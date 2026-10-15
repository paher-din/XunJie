import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import '../server/app/digital-logic.test.ts';
import {fixture,allocate,command,view,programmed,configuration} from './dl-a-support.ts';
test('normal two-course host freezes HDL config, hides private materials and rejects TextScope execution on HDL',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login();const c=await allocate(f,teacher,student,false),hdl=await allocate(f,teacher,student);
 const courses=await f.app.inject({url:'/api/courses',headers:student});assert.deepEqual(courses.json().data.map((item:{courseId:string})=>item.courseId),['course','logic-course']);
 for(const item of [c,hdl]){const a=await f.app.inject({url:`/api/activities/${item.activityId}`,headers:student});assert.equal(a.statusCode,200,a.body);assert(!a.body.includes('PRIVATE_BODY'));assert(!a.body.includes('PRIVATE_TITLE'));}
 assert.deepEqual(hdl.checks.execution,{kind:'hdl_board',structural:'validated',behavior:'unverified'});
 const activity=await f.app.inject({url:`/api/activities/${hdl.activityId}`,headers:student});assert.deepEqual(activity.json().data.execution.configuration,configuration());
 assert.equal((await command(f,student,`/api/attempts/${hdl.attemptId}/runs`,{expectedAttemptRevision:(await view(f,student,hdl.attemptId)).attempt.attemptRevision,snapshotId:hdl.snapshotId,mode:'run',input:{operation:'stats',fileIds:[]}})).statusCode,400);
 const assignments=await f.app.inject({url:'/api/courses/logic-course/assignments',headers:student});assert.equal(assignments.json().data[0].executionKind,'hdl_board');
 }finally{await f.close();}
});

