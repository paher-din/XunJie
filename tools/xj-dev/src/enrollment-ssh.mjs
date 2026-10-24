// Client-only SSHSIG selection. The Linux access bundle imports the original
// protocol directly and does not depend on this module.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { AccessError, ensurePrivateDirectory, proofMessage, PROOF_NAMESPACE, publicKey, requireAccess, signProof, writePrivateFile } from './enrollment-protocol.mjs';

const PROBE_TIMEOUT_MS = 1500;
const signed = result => result.status === 0 && typeof result.stdout === 'string'
  && result.stdout.trim().startsWith('-----BEGIN SSH SIGNATURE-----') && result.stdout.trim().endsWith('-----END SSH SIGNATURE-----');
const fileExists = file => { try { return statSync(file).isFile(); } catch { return false; } };

export function windowsSigningCandidates(env = process.env, exists = fileExists) {
  const value = key => env[Object.keys(env).find(name => name.toLowerCase() === key.toLowerCase())] ?? '';
  const dirs = value('PATH').split(';').map(path => path.trim().replace(/^"(.*)"$/, '$1')).filter(win32.isAbsolute);
  const candidates = [], seen = new Set();
  const add = path => {
    path = win32.normalize(path); const key = path.toLowerCase();
    if (!seen.has(key) && exists(path)) { seen.add(key); candidates.push(path); }
  };
  // Preserve a working PATH choice before trying Git's bundled OpenSSH.
  for (const dir of dirs) add(win32.join(dir, 'ssh-keygen.exe'));
  for (const dir of dirs) {
    if (!exists(win32.join(dir, 'git.exe'))) continue;
    for (const relative of ['../usr/bin/ssh-keygen.exe', '../../usr/bin/ssh-keygen.exe']) add(win32.resolve(dir, relative));
  }
  for (const name of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    if (win32.isAbsolute(value(name))) add(win32.join(value(name), 'Git/usr/bin/ssh-keygen.exe'));
  }
  if (win32.isAbsolute(value('LOCALAPPDATA'))) add(win32.join(value('LOCALAPPDATA'), 'Programs/Git/usr/bin/ssh-keygen.exe'));
  return candidates;
}

export function chooseSigningKeygen(candidates, usable) {
  for (const candidate of candidates) {
    try { if (usable(candidate)) return candidate; } catch { /* Never expose a tool's stderr or payload in an error. */ }
  }
  throw new AccessError('DEVICE_SIGNING_FAILED');
}

function probeSigningKeygen(candidates) {
  const root = mkdtempSync(join(tmpdir(), 'xj-signing-probe-')), key = join(root, 'probe_ed25519');
  let expected;
  try {
    ensurePrivateDirectory(root);
    return chooseSigningKeygen(candidates, candidate => {
      const run = (args, options = {}) => spawnSync(candidate, args, {
        encoding: 'utf8', windowsHide: true, shell: false, timeout: PROBE_TIMEOUT_MS, maxBuffer: 16384, ...options,
      });
      if (!expected) {
        const generated = run(['-q', '-t', 'ed25519', '-N', '', '-C', 'xj-dev-capability-probe', '-f', key], { stdio: 'ignore' });
        if (generated.status !== 0) { rmSync(key, { force: true }); rmSync(key + '.pub', { force: true }); return false; }
        // Use the same protected owner/DACL as real enrollment keys. The probe
        // key and harmless message never become an enrollment/device identity.
        writePrivateFile(key, readFileSync(key));
        expected = publicKey(readFileSync(key + '.pub', 'utf8'));
      }
      const extracted = run(['-y', '-f', key], { stdio: ['ignore', 'pipe', 'ignore'] });
      if (extracted.status !== 0 || publicKey(extracted.stdout) !== expected) return false;
      return signed(run(['-Y', 'sign', '-f', key, '-n', PROOF_NAMESPACE], { input: Buffer.from('xj-dev harmless SSHSIG capability probe\n') }));
    });
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
}

let cached;
export function enrollmentKeygen() {
  if (process.platform !== 'win32') return 'ssh-keygen';
  const candidates = windowsSigningCandidates(), fingerprint = candidates.join('\0').toLowerCase();
  if (!cached || cached.fingerprint !== fingerprint) cached = { fingerprint, executable: probeSigningKeygen(candidates) };
  return cached.executable;
}

export function signEnrollmentProof(identityFile, challenge) {
  if (process.platform !== 'win32') return signProof(identityFile, challenge);
  const result = spawnSync(enrollmentKeygen(), ['-Y', 'sign', '-f', identityFile, '-n', PROOF_NAMESPACE], {
    input: proofMessage(challenge), encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000, maxBuffer: 16384,
  });
  requireAccess(signed(result), 'DEVICE_SIGNING_FAILED');
  return result.stdout;
}
