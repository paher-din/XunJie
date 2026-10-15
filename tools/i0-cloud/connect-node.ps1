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
  Write-Output 'Execution tunnel utility. The private handover supplies the connection file, authorized identity and usage steps.'
  Write-Output 'No VM, key, ledger or database initialization. The example cannot connect.'
  return
}
. (Join-Path $PSScriptRoot 'ssh-common.ps1')
$connection = Get-XjCloudConnection $ConnectionFile $IdentityFile $BindAddress
$config = $connection.Config
if ($config.nodeId -notmatch '^[A-Za-z0-9_-]{1,64}$' -or $config.nodeUser -notmatch '^[a-z_][a-z0-9_-]{0,31}$' -or
    ($config.remoteRunnerPort -isnot [long] -and $config.remoteRunnerPort -isnot [int]) -or
    ($config.localRunnerPort -isnot [long] -and $config.localRunnerPort -isnot [int]) -or
    $config.remoteRunnerPort -lt 1 -or $config.remoteRunnerPort -gt 65535 -or $config.localRunnerPort -lt 1 -or $config.localRunnerPort -gt 65535) {
  throw 'The pre-registered node identity and loopback ports are required.'
}
$forward = "127.0.0.1:$($config.remoteRunnerPort):127.0.0.1:$($config.localRunnerPort)"
$destination = '{0}@{1}' -f $config.nodeUser, $config.host
$arguments = $connection.Arguments + @('-R', $forward, $destination)
Write-Host 'Connecting the existing execution node using the private handover configuration; Ctrl+C exits.'
& $connection.Ssh @arguments
if ($LASTEXITCODE -ne 0) { throw "SSH node tunnel exited with code $LASTEXITCODE." }
