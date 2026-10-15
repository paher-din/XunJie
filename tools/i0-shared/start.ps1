#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'start')]
param(
  [Parameter(Mandatory, ParameterSetName = 'start')]
  [ValidateNotNullOrEmpty()]
  [string]$IdentityFile,
  [Parameter(ParameterSetName = 'start')]
  [string]$BindAddress,
  [Parameter(Mandatory, ParameterSetName = 'help')]
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Help) {
  @'
PAHER shared application tunnel (PowerShell 7)
  ./start.ps1 -IdentityFile <your-authorized-private-key> [-BindAddress <local-source-IP>]
  ./start.ps1 -Help

Open https://127.0.0.1:3444 after SSH connects. Keep this terminal open; Ctrl+C exits.
The local port must be free. Existing services are never reused or stopped.
IdentityFile must belong to you and already be authorized for xunjie-tunnel.
BindAddress only selects the outbound SSH source IP; the browser listener stays on 127.0.0.1.
'@
  return
}

if (Get-NetTCPConnection -State Listen -LocalPort 3444 -ErrorAction SilentlyContinue) {
  throw 'Local port 3444 is already in use. This tool does not reuse or stop the existing service.'
}
if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
  throw 'Your authorized SSH IdentityFile was not found.'
}
$identityPath = (Resolve-Path -LiteralPath $IdentityFile).ProviderPath
$knownHosts = Join-Path $PSScriptRoot 'known_hosts'
if (-not (Test-Path -LiteralPath $knownHosts -PathType Leaf)) {
  throw 'The bundled PAHER public host key is missing.'
}
$ssh = (Get-Command ssh -CommandType Application -ErrorAction Stop).Source
$arguments = @(
  '-F', 'NUL', '-N', '-T', '-p', '22', '-i', $identityPath,
  '-L', '127.0.0.1:3444:127.0.0.1:3444',
  '-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$knownHosts",
  '-o', 'GlobalKnownHostsFile=NUL', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
  '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey',
  '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
  '-o', 'ExitOnForwardFailure=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'
)
if ($BindAddress) { $arguments += @('-b', $BindAddress) }
$arguments += 'xunjie-tunnel@192.168.3.15'
Write-Host 'Connecting PAHER shared application. Open https://127.0.0.1:3444; Ctrl+C closes this tunnel.'
& $ssh @arguments
if ($LASTEXITCODE -ne 0) { throw "SSH tunnel exited with code $LASTEXITCODE." }
