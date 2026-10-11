$ErrorActionPreference = 'Stop'
$stage = 'create task cache'
try {
    $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
    $cache = Join-Path $repositoryRoot ('node_modules/.cache/c1-gcc-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $cache | Out-Null
    $manifestDigest = '980e5c2310bee44d11ee46964174cc11dfea822ba60f0d050d2161d63b64b8f5'
    $configDigest = '9f14e671a09bc195b93ca39524b8dcf401bc832b0c520e462327ce94986799aa'
    $stage = 'read public registry manifest'
    $anonymousRegistryToken = (Invoke-RestMethod -Uri 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/gcc:pull' -TimeoutSec 30).token
    $registryHeaders = @{ Authorization = "Bearer $anonymousRegistryToken"; Accept = 'application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json' }
    $manifestPath = Join-Path $cache 'registry-manifest.json'
    Invoke-WebRequest -UseBasicParsing -Uri "https://registry-1.docker.io/v2/library/gcc/manifests/sha256:$manifestDigest" -Headers $registryHeaders -OutFile $manifestPath -TimeoutSec 60
    if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifestDigest) { throw 'Manifest digest mismatch' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.config.digest -ne "sha256:$configDigest" -or $manifest.layers.Count -ne 8) { throw 'Unexpected manifest' }
    $configPath = Join-Path $cache 'config.json'
    Invoke-WebRequest -UseBasicParsing -Uri "https://registry-1.docker.io/v2/library/gcc/blobs/sha256:$configDigest" -Headers $registryHeaders -OutFile $configPath -TimeoutSec 60
    if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $configDigest) { throw 'Config digest mismatch' }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.os -ne 'linux' -or $config.architecture -ne 'amd64' -or $config.rootfs.diff_ids.Count -ne 8) { throw 'Unexpected image platform' }
    $layerPaths = @()
    for ($index = 0; $index -lt $manifest.layers.Count; $index++) {
        $stage = "download layer $($index + 1)/8"
        $layer = $manifest.layers[$index]
        if ($layer.digest -notmatch '^sha256:[0-9a-f]{64}$' -or $config.rootfs.diff_ids[$index] -notmatch '^sha256:[0-9a-f]{64}$' -or $layer.mediaType -notmatch 'gzip$') { throw 'Unexpected layer format' }
        $compressedDigest = $layer.digest.Substring(7)
        $diffDigest = $config.rootfs.diff_ids[$index].Substring(7)
        $compressedPath = Join-Path $cache ($compressedDigest + '.tar.gz')
        Invoke-WebRequest -UseBasicParsing -Uri "https://registry-1.docker.io/v2/library/gcc/blobs/sha256:$compressedDigest" -Headers $registryHeaders -OutFile $compressedPath -TimeoutSec 900
        if ((Get-Item -LiteralPath $compressedPath).Length -ne $layer.size -or (Get-FileHash -LiteralPath $compressedPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $compressedDigest) { throw 'Compressed layer digest mismatch' }
        $layerDirectory = Join-Path $cache $diffDigest
        New-Item -ItemType Directory -Path $layerDirectory | Out-Null
        $layerPath = Join-Path $layerDirectory 'layer.tar'
        $source = [System.IO.File]::OpenRead($compressedPath)
        $gzip = [System.IO.Compression.GZipStream]::new($source, [System.IO.Compression.CompressionMode]::Decompress)
        $destination = [System.IO.File]::Open($layerPath, [System.IO.FileMode]::CreateNew)
        try { $gzip.CopyTo($destination) } finally { $destination.Dispose(); $gzip.Dispose(); $source.Dispose() }
        if ((Get-FileHash -LiteralPath $layerPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $diffDigest) { throw 'Uncompressed layer digest mismatch' }
        $layerPaths += "$diffDigest/layer.tar"
        Write-Output "Verified layer $($index + 1)/8"
    }
    $stage = 'create verified Docker archive'
    $importManifest = @([pscustomobject]@{ Config = 'config.json'; RepoTags = @('xunjie-c1/gcc:15.3.0-trixie'); Layers = $layerPaths })
    $manifestJson = ConvertTo-Json -InputObject $importManifest -Depth 5 -Compress
    [System.IO.File]::WriteAllText((Join-Path $cache 'manifest.json'), $manifestJson, [System.Text.UTF8Encoding]::new($false))
    $archive = Join-Path $cache 'gcc.tar'
    & tar.exe -C $cache -cf $archive manifest.json config.json @layerPaths
    if ($LASTEXITCODE -ne 0) { throw 'Archive creation failed' }
    $stage = 'load verified image into task-only engine'
    $wslArchive = (& wsl.exe -d Ubuntu --exec wslpath -u $archive | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $wslArchive.StartsWith('/')) { throw 'WSL path resolution failed' }
    & wsl.exe -d Ubuntu -u root --exec /opt/xunjie-runner/engine/docker --host=unix:///run/xunjie-c1-docker.sock load --input $wslArchive
    if ($LASTEXITCODE -ne 0) { throw 'Image load failed' }
    Write-Output "Imported source manifest sha256:$manifestDigest as image sha256:$configDigest"
    Write-Output 'Task cache retained; no files, containers or images were deleted.'
} catch {
    Write-Output ("C1 image import failed at $stage; type=" + $_.Exception.GetType().Name)
    exit 1
}
