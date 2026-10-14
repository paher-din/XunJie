#Requires -Version 7.0
<#
  PAHER maintenance client. The retained xunjie-paher.ps1 is an identical local snapshot.
  Commands use only the approved host/account/key and do not change remote SSH configuration.
  Dot-source to capture Invoke-XjMaintenanceCommand, Invoke-XjMaintenancePowerShellScript,
  or Get-XunJieStudentCredential in memory.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('help', 'probe', 'exec', 'sftp-get')]
  [string]$Operation = 'help',
  [string]$RemoteCommand,
  [string]$PowerShellScript,
  [string]$ScriptFile,
  [string]$RemotePath,
  [string]$LocalPath,
  [ValidateRange(5, 3600)]
  [int]$TimeoutSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:XjMaintenanceRoot = 'D:\XunJie_Project\i0-ui55-connection'
$script:XjMaintenanceSsh = 'C:\Program Files\OpenSSH\ssh.exe'
$script:XjMaintenanceSftp = 'C:\Program Files\OpenSSH\sftp.exe'
$script:XjMaintenanceIdentity = 'C:\Users\h\.ssh\id_ed25519'
$script:XjMaintenanceKnownHosts = Join-Path $script:XjMaintenanceRoot 'paher_known_hosts'
$script:XjMaintenanceTarget = 'p3148@192.168.3.15'
$script:XjStudentCredentialReader = 'wsl -d Ubuntu -u root -- /opt/xunjie-runner/tests/i0-entry-20261013-01/xj-student-cred.sh 2>NUL'

function Assert-XjNoReparsePoint([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Path contains a reparse point; refused.'
      }
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
}

function Assert-XjMaintenancePrerequisites {
  foreach ($path in @($script:XjMaintenanceSsh, $script:XjMaintenanceIdentity, $script:XjMaintenanceKnownHosts)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required local file is missing: $path" }
    Assert-XjNoReparsePoint $path
  }
  $expected = '192.168.3.15 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGwl+IVdUjq+JblbiTql4J+j4xr43yrgqba4/oPuQZtf'
  $hostLines = @(Get-Content -LiteralPath $script:XjMaintenanceKnownHosts | Where-Object { $_ -and -not $_.StartsWith('#') })
  if ($hostLines.Count -ne 1 -or -not ($hostLines[0] -eq $expected -or $hostLines[0].StartsWith($expected + ' '))) {
    throw 'Dedicated known_hosts does not match the approved Ed25519 host key.'
  }
}

function Get-XjMaintenanceOptions {
  return @('-F', 'NUL', '-i', $script:XjMaintenanceIdentity,
    '-o', 'BindAddress=192.168.3.8', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$script:XjMaintenanceKnownHosts",
    '-o', 'GlobalKnownHostsFile=NUL', '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes')
}

function Invoke-XjCapturedProcess {
  param([string]$FilePath, [string[]]$Arguments, [ValidateRange(5, 3600)][int]$TimeoutSeconds = 90, [string]$InputText)
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.RedirectStandardInput = $true
  foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    $null = $process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if ($InputText) { $process.StandardInput.Write($InputText) }
    $process.StandardInput.Close()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      $process.Kill($true)
      $process.WaitForExit()
      throw 'The local SSH/SFTP client timed out and was stopped. Remote completion is unconfirmed; no retry was made.'
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout.GetAwaiter().GetResult(); StdErr = $stderr.GetAwaiter().GetResult() }
  } finally { $process.Dispose() }
}

function Invoke-XjMaintenanceCommand {
  param([Parameter(Mandatory)][string]$RemoteCommand, [ValidateRange(5, 3600)][int]$TimeoutSeconds = 90)
  if (-not $RemoteCommand.Trim() -or $RemoteCommand.Contains([char]0)) { throw 'RemoteCommand must be explicit and contain no NUL.' }
  Assert-XjMaintenancePrerequisites
  $arguments = @('-T', '-p', '22') + (Get-XjMaintenanceOptions) + @($script:XjMaintenanceTarget, $RemoteCommand)
  return Invoke-XjCapturedProcess -FilePath $script:XjMaintenanceSsh -Arguments $arguments -TimeoutSeconds $TimeoutSeconds
}

