#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Position=0)][ValidateSet('help','status','check','start','stop')][string]$Operation='help',
  [switch]$EnableModel,
  [switch]$DisablePersonalModels,
  [switch]$EnableReview,
  [string]$RetainedRoot='D:\XunJie_Project\i0-ui55-connection\hdl-ui\local-environment'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$statePath=Join-Path $RetainedRoot 'application-process.json'
function Invoke-LocalWsl([string]$Script) {
  $result=& wsl.exe -d Ubuntu -u root --exec sh -c $Script
  if($LASTEXITCODE -ne 0){throw 'Local controlled operation failed; its original state remains available for inspection.'}
  return $result
}
function Get-LocalNodeProgram {
  # Public code on stdin only. The original application key is referenced by
  # path inside this local process; no key, password or application DB is read.
  return @'
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const base='/opt/xunjie-runner',mode=process.argv[2],unit='xunjie-c1-vm.service';
const vmScript=base+'/frozen-source/apps/teaching/runner/vm.sh';
const vmScriptHash='9da8f18f2d0119c0e8558c8184b0cc34044fc59e2f2f7d9af2302d1e2285586f';
const sourceHash='7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852';
const sha=value=>createHash('sha256').update(value).digest('hex');
const failure=reason=>{throw new Error(reason);};
const ordinary=(path,controlled=true)=>{const s=fs.lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(path)!==path||controlled&&(s.mode&0o022))failure('preparation_mismatch');};
const deadline=Date.now()+(mode==='ensure'?120000:25000);
const timeLeft=()=>Math.max(1,deadline-Date.now());
const activeState=()=>{try{return execFileSync('/usr/bin/systemctl',['show',unit,'--property=ActiveState','--value'],{encoding:'utf8',timeout:Math.min(5000,timeLeft()),stdio:['ignore','pipe','pipe']}).trim();}catch{return 'unknown';}};
let state='unknown',startedVm=false,matched;
try {
  if(!['status','ensure'].includes(mode))failure('unsupported_operation');
  for(const path of [base+'/.robert-local-c1',base+'/local-node-ready.json',base+'/vm/state/guest.qcow2',base+'/vm/state/seed.iso',base+'/vm/keys/known_hosts',base+'/vm/keys/application'])ordinary(path);
  // Git archive preserves this public script's source mode. Its exact content
  // hash is pinned below; do not alter the already accepted source permissions.
  ordinary(vmScript,false);
  if(fs.lstatSync(base+'/local-node-ready.json').size>1024*1024||sha(fs.readFileSync(vmScript))!==vmScriptHash)failure('preparation_mismatch');
  const receipt=JSON.parse(fs.readFileSync(base+'/local-node-ready.json','utf8'));
  const ssh=receipt.ssh;
  if(receipt.sourceHash!==sourceHash||typeof receipt.recoveryGeneration!=='string'||!receipt.recoveryGeneration||
    ssh?.binary!=='/usr/bin/ssh'||ssh.host!=='127.0.0.1'||ssh.port!==2222||ssh.keyFile!==base+'/vm/keys/application'||ssh.knownHostsFile!==base+'/vm/keys/known_hosts'||
    fs.readFileSync(ssh.knownHostsFile,'utf8').trim()!==receipt.vm?.guestHostPublicPin)failure('preparation_mismatch');
  function fingerprint(data,kind) {
    if(data?.ready!==true||data.recoveryGeneration!==receipt.recoveryGeneration||data.fingerprint?.sourceHash!==sourceHash)failure('node_identity_mismatch');
    const hash=sha(JSON.stringify(data.fingerprint));
    if(data.validation?.passed!==true||hash!==data.validation.fingerprintHash||!Number.isFinite(Date.parse(data.validation.validatedAt))||Date.parse(data.validation.validatedAt)>Date.now())failure('node_identity_mismatch');
    if(kind==='hdl'&&(hash!==data.fingerprintHash||data.profile?.sourceHash!==sourceHash||JSON.stringify(data.profile)!==JSON.stringify(data.fingerprint.profile)))failure('node_identity_mismatch');
    if(kind==='c'&&['compilerImage','runtimeImage','imageDigest','runtimeProfileVersion'].some(key=>data[key]!==data.fingerprint.profile?.[key]))failure('node_identity_mismatch');
    return hash;
  }
  const expectedC=fingerprint(receipt.c?.data,'c'),expectedHdl=fingerprint(receipt.hdl?.data,'hdl');
  const args=['-T','-i',ssh.keyFile,'-F','/dev/null','-o','UserKnownHostsFile='+ssh.knownHostsFile,'-o','GlobalKnownHostsFile=/dev/null',
    '-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=5','-o','ForwardAgent=no','-o','ForwardX11=no',
    '-p','2222','root@127.0.0.1','xunjie-c1'];
  const read=op=>JSON.parse(execFileSync(ssh.binary,args,{input:JSON.stringify({op}),encoding:'utf8',timeout:Math.min(10000,timeLeft()),maxBuffer:1024*1024,stdio:['pipe','pipe','pipe']}));
  state=activeState();
  if(mode==='status'&&state!=='active')failure('vm_not_active');
  if(mode==='ensure'&&!['active','activating','deactivating'].includes(state)) {
    // This frozen start command only reuses the prepared disks and pinned keys.
    // It never executes setup stages, revalidates, changes a generation or stops.
    execFileSync('/bin/sh',[vmScript,'start'],{timeout:Math.min(15000,timeLeft()),stdio:['ignore','pipe','pipe']});startedVm=true;
  }
  while(Date.now()<deadline) {
    state=activeState();
    if(mode==='ensure'&&!['active','activating','deactivating'].includes(state)&&!startedVm) {
      execFileSync('/bin/sh',[vmScript,'start'],{timeout:Math.min(15000,timeLeft()),stdio:['ignore','pipe','pipe']});startedVm=true;
    }
    if(state==='active') {
      let c,hdl;
      try {c=read('readiness');hdl=read('hdl_readiness');} catch {if(mode==='status')failure('readiness_unavailable');}
      if(c?.data?.ready===true&&hdl?.data?.ready===true) {
        const cHash=fingerprint(c.data,'c'),hdlHash=fingerprint(hdl.data,'hdl');
        if(cHash!==expectedC||hdlHash!==expectedHdl)failure('node_identity_mismatch');
        matched={ready:true,vmActive:true,vmStarted:startedVm,unit,recoveryGeneration:receipt.recoveryGeneration,sourceHash,
          cFingerprintHash:cHash,hdlFingerprintHash:hdlHash,kernel:c.data.fingerprint.kernel};
        break;
      }
      if(mode==='status')failure('readiness_unavailable');
    }
    if(mode==='status')failure('vm_not_active');
    await new Promise(resolve=>setTimeout(resolve,Math.min(2000,timeLeft())));
  }
  if(!matched)failure('readiness_timeout');
  console.log(JSON.stringify(matched));
} catch(error) {
  const allowed=['unsupported_operation','preparation_mismatch','node_identity_mismatch','vm_not_active','readiness_unavailable','readiness_timeout'];
  console.log(JSON.stringify({ready:false,vmActive:state==='active',vmStarted:startedVm,unit,reason:allowed.includes(error.message)?error.message:'local_node_check_failed'}));
  if(mode==='ensure')process.exitCode=1;
}
'@
}
function Get-LocalNodeState([switch]$Ensure) {
  $mode=if($Ensure){'ensure'}else{'status'}
  $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName='wsl.exe';$info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $null=$info.Environment.Remove('DEEPSEEK_API_KEY')
  $info.Environment['WSLENV']=(@($info.Environment['WSLENV'] -split ':'|Where-Object{$_ -and ($_ -split '/')[0] -ne 'DEEPSEEK_API_KEY'}) -join ':')
  foreach($argument in @('-d','Ubuntu','-u','root','--exec','/opt/xunjie-runner/node/bin/node','--input-type=module','-',$mode)){$info.ArgumentList.Add($argument)}
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info
  try {
    $null=$process.Start()
    $output=$process.StandardOutput.ReadToEndAsync();$errors=$process.StandardError.ReadToEndAsync()
    $process.StandardInput.WriteLine((Get-LocalNodeProgram));$process.StandardInput.Close()
    $limit=if($Ensure){130000}else{35000}
    if(-not $process.WaitForExit($limit)){$process.Kill($true);$process.WaitForExit();throw 'Local node readiness check timed out; no identity or disk was rebuilt.'}
    $public=$output.GetAwaiter().GetResult();$null=$errors.GetAwaiter().GetResult()
    try {$result=$public | ConvertFrom-Json -ErrorAction Stop} catch {throw 'Local node check did not return its public status; inspect preparation.'}
    if($Ensure -and ($process.ExitCode -ne 0 -or $result.ready -ne $true)){throw ('Existing local node is not ready: '+$result.reason+'. No new identity, generation or acceptance was created.')}
    return $result
  } finally {$process.Dispose()}
}
function Get-LocalPublicHealth {
  $output=@()
  foreach($path in @('/health/live','/health/ready')) {
    try {
      $response=Invoke-WebRequest -Uri ('https://127.0.0.1:3444'+$path) -TimeoutSec 10
      $output += [pscustomobject]@{path=$path;status=[int]$response.StatusCode;body=($response.Content|ConvertFrom-Json)}
    } catch { $output += [pscustomobject]@{path=$path;status='unavailable';body=$null} }
  }
  return $output
}
switch($Operation) {
  help {
    @'
Robert local C/HDL environment (Ubuntu data and retained tools live on D:).
  .\xunjie-local.ps1 status
  .\xunjie-local.ps1 check
  .\xunjie-local.ps1 start
  .\xunjie-local.ps1 start -EnableModel
  .\xunjie-local.ps1 start -DisablePersonalModels
  .\xunjie-local.ps1 start -EnableReview
  .\xunjie-local.ps1 stop
Open https://127.0.0.1:3444 in the owned acceptance Chrome profile.
start reuses the prepared/validated dedicated C1 VM, starting it if stopped.
It waits at most120s for both original SSH readiness checks to match the saved local generation/fingerprints.
The synthetic35 database must already exist; this entry never prepares disks, keys or data again.
EnableReview requires the separately authorized41-table review composition; start never migrates it.
EnableModel reads your own DEEPSEEK_API_KEY into the local child environment only.
Personal model settings use each signed-in account's encrypted Key by default, without environment-Key fallback.
DisablePersonalModels stops new personal model calls while preserving settings and history.
stop sends SIGTERM to this exact business host; VM/runtime assets and database remain.
The parallel3443 gateway and PAHER are not controlled by this entry.
'@
  }
  status {
    $stored=if(Test-Path -LiteralPath $statePath){Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json}else{$null}
    [pscustomobject]@{origin='https://127.0.0.1:3444';process=$stored;node=Get-LocalNodeState;health=Get-LocalPublicHealth}|ConvertTo-Json -Depth 8
  }
  check { Get-LocalPublicHealth|ConvertTo-Json -Depth 8 }
  start {
    $null=Invoke-LocalWsl 'set -eu; test -f /opt/xunjie-ui-local/application-config.json; test -f /opt/xunjie-ui-local/tools/local-application-host.mjs; test -x /opt/xunjie-runner/node/bin/node; test -f /opt/xunjie-runner/local-node-ready.json'
    if(Get-NetTCPConnection -State Listen -LocalPort 3444 -ErrorAction SilentlyContinue){throw 'Local3444 is already listening; inspect status instead of creating another host.'}
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName='wsl.exe'
    $info.UseShellExecute=$false
    $info.CreateNoWindow=$true
    $modelArgument=''
    $reviewArgument=if($EnableReview){' --review-enabled'}else{''}
    if($EnableModel) {
      $key=[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','Process')
      if(-not $key){$key=[Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')}
      if(-not $key){throw 'Your local DEEPSEEK_API_KEY is absent; model-disabled start remains available.'}
      $info.Environment['DEEPSEEK_API_KEY']=$key
      $names=@(($info.Environment['WSLENV'] -split ':'|Where-Object{$_ -and ($_ -split '/')[0] -ne 'DEEPSEEK_API_KEY'}))+'DEEPSEEK_API_KEY/u'
      $info.Environment['WSLENV']=$names -join ':'
      $modelArgument=' --model-enabled'
      $key=$null
    } else { $null=$info.Environment.Remove('DEEPSEEK_API_KEY') }
    if($DisablePersonalModels){$modelArgument+=' --personal-models-disabled'}
    $node=Get-LocalNodeState -Ensure
    $startScript='set -eu; umask 077; echo $$ > /opt/xunjie-ui-local/host.pid; exec /opt/xunjie-runner/node/bin/node /opt/xunjie-ui-local/tools/local-application-host.mjs'+$modelArgument+$reviewArgument+' >>/opt/xunjie-ui-local/evidence/host.stdout.log 2>>/opt/xunjie-ui-local/evidence/host.stderr.log'
    # Original nonblocking flock retains exclusive ownership through the host exec.
    # A second start cannot overwrite the live Linux PID while readiness is pending.
    foreach($argument in @('-d','Ubuntu','-u','root','--exec','/usr/bin/flock','--no-fork','--nonblock','/opt/xunjie-ui-local/host.lock','/bin/sh','-c',$startScript)){$info.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$info
    $null=$process.Start()
    Start-Sleep -Seconds 2
    if($process.HasExited){throw 'Local host exited; inspect the controlled local startup log.'}
    [pscustomobject]@{windowsPid=$process.Id;startedAtUtc=[DateTimeOffset]::UtcNow.ToString('o');module='/opt/xunjie-ui-local/tools/local-application-host.mjs';modelEnabled=[bool]$EnableModel;reviewEnabled=[bool]$EnableReview}|ConvertTo-Json|Set-Content -LiteralPath $statePath -Encoding utf8
    [pscustomobject]@{started=$true;origin='https://127.0.0.1:3444';modelEnabled=[bool]$EnableModel;reviewEnabled=[bool]$EnableReview;node=$node;health=Get-LocalPublicHealth}|ConvertTo-Json -Depth 8
    $process.Dispose()
  }
  stop {
    $null=Invoke-LocalWsl 'set -eu; test -f /opt/xunjie-ui-local/host.pid; pid=$(cat /opt/xunjie-ui-local/host.pid); case "$pid" in ""|*[!0-9]*) exit 1;; esac; test "$(readlink /proc/$pid/exe)" = /opt/xunjie-runner/node/bin/node; tr "\000" " " < /proc/$pid/cmdline | grep -Fq "/opt/xunjie-ui-local/tools/local-application-host.mjs"; kill -TERM "$pid"'
    [pscustomobject]@{shutdownRequested=$true;scope='owned local business host';terminationConfirmed=$false}|ConvertTo-Json
  }
}
