param(
  [Parameter(Mandatory=$true)][string]$PackageDirectory,
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Output,
  [ValidateRange(20,120)][int]$SleepSeconds = 60,
  [switch]$ResumeExisting,
  [string]$ExpectedEnvironmentId
)

# External consumer of the actual distribution. No system power policy changes.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$node = Join-Path $PackageDirectory 'resources\node\node.exe'
$cli = Join-Path $PackageDirectory 'app\cli.js'
$pg = Join-Path $PackageDirectory 'resources\postgres\bin'
$report = [ordered]@{ issue='https://github.com/paher-din/XunJie/issues/143'; status='running'; startedAt=[DateTime]::UtcNow.ToString('o'); platform='Windows 11 x64'; powerState='Actual power state is determined from fresh OS events'; signingNotarization='excluded-by-user'; browser='not-exercised-by-this-power-probe'; stages=@() }
$installed = $false
$oldPassword = $env:PGPASSWORD
$timer = [IntPtr]::Zero
function Save-Report { [IO.File]::WriteAllText($Output, ($report | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false)) }
function Product([string]$verb) {
  $text = & $node $cli $verb --root $Root
  if ($LASTEXITCODE -ne 0) { throw "Product $verb failed: $text" }
  return ($text | ConvertFrom-Json)
}
function Sql([string]$query) {
  $text = & (Join-Path $pg 'psql.exe') -X -q -A -t --set ON_ERROR_STOP=1 -h $binding.host -p $binding.port -U $binding.user -d $binding.database -c $query
  if ($LASTEXITCODE -ne 0) { throw 'Bundled psql failed' }
  return $text
}
function Snapshot {
  $state = Product 'status'
  if ($state.state -ne 'ready') { throw "Expected ready, got $($state.state)" }
  $instance = Get-Content -LiteralPath (Join-Path $Root 'instance.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $daemon = Get-CimInstance Win32_Process -Filter "ProcessId=$($instance.pid)"
  $data = Sql "SELECT json_build_object('identifier',(SELECT system_identifier::text FROM pg_control_system()),'directory',current_setting('data_directory'),'value',(SELECT value FROM sleep_probe WHERE id=1),'postmasterStarted',pg_postmaster_start_time());" | ConvertFrom-Json
  return [ordered]@{ state=$state.state; environment=$state.environment; daemonPid=$instance.pid; daemonCreatedAt=$daemon.CreationDate.ToUniversalTime().ToString('o'); database=$data }
}
try {
  Save-Report
  $os = Get-CimInstance Win32_OperatingSystem
  if ([int]$os.BuildNumber -lt 22000 -or ![Environment]::Is64BitOperatingSystem) { throw 'This probe targets Windows 11 x64' }
  $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($elevated) { throw 'The product power probe must use a non-elevated user token' }
  $report.host = [ordered]@{ version=[Environment]::OSVersion.VersionString; user=[Security.Principal.WindowsIdentity]::GetCurrent().Name; elevated=$elevated }
  $report.powerCapabilities = (& powercfg /a | Out-String)
  $report.wakePolicy = (& powercfg /query SCHEME_CURRENT SUB_SLEEP RTCWAKE | Out-String)
  if (Test-Path -LiteralPath $Root) {
    if (!$ResumeExisting -or !$ExpectedEnvironmentId) { throw 'Use a fresh environment or explicitly identify the owned environment to resume' }
    $existing = Product 'status'
    if ($existing.environment.environmentId -ne $ExpectedEnvironmentId) { throw 'Existing environment ownership mismatch' }
    $report.resumedEnvironmentId = $ExpectedEnvironmentId
    $installed = $true
  } else { $install = Product 'install'; $installed = $true }
  $start = Product 'start'
  if ($start.state -ne 'ready') { throw 'Product did not start ready' }
  $binding = Product 'database'
  $env:PGPASSWORD = [IO.File]::ReadAllText((Join-Path (Join-Path $Root 'credentials') $binding.credentialRef))
  $env:PGCONNECT_TIMEOUT = '5'; $env:PGCLIENTENCODING = 'UTF8'; $env:PGSSLMODE = 'disable'
  $sentinel = 'committed-before-sleep-' + [Guid]::NewGuid().ToString()
  Sql "CREATE TABLE IF NOT EXISTS sleep_probe(id integer PRIMARY KEY,value text NOT NULL); INSERT INTO sleep_probe VALUES (1,'$sentinel') ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value;" | Out-Null
  $before = Snapshot
  $report.before = $before
  $report.stages += 'standalone-package-installed-ready-and-committed-fixture'
  Save-Report
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class XunJieSleepProbe {
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint low; public int high; }
  [StructLayout(LayoutKind.Sequential)] struct Privileges { public uint count; public Luid luid; public uint attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint a,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool LookupPrivilegeValue(string system,string name,out Luid luid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref Privileges p,uint length,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateWaitableTimer(IntPtr attrs,bool manual,string name);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetWaitableTimer(IntPtr timer,ref long due,int period,IntPtr callback,IntPtr arg,bool resume);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr timer,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CancelWaitableTimer(IntPtr timer);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("powrprof.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.I1)]
  public static extern bool SetSuspendState([MarshalAs(UnmanagedType.I1)]bool hibernate,[MarshalAs(UnmanagedType.I1)]bool force,[MarshalAs(UnmanagedType.I1)]bool disableWake);
  public static void EnableExistingShutdownPrivilege() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(),0x28,out token)) throw new Win32Exception();
    try {
      Luid luid; if(!LookupPrivilegeValue(null,"SeShutdownPrivilege",out luid)) throw new Win32Exception();
      Privileges p = new Privileges {count=1,luid=luid,attributes=2};
      if(!AdjustTokenPrivileges(token,false,ref p,0,IntPtr.Zero,IntPtr.Zero)) throw new Win32Exception();
      int error=Marshal.GetLastWin32Error(); if(error!=0) throw new Win32Exception(error);
    } finally {CloseHandle(token);}
  }
}
'@
  [XunJieSleepProbe]::EnableExistingShutdownPrivilege()
  $timer = [XunJieSleepProbe]::CreateWaitableTimer([IntPtr]::Zero,$false,$null)
  if ($timer -eq [IntPtr]::Zero) { throw 'Cannot create wake timer' }
  $wakeAt = [DateTime]::UtcNow.AddSeconds($SleepSeconds + 5)
  $due = $wakeAt.ToFileTimeUtc()
  $armed = [XunJieSleepProbe]::SetWaitableTimer($timer,[ref]$due,0,[IntPtr]::Zero,[IntPtr]::Zero,$true)
  $wakeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if (!$armed -or $wakeError -eq 50) { throw "Automatic wake is unavailable ($wakeError)" }
  $report.phase = 'wake-timer-armed'
  $report.wakeAt = $wakeAt.ToString('o')
  $report.absoluteUtcWakeTimer = $true
  Save-Report
  Start-Sleep -Seconds 5
  $sleepAt = [DateTime]::UtcNow
  $suspended = [XunJieSleepProbe]::SetSuspendState($false,$false,$false)
  $suspendError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if (!$suspended) { throw "SetSuspendState failed ($suspendError)" }
  $signalled = [XunJieSleepProbe]::WaitForSingleObject($timer,90000)
  if ($signalled -ne 0) { throw "Wake timer did not signal ($signalled)" }
  $returnedAt = [DateTime]::UtcNow
  $events = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; StartTime=$sleepAt.AddSeconds(-1).ToLocalTime()} -ErrorAction SilentlyContinue | Where-Object {$_.Id -in @(42,107,506,507) -and $_.TimeCreated.ToUniversalTime() -ge $sleepAt.AddSeconds(-1)} | Sort-Object TimeCreated | ForEach-Object { [xml]$xml=$_.ToXml(); $states=@{}; foreach($d in $xml.Event.EventData.Data){if($d.Name -in @('TargetState','EffectiveState')){$states[[string]$d.Name]=[string]$d.'#text'}}; [ordered]@{id=$_.Id; time=$_.TimeCreated.ToUniversalTime().ToString('o'); recordId=$_.RecordId; effectiveState=$states.EffectiveState; targetState=$states.TargetState} })
  $report.power = [ordered]@{ requestedAt=$sleepAt.ToString('o'); suspendReturnedAt=$returnedAt.ToString('o'); elapsedMs=($returnedAt-$sleepAt).TotalMilliseconds; wakeTimerSignalled=($signalled -eq 0); events=$events; globalPowerPolicyChanged=$false }
  $entry = $events | Where-Object {$_.id -in @(42,506)} | Select-Object -First 1
  $exit = $events | Where-Object {$_.id -in @(107,507) -and $entry -and [DateTime]::Parse($_.time) -ge [DateTime]::Parse($entry.time)} | Select-Object -First 1
  if (!$entry -or !$exit) { throw 'No complete fresh OS sleep/resume event pair was observed; do not infer sleep from a timer' }
  $report.power.observedEventPair = [ordered]@{entryRecordId=$entry.recordId;exitRecordId=$exit.recordId;durationMs=([DateTime]::Parse($exit.time)-[DateTime]::Parse($entry.time)).TotalMilliseconds}
  $report.power.transitionKind = $(if ($entry.id -eq 506) { 'modern-standby-S0' } elseif ($entry.effectiveState -eq '5') { 'hibernate-S4' } else { 'system-sleep-as-recorded' })
  $report.power.wakeSource = 'not-established; an armed/signalled timer alone does not prove the wake source'
  $after = Snapshot
  $report.after = $after
  if (($before.environment | ConvertTo-Json -Depth 8 -Compress) -ne ($after.environment | ConvertTo-Json -Depth 8 -Compress)) { throw 'Environment/service ownership changed after wake' }
  if ($before.daemonPid -ne $after.daemonPid -or $before.daemonCreatedAt -ne $after.daemonCreatedAt) { throw 'Runtime daemon restarted during sleep' }
  if (($before.database | ConvertTo-Json -Compress) -ne ($after.database | ConvertTo-Json -Compress)) { throw 'Database identity, postmaster start time or committed data changed after wake' }
  $report.stages += 'actual-OS-sleep-resume-events-with-armed-wake-timer'
  $report.stages += 'same-runtime-database-identity-processes-and-committed-data-ready'
  $report.status = 'passed'
} catch {
  $report.status = 'failed'; $report.error = $_.Exception.Message
  $runtimeLog = Join-Path $Root 'logs\runtime.log'
  if (Test-Path -LiteralPath $runtimeLog) { $report.runtimeLogTail = @(Get-Content -LiteralPath $runtimeLog -Tail 20 -Encoding UTF8) }
} finally {
  if ($timer -ne [IntPtr]::Zero) { [XunJieSleepProbe]::CancelWaitableTimer($timer)|Out-Null; [XunJieSleepProbe]::CloseHandle($timer)|Out-Null }
  if ($installed) {
    try {
      $stop = Product 'stop'
      & (Join-Path $pg 'pg_ctl.exe') status -D (Join-Path $Root 'pgdata') *> $null
      if ($stop.state -ne 'stopped' -or $LASTEXITCODE -ne 3) { throw 'Owned product/database is not stopped' }
      $report.cleanup = [ordered]@{servicesStopped=$true; postgresStopped=$true; coordinatorMustRemoveAfterThisProbeExits=$true}
    } catch { $report.cleanup = [ordered]@{error=$_.Exception.Message}; $report.status='failed' }
  }
  $env:PGPASSWORD = $oldPassword
  $report.finishedAt = [DateTime]::UtcNow.ToString('o')
  Save-Report
}
if ($report.status -ne 'passed') { exit 1 }
