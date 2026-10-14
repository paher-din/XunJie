#Requires -Version 7.0
[CmdletBinding()]
param(
  [ValidateSet('help','probe','receive')][string]$Operation='help',
  [string]$MaintenanceEntry='D:\XunJie_Project\i0-ui55-connection\xunjie-paher.ps1',
  [string]$OutputDirectory='D:\XunJie_Project\i0-ui55-connection\hdl-ui\local-environment\oci',
  [string]$NodeExecutable='D:\nodejs\node.exe',
  [ValidateRange(60,3600)][int]$TimeoutSeconds=1200
)
$ErrorActionPreference='Stop'
if($Operation -eq 'help'){
  @'
Receive only the four images declared by current PAHER C/HDL readiness, as non-secret immutable bytes.
  pwsh -NoProfile -File receive-frozen-images.ps1 probe
  pwsh -NoProfile -File receive-frozen-images.ps1 receive
Uses the existing strict p3148 maintenance SSH and the existing PAHER guest maintenance key by path only.
No private-key/password/config/database/ledger/validation body is copied; no service or VM is modified.
Docker image save stdout is streamed as binary directly to a new D: file. Nothing large is staged remotely.
New files only; no overwrite, delete, global config, image rebuild, Docker load or automatic retry.
The paired Node verifier checks TAR headers/file list, config image IDs, architecture, each layer diffID and archive SHA256.
Output names/source metadata, bytes and hashes are public transfer receipts; they are not Robert-local acceptance.
'@
  return
}
$approvedRoot=[IO.Path]::GetFullPath('D:\XunJie_Project\i0-ui55-connection\hdl-ui\local-environment\oci')
$destination=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if(-not [string]::Equals($destination,$approvedRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Only the exact approved D OCI directory is accepted.'}
foreach($path in @($MaintenanceEntry,$NodeExecutable,(Join-Path $PSScriptRoot 'receive-frozen-images.mjs'))){if(-not (Test-Path -LiteralPath $path -PathType Leaf)){throw 'An existing approved tool reference is missing.'}}
$check=$destination
while($check){if(Test-Path -LiteralPath $check){if((Get-Item -LiteralPath $check -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Artifact path contains a reparse point.'}};$check=[IO.Path]::GetDirectoryName($check)}
# The retained entry has Operation/TimeoutSeconds parameters of its own. Preserve
# the receiver's explicitly chosen operation and timeout across dot-sourcing.
$receiveOperation=$Operation;$receiveTimeoutSeconds=$TimeoutSeconds
. $MaintenanceEntry
$Operation=$receiveOperation;$TimeoutSeconds=$receiveTimeoutSeconds
$program=(& $NodeExecutable (Join-Path $PSScriptRoot 'receive-frozen-images.mjs') --probe-program) -join "`n"
if($LASTEXITCODE -ne 0 -or -not $program){throw 'The public source probe could not be generated.'}
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($program))
$remote=@'
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$program=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PROGRAM__'))
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName='wsl.exe';$start.Arguments='-d Ubuntu -u root -- /opt/xunjie-runner/node/bin/node -'
$start.UseShellExecute=$false;$start.CreateNoWindow=$true
$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
$process=[Diagnostics.Process]::new();$process.StartInfo=$start
try {
  $null=$process.Start()
  $output=$process.StandardOutput.ReadToEndAsync();$errors=$process.StandardError.ReadToEndAsync()
  $process.StandardInput.WriteLine($program);$process.StandardInput.Close()
  if(-not $process.WaitForExit(75000)){$process.Kill();$process.WaitForExit();throw 'Current source probe timed out.'}
  [Console]::Out.Write($output.GetAwaiter().GetResult())
  $null=$errors.GetAwaiter().GetResult()
  $code=$process.ExitCode
} finally {$process.Dispose()}
exit $code
'@
$captured=Invoke-XjMaintenancePowerShellScript -PowerShellScript $remote.Replace('__PROGRAM__',$encoded) -TimeoutSeconds 90
if($captured.ExitCode -ne 0){
  # The dedicated probe outputs only its static stage and whitelisted public readiness fields.
  if($captured.StdOut.Trim()){[Console]::Error.WriteLine($captured.StdOut.Trim())}
  throw 'Current image source could not be verified; no image export was started.'
}
$source=ConvertFrom-Json -InputObject $captured.StdOut -ErrorAction Stop
if($source.c.ready -ne $true -or $source.hdl.ready -ne $true -or @($source.images).Count -ne 4){throw 'Current C/HDL readiness is not verified.'}
$ids=@($source.images | ForEach-Object {$_.Id})
if(@($ids | Select-Object -Unique).Count -ne 4 -or @($ids | Where-Object {$_ -cnotmatch '^sha256:[a-f0-9]{64}$'}).Count){throw 'The four image IDs are not valid immutable references.'}
$null=New-Item -ItemType Directory -Path $destination -Force
$stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)
$sourcePath=Join-Path $destination ('source-image-receipt-'+$stamp+'.json')
[IO.File]::WriteAllText($sourcePath,($source | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
if($Operation -eq 'probe'){@{sourceReceipt=$sourcePath;imageIDs=$ids;ready=$true} | ConvertTo-Json -Depth 3;return}
$archive=Join-Path $destination ('frozen-images-'+$stamp+'.tar')
$inner='/opt/xunjie-runner/engine/docker --host=unix:///run/xunjie-c1-docker.sock image save '+($ids -join ' ')
$rawCommand='wsl.exe -d Ubuntu -u root -- /usr/bin/ssh -T -i /opt/xunjie-runner/vm/keys/maintenance -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/opt/xunjie-runner/vm/keys/known_hosts -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=8 -p 2222 root@127.0.0.1 '+$inner
Assert-XjMaintenancePrerequisites
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=$script:XjMaintenanceSsh;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.RedirectStandardInput=$true
foreach($argument in @('-T','-p','22')+(Get-XjMaintenanceOptions)+@($script:XjMaintenanceTarget,$rawCommand)){$start.ArgumentList.Add($argument)}
$process=[Diagnostics.Process]::new();$process.StartInfo=$start
$stream=$null;$failure=$null
try {
  $stream=[IO.File]::Open($archive,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  $null=$process.Start();$process.StandardInput.Close()
  $errors=$process.StandardError.ReadToEndAsync()
  $copy=$process.StandardOutput.BaseStream.CopyToAsync($stream)
  if(-not $process.WaitForExit($TimeoutSeconds*1000)){$process.Kill($true);$process.WaitForExit();throw 'The binary image transfer timed out; the incomplete new archive is retained.'}
  $null=$copy.GetAwaiter().GetResult();$stream.Flush($true)
  $safeErrors=$errors.GetAwaiter().GetResult()
  if($process.ExitCode -ne 0){throw 'The authenticated image stream did not complete successfully; the partial new archive is retained.'}
}catch{$failure=$_.Exception.Message}
finally{if($stream){$stream.Dispose()};$process.Dispose()}
if($failure){@{sourceReceipt=$sourcePath;partialArchive=$archive;confirmed=$false;reason=$failure} | ConvertTo-Json -Depth 3;throw 'Frozen image reception failed; no retry, node or service changes were made.'}
$verifiedText=(& $NodeExecutable (Join-Path $PSScriptRoot 'receive-frozen-images.mjs') verify $archive $sourcePath) -join "`n"
if($LASTEXITCODE -ne 0){throw 'Received archive did not pass identity/layer verification; the new file is retained for diagnosis and must not be loaded.'}
$verification=ConvertFrom-Json -InputObject $verifiedText -ErrorAction Stop
$verification | Add-Member -NotePropertyName sourceReceipt -NotePropertyValue $sourcePath
$verificationPath=Join-Path $destination ('verified-image-receipt-'+$stamp+'.json')
[IO.File]::WriteAllText($verificationPath,($verification | ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
@{archive=$archive;verificationReceipt=$verificationPath;sourceReceipt=$sourcePath;bytes=$verification.bytes;sha256=$verification.sha256;imageIDs=$verification.imageIDs;passed=$verification.passed} | ConvertTo-Json -Depth 3
