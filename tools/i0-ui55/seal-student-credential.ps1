#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'seal')]
param(
  [Parameter(ParameterSetName = 'seal')][string]$MaintenanceEntry = 'D:\XunJie_Project\i0-ui55-connection\xunjie-paher.ps1',
  [Parameter(Mandatory, ParameterSetName = 'seal')][string]$RecipientPublicKeyPem,
  [Parameter(Mandatory, ParameterSetName = 'help')][switch]$Help
)
$ErrorActionPreference = 'Stop'
if ($Help) {
  @'
Seal only the approved synthetic-i0-student-a credential for an ephemeral recipient.
  pwsh -NoProfile -File seal-student-credential.ps1 -Help
  & .\seal-student-credential.ps1 -RecipientPublicKeyPem $recipientPublicPem
Optional: -MaintenanceEntry <approved retained maintenance script>
Accepts one RSA PUBLIC KEY / PUBLIC KEY PEM, RSA >= 2048 bits. Private/mixed PEM is refused before capture.
Outputs only loginName, sealedPassword (base64), algorithm=RSA-OAEP-SHA256. Does not reset credentials or log in.
Keep the recipient private key only in the receiving process memory. Do not save/print plaintext or credential objects.
'@
  return
}
$recipient = [System.Security.Cryptography.RSA]::Create()
$credential = $null
$passwordBytes = $null
try {
  if ($RecipientPublicKeyPem -notmatch '^\s*-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----\s+[A-Za-z0-9+/=\s]+-----END \1-----\s*$') {
    throw 'Only one recipient public key PEM is accepted.'
  }
  $recipient.ImportFromPem($RecipientPublicKeyPem)
  if ($recipient.KeySize -lt 2048) { throw 'Recipient RSA key is too small.' }
  $entryPath = [IO.Path]::GetFullPath($MaintenanceEntry)
  if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw 'Approved maintenance entry is missing.' }
  $current = $entryPath
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Maintenance entry path contains a reparse point.'
      }
    }
    $current = [IO.Path]::GetDirectoryName($current)
  }
  . $entryPath
  $credential = Get-XunJieStudentCredential
  $passwordBytes = [System.Text.Encoding]::UTF8.GetBytes($credential.password)
  $sealed = $recipient.Encrypt($passwordBytes, [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
  # Only an ephemeral recipient with the in-memory private key can open this value.
  @{ loginName = $credential.loginName; sealedPassword = [Convert]::ToBase64String($sealed);
    algorithm = 'RSA-OAEP-SHA256' } | ConvertTo-Json -Compress
} catch {
  throw 'Approved credential capture/encryption failed; secret output suppressed.'
} finally {
  if ($passwordBytes) { [Array]::Clear($passwordBytes) }
  $credential = $null
  $recipient.Dispose()
}
