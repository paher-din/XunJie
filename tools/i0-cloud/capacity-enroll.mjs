// Private maintenance harness. Real access invitations and enrollment, no test passwords or SSH shortcuts.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {joinEnrollment} from '../xj-dev/src/enrollment-client.mjs';
import {ensurePrivateDirectory,privateJson,writePrivateJson} from '../xj-dev/src/enrollment-protocol.mjs';

export function access(repo,adminConfig,root,operation,input,outFile){
  const inputFile=join(root,'admin-input.json');writePrivateJson(inputFile,input);
  const args=[join(repo,'tools/xj-dev/xj-dev.mjs'),'access',operation,'--admin-config',adminConfig,'--input-file',inputFile,
    ...(outFile?['--out-file',outFile]:[]),'--worktree',repo];
  const child=spawnSync(process.execPath,args,{encoding:'utf8',timeout:90_000,env:{...process.env,XJ_DEV_HOME:join(root,'admin-home')}});
  let result;try{result=JSON.parse(child.stdout);}catch{throw new Error('CAPACITY_ADMIN_RESPONSE_FAILED');}
  if(child.status!==0||!result.ok)throw new Error('CAPACITY_ADMIN_OPERATION_FAILED');
  return result;
}
export async function enrollFive({repo,root,adminConfig,courseId}){
  ensurePrivateDirectory(root);const stateFile=join(root,'actors.json');
  const state=existsSync(stateFile)?privateJson(stateFile):{schema:'xunjie/capacity-actors-v1',courseId,actors:[]};
  if(state.courseId!==courseId)throw new Error('CAPACITY_SCOPE_CHANGED');
  for(const label of ['T','S1','S2','S3','S4']){
    if(state.actors.some(actor=>actor.label===label))continue;
    const home=ensurePrivateDirectory(join(root,label)),invitationFile=join(home,'invitation.json');
    if(!existsSync(invitationFile))access(repo,adminConfig,root,'invite',{label:`capacity-133-${label}`,teamRole:'developer',
      appRole:label==='T'?'teacher':'student',courseId,ttlSeconds:7200,capabilities:['page','file:read','file:publish']},invitationFile);
    const result=await joinEnrollment({home,invitationFile});
    state.actors.push({label,home,deviceFile:result.deviceFile,connectionFile:result.connectionFile,
      accountFile:result.accountFile,memberId:result.identity.memberId,deviceId:result.identity.deviceId});
    writePrivateJson(stateFile,state);
    process.stdout.write(JSON.stringify({phase:'enrolled',actor:label,ready:state.actors.length})+'\n');
  }
  return state;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const config=privateJson(resolve(process.argv[2]));await enrollFive(config);}
  catch{process.stderr.write('CAPACITY_ENROLL_FAILED; retain private state and inspect the specific stage without printing credentials.\n');process.exitCode=1;}
}
