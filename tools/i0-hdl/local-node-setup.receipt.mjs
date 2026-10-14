import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const base='/opt/xunjie-runner';
const ssh={binary:'/usr/bin/ssh',keyFile:base+'/vm/keys/application',knownHostsFile:base+'/vm/keys/known_hosts',host:'127.0.0.1',port:2222};
const expectedSource='7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852';
function read(op) {
  const output=execFileSync(ssh.binary,['-i',ssh.keyFile,'-o','UserKnownHostsFile='+ssh.knownHostsFile,
    '-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-o','IdentitiesOnly=yes',
    '-p',String(ssh.port),'root@'+ssh.host,'xunjie-c1'],{input:JSON.stringify({op}),encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  const value=JSON.parse(output);if(value.error||!value.data)throw Error('Authenticated local readiness failed: '+op);
  return value;
}
const c=read('readiness'),hdl=read('hdl_readiness');
if(c.data.ready!==true||hdl.data.ready!==true)throw Error('Current local C/HDL acceptance has not earned readiness');
if(c.data.recoveryGeneration!==hdl.data.recoveryGeneration)throw Error('Local C/HDL generations differ');
if(c.data.fingerprint.sourceHash!==expectedSource||hdl.data.profile.sourceHash!==expectedSource||hdl.data.fingerprint.sourceHash!==expectedSource)throw Error('Frozen local source differs');
if(c.data.compilerImage!=='sha256:9f14e671a09bc195b93ca39524b8dcf401bc832b0c520e462327ce94986799aa'
  ||c.data.runtimeImage!=='sha256:765d51df494104de704bbecfdfdd42945077ea4c8f11fb49f91e9dca27a6fe99'
  ||hdl.data.profile.buildImage!=='sha256:6a0e6ee8ab6bffc7a4fc999c5dbdcf68f058ed04cb13f053730e7209e3efad0d'
  ||hdl.data.profile.runtimeImage!=='sha256:6a3c202ccc35152020f156ad4d9665f08cb45ff9893fe5c51b6be9e788243ca5')throw Error('Original image identity differs');
const receipt={observedAtUtc:new Date().toISOString(),scope:'Robert fresh local synthetic C1; authenticated application reads after current acceptance',
  recoveryGeneration:c.data.recoveryGeneration,ssh,sourceHash:expectedSource,c,hdl,hdlRuntime:hdl.data.profile,
  vm:{hostDistribution:'Ubuntu',unit:'xunjie-c1-vm.service',vcpus:2,memoryMiB:4096,diskGiB:20,sharedFolders:false,
    guestHostPublicPin:readFileSync(ssh.knownHostsFile,'utf8').trim()},
  importedRemoteValidationState:false,readinessUsesCurrentLocalValidation:true,importedRemoteKeys:false,importedRemoteDatabase:false};
writeFileSync(base+'/local-node-ready.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(receipt,null,2));
