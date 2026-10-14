import { createReadStream, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const retained='/mnt/d/XunJie_Project/i0-ui55-connection/hdl-ui/local-environment/oci/';
const file=process.argv[2];
if(!file?.startsWith(retained)||!/^verified-image-receipt-[A-Za-z0-9-]+\.json$/.test(file.slice(retained.length)))throw Error('Owned verified OCI receipt required');
if(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())throw Error('OCI receipt must be a regular file');
const receipt=JSON.parse(readFileSync(file,'utf8'));
const expected=[
  'sha256:9f14e671a09bc195b93ca39524b8dcf401bc832b0c520e462327ce94986799aa',
  'sha256:765d51df494104de704bbecfdfdd42945077ea4c8f11fb49f91e9dca27a6fe99',
  'sha256:6a0e6ee8ab6bffc7a4fc999c5dbdcf68f058ed04cb13f053730e7209e3efad0d',
  'sha256:6a3c202ccc35152020f156ad4d9665f08cb45ff9893fe5c51b6be9e788243ca5',
].sort();
if(receipt.passed!==true||JSON.stringify([...receipt.imageIDs].sort())!==JSON.stringify(expected))throw Error('Verified original four-image identity required');
const archive=receipt.archivePath.replace(/^D:\\/i,'/mnt/d/').replaceAll('\\','/');
if(!archive.startsWith(retained)||!/^frozen-images-[A-Za-z0-9-]+\.tar$/.test(archive.slice(retained.length)))throw Error('OCI archive must stay in the owned retained directory');
const stat=lstatSync(archive);
if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==receipt.bytes||!/^[0-9a-f]{64}$/.test(receipt.sha256))throw Error('OCI archive metadata differs');
const hash=createHash('sha256');for await(const chunk of createReadStream(archive))hash.update(chunk);
if(hash.digest('hex')!==receipt.sha256)throw Error('OCI archive hash differs');
const ssh=spawn('/usr/bin/ssh',['-i','/opt/xunjie-runner/vm/keys/maintenance',
  '-o','UserKnownHostsFile=/opt/xunjie-runner/vm/keys/known_hosts','-o','StrictHostKeyChecking=yes',
  '-o','BatchMode=yes','-o','IdentitiesOnly=yes','-p','2222','root@127.0.0.1',
  '/opt/xunjie-runner/engine/docker --host=unix:///run/xunjie-c1-docker.sock --config=/opt/xunjie-runner/cli-config load'],{stdio:['pipe','inherit','inherit']});
const exited=new Promise((resolve,reject)=>{ssh.once('error',reject);ssh.once('close',code=>code===0?resolve():reject(Error('Local dedicated OCI import failed; reconcile original image IDs before retry')));});
await pipeline(createReadStream(archive),ssh.stdin);await exited;
console.log(JSON.stringify({archivePath:receipt.archivePath,sha256:receipt.sha256,bytes:receipt.bytes,imageIDs:expected,importedInto:'Fresh Robert guest dedicated Engine',copiedKeys:false,copiedValidationState:false}));