function ConvertTo-XjEncodedCommand([string]$Text) {
  if (-not $Text.Trim() -or $Text.Contains([char]0)) { throw 'PowerShell script must be explicit and contain no NUL.' }
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Text))
  return "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded"
}

function Invoke-XjMaintenancePowerShellScript {
  param([Parameter(Mandatory)][Alias('Script')][string]$PowerShellScript,
    [ValidateRange(5, 3600)][int]$TimeoutSeconds = 90)
  if (-not $PowerShellScript.Trim() -or $PowerShellScript.Contains([char]0)) {
    throw 'PowerShell script must be explicit and contain no NUL.'
  }
  Assert-XjMaintenancePrerequisites
  # Only this short, fixed receiver enters cmd.exe's command line. The explicit script is stdin data.
  $receiver = @'
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
  $xjScriptText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
  & ([ScriptBlock]::Create($xjScriptText))
  if (-not $?) { exit 1 }
} catch {
  [Console]::Error.WriteLine('Approved PowerShell script failed; script text suppressed.')
  exit 1
}
'@
  $remoteCommand = ConvertTo-XjEncodedCommand $receiver
  $inputText = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PowerShellScript))
  $arguments = @('-T', '-p', '22') + (Get-XjMaintenanceOptions) + @($script:XjMaintenanceTarget, $remoteCommand)
  return Invoke-XjCapturedProcess -FilePath $script:XjMaintenanceSsh -Arguments $arguments -InputText $inputText -TimeoutSeconds $TimeoutSeconds
}

function Get-XunJieStudentCredential {
  # This function has no CLI operation: callers capture the object in memory and must not print/log it.
  $result = Invoke-XjMaintenanceCommand -RemoteCommand $script:XjStudentCredentialReader -TimeoutSeconds 20
  if ($result.ExitCode -ne 0) { throw 'Approved student credential reader failed; no credential output was printed.' }
  try { $credential = ConvertFrom-Json -InputObject $result.StdOut -ErrorAction Stop }
  catch { throw 'Approved student credential reader returned invalid JSON; no credential output was printed.' }
  $properties = @($credential.PSObject.Properties.Name)
  if ($properties.Count -ne 2 -or -not ($properties -contains 'loginName') -or -not ($properties -contains 'password') -or
      $credential.loginName -cne 'synthetic-i0-student-a' -or $credential.password -isnot [string] -or -not $credential.password) {
    throw 'Approved student credential reader returned an unexpected account/shape; no credential output was printed.'
  }
  return [pscustomobject]@{ loginName = $credential.loginName; password = $credential.password }
}

function Resolve-XjDownloadDestination([string]$Path) {
  if (-not $Path -or $Path -match '[\x00-\x1f"*?<>|]' -or $Path -match '(^|[\\/])\.\.?([\\/]|$)' -or
      $Path -match '(^|[\\/])[^\\/]*[. ]([\\/]|$)') {
    throw 'LocalPath must name a new ordinary file without control characters or dot segments.'
  }
  $resolved = if ([IO.Path]::IsPathRooted($Path)) { [IO.Path]::GetFullPath($Path) }
              else { [IO.Path]::GetFullPath((Join-Path $script:XjMaintenanceRoot $Path)) }
  $root = [IO.Path]::GetFullPath($script:XjMaintenanceRoot).TrimEnd('\')
  if (-not $resolved.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'LocalPath must stay inside the retained tool directory.' }
  foreach ($part in $resolved.Substring($root.Length + 1).Split('\')) {
    if (-not $part -or $part -match '[:]' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or
        $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { throw 'LocalPath contains an unsafe Windows path component.' }
  }
  Assert-XjNoReparsePoint $resolved
  if (Test-Path -LiteralPath $resolved) { throw 'LocalPath already exists; overwrite is refused.' }
  if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($resolved)) -PathType Container)) {
    throw 'The LocalPath parent directory must already exist.'
  }
  return $resolved
}

