import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import type { Server } from 'node:net';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const namedPipe = (path: string) => /^\\\\[.?]\\pipe\\/i.test(path);

/** Use the same configured identity for Windows clients and their local owner. */
export function localSocketAddress(path: string): string {
  if (process.platform !== 'win32' || namedPipe(path)) return path;
  return '\\\\.\\pipe\\xunjie-control-' + createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
}

const protect = `
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $env:XJ_LOCAL_PIPE.Substring(9), [IO.Pipes.PipeAccessRights]::FullControl, [IO.Pipes.PipeOptions]::None, [Security.Principal.TokenImpersonationLevel]::Identification, [IO.HandleInheritability]::None)
try {
  $pipe.Connect(5000)
  $owner = $pipe.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $sid.Value -and $owner -ne $identity.Owner.Value) { throw 'owner' }
  $acl = New-Object IO.Pipes.PipeSecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $network = New-Object Security.Principal.SecurityIdentifier('S-1-5-2')
  $acl.AddAccessRule((New-Object IO.Pipes.PipeAccessRule($network, 'FullControl', 'Deny')))
  $acl.AddAccessRule((New-Object IO.Pipes.PipeAccessRule($sid, 'FullControl', 'Allow')))
  $pipe.SetAccessControl($acl)
  $actual = $pipe.GetAccessControl()
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
  $own = $false
  $localOnly = $false
  foreach ($rule in $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'other principal' }
      if (($rule.PipeAccessRights -band [IO.Pipes.PipeAccessRights]::FullControl) -eq [IO.Pipes.PipeAccessRights]::FullControl) { $own = $true }
    }
    if ($rule.AccessControlType -eq 'Deny' -and $rule.IdentityReference.Value -eq 'S-1-5-2' -and ($rule.PipeAccessRights -band [IO.Pipes.PipeAccessRights]::FullControl) -eq [IO.Pipes.PipeAccessRights]::FullControl) { $localOnly = $true }
  }
  if (-not $own -or -not $localOnly) { throw 'missing access' }
} finally { $pipe.Dispose() }
`;

export async function listenWindowsPipe(server: Server, path: string, gid?: number): Promise<void> {
  if (gid !== undefined) throw new Error('LOCAL_SOCKET_CONFLICT'); // POSIX groups have no Windows mapping.
  if (!namedPipe(path)) {
    try { lstatSync(path); throw new Error('LOCAL_SOCKET_CONFLICT'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    mkdirSync(dirname(path), { recursive: true });
  }
  const address = localSocketAddress(path);
  await new Promise<void>((done, fail) => {
    const failed = (error: Error) => { server.off('listening', ready); fail(error); };
    const ready = () => { server.off('error', failed); done(); };
    server.once('error', failed); server.once('listening', ready); server.listen(address);
  });
  try {
    // The kernel excludes another first instance and releases the name on process exit.
    // Default pipe permissions already exclude other users from writing HTTP requests;
    // tighten the DACL to this SID before reporting readiness.
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(protect, 'utf16le').toString('base64')], {
      env: { ...process.env, XJ_LOCAL_PIPE: address }, windowsHide: true, timeout: 15000, maxBuffer: 16384,
    });
  } catch {
    await new Promise<void>(done => server.close(() => done()));
    throw new Error('LOCAL_SOCKET_CONFLICT');
  }
}
