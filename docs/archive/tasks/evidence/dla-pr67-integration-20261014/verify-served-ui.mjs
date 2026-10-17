import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {request} from 'node:https';
import assert from 'node:assert/strict';
import {extname} from 'node:path';
const manifest=JSON.parse(readFileSync(process.argv[2],'utf8')),cert=readFileSync('/opt/xunjie-runner/tests/i0-entry-20261013-01/server.cert.pem');
const failures=[],expectedRejections=[];
// Existing I0 static-serving contract; JSON brand metadata is bundled by Vite, licenses are retained on disk.
const allowed=new Set(['.html','.js','.css','.svg','.png','.jpg','.jpeg','.ico','.ttf','.woff','.woff2']);
for(const file of manifest.files){
  const value=await new Promise((resolve,reject)=>{const req=request(new URL('/'+file.path,manifest.origin),{ca:cert,rejectUnauthorized:true},response=>{
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,authorized:response.socket?.authorized??true,body:Buffer.concat(chunks)}));
  });req.setTimeout(10000,()=>req.destroy(new Error('Static byte verification timed out')));req.on('error',reject);req.end();});
  if(!allowed.has(extname(file.path))){
    let code;try{code=JSON.parse(value.body.toString('utf8')).error?.code;}catch{}
    expectedRejections.push({path:file.path,status:value.status,code});
    if(value.status!==400||!value.authorized||code!=='INVALID_REQUEST')failures.push(file.path);
  }else if(value.status!==200||!value.authorized||value.body.length!==file.bytes||createHash('sha256').update(value.body).digest('hex')!==file.sha256)failures.push(file.path);
}
const result={checkedAt:new Date().toISOString(),origin:manifest.origin,sourceCommit:manifest.sourceCommit,zipSha256:manifest.zipSha256,
  filesInManifest:manifest.files.length,servedFilesVerified:manifest.files.length-expectedRejections.length,
  expectedRejections,byteMismatches:failures,passed:failures.length===0,strictTls:true,modelRequests:0,browserAcceptance:false};
writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));assert.equal(result.passed,true);
