# Uses C1's verified archive import pattern when the guest cannot reach the public registry.
$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$cache = Join-Path $repositoryRoot ('node_modules/.cache/dlc-base-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $cache | Out-Null
$manifestDigest = 'f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b'
$anonymousRegistryToken = (Invoke-RestMethod -Uri 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/ubuntu:pull' -TimeoutSec 30).token
$registryHeaders = @{ Authorization = ('Bearer ' + $anonymousRegistryToken); Accept = 'application/vnd.oci.image.manifest.v1+json' }
$manifestPath = Join-Path $cache 'registry-manifest.json'
Invoke-WebRequest -Uri ('https://registry-1.docker.io/v2/library/ubuntu/manifests/sha256:' + $manifestDigest) -Headers $registryHeaders -OutFile $manifestPath -TimeoutSec 60
function Assert-Digest($Path, $Digest) { if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Digest) { throw 'Image digest mismatch' } }
Assert-Digest $manifestPath $manifestDigest
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.config.digest -notmatch '^sha256:[0-9a-f]{64}$' -or $manifest.layers.Count -ne 1) { throw 'Unexpected approved base manifest' }
$configDigest = $manifest.config.digest.Substring(7)
$configPath = Join-Path $cache 'config.json'
Invoke-WebRequest -Uri ('https://registry-1.docker.io/v2/library/ubuntu/blobs/sha256:' + $configDigest) -Headers $registryHeaders -OutFile $configPath -TimeoutSec 60
Assert-Digest $configPath $configDigest
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($config.os -ne 'linux' -or $config.architecture -ne 'amd64' -or $config.rootfs.diff_ids.Count -ne 1) { throw 'Wrong base platform' }
$layer = $manifest.layers[0]
if ($layer.digest -notmatch '^sha256:[0-9a-f]{64}$' -or $layer.mediaType -notmatch 'gzip$' -or $config.rootfs.diff_ids[0] -notmatch '^sha256:[0-9a-f]{64}$') { throw 'Unsupported layer format' }
$compressedDigest = $layer.digest.Substring(7)
$diffDigest = $config.rootfs.diff_ids[0].Substring(7)
$compressedPath = Join-Path $cache 'layer.tar.gz'
Invoke-WebRequest -Uri ('https://registry-1.docker.io/v2/library/ubuntu/blobs/sha256:' + $compressedDigest) -Headers $registryHeaders -OutFile $compressedPath -TimeoutSec 120
if ((Get-Item -LiteralPath $compressedPath).Length -ne $layer.size) { throw 'Layer size mismatch' }
Assert-Digest $compressedPath $compressedDigest
New-Item -ItemType Directory -Path (Join-Path $cache $diffDigest) | Out-Null
$layerPath = Join-Path (Join-Path $cache $diffDigest) 'layer.tar'
$source = [System.IO.File]::OpenRead($compressedPath)
$gzip = [System.IO.Compression.GZipStream]::new($source, [System.IO.Compression.CompressionMode]::Decompress)
$destination = [System.IO.File]::Open($layerPath, [System.IO.FileMode]::CreateNew)
try { $gzip.CopyTo($destination) } finally { $destination.Dispose(); $gzip.Dispose(); $source.Dispose() }
Assert-Digest $layerPath $diffDigest
$layerNames = @($diffDigest + '/layer.tar')
$archiveManifest = @([pscustomobject]@{Config='config.json';RepoTags=@('xunjie-dlc/ubuntu:verified');Layers=$layerNames})
[System.IO.File]::WriteAllText((Join-Path $cache 'manifest.json'), (ConvertTo-Json -InputObject $archiveManifest -Depth 5 -Compress), [System.Text.UTF8Encoding]::new($false))
$archive = Join-Path $cache 'ubuntu.tar'
tar.exe -C $cache -cf $archive manifest.json config.json @layerNames
if ($LASTEXITCODE -ne 0) { throw 'Archive failed' }
if ($archive -notmatch '^[A-Za-z]:\\') { throw 'Absolute Windows task cache required' }
$wslArchive = '/mnt/' + $archive.Substring(0,1).ToLowerInvariant() + '/' + $archive.Substring(3).Replace('\','/')
wsl.exe -d Ubuntu -u root -- ssh -i /opt/xunjie-runner/vm/keys/maintenance -o UserKnownHostsFile=/opt/xunjie-runner/vm/keys/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -p 2222 root@127.0.0.1 mkdir -p /opt/xunjie-runner/hdl-input
wsl.exe -d Ubuntu -u root -- scp -i /opt/xunjie-runner/vm/keys/maintenance -o UserKnownHostsFile=/opt/xunjie-runner/vm/keys/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -P 2222 $wslArchive root@127.0.0.1:/opt/xunjie-runner/hdl-input/ubuntu.tar
if ($LASTEXITCODE -ne 0) { throw 'Archive transfer failed' }
wsl.exe -d Ubuntu -u root -- ssh -i /opt/xunjie-runner/vm/keys/maintenance -o UserKnownHostsFile=/opt/xunjie-runner/vm/keys/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes -p 2222 root@127.0.0.1 /opt/xunjie-runner/engine/docker --host=unix:///run/xunjie-c1-docker.sock load --input /opt/xunjie-runner/hdl-input/ubuntu.tar
if ($LASTEXITCODE -ne 0) { throw 'Verified base import failed' }
Write-Output ('Verified source manifest sha256:' + $manifestDigest + ' image sha256:' + $configDigest)
Write-Output 'Import artifacts retained; no deletion or pruning.'
