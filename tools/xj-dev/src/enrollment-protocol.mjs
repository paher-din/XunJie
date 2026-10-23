import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const ACCESS_PROTOCOL = 'xj-dev/access-v1';
export const PROOF_NAMESPACE = 'xunjie-dev-access-v1';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const opaque = () => randomBytes(24).toString('base64url');
export class AccessError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function requireAccess(value, code = 'INVALID_REQUEST', status = 400) {
  if (!value) throw new AccessError(code, status);
}
export function privateJson(file) {
  const stat = lstatSync(file);
  requireAccess(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024 && (process.platform === 'win32' || !(stat.mode & 0o077)), 'PRIVATE_FILE_REQUIRED');
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function writePrivateJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${opaque()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file); chmodSync(file, 0o600);
  } finally { rmSync(temporary, { force: true }); }
}
export function publicKey(value) {
  requireAccess(typeof value === 'string' && value.length < 512, 'INVALID_PUBLIC_KEY');
  const fields = value.trim().split(/\s+/);
  requireAccess(fields[0] === 'ssh-ed25519' && /^[A-Za-z0-9+/=]+$/.test(fields[1] ?? ''), 'INVALID_PUBLIC_KEY');
  const bytes = Buffer.from(fields[1], 'base64');
  requireAccess(bytes.length === 51 && bytes.readUInt32BE(0) === 11 && bytes.subarray(4, 15).toString() === 'ssh-ed25519' && bytes.readUInt32BE(15) === 32, 'INVALID_PUBLIC_KEY');
  return `${fields[0]} ${fields[1]}`;
}
export function proofMessage(challenge) {
  return Buffer.from(JSON.stringify({ protocol: ACCESS_PROTOCOL, serviceId: challenge.serviceId,
    challengeId: challenge.challengeId, nonce: challenge.nonce, expiresAt: challenge.expiresAt,
    method: challenge.method, path: challenge.path, bodyHash: challenge.bodyHash }));
}
export function signProof(identityFile, challenge) {
  const result = spawnSync('ssh-keygen', ['-Y', 'sign', '-f', identityFile, '-n', PROOF_NAMESPACE], { input: proofMessage(challenge), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  requireAccess(result.status === 0 && result.stdout.includes('BEGIN SSH SIGNATURE'), 'DEVICE_SIGNING_FAILED');
  return result.stdout;
}
export function verifyProof(key, challenge, signature) {
  requireAccess(typeof signature === 'string' && signature.length < 4096, 'PROOF_INVALID', 401);
  const directory = mkdtempSync(join(tmpdir(), 'xj-access-proof-'));
  try {
    const allowed = join(directory, 'allowed'), sig = join(directory, 'signature');
    writeFileSync(allowed, `device ${publicKey(key)}\n`, { mode: 0o600 });
    writeFileSync(sig, signature, { mode: 0o600 });
    const result = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', allowed, '-I', 'device', '-n', PROOF_NAMESPACE, '-s', sig], { input: proofMessage(challenge), stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
    requireAccess(result.status === 0, 'PROOF_INVALID', 401);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
