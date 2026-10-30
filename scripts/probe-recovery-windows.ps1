# Launch from an InteractiveToken / Limited scheduled task for the current user.
param([Parameter(Mandatory=$true)][string]$LabRoot,[ValidatePattern('^[a-zA-Z0-9-]+$')][string]$RunName='windows-r1')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if($elevated){throw 'Run recovery acceptance with a Limited user token'}
$package=Join-Path $LabRoot 'xunjie-145-product-win18'
$node=Join-Path $package 'resources\node\node.exe'
$scripts=Join-Path $LabRoot 'harness\scripts'
$s3=Join-Path $LabRoot ('s3-'+$RunName)
$report=[ordered]@{capturedAt=[DateTime]::UtcNow.ToString('o');user=$identity.Name;elevated=$elevated;status='running'}
function Invoke-Node([string[]]$NodeArguments,[string]$OutputName,[string]$ErrorName) {
  $process=[Diagnostics.Process]::new()
  $process.StartInfo=[Diagnostics.ProcessStartInfo]::new()
  $process.StartInfo.FileName=$node
  $process.StartInfo.Arguments=($NodeArguments | ForEach-Object {'"'+$_+'"'}) -join ' '
  $process.StartInfo.UseShellExecute=$false
  $process.StartInfo.CreateNoWindow=$true
  $process.StartInfo.RedirectStandardOutput=$true
  $process.StartInfo.RedirectStandardError=$true
  $process.StartInfo.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
  $process.StartInfo.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
  try {
    [void]$process.Start()
    $stdout=$process.StandardOutput.ReadToEndAsync()
    $stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(900000)){$process.Kill();throw 'Owned recovery probe timed out'}
    [IO.File]::WriteAllText((Join-Path $LabRoot $OutputName),$stdout.Result,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $LabRoot $ErrorName),$stderr.Result,[Text.UTF8Encoding]::new($false))
    return $process.ExitCode
  } finally {$process.Dispose()}
}
try {
  $weed=Join-Path $LabRoot 'weed.exe'
  if(Test-Path $weed) {
    $code=Invoke-Node @((Join-Path $scripts 'storage-s3-fixture.mjs'),'--binary',$weed,'--root',$s3) ($RunName+'-s3-start.out') ($RunName+'-s3-start.log')
  } else {
    $code=Invoke-Node @((Join-Path $scripts 'storage-s3-fixture.mjs'),'--download','--root',$s3) ($RunName+'-s3-start.out') ($RunName+'-s3-start.log')
  }
  if($code -ne 0){throw 'S3 fixture failed; inspect public fixture diagnostics'}
  $code=Invoke-Node @((Join-Path $scripts 'probe-recovery.mjs'),'--package',$package,'--root',(Join-Path $LabRoot $RunName),'--out',(Join-Path $LabRoot ($RunName+'.json')),'--s3-config',(Join-Path $s3 's3-config.json'),'--old-package',(Join-Path $LabRoot 'xunjie-145-product-win1710'),'--minor-package',(Join-Path $LabRoot 'xunjie-145-product-win1711')) ($RunName+'.out') ($RunName+'.log')
  if($code -ne 0){throw 'Recovery probe failed; inspect public evidence'}
  $report.status='passed'
} catch {
  $report.status='failed';$report.error=$_.Exception.Message
} finally {
  if(Test-Path (Join-Path $s3 's3-config.json')) {
    $code=Invoke-Node @((Join-Path $scripts 'storage-s3-fixture.mjs'),'--stop','--root',$s3) ($RunName+'-s3-stop.out') ($RunName+'-s3-stop.log')
    $report.s3Stopped=($code -eq 0)
    if(-not $report.s3Stopped){$report.status='failed'}
  }
  $report.completedAt=[DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllText((Join-Path $LabRoot ('limited-token-'+$RunName+'.json')),($report|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
}
if($report.status -ne 'passed'){exit 1}
