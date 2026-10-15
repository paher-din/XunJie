Set-StrictMode -Version Latest

function Get-XjCloudConnection([string]$ConnectionFile, [string]$IdentityFile, [string]$BindAddress = '') {
  if (-not (Test-Path -LiteralPath $ConnectionFile -PathType Leaf)) { throw 'The issued cloud connection file was not found.' }
  $configItem = Get-Item -LiteralPath $ConnectionFile
  if ($configItem.Attributes -band [IO.FileAttributes]::ReparsePoint -or $configItem.Length -gt 65536) {
    throw 'A private regular connection file is required.'
  }
  $configPath = $configItem.FullName
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $parsedAddress = $null
  $remoteHost = [string]$config.host
  $isAddress = [Net.IPAddress]::TryParse($remoteHost, [ref]$parsedAddress)
  $isDns = $remoteHost.Length -le 253 -and $remoteHost -match '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
  if ($config.version -ne 1 -or $config.registered -ne $true -or (-not $isAddress -and -not $isDns) -or
      ($config.port -isnot [long] -and $config.port -isnot [int]) -or $config.port -lt 1 -or $config.port -gt 65535) {
    throw 'An issued, registered private cloud connection is required; the example is not runnable.'
  }
  if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) { throw 'Your authorized SSH identity file was not found.' }
  $identity = (Resolve-Path -LiteralPath $IdentityFile).ProviderPath
  $pinPath = if ([IO.Path]::IsPathRooted([string]$config.knownHostsFile)) { [IO.Path]::GetFullPath([string]$config.knownHostsFile) }
    else { [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $configPath) ([string]$config.knownHostsFile))) }
  if (-not (Test-Path -LiteralPath $pinPath -PathType Leaf)) { throw 'The independently verified cloud SSH host pin was not found.' }
  $pins = @(Get-Content -LiteralPath $pinPath | Where-Object { $_ -and -not $_.StartsWith('#') })
  $hostToken = if ($config.port -eq 22) { $remoteHost } else { '[{0}]:{1}' -f $remoteHost, $config.port }
  $pinPattern = '^' + [Regex]::Escape($hostToken) + ' ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$'
  if ($pins.Count -ne 1 -or $pins[0] -notmatch $pinPattern) {
    throw 'The private file must contain the exact public host pin for the configured destination.'
  }
  $nullFile = if ($IsWindows) { 'NUL' } else { '/dev/null' }
  $arguments = @(
    '-F', $nullFile, '-N', '-T', '-p', [string]$config.port, '-i', $identity,
    '-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$pinPath",
    '-o', "GlobalKnownHostsFile=$nullFile", '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'
  )
  if ($BindAddress) {
    $sourceAddress = $null
    if (-not [Net.IPAddress]::TryParse($BindAddress, [ref]$sourceAddress)) { throw 'BindAddress must be an IP address on this computer.' }
    $arguments += @('-o', "BindAddress=$BindAddress")
  }
  return @{ Config = $config; Arguments = $arguments; Ssh = (Get-Command ssh -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
}
