# Product helper: Check is read-only; Prepare downloads only. The end user
# opens the verified Microsoft installer and completes its full UI themselves.
param(
  [ValidateSet('Check','Prepare')][string]$Mode = 'Check',
  [string]$Destination = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'XunJie\prerequisites\vc14-x64-14.51.36247')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '14.51.36247.0'
# Official latest permalink was resolved on 2026-10-29. Downloads always use
# the fixed content URL and digest below, never mutable "latest" bytes.
$source = 'https://aka.ms/vc14/vc_redist.x64.exe'
$resolvedSource = 'https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe'
$expectedHash = '843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c'
$expectedBytes = 18731856
$installer = Join-Path $Destination 'VC_redist.x64.exe'
function Stop-Preparation([string]$Code,[string]$Message,[string]$Recovery){
  @{schemaVersion=1;status='preparation-failed';installerExecuted=$false;error=@{code=$Code;message=$Message;cachePath=$installer;recovery=$Recovery}}|ConvertTo-Json -Depth 8
  exit 1
}
# Product support policy pins this tested installer candidate. PE linker 14.51
# establishes a toolchain-family floor, not an exact compiler patch/ABI minimum.
function Get-ProductVcRuntime {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
  $key=$null; $registryVersion=$null; $installed=$false
  try {
    $key=$base.OpenSubKey('SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64')
    if($key){$installed=$key.GetValue('Installed') -eq 1; $registryVersion=[string]$key.GetValue('Version')}
  } finally {if($key){$key.Dispose()};$base.Dispose()}
  $registryParsed=$null
  [void][version]::TryParse(($registryVersion -replace '^v',''),[ref]$registryParsed)
  $adequate=$installed -and $registryParsed -and $registryParsed -ge [version]$version
  $system=Join-Path $env:WINDIR $(if([Environment]::Is64BitProcess){'System32'}else{'Sysnative'})
  $dlls=@()
  foreach($name in @('vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll')){
    $path=Join-Path $system $name; $dllVersion=$null; $parsed=$null
    if(Test-Path -LiteralPath $path){$dllVersion=(Get-Item -LiteralPath $path).VersionInfo.FileVersion;[void][version]::TryParse($dllVersion,[ref]$parsed)}
    $acceptable=[bool]($parsed -and $parsed -ge [version]$version)
    if(-not $acceptable){$adequate=$false}
    $dlls+=@{name=$name;path=$path;version=$dllVersion;acceptable=$acceptable}
  }
  @{ready=[bool]$adequate;installed=$installed;version=$registryVersion;registryView='Registry64';dlls=$dlls;toolchainFamilyFloor='14.51';productAcceptedMinimum=$version;minimumMeaning='Conservative pinned product policy; exact upstream compiler patch minimum not established'}
}
try {
$runtime=Get-ProductVcRuntime
if($Mode -eq 'Check' -or $runtime.ready){
  @{schemaVersion=1;status=$(if($runtime.ready){'ready'}else{'preparation-required'});runtime=$runtime;installerExecuted=$false}|ConvertTo-Json -Depth 8
  if($runtime.ready){exit 0}else{exit 3}
}
[void](New-Item -ItemType Directory -Path $Destination -Force)
if (-not (Test-Path -LiteralPath $installer)) {
  $temporary = Join-Path $Destination ([Guid]::NewGuid().ToString() + '.download')
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $resolvedSource -OutFile $temporary -TimeoutSec 120
    if ((Get-Item -LiteralPath $temporary).Length -ne $expectedBytes -or (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { Stop-Preparation 'VC_DOWNLOAD_HASH_MISMATCH' '微软运行库下载的大小或 SHA-256 不匹配。' '本次临时下载将被清理；请检查网络后重新运行原命令。未运行安装器。' }
    Move-Item -LiteralPath $temporary -Destination $installer
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ((Get-Item -LiteralPath $installer).Length -ne $expectedBytes -or $hash -ne $expectedHash) { Stop-Preparation 'VC_CACHE_HASH_MISMATCH' '缓存安装器的大小或 SHA-256 不匹配；原文件已保留。' '请核对该缓存路径，手动将该文件移出缓存并保留备份，再运行 xunjie prepare 从微软重新下载。不要运行此文件；程序不会自动删除或覆盖它。' }
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') { Stop-Preparation 'VC_INSTALLER_SIGNATURE_INVALID' '缓存安装器未通过 Microsoft 签名验证。' '请检查 Windows 证书验证与网络；若需重新下载，请先核对缓存路径，手动移出原文件并保留备份，再运行 xunjie prepare。未运行安装器。' }
$fileVersion = (Get-Item -LiteralPath $installer).VersionInfo.FileVersion
if ($fileVersion -ne $version) { Stop-Preparation 'VC_INSTALLER_VERSION_MISMATCH' '缓存安装器版本与产品固定版本不一致。' '请核对缓存路径，手动移出原文件并保留备份，再运行 xunjie prepare。未运行安装器。' }
$report = [ordered]@{
  schemaVersion = 1; capturedAt = [DateTime]::UtcNow.ToString('o'); status = 'downloaded-and-verified-not-installed'
  source = $source; resolvedSource = $resolvedSource; installer = $installer; bytes = $expectedBytes; sha256 = $hash; fileVersion = $fileVersion
  signature = @{ status = $signature.Status.ToString(); subject = $signature.SignerCertificate.Subject; thumbprint = $signature.SignerCertificate.Thumbprint; timestampSubject = $signature.TimeStamperCertificate.Subject }
  installedRuntime = $runtime
  licenseUrl = 'https://visualstudio.microsoft.com/license-terms/vs2026-ga-visualcpp-v14-redist-runtime/'
  preparedInvocationForHumanReview = @{ executable = $installer; arguments = @('/install','/norestart'); requiresAdministrativeConsent = $true; executed = $false }
  productDistribution = 'Direct download from Microsoft; no DLL copied from System32 and no Microsoft binary included in a XunJie distribution by this script'
  limitations = @('No installer execution, license acceptance, UAC or reboot performed','Prepared prerequisite is not clean-Windows acceptance evidence','Pinned version must be re-evaluated for servicing updates and actual upstream toolchain requirements')
}
$json = $report | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText((Join-Path $Destination 'prepared.json'),$json,[Text.UTF8Encoding]::new($false))
$json
} catch {
  # Deliberately do not include exception text, script source or raw stderr.
  Stop-Preparation 'VC_PREPARATION_FAILED' 'Windows 运行库检查或下载未完成。' '请检查网络、缓存目录的读写权限及 Windows 证书验证，再运行原命令。未运行安装器。'
}
