// A resumable observation process: inspect its progress/PID; never restart an alive 900-second run after a tool timeout.
import {existsSync,appendFileSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {privateJson,ensurePrivateDirectory} from '../xj-dev/src/enrollment-protocol.mjs';
import {publishFrozen} from '../xj-dev/src/package-transfer.mjs';
import {client,httpsTransport,prepareProject,resumeProject,editAndSave,snapshot,submit,reviewAndResume,check,hash,CapacityFailure} from './capacity-workflow.mjs';

function jsonFile(file,value){const temporary=file+'.tmp';writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temporary,file);}
export async function runCapacity(config){
  check(config.windowApproved===true&&config.seconds>=900&&config.seconds<=1200&&/^[0-9a-f]{40}$/.test(config.expectedSource),'CAPACITY_WINDOW_NOT_APPROVED');
  const actors=privateJson(config.actorsFile).actors;check(actors.length===5&&new Set(actors.map(a=>a.memberId)).size===5,'CAPACITY_FIVE_MEMBERS_REQUIRED');
  const directory=ensurePrivateDirectory(config.evidenceDirectory),marker=join(directory,'run.json');
  check(!existsSync(marker),'CAPACITY_RUN_ALREADY_EXISTS_DO_NOT_RESTART');
  const runId=config.runId??randomUUID(),logFile=join(directory,'requests.jsonl'),eventsFile=join(directory,'events.jsonl');
  writeFileSync(logFile,'',{flag:'wx',mode:0o600});writeFileSync(eventsFile,'',{flag:'wx',mode:0o600});
  const harnessFiles=Object.fromEntries(['capacity-run.mjs','capacity-workflow.mjs','capacity-metrics.mjs'].map(name=>[name,hash(readFileSync(new URL(name,import.meta.url)))]));
  const startedAt=new Date().toISOString(),counts={requests:0,non2xx:0,unexpected5xx:0,readBytes:0,writeBytes:0},transports=[];
  const modelResults=[],transfers=[],requestIds=new Set();let project,phase='initial-login',steadyAt,finished=false;
  const abort=new AbortController(),pause=ms=>delay(ms,undefined,{signal:abort.signal});let stop=false;
  const event=value=>appendFileSync(eventsFile,JSON.stringify({at:new Date().toISOString(),...value})+'\n');
  function progress(extra={}){
    const value={schema:'xunjie/capacity-run-v1',runId,pid:process.pid,source:config.expectedSource,harnessFiles,phase,startedAt,
      steadyAt:steadyAt?new Date(steadyAt).toISOString():null,elapsedSeconds:steadyAt?(Date.now()-steadyAt)/1000:0,counts,
      models:modelResults,transfers,actors:project?.states.map(s=>({actor:s.label,iterations:s.iterations,submissions:s.submissions,feedback:s.feedback,replays:s.replays})),...extra};
    jsonFile(marker,value);
    if(config.ownerProgress){const previous=JSON.parse(readFileSync(config.ownerProgress,'utf8'));
      jsonFile(config.ownerProgress,{...previous,updatedAt:new Date().toISOString(),activeRun:value,
        liveCommands:[...(previous.liveCommands??[]).filter(item=>item.kind!=='capacity-load'),{kind:'capacity-load',pid:process.pid,runFile:marker,phase}]});}
  }
  const record=row=>{check(!requestIds.has(row.requestId),'CAPACITY_DUPLICATE_REQUEST_ID');requestIds.add(row.requestId);
    appendFileSync(logFile,JSON.stringify(row)+'\n');counts.requests++;counts.readBytes+=row.readBytes;counts.writeBytes+=row.writeBytes;
    if(row.status>=400)counts.non2xx++;if(row.status>=500)counts.unexpected5xx++;};
  const clients=actors.map(actor=>{const connection=privateJson(actor.connectionFile),transport=httpsTransport({port:config.ports?.[actor.label]??config.port,caFile:connection.caFile,origin:connection.browserOrigin});
    transports.push(transport);return {...actor,account:privateJson(actor.accountFile),client:client({actor:actor.label,origin:connection.browserOrigin,transport,record,executionNodeId:config.executionNodeId})};});
  let heartbeat;
  try{
    const probe=await transports[0].send({method:'GET',url:'/health/live',headers:{}});
    check(probe.status===200&&probe.headers['x-xunjie-version']===config.expectedSource,'CAPACITY_ARTIFACT_IDENTITY_MISMATCH');
    progress();event({phase:'initial-login',members:5});heartbeat=setInterval(()=>progress(),5000);
    // Product admits two scrypt verifications; normal logins are included, without intentionally triggering 429.
    for(let i=0;i<clients.length;i+=2)await Promise.all(clients.slice(i,i+2).map(async actor=>{
      await actor.client.login(actor.account);const identity=await actor.client.get('/api/session');actor.userId=identity.userId;
      check(typeof actor.userId==='string','CAPACITY_SESSION_IDENTITY_MISSING');
      delete actor.account;await actor.client.get('/api/courses');
    }));
    check(new Set(clients.map(actor=>actor.client.sessionFingerprint())).size===5,'CAPACITY_SHARED_SESSION');
    const teacher=clients.find(a=>a.label==='T'),students=clients.filter(a=>a.label!=='T');
    phase='prepare-own-project';progress();
    project=config.previousAuditFile?await resumeProject(teacher.client,students,config.courseId,runId,privateJson(config.previousAuditFile)):
      await prepareProject(teacher.client,students,config.courseId,runId,{reusePublishedActivity:config.reusePublishedActivity===true});
    jsonFile(join(directory,'project.json'),{runId,courseId:project.courseId,generation:project.generation,blueprintId:project.blueprintId,activityId:project.activityId,projectSource:project.projectSource,
      actors:project.states.map(s=>({actor:s.label,assignmentId:s.assignmentId,attemptId:s.attemptId,
        baseDocumentVersion:s.baseDocumentVersion??0,baseSaves:s.baseSaves??0,baseSubmissions:s.baseSubmissions??0,baseFeedback:s.baseFeedback??0}))});
    steadyAt=Date.now();const end=steadyAt+config.seconds*1000;phase='steady-load';progress();event({phase,minimumSeconds:config.seconds});
    const reviewQueue=[];let studentsDone=false,teacherFailure;
    const teacherWork=(async()=>{
      let nextView=0;
      try{while((!studentsDone||reviewQueue.length)&&!stop){
        const item=reviewQueue.shift();
        if(item){try{await reviewAndResume(teacher.client,item);item.resolve();}catch(error){item.reject(error);throw error;}}
        if(Date.now()>=nextView){await teacher.client.get('/api/courses/:id/teacher-workbench',{id:config.courseId});
          await teacher.client.get('/api/session');nextView=Date.now()+5000;}
        if(!item)await pause(200);
      }}catch(error){teacherFailure=error;stop=true;for(const item of reviewQueue.splice(0))item.reject(error);}
    })();
    async function realModel(actor){
      const expectedModelConfigRevision=config.modelConfigRevision??1;
      check((await actor.client.get('/api/model-settings')).revision===expectedModelConfigRevision,'CAPACITY_MODEL_REVISION_MISMATCH');
      const began=performance.now(),accepted=await actor.client.post('/api/agent/turns',{},
        {conversationId:null,mode:'send',text:'Reply exactly OK, with no explanation.',requestKey:`${runId}-real-${actor.label}`,expectedModelConfigRevision});
      let turn;
      for(let n=0;n<180;n++){
        turn=await actor.client.get('/api/agent/turns/:id',{id:accepted.turnId});
        if(['settled','failed','stopped'].includes(turn.message.phase))break;await pause(1000);
      }
      const result={actor:actor.label,source:'real provider, server-only resealed isolated credential',phase:turn.message.phase,
        success:turn.message.phase==='settled',exactOK:turn.message.text.trim()==='OK',elapsedMs:performance.now()-began,
        ...(turn.message.failure?{failureCode:turn.message.failure.code}:{})};
      modelResults.push(result);event({phase:'real-model-result',...result});progress();
      // Provider availability is reported independently; preserve the full business-capacity window on model failure.
    }
    const models=(async()=>{await pause(config.modelAtSeconds*1000);await Promise.all([realModel(teacher),realModel(students[0])]);})();
    const uploads=(async()=>{
      for(const [index,at]of config.transferAtSeconds.entries()){
        await pause(Math.max(0,steadyAt+at*1000-Date.now()));const actor=clients[index],file=config.transferFiles[index],began=performance.now();
        const result=await publishFrozen({home:actor.home},{deviceFile:actor.deviceFile,file,expectedDigest:'sha256:'+hash(readFileSync(file)),idempotencyKey:randomUUID()});
        // The transfer module exposes a safe public projection; no URL or STS is persisted here.
        const record=result.package??result.record??result;
        check(record.state==='published'&&typeof record.reproId==='string'&&Number.isSafeInteger(record.bytes),'CAPACITY_UPLOAD_NOT_PUBLISHED');
        transfers.push({actor:actor.label,source:'real OSS direct upload',reproId:record.reproId??result.reproId,
          bytes:record.bytes??result.bytes,elapsedMs:performance.now()-began,state:record.state??result.state});
        event({phase:'direct-upload',...transfers.at(-1)});progress();
      }
    })();
    const workers=project.states.map(async(state,index)=>{
      await pause(index*600);
      while(Date.now()<end&&!stop){const began=Date.now();
        if(teacherFailure)throw teacherFailure;
        if(state.iterations%5===0){await state.client.get('/api/courses');await state.client.get('/api/courses/:id/assignments',{id:config.courseId});await state.client.get('/api/session');}
        await editAndSave(state,runId);
        if(state.iterations%6===0){const item=await submit(state);
          // No await between the failure check and enqueue: a dead teacher cannot strand a later submitter.
          if(teacherFailure)throw teacherFailure;check(!stop,'CAPACITY_RUN_STOPPED');
          await new Promise((resolve,reject)=>reviewQueue.push({...item,resolve,reject}));
          await state.client.get('/api/attempts/:id/feedback',{id:state.attemptId});}
        else if(state.iterations%3===0)await snapshot(state);
        await pause(Math.max(0,5000-(Date.now()-began)));
      }
    });
    await Promise.all([...workers,models,uploads]);studentsDone=true;await teacherWork;if(teacherFailure)throw teacherFailure;
    phase='final-write-audit';progress();const audits=[];
    for(const state of project.states){
      const final=await state.client.get('/api/attempts/:id',{id:state.attemptId}),file=final.files.find(row=>row.path==='capacity.c'&&row.lifecycle==='active');
      check(file?.contentHash===state.lastHash&&file.documentVersion===(state.baseDocumentVersion??0)+state.iterations,'CAPACITY_FINAL_WRITE_MISMATCH');
      check(final.submissions.length===(state.baseSubmissions??0)+state.submissions,'CAPACITY_SUBMISSION_HISTORY_CHANGED');
      check(state.submissions===state.feedback&&state.submissions>0,'CAPACITY_UNREVIEWED_SUBMISSION');
      audits.push({actor:state.label,assignmentId:state.assignmentId,attemptId:state.attemptId,iterations:state.iterations,
        submissions:state.submissions,feedback:state.feedback,replays:state.replays,finalVersion:file.documentVersion,finalHash:file.contentHash,
        baseDocumentVersion:state.baseDocumentVersion??0,baseSaves:state.baseSaves??0,baseSubmissions:state.baseSubmissions??0,baseFeedback:state.baseFeedback??0,
        finalFileBytes:Buffer.byteLength(file.text),state:final.attempt.status});
    }
    jsonFile(join(directory,'write-audit.json'),{source:'actual API readback, exact hashes/version, idempotent command replay, immutable submitted artifact',actors:audits});
    check(Date.now()-steadyAt>=900_000&&modelResults.length===2&&transfers.length===2&&counts.non2xx===0,'CAPACITY_ACCEPTANCE_INCOMPLETE');
    phase='completed';finished=true;progress({finishedAt:new Date().toISOString(),steadySeconds:(Date.now()-steadyAt)/1000,
      acceptance:{businessRequestsAllSuccessful:counts.non2xx===0,realModelsPassed:modelResults.every(result=>result.success&&result.exactOK),realUploadsPassed:transfers.length===2}});event({phase,success:true});
  }catch(error){stop=true;abort.abort();phase='failed';progress({failureCode:error instanceof CapacityFailure?error.code:'CAPACITY_UNEXPECTED_FAILURE',failureDetails:error instanceof CapacityFailure?error.details:undefined});event({phase,failureCode:error instanceof CapacityFailure?error.code:'CAPACITY_UNEXPECTED_FAILURE'});throw new CapacityFailure('CAPACITY_RUN_FAILED');}
  finally{if(heartbeat)clearInterval(heartbeat);for(const transport of transports)transport.close();if(!finished)process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{await runCapacity(privateJson(resolve(process.argv[2])));}catch{process.stderr.write('CAPACITY_RUN_FAILED; inspect the non-secret durable progress, never print native HTTP errors.\n');process.exitCode=1;}
}
