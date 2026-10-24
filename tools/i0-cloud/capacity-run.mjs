// A resumable observation process: inspect its progress/PID; never restart an alive 900-second run after a tool timeout.
import {existsSync,appendFileSync,readFileSync,writeFileSync,renameSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {privateJson,ensurePrivateDirectory} from '../xj-dev/src/enrollment-protocol.mjs';
import {publishFrozen} from '../xj-dev/src/package-transfer.mjs';
import {CliError} from '../xj-dev/src/envelope.mjs';
import {routes} from './capacity-metrics.mjs';
import {client,httpsTransport,prepareProject,resumeProject,editAndSave,snapshot,submit,reviewAndResume,check,hash,CapacityFailure} from './capacity-workflow.mjs';

function jsonFile(file,value){const temporary=file+'.tmp';writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temporary,file);}
function transferFailure(error){
  // CliError is already the transfer tool's safe contract. Messages, recovery, native errors and URLs stay private.
  return error instanceof CliError&&['transfer','enrollment','repro','lock'].includes(error.stage)&&typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ?{failureStage:error.stage,failureCode:error.code}:{failureStage:'transfer',failureCode:'CAPACITY_TRANSFER_FAILED'};
}
function fatalFailure(error){
  const failureCode=error instanceof CapacityFailure&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)?error.code:'CAPACITY_UNEXPECTED_FAILURE';
  const input=error instanceof CapacityFailure?error.details:undefined,failureDetails={};
  if(input&&typeof input==='object'){
    if(['T','S1','S2','S3','S4'].includes(input.actor))failureDetails.actor=input.actor;
    if(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(input.method))failureDetails.method=input.method;
    if(routes.has(input.route))failureDetails.route=input.route;
    if(Number.isInteger(input.status)&&input.status>=100&&input.status<=599)failureDetails.status=input.status;
    if(typeof input.requestId==='string'&&/^[0-9a-f-]{36}$/i.test(input.requestId))failureDetails.requestId=input.requestId;
    if(typeof input.serverErrorCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(input.serverErrorCode))failureDetails.serverErrorCode=input.serverErrorCode;
  }
  return {failureCode,...(Object.keys(failureDetails).length?{failureDetails}:{})};
}
export async function runCapacity(config,{transportFactory=httpsTransport,publish=publishFrozen,wait=delay}={}){
  check(config.windowApproved===true&&config.seconds>=900&&config.seconds<=1200&&/^[0-9a-f]{40}$/.test(config.expectedSource),'CAPACITY_WINDOW_NOT_APPROVED');
  const actors=privateJson(config.actorsFile).actors;check(actors.length===5&&new Set(actors.map(a=>a.memberId)).size===5
    &&new Set(actors.map(a=>a.label)).size===5&&actors.every(a=>['T','S1','S2','S3','S4'].includes(a.label)),'CAPACITY_FIVE_MEMBERS_REQUIRED');
  const directory=ensurePrivateDirectory(config.evidenceDirectory),marker=join(directory,'run.json');
  check(!existsSync(marker),'CAPACITY_RUN_ALREADY_EXISTS_DO_NOT_RESTART');
  const runId=config.runId??randomUUID(),logFile=join(directory,'requests.jsonl'),eventsFile=join(directory,'events.jsonl');
  writeFileSync(logFile,'',{flag:'wx',mode:0o600});writeFileSync(eventsFile,'',{flag:'wx',mode:0o600});
  const harnessFiles=Object.fromEntries(['capacity-run.mjs','capacity-workflow.mjs','capacity-metrics.mjs'].map(name=>[name,hash(readFileSync(new URL(name,import.meta.url)))]));
  const startedAt=new Date().toISOString(),counts={requests:0,non2xx:0,unexpected5xx:0,readBytes:0,writeBytes:0},transports=[];
  const modelResults=[],transfers=[],requestIds=new Set(),tasks=[],branchResults=[],reviewQueue=[];
  let project,phase='initial-login',steadyAt,fatal,hasFatal=false,terminal=false,heartbeat;const persistent={};
  const abort=new AbortController(),pause=ms=>wait(ms,undefined,{signal:abort.signal});let stop=false;
  const event=value=>appendFileSync(eventsFile,JSON.stringify({at:new Date().toISOString(),...value})+'\n');
  function progress(extra={}){
    if(terminal)return;
    Object.assign(persistent,extra);
    const value={schema:'xunjie/capacity-run-v1',runId,pid:process.pid,source:config.expectedSource,harnessFiles,phase,startedAt,
      steadyAt:steadyAt?new Date(steadyAt).toISOString():null,elapsedSeconds:steadyAt?(Date.now()-steadyAt)/1000:0,counts,
      models:modelResults,transfers,branchResults,actors:project?.states.map(s=>({actor:s.label,iterations:s.iterations,submissions:s.submissions,feedback:s.feedback,replays:s.replays})),
      ...persistent,...(hasFatal?fatalFailure(fatal):{})};
    jsonFile(marker,value);
    if(config.ownerProgress){const previous=JSON.parse(readFileSync(config.ownerProgress,'utf8'));
      jsonFile(config.ownerProgress,{...previous,updatedAt:new Date().toISOString(),activeRun:value,
        liveCommands:[...(previous.liveCommands??[]).filter(item=>item.kind!=='capacity-load'),{kind:'capacity-load',pid:process.pid,runFile:marker,phase}]});}
  }
  function fail(error){
    if(hasFatal)return;
    fatal=error;hasFatal=true;stop=true;phase='draining';if(heartbeat)clearInterval(heartbeat);
    abort.abort();for(const transport of transports)transport.close();
    for(const item of reviewQueue.splice(0))item.reject(error);
    progress();event({phase,...fatalFailure(error)});
  }
  function track(branch,work){
    const result={branch,state:'running'};branchResults.push(result);
    const promise=(async()=>{
      try{check(!stop,'CAPACITY_RUN_STOPPED');const value=await work();result.state='fulfilled';return value;}
      catch(error){Object.assign(result,{state:'rejected',...fatalFailure(error)});fail(error);throw error;}
    })();
    // Attach immediately, even when this branch is only awaited during shutdown.
    promise.catch(()=>{});tasks.push(promise);return promise;
  }
  async function drain(){
    // A model branch may register its two children after its scheduled wait; drain those too.
    let offset=0;while(offset<tasks.length){const pending=tasks.slice(offset);offset=tasks.length;await Promise.allSettled(pending);}
  }
  const record=row=>{check(!requestIds.has(row.requestId),'CAPACITY_DUPLICATE_REQUEST_ID');requestIds.add(row.requestId);
    appendFileSync(logFile,JSON.stringify(row)+'\n');counts.requests++;counts.readBytes+=row.readBytes;counts.writeBytes+=row.writeBytes;
    if(row.status>=400)counts.non2xx++;if(row.status>=500)counts.unexpected5xx++;};
  const clients=actors.map(actor=>{const connection=privateJson(actor.connectionFile),transport=transportFactory({port:config.ports?.[actor.label]??config.port,caFile:connection.caFile,origin:connection.browserOrigin});
    let closed=false;const guarded={close(){if(!closed){closed=true;transport.close();}},send(input){check(!stop,'CAPACITY_RUN_STOPPED');return transport.send(input);}};
    transports.push(guarded);return {...actor,account:privateJson(actor.accountFile),client:client({actor:actor.label,origin:connection.browserOrigin,transport:guarded,record,executionNodeId:config.executionNodeId})};});
  try{
    const probe=await transports[0].send({method:'GET',url:'/health/live',headers:{}});
    check(probe.status===200&&probe.headers['x-xunjie-version']===config.expectedSource,'CAPACITY_ARTIFACT_IDENTITY_MISMATCH');
    progress();event({phase:'initial-login',members:5});heartbeat=setInterval(()=>progress(),5000);
    // Product admits two scrypt verifications; normal logins are included, without intentionally triggering 429.
    for(let i=0;i<clients.length;i+=2)await Promise.all(clients.slice(i,i+2).map(actor=>track('login:'+actor.label,async()=>{
      await actor.client.login(actor.account);const identity=await actor.client.get('/api/session');actor.userId=identity.userId;
      check(typeof actor.userId==='string','CAPACITY_SESSION_IDENTITY_MISSING');
      delete actor.account;await actor.client.get('/api/courses');
    })));
    check(new Set(clients.map(actor=>actor.client.sessionFingerprint())).size===5,'CAPACITY_SHARED_SESSION');
    const teacher=clients.find(a=>a.label==='T'),students=clients.filter(a=>a.label!=='T');
    phase='prepare-own-project';progress();
    project=config.previousAuditFile?await resumeProject(teacher.client,students,config.courseId,runId,privateJson(config.previousAuditFile)):
      await prepareProject(teacher.client,students,config.courseId,runId,{reusePublishedActivity:config.reusePublishedActivity===true});
    jsonFile(join(directory,'project.json'),{runId,courseId:project.courseId,generation:project.generation,blueprintId:project.blueprintId,activityId:project.activityId,projectSource:project.projectSource,
      actors:project.states.map(s=>({actor:s.label,assignmentId:s.assignmentId,attemptId:s.attemptId,
        baseDocumentVersion:s.baseDocumentVersion??0,baseSaves:s.baseSaves??0,baseSubmissions:s.baseSubmissions??0,baseFeedback:s.baseFeedback??0}))});
    steadyAt=Date.now();const end=steadyAt+config.seconds*1000;phase='steady-load';progress();event({phase,minimumSeconds:config.seconds});
    let studentsDone=false;
    const teacherWork=track('teacher',async()=>{
      let nextView=0;
      while((!studentsDone||reviewQueue.length)&&!stop){
        const item=reviewQueue.shift();
        if(item){try{await reviewAndResume(teacher.client,item);item.resolve();}catch(error){item.reject(error);throw error;}}
        if(Date.now()>=nextView){await teacher.client.get('/api/courses/:id/teacher-workbench',{id:config.courseId});
          await teacher.client.get('/api/session');nextView=Date.now()+5000;}
        if(!item)await pause(200);
      }
    });
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
    const models=track('models',async()=>{await pause(config.modelAtSeconds*1000);
      await Promise.allSettled([track('model:T',()=>realModel(teacher)),track('model:S1',()=>realModel(students[0]))]);});
    for(const [index,at]of config.transferAtSeconds.entries()){
      let plannedBytes=null;try{plannedBytes=statSync(config.transferFiles[index]).size;}catch{}
      transfers.push({actor:clients[index].label,source:'real OSS direct upload',scheduledSeconds:at,plannedBytes,state:'scheduled',elapsedMs:0});
    }
    const uploads=track('uploads',async()=>{try{
      for(const [index,at]of config.transferAtSeconds.entries()){
        if(stop)break;
        await pause(Math.max(0,steadyAt+at*1000-Date.now()));
        if(stop)break;
        const actor=clients[index],file=config.transferFiles[index],began=performance.now();
        const transfer=transfers[index];transfer.state='uploading';progress();
        try{
          const result=await publish({home:actor.home},{deviceFile:actor.deviceFile,file,expectedDigest:'sha256:'+hash(readFileSync(file)),idempotencyKey:randomUUID()});
          // The transfer module exposes a safe public projection; no URL or STS is persisted here.
          const record=result.package??result.record??result;
          check(record.state==='published'&&typeof record.reproId==='string'&&Number.isSafeInteger(record.bytes),'CAPACITY_UPLOAD_NOT_PUBLISHED');
          Object.assign(transfer,{reproId:record.reproId,bytes:record.bytes,state:record.state});
        }catch(error){Object.assign(transfer,{state:'failed',...transferFailure(error)});}
        transfer.elapsedMs=performance.now()-began;event({phase:'direct-upload',...transfer});progress();
      }
    }finally{
      if(stop)for(const transfer of transfers)if(transfer.state==='scheduled')Object.assign(transfer,{state:'not_started',failureStage:'capacity',failureCode:'CAPACITY_RUN_STOPPED'});
      progress();
    }});
    const workers=project.states.map((state,index)=>track('student:'+state.label,async()=>{
      await pause(index*600);
      while(Date.now()<end&&!stop){const began=Date.now();
        check(!stop,'CAPACITY_RUN_STOPPED');
        if(state.iterations%5===0){await state.client.get('/api/courses');await state.client.get('/api/courses/:id/assignments',{id:config.courseId});await state.client.get('/api/session');}
        await editAndSave(state,runId);
        if(state.iterations%6===0){const item=await submit(state);
          // No await between the failure check and enqueue: a dead teacher cannot strand a later submitter.
          check(!stop,'CAPACITY_RUN_STOPPED');
          await new Promise((resolve,reject)=>reviewQueue.push({...item,resolve,reject}));
          await state.client.get('/api/attempts/:id/feedback',{id:state.attemptId});}
        else if(state.iterations%3===0)await snapshot(state);
        await pause(Math.max(0,5000-(Date.now()-began)));
      }
    }));
    await Promise.all([...workers,models,uploads]);studentsDone=true;await teacherWork;await drain();if(hasFatal)throw fatal;
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
    const acceptance={businessRequestsAllSuccessful:counts.non2xx===0,realModelsPassed:modelResults.every(result=>result.success&&result.exactOK),
      realUploadsPassed:transfers.length===2&&transfers.every(result=>result.state==='published')};
    acceptance.executionPassed=acceptance.businessRequestsAllSuccessful&&acceptance.realModelsPassed&&acceptance.realUploadsPassed;
    // A successful execution still needs separate server-duration/resource/independent-DB acceptance.
    acceptance.overallPassed=acceptance.executionPassed?null:false;
    phase='completed';progress({finishedAt:new Date().toISOString(),steadySeconds:(Date.now()-steadyAt)/1000,executionDrained:true,acceptance,
      ...(!acceptance.executionPassed?{failureCode:'CAPACITY_EXTERNAL_DEPENDENCY_FAILED'}:{})});terminal=true;event({phase,success:acceptance.executionPassed});return acceptance;
  }catch(error){
    fail(error);await drain();phase='failed';progress({finishedAt:new Date().toISOString(),executionDrained:true});terminal=true;
    event({phase,...fatalFailure(fatal)});throw new CapacityFailure('CAPACITY_RUN_FAILED');
  }finally{if(heartbeat)clearInterval(heartbeat);for(const transport of transports)transport.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const result=await runCapacity(privateJson(resolve(process.argv[2])));if(!result.executionPassed)process.exitCode=1;}
  catch{process.stderr.write('CAPACITY_RUN_FAILED; inspect the non-secret durable progress, never print native HTTP errors.\n');process.exitCode=1;}
}
