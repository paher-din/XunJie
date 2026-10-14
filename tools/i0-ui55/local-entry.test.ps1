#Requires -Version 7.0
param([Parameter(Mandatory)][string]$EntryPath, [Parameter(Mandatory)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile($EntryPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Entry syntax invalid.' }
# Load only the reviewed helper functions, never the entry dispatcher or setup.
$names = @('Get-PropValue', 'Get-FileSha256', 'Assert-NoReparsePoint', 'Assert-InConnectionRoot',
  'Get-ActiveDist', 'Test-ActiveDist', 'Test-ControlledAcl', 'Get-RecordStatus', 'Invoke-AnonymousGet')
foreach ($name in $names) {
  $definition = $tree.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true)
  if (-not $definition) { throw "Helper missing: $name" }
  Invoke-Expression $definition.Extent.Text
}
function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Rejected([scriptblock]$Operation, [string]$Message) {
  $rejected = $false
  try { $null = & $Operation } catch { $rejected = $true }
  Assert-True $rejected $Message
}

$GatewayScript = 'D:\synthetic-only\gateway.mjs'
$TunnelLocalPort = 14443
$TunnelRemote = '127.0.0.1:3443'
$fixtureStart = [datetime]::UtcNow
$script:fixtureProcess = [pscustomobject]@{ StartTime = $fixtureStart }
$script:fixtureCommandLine = "node.exe $GatewayScript"
function Get-Process { [CmdletBinding()]param([int]$Id) return $script:fixtureProcess }
function Get-CimInstance { [CmdletBinding()]param([string]$ClassName, [string]$Filter)
  return [pscustomobject]@{ CommandLine = $script:fixtureCommandLine }
}
$record = [pscustomobject]@{ kind = 'gateway'; pid = 12345; startTimeTicks = $fixtureStart.Ticks;
  startTimeUtc = $fixtureStart.ToString('o'); marker = $GatewayScript }
Assert-True (Get-RecordStatus $record).matches 'Matching process should be recognized.'
$script:fixtureCommandLine = $null
Assert-True (-not (Get-RecordStatus $record).matches) 'Unreadable command line must refuse termination.'
$script:fixtureCommandLine = 'node.exe unrelated-task.mjs'
Assert-True (-not (Get-RecordStatus $record).matches) 'Unrelated command must refuse termination.'
$script:fixtureCommandLine = "node.exe $GatewayScript"
$record.startTimeTicks -= 1
Assert-True (-not (Get-RecordStatus $record).matches) 'PID reuse must refuse termination.'
Write-Output 'Process ownership: passed (including unreadable command, mismatch, PID reuse).'

function New-FixtureRule([string]$Sid) {
  return [pscustomobject]@{ IdentityReference = [System.Security.Principal.SecurityIdentifier]::new($Sid);
    IsInherited = $false; AccessControlType = [System.Security.AccessControl.AccessControlType]::Allow;
    FileSystemRights = [System.Security.AccessControl.FileSystemRights]::FullControl }
}
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:fixtureAcl = [pscustomobject]@{ AreAccessRulesProtected = $true; Access = @(
  (New-FixtureRule $owner), (New-FixtureRule 'S-1-5-18'), (New-FixtureRule 'S-1-5-32-544')) }
function Get-Acl { [CmdletBinding()]param([string]$LiteralPath) return $script:fixtureAcl }
Assert-True (Test-ControlledAcl 'synthetic').ok 'Exact three SIDs should pass.'
$script:fixtureAcl.Access += New-FixtureRule 'S-1-5-32-545'
Assert-True (-not (Test-ControlledAcl 'synthetic').ok) 'Additional SID must fail regardless of localized name.'
$script:fixtureAcl.Access = @()
Assert-True (-not (Test-ControlledAcl 'synthetic').ok) 'Empty/unreadable ACL must not pass.'
Write-Output 'ACL scope: passed (exact SIDs, additional SID, missing entries).'

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('xunjie-ui55-review-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $fixtureRoot
$ConnectionRoot = $fixtureRoot
$ConfigPath = Join-Path $fixtureRoot 'gateway.json'
$ActiveDistPath = Join-Path $fixtureRoot 'active-dist.json'
$activeDirectory = Join-Path $fixtureRoot 'new-dist'
$zipPath = Join-Path $fixtureRoot 'new-dist.zip'
$manifestPath = Join-Path $fixtureRoot 'new-manifest.json'
$fixtureNode = $null
try {
  $null = New-Item -ItemType Directory -Path $activeDirectory
  [System.IO.File]::WriteAllText((Join-Path $activeDirectory 'index.html'), '<html>synthetic static</html>')
  Compress-Archive -Path (Join-Path $activeDirectory '*') -DestinationPath $zipPath
  @{ staticDirectory = $activeDirectory } | ConvertTo-Json | Set-Content $ConfigPath
  @{ manifestFile = $manifestPath } | ConvertTo-Json | Set-Content $ActiveDistPath
  @{ sourceCommit = ('a' * 40); artifact = 'new-dist.zip'; sha256 = (Get-FileSha256 $zipPath);
    normalBuild = $true; entry = 'index.html'; staticFiles = 1 } | ConvertTo-Json | Set-Content $manifestPath
  $facts = Test-ActiveDist
  Assert-True ($facts.directory -eq $activeDirectory) 'Dist must use actual configuration, not a fixed old path.'
  [System.IO.File]::WriteAllText((Join-Path $activeDirectory 'index.html'), 'altered after extraction')
  Assert-Rejected { Test-ActiveDist } 'Same file count with changed bytes must fail.'
  Write-Output 'Active artifact: passed (new configured directory and byte mismatch).'

  $start = [System.Diagnostics.ProcessStartInfo]::new($NodePath)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.ArgumentList.Add('--eval')
  $start.ArgumentList.Add("const s=require('node:http').createServer((q,r)=>{r.writeHead(503,{'Content-Length':'1000'});r.flushHeaders();});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));")
  $fixtureNode = [System.Diagnostics.Process]::Start($start)
  $read = $fixtureNode.StandardOutput.ReadLineAsync()
  Assert-True ($read.Wait(5000)) 'Fixture startup timed out.'
  $fixturePort = [int]$read.Result
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  $result = Invoke-AnonymousGet "http://127.0.0.1:$fixturePort/"
  Assert-True ($result.status -eq 503 -and $timer.Elapsed.TotalSeconds -lt 5) 'Probe must return header status without waiting for body.'
  Write-Output 'Anonymous probe: passed (503 headers received while body never completes).'
} finally {
  if ($fixtureNode -and -not $fixtureNode.HasExited) { $fixtureNode.Kill(); $fixtureNode.WaitForExit() }
  $resolved = [System.IO.Path]::GetFullPath($fixtureRoot)
  $expectedParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
  if ((Split-Path -Parent $resolved) -ne $expectedParent -or
      -not (Split-Path -Leaf $resolved).StartsWith('xunjie-ui55-review-')) { throw 'Unsafe fixture cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output 'Entry regression checks passed.'
