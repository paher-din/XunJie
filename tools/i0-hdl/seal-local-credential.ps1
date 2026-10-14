#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('synthetic-robert-student-a','synthetic-robert-student-b')][string]$LoginName,
  [Parameter(Mandatory)][string]$RecipientPublicKeyPem
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$publicFile=[IO.Path]::GetFullPath($RecipientPublicKeyPem)
$allowedRoot=[IO.Path]::GetFullPath('D:\XunJie_Project\i0-ui55-connection\hdl-ui\local-environment').TrimEnd('\')
if(-not $publicFile.StartsWith($allowedRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $publicFile).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Owned ordinary recipient public key required.'}
$pem=[IO.File]::ReadAllText($publicFile)
if($pem -notmatch '^-----BEGIN PUBLIC KEY-----' -or $pem -match 'PRIVATE KEY'){throw 'Public-only recipient required.'}
$reader=@'
import {readFileSync} from 'node:fs';
const loginName=process.argv[2];
if(!['synthetic-robert-student-a','synthetic-robert-student-b'].includes(loginName))throw Error('Approved local synthetic account required');
const value=JSON.parse(readFileSync('/opt/xunjie-ui-local/initializer.json','utf8')).accounts.find(account=>account.loginName===loginName);
if(!value||value.id!==loginName||typeof value.password!=='string')throw Error('Local synthetic account unavailable');
process.stdout.write(JSON.stringify({loginName,password:value.password}));
'@
$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName='wsl.exe';$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
$null=$info.Environment.Remove('DEEPSEEK_API_KEY')
foreach($argument in @('-d','Ubuntu','-u','root','--exec','/opt/xunjie-runner/node/bin/node','--input-type=module','-',$LoginName)){$info.ArgumentList.Add($argument)}
$process=[Diagnostics.Process]::new();$process.StartInfo=$info
$rsa=[Security.Cryptography.RSA]::Create()
try {
  $rsa.ImportFromPem($pem)
  if($rsa.KeySize -lt 2048){throw 'RSA2048 or greater recipient required.'}
  $null=$process.Start();$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  $process.StandardInput.Write($reader);$process.StandardInput.Close()
  if(-not $process.WaitForExit(15000)){$process.Kill($true);throw 'Local credential read timed out.'}
  if($process.ExitCode -ne 0){throw 'Local approved credential is unavailable.'}
  $plain=$stdout.GetAwaiter().GetResult()
  if($plain.Length -gt 512){throw 'Unexpected local credential response.'}
  $credential=$plain|ConvertFrom-Json
  if($credential.loginName -ne $LoginName -or -not $credential.password){throw 'Credential account mismatch.'}
  $bytes=[Text.Encoding]::UTF8.GetBytes($plain)
  $cipher=$rsa.Encrypt($bytes,[Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
  [pscustomobject]@{algorithm='RSA-OAEP-SHA256';loginName=$LoginName;ciphertextBase64=[Convert]::ToBase64String($cipher)}|ConvertTo-Json -Compress
} finally {
  if($null -ne (Get-Variable bytes -ErrorAction SilentlyContinue)){[Array]::Clear($bytes)}
  $plain=$null;$credential=$null;$rsa.Dispose();$process.Dispose()
}
