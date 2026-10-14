#Requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('host','vm','pin','guest','fixtures','install','c-acceptance','hdl-install','hdl-acceptance','status','retain-logs')][string]$Stage='host', [switch]$KeepAlive,
  [string]$Repository=(Join-Path $PSScriptRoot '..\..'))
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$retained='D:\XunJie_Project\i0-ui55-connection\hdl-ui\local-environment'
$null=New-Item -ItemType Directory -Path (Join-Path $retained 'node-logs') -Force
if ($KeepAlive) {
  # A task-owned foreground WSL client, with no global WSL/autostart edits.
  $process=Start-Process -FilePath 'wsl.exe' -ArgumentList '-d','Ubuntu','-u','root','--exec','/bin/sleep','43200' -WindowStyle Hidden -PassThru
  [pscustomobject]@{pid=$process.Id;purpose='Robert local C1 keepalive';startedAtUtc=[DateTimeOffset]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $retained 'node-logs\keepalive.json') -Encoding utf8NoBOM
}
$scriptPath=Join-Path $PSScriptRoot 'local-node-setup.sh'
$wslPath=(& wsl.exe -d Ubuntu -u root --exec wslpath -u $scriptPath).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve owned setup script.' }
if ($Stage -eq 'fixtures') {
  $fixtureProgram=@'
const {execFileSync}=require('node:child_process');const{createHash}=require('node:crypto');
const repository=process.argv[2];
const b=execFileSync('git',['-C',repository,'show','9fa76adbfb37a60cc087f8bf2fbdd1e05cd18e77:apps/teaching/tests/fixtures/hdl-board.ts']);
if(createHash('sha256').update(b).digest('hex')!=='e3bd99d5257524453015ca83c1370ba801b5b929af1a89e1b859c78c96426334')throw Error('Original public test fixture differs');
execFileSync('wsl.exe',['-d','Ubuntu','-u','root','--exec','/usr/bin/test','-f','/opt/xunjie-runner/.robert-local-c1']);
execFileSync('wsl.exe',['-d','Ubuntu','-u','root','--exec','mkdir','-p','/opt/xunjie-runner/frozen-source/apps/teaching/tests/fixtures']);
execFileSync('wsl.exe',['-d','Ubuntu','-u','root','--exec','/usr/bin/tee','/opt/xunjie-runner/frozen-source/apps/teaching/tests/fixtures/hdl-board.ts'],{input:b,stdio:['pipe','ignore','pipe']});
console.log('Original public HDL fixture Git bytes/hash verified');
'@
  $fixtureProgram | & D:\nodejs\node.exe - $Repository
  if ($LASTEXITCODE -ne 0) { throw 'Cannot restore the original public test fixture.' }
}
& wsl.exe -d Ubuntu -u root --exec /bin/bash $wslPath $Stage 2>&1 | Tee-Object -FilePath (Join-Path $retained ('node-logs\'+$Stage+'-'+[DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmss')+'.log'))
if ($LASTEXITCODE -ne 0) { throw ('Local C1 setup failed in '+$Stage+'; partial objects retained.') }
