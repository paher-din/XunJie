import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceProbeProgram=String.raw`
(async()=>{
 const fs=require('node:fs'),cp=require('node:child_process');let stage='source';
 try {
  const source='/opt/xunjie-runner/tests/i0-entry-source-9fa76ad-lf2-20261013/apps/teaching';
  const config=JSON.parse(fs.readFileSync('/opt/xunjie-runner/tests/i0-entry-20261013-01/i0-host-recovered-20261014.json','utf8'));
  const {sshRunner}=await import('file://'+source+'/server/records/runner.ts');const transport=sshRunner(config.ssh);
  stage='readiness';const c=(await transport({op:'readiness'})).data,h=(await transport({op:'hdl_readiness'})).data;
  if(!c||!h)throw new Error('missing');
  const publicReadiness={c:{ready:c.ready,compilerImage:c.compilerImage,runtimeImage:c.runtimeImage,kernel:c.fingerprint.kernel,sourceHash:c.fingerprint.sourceHash},
    hdl:{ready:h.ready,profile:h.profile,kernel:h.fingerprint.kernel},generation:c.recoveryGeneration};
  if(!c.ready||!h.ready||c.recoveryGeneration!==h.recoveryGeneration||c.fingerprint.sourceHash!=='7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852'||h.profile.sourceHash!=='7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852'){
    process.stdout.write(JSON.stringify({purpose:'Current image source unavailable; no export',stage,...publicReadiness}));process.exitCode=2;return;
  }
  stage='image-ids';const ids=[c.compilerImage,c.runtimeImage,h.profile.buildImage,h.profile.runtimeImage];
  if(ids.length!==new Set(ids).size||!ids.every(x=>/^sha256:[a-f0-9]{64}$/.test(x)))throw new Error('ids');
  const template='{'+['Id','Size','RepoTags','Architecture','Os'].map(k=>'"'+k+'":{{json .'+k+'}}').join(',')+',"Layers":{{json .RootFS.Layers}}}';
  const remote='/opt/xunjie-runner/engine/docker --host=unix:///run/xunjie-c1-docker.sock image inspect --format '+"'"+template+"'"+' '+ids.join(' ');
  const args=['-T','-i','/opt/xunjie-runner/vm/keys/maintenance','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
    '-o','UserKnownHostsFile=/opt/xunjie-runner/vm/keys/known_hosts','-o','GlobalKnownHostsFile=/dev/null','-p','2222','root@127.0.0.1',remote];
  stage='image-inspect';const inspected=cp.execFileSync('/usr/bin/ssh',args,{encoding:'utf8',timeout:40000,maxBuffer:65536,stdio:['ignore','pipe','pipe']}).trim().split('\n').map(x=>JSON.parse(x));
  if(inspected.length!==4||inspected.some((x,i)=>x.Id!==ids[i]||x.Architecture!=='amd64'||x.Os!=='linux'))throw new Error('inspect');
  process.stdout.write(JSON.stringify({observedAt:new Date().toISOString(),purpose:'Original current non-secret image identities; not Robert local acceptance',
    ...publicReadiness,images:inspected}));
 }catch{process.stdout.write(JSON.stringify({stage,error:'Current approved image probe failed; private details suppressed'}));process.exitCode=1;}
})();`;

