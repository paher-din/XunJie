import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, rmdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFrozenArchive, sourceProbeProgram } from './receive-frozen-images.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const frozenSource='7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852';
function header(path,bytes){
  const block=Buffer.alloc(512);block.write(path);block.write('0000644\0',100);block.write('0000000\0',108);block.write('0000000\0',116);
  block.write(bytes.toString(8).padStart(11,'0')+'\0',124);block.write('00000000000\0',136);block.fill(32,148,156);
  block[156]=48;block.write('ustar\0',257);block.write('00',263);const check=block.reduce((a,b)=>a+b,0);
  block.write(check.toString(8).padStart(6,'0')+'\0 ',148);return block;
}
function fixture(oci=false){
  const files=[],images=[],manifest=[];
  for(let i=0;i<4;i++){
    const layer=Buffer.from('non-secret synthetic layer '+i),diffId='sha256:'+sha(layer);
    const config=Buffer.from(JSON.stringify({os:'linux',architecture:'amd64',created:String(i),rootfs:{type:'layers',diff_ids:[diffId]}})),id=sha(config);
    const configPath=oci?'blobs/sha256/'+id:id+'.json',layerPath=oci?'blobs/sha256/'+sha(layer):sha(layer)+'/layer.tar';
    files.push({path:configPath,body:config},{path:layerPath,body:layer});
    images.push({Id:'sha256:'+id,Layers:[diffId],RepoTags:['synthetic/image:'+i]});
    manifest.push({Config:configPath,RepoTags:null,Layers:[layerPath]});
  }
  files.push({path:'manifest.json',body:Buffer.from(JSON.stringify(manifest))});
  const archive=()=>Buffer.concat([...files.flatMap(f=>[header(f.path,f.body.length),f.body,Buffer.alloc((512-f.body.length%512)%512)]),Buffer.alloc(1024)]);
  return {files,archive,source:{c:{ready:true},hdl:{ready:true,profile:{sourceHash:frozenSource}},images}};
}
const directory=resolve('D:/XunJie_Project/i0-ui55-connection/hdl-ui/local-environment/oci/verifier-tests-'+process.pid);
async function withArchive(build,callback){
  await mkdir(directory,{recursive:true});const path=join(directory,'synthetic-'+process.hrtime.bigint()+'.tar');
  await writeFile(path,build);
  try{return await callback(path);}finally{assert.equal(dirname(resolve(path)),directory);await unlink(path);}
}
test('classic and Docker29 OCI blob layouts bind config ID, layers and archive digest',async()=>{
  for(const oci of [false,true]){
    const f=fixture(oci),bytes=f.archive();await withArchive(bytes,async path=>{
      const result=await verifyFrozenArchive(path,f.source);assert.equal(result.passed,true);assert.equal(result.sha256,sha(bytes));
      assert.equal(result.bytes,bytes.length);assert.deepEqual(new Set(result.imageIDs),new Set(f.source.images.map(x=>x.Id)));
      assert.equal(result.images.length,4);assert.equal(result.files.length,9);
    });
  }
});
test('rejects layer mutation, wrong source ID, blob digest name and unsafe TAR path',async()=>{
  for(const kind of ['layer','source','blob','path']){
    const f=fixture(kind==='blob');
    if(kind==='layer')f.files[1].body=Buffer.from('altered synthetic layer');
    if(kind==='source')f.source.images[0].Id='sha256:'+'0'.repeat(64);
    if(kind==='blob')f.files[0].path='blobs/sha256/'+'f'.repeat(64);
    if(kind==='path')f.files[0].path='../outside.json';
    await withArchive(f.archive(),path=>assert.rejects(verifyFrozenArchive(path,f.source),/mismatch/));
  }
});
test('rejects truncated archive, bad checksum, unknown readiness and changed frozen source',async()=>{
  for(const kind of ['truncated','checksum','not-ready','sourcehash']){
    const f=fixture();let bytes=f.archive();
    if(kind==='truncated')bytes=bytes.subarray(0,bytes.length-513);
    if(kind==='checksum')bytes[25]^=1;
    if(kind==='not-ready')f.source.c.ready=false;
    if(kind==='sourcehash')f.source.hdl.profile.sourceHash='new-or-history';
    await withArchive(bytes,path=>assert.rejects(verifyFrozenArchive(path,f.source),/mismatch/));
  }
});
test('receiver restores explicit operation/timeout after importing existing maintenance entry',async()=>{
  const path=join(dirname(fileURLToPath(import.meta.url)),'receive-frozen-images.ps1'),body=await readFile(path,'utf8');
  assert.match(body,/\$receiveOperation=\$Operation;\$receiveTimeoutSeconds=\$TimeoutSeconds\s*\. \$MaintenanceEntry\s*\$Operation=\$receiveOperation;\$TimeoutSeconds=\$receiveTimeoutSeconds/);
  assert.match(body,/if\(\$Operation -eq 'probe'\)\{[^\n]*return\}/);
  assert.match(body,/image save '\+\(\$ids -join ' '\)/);
  assert.doesNotMatch(body,/image load|image build|docker.*restart|Remove-Item|Get-Content.*keyFile/i);
  assert.match(body,/Only the exact approved D OCI directory/);
  assert.match(body,/CreateNew/);
  assert.match(sourceProbeProgram,/c\.fingerprint\.sourceHash!==/);
  assert.match(sourceProbeProgram,/op:'readiness'/);assert.match(sourceProbeProgram,/op:'hdl_readiness'/);
  assert.doesNotMatch(sourceProbeProgram,/console\.|JSON\.stringify\(config\)|readFileSync\([^\n]*keyFile/);
});
test.after(async()=>{await rmdir(directory);});
