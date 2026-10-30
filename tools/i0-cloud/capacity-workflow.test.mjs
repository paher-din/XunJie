import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture,allocate} from '../../apps/server/tests/dl-a-support.ts';
import {client,prepareProject,resumeProject,editAndSave,submit,reviewAndResume} from './capacity-workflow.mjs';

test('capacity workflow uses the real Session/CSRF, creates its own project, proves exact save/replay and frozen feedback/reopen semantics',async()=>{
  const f=await fixture(undefined,{review:{versions:{modelConfigVersion:'disabled',promptVersion:'disabled',schemaVersion:'review-v1',analysisVersion:'review-v1'}}});
  try{
    const existingTeacher=await f.login('teacher'),existingStudent=await f.login();await allocate(f,existingTeacher,existingStudent,false);
    const records=[],transport={async send(input){
      const res=await f.app.inject({method:input.method,url:input.url,headers:input.headers,...(input.body?{payload:input.body}:{})});
      return {status:res.statusCode,headers:res.headers,text:res.body,bytes:Buffer.byteLength(res.body)};
    }};
    const teacher=client({actor:'T',origin:'https://synthetic.example',transport,record:row=>records.push(row)});
    const student=client({actor:'S1',origin:'https://synthetic.example',transport,record:row=>records.push(row)});
    await teacher.login({loginName:'teacher',password:f.password});await student.login({loginName:'student',password:f.password});
    assert.notEqual(teacher.sessionFingerprint(),student.sessionFingerprint());
    const project=await prepareProject(teacher,[{label:'S1',client:student,userId:'student'}],'course','test-capacity');
    const state=project.states[0];await editAndSave(state,'test-capacity');const submission=await submit(state);await reviewAndResume(teacher,submission);
    await editAndSave(state,'test-capacity');assert.equal(state.iterations,2);assert.equal(state.feedback,1);assert.equal(state.submissions,1);assert.equal(state.replays,1);
    assert(!JSON.stringify(records).includes(f.password));assert(!JSON.stringify(records).includes('cookie'));
    assert(records.some(row=>row.route==='/api/sessions'));assert(records.every(row=>!row.route.includes(state.attemptId)));
  }finally{await f.close();}
});

test('repeat capacity run retains old assignments/history, validates owned base, and audits new writes as deltas',async()=>{
  const f=await fixture(undefined,{review:{versions:{modelConfigVersion:'disabled',promptVersion:'disabled',schemaVersion:'review-v1',analysisVersion:'review-v1'}}});
  try{
    await allocate(f,await f.login('teacher'),await f.login(),false);
    const records=[],transport={async send(input){const r=await f.app.inject({method:input.method,url:input.url,headers:input.headers,...(input.body?{payload:input.body}:{})});
      return {status:r.statusCode,headers:r.headers,text:r.body,bytes:Buffer.byteLength(r.body)};}};
    const teacher=client({actor:'T',origin:'https://synthetic.example',transport,record:row=>records.push(row)}),student=client({actor:'S1',origin:'https://synthetic.example',transport,record:row=>records.push(row)});
    await teacher.login({loginName:'teacher',password:f.password});await student.login({loginName:'student',password:f.password});
    const people=[{label:'S1',client:student,userId:'student'}],first=await prepareProject(teacher,people,'course','original-capacity'),old=first.states[0];
    await editAndSave(old,'original-capacity');await reviewAndResume(teacher,await submit(old));
    const baseline=await student.get('/api/attempts/:id',{id:old.attemptId});
    const prior={actors:[{actor:'S1',assignmentId:old.assignmentId,attemptId:old.attemptId,iterations:old.iterations,
      submissions:old.submissions,feedback:old.feedback,finalVersion:old.lastVersion,finalHash:old.lastHash}]};
    await assert.rejects(resumeProject(teacher,[{...people[0],userId:'other'}],'course','wrong-owner',prior),{code:'CAPACITY_RESUME_OWNERSHIP'});
    await assert.rejects(resumeProject(teacher,people,'course','changed-base',{actors:[{...prior.actors[0],finalVersion:99}]}),{code:'CAPACITY_RESUME_BASE_CHANGED'});
    const started=records.length,resumed=await resumeProject(teacher,people,'course','repeat-capacity',prior),state=resumed.states[0];
    assert.equal(state.assignmentId,old.assignmentId);assert.equal(state.attemptId,old.attemptId);
    assert.equal(state.baseDocumentVersion,1);assert.equal(state.baseSaves,1);assert.equal(state.baseSubmissions,1);assert.equal(state.baseFeedback,1);
    assert(!records.slice(started).some(row=>row.method==='POST'));
    await editAndSave(state,'repeat-capacity');await reviewAndResume(teacher,await submit(state));
    const head=await student.get('/api/attempts/:id',{id:state.attemptId}),feedback=await student.get('/api/attempts/:id/feedback',{id:state.attemptId});
    assert.equal(head.files.find(file=>file.path==='capacity.c').documentVersion,state.baseDocumentVersion+state.iterations);
    assert.equal(head.submissions.length,state.baseSubmissions+state.submissions);assert.equal(feedback.feedbackRevision,state.baseFeedback+state.feedback);
    assert.deepEqual(head.submissions[0],baseline.submissions[0]);
    assert.equal(f.db.withTransaction(tx=>tx.get('SELECT COUNT(*) AS n FROM attempts')?.n),2);
    assert.equal(f.db.withTransaction(tx=>tx.get("SELECT COUNT(*) AS n FROM command_receipts WHERE command='shared.workspace.sync' AND target=?",`/api/attempts/${state.attemptId}/sync`)?.n),state.baseSaves+state.iterations);
  }finally{await f.close();}
});


test('an existing immutable C activity accepts new independent assignments without requiring a new execution node or changing old attempts',async()=>{
  const f=await fixture(undefined,{review:{versions:{modelConfigVersion:'disabled',promptVersion:'disabled',schemaVersion:'review-v1',analysisVersion:'review-v1'}}});
  try{
    const teacherHeaders=await f.login('teacher'),oldStudent=await f.login(),old=await allocate(f,teacherHeaders,oldStudent,false);
    const records=[],transport={async send(input){const r=await f.app.inject({method:input.method,url:input.url,headers:input.headers,...(input.body?{payload:input.body}:{})});
      return {status:r.statusCode,headers:r.headers,text:r.body,bytes:Buffer.byteLength(r.body)};}};
    const teacher=client({actor:'T',origin:'https://synthetic.example',transport,record:row=>records.push(row)}),student=client({actor:'S1',origin:'https://synthetic.example',transport,record:row=>records.push(row)});
    await teacher.login({loginName:'teacher',password:f.password});await student.login({loginName:'other',password:f.password});
    const project=await prepareProject(teacher,[{label:'S1',client:student,userId:'other'}],'course','reused-capacity',{reusePublishedActivity:true});
    assert.equal(project.activityId,old.activityId);assert.notEqual(project.states[0].assignmentId,old.assignmentId);
    await editAndSave(project.states[0],'reused-capacity');await reviewAndResume(teacher,await submit(project.states[0]));
    assert.equal(project.states[0].feedback,1);assert(!records.some(row=>['/api/blueprints/:id/checks','/api/blueprints/:id/releases','/api/courses/:id/blueprints'].includes(row.route)));
    const before=await f.app.inject({url:`/api/attempts/${old.attemptId}`,headers:oldStudent});
    assert.equal(before.json().data.attempt.workspaceRevision,1);assert.equal(before.json().data.files.length,1);
  }finally{await f.close();}
});