test('original consumer builds/programs exact snapshots; pending Trace cursor and read authority survive replay',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login(),other=await f.login('other'),item=await allocate(f,teacher,student);
 const input={expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,snapshotId:item.snapshotId},b=await command(f,student,`/api/attempts/${item.attemptId}/hdl/builds`,input,'build');assert.equal(b.statusCode,200,b.body);await f.host.consumeOnce();const build=b.json().data.result;
 const state=await view(f,student,item.attemptId),pInput={expectedAttemptRevision:state.attempt.attemptRevision,buildId:build.buildId},p=await command(f,student,`/api/attempts/${item.attemptId}/hdl/programs`,pInput,'program');assert.equal(p.statusCode,200,p.body);const program=p.json().data.result;
 const before=await f.app.inject({url:`/api/hdl/sessions/${program.sessionId}/trace?afterSequence=-1`,headers:student});assert.equal(before.json().data.nextSequence,-1);assert.equal(before.json().data.operation.result,null);
 await f.host.consumeOnce();const trace=await f.app.inject({url:`/api/hdl/sessions/${program.sessionId}/trace?afterSequence=-1`,headers:student});assert.equal(trace.json().data.operation.result.snapshotId,item.snapshotId);assert.equal(trace.json().data.nextSequence,0);
 for(const target of [`/api/hdl/builds/${build.buildId}`,`/api/hdl/sessions/${program.sessionId}`,`/api/hdl/sessions/${program.sessionId}/trace`]){assert.equal((await f.app.inject({url:target,headers:other})).statusCode,403);assert.equal((await f.app.inject({url:target,headers:teacher})).statusCode,200);}
 f.node.unavailable();const paused=await command(f,teacher,`/api/assignments/${item.assignmentId}/controls`,{expectedAssignmentRevision:1,action:'pause',reason:'Review'});assert.equal(paused.statusCode,200,paused.body);
 for(const [path,key,commandInput] of [['builds','build',input],['programs','program',pInput]] as const){const replay=await command(f,student,`/api/attempts/${item.attemptId}/hdl/${path}`,commandInput,key);assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json().data.result,path==='builds'?build:program);}
 assert.equal((await command(f,student,`/api/attempts/${item.attemptId}/hdl/builds`,{...input,snapshotId:'different'},'build')).statusCode,409);
 const ended=await f.app.inject({url:`/api/hdl/sessions/${program.sessionId}`,headers:student});assert(ended.json().data.stopRequested&&ended.json().data.terminationConfirmed);
 }finally{await f.close();}
});
test('fixed configuration rejects unknown runtime, client role, overlap and changed body; same body replays',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login(),payload={configuration:configuration()};
 assert.equal((await command(f,student,'/api/courses/logic-course/hdl-configurations',payload)).statusCode,403);
 assert.equal((await command(f,teacher,'/api/courses/logic-course/hdl-configurations',{...payload,role:'teacher'})).statusCode,400);
 assert.equal((await command(f,teacher,'/api/courses/logic-course/hdl-configurations',{configuration:{...configuration(),runtime:{...configuration().runtime,engineVersion:'unapproved'}}})).statusCode,422);
 assert.equal((await command(f,teacher,'/api/courses/logic-course/hdl-configurations',{configuration:{...configuration(),alu:{...configuration().alu,switchMapping:configuration().alu.switchMapping.map(m=>({...m,offset:0}))}}})).statusCode,400);
 const first=await command(f,teacher,'/api/courses/logic-course/hdl-configurations',payload,'config');assert.equal(first.statusCode,200,first.body);
 const replay=await command(f,teacher,'/api/courses/logic-course/hdl-configurations',payload,'config');assert.deepEqual(replay.json().data,first.json().data);
 const changed={configuration:{...configuration(),board:{...configuration().board,topModule:'changed_top'}}};assert.equal((await command(f,teacher,'/api/courses/logic-course/hdl-configurations',changed,'config')).statusCode,409);assert.equal((await command(f,teacher,'/api/courses/logic-course/hdl-configurations',changed,'new-config')).statusCode,409);
 assert.equal((await command(f,teacher,'/api/courses/course/hdl-configurations',payload)).statusCode,403);
 }finally{await f.close();}
});
test('HTTP reprogram denies final acceptance when its real Session logs out during stop wait',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student),p=await programmed(f,student,item);
 let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);f.node.waitForStop(async()=>{entered();await barrier;});
 const request=command(f,student,`/api/attempts/${item.attemptId}/hdl/programs`,{expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,buildId:p.build.buildId,replaceSessionId:p.program.sessionId,expectedSessionRevision:1},'reprogram');
 await waiting;const logout=await f.app.inject({method:'POST',url:'/api/logout',headers:student,payload:{}});assert.equal(logout.statusCode,200,logout.body);release();const result=await request;assert.equal(result.statusCode,401,result.body);
 const ended=await f.app.inject({url:`/api/hdl/sessions/${p.program.sessionId}`,headers:teacher});assert(ended.json().data.terminationConfirmed);
 }finally{await f.close();}
});
test('management withdrawal commits stop with permission state; a real rollback keeps permission and session active',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student),p=await programmed(f,student,item);
 assert.throws(()=>f.db.withTransaction(tx=>{f.host.management.deactivateMembershipInTransaction(tx,'logic-course','student');tx.run('INSERT INTO courses(id) VALUES (?)','course');}));
 let state=await f.app.inject({url:`/api/hdl/sessions/${p.program.sessionId}`,headers:student});assert.equal(state.statusCode,200,state.body);assert.equal(state.json().data.stopRequested,false);
 f.db.withTransaction(tx=>f.host.management.deactivateMembershipInTransaction(tx,'logic-course','student'));
 assert.equal((await f.app.inject({url:`/api/hdl/sessions/${p.program.sessionId}`,headers:student})).statusCode,403);await f.host.consumeOnce();
 state=await f.app.inject({url:`/api/hdl/sessions/${p.program.sessionId}`,headers:teacher});assert(state.json().data.stopRequested&&state.json().data.terminationConfirmed);
 }finally{await f.close();}
});
test('activity pause stops a completed program even without a currently pending Job',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student),p=await programmed(f,student,item);
 const paused=await command(f,teacher,`/api/activities/${item.activityId}/controls`,{expectedActivityControlRevision:1,action:'pause',reason:'Course pause'});assert.equal(paused.statusCode,200,paused.body);
 const state=await f.app.inject({url:`/api/hdl/sessions/${p.program.sessionId}`,headers:student});assert(state.json().data.stopRequested&&state.json().data.terminationConfirmed);
 const assignment=await f.app.inject({url:`/api/assignments/${item.assignmentId}`,headers:student});assert.equal(assignment.json().data.active,false);
 }finally{await f.close();}
});

