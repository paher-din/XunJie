#Requires -Version 7.0
[CmdletBinding()]
param(
  [string]$EntryPath = (Join-Path $PSScriptRoot 'maintenance.ps1'),
  [switch]$SealOnly,
  [switch]$LongScriptOnly,
  [string]$SealEntryPath = (Join-Path $PSScriptRoot 'seal-student-credential.ps1')
)
$ErrorActionPreference = 'Stop'
. $EntryPath

function Assert-Rejected([scriptblock]$Action, [string]$Name) {
  $rejected = $false
  try { $null = & $Action } catch { $rejected = $true }
  if (-not $rejected) { throw "Boundary was not rejected: $Name" }
}

if ($LongScriptOnly) {
  if ($SealOnly) { throw 'Select only one targeted test group.' }
  $script:XjCapturedLongScript = $null
  function Assert-XjMaintenancePrerequisites { }
  function Invoke-XjCapturedProcess {
    param([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds, [string]$InputText)
    $script:XjCapturedLongScript = [pscustomobject]@{
      FilePath = $FilePath; Arguments = $Arguments; TimeoutSeconds = $TimeoutSeconds; InputText = $InputText
    }
    return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' }
  }
  $text = (( '# 长注释😀"quoted"' + "`n") * 2048) + "[Console]::Out.WriteLine('LONG-脚本-😀')`nGet-Date -Format o"
  $result = Invoke-XjMaintenancePowerShellScript -PowerShellScript $text -TimeoutSeconds 20
  $captured = $script:XjCapturedLongScript
  if ($text.Length -le 8191 -or $captured.Arguments[-1].Length -ge 2048 -or
      ($captured.Arguments -join ' ').Length -ge 8191 -or $captured.Arguments[-1].Contains('LONG-脚本') -or
      $captured.FilePath -cne 'C:\Program Files\OpenSSH\ssh.exe' -or $captured.Arguments[-2] -cne 'p3148@192.168.3.15' -or
      $captured.TimeoutSeconds -ne 20 -or $result.ExitCode -ne 0) {
    throw 'Long script escaped into argv or changed the fixed invocation/result boundary.'
  }
  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($captured.InputText))
  if ($decoded -cne $text) { throw 'The complete long Unicode script did not reach InputText.' }
  $script:XjCapturedLongScript = $null
  Assert-Rejected { Invoke-XjMaintenancePowerShellScript -PowerShellScript ' ' } 'blank script'
  Assert-Rejected { Invoke-XjMaintenancePowerShellScript -PowerShellScript ([string][char]0) } 'NUL script'
  Assert-Rejected { Invoke-XjMaintenancePowerShellScript -PowerShellScript 'Get-Date' -TimeoutSeconds -1 } 'invalid timeout'
  if ($null -ne $script:XjCapturedLongScript) { throw 'An invalid input reached the process boundary.' }
  'Passed: long Unicode script uses short fixed argv and complete UTF8/base64 stdin; empty/NUL/invalid-timeout inputs never launch. No network, credentials or filesystem mutations.'
  return
}

if ($SealOnly) {
  $weak = [Security.Cryptography.RSA]::Create(1024)
  $strong = [Security.Cryptography.RSA]::Create(2048)
  try {
    $missingEntry = Join-Path $script:XjMaintenanceRoot ('missing-entry-' + [Guid]::NewGuid().ToString('N') + '.ps1')
    $cases = @(
      'not a PEM',
      "-----BEGIN PRIVATE KEY-----`nQUJD`n-----END PRIVATE KEY-----",
      $weak.ExportSubjectPublicKeyInfoPem(),
      $strong.ExportSubjectPublicKeyInfoPem(),
      ($strong.ExportSubjectPublicKeyInfoPem() + "`n" + $strong.ExportSubjectPublicKeyInfoPem())
    )
    foreach ($recipientPem in $cases) {
      $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
      $start.UseShellExecute = $false
      $start.CreateNoWindow = $true
      $start.RedirectStandardOutput = $true
      $start.RedirectStandardError = $true
      foreach ($argument in @('-NoProfile', '-File', $SealEntryPath, '-MaintenanceEntry', $missingEntry, '-RecipientPublicKeyPem', $recipientPem)) {
        $start.ArgumentList.Add($argument)
      }
      $process = [Diagnostics.Process]::new()
      $process.StartInfo = $start
      try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) { $process.Kill($true); throw 'Seal boundary child timed out.' }
        if ($process.ExitCode -eq 0 -or $stdout.GetAwaiter().GetResult() -ne '' -or
            $stderr.GetAwaiter().GetResult() -notmatch 'secret output suppressed') {
          throw 'Seal boundary did not fail without credential output.'
        }
      } finally { $process.Dispose() }
    }
    'Passed: malformed/private/mixed/weak recipient PEM and missing maintenance entry rejected without stdout. No real credential read, network or filesystem mutations.'
  } finally { $weak.Dispose(); $strong.Dispose() }
  return
}

foreach ($path in @('D:\outside-new.txt', '..\outside-new.txt', 'README.zh-CN.md',
    'new.txt:alternate-stream', 'CON.txt', 'new.txt.', 'nested\..\new.txt', 'D:\XunJie_Project\i0-ui55-connection-other\new.txt')) {
  Assert-Rejected { Resolve-XjDownloadDestination $path } 'local path'
}
$candidate = Resolve-XjDownloadDestination ('maintenance-boundary-' + [Guid]::NewGuid().ToString('N') + '.json')
if (-not $candidate.StartsWith('D:\XunJie_Project\i0-ui55-connection\')) { throw 'A safe new destination did not stay inside the tool root.' }

foreach ($path in @('relative.json', '/C:/Users/p3148/*.json', "/C:/Users/p3148/file`nput another", '/C:/Users/p3148/a"b.json', '/C:/Users/p3148/[ab].json')) {
  Assert-Rejected { Assert-XjRemoteDownloadPath $path } 'remote SFTP path'
}
Assert-XjRemoteDownloadPath '/C:/Users/p3148/example with space.json'

$sample = "Write-Output 'a`"b'; Write-Output ([char]0x4e2d)"
$command = ConvertTo-XjEncodedCommand $sample
$decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(($command -split ' ')[-1]))
if ($decoded -cne $sample -or $command -notmatch '^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$') {
  throw 'EncodedCommand did not preserve the script without shell metacharacters.'
}
Assert-Rejected { ConvertTo-XjEncodedCommand '' } 'empty script'
Assert-Rejected { ConvertTo-XjEncodedCommand ([string][char]0) } 'NUL script'
'Passed: local no-overwrite/path boundaries; SFTP batch-injection/wildcard boundaries; EncodedCommand preservation. No network, credentials or filesystem mutations.'
