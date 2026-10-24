import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs, { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from '../src/certificates.mjs';
import { environmentPaths } from '../src/paths.mjs';
import { ACCESS_PROTOCOL, digest, privateJson, publicKey, verifyProof, writePrivateFile, writePrivateJson } from '../src/enrollment-protocol.mjs';
import { failureEnvelope } from '../src/envelope.mjs';
import { MAX_INVITATION_STDIN_BYTES, prepareEnrollment, joinEnrollment, refreshEnrollment, readRegistration, authenticatedRequest } from '../src/enrollment-client.mjs';
import { readInvitationStdin } from '../src/enrollment-routes.mjs';

// An actual TLS peer implementing the fixed protocol. This is not the deployed
// access service or a business-login acceptance; Mendel owns that integration.
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xj-enrollment-client-')));
  const home = join(root, 'home'), invitationFile = join(root, 'invite.json');
  const ca = ensureCertificateAuthority(root), cert = ensureEnvironmentCertificate(environmentPaths(root, 'tls'), ca);
  const hostKey = join(root, 'host-key');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey], { stdio: 'ignore' }).status, 0);
  const knownHosts = 'approved.test ' + publicKey(readFileSync(hostKey + '.pub', 'utf8')) + '\n';
  const secret = randomBytes(32).toString('base64url'), password = randomBytes(32).toString('base64url');
  const challenges = new Map(), requests = [], proofs = [], bound = new Map();
  const controls = { loseEnrollmentResponse: false, challenge: null, connection: null, identity: null, rejected: null };
  const serviceId = randomUUID(), invitationId = randomUUID();
  const identity = { memberId: 'member-one', deviceId: 'device-one', teamRole: 'developer', capabilities: ['page'] };
  const connection = { schema: 'xj-dev/connection-v1', host: 'approved.test', port: 22, browserUser: 'xjd_test',
    applicationPort: 13444, browserOrigin: 'https://localhost:13445', knownHosts, caPem: readFileSync(ca.certFile, 'utf8') };
  const server = createServer({ key: readFileSync(cert.keyFile), cert: readFileSync(cert.certFile) }, async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const input = JSON.parse(text); requests.push({ path: req.url, input });
      if (controls.rejected) return reply(403, { ok: false, code: controls.rejected, detail: secret + password });
      if (req.url === '/v1/challenges') {
        assert.equal(input.method, 'POST'); assert.equal(publicKey(input.publicKey), input.publicKey);
        if (input.path === '/v1/enroll') {
          if (input.invitationSecret !== secret) return reply(403, { ok: false, code: 'INVITATION_INVALID' });
          if (!bound.size && invitation.expiresAt <= Date.now()) return reply(403, { ok: false, code: 'INVITATION_EXPIRED' });
          if (bound.size && !bound.has(input.publicKey)) return reply(403, { ok: false, code: 'INVITATION_KEY_MISMATCH' });
        } else if (!bound.has(input.publicKey) || input.deviceId !== identity.deviceId) return reply(403, { ok: false, code: 'DEVICE_KEY_MISMATCH' });
        const challenge = { serviceId, challengeId: randomUUID(), nonce: randomBytes(24).toString('base64url'), expiresAt: Date.now() + 60000,
          method: 'POST', path: input.path, bodyHash: input.bodyHash, ...controls.challenge };
        challenges.set(challenge.challengeId, { challenge, key: input.publicKey });
        return reply(200, { ok: true, data: challenge });
      }
      const saved = challenges.get(input.challengeId); assert.ok(saved, 'proof must refer to a fresh issued challenge');
      challenges.delete(input.challengeId);
      assert.equal(saved.challenge.path, req.url); assert.equal(saved.challenge.bodyHash, digest(JSON.stringify(input.body)));
      verifyProof(saved.key, saved.challenge, input.signature); proofs.push(input.signature);
      if (req.url === '/v1/enroll') {
        assert.equal(input.body.invitationSecret, secret); bound.set(saved.key, identity);
        if (controls.loseEnrollmentResponse) { controls.loseEnrollmentResponse = false; req.socket.destroy(); return; }
      } else assert.equal(input.body.deviceId, identity.deviceId);
      return reply(200, { ok: true, data: req.url === '/v1/identity' ? controls.identity ?? identity : {
        identity: controls.identity ?? identity, connection: { ...connection, ...controls.connection }, account: { loginName: 'synthetic-personal', password },
      } });
    } catch { reply(400, { ok: false, code: 'PROOF_INVALID' }); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const invitation = { protocol: ACCESS_PROTOCOL, serviceId, endpoint: `https://127.0.0.1:${server.address().port}`,
    caPem: readFileSync(ca.certFile, 'utf8'), sshKnownHosts: knownHosts, cloudCaPem: readFileSync(ca.certFile, 'utf8'),
    invitationId, secret, expiresAt: Date.now() + 60000 };
  writePrivateJson(invitationFile, invitation);
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, home, invitationFile, invitation, controls, requests, proofs, bound, secret, password, identity };
}

