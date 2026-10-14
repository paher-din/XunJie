import type {SubmitRun,RunFact} from '../contracts/runner/index.ts';
import type {RunnerTransport} from '../server/records/runner.ts';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {BoardProfile,HdlCommand,HdlBuild,HdlSession,HdlOperationResult} from '../contracts/runner/hdl.ts';
import {sha256} from '../runner/snapshot.ts';
import {createDigitalLogicApplicationDatabase} from '../server/db/transaction.ts';
import {createPasswordRecord} from '../server/access/password.ts';
import {createDigitalLogicApplication,type DigitalLogicApplicationOptions} from '../server/app/digital-logic.ts';
import {storePolicy,storeRule} from '../server/design/activities.ts';
import {definedAluOperations,type HdlConfiguration} from '../contracts/design/hdl.ts';
export const origin='https://synthetic.example';
export const runtime={runtimeProfileVersion:'hdl-test-v1',engineVersion:'iverilog-test',buildImage:'sha256:'+'a'.repeat(64),runtimeImage:'sha256:'+'b'.repeat(64),sourceHash:'c'.repeat(64)};
export const profile={runtimeProfileVersion:'runtime-v1',imageDigest:'sha256:'+'a'.repeat(64),compilerImage:'sha256:'+'b'.repeat(64),runtimeImage:'sha256:'+'c'.repeat(64),approvedResultFiles:['report.txt']};
export const board:BoardProfile={boardProfileVersion:'nexys4-ddr-rev-c-v1',mappingVersion:'synthetic-mapping-v1',topModule:'top',bindings:[
  {signal:'clock',offset:0,port:'clk',portOffset:0,width:1},{signal:'switches',offset:0,port:'sw',portOffset:0,width:16},
  {signal:'buttons',offset:0,port:'btn',portOffset:0,width:5},{signal:'leds',offset:0,port:'led',portOffset:0,width:16},
  {signal:'anodes',offset:0,port:'an',portOffset:0,width:8},{signal:'segments',offset:0,port:'seg',portOffset:0,width:7},
  {signal:'dp',offset:0,port:'dp',portOffset:0,width:1}]};
