# Run under an InteractiveToken/LeastPrivilege h scheduled task. No installer
# execution, power action, real PG start or browser action is performed.
param([Parameter(Mandatory=$true)][string]$LabRoot)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$node=Join-Path $LabRoot 'package\resources\node\node.exe'
$cli=Join-Path $LabRoot 'package\app\cli.js'
$environment=Join-Path $LabRoot 'never-created-environment'
$cache=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'XunJie\prerequisites\vc14-x64-14.51.36247'
$cacheFile=Join-Path $cache 'VC_redist.x64.exe'
function Invoke-Product([string[]]$CommandArguments){
  $p=[Diagnostics.Process]::new(); $p.StartInfo=[Diagnostics.ProcessStartInfo]::new()
  $p.StartInfo.FileName=$node; $p.StartInfo.WorkingDirectory=$LabRoot
  $p.StartInfo.Arguments=(@($cli)+$CommandArguments | ForEach-Object {'"'+$_+'"'}) -join ' '
  $p.StartInfo.UseShellExecute=$false; $p.StartInfo.CreateNoWindow=$true
  $p.StartInfo.RedirectStandardOutput=$true; $p.StartInfo.RedirectStandardError=$true
  $p.StartInfo.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
  $p.StartInfo.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
  try{
    [void]$p.Start();$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
    if(-not $p.WaitForExit(180000)){$p.Kill();throw 'Product prerequisite probe exceeded 180 seconds.'}
    $value=$null;if($out.Result.Trim()){try{$value=$out.Result|ConvertFrom-Json}catch{}}
    @{arguments=$CommandArguments;exit=$p.ExitCode;result=$value;stdout=$out.Result;stderr=$err.Result}
  }finally{if($p.Id -and -not $p.HasExited){$p.Kill();$p.WaitForExit()};$p.Dispose()}
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$report=[ordered]@{capturedAt=[DateTime]::UtcNow.ToString('o');user=$identity.Name;elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);labRoot=$LabRoot;cleanMachine=$false;cacheExistedBefore=(Test-Path $cacheFile)}
try{
  $readonly=@();foreach($command in @('--help','status','stop')){$readonly+=Invoke-Product @($command,'--root',$environment,'--json')}
  $report.readonly=$readonly; $report.cacheExistsAfterReadonly=Test-Path $cacheFile
  $report.remote=Invoke-Product @('prepare','--profile','remote','--root',$environment,'--json')
  $config=Join-Path $LabRoot 'external.json'
  [IO.File]::WriteAllText($config,'{"profile":"local","database":{"mode":"external"}}',[Text.UTF8Encoding]::new($false))
  $report.external=Invoke-Product @('prepare','--config',$config,'--root',$environment,'--json')
  $report.cacheExistsAfterRemoteAndExternal=Test-Path $cacheFile
  $managed=@();foreach($command in @('prepare','install','launch')){$managed+=Invoke-Product @($command,'--root',$environment,'--json')}
  $report.managed=$managed; $report.environmentExists=Test-Path $environment
  $report.preparedMetadata=[IO.File]::ReadAllText((Join-Path $cache 'prepared.json'))|ConvertFrom-Json
  $report.runtimeVersionAfter=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64').Version
  $report.status=if(-not $report.elevated -and -not $report.environmentExists -and ($managed|Where-Object {$_.exit -ne 3 -or $_.result.status -ne 'installation-required'}).Count -eq 0 -and $report.remote.exit -eq 0 -and $report.external.exit -eq 0){'passed'}else{'failed'}
}catch{$report.status='failed';$report.error=$_.Exception.Message}
$report.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText((Join-Path $LabRoot 'product-probe.json'),($report|ConvertTo-Json -Depth 18),[Text.UTF8Encoding]::new($false))