test('a new device proves possession over real TLS; public results expose only paths and non-secret identity', async t => {
  const f = await fixture(t);
  const prepared = prepareEnrollment({ home: f.home, invitationFile: f.invitationFile });
  assert.equal(prepared.state, 'prepared'); assert.ok(existsSync(prepared.identityFile));
  const joined = await joinEnrollment({ home: f.home, invitationFile: f.invitationFile });
  assert.equal(joined.state, 'registered'); assert.deepEqual(joined.identity, f.identity);
  assert.equal(joined.identityFile, prepared.identityFile);
  assert.deepEqual(readRegistration({ home: f.home }), joined);
  const config = privateJson(joined.connectionFile), account = privateJson(joined.accountFile);
  assert.equal(config.identityFile, joined.identityFile);
  assert.ok(account.password === f.password);
  assert.deepEqual(f.requests.map(r => r.path), ['/v1/challenges', '/v1/enroll']);
  const visible = JSON.stringify({ prepared, joined });
  for (const value of [f.secret, f.password, ...f.proofs, readFileSync(joined.identityFile, 'utf8')]) assert.equal(visible.includes(value), false);
  assert.equal(JSON.stringify(f.requests).includes('BEGIN OPENSSH PRIVATE KEY'), false);
});

test('lost enrollment response resumes with the same persisted key and a fresh challenge, without a hidden request retry', async t => {
  const f = await fixture(t), prepared = prepareEnrollment({ home: f.home, invitationFile: f.invitationFile });
  const keyDigest = digest(readFileSync(prepared.identityFile));
  f.controls.loseEnrollmentResponse = true;
  await assert.rejects(() => joinEnrollment({ home: f.home, invitationFile: f.invitationFile }), { code: 'ACCESS_UNREACHABLE' });
  assert.equal(f.bound.size, 1); assert.equal(readRegistration({ home: f.home }), undefined);
  assert.deepEqual(f.requests.map(r => r.path), ['/v1/challenges', '/v1/enroll']);
  const repeated = prepareEnrollment({ home: f.home, invitationFile: f.invitationFile });
  assert.equal(digest(readFileSync(repeated.identityFile)), keyDigest);
  const script = `import {joinEnrollment} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/enrollment-client.mjs')).href)};
    console.log(JSON.stringify(await joinEnrollment({deviceFile:process.argv[1]})));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, repeated.deviceFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
  const status = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  assert.equal(status, 0, errors.slice(-500));
  const joined = JSON.parse(output);
  assert.equal(joined.state, 'registered'); assert.equal(f.bound.size, 1);
  const attempts = f.requests.filter(r => r.path === '/v1/enroll');
  assert.notEqual(attempts[0].input.challengeId, attempts[1].input.challengeId);
});

test('a missing key after preparation is never silently replaced with another device identity', async t => {
  const f = await fixture(t), prepared = prepareEnrollment({ home: f.home, invitationFile: f.invitationFile });
  unlinkSync(prepared.identityFile);
  assert.throws(() => prepareEnrollment({ home: f.home, invitationFile: f.invitationFile }), { code: 'DEVICE_KEY_MISSING' });
  assert.equal(existsSync(prepared.identityFile), false); assert.equal(f.requests.length, 0);
});

test('refresh and the internal identity API use new device proofs and keep credentials private', async t => {
  const f = await fixture(t), joined = await joinEnrollment({ home: f.home, invitationFile: f.invitationFile });
  const original = digest(readFileSync(joined.identityFile));
  const refreshed = await refreshEnrollment({ deviceFile: joined.deviceFile });
  assert.equal(refreshed.identityFile, joined.identityFile); assert.equal(digest(readFileSync(refreshed.identityFile)), original);
  assert.notEqual(refreshed.connectionFile, joined.connectionFile);
  assert.equal(existsSync(joined.connectionFile), true, 'old immutable generation remains available');
  assert.deepEqual(await authenticatedRequest(refreshed.deviceFile, '/v1/identity'), f.identity);
  assert.deepEqual(f.requests.map(r => r.path), ['/v1/challenges', '/v1/enroll', '/v1/challenges', '/v1/config', '/v1/challenges', '/v1/identity']);
  const challengeIds = f.requests.filter(r => r.path !== '/v1/challenges').map(r => r.input.challengeId);
  assert.equal(new Set(challengeIds).size, 3);
  assert.equal(JSON.stringify(refreshed).includes(f.password), false);
  assert.equal(JSON.stringify(privateJson(refreshed.deviceFile)).includes(f.secret), false, 'successful stage drops the invitation secret');
});

test('foreign host/pin/CA/identity and invalid connection responses preserve the existing published connection', async t => {
  const f = await fixture(t), joined = await joinEnrollment({ home: f.home, invitationFile: f.invitationFile });
  const original = digest(readFileSync(joined.connectionFile));
  const other = ensureCertificateAuthority(join(f.root, 'other-ca'));
  for (const [change, code] of [
    [{ connection: { host: 'unknown.test' } }, 'HOST_IDENTITY_CHANGED'],
    [{ connection: { knownHosts: f.invitation.sshKnownHosts.replace('approved.test', 'unknown.test') } }, 'HOST_IDENTITY_CHANGED'],
    [{ connection: { caPem: readFileSync(other.certFile, 'utf8') } }, 'TLS_IDENTITY_CHANGED'],
    [{ identity: { ...f.identity, deviceId: 'other-device' } }, 'IDENTITY_MISMATCH'],
    [{ connection: { browserUser: 'invalid user' } }, 'CONNECTION_INVALID'],
  ]) {
    f.controls.connection = change.connection; f.controls.identity = change.identity;
    await assert.rejects(() => refreshEnrollment({ deviceFile: joined.deviceFile }), { code });
    assert.deepEqual(readRegistration({ home: f.home }), joined);
    assert.equal(digest(readFileSync(joined.connectionFile)), original);
  }
});

test('server supplied local file paths are ignored; all connection files stay in the managed generation', async t => {
  const f = await fixture(t), outside = join(f.root, 'must-not-be-written');
  f.controls.connection = { identityFile: outside, knownHostsFile: outside, caFile: outside, nodeIdentityFile: outside,
    nodeId: 'node-one', nodeUser: 'xjd_node', remoteRunnerPort: 34001, localRunnerPort: 34002 };
  f.controls.identity = { ...f.identity, capabilities: ['page', 'node:node-one'] };
  const joined = await joinEnrollment({ home: f.home, invitationFile: f.invitationFile });
  const connection = privateJson(joined.connectionFile);
  assert.equal(connection.identityFile, joined.identityFile); assert.equal(connection.nodeIdentityFile, joined.identityFile);
  assert.ok(connection.knownHostsFile.startsWith(joined.connectionFile.slice(0, -'connection.json'.length)));
  assert.ok(connection.caFile.startsWith(joined.connectionFile.slice(0, -'connection.json'.length)));
  assert.equal(existsSync(outside), false);
});

test('different invitations get different keys; a failed new invite cannot replace an existing home registration', async t => {
  const f = await fixture(t), joined = await joinEnrollment({ home: f.home, invitationFile: f.invitationFile });
  const secondFile = join(f.root, 'second-invite.json');
  writePrivateJson(secondFile, { ...f.invitation, invitationId: randomUUID(), secret: randomBytes(32).toString('base64url') });
  const second = prepareEnrollment({ home: f.home, invitationFile: secondFile });
  assert.equal(second.state, 'prepared'); assert.notEqual(second.identityFile, joined.identityFile);
  assert.notEqual(digest(readFileSync(second.identityFile)), digest(readFileSync(joined.identityFile)));
  await assert.rejects(() => joinEnrollment({ home: f.home, invitationFile: secondFile }), { code: 'INVITATION_INVALID' });
  assert.deepEqual(readRegistration({ home: f.home }), joined);
});

test('another home/key cannot redeem an already-bound invitation; an expired unbound invite is rejected', async t => {
  const f = await fixture(t), joined = await joinEnrollment({ home: f.home, invitationFile: f.invitationFile });
  const otherHome = join(f.root, 'other-home');
  await assert.rejects(() => joinEnrollment({ home: otherHome, invitationFile: f.invitationFile }), { code: 'INVITATION_KEY_MISMATCH' });
  assert.equal(readRegistration({ home: otherHome }), undefined); assert.deepEqual(readRegistration({ home: f.home }), joined);
  const expired = await fixture(t); expired.invitation.expiresAt = Date.now() - 1;
  writePrivateJson(expired.invitationFile, expired.invitation);
  await assert.rejects(() => joinEnrollment({ home: expired.home, invitationFile: expired.invitationFile }), { code: 'INVITATION_EXPIRED' });
  assert.equal(expired.bound.size, 0); assert.equal(readRegistration({ home: expired.home }), undefined);
});

test('challenge service/target/hash/expiry are checked and used nonces remain consumed across retries', async t => {
  const f = await fixture(t), joined = await joinEnrollment({ home: f.home, invitationFile: f.invitationFile });
  for (const challenge of [{ serviceId: 'other-service' }, { path: '/v1/enroll' }, { method: 'GET' }, { bodyHash: '0'.repeat(64) }, { expiresAt: Date.now() - 1 }]) {
    f.controls.challenge = challenge;
    const before = f.requests.length;
    await assert.rejects(() => refreshEnrollment({ deviceFile: joined.deviceFile }), { code: 'CHALLENGE_INVALID' });
    assert.equal(f.requests.length, before + 1, 'invalid challenge never reaches the signed endpoint');
    assert.deepEqual(readRegistration({ home: f.home }), joined);
  }
  f.controls.challenge = { nonce: randomBytes(24).toString('base64url'), challengeId: randomUUID() };
  const refreshed = await refreshEnrollment({ deviceFile: joined.deviceFile });
  await assert.rejects(() => refreshEnrollment({ deviceFile: joined.deviceFile }), { code: 'CHALLENGE_REUSED' });
  assert.deepEqual(readRegistration({ home: f.home }), refreshed);
});

test('bootstrap enforces the invite TLS CA even when certificate checking is disabled in the ambient environment', async t => {
  const f = await fixture(t), wrong = ensureCertificateAuthority(join(f.root, 'wrong-ca'));
  writePrivateJson(f.invitationFile, { ...f.invitation, caPem: readFileSync(wrong.certFile, 'utf8') });
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try { await assert.rejects(() => joinEnrollment({ home: f.home, invitationFile: f.invitationFile }), { code: 'TLS_IDENTITY_CHANGED' }); }
  finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; }
  assert.equal(f.requests.length, 0); assert.equal(readRegistration({ home: f.home }), undefined);
});

test('errors, public JSON and actual ssh-keygen argv never disclose invitation/account/proof/private-key bytes', async t => {
  const f = await fixture(t), argv = [], original = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, options) => { argv.push(command, ...args); return original(command, args, options); };
  syncBuiltinESMExports();
  let joined;
  try { joined = await joinEnrollment({ home: f.home, invitationFile: f.invitationFile }); }
  finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
  for (const material of [f.secret, f.password, ...f.proofs, readFileSync(joined.identityFile, 'utf8')])
    assert.equal(argv.some(argument => argument.includes(material)), false);
  for (const code of ['DEVICE_REVOKED', f.secret]) {
    f.controls.rejected = code;
    await assert.rejects(() => refreshEnrollment({ deviceFile: joined.deviceFile }), error => {
      const output = JSON.stringify(failureEnvelope('0.2.0', 'join', error)) + error.stack;
      assert.equal(output.includes(f.secret), false); assert.equal(output.includes(f.password), false);
      return error.code === (code === 'DEVICE_REVOKED' ? code : 'ACCESS_REJECTED');
    });
    assert.deepEqual(readRegistration({ home: f.home }), joined);
  }
  writePrivateFile(joined.deviceFile, '{"invitationSecret":"' + f.secret + '" broken');
  assert.throws(() => readRegistration(joined.deviceFile), error => error.code === 'ENROLLMENT_STATE_INVALID' && !error.message.includes(f.secret));
});

test('local publication failure rolls back only the new generation and leaves the old registration usable', async t => {
  const f = await fixture(t), joined = await joinEnrollment({ home: f.home, invitationFile: f.invitationFile });
  const before = readdirSync(dirname(joined.deviceFile)).sort(), original = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (typeof file === 'string' && file.includes('account.json.') && file.endsWith('.tmp')) throw Object.assign(new Error('controlled write failure'), { code: 'EIO' });
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(() => refreshEnrollment({ deviceFile: joined.deviceFile }), { code: 'ENROLLMENT_STATE_INVALID' }); }
  finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(readRegistration({ home: f.home }), joined);
  assert.deepEqual(readdirSync(dirname(joined.deviceFile)).sort(), before);
  assert.deepEqual(await authenticatedRequest(joined.deviceFile, '/v1/identity'), f.identity);
});

test('invitation files with broad POSIX permissions or symlinks are rejected before any network activity', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  chmodSync(f.invitationFile, 0o644);
  assert.throws(() => prepareEnrollment({ home: f.home, invitationFile: f.invitationFile }), { code: 'PRIVATE_FILE_REQUIRED' });
  chmodSync(f.invitationFile, 0o600);
  const link = join(f.root, 'linked-invite.json'); symlinkSync(f.invitationFile, link);
  assert.throws(() => prepareEnrollment({ home: f.home, invitationFile: link }), { code: 'PRIVATE_FILE_REQUIRED' });
  assert.equal(f.requests.length, 0); assert.equal(existsSync(f.home), false);
});

async function stdinJoin(f, extraArgs, input) {
  const args = [join(import.meta.dirname, '../xj-dev.mjs'), 'join', ...extraArgs, '--no-start', '--worktree', join(import.meta.dirname, '../../..')];
  const child = spawn(process.execPath, args, { env: { ...process.env, XJ_DEV_HOME: f.home }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  child.stdin.on('error', () => {}); // Early argument/size rejection may close the pipe.
  if (input !== undefined) child.stdin.end(input);
  const status = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  for (const material of [f.secret, f.password, ...f.proofs]) {
    assert.equal(stdout.includes(material), false); assert.equal(stderr.includes(material), false);
    assert.equal(child.spawnargs.some(arg => arg.includes(material)), false);
  }
  return { status, result: JSON.parse(stdout), stderr };
}

test('CLI stdin joins resume a lost response with the same key, then reuse registration after success', async t => {
  const f = await fixture(t), input = JSON.stringify(f.invitation);
  f.controls.loseEnrollmentResponse = true;
  const failed = await stdinJoin(f, ['--invitation-stdin'], input);
  assert.equal(failed.status, 1); assert.equal(failed.result.failure.code, 'ACCESS_UNREACHABLE');
  const prepared = prepareEnrollment({ home: f.home, invitationFile: f.invitationFile });
  const originalKey = digest(readFileSync(prepared.identityFile));
  const joined = await stdinJoin(f, ['--invitation-stdin'], input);
  assert.equal(joined.status, 0); assert.equal(joined.result.enrollment.identityFile, prepared.identityFile);
  assert.equal(digest(readFileSync(prepared.identityFile)), originalKey);
  const repeated = await stdinJoin(f, ['--invitation-stdin'], input);
  assert.equal(repeated.status, 0); assert.equal(repeated.result.enrollment.identity.deviceId, joined.result.enrollment.identity.deviceId);
  assert.equal(digest(readFileSync(prepared.identityFile)), originalKey);
  assert.equal(f.bound.size, 1); assert.equal(f.requests.at(-1).path, '/v1/config');
  assert.equal(JSON.stringify(privateJson(prepared.deviceFile)).includes(f.secret), false);
  assert.equal(readdirSync(f.home).some(name => name.includes('invite')), false);
});

test('stdin/file conflict rejects before reading stdin; invalid/empty/oversized input never prepares a device or leaks bytes', async t => {
  const f = await fixture(t);
  // Leave stdin open: argument validation must not wait for secret input/EOF.
  const conflict = await stdinJoin(f, ['--invitation-file', f.invitationFile, '--invitation-stdin']);
  assert.equal(conflict.result.failure.code, 'INVITATION_INPUT_CONFLICT');
  for (const [input, code] of [
    ['', 'INVITATION_STDIN_EMPTY'],
    ['{"secret":"' + f.secret + '" broken', 'INVITATION_INVALID'],
    [Buffer.concat([Buffer.from(f.secret), Buffer.alloc(MAX_INVITATION_STDIN_BYTES, 0x20)]), 'INVITATION_TOO_LARGE'],
  ]) {
    const result = await stdinJoin(f, ['--invitation-stdin'], input);
    assert.equal(result.status, 1); assert.equal(result.result.failure.code, code);
  }
  assert.equal(f.requests.length, 0); assert.equal(existsSync(f.home), false);
});

test('stdin enforces a byte boundary across chunks, rejects terminal input and sanitizes stream errors', async () => {
  const bytes = Buffer.alloc(MAX_INVITATION_STDIN_BYTES, 0x20);
  assert.deepEqual(await readInvitationStdin(Readable.from([bytes.subarray(0, 7), bytes.subarray(7)])), bytes);
  await assert.rejects(readInvitationStdin(Readable.from([bytes.subarray(0, -1), Buffer.from('循')])), { code: 'INVITATION_TOO_LARGE' });
  await assert.rejects(readInvitationStdin({ isTTY: true }), { code: 'INVITATION_STDIN_REQUIRES_PIPE' });
  const secret = randomBytes(24).toString('base64url');
  const broken = Readable.from((async function* () { yield Buffer.from(secret); throw new Error(secret); })());
  await assert.rejects(readInvitationStdin(broken), error => {
    assert.equal((JSON.stringify(failureEnvelope('0.2.0', 'join', error)) + error.stack).includes(secret), false);
    return error.code === 'INVITATION_STDIN_FAILED';
  });
});

test('the complete invitation at exactly the stdin byte limit is accepted without a relay file', async t => {
  const f = await fixture(t), json = Buffer.from(JSON.stringify(f.invitation));
  const input = Buffer.concat([json, Buffer.alloc(MAX_INVITATION_STDIN_BYTES - json.length, 0x20)]);
  const result = await stdinJoin(f, ['--invitation-stdin'], input);
  assert.equal(result.status, 0); assert.equal(result.result.enrollment.state, 'registered');
});