export function syntheticNode(){const builds=new Map<string,HdlBuild>(),sessions=new Map<string,HdlSession>(),outputs=new Map<string,HdlOperationResult>();
  let lost=false,calls=0,ready=true;let stopWait:(()=>Promise<void>)|undefined;
  const transport=async(command:HdlCommand)=>{calls++;
    if(command.op==='hdl_build'){const request=command.request,result:HdlBuild={buildId:request.identity.id,identity:request.identity,snapshotId:request.snapshot.snapshotId,snapshotHash:request.snapshot.hash,
      board:request.board,runtimeProfileVersion:runtime.runtimeProfileVersion,engineVersion:runtime.engineVersion,imageDigest:runtime.buildImage,configurationHash:sha256(JSON.stringify(request.board)),
      status:'succeeded',terminationConfirmed:true,artifactHash:'d'.repeat(64),diagnostics:[],stdout:'',stderr:''};builds.set(result.buildId,result);return {data:result};}
    if(command.op==='hdl_program'){const build=builds.get(command.request.buildId)!,at=new Date().toISOString(),state:HdlSession={sessionId:command.request.identity.id,identity:command.request.identity,
      buildId:build.buildId,snapshotId:build.snapshotId,snapshotHash:build.snapshotHash,boardProfileVersion:board.boardProfileVersion,mappingVersion:board.mappingVersion,
      engineVersion:runtime.engineVersion,runtimeProfileVersion:runtime.runtimeProfileVersion,sessionRevision:1,confirmedSequence:0,simTimePs:'0',status:'active',terminationConfirmed:false,stopRequested:false,
      createdAt:at,lastOperationAt:at,deadline:new Date(Date.now()+1800000).toISOString()};sessions.set(state.sessionId,state);
      const frame={simTimePs:'0',switches:'0'.repeat(16),buttons:'00000',resetN:'1',leds:'0'.repeat(16),anodes:'11111110',segments:'0'.repeat(7),dp:'0'};
      const body={operationId:state.sessionId,sessionId:state.sessionId,buildId:build.buildId,snapshotId:build.snapshotId,snapshotHash:build.snapshotHash,
        boardProfileVersion:board.boardProfileVersion,mappingVersion:board.mappingVersion,engineVersion:runtime.engineVersion,sequence:0,sessionRevision:1,
        frames:[frame],finalFrame:frame,sampleCount:1,droppedFrames:0,coverage:'complete' as const};outputs.set(state.sessionId,{...body,resultHash:sha256(JSON.stringify(body))});return {data:state};}
    if(command.op==='hdl_interact'){const request=command.request,state=sessions.get(request.sessionId)!,time=(BigInt(state.simTimePs)+BigInt(request.advanceCycles)*10000n).toString();
      const frame={simTimePs:time,...request.inputs,leds:'0'.repeat(16),anodes:'11111110',segments:'x0z1010',dp:'0'};
      const body={operationId:request.identity.id,sessionId:state.sessionId,buildId:state.buildId,snapshotId:state.snapshotId,snapshotHash:state.snapshotHash,boardProfileVersion:board.boardProfileVersion,
        mappingVersion:board.mappingVersion,engineVersion:runtime.engineVersion,sequence:request.expectedSequence,sessionRevision:request.expectedSessionRevision+1,
        frames:[frame],finalFrame:frame,sampleCount:request.advanceCycles,droppedFrames:0,coverage:'complete' as const};const result={...body,resultHash:sha256(JSON.stringify(body))};
      outputs.set(result.operationId,result);sessions.set(state.sessionId,{...state,sessionRevision:result.sessionRevision,confirmedSequence:result.sequence,simTimePs:time});
      if(lost){lost=false;throw new Error('Synthetic transport lost after the real side effect');}return {data:result};}
    if(command.op==='hdl_query')return {data:sessions.get(command.identity.id)??builds.get(command.identity.id)??null};
    if(command.op==='hdl_result')return {data:outputs.get(command.operationId)??null};
    if(command.op==='hdl_stop'){await stopWait?.();const state=sessions.get(command.identity.id)!;const stopped={...state,sessionRevision:state.sessionRevision+1,status:'stopped' as const,terminationConfirmed:true,stopRequested:true};sessions.set(state.sessionId,stopped);return {data:stopped};}
    const fingerprint={profile:runtime,sourceHash:runtime.sourceHash};const fingerprintHash=sha256(JSON.stringify(fingerprint));return {data:{ready,profile:runtime,recoveryGeneration:'generation',fingerprint,fingerprintHash,validation:{passed:true,fingerprintHash,validatedAt:new Date().toISOString()}}};
  };return {transport,loseNext(){lost=true;},calls:()=>calls,unavailable(){ready=false;},available(){ready=true;},waitForStop(callback:()=>Promise<void>){stopWait=callback;}};
}
export function configuration(versionId='fixed-hdl-v1'):HdlConfiguration{return {versionId,board:structuredClone(board),runtime,signals:{bitOrder:'msb_first',clockHz:100000000,initialClock:'0',initialSwitches:'0000000000000000',initialButtons:'00000',initialResetN:'1',stableSampling:'low_phase',anodesActive:'low',segmentsActive:'low',dpActive:'low'},alu:{operandWidth:4,resultWidth:4,carryWidth:1,signedness:'unsigned',operations:definedAluOperations.map(op=>({...op})),subtractionOperandDomain:'a_gt_b',undefinedArithmeticSelectors:'ungraded',subtractionOutsideDomain:'ungraded',nonAdditionCout:'ungraded',switchMapping:[{semantic:'operand_a',offset:0,width:4},{semantic:'operand_b',offset:4,width:4},{semantic:'mode',offset:15,width:1},{semantic:'select',offset:13,width:2},{semantic:'carry_in',offset:8,width:1}]},structuralCoverage:'board_bindings_and_defined_alu_domain'};}
function controlledRunner() {
  const accepted = new Map<string,SubmitRun>(), facts = new Map<string,RunFact>();
  const results = new Map<string,object>(); let submits = 0, queries = 0, lose = false, loseQuery = false;
  const transport: RunnerTransport = async command => {
    if (command.op === 'readiness') {
      const fingerprint = { profile: profile,sourceHash: 'd'.repeat(64) };
      return { data: { ready: true,...profile,recoveryGeneration: 'generation',fingerprint,
        validation: { passed: true,fingerprintHash: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),validatedAt: new Date().toISOString() } } };
    }
    const id = command.op === 'submit' ? command.submission.identity.runId : command.identity.runId;
    if (command.op === 'submit') {
      submits++; accepted.set(id,command.submission); facts.set(id,{ identity: command.submission.identity,state: 'running',reserved: true,stopRequested: false,units: ['synthetic-unit'],pending: [] });
      if (lose) { lose = false; throw new Error('Synthetic link lost after node acceptance.'); }
    }
    if (command.op === 'query') { queries++; if (loseQuery) { loseQuery = false; throw new Error('Synthetic query lost.'); } }
    if (command.op === 'cancel') {
      const old = facts.get(id);
      facts.set(id,old?.resultRef ? { ...old,stopRequested: true } : { identity: command.identity,state: 'cancelled',reserved: false,stopRequested: true,units: [],pending: [] });
    }
    return { data: command.op === 'readResult' ? results.get(id) : facts.get(id) ?? null };
  };
  return { transport,loseNext() { lose = true; },loseNextQuery() { loseQuery = true; },counts: () => ({ submits,queries }),
    finish(id: string) {
      const submission = accepted.get(id)!;
      const record = { ...submission.identity,unitTerminated: true,phases: [{ stdout: submission.mode === 'check' ? 'PRIVATE_CHECK_OUTPUT' : 'old snapshot',stderr: '' }],
        ...(submission.mode === 'check' ? { verdict: 'failed',checkResults: [{ expected: 'PRIVATE_CHECK_OUTPUT' }] } : {}) };
      results.set(id,record); facts.set(id,{ ...facts.get(id)!,state: 'succeeded',reserved: false,resultRef: 'synthetic-result-'+id,resultHash: sha256(JSON.stringify(record)) });
    } };
}
export async function fixture(onHdlCommand?:(command:HdlCommand)=>Promise<void>,tutoring:Partial<Pick<DigitalLogicApplicationOptions,'studentHelp'|'tutoringProvider'>>={}){const db=createDigitalLogicApplicationDatabase(),node=syntheticNode(),password=randomBytes(32).toString('base64url'),record=await createPasswordRecord(password),signingSecret=randomBytes(48).toString('hex');
 db.withTransaction(tx=>{for(const user of ['teacher','student','other','foreign'])tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES (?,?,?,?,?,?,?,?,?)',user,user,record.hash,record.salt,'scrypt',131072,8,1,64);
 for(const course of ['course','logic-course']){tx.run('INSERT INTO courses(id) VALUES (?)',course);for(const [user,role] of [['teacher','teacher'],['student','student'],['other','student']])tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,1)',course,user!,role!);
 const actor={userId:'teacher',courseId:course,role:'teacher' as const};storePolicy(tx,actor,{versionId:course+'-help',helpAllowed:true,wholeSolutionAllowed:false,limitedCheckHelpAllowed:false,description:'Synthetic policy'},Date.now());storeRule(tx,actor,{versionId:'textscope-core-v1',validatorVersion:'textscope-validator-v2',limitedHelp:true,description:'Synthetic checks'},Date.now());}
 tx.run('INSERT INTO application_control(singleton,recovery_generation,control_revision,initialized_at_ms) VALUES (1,?,1,?)','generation',Date.now());
 });
 const cNode=controlledRunner(),runner=cNode.transport;
 const settings={db,origin,signingSecret,runner,hdlTransport:async(packet:HdlCommand)=>{await onHdlCommand?.(packet);return node.transport(packet);},approvedHdlRuntimes:[runtime],studentHelp:{versions:{modelConfig:'unconfigured',prompt:'unconfigured',schema:'unconfigured',policy:'unconfigured'},budgetAvailable:()=>false}};
 const host=await createDigitalLogicApplication({...settings,...tutoring});
 const login=async(user='student')=>{const response=await host.app.inject({method:'POST',url:'/api/sessions',headers:{origin},payload:{loginName:user,password}});assert.equal(response.statusCode,200,response.body);return {origin,cookie:response.cookies.filter(c=>c.value).map(c=>`${c.name}=${encodeURIComponent(c.value)}`).join('; '),'x-csrf-token':String(response.json().data.csrfToken)};};
 return {db,node,cNode,host,app:host.app,settings,login,async close(){await host.shutdown();db.close();}};
}
export type Fixture=Awaited<ReturnType<typeof fixture>>;
export type Headers=Awaited<ReturnType<Fixture['login']>>;
export function command(f:Fixture,headers:Headers,url:string,payload:object,key:string=randomUUID()){return f.app.inject({method:'POST',url,headers:{...headers,'idempotency-key':key},payload:{recoveryGeneration:'generation',...payload}});}
export async function view(f:Fixture,headers:Headers,attemptId:string){const res=await f.app.inject({url:`/api/attempts/${attemptId}`,headers});assert.equal(res.statusCode,200,res.body);return res.json().data;}
export async function allocate(f:Fixture,teacher:Headers,student:Headers,hdl=true){const course=hdl?'logic-course':'course';
 if(hdl){const c=await command(f,teacher,`/api/courses/${course}/hdl-configurations`,{configuration:configuration()});assert.equal(c.statusCode,200,c.body);}
 const goals=[{competencyId:'k',competencyVersion:1,domain:'domain',title:'Explain circuit'},{competencyId:'p',competencyVersion:1,domain:'project',title:'Compare routes'},{competencyId:'a',competencyVersion:1,domain:'ai_collaboration',title:'Check AI'}],refs=goals.map(({competencyId,competencyVersion})=>({competencyId,competencyVersion}));
 const material=await command(f,teacher,`/api/courses/${course}/resources`,{teacherDesignAllowed:true,material:{format:'txt',title:'PRIVATE_TITLE',content:'PRIVATE_BODY',kind:'private_answer',visibility:{student:false,tutor:false}}});assert.equal(material.statusCode,200,material.body);
 const draft=await command(f,teacher,`/api/courses/${course}/blueprints`,{mode:'manual',content:{projectTitle:hdl?'ALU':'TextScope',problem:'Explore',audience:'Peers',artifact:hdl?'HDL source':'C source',routes:['first','second'],goals,tasks:[{taskId:'t',title:'Compare',goalRefs:refs}],observations:[{observationId:'o',description:'Explain',goalRefs:refs,taskIds:['t']}],rubricCriteria:[{criterionId:'r',description:'Reason',goalRefs:refs,observationIds:['o']}],milestones:[{milestoneId:'m',title:'Review',taskIds:['t']}],resources:[{resourceVersionId:material.json().data.result.resourceVersion.resourceVersionId}],helpPolicyVersionId:course+'-help',checkRuleVersionId:hdl?'hdl-board-structure-v1':'textscope-core-v1',runtimeProfileVersionId:hdl?runtime.runtimeProfileVersion:profile.runtimeProfileVersion,...(hdl?{digitalLogicConfigVersionId:'fixed-hdl-v1'}:{})}});assert.equal(draft.statusCode,200,draft.body);
 const blueprintId=String(draft.json().data.result.draft.blueprintId),checks=await command(f,teacher,`/api/blueprints/${blueprintId}/checks`,{expectedRevision:1});assert.equal(checks.statusCode,200,checks.body);assert.equal(checks.json().data.result.report.blocking.length,0,checks.body);
 const release=await command(f,teacher,`/api/blueprints/${blueprintId}/releases`,{expectedRevision:1,confirmed:true});assert.equal(release.statusCode,200,release.body);const activityId=String(release.json().data.result.activityVersionId);
 const assignment=await command(f,teacher,`/api/activities/${activityId}/assignments`,{expectedActivityControlRevision:1,studentIds:['student']});assert.equal(assignment.statusCode,200,assignment.body);const assignmentId=String(assignment.json().data.result.assignments[0].assignmentId);
 const attempt=await command(f,student,`/api/assignments/${assignmentId}/attempts`,{});assert.equal(attempt.statusCode,200,attempt.body);const attemptId=String(attempt.json().data.result.attemptId);
 const sync=await command(f,student,`/api/attempts/${attemptId}/sync`,{expectedWorkspaceRevision:0,clientId:'page',clientSeq:1,operations:[{kind:'create',clientFileKey:'source',path:hdl?'top.sv':'main.c',text:hdl?'module top; endmodule':'int main(void){return 0;}'}]});assert.equal(sync.statusCode,200,sync.body);
 const state=await view(f,student,attemptId),snapshot=await command(f,student,`/api/attempts/${attemptId}/snapshots`,{expectedWorkspaceRevision:state.attempt.workspaceRevision});assert.equal(snapshot.statusCode,200,snapshot.body);
 return {blueprintId,activityId,assignmentId,attemptId,snapshotId:String(snapshot.json().data.result.snapshotId),checks:checks.json().data.result.report};
}
export async function programmed(f:Fixture,student:Headers,item:Awaited<ReturnType<typeof allocate>>){const state=await view(f,student,item.attemptId),build=await command(f,student,`/api/attempts/${item.attemptId}/hdl/builds`,{expectedAttemptRevision:state.attempt.attemptRevision,snapshotId:item.snapshotId});assert.equal(build.statusCode,200,build.body);await f.host.consumeOnce();
 const current=await view(f,student,item.attemptId),program=await command(f,student,`/api/attempts/${item.attemptId}/hdl/programs`,{expectedAttemptRevision:current.attempt.attemptRevision,buildId:build.json().data.result.buildId});assert.equal(program.statusCode,200,program.body);await f.host.consumeOnce();return {build:build.json().data.result,program:program.json().data.result};}
