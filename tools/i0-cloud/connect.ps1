#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'connect')]
param(
  [Parameter(Mandatory, ParameterSetName = 'connect')][string]$IdentityFile,
  [Parameter(Mandatory, ParameterSetName = 'connect')][string]$ConnectionFile,
  [Parameter(ParameterSetName = 'connect')][string]$BindAddress = '',
  [Parameter(Mandatory, ParameterSetName = 'help')][switch]$Help
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Help) {
  Write-Output 'Browser tunnel utility. The private handover supplies the connection file, authorized identity and usage steps.'
  Write-Output 'Only a registered private configuration is accepted. The example cannot connect.'
  return
}
. (Join-Path $PSScriptRoot 'ssh-common.ps1')
$connection = Get-XjCloudConnection $ConnectionFile $IdentityFile $BindAddress
$config = $connection.Config
if ($config.browserUser -notmatch '^[a-z_][a-z0-9_-]{0,31}$' -or
    ($config.browserLocalPort -isnot [long] -and $config.browserLocalPort -isnot [int]) -or
    ($config.applicationPort -isnot [long] -and $config.applicationPort -isnot [int]) -or
    $config.browserLocalPort -lt 1 -or $config.browserLocalPort -gt 65535 -or $config.applicationPort -lt 1 -or $config.applicationPort -gt 65535) {
  throw 'The private browser identity and loopback ports are required.'
}
$browserOrigin = $null
if (-not [Uri]::TryCreate([string]$config.browserOrigin, [UriKind]::Absolute, [ref]$browserOrigin) -or
    $browserOrigin.Scheme -ne 'https' -or -not $browserOrigin.IsLoopback -or $browserOrigin.Port -ne $config.browserLocalPort -or
    $browserOrigin.UserInfo -or $browserOrigin.Query -or $browserOrigin.Fragment -or $browserOrigin.AbsolutePath -ne '/') {
  throw 'The private browser origin must match its HTTPS loopback port.'
}
if (Get-NetTCPConnection -State Listen -LocalPort $config.browserLocalPort -ErrorAction SilentlyContinue) {
  throw 'The configured local browser port is in use. This tool does not reuse or stop its owner.'
}
$forward = '127.0.0.1:{0}:127.0.0.1:{1}' -f $config.browserLocalPort, $config.applicationPort
$destination = '{0}@{1}' -f $config.browserUser, $config.host
$arguments = $connection.Arguments + @('-L', $forward, $destination)
Write-Host 'Connecting the shared application using the private handover configuration; Ctrl+C exits.'
& $connection.Ssh @arguments
if ($LASTEXITCODE -ne 0) { throw "SSH browser tunnel exited with code $LASTEXITCODE." }