function Assert-XjRemoteDownloadPath([string]$Path) {
  if (-not $Path -or -not $Path.StartsWith('/') -or $Path -match '[\x00-\x1f"\\*?\[\]]') {
    throw 'RemotePath must be an explicit absolute SFTP file path without controls, quotes, backslashes or wildcards.'
  }
}

function Receive-XjMaintenanceFile {
  param([Parameter(Mandatory)][string]$RemotePath, [Parameter(Mandatory)][string]$LocalPath, [ValidateRange(5, 3600)][int]$TimeoutSeconds = 90)
  Assert-XjRemoteDownloadPath $RemotePath
  $destination = Resolve-XjDownloadDestination $LocalPath
  Assert-XjMaintenancePrerequisites
  if (-not (Test-Path -LiteralPath $script:XjMaintenanceSftp -PathType Leaf)) { throw 'The approved SFTP client is missing.' }
  Assert-XjNoReparsePoint $script:XjMaintenanceSftp
  # Stage in a fresh name, then use an atomic no-overwrite move. A failed transfer remains for inspection.
  $staging = $destination + '.' + [Guid]::NewGuid().ToString('N') + '.part'
  $null = Resolve-XjDownloadDestination $staging
  $batch = 'get "' + $RemotePath + '" "' + $staging.Replace('\', '/') + '"' + "`nquit`n"
  $arguments = @('-P', '22', '-b', '-') + (Get-XjMaintenanceOptions) + @($script:XjMaintenanceTarget)
  $result = Invoke-XjCapturedProcess -FilePath $script:XjMaintenanceSftp -Arguments $arguments -InputText $batch -TimeoutSeconds $TimeoutSeconds
  if ($result.ExitCode -ne 0) { throw "SFTP failed (exit $($result.ExitCode)); no destination was overwritten. A partial staging file may remain." }
  Assert-XjNoReparsePoint $staging
  $null = Resolve-XjDownloadDestination $destination
  if (-not (Test-Path -LiteralPath $staging -PathType Leaf)) { throw 'SFTP did not produce an ordinary staging file.' }
  [IO.File]::Move($staging, $destination, $false)
  return [pscustomobject]@{ path = $destination; bytes = (Get-Item -LiteralPath $destination).Length; sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Get-XjMaintenanceProbe {
  $identity = Invoke-XjMaintenanceCommand -RemoteCommand 'whoami' -TimeoutSeconds 20
  $services = Invoke-XjMaintenanceCommand -RemoteCommand 'wsl -d Ubuntu -u root -- systemctl is-active xunjie-i0-entry-recovered-20261014.service xunjie-c1-vm.service' -TimeoutSeconds 25
  $states = @($services.StdOut.Trim() -split '\r?\n')
  $passed = $identity.ExitCode -eq 0 -and $identity.StdOut.Trim() -ieq 'paher\p3148' -and
            $services.ExitCode -eq 0 -and $states.Count -eq 2 -and $states[0] -eq 'active' -and $states[1] -eq 'active'
  return [pscustomobject]@{
    observedAtUtc = [DateTimeOffset]::UtcNow.ToString('o'); target = $script:XjMaintenanceTarget; sourceAddress = '192.168.3.8';
    whoami = $identity.StdOut.Trim(); identityExitCode = $identity.ExitCode; serviceExitCode = $services.ExitCode;
    appUnit = 'xunjie-i0-entry-recovered-20261014.service'; appState = if ($states.Count -ge 1) { $states[0] } else { 'unconfirmed' };
    vmUnit = 'xunjie-c1-vm.service'; vmState = if ($states.Count -ge 2) { $states[1] } else { 'unconfirmed' };
    stderrPresent = [bool]($identity.StdErr -or $services.StdErr); passed = $passed;
    note = 'Only SSH identity and existing unit activity were probed. Stderr is captured; neither HTTPS ready nor runner readiness/browser acceptance is claimed.'
  }
}

function Show-XjMaintenanceHelp {
  @'
PAHER maintenance (PowerShell 7, retained locally)
  .\xunjie-paher.ps1 probe
  .\xunjie-paher.ps1 exec -RemoteCommand 'whoami'
  .\xunjie-paher.ps1 exec -PowerShellScript 'Get-Date -Format o'
  .\xunjie-paher.ps1 exec -ScriptFile 'D:\approved-maintenance.ps1' -TimeoutSeconds 120
  .\xunjie-paher.ps1 sftp-get -RemotePath '/C:/Users/p3148/XunJie_SSH_handoff_20261014.json' -LocalPath 'handoff-new.json'

Fixed: p3148@192.168.3.15:22, source 192.168.3.8, existing identity and exact dedicated Ed25519 host key.
No interactive TTY, password authentication, global configuration changes, automatic retry, remote login or password reset.
exec requires one explicit command/script and inherits the existing maintenance account privileges. Use only approved XunJie work.
ScriptFile is local text; a fixed short EncodedCommand receiver reads the UTF8/base64 script from SSH stdin.
Long scripts do not enter cmd.exe argv or remote temporary files; the remote DefaultShell is unchanged. Base64 is not encryption.
SFTP is Windows filesystem access; no WSL path translation. Local downloads stay under this retained directory and refuse overwrite/reparse points.
No built-in persistent command/output logs. A failed get may retain a uniquely named .part file for inspection.
Dot-source this script and capture Get-XunJieStudentCredential in a variable to read only synthetic-i0-student-a into memory.
The credential function has no CLI print command, reads the existing approved reader, and never resets credentials or logs in.
Encrypted handoff: pwsh -NoProfile -File .\tools\i0-ui55\seal-student-credential.ps1 -Help
C1 read-only: pwsh -NoProfile -File .\scratch-c1-readiness\Read-C1Readiness.ps1 (not-ready returns nonzero).
Snapshot integrity: xunjie-ui55.ps1 check verifies source-manifest; it also performs anonymous HTTPS checks.
Do not print/serialize credential objects or place passwords/tokens/private-key bodies in command/script/log files.
'@
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    switch ($Operation) {
      'help' { Show-XjMaintenanceHelp; exit 0 }
      'probe' {
        $probe = Get-XjMaintenanceProbe
        $probe | ConvertTo-Json -Depth 3
        if ($probe.passed) { exit 0 } else { exit 1 }
      }
      'exec' {
        $choices = @($RemoteCommand, $PowerShellScript, $ScriptFile | Where-Object { $_ })
        if ($choices.Count -ne 1) { throw 'exec requires exactly one of RemoteCommand, PowerShellScript or ScriptFile.' }
        if ($ScriptFile) {
          $scriptPath = [IO.Path]::GetFullPath($ScriptFile)
          Assert-XjNoReparsePoint $scriptPath
          if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw 'ScriptFile must be an existing local text file.' }
          $PowerShellScript = Get-Content -LiteralPath $scriptPath -Raw
        }
        if ($RemoteCommand -match 'xj-student-cred|initializer\.json' -or $PowerShellScript -match 'xj-student-cred|initializer\.json') {
          throw 'Use the in-memory credential getter rather than the printing exec CLI for credential reads.'
        }
        $result = if ($PowerShellScript) {
          Invoke-XjMaintenancePowerShellScript -PowerShellScript $PowerShellScript -TimeoutSeconds $TimeoutSeconds
        } else { Invoke-XjMaintenanceCommand -RemoteCommand $RemoteCommand -TimeoutSeconds $TimeoutSeconds }
        if ($result.StdOut) { [Console]::Out.Write($result.StdOut) }
        if ($result.StdErr) { [Console]::Error.Write($result.StdErr) }
        exit $result.ExitCode
      }
      'sftp-get' {
        Receive-XjMaintenanceFile -RemotePath $RemotePath -LocalPath $LocalPath -TimeoutSeconds $TimeoutSeconds | ConvertTo-Json
        exit 0
      }
    }
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
  }
}
