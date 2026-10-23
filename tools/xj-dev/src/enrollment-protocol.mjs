import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
// Windows chmod does not protect secrets. Use a protected current-SID DACL for
// every shared private-file API, including owner invitation exports.
function windowsPrivatePath(file, directory, protect) {
  const script = `
$ErrorActionPreference = 'Stop'
$p = $env:XJ_PRIVATE_PATH
if (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$acl = [IO.${directory ? 'Directory' : 'File'}]::GetAccessControl($p)
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $sid.Value ${protect ? "-and $owner -ne $identity.Owner.Value" : ''}) { throw 'owner' }
${protect ? `
$acl = New-Object Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', '${directory ? 'ContainerInherit, ObjectInherit' : 'None'}', 'None', 'Allow')
$acl.AddAccessRule($rule)
[IO.${directory ? 'Directory' : 'File'}]::SetAccessControl($p, $acl)
$acl = [IO.${directory ? 'Directory' : 'File'}]::GetAccessControl($p)
` : ''}
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
${directory || protect ? "if (-not $acl.AreAccessRulesProtected) { throw 'inheritance' }" : ''}
$own = $false
foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($r.AccessControlType -eq 'Allow') {
    if ($r.IdentityReference.Value -ne $sid.Value) { throw 'other principal' }
    if (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $own = $true }
  }
}
if (-not $own) { throw 'missing owner access' }
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, XJ_PRIVATE_PATH: file }, stdio: 'ignore', windowsHide: true, timeout: 15000,
  });
  requireAccess(result.status === 0, 'PRIVATE_FILE_REQUIRED');
}
function ownedPath(file, directory) {
  const stat = lstatSync(file);
  requireAccess(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) &&
    (process.platform === 'win32' || stat.uid === process.getuid()), 'PRIVATE_FILE_REQUIRED');
  return stat;
}
export function ensurePrivateDirectory(directory) {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const stat = ownedPath(directory, true);
  if (process.platform === 'win32') windowsPrivatePath(directory, true, true);
  else requireAccess(!(stat.mode & 0o077), 'PRIVATE_FILE_REQUIRED');
  return directory;
}
export function assertPrivateFile(file) {
  const stat = ownedPath(file, false);
  requireAccess(stat.size <= 1024 * 1024, 'PRIVATE_FILE_REQUIRED');
  if (process.platform === 'win32') windowsPrivatePath(file, false, false);
  else requireAccess(!(stat.mode & 0o077), 'PRIVATE_FILE_REQUIRED');
  return file;
}
export function writePrivateFile(file, bytes) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) ownedPath(file, false);
  const temporary = `${file}.${opaque()}.tmp`;
  try {
    // Protect the empty file before any secret bytes are written.
    closeSync(openSync(temporary, 'wx', 0o600));
    if (process.platform === 'win32') windowsPrivatePath(temporary, false, true);
    writeFileSync(temporary, bytes);
    assertPrivateFile(temporary);
    renameSync(temporary, file);
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    assertPrivateFile(file);
  } finally { rmSync(temporary, { force: true }); }
}
export function privateJson(file) {
  assertPrivateFile(file);
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function writePrivateJson(file, value) {
  writePrivateFile(file, JSON.stringify(value, null, 2) + '\n');
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