test('same normal consumer dispatches original C and HDL jobs without a second queue',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login(),c=await allocate(f,teacher,student,false),hdl=await allocate(f,teacher,student);
 const state=await view(f,student,c.attemptId),source=state.files[0];
 const cRun=await command(f,student,`/api/attempts/${c.attemptId}/runs`,{expectedAttemptRevision:state.attempt.attemptRevision,snapshotId:c.snapshotId,runtimeProfileVersion:'runtime-v1',entryFileId:source.fileId,input:{operation:'stats',fileIds:[source.fileId]},mode:'run'});assert.equal(cRun.statusCode,200,cRun.body);const original=cRun.json().data.result;
 const build=await command(f,student,`/api/attempts/${hdl.attemptId}/hdl/builds`,{expectedAttemptRevision:(await view(f,student,hdl.attemptId)).attempt.attemptRevision,snapshotId:hdl.snapshotId});assert.equal(build.statusCode,200,build.body);
 await f.host.consumeOnce();f.cNode.finish(original.runId);await f.host.consumeOnce();
 const run=await f.app.inject({url:`/api/attempts/${c.attemptId}/runs/${original.runId}`,headers:student});assert.equal(run.json().data.diagnostics.status,'available');assert.equal(run.json().data.diagnostics.stdout,'old snapshot');
 const h=await f.app.inject({url:`/api/hdl/builds/${build.json().data.result.buildId}`,headers:student});assert.equal(h.json().data.result.status,'succeeded');assert.equal(f.cNode.counts().submits,1);
 }finally{await f.close();}
});
test('interaction preserves sequence, four-value outputs and immutable source when a new draft is saved',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student),p=await programmed(f,student,item),before=await view(f,student,item.attemptId);
 const input={expectedAttemptRevision:before.attempt.attemptRevision,sessionId:p.program.sessionId,expectedSessionRevision:1,expectedSequence:1,inputs:{switches:'0000000000000001',buttons:'00001',resetN:'1'},advanceCycles:3};
 assert.equal((await command(f,teacher,`/api/attempts/${item.attemptId}/hdl/interactions`,input)).statusCode,403);
 assert.equal((await command(f,student,`/api/attempts/${item.attemptId}/hdl/interactions`,{...input,recoveryGeneration:'old'})).statusCode,409);
 const accepted=await command(f,student,`/api/attempts/${item.attemptId}/hdl/interactions`,input,'step');assert.equal(accepted.statusCode,200,accepted.body);await f.host.consumeOnce();
 const replay=await command(f,student,`/api/attempts/${item.attemptId}/hdl/interactions`,input,'step');assert.deepEqual(replay.json().data.result,accepted.json().data.result);
 assert.equal((await command(f,student,`/api/attempts/${item.attemptId}/hdl/interactions`,{...input,advanceCycles:4},'step')).statusCode,409);
 assert.equal((await command(f,student,`/api/attempts/${item.attemptId}/hdl/interactions`,input,'late-step')).statusCode,409);
 const state=await view(f,student,item.attemptId),file=state.files[0],sync=await command(f,student,`/api/attempts/${item.attemptId}/sync`,{expectedWorkspaceRevision:state.attempt.workspaceRevision,clientId:'page',clientSeq:2,operations:[{kind:'update',fileId:file.fileId,baseVersion:file.documentVersion,text:'module revised; endmodule'}]});assert.equal(sync.statusCode,200,sync.body);
 const trace=await f.app.inject({url:`/api/hdl/sessions/${p.program.sessionId}/trace?afterSequence=0`,headers:student});assert.equal(trace.json().data.operation.result.snapshotId,item.snapshotId);assert.equal(trace.json().data.operation.result.finalFrame.simTimePs,'30000');assert.equal(trace.json().data.operation.result.finalFrame.segments,'x0z1010');
 const build=await f.app.inject({url:`/api/hdl/builds/${p.build.buildId}`,headers:student});assert.equal(build.json().data.request.snapshot.files[0].text,'module top; endmodule');
 const stop=await command(f,student,`/api/attempts/${item.attemptId}/hdl/controls`,{expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,action:'stop',reason:'Explicit stop'});assert.equal(stop.statusCode,200,stop.body);assert.equal(stop.json().data.result.stopRequested,true);
 const ended=await f.app.inject({url:`/api/hdl/sessions/${p.program.sessionId}`,headers:student});assert(ended.json().data.terminationConfirmed);
 }finally{await f.close();}
});
test('personal pause and account disable propagate stop through original C reconciliation',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student),p=await programmed(f,student,item);
 const pause=await command(f,student,`/api/attempts/${item.attemptId}/controls`,{expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,control:{kind:'pause'}});assert.equal(pause.statusCode,200,pause.body);
 const ended=await f.app.inject({url:`/api/hdl/sessions/${p.program.sessionId}`,headers:student});assert(ended.json().data.terminationConfirmed);
 const second=await allocate(f,teacher,student),q=await programmed(f,student,second);f.db.withTransaction(tx=>f.host.management.disableUserInTransaction(tx,'student'));await f.host.consumeOnce();
 assert.equal((await f.app.inject({url:`/api/hdl/sessions/${q.program.sessionId}`,headers:student})).statusCode,401);const disabled=await f.app.inject({url:`/api/hdl/sessions/${q.program.sessionId}`,headers:teacher});assert(disabled.json().data.terminationConfirmed);
 }finally{await f.close();}
});
test('normal scheduled consumer and shutdown retain actual termination facts',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student);
 const build=await command(f,student,`/api/attempts/${item.attemptId}/hdl/builds`,{expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,snapshotId:item.snapshotId});assert.equal(build.statusCode,200,build.body);f.host.startConsumer(50);
 let status='queued';for(let n=0;n<50&&status!=='succeeded';n++){await new Promise(resolve=>setTimeout(resolve,20));status=(await f.app.inject({url:`/api/hdl/builds/${build.json().data.result.buildId}`,headers:student})).json().data.status;}assert.equal(status,'succeeded');
 const p=await command(f,student,`/api/attempts/${item.attemptId}/hdl/programs`,{expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,buildId:build.json().data.result.buildId});assert.equal(p.statusCode,200,p.body);
 for(let n=0;n<50;n++){const state=await f.app.inject({url:`/api/hdl/sessions/${p.json().data.result.sessionId}`,headers:student});if(state.json().data.status==='active')break;await new Promise(resolve=>setTimeout(resolve,20));}
 await f.host.shutdown();assert.equal(f.host.isAccepting(),false);
 // DB is retained; reopen the same application and consume its authenticated read seam.
 const {createDigitalLogicApplication}=await import('../server/app/digital-logic.ts');const reopened=await createDigitalLogicApplication(f.settings);try{const session=await reopened.app.inject({url:`/api/hdl/sessions/${p.json().data.result.sessionId}`,headers:teacher});assert(session.json().data.stopRequested&&session.json().data.terminationConfirmed);}finally{await reopened.shutdown();}
 }finally{await f.close();}
});