function fail(){throw new Error('Frozen archive identity, shape or digest mismatch.');}
const digest=value=>createHash('sha256').update(value).digest('hex');
function pathName(value){
  if(typeof value!=='string'||!value||!value.match(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)||value.split('/').some(x=>x==='..'||x==='.'||x===''))fail();
  return value;
}
function numeric(bytes){
  if(bytes[0]&128){let v=BigInt(bytes[0]&127);for(const x of bytes.subarray(1))v=v*256n+BigInt(x);if(v>BigInt(Number.MAX_SAFE_INTEGER))fail();return Number(v);}
  const s=bytes.toString('ascii').replace(/\0.*$/,'').trim();if(s&&!/^[0-7]+$/.test(s))fail();return s?Number.parseInt(s,8):0;
}
const text=bytes=>bytes.toString('utf8').replace(/\0.*$/,'');
/** Verifies an outer Docker save archive in place; no extraction or Engine access. */
export async function verifyFrozenArchive(archivePath,source){
  if(!source||source.c?.ready!==true||source.hdl?.ready!==true||source.hdl.profile?.sourceHash!=='7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852'
    ||!Array.isArray(source.images)||source.images.length!==4)fail();
  const expected=source.images.map(image=>image.Id);
  if(new Set(expected).size!==4||expected.some(id=>!/^sha256:[a-f0-9]{64}$/.test(id)))fail();
  const info=await stat(archivePath);if(!info.isFile()||info.size<1024||info.size%512!==0||info.size>12*1024**3)fail();
  const fd=await open(archivePath,'r'),whole=createHash('sha256'),files=new Map();let position=0,zeroBlocks=0;
  const read=async count=>{const buffer=Buffer.allocUnsafe(count);let used=0;while(used<count){const r=await fd.read(buffer,used,count-used,position+used);if(!r.bytesRead)fail();used+=r.bytesRead;}position+=count;whole.update(buffer);return buffer;};
  try {
    while(position<info.size){
      const header=await read(512);
      if(header.every(x=>x===0)){zeroBlocks++;continue;}
      if(zeroBlocks)fail();
      const recorded=numeric(header.subarray(148,156));let check=0;
      for(let i=0;i<512;i++)check+=i>=148&&i<156?32:header[i];if(check!==recorded)fail();
      const base=text(header.subarray(0,100)),prefix=text(header.subarray(345,500));
      const name=pathName((prefix?prefix+'/':'')+base.replace(/\/$/,'')),size=numeric(header.subarray(124,136)),kind=String.fromCharCode(header[156]||48);
      if(![0,48,49,53].includes(header[156])||files.has(name)||size>info.size-position)fail();
      if(kind==='5'){if(size)fail();files.set(name,{path:name,type:'directory',bytes:0});continue;}
      if(kind==='1'){if(size)fail();files.set(name,{path:name,type:'hardlink',target:pathName(text(header.subarray(157,257))),bytes:0});continue;}
      // Docker 29 save places JSON config/index blobs at content-addressed paths
      // without a .json suffix. Capture bounded small blobs without extracting.
      const hash=createHash('sha256'),capture=size<=2*1024*1024&&(name.endsWith('.json')||name==='oci-layout'||/^blobs\/sha256\/[a-f0-9]{64}$/.test(name)),chunks=[];
      let remaining=size;while(remaining){const bytes=await read(Math.min(1024*1024,remaining));hash.update(bytes);if(capture)chunks.push(bytes);remaining-=bytes.length;}
      const padding=(512-size%512)%512;if(padding){const bytes=await read(padding);if(bytes.some(x=>x!==0))fail();}
      files.set(name,{path:name,type:'file',bytes:size,sha256:hash.digest('hex'),...(capture?{body:Buffer.concat(chunks)}:{})});
    }
    if(zeroBlocks<2)fail();
    for(const file of files.values())if(file.type==='file'&&/^blobs\/sha256\/[a-f0-9]{64}$/.test(file.path)&&file.sha256!==file.path.slice(13))fail();
    const get=name=>{let row=files.get(pathName(name));const seen=new Set();while(row?.type==='hardlink'){if(seen.has(row.path))fail();seen.add(row.path);row=files.get(row.target);}if(!row||row.type!=='file')fail();return row;};
    const manifestFile=get('manifest.json');if(!manifestFile.body)fail();
    const manifest=JSON.parse(manifestFile.body.toString('utf8'));if(!Array.isArray(manifest)||manifest.length!==4)fail();
    const images=[],ids=new Set();
    for(const entry of manifest){
      if(!entry||typeof entry!=='object'||!Array.isArray(entry.Layers)||entry.RepoTags!==null&&!Array.isArray(entry.RepoTags))fail();
      const configFile=get(entry.Config);if(!configFile.body)fail();const imageId='sha256:'+configFile.sha256;
      if(!expected.includes(imageId)||ids.has(imageId))fail();ids.add(imageId);
      const config=JSON.parse(configFile.body.toString('utf8'));
      if(config.os!=='linux'||config.architecture!=='amd64'||config.rootfs?.type!=='layers'||!Array.isArray(config.rootfs.diff_ids)||config.rootfs.diff_ids.length!==entry.Layers.length)fail();
      const layers=entry.Layers.map((path,index)=>{const file=get(path),diffId=config.rootfs.diff_ids[index];if(diffId!=='sha256:'+file.sha256)fail();return {path,bytes:file.bytes,diffId};});
      const original=source.images.find(image=>image.Id===imageId);
      if(JSON.stringify(original.Layers)!==JSON.stringify(config.rootfs.diff_ids))fail();
      images.push({imageId,configPath:entry.Config,configSha256:configFile.sha256,architecture:config.architecture,os:config.os,
        archivedRepoTags:entry.RepoTags??[],sourceRepoTags:original.RepoTags??[],layers});
    }
    return {verifiedAt:new Date().toISOString(),archivePath:resolve(archivePath),bytes:info.size,sha256:whole.digest('hex'),
      passed:true,imageIDs:images.map(x=>x.imageId),images,files:[...files.values()].map(({body,...metadata})=>metadata),
      purpose:'Non-secret immutable Docker image transfer only; not local runtime validation or acceptance'};
  }finally{await fd.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [operation,...args]=process.argv.slice(2);
    if(operation==='--probe-program'){process.stdout.write(sourceProbeProgram);}
    else if(operation==='verify'&&args.length===2){const source=JSON.parse(await readFile(args[1],'utf8'));process.stdout.write(JSON.stringify(await verifyFrozenArchive(args[0],source),null,2)+'\n');}
    else throw new Error('Use --probe-program or verify <archive> <public-source-receipt>.');
  }catch{process.stderr.write('Frozen image archive verification/probe request failed; no file contents displayed.\n');process.exitCode=1;}
}
