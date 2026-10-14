/** Explicit isolated service verification; never imported by the normal startup. */
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fixture,assigned,command,view,snapshot,submit,markReviewed,origin } from '../workspace/test-support.ts';
import type { Headers } from '../workspace/test-support.ts';
import { createPasswordRecord } from '../access/password.ts';
import { createI0App } from './i0.ts';
import type { ModelProvider } from '../tutoring/providers.ts';
import { createBrowserRunner,browserRunnerOutcomes } from './i0-browser-runner.ts';

const protocol=createInterface({input:process.stdin}),lines=protocol[Symbol.asyncIterator]();
const configuration=z.strictObject({synthetic:z.literal(true),port:z.number().int().min(1).max(65535),password:z.string().min(16).max(128),runs:z.boolean().default(false)});
const reference=z.string().min(1).max(128);
const requestId=z.uuid();
const controlInput=z.union([
  z.strictObject({requestId,kind:z.literal('generation'),value:z.string().max(128)}),
  z.strictObject({requestId,kind:z.literal('reopen')}),
  z.strictObject({requestId,kind:z.literal('state'),attemptId:reference,state:z.enum(['paused','active','submitted','reviewed'])}),
  z.strictObject({requestId,kind:z.literal('inspect'),attemptId:reference.optional()}),
  z.strictObject({requestId,kind:z.literal('clock-regress'),milliseconds:z.number().int().min(1).max(60000)}),
  z.strictObject({requestId,kind:z.literal('runner'),action:z.literal('configure'),ready:z.boolean().optional(),
    outcome:z.enum(browserRunnerOutcomes).optional(),stopConfirmed:z.boolean().optional(),link:z.enum(['online','offline']).optional()}),
  z.strictObject({requestId,kind:z.literal('runner'),action:z.literal('finish'),runId:reference,
    outcome:z.enum(browserRunnerOutcomes).exclude(['running','unknown']).default('success')}),
  z.strictObject({requestId,kind:z.literal('runner'),action:z.literal('confirm-stop'),runId:reference}),
  z.strictObject({requestId,kind:z.literal('runner'),action:z.literal('inspect'),runId:reference.optional()}),
  z.strictObject({requestId,kind:z.literal('history'),attemptId:reference,
    outcome:z.enum(['report-complete','report-missing','report-incomplete','files-unavailable','check'])}),
]);
let close:(()=>Promise<void>)|undefined,certDirectory:string|undefined;
try {
  if(process.versions.node!=='24.21.0') throw new Error('Approved teaching runtime required');
  const first=await lines.next();
  if(first.done||first.value.length>1024) throw new Error('Synthetic IPC input required');
  const input=configuration.parse(JSON.parse(first.value));
  // Private synthetic fault: observe behavior when the host's wall clock retreats.
  const originalWallClock=Date.now;
  let wallOffset=0;
  Date.now=()=>originalWallClock()-wallOffset;
  let generation='generation';
  const runner=input.runs?createBrowserRunner(()=>generation):undefined;
  const f=await fixture(runner?.transport,{teaching:true});
  close=()=>f.close();
  const teacher=await f.login('teacher'),allocation=await assigned(f,teacher);
  const other=await command(f,teacher,`/api/activities/${allocation.activityId}/assignments`,{
    expectedActivityControlRevision:1,studentIds:['other']});
  if(other.statusCode!==200)throw new Error('Synthetic second allocation unavailable');
  const otherAssignmentId=String(other.json().data.result.assignments[0].assignmentId);
  const password=await createPasswordRecord(input.password);
  f.db.withTransaction(tx=>tx.run("UPDATE users SET password_hash=?,salt=? WHERE id IN ('student','other')",password.hash,password.salt));
  certDirectory=mkdtempSync(join(tmpdir(),'xunjie-i0-browser-tls-'));
  const keyFile=join(certDirectory,'key.pem'),certFile=join(certDirectory,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,
    '-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-days','1'],{stdio:'ignore'});
  const base=`https://127.0.0.1:${input.port}`;
  const provider:ModelProvider={generate:async request=> {
    const refs=request.untrustedInput as {references:Array<{id:string}>};
    return {body:{kind:'student_help',actionType:'hint',content:'隔离合成服务验证：先写出一个边界输入，再自行检查。',
      rationale:'保留学生选择与验证。',expectedStudentAction:'请自行试验边界条件。',
      evidenceIds:[refs.references[0]!.id],resourceRefs:[],assistanceContext:'这是离线合成服务验证，未调用实际模型。',unresolved:[],
      policyChecks:{containsWholeSolution:false,writesStudentWork:false,runsCode:false,makesFormalEvaluation:false}}};
  }};
  generation=f.generation();
  // One synthetic clock for all composed services. WSL wall-clock resync must not
  // make a just-created Session appear to come from the future during these tests.
  const clockEpoch=Math.max(f.timestamp(),originalWallClock()),clockStart=performance.now();
  const currentTime=()=>clockEpoch+Math.floor(performance.now()-clockStart);
  const requests={businessWrites:0,activityReads:0};
  const https={key:readFileSync(keyFile),cert:readFileSync(certFile)};
  async function compose() {
    const service=await createI0App({db:f.db,origin:base,signingSecret:f.signingSecret,currentGeneration:()=>generation,now:currentTime,
      https,staticDirectory:resolve('../student/dist'),consumerIntervalMs:50,
      ...(runner?{runner:runner.transport}:{}),
      tutoring:{studentHelp:{versions:{modelConfig:'deepseek-flash-v1',prompt:'student-help-v1',schema:'student-help-v1',policy:'help-v1'},
        budgetAvailable:()=>true},provider}});
    // Observation only: no fixture HTTP route, body rewriting, authorization bypass or normal-app change.
    service.app.addHook('onRequest',async request=>{
      const path=request.url.split('?')[0]!;
      if(request.method==='GET'&&/^\/api\/activities\/[^/]+$/.test(path))requests.activityReads++;
      if(!['GET','HEAD','OPTIONS'].includes(request.method)&&path.startsWith('/api/')
        &&!['/api/sessions','/api/logout'].includes(path))requests.businessWrites++;
    });
    try {await service.app.listen({host:'127.0.0.1',port:input.port});service.startConsumer();}
    catch(error){await service.close();throw error;}
    return service;
  }
  let service=await compose();
  close=async()=>{await service.close();await f.close();};
  const studentHeaders=new Map<string,Headers>();
  let controlStage='input';
  async function ownerHeaders(attemptId:string) {
    // The original factory has a controlled clock. Actual HTTPS logins already
    // advanced the shared rate-limit windows; private setup must not go backwards.
    f.advance(Math.max(0,currentTime()-f.timestamp()));
    controlStage='owner-query';
    const owner=f.db.withTransaction(tx=>tx.get('SELECT student_id FROM attempts WHERE attempt_id=?',attemptId));
    if(!owner||!['student','other'].includes(String(owner.student_id)))throw new Error('Synthetic attempt required');
    const user=String(owner.student_id),previous=studentHeaders.get(user);
    if(previous)return previous;
    controlStage='owner-session';
    const response=await f.app.inject({method:'POST',url:'/api/sessions',headers:{origin},payload:{loginName:user,password:input.password}});
    if(response.statusCode!==200)throw new Error('Synthetic session unavailable');
    const headers={origin,cookie:response.cookies.filter(c=>c.value).map(c=>`${c.name}=${encodeURIComponent(c.value)}`).join('; '),
      'x-csrf-token':String(response.json().data.csrfToken)};
    studentHeaders.set(user,headers);return headers;
  }
  async function setState(attemptId:string,target:'paused'|'active'|'submitted'|'reviewed') {
    const student=await ownerHeaders(attemptId);
    let head=await view(f,student,attemptId);
    const invoke=async(kind:'start'|'pause'|'resume')=>{
      const response=await command(f,student,`/api/attempts/${attemptId}/controls`,{
        expectedAttemptRevision:head.attempt.attemptRevision,control:{kind}});
      if(response.statusCode!==200)throw new Error('Synthetic state transition refused');
      head=await view(f,student,attemptId);
    };
    if(head.attempt.status!==target) {
      if(['paused','active'].includes(target)) {
        if(head.attempt.status==='ready')await invoke('start');
        if(target==='paused'&&head.attempt.status==='active')await invoke('pause');
        if(target==='active'&&head.attempt.status==='paused')await invoke('resume');
      } else {
        if(head.attempt.status==='paused')await invoke('resume');
        if(['ready','active'].includes(head.attempt.status)) {
          const snapshotId=await snapshot(f,student,attemptId);
          head=await view(f,student,attemptId);
          const response=await submit(f,student,attemptId,{expectedAttemptRevision:head.attempt.attemptRevision,snapshotId});
          if(response.statusCode!==200)throw new Error('Synthetic submission refused');
          head=await view(f,student,attemptId);
        }
        if(target==='reviewed'&&head.attempt.status==='submitted') {
          const response=await markReviewed(f,teacher,attemptId,head.attempt.attemptRevision);
          if(response.statusCode!==200)throw new Error('Synthetic review refused');
          head=await view(f,student,attemptId);
        }
      }
    }
    if(head.attempt.status!==target)throw new Error('Synthetic state transition refused');
    const {status,attemptRevision,workspaceRevision}=head.attempt;
    return {attemptId,status,attemptRevision,workspaceRevision};
  }
  async function inspect(attemptId?:string) {
    controlStage='inspect-counts';
    const counts=f.db.withTransaction(tx=>{
      const total=(table:string)=>Number(tx.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
      const database={attempts:total('attempts'),files:total('workspace_files'),snapshots:total('artifact_snapshots'),
        submissions:total('workspace_submissions'),receipts:total('command_receipts')};
      if(!attemptId)return {database};
      const count=(table:string)=>Number(tx.get(`SELECT COUNT(*) AS n FROM ${table} WHERE attempt_id=?`,attemptId)!.n);
      return {database,attemptCounts:{files:count('workspace_files'),snapshots:count('artifact_snapshots'),submissions:count('workspace_submissions'),
        receipts:Number(tx.get("SELECT COUNT(*) AS n FROM command_receipts WHERE json_extract(result_json,'$.identity.scope.attemptId')=? OR json_extract(result_json,'$.result.attemptId')=?",attemptId,attemptId)!.n)}};
    });
    if(!attemptId)return {requests:{...requests},...counts};
    const headers=await ownerHeaders(attemptId);
    controlStage='inspect-attempt';
    return {requests:{...requests},...counts,attempt:await view(f,headers,attemptId)};
  }
  async function history(attemptId:string,outcome:'report-complete'|'report-missing'|'report-incomplete'|'files-unavailable'|'check') {
    if(!runner)throw new Error('Synthetic runner not enabled');
    controlStage='history-source';
    const headers={...await ownerHeaders(attemptId),origin:base};
    const headResponse=await service.app.inject({url:`/api/attempts/${attemptId}`,headers});
    if(headResponse.statusCode!==200)throw new Error('Synthetic history source unavailable');
    const head=headResponse.json().data as Awaited<ReturnType<typeof view>>;
    const fixed=[...head.snapshots].sort((a:{workspaceRevision:number},b:{workspaceRevision:number})=>b.workspaceRevision-a.workspaceRevision)[0];
    if(!fixed)throw new Error('Synthetic confirmed snapshot required');
    const frozenResponse=await service.app.inject({url:`/api/attempts/${attemptId}/snapshots/${fixed.snapshotId}`,headers});
    if(frozenResponse.statusCode!==200)throw new Error('Synthetic confirmed snapshot unavailable');
    const frozen=frozenResponse.json().data as {files:Array<{fileId:string;path:string;text:string}>};
    const source=frozen.files.find(file=>file.path.endsWith('.c'));
    const text=frozen.files.find(file=>!file.path.endsWith('.c')&&/^[\x00-\x7f]*$/.test(file.text));
    if(!source||!text)throw new Error('Synthetic confirmed C source and ASCII input required');
    const prior=runner.inspect().configuration;
    runner.configure({ready:true,link:'online',outcome:outcome==='files-unavailable'?'infrastructure-error':outcome==='check'?'success':outcome});
    try {
      controlStage='history-create';
      const response=await service.app.inject({method:'POST',url:`/api/attempts/${attemptId}/runs`,
        headers:{...headers,'idempotency-key':randomUUID()},payload:{recoveryGeneration:generation,
          expectedAttemptRevision:head.attempt.attemptRevision,snapshotId:fixed.snapshotId,runtimeProfileVersion:f.profile.runtimeProfileVersion,
          entryFileId:source.fileId,input:outcome==='check'?{operation:'stats',fileIds:[text.fileId]}:
            {operation:'report',fileIds:[text.fileId],resultFile:'report.txt'},mode:outcome==='check'?'course_check':'run'}});
      if(response.statusCode!==200)throw new Error('Synthetic public history request refused');
      const {jobId,runId,snapshotId}=response.json().data.result as {jobId:string;runId:string;snapshotId:string};
      controlStage='history-consumer';
      const deadline=performance.now()+15_000;
      while(performance.now()<deadline) {
        const read=await service.app.inject({url:`/api/jobs/${jobId}`,headers});
        if(read.statusCode!==200)throw new Error('Synthetic original history unreadable');
        const status=String(read.json().data.status);
        if(['succeeded','failed'].includes(status))return {jobId,runId,snapshotId,status};
        await new Promise(accept=>setTimeout(accept,25));
      }
      throw new Error('Synthetic original consumer not settled');
    } finally {runner.configure(prior);}
  }
  async function waitRunnerFact(runId:string,stopped=false) {
    if(!runner)throw new Error('Synthetic runner not enabled');
    const deadline=performance.now()+5_000;
    while(performance.now()<deadline) {
      const fact=runner.inspect(runId).runs[0]?.fact;
      // HTTP acceptance/stop intent precedes the original consumer's transport operation.
      // Never manufacture that operation just to make a private control succeed.
      if(fact&&(!stopped||fact.stopRequested))return;
      await new Promise(accept=>setTimeout(accept,20));
    }
    throw new Error('Synthetic original runner fact not observed');
  }
  // Public references only. Synthetic passwords are private IPC input, never output.
  process.stdout.write(JSON.stringify({synthetic:true,base,assignmentId:allocation.assignmentId,otherAssignmentId})+'\n');
  for await(const line of lines) {
    if(line==='stop')break;
    let id='invalid-request';
    try {
      if(line.length>2048)throw new Error('Bounded synthetic IPC required');
      const raw:unknown=JSON.parse(line);
      if(raw&&typeof raw==='object'&&'requestId' in raw&&requestId.safeParse(raw.requestId).success)id=String(raw.requestId);
      controlStage='input';
      const control=controlInput.parse(raw);
      let data:unknown;
      switch(control.kind) {
        case 'generation':generation=control.value;data={recoveryGeneration:generation};break;
        case 'reopen':
          // Close the actual listener/consumer before reopening the same original SQLite file.
          await service.close();await f.reopen();service=await compose();
          data={reopened:true,recoveryGeneration:generation};break;
        case 'state':data=await setState(control.attemptId,control.state);break;
        case 'inspect':data=await inspect(control.attemptId);break;
        case 'clock-regress':wallOffset+=control.milliseconds;data={regressed:true};break;
        case 'runner':
          if(!runner)throw new Error('Synthetic runner not enabled');
          controlStage='runner-control';
          switch(control.action) {
            case 'configure': {
              data=runner.configure({...(control.ready===undefined?{}:{ready:control.ready}),
                ...(control.outcome===undefined?{}:{outcome:control.outcome}),
                ...(control.stopConfirmed===undefined?{}:{stopConfirmed:control.stopConfirmed}),
                ...(control.link===undefined?{}:{link:control.link})});break;
            }
            case 'finish':await waitRunnerFact(control.runId);data=runner.finish(control.runId,control.outcome);break;
            case 'confirm-stop':await waitRunnerFact(control.runId,true);data=runner.confirmStop(control.runId);break;
            case 'inspect':data=runner.inspect(control.runId);break;
          }
          break;
        case 'history':data=await history(control.attemptId,control.outcome);break;
      }
      process.stdout.write(JSON.stringify({requestId:control.requestId,ok:true,data})+'\n');
    } catch {
      // No raw exception, session headers, configuration, password or token crosses public stdout.
      process.stdout.write(JSON.stringify({requestId:id,ok:false,error:'IPC_CONTROL_FAILED',stage:controlStage})+'\n');
    }
  }
} catch {
  process.stderr.write('Isolated I0 browser service failed.\n');process.exitCode=1;
} finally {
  try {await close?.();}catch {process.stderr.write('Isolated I0 browser shutdown failed.\n');process.exitCode=1;}
  protocol.close();
  if(certDirectory&&resolve(certDirectory).startsWith(join(resolve(tmpdir()),'xunjie-i0-browser-tls-')))
    rmSync(certDirectory,{recursive:true});
  // The original factory database is retained independently for audit; never deleted.
}