test('reprogram rejects membership withdrawal after external wait but still persists original exit',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student),p=await programmed(f,student,item);
 let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);f.node.waitForStop(async()=>{entered();await barrier;});
 const pending=command(f,student,`/api/attempts/${item.attemptId}/hdl/programs`,{expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,buildId:p.build.buildId,replaceSessionId:p.program.sessionId,expectedSessionRevision:1});
 await waiting;f.db.withTransaction(tx=>f.host.management.deactivateMembershipInTransaction(tx,'logic-course','student'));release();assert.equal((await pending).statusCode,403);
 const ended=await f.app.inject({url:`/api/hdl/sessions/${p.program.sessionId}`,headers:teacher});assert(ended.json().data.terminationConfirmed);
 }finally{await f.close();}
});
test('fresh initializer creates two normal courses and rejects mismatched recovery before creating business rows',async()=>{
 const f=await fixture();const {initializeSyntheticApplication}=await import('../server/app/initialize.ts');const {randomBytes}=await import('node:crypto');
 const password=randomBytes(32).toString('base64url'),manifest={synthetic:true,recoveryGeneration:'generation',accounts:[{id:'synthetic-teacher',loginName:'synthetic-teacher',password},{id:'synthetic-student',loginName:'synthetic-student',password}],courses:['synthetic-c','synthetic-hdl'],memberships:['synthetic-c','synthetic-hdl'].flatMap(courseId=>[{courseId,userId:'synthetic-teacher',role:'teacher'},{courseId,userId:'synthetic-student',role:'student'}])};
 let db:Awaited<ReturnType<typeof initializeSyntheticApplication>>|undefined;try{
 const transport={runner:f.settings.runner,hdlTransport:f.settings.hdlTransport};await assert.rejects(initializeSyntheticApplication({...manifest,recoveryGeneration:'old'},transport,f.settings.approvedHdlRuntimes));
 db=await initializeSyntheticApplication({...manifest,accounts:manifest.accounts.map(account=>({...account,displayName:account.id==='synthetic-student'?'夏禾':'任课教师'})),courses:[{id:'synthetic-c',name:'C 语言项目课'},'synthetic-hdl']},transport,f.settings.approvedHdlRuntimes);const {createDigitalLogicApplication}=await import('../server/app/digital-logic.ts');const host=await createDigitalLogicApplication({...f.settings,db});try{
 assert.equal(db.withTransaction(()=>host.currentGeneration()),'generation');const login=await host.app.inject({method:'POST',url:'/api/sessions',headers:{origin:'https://synthetic.example'},payload:{loginName:'synthetic-student',password}});assert.equal(login.statusCode,200,login.body);const cookie=login.cookies.filter(c=>c.value).map(c=>`${c.name}=${encodeURIComponent(c.value)}`).join('; ');const courses=await host.app.inject({url:'/api/courses',headers:{cookie}});assert.deepEqual(courses.json().data,[{courseId:'synthetic-c',role:'student',name:'C 语言项目课'},{courseId:'synthetic-hdl',role:'student'}]);const session=await host.app.inject({url:'/api/session',headers:{cookie}});assert.equal(session.json().data.displayName,'夏禾');
 }finally{await host.shutdown();}
 }finally{db?.close();await f.close();}
});

