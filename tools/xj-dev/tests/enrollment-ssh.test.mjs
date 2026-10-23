import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chooseSigningKeygen, enrollmentKeygen, signEnrollmentProof, windowsSigningCandidates } from '../src/enrollment-ssh.mjs';
import { ensurePrivateDirectory, proofMessage, PROOF_NAMESPACE, publicKey, writePrivateFile } from '../src/enrollment-protocol.mjs';

test('Windows preserves PATH precedence and discovers Git OpenSSH from the installed git.exe location', () => {
  const files = new Set(['C:\\Native\\ssh-keygen.exe', 'D:\\Portable Git\\cmd\\git.exe', 'D:\\Portable Git\\usr\\bin\\ssh-keygen.exe'].map(p => p.toLowerCase()));
  const found = windowsSigningCandidates({ Path: 'C:\\Native;"D:\\Portable Git\\cmd";c:\\native;.;relative' }, p => files.has(p.toLowerCase()));
  assert.deepEqual(found, ['C:\\Native\\ssh-keygen.exe', 'D:\\Portable Git\\usr\\bin\\ssh-keygen.exe']);
});

test('Windows can find a per-user Git install without modifying PATH or executing a cmd shim', () => {
  const git = 'C:\\Users\\fixture\\AppData\\Local\\Programs\\Git\\usr\\bin\\ssh-keygen.exe';
  assert.deepEqual(windowsSigningCandidates({ PATH: '', LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' }, p => p === git), [git]);
  assert.deepEqual(windowsSigningCandidates({ PATH: 'relative;.' }, () => true), []);
});

test('a working PATH signer wins; a timed-out or unsupported signer falls back without exposing diagnostics', () => {
  const candidates = ['native.exe', 'git.exe'], tried = [];
  assert.equal(chooseSigningKeygen(candidates, tool => { tried.push(tool); return true; }), 'native.exe');
  assert.deepEqual(tried, ['native.exe']);
  assert.equal(chooseSigningKeygen(candidates, tool => { if (tool === 'native.exe') throw Object.assign(new Error('private diagnostic'), { code: 'ETIMEDOUT' }); return true; }), 'git.exe');
  assert.equal(chooseSigningKeygen(candidates, tool => tool === 'git.exe'), 'git.exe');
  assert.throws(() => chooseSigningKeygen(candidates, () => { throw new Error('must not escape'); }), error => {
    assert.equal(error.code, 'DEVICE_SIGNING_FAILED'); assert.equal((error.stack + error.message).includes('must not escape'), false); return true;
  });
});

test('selected keygen produces an Ed25519 SSHSIG with the unchanged service/nonce/method/path/body proof', () => {
  const root = mkdtempSync(join(tmpdir(), 'xj-enrollment-ssh-'));
  try {
    ensurePrivateDirectory(root);
    const executable = enrollmentKeygen(), key = join(root, 'identity'), allowed = join(root, 'allowed'), sig = join(root, 'signature');
    if (process.platform !== 'win32') assert.equal(executable, 'ssh-keygen');
    assert.equal(childProcess.spawnSync(executable, ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore', timeout: 10000 }).status, 0);
    writePrivateFile(key, readFileSync(key));
    const expected = publicKey(readFileSync(key + '.pub', 'utf8'));
    const challenge = { serviceId: 'signing-regression', challengeId: randomUUID(), nonce: randomBytes(24).toString('base64url'), expiresAt: Date.now() + 60000,
      method: 'POST', path: '/v1/config', bodyHash: 'a'.repeat(64) };
    writePrivateFile(allowed, `device ${expected}\n`); writePrivateFile(sig, signEnrollmentProof(key, challenge));
    const verify = message => childProcess.spawnSync(executable, ['-Y', 'verify', '-f', allowed, '-I', 'device', '-n', PROOF_NAMESPACE, '-s', sig],
      { input: proofMessage(message), stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000 }).status;
    assert.equal(verify(challenge), 0);
    for (const changed of [{ serviceId: 'foreign' }, { nonce: 'different' }, { method: 'GET' }, { path: '/v1/enroll' }, { bodyHash: 'b'.repeat(64) }])
      assert.notEqual(verify({ ...challenge, ...changed }), 0);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test('failed signing never exposes private diagnostics, input proof or key bytes in its error', () => {
  // Resolve before replacing spawnSync so Windows capability detection is real.
  enrollmentKeygen();
  const secret = randomBytes(24).toString('base64url'), original = childProcess.spawnSync;
  childProcess.spawnSync = () => ({ status: null, error: new Error(secret), stderr: secret, stdout: secret }); syncBuiltinESMExports();
  try {
    assert.throws(() => signEnrollmentProof('private-key-path', { serviceId: secret }), error => {
      assert.equal(error.code, 'DEVICE_SIGNING_FAILED'); assert.equal((error.stack + error.message).includes(secret), false); return true;
    });
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});
