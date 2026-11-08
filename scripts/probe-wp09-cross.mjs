// WP09 deployment/preflight controller. SSH carries control only; product traffic uses two real LAN hosts.
import { parseArgs, promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
const { values: a } = parseArgs({ options: {
  product:{type:'string'}, 'windows-product':{type:'string'}, 'remote-product':{type:'string'}, ssh:{type:'string',default:'win'},
  'mac-host':{type:'string',default:'192.168.3.39'}, 'win-host':{type:'string',default:'192.168.3.8'},
  'mac-port':{type:'string',default:'39409'}, 'win-port':{type:'string',default:'39410'},
  'credentials-file':{type:'string',default:'/Users/robertwu/.config/magpie/providers.json'},
  'prepare-only':{type:'boolean'}, 'windows-local-only':{type:'boolean'}, 'skip-windows-local':{type:'boolean'}, 'retain-failure':{type:'boolean'}, 'tls-worker':{type:'string'}, 'chrome-job':{type:'string'},
  'model':{type:'string',default:'real'}, out:{type:'string',default:'docs/student-agent-implementation/evidence/wp09/cross/report.json'},
  session:{type:'string',default:'wp09-cross-224'}, help:{type:'boolean'},
} });
const exec = promisify(execFile), sha = b => createHash('sha256').update(b).digest('hex');
const quote = v => "'" + v.replaceAll("'", "''") + "'";
const check = (v,c) => { if (!v) throw Object.assign(new Error(c),{code:c}); };
const safe = e => /^[a-zA-Z0-9_-]{1,100}$/.test(e?.code??'')?e.code:'cross-harness-failed';
async function ps(source,input='') {
 source=source.replaceAll('[Console]::In.ReadToEnd()', '([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())))');
  return new Promise((done,reject) => {
    const code="$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);"+source;
    const child=spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',a.ssh,'powershell -NoProfile -EncodedCommand '+Buffer.from(code,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe']});
    let out=''; child.stdout.on('data',b=>out+=b); child.stderr.resume();
    const timer=setTimeout(()=>{child.kill();reject(Object.assign(new Error(),{code:'ssh-control-timeout'}));},60000);
    child.on('error',()=>{clearTimeout(timer);reject(Object.assign(new Error(),{code:'ssh-control-failed'}));});
    child.on('close',n=>{clearTimeout(timer);n===0?done(out.replace(/^\uFEFF/,'').trim()):reject(Object.assign(new Error(),{code:'ssh-control-failed'}));});child.stdin.end(Buffer.from(input,'utf8').toString('base64')+'\n');
  });
}
async function get(url,ca) {
 return new Promise((done,reject)=>{const req=https.get(url,{ca,rejectUnauthorized:true,timeout:10000},r=>{let s='';r.on('data',b=>s+=b);r.on('end',()=>done({status:r.statusCode,value:JSON.parse(s),tlsAuthorized:r.socket?.authorized??true}));}); req.on('error',reject);req.on('timeout',()=>req.destroy(Object.assign(new Error(),{code:'tls-timeout'})));});
}
if(a.help){console.log('NODE24 scripts/probe-wp09-cross.mjs --prepare-only | --product dist/wp09-macos --windows-product dist/wp09-win32 [--model real|controlled] [--out JSON]. Uses only isolated owned roots and scoped firewall rules. Never claims old packages passed WP09.');process.exit(0);}
if(a['chrome-job']){await (await import('./lib/wp09-cross-case.mjs')).artifactChromeJob(a['chrome-job']);process.exit(0);}
if(a['tls-worker']){
 const j=JSON.parse(await readFile(a['tls-worker'],'utf8'));const ca=await readFile(j.certificate);
 const server=https.createServer({cert:ca,key:await readFile(j.key)},(_q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({host:hostname(),platform:process.platform,probe:'wp09-transport-only'}));});
 await new Promise(done=>server.listen(j.port,'0.0.0.0',done));const back=await get(j.macEndpoint,ca);
 console.log(JSON.stringify({ready:true,host:hostname(),platform:process.platform,macHttps:back}));
 process.stdin.once('data',()=>server.close());process.stdin.resume();
}else{
 const report={issue:224,status:'preparing',measuredAt:new Date().toISOString(),mode:a['prepare-only']?'transport-preflight':'product-acceptance',model:a.model,cleanup:{},stages:[]};
 const out=resolve(a.out), persist=async()=>{await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n');};
 let local,remote,firewall,child,server,releaseDesktop,taskName,taskRegistered=false;
 let prior;try{prior=JSON.parse(await readFile(out,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const used=prior?.totalRealProviderCalls??0;report.previousAttempts=prior?[...(prior.previousAttempts??[]),{status:prior.status,model:prior.model,realProviderCalls:prior.runRealProviderCalls??0,finishedAt:prior.finishedAt}]:[];report.totalRealProviderCalls=used;
 // Preserve the four calls consumed before the fault-injection TLS fix. The final
 // create/read/revise chain needs five more; the probe's overall ceiling is ten.
 report.realProviderCallLimit=10;
 let remaining=report.realProviderCallLimit-used;
 try{
  check(process.platform==='darwin'&&a['mac-host']!==a['win-host'],'requires-two-real-hosts');check(['real','controlled'].includes(a.model),'invalid-model-mode');
  report.topology={mac:{host:hostname(),ip:a['mac-host']},windows:{ip:a['win-host']},productTransport:'direct bidirectional LAN HTTPS',ssh:'control-only-no-tunnel',providerCredentials:'Mac only'};
  const preflight=JSON.parse(await ps("[PSCustomObject]@{host=$env:COMPUTERNAME;os=(Get-CimInstance Win32_OperatingSystem).Caption;chrome=(Get-Item 'C:/Program Files/Google/Chrome/Application/chrome.exe').VersionInfo.ProductVersion;playwright=(Test-Path 'C:/Users/h/XunJie-acceptance/node_modules/@playwright/test/package.json');oldNode='C:/Users/h/XunJie-acceptance/channel-product/resources/node/node.exe';temp=$env:TEMP}|ConvertTo-Json -Compress"));
  check(preflight.playwright,'windows-playwright-missing');report.windowsPreflight=preflight;report.topology.windows.host=preflight.host;
  local=await mkdtemp(join(tmpdir(),'xj-wp09-cross-control-'));remote=preflight.temp.replaceAll('\\','/')+'/xj-wp09-cross-'+randomUUID();
  const certificate=join(local,'lan.crt'),key=join(local,'lan.key');
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',certificate,'-days','2','-subj','/CN=XunJie WP09 isolated LAN test','-addext',`subjectAltName=IP:${a['mac-host']},IP:${a['win-host']}`],{maxBuffer:100000});
  const cert=new X509Certificate(await readFile(certificate));report.tls={certificateSha256:sha(cert.raw),spki:sha(cert.publicKey.export({type:'spki',format:'der'})),subjectAltName:cert.subjectAltName,trust:'explicit test CA for Node; certificate SPKI pin for Chrome; no global trust-store modification'};
  report.preparationStep='copy-TLS-and-probe-resources';await persist();
  await ps(`New-Item -ItemType Directory -Path ${quote(remote+'/lib')} -Force|Out-Null;[IO.File]::WriteAllText(${quote(remote+'/lan.crt')},[Console]::In.ReadToEnd(),[Text.UTF8Encoding]::new($false))`,await readFile(certificate,'utf8'));
  await ps(`[IO.File]::WriteAllText(${quote(remote+'/lan.key')},[Console]::In.ReadToEnd(),[Text.UTF8Encoding]::new($false))`,await readFile(key,'utf8'));
  for(const name of ['probe-wp09-cross.mjs','probe-teaching-assembly-cross.mjs','lib/wp09-cross-case.mjs'])await exec('scp',['-q',fileURLToPath(new URL(name,import.meta.url)),a.ssh+':'+remote+'/'+name],{timeout:60000});
  report.preparationStep='scoped-firewall';await persist();
  firewall='XunJie-WP09-'+randomUUID();
  await ps(`New-NetFirewallRule -Name ${quote(firewall)} -DisplayName ${quote(firewall)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${Number(a['win-port'])},${Number(a['win-port'])+2} -RemoteAddress ${quote(a['mac-host'])} -Profile Any|Out-Null`);
  const macFirewall=await exec('/usr/libexec/ApplicationFirewall/socketfilterfw',['--getglobalstate']);report.macFirewall={disabled:/State = 0/.test(macFirewall.stdout)};
  check(report.macFirewall.disabled,'mac-firewall-needs-scoped-rule');
  report.preparationStep='bidirectional-TLS';await persist();
  if(a['prepare-only']){
   let resourceNode=preflight.oldNode;
   const discovered=await ps(`$p=@('C:/Users/h/XunJie-acceptance/channel-product/resources/node/node.exe','C:/Users/h/XunJie-acceptance/wp03-188/product-win32-x64/resources/node/node.exe','C:/Users/h/.verification/wp08-217-cross-ywisqryz/product/resources/node/node.exe','C:/Users/h/XunJie-acceptance/package/resources/node/node.exe');$n=$p | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1;[PSCustomObject]@{node=$n;version=if($n){& $n --version}}|ConvertTo-Json -Compress`);
   const available=JSON.parse(discovered);check(available.version==='v24.21.0','windows-fixed-node-unavailable');resourceNode=available.node;report.windowsPreflight.node=available;
   server=https.createServer({cert:await readFile(certificate),key:await readFile(key)},(_q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({host:hostname(),platform:process.platform,probe:'wp09-transport-only'}));});await new Promise(done=>server.listen(Number(a['mac-port']),'0.0.0.0',done));
   const job={certificate:remote+'/lan.crt',key:remote+'/lan.key',port:Number(a['win-port']),macEndpoint:`https://${a['mac-host']}:${a['mac-port']}/transport-only`};
   await ps(`[IO.File]::WriteAllText(${quote(remote+'/tls-job.json')},[Console]::In.ReadToEnd(),[Text.UTF8Encoding]::new($false))`,JSON.stringify(job));
   const launch=`& ${quote(resourceNode)} ${quote(remote+'/probe-wp09-cross.mjs')} --tls-worker ${quote(remote+'/tls-job.json')};exit $LASTEXITCODE`;
   child=spawn('ssh',['-o','BatchMode=yes',a.ssh,'powershell -NoProfile -EncodedCommand '+Buffer.from(launch,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe']});child.stderr.resume();
   const ready=await new Promise((done,reject)=>{let text='';const timer=setTimeout(()=>reject(Object.assign(new Error(),{code:'tls-worker-start-timeout'})),20000);child.stdout.on('data',b=>{text+=b;for(const line of text.split('\n')){try{const v=JSON.parse(line);if(v.ready){clearTimeout(timer);done(v);return;}}catch{}}});child.once('exit',()=>reject(Object.assign(new Error(),{code:'tls-worker-exited'})));});
   report.transport={windowsToMac:ready.macHttps,macToWindows:await get(`https://${a['win-host']}:${a['win-port']}/transport-only`,await readFile(certificate))};check(report.transport.windowsToMac.status===200&&report.transport.macToWindows.status===200,'direct-tls-preflight-failed');
   report.preparationStep='Windows-Interactive-Limited-Chrome-SPKI';await persist();
   const {acquireNativeDesktop}=await import('./lib/native-desktop-lock.mjs');releaseDesktop=await acquireNativeDesktop('windows',a.session,'WP09 transport-only Chrome SPKI preflight');
   taskName='XunJie-WP09-Transport-'+randomUUID();const chromeJob={transportOnly:true,endpoint:`https://${a['mac-host']}:${a['mac-port']}/transport-only`,spki:createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('base64'),playwright:'C:/Users/h/XunJie-acceptance/package.json',result:remote+'/chrome-result.json',screenshot:remote+'/chrome.png'};
   const chromeLaunch='"'+remote+'/probe-wp09-cross.mjs" --chrome-job "'+remote+'/chrome-job.json"';
   await ps(`[IO.File]::WriteAllText(${quote(remote+'/chrome-job.json')},[Console]::In.ReadToEnd(),[Text.UTF8Encoding]::new($false));$a=New-ScheduledTaskAction -Execute ${quote(resourceNode)} -Argument ${quote(chromeLaunch)};$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2);Register-ScheduledTask -TaskName ${quote(taskName)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(taskName)}`,JSON.stringify(chromeJob));taskRegistered=true;
   let result;const end=Date.now()+45000;while(Date.now()<end){const raw=await ps(`if(Test-Path -LiteralPath ${quote(chromeJob.result)}){[IO.File]::ReadAllText(${quote(chromeJob.result)})}`);result=raw?JSON.parse(raw):null;if(result&&['passed','failed'].includes(result.status))break;await new Promise(done=>setTimeout(done,500));}
   check(result?.status==='passed','Windows-Chrome-transport-preflight-failed');const image=Buffer.from(await ps(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${quote(chromeJob.screenshot)}))`),'base64');
   const imagePath=resolve(dirname(out),'../windows/transport-preflight.png');await mkdir(dirname(imagePath),{recursive:true});await writeFile(imagePath,image);report.windowsChrome={status:result.status,chromeVersion:result.chromeVersion,desktopSessionId:result.desktopSessionId,transport:result.transport,screenshot:imagePath,screenshotSha256:sha(image)};
   report.preparationStep='complete';report.wp09Product='not-run; old package Node is transport infrastructure only';report.status='passed';
  }else{
   check(a.product&&(a['windows-product']||a['remote-product']),'new-product-packages-required');
   let remoteProduct=a['remote-product'];
   if(!remoteProduct){remoteProduct=remote+'/product';const archive=join(local,'windows.tgz');await exec('tar',['-czf',archive,'-C',resolve(a['windows-product']),'.'],{timeout:120000});await exec('scp',['-q',archive,a.ssh+':'+remote+'/windows.tgz'],{timeout:180000});await ps(`New-Item -ItemType Directory -Path ${quote(remoteProduct)}|Out-Null;tar -xzf ${quote(remote+'/windows.tgz')} -C ${quote(remoteProduct)};if($LASTEXITCODE){throw 'archive-extraction-failed'}`);}
   check(a.model!=='real'||remaining>=5,'remaining-real-call-budget-cannot-complete-create-and-revision');
   const node=join(resolve(a.product),'resources/node/bin/node');
   const argv=['scripts/probe-teaching-assembly-cross.mjs','--artifacts','--product',resolve(a.product),'--remote-product',remoteProduct,'--ssh',a.ssh,'--remote-script',remote+'/probe-teaching-assembly-cross.mjs','--certificate',certificate,'--key',key,'--remote-certificate',remote+'/lan.crt','--remote-key',remote+'/lan.key','--mac-host',a['mac-host'],'--win-host',a['win-host'],'--mac-port',a['mac-port'],'--win-port',a['win-port'],'--credentials-file',resolve(a['credentials-file']),'--artifacts-model',a.model,'--artifacts-session',a.session,'--artifacts-call-budget',String(a.model==='real'?remaining:8),'--out',out.replace(/\.json$/,'.case.json')];if(a['retain-failure'])argv.push('--artifacts-keep-failure');if(a['windows-local-only'])argv.push('--artifacts-windows-local-only');if(a['skip-windows-local'])argv.push('--artifacts-skip-windows-local');
   const result=await exec(node,argv,{timeout:15*60*1000,maxBuffer:1000000}).catch(e=>({code:e.code,stdout:e.stdout}));
   report.caseReport=JSON.parse(await readFile(out.replace(/\.json$/,'.case.json'),'utf8'));report.status=report.caseReport.status;report.retained=report.caseReport.retained;report.privateResume=report.caseReport.privateResume;report.runRealProviderCalls=a.model==='real'?(report.caseReport.providerRequests?.length??0):0;report.totalRealProviderCalls=used+report.runRealProviderCalls;
  }
 }catch(e){report.status='failed';report.error=safe(e);}
 finally{
  if(taskRegistered)try{await ps(`Stop-ScheduledTask -TaskName ${quote(taskName)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${quote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`);report.cleanup.windowsTaskRemoved=true;}catch(e){report.cleanup.taskError=safe(e);}
  if(releaseDesktop){await releaseDesktop();report.cleanup.windowsDesktopReleased=true;}
  if(child){const ended=new Promise(done=>child.once('close',done));child.stdin.end('close\n');await Promise.race([ended,new Promise(done=>setTimeout(()=>{child.kill();done();},5000))]);}
  if(server)await new Promise(done=>server.close(done));
  if(firewall)try{await ps(`Remove-NetFirewallRule -Name ${quote(firewall)};if(Get-NetFirewallRule -Name ${quote(firewall)} -ErrorAction SilentlyContinue){throw 'scoped-firewall-remains'}`);report.cleanup.scopedWindowsFirewallRemoved=true;}catch(e){report.cleanup.firewallError=safe(e);}
  if(remote&&report.retained){report.cleanup.remoteFixtureRetained=remote;report.cleanup.localFixtureRetained=local;local=null;remote=null;}
  if(remote)try{const cleanupCode="const fs=require('node:fs');const root=process.argv[1],prefix='C:/Users/h/AppData/Local/Temp/xj-wp09-cross-';if(!root.startsWith(prefix)||!/^[a-f0-9-]{36}$/.test(root.slice(prefix.length)))process.exit(2);fs.rmSync(root,{recursive:true,force:true,maxRetries:12,retryDelay:200});if(fs.existsSync(root))process.exit(3);";await ps(`& 'C:/Users/h/XunJie-acceptance/channel-product/resources/node/node.exe' -e ${quote(cleanupCode)} ${quote(remote)};if($LASTEXITCODE){throw 'owned-probe-root-cleanup-failed'}`);report.cleanup.remoteFixtureRemoved=true;}catch(e){report.cleanup.remoteError=safe(e);}
  if(local){await rm(local,{recursive:true,force:true});report.cleanup.localFixtureRemoved=true;}
  if(Object.keys(report.cleanup).some(k=>k.endsWith('Error')))report.status='failed';report.finishedAt=new Date().toISOString();await persist();
 }
 console.log(JSON.stringify({status:report.status,report:out,mode:report.mode,error:report.error}));if(report.status!=='passed')process.exitCode=1;
}