test('fixed ALU rejects out-of-course definitions and accepts another legal SW layout',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher');
 const bad=configuration('out-of-course');const payload=JSON.parse(JSON.stringify(bad));payload.alu.operations[0].meaning='shift_left';
 assert.equal((await command(f,teacher,'/api/courses/logic-course/hdl-configurations',{configuration:payload})).statusCode,400);
 for(const change of [(c:any)=>{c.alu.operandWidth=8;},(c:any)=>{c.alu.switchMapping=c.alu.switchMapping.filter((m:any)=>m.semantic!=='carry_in');},(c:any)=>{c.alu.operations[0].meaning='add_with_carry';},(c:any)=>{c.signals.anodesActive='high';}]){
 const invalid=JSON.parse(JSON.stringify(configuration()));change(invalid);assert.equal((await command(f,teacher,'/api/courses/logic-course/hdl-configurations',{configuration:invalid})).statusCode,400);}
 const alternate=configuration('other-legal-map');alternate.alu.switchMapping=[{semantic:'operand_a',offset:8,width:4},{semantic:'operand_b',offset:0,width:4},{semantic:'mode',offset:4,width:1},{semantic:'select',offset:5,width:2},{semantic:'carry_in',offset:7,width:1}];
 const accepted=await command(f,teacher,'/api/courses/logic-course/hdl-configurations',{configuration:alternate});assert.equal(accepted.statusCode,200,accepted.body);
 }finally{await f.close();}
});

test('withdrawal stops original C Run and marks teacher course assignment inactive',async()=>{
 const f=await fixture();try{const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student,false),state=await view(f,student,item.attemptId);
 const accepted=await command(f,student,`/api/attempts/${item.attemptId}/runs`,{expectedAttemptRevision:state.attempt.attemptRevision,snapshotId:item.snapshotId,runtimeProfileVersion:'runtime-v1',entryFileId:state.files[0].fileId,input:{operation:'stats',fileIds:[state.files[0].fileId]},mode:'run'});assert.equal(accepted.statusCode,200,accepted.body);const run=accepted.json().data.result;await f.host.consumeOnce();
 f.db.withTransaction(tx=>f.host.management.deactivateMembershipInTransaction(tx,'course','student'));
 const list=await f.app.inject({url:'/api/courses/course/assignments',headers:teacher});assert.equal(list.json().data.find((a:{assignmentId:string})=>a.assignmentId===item.assignmentId).active,false);
 await f.host.consumeOnce();const job=await f.app.inject({url:`/api/jobs/${run.jobId}`,headers:teacher});assert.equal(job.statusCode,200,job.body);assert.equal(job.json().data.stopRequested,true);assert.equal(job.json().data.status,'cancelled');
 assert.equal((await f.app.inject({url:`/api/jobs/${run.jobId}`,headers:student})).statusCode,403);
 }finally{await f.close();}
});

