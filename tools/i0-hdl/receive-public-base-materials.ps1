#Requires -Version 7.0
[CmdletBinding()]
param(
  [switch]$Fetch,
  [string]$MaintenanceEntry = 'D:\XunJie_Project\i0-ui55-connection\xunjie-paher.ps1',
  [string]$Destination = 'D:\XunJie_Project\i0-ui55-connection\hdl-ui\local-environment\downloads'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Only these public upstream binaries are eligible. Never transfer a guest disk,
# seed, private key, database, model credential, or an old validation record.
$materials = @(
  @{ name='noble-20260926-amd64.img'; remote='/opt/xunjie-runner/vm/images/noble-20260926-amd64.img'; bytes=625612288L; sha256='6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2' },
  @{ name='node-v24.21.0-linux-x64.tar.xz'; remote='/opt/xunjie-runner/downloads/node-v24.21.0-linux-x64.tar.xz'; bytes=31890184L; sha256='fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6' },
  @{ name='docker-29.8.2.tgz'; remote='/opt/xunjie-runner/downloads/docker-29.8.2.tgz'; bytes=85591344L; sha256='995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f' }
)
if (-not $Fetch) {
  [pscustomobject]@{ operation='public-only-copy'; destination=$Destination; material=$materials; totalBytes=($materials.bytes | Measure-Object -Sum).Sum } | ConvertTo-Json -Depth 5
  return
}
. $MaintenanceEntry
Assert-XjMaintenancePrerequisites
$downloadRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
$retainedRoot = [IO.Path]::GetFullPath('D:\XunJie_Project\i0-ui55-connection\hdl-ui').TrimEnd('\')
if (-not $downloadRoot.StartsWith($retainedRoot+'\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination must stay within this task retained directory.' }
Assert-XjNoReparsePoint $downloadRoot
$null = New-Item -ItemType Directory -Path $downloadRoot -Force
$receipts = @()
foreach ($material in $materials) {
  $target = Join-Path $downloadRoot $material.name
  Assert-XjNoReparsePoint $target
  if (Test-Path -LiteralPath $target) {
    if ((Get-Item -LiteralPath $target).Length -ne $material.bytes -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $material.sha256) { throw 'An existing public material differs; no overwrite permitted.' }
    $receipts += [pscustomobject]@{ name=$material.name; bytes=$material.bytes; sha256=$material.sha256; status='verified-existing' }
    continue
  }
  $staging = $target+'.'+[Guid]::NewGuid().ToString('N')+'.part'
  $processInfo = [Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = $script:XjMaintenanceSsh
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  foreach ($argument in ((Get-XjMaintenanceOptions)+@($script:XjMaintenanceTarget, 'wsl -d Ubuntu -u root --exec cat '+$material.remote))) { $processInfo.ArgumentList.Add($argument) }
  $transfer = [Diagnostics.Process]::new()
  $transfer.StartInfo = $processInfo
  $output = [IO.File]::Open($staging,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {
    Write-Output ('Receiving public material: '+$material.name)
    $null = $transfer.Start()
    $errorOutput = $transfer.StandardError.ReadToEndAsync()
    $binaryCopy = $transfer.StandardOutput.BaseStream.CopyToAsync($output)
    if (-not $transfer.WaitForExit(300000)) { $transfer.Kill($true); throw 'Public transfer timed out; partial file retained.' }
    [void]$binaryCopy.GetAwaiter().GetResult()
    if ($transfer.ExitCode -ne 0) { throw 'Public transfer failed; partial file retained.' }
    $null = $errorOutput.GetAwaiter().GetResult()
    $output.Flush($true)
  } finally { $output.Dispose(); $transfer.Dispose() }
  if ((Get-Item -LiteralPath $staging).Length -ne $material.bytes -or (Get-FileHash -LiteralPath $staging -Algorithm SHA256).Hash.ToLowerInvariant() -ne $material.sha256) { throw 'Public transfer byte/hash mismatch; partial file retained.' }
  [IO.File]::Move($staging,$target,$false)
  $receipts += [pscustomobject]@{ name=$material.name; bytes=$material.bytes; sha256=$material.sha256; status='received-verified' }
}
[pscustomobject]@{ observedAtUtc=[DateTimeOffset]::UtcNow.ToString('o'); material=$receipts; copiedSecrets=$false; copiedGuestDisk=$false; copiedDatabase=$false } | ConvertTo-Json -Depth 5