test('HDL host reuses the authorized I0 bootstrap with current generation and original AssignmentView',async()=>{
 const f=await fixture();try{
  const teacher=await f.login('teacher'),student=await f.login(),other=await f.login('other'),item=await allocate(f,teacher,student);
  const before=await view(f,student,item.attemptId);
  const assignment=await f.app.inject({url:'/api/assignments/'+item.assignmentId,headers:student});
  const response=await f.app.inject({url:'/api/assignments/'+item.assignmentId+'/bootstrap',headers:student});
  assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(response.json().data,{assignment:assignment.json().data,recoveryGeneration:'generation'});
  assert.equal(response.headers['cache-control'],'no-store');
  assert.deepEqual(await view(f,student,item.attemptId),before);
  assert.equal((await f.app.inject({url:'/api/assignments/'+item.assignmentId+'/bootstrap',headers:other})).statusCode,403);
 }finally{await f.close();}
});

test('C4 fixed submission stops the original active HDL Session and keeps replay and old trace readable',async()=>{
 const f=await fixture();try{
  const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student),p=await programmed(f,student,item);
  const input={expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,snapshotId:item.snapshotId,reflection:'Synthetic own explanation'};
  const response=await command(f,student,'/api/attempts/'+item.attemptId+'/submissions',input,'submit-hdl');
  assert.equal(response.statusCode,200,response.body);
  assert.equal((await view(f,student,item.attemptId)).attempt.status,'submitted');
  await f.host.consumeOnce();
  const session=await f.app.inject({url:'/api/hdl/sessions/'+p.program.sessionId,headers:student});
  assert.equal(session.statusCode,200,session.body);
  assert.equal(session.json().data.stopRequested,true);
  assert.equal(session.json().data.terminationConfirmed,true);
  const replay=await command(f,student,'/api/attempts/'+item.attemptId+'/submissions',input,'submit-hdl');
  assert.equal(replay.statusCode,200,replay.body);
  assert.deepEqual(replay.json().data.result,response.json().data.result);
  assert.equal((await view(f,student,item.attemptId)).submissions.length,1);
  const changed=await command(f,student,'/api/attempts/'+item.attemptId+'/submissions',{...input,reflection:'Different'},'submit-hdl');
  assert.equal(changed.statusCode,409,changed.body);
  const trace=await f.app.inject({url:'/api/hdl/sessions/'+p.program.sessionId+'/trace?afterSequence=-1',headers:student});
  assert.equal(trace.statusCode,200,trace.body);
  assert.equal(trace.json().data.operation.result.snapshotId,item.snapshotId);
 }finally{await f.close();}
});

test('C4 teacher grant and student revision resume never revive the stopped original HDL Session',async()=>{
 const f=await fixture();
 // Adapt the existing C4 public teacher seam only in the synthetic harness; this is not an A5 product route.
 f.app.post('/fixture/reviewed/:id',request=>f.host.workspace.reopen.markReviewed(request,(request.params as {id:string}).id,request.body));
 f.app.post('/fixture/reopen/:id',request=>f.host.workspace.reopen.grant(request,(request.params as {id:string}).id,request.body));
 try{
  const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student),p=await programmed(f,student,item);
  const submitted=await command(f,student,'/api/attempts/'+item.attemptId+'/submissions',{
   expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,snapshotId:item.snapshotId},'submit-for-revision');
  assert.equal(submitted.statusCode,200,submitted.body);await f.host.consumeOnce();
  const reviewed=await command(f,teacher,'/fixture/reviewed/'+item.attemptId,{
   expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,to:'reviewed'},'review-for-revision');
  assert.equal(reviewed.statusCode,200,reviewed.body);
  const granted=await command(f,teacher,'/fixture/reopen/'+item.attemptId,{
   expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,
   submissionId:submitted.json().data.result.submissionId,reason:'Synthetic teacher permits revision'},'grant-revision');
  assert.equal(granted.statusCode,200,granted.body);
  const resumed=await command(f,student,'/api/attempts/'+item.attemptId+'/controls',{
   expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,control:{kind:'resume_revision'}},'resume-revision');
  assert.equal(resumed.statusCode,200,resumed.body);
  const old=await f.app.inject({url:'/api/hdl/sessions/'+p.program.sessionId,headers:student});
  assert.equal(old.json().data.terminationConfirmed,true);assert.equal(old.json().data.status,'stopped');
  const revision=(await view(f,student,item.attemptId)).attempt.attemptRevision;
  const interaction=await command(f,student,'/api/attempts/'+item.attemptId+'/hdl/interactions',{
   expectedAttemptRevision:revision,sessionId:p.program.sessionId,expectedSessionRevision:old.json().data.sessionRevision,
   expectedSequence:1,inputs:{switches:'0'.repeat(16),buttons:'00000',resetN:'1'},advanceCycles:1},'old-session-after-resume');
  assert.equal(interaction.statusCode,409,interaction.body);
  const next=await command(f,student,'/api/attempts/'+item.attemptId+'/hdl/programs',{
   expectedAttemptRevision:revision,buildId:p.build.buildId},'new-explicit-program');
  assert.equal(next.statusCode,200,next.body);assert.notEqual(next.json().data.result.sessionId,p.program.sessionId);
  await f.host.consumeOnce();
  const current=await f.app.inject({url:'/api/hdl/sessions/'+next.json().data.result.sessionId,headers:student});
  assert.equal(current.json().data.status,'active');
  const history=await view(f,student,item.attemptId);
  assert.equal(history.submissions.length,1);assert.equal(history.submissions[0].snapshotId,item.snapshotId);
 }finally{await f.close();}
});


test('shutdown blocks new HDL dispatch while a real HTTP readiness request drains', {timeout:30000}, async()=>{
 let holdReadiness=false,buildCalls=0;
 let releaseBuild!:()=>void,releaseReadiness!:()=>void,markBuild!:()=>void,markReadiness!:()=>void;
 const buildStarted=new Promise<void>(resolve=>{markBuild=resolve;});
 const readinessStarted=new Promise<void>(resolve=>{markReadiness=resolve;});
 const buildWait=new Promise<void>(resolve=>{releaseBuild=resolve;});
 const readinessWait=new Promise<void>(resolve=>{releaseReadiness=resolve;});
 const f=await fixture(async packet=>{
  if(packet.op==='hdl_build'&&++buildCalls===1){markBuild();await buildWait;}
  if(packet.op==='hdl_readiness'&&holdReadiness){markReadiness();await readinessWait;}
 });
 let consuming:Promise<void>|undefined,closing:Promise<void>|undefined,http:Promise<Response>|undefined;
 try{
  f.host.startConsumer(10000);
  let healthy=false;
  for(let i=0;i<100;i++){if((await f.app.inject({url:'/health/ready'})).statusCode===200){healthy=true;break;}await delay(10);}
  assert.equal(healthy,true);
  const teacher=await f.login('teacher'),student=await f.login();
  for(let n=0;n<2;n++){
   const item=await allocate(f,teacher,student);
   const accepted=await command(f,student,'/api/attempts/'+item.attemptId+'/hdl/builds',{
    expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,snapshotId:item.snapshotId});
   assert.equal(accepted.statusCode,200,accepted.body);
  }
  const address=await f.app.listen({host:'127.0.0.1',port:0});
  holdReadiness=true;http=fetch(address+'/health/ready');await readinessStarted;
  consuming=f.host.consumeOnce();await buildStarted;
  closing=f.host.shutdown();assert.equal(f.host.isAccepting(),false);
  releaseBuild();await consuming;
  assert.equal(buildCalls,1,'shutdown must not dispatch the next queued HDL build while app.close waits for HTTP');
  releaseReadiness();assert.equal((await http).status,503);await closing;
 }finally{
  releaseBuild();releaseReadiness();
  await http;await consuming;await closing;await f.close();
 }
});
