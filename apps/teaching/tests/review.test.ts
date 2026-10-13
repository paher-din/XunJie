import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture,command } from './review-support.ts';

test('A4: authenticated self-report has its own revision and never manufactures a claim',async () => {
  const f = await fixture();
  try {
    const student = await f.login();
    const read = async () => { const response = await f.app.inject({ url: '/api/courses/course/my-context',headers: student });
      assert.equal(response.statusCode,200,response.body);return response.json().data; };
    assert.equal((await read()).contextRevision,0);
    const input = { expectedContextRevision: 0,goals: 'I want to explain pointers',constraints: 'I need more time' };
    const first = await command(f,student,'/api/courses/course/my-context',input,'context-key','PATCH');
    assert.equal(first.statusCode,200,first.body);
    assert.equal(first.json().data.result.contextRevision,1);
    assert.equal((await read()).goals,input.goals);
    assert.equal((await read()).source,'self_report');
    const replay = await command(f,student,'/api/courses/course/my-context',input,'context-key','PATCH');
    assert.equal(replay.json().data.result.contextRevision,1);
    const conflict = await command(f,student,'/api/courses/course/my-context',{ ...input,goals: 'Different' },'context-key','PATCH');
    assert.equal(conflict.statusCode,409,conflict.body);
    const injected = await command(f,student,'/api/courses/course/my-context',{ ...input,role: 'teacher',studentId: 'other' },'injected','PATCH');
    assert.equal(injected.statusCode,400,injected.body);
    const foreign = await command(f,student,'/api/courses/foreign-course/my-context',input,'foreign','PATCH');
    assert.equal(foreign.statusCode,403,foreign.body);
    await f.reopen();assert.equal((await read()).contextRevision,1);
  } finally { await f.close(); }
});

test('A4: original analysis bytes and IDs survive replay and reopening without becoming teacher judgment',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    assert.equal((await s.state()).learnerStateRevision,0);
    const queued = await s.queue(),claimed = s.f.review.claimAnalysis(queued.jobId);
    assert.ok(claimed);
    const raw = JSON.stringify(candidate(s.snapshotId,s.activityId),null,2) + '\r\n';
    const input = {jobId: queued.jobId,leaseToken: claimed.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: raw};
    const result = s.f.review.completeAnalysis(input);
    assert.equal(result.disposition,'accepted');assert.equal(result.learnerStateRevision,1);
    const state = await s.state();assert.equal(state.claims.length,1);assert.equal(state.claims[0].source,'model_candidate');
    assert.equal(state.claims[0].assistanceStatus,'unknown');assert.equal(state.claims[0].unresolved,true);
    assert.equal(s.f.review.completeAnalysis(input).analysisId,result.analysisId);
    assert.equal((await s.state()).learnerStateRevision,1);
    assert.throws(() => s.f.review.completeAnalysis({...input,bodyJson: raw.trim()}),(error: unknown) => (error as {code?:string}).code === 'IDEMPOTENCY_CONFLICT');
    await s.f.reopen();
    const recorded = await s.f.app.inject({url: `/fixture/analysis/${s.attemptId}/${queued.jobId}`,headers: s.teacher});
    assert.equal(recorded.statusCode,200,recorded.body);assert.equal(recorded.json().data.rawBodyText,raw);
    assert.equal((await s.state()).claims[0].claimId,result.claimIds[0]);
  } finally { await s.f.close(); }
});

test('A4: teacher withdrawal is versioned, stops old analysis, and blocks renamed reuse of the same basis',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const original = await s.queue(),lease = s.f.review.claimAnalysis(original.jobId)!;
    const accepted = s.f.review.completeAnalysis({jobId: original.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    const before = await s.state(),target = before.claims[0],oldAttempt = (await s.attempt()).attempt;
    const late = await s.queue(),lateLease = s.f.review.claimAnalysis(late.jobId)!;
    const input = {expectedStateRevision: 1,targetRef: {kind: 'claim',id: target.claimId,revision: 1},decision: 'correct',reason: 'The cited work is not sufficient',evidenceRefs: []};
    const student = await command(s.f,s.student,`/api/attempts/${s.attemptId}/reviews`,input,'student-review');
    assert.equal(student.statusCode,403,student.body);
    const corrected = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,input,'teacher-review');
    assert.equal(corrected.statusCode,200,corrected.body);
    const result = corrected.json().data.result;
    assert.equal(result.learnerStateRevision,2);assert.ok(result.stoppedJobIds.includes(late.jobId));
    assert.equal((await s.attempt()).attempt.decisionEpoch,oldAttempt.decisionEpoch+1);
    const after = await s.state();assert.equal(after.claims[0].validity,'withdrawn');assert.equal(after.claims[0].claimRevision,2);
    assert.equal(after.decisions[0].reason,input.reason);assert.equal(after.decisions[0].teacherId,'teacher');
    const replay = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,input,'teacher-review');
    assert.equal(replay.json().data.result.decisionId,result.decisionId);assert.equal((await s.state()).learnerStateRevision,2);
    const lateResult = s.f.review.completeAnalysis({jobId: late.jobId,leaseToken: lateLease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    assert.equal(lateResult.disposition,'rejected');assert.equal((await s.state()).learnerStateRevision,2);
    const renamed = await s.queue(),newLease = s.f.review.claimAnalysis(renamed.jobId)!;
    const result2 = s.f.review.completeAnalysis({jobId: renamed.jobId,leaseToken: newLease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId,{claimId: 'fresh-id',statement: 'Different wording, original basis'}))});
    assert.equal(result2.disposition,'rejected');assert.equal(result2.reason,'STATE_CONFLICT');
    assert.deepEqual(accepted.claimIds,[target.claimId]);
    const stale = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,input,'stale-form');
    assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().error.code,'VERSION_CONFLICT');
  } finally {await s.f.close();}
});

test('A4: student dispute contests the current basis while historical disputes cannot overwrite later judgment',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    const target = (await s.state()).claims[0],ref = {kind: 'claim',id: target.claimId,revision: 1};
    const missingCas = await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,{targetRef: ref,reason: 'Please review the observation'},'missing-cas');
    assert.equal(missingCas.statusCode,409,missingCas.body);
    const foreign = await s.f.login('other');
    const denied = await command(s.f,foreign,`/api/attempts/${s.attemptId}/disputes`,{targetRef: ref,reason: 'Not my work',expectedStateRevision: 1});
    assert.equal(denied.statusCode,403,denied.body);
    const currentInput = {targetRef: ref,reason: 'The observation missed my explanation',expectedStateRevision: 1};
    const dispute = await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,currentInput,'dispute');
    assert.equal(dispute.statusCode,200,dispute.body);assert.equal(dispute.json().data.result.learnerStateRevision,2);
    const state = await s.state();assert.equal(state.claims[0].validity,'contested');assert.equal(state.claims[0].unresolved,true);
    assert.equal(state.disputes[0].reason,currentInput.reason);assert.equal(state.disputes[0].studentId,'student');
    const replay = await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,currentInput,'dispute');
    assert.equal(replay.json().data.result.disputeId,dispute.json().data.result.disputeId);
    const reviewed = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{targetRef: {...ref,revision: 2},expectedStateRevision: 2,
      decision: 'confirm',reason: 'Keep the uncertainty pending new evidence',evidenceRefs: []});
    assert.equal(reviewed.statusCode,200,reviewed.body);assert.equal((await s.state()).learnerStateRevision,3);
    const old = await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,{targetRef: ref,reason: 'A note on the old analysis'},'old-dispute');
    assert.equal(old.statusCode,200,old.body);assert.equal(old.json().data.result.currentTarget,false);
    assert.equal((await s.state()).learnerStateRevision,3);assert.equal((await s.state()).claims[0].source,'teacher_judgment');
    const feedback = await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,{targetRef: {kind: 'feedback',id: 'unimplemented-feedback',revision: 1},reason: 'Missing object'});
    assert.equal(feedback.statusCode,422,feedback.body);assert.equal(feedback.json().error.code,'INVALID_REFERENCE');
    await s.f.reopen();assert.equal((await s.state()).disputes.length,2);
  } finally {await s.f.close();}
});

test('A4: B2 preparation automatically reads the real current learner state and ignores injected preparation state',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    const claim = (await s.state()).claims[0];
    const help = await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question: 'Explain the approach',expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision});
    assert.equal(help.statusCode,200,help.body);const jobId = help.json().data.result.jobId;
    const prepared = await s.f.app.inject({method: 'POST',url: `/fixture/prepare/${s.attemptId}/${jobId}`,headers: s.student,
      payload: {learnerStateRevision: 900,learnerClaims: []}});
    assert.equal(prepared.statusCode,200,prepared.body);
    const refs = prepared.json().data.references;
    const ref = refs.find((r: {id:string}) => r.id === `claim:${claim.claimId}:1`);
    assert.ok(ref,'Real A claim is included');assert.equal(JSON.parse(ref.content).learnerStateRevision,1);
    assert.equal(JSON.parse(ref.content).assistanceStatus,'unknown');assert.ok(!JSON.stringify(refs).includes('900'));
  } finally {await s.f.close();}
});

test('A4: C3 final transaction archives an old learner-state help result with original IDs and prevents delivery',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const help = await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question: 'Explain the approach',expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision});
    assert.equal(help.statusCode,200,help.body);const helpResult = help.json().data.result,control = (await s.attempt()).attempt;
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    assert.equal((await s.attempt()).attempt.decisionEpoch,control.decisionEpoch,'Analysis can update A after the last B guard without changing epoch');
    const body = {kind: 'student_help',actionType: 'hint',content: 'Synthetic old-state help',rationale: 'Ask for an explanation',expectedStudentAction: 'Explain the approach',
      evidenceIds: [],resourceRefs: [],assistanceContext: 'Unknown assistance',unresolved: ['Missing evidence'],
      policyChecks: {containsWholeSolution: false,writesStudentWork: false,runsCode: false,makesFormalEvaluation: false}};
    const input = {jobId: helpResult.jobId,leaseToken: 'worker-lease',bodyJson: JSON.stringify(body),
      versions: {activityVersionId: s.activityId,policyVersionId: 'help-v1',modelConfigVersion: 'synthetic-model-v1',promptVersion: 'review-prompt-v1',schemaVersion: 'review-schema-v1'},
      usage: {status: 'unknown',reason: 'synthetic'},calls: 0,elapsedMs: 0,
      basis: {attemptRevision: helpResult.attemptRevision,decisionEpoch: control.decisionEpoch,captureRevision: control.captureRevision,
        relatedStateRevision: 0,inputRefs: [],assistanceRefs: [],coverageRefs: []}};
    const completed = await command(s.f,s.student,`/fixture/complete/${s.attemptId}`,input);
    assert.equal(completed.statusCode,200,completed.body);assert.equal(completed.json().data.disposition,'stale');
    const repeat = await command(s.f,s.student,`/fixture/complete/${s.attemptId}`,input);
    assert.equal(repeat.json().data.actionId,completed.json().data.actionId);
    const records = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/teaching-records`,headers: s.teacher});
    const action = records.json().data.actions.find((value: {actionId:string}) => value.actionId === completed.json().data.actionId);
    assert.equal(action.basisRevised,true);assert.equal(action.deliveries.length,0);
    const events = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/events?clientId=page&recoveryGeneration=generation&decisionEpoch=${control.decisionEpoch}&limit=100`,headers: s.student});
    assert.equal(events.statusCode,200,events.body);assert.ok(!events.body.includes(body.content));
  } finally {await s.f.close();}
});

test('A4: undelivered pending help is rechecked against A before first delivery and marked as revised',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const help = await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question: 'Explain the approach',expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision});
    const h = help.json().data.result,control = (await s.attempt()).attempt;
    const body = {kind: 'student_help',actionType: 'hint',content: 'Synthetic pending help before A changes',rationale: 'Ask for an explanation',expectedStudentAction: 'Explain',
      evidenceIds: [],resourceRefs: [],assistanceContext: 'Unknown assistance',unresolved: ['Missing evidence'],
      policyChecks: {containsWholeSolution: false,writesStudentWork: false,runsCode: false,makesFormalEvaluation: false}};
    const completed = await command(s.f,s.student,`/fixture/complete/${s.attemptId}`,{jobId: h.jobId,leaseToken: 'worker-lease',bodyJson: JSON.stringify(body),
      versions: {activityVersionId: s.activityId,policyVersionId: 'help-v1',modelConfigVersion: 'synthetic-model-v1',promptVersion: 'review-prompt-v1',schemaVersion: 'review-schema-v1'},
      usage: {status: 'unknown',reason: 'synthetic'},calls: 0,elapsedMs: 0,basis: {attemptRevision: h.attemptRevision,decisionEpoch: control.decisionEpoch,
        captureRevision: control.captureRevision,relatedStateRevision: 0,inputRefs: [],assistanceRefs: [],coverageRefs: []}});
    assert.equal(completed.statusCode,200,completed.body);assert.equal(completed.json().data.disposition,'pending');
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    const events = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/events?clientId=new-page&recoveryGeneration=generation&decisionEpoch=${control.decisionEpoch}&limit=100`,headers: s.student});
    assert.equal(events.statusCode,200,events.body);assert.ok(!events.body.includes(body.content));
    const records = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/teaching-records`,headers: s.teacher});
    const action = records.json().data.actions[0];assert.equal(action.disposition,'stale');assert.equal(action.basisRevised,true);assert.equal(action.deliveries.length,0);
  } finally {await s.f.close();}
});

test('A4: B2 running guard uses persisted A revision even when the external current reader is stale',async () => {
  const {setup,candidate,helpBody} = await import('./review-support.ts');const s = await setup();
  try {
    const help = await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question: 'Explain the approach',expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision});
    assert.equal(help.statusCode,200,help.body);const h = help.json().data.result;
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;let calls = 0;
    s.f.setProvider({async generate() {
      calls++;s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
      return {body: helpBody(),usage: {status: 'actual',inputTokens: 17,outputTokens: 9}};
    }});
    const execution = await command(s.f,s.student,`/fixture/execute/${s.attemptId}/${h.jobId}`,{});
    assert.equal(execution.statusCode,200,execution.body);assert.equal(execution.json().data.outcome.outcome,'stale');
    assert.equal(calls,1);assert.equal(execution.json().data.delivery,undefined);
    const records = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/teaching-records`,headers: s.teacher});
    assert.equal(records.json().data.actions.length,0);assert.equal((await s.state()).learnerStateRevision,1);
  } finally {await s.f.close();}
});

test('A4: actual B2 worker to C3 composition closes the last-guard-to-commit race',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const help = await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question: 'Explain the approach',expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision});
    assert.equal(help.statusCode,200,help.body);const h = help.json().data.result;
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    s.f.beforeTeachingComplete(() => {
      s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
      s.f.beforeTeachingComplete();
    });
    const execution = await command(s.f,s.student,`/fixture/execute/${s.attemptId}/${h.jobId}`,{});
    assert.equal(execution.statusCode,200,execution.body);
    assert.equal(execution.json().data.outcome.outcome,'success','The final B guard was current before A changed');
    assert.equal(execution.json().data.delivery.disposition,'stale','C admission uses the new A revision in the same transaction');
    const records = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/teaching-records`,headers: s.teacher});
    assert.equal(records.json().data.actions[0].basisRevised,true);assert.equal(records.json().data.actions[0].deliveries.length,0);
    assert.equal(records.json().data.messages.find((m: {authorKind:string}) => m.authorKind === 'model').envelope.basis.relatedStateRevision,0);
    assert.equal((await s.state()).learnerStateRevision,1);
  } finally {await s.f.close();}
});

test('A4: any late teacher transaction failure rolls back decision, state, epochs, stopped jobs, actions, events, and receipt',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const first = await s.queue(),lease = s.f.review.claimAnalysis(first.jobId)!;
    s.f.review.completeAnalysis({jobId: first.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    const target = (await s.state()).claims[0];
    const help = await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question: 'Explain the approach',expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision});
    const h = help.json().data.result;
    const executed = await command(s.f,s.student,`/fixture/execute/${s.attemptId}/${h.jobId}`,{});assert.equal(executed.statusCode,200,executed.body);
    assert.equal(executed.json().data.delivery.disposition,'pending');
    const late = await s.queue();s.f.review.claimAnalysis(late.jobId);
    const control = (await s.attempt()).attempt;
    const readRecords = async () => (await s.f.app.inject({url: `/api/attempts/${s.attemptId}/teaching-records`,headers: s.teacher})).json().data;
    const readJob = async (id: string) => (await s.f.app.inject({url: `/api/jobs/${id}`,headers: s.student})).json().data;
    const readEvents = async () => (await s.f.app.inject({url: `/api/attempts/${s.attemptId}/events?recoveryGeneration=generation&decisionEpoch=${control.decisionEpoch}&limit=100`,headers: s.teacher})).json().data;
    const before = {state: await s.state(),records: await readRecords(),help: await readJob(h.jobId),late: await readJob(late.jobId),events: await readEvents()};
    const input = {targetRef: {kind: 'claim',id: target.claimId,revision: 1},expectedStateRevision: 1,decision: 'correct',reason: 'Withdraw the unsupported interpretation',evidenceRefs: []};
    for (const statement of ['INSERT INTO learner_state_revisions','INSERT INTO teacher_decisions','INSERT INTO jobs','INSERT INTO teaching_actions',
      'INSERT INTO attempts','INSERT INTO audit_events','INSERT INTO command_receipts']) {
      s.f.injectFailure(statement);
      const response = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,input,'atomic-review');
      assert.equal(response.statusCode,503,response.body);assert.equal(response.json().error.code,'PERSISTENCE_UNAVAILABLE');
      s.f.injectFailure('');
      assert.deepEqual(await s.state(),before.state,statement);assert.deepEqual((await s.attempt()).attempt,control,statement);
      assert.deepEqual(await readRecords(),before.records,statement);assert.deepEqual(await readJob(h.jobId),before.help,statement);
      assert.deepEqual(await readJob(late.jobId),before.late,statement);assert.deepEqual(await readEvents(),before.events,statement);
    }
    const committed = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,input,'atomic-review');
    assert.equal(committed.statusCode,200,committed.body);const after = await readEvents();
    const replay = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,input,'atomic-review');
    assert.equal(replay.json().data.result.decisionId,committed.json().data.result.decisionId);assert.deepEqual(await readEvents(),after);
    assert.equal((await s.state()).decisions.length,1);assert.equal((await s.state()).learnerStateRevision,2);
  } finally {s.f.injectFailure('');await s.f.close();}
});

test('A4: completed analysis replays by original Job and exact hash rather than an expired execution lease',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    const raw = JSON.stringify(candidate(s.snapshotId,s.activityId)),input = {jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: raw};
    assert.throws(() => s.f.review.completeAnalysis({...input,leaseToken: 'wrong-lease'}),(e: unknown) => (e as {code?:string}).code === 'STATE_CONFLICT');
    const result = s.f.review.completeAnalysis(input);
    s.f.advance(45001);
    assert.deepEqual(s.f.review.completeAnalysis({...input,leaseToken: 'reconciliation-only'}),result);
    assert.equal((await s.state()).learnerStateRevision,1);
    assert.throws(() => s.f.review.completeAnalysis({...input,bodyJson: raw+' '}),(e: unknown) => (e as {code?:string}).code === 'IDEMPOTENCY_CONFLICT');
    s.f.restoreGeneration();
    assert.throws(() => s.f.review.completeAnalysis(input),(e: unknown) => (e as {code?:string}).code === 'RECOVERY_REQUIRED');
  } finally {await s.f.close();}
});

test('A4: original analysis, Job completion, state, event, and receipt are one real transaction',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    const input = {jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))};
    const readJob = async () => (await s.f.app.inject({url: `/api/jobs/${queued.jobId}`,headers: s.student})).json().data;
    const before = await readJob(),control = (await s.attempt()).attempt;
    const readEvents = async () => (await s.f.app.inject({url: `/api/attempts/${s.attemptId}/events?recoveryGeneration=generation&decisionEpoch=${control.decisionEpoch}&limit=100`,headers: s.teacher})).json().data;
    const events = await readEvents();
    for (const statement of ['INSERT INTO learner_state_revisions','INSERT INTO analysis_results','INSERT INTO jobs','INSERT INTO audit_events','INSERT INTO command_receipts']) {
      s.f.injectFailure(statement);
      assert.throws(() => s.f.review.completeAnalysis(input),(e: unknown) => (e as {code?:string}).code === 'PERSISTENCE_UNAVAILABLE');
      s.f.injectFailure('');assert.equal((await s.state()).learnerStateRevision,0);assert.deepEqual(await readJob(),before,statement);
      assert.deepEqual(await readEvents(),events,statement);
      const result = await s.f.app.inject({url: `/fixture/analysis/${s.attemptId}/${queued.jobId}`,headers: s.teacher});
      assert.equal(result.statusCode,422,result.body);assert.equal(result.json().error.code,'INVALID_REFERENCE');
    }
    const result = s.f.review.completeAnalysis(input);assert.equal(result.disposition,'accepted');assert.equal((await s.state()).learnerStateRevision,1);
    const saved = await readEvents();assert.deepEqual(s.f.review.completeAnalysis(input),result);assert.deepEqual(await readEvents(),saved);
  } finally {s.f.injectFailure('');await s.f.close();}
});

test('A4: invalid raw analyses and forged target versions remain archived rejections, never effective claims or student raw text',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const cases = [
      {raw: 'not JSON\r\n',reason: 'INVALID_REQUEST'},
      {raw: JSON.stringify({...candidate(s.snapshotId,s.activityId),studentId: 'other',role: 'teacher'}),reason: 'INVALID_REQUEST'},
      {raw: JSON.stringify(candidate(s.snapshotId,s.activityId,{competencyVersion: 2})),reason: 'INVALID_REFERENCE'},
      {raw: JSON.stringify(candidate(s.snapshotId,s.activityId,{domain: 'project'})),reason: 'INVALID_REFERENCE'},
      {raw: JSON.stringify(candidate(s.snapshotId,s.activityId,{scope: {kind: 'activity',activityVersionId: 'wrong-version'}})),reason: 'INVALID_REFERENCE'},
      {raw: JSON.stringify(candidate(s.snapshotId,s.activityId,{evidenceIds: ['fabricated']})),reason: 'INVALID_REFERENCE'},
      {raw: JSON.stringify(candidate(s.snapshotId,s.activityId,{state: 'supported_in_check'})),reason: 'INVALID_REFERENCE'},
      {raw: JSON.stringify(candidate(s.snapshotId,s.activityId,{assistanceStatus: 'observed_help'})),reason: 'INVALID_REFERENCE'},
    ];
    for (const entry of cases) {
      const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
      const result = s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: entry.raw});
      assert.equal(result.disposition,'rejected');assert.equal(result.reason,entry.reason);assert.equal(result.learnerStateRevision,0);assert.deepEqual(result.claimIds,[]);
      const teacher = await s.f.app.inject({url: `/fixture/analysis/${s.attemptId}/${queued.jobId}`,headers: s.teacher});
      assert.equal(teacher.statusCode,200,teacher.body);assert.equal(teacher.json().data.rawBodyText,entry.raw);
      if (entry.raw === 'not JSON\r\n') assert.equal(teacher.json().data.resultHash,'a2e359f46a34d3de00514f2065375c5929cf7f2d546f53b255a46b22ddd2857c');
      const student = await s.f.app.inject({url: `/fixture/analysis/${s.attemptId}/${queued.jobId}`,headers: s.student});
      assert.equal(student.statusCode,200,student.body);assert.equal(student.json().data.rawBodyText,undefined);
      assert.equal((await s.state()).claims.length,0);assert.equal((await s.state()).learnerStateRevision,0);
    }
  } finally {await s.f.close();}
});

test('A4: duplicate snapshot IDs cannot resurrect a withdrawn basis, but genuinely changed work can provide a new basis',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    const target = (await s.state()).claims[0];
    const correction = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{targetRef: {kind: 'claim',id: target.claimId,revision: 1},expectedStateRevision: 1,
      decision: 'correct',reason: 'The same artifact has insufficient evidence',evidenceRefs: []});assert.equal(correction.statusCode,200,correction.body);
    const duplicate = await command(s.f,s.student,`/api/attempts/${s.attemptId}/snapshots`,{expectedWorkspaceRevision: 1});assert.equal(duplicate.statusCode,200,duplicate.body);
    const duplicateId = duplicate.json().data.result.snapshotId;
    assert.notEqual(duplicateId,s.snapshotId);
    const second = await s.queue([{kind: 'snapshot',id: duplicateId,attemptId: s.attemptId}]),secondLease = s.f.review.claimAnalysis(second.jobId)!;
    const rejected = s.f.review.completeAnalysis({jobId: second.jobId,leaseToken: secondLease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(duplicateId,s.activityId))});
    assert.equal(rejected.disposition,'rejected');assert.equal(rejected.reason,'STATE_CONFLICT');assert.equal((await s.state()).learnerStateRevision,2);
    const file = (await s.attempt()).files[0];
    const edit = await command(s.f,s.student,`/api/attempts/${s.attemptId}/sync`,{expectedWorkspaceRevision: 1,clientId: 'page',clientSeq: 2,
      operations: [{kind: 'update',fileId: file.fileId,baseVersion: file.documentVersion,text: 'int main(void){return 1;}\n'}]});assert.equal(edit.statusCode,200,edit.body);
    const fresh = await command(s.f,s.student,`/api/attempts/${s.attemptId}/snapshots`,{expectedWorkspaceRevision: 2});assert.equal(fresh.statusCode,200,fresh.body);
    const freshId = fresh.json().data.result.snapshotId;
    const third = await s.queue([{kind: 'snapshot',id: freshId,attemptId: s.attemptId}]),thirdLease = s.f.review.claimAnalysis(third.jobId)!;
    const accepted = s.f.review.completeAnalysis({jobId: third.jobId,leaseToken: thirdLease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(freshId,s.activityId))});
    assert.equal(accepted.disposition,'accepted');assert.equal((await s.state()).learnerStateRevision,3);
    assert.ok((await s.state()).claims.some((value: {validity:string}) => value.validity === 'withdrawn'));
  } finally {await s.f.close();}
});

test('A4: transitive claim dependencies are contested and a changed analysis version cannot revive their primitive basis',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const add = async (refs: object[],evidenceId: string,extra: object = {}) => {
      const queued = await s.queue(refs),lease = s.f.review.claimAnalysis(queued.jobId)!;
      return s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(evidenceId,s.activityId,extra))});
    };
    const root = await add([{kind: 'snapshot',id: s.snapshotId,attemptId: s.attemptId}],s.snapshotId);
    const rootId = root.claimIds[0];assert.ok(rootId);
    const project = await add([{kind: 'claim',id: rootId,revision: 1}],rootId,{competencyId: 'p',domain: 'project'});
    const projectId = project.claimIds[0];assert.ok(projectId);
    const ai = await add([{kind: 'claim',id: projectId,revision: 1}],projectId,{competencyId: 'a',domain: 'ai_collaboration'});
    assert.equal(ai.disposition,'accepted');const before = await s.state();
    assert.deepEqual(before.claims.map((value: {domain:string}) => value.domain).sort(),['ai_collaboration','domain','project']);
    for (const claim of before.claims) assert.deepEqual(claim.evidenceGroupIds,[s.attemptId],'Derived summaries do not add another independent observation group');
    const correction = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{targetRef: {kind: 'claim',id: root.claimIds[0],revision: 1},expectedStateRevision: 3,
      decision: 'correct',reason: 'Withdraw the original basis',evidenceRefs: []});assert.equal(correction.statusCode,200,correction.body);
    const after = await s.state();assert.equal(after.learnerStateRevision,4);
    assert.equal(after.claims.find((value: {claimId:string}) => value.claimId === root.claimIds[0]).validity,'withdrawn');
    assert.equal(after.claims.find((value: {claimId:string}) => value.claimId === project.claimIds[0]).validity,'contested');
    assert.equal(after.claims.find((value: {claimId:string}) => value.claimId === ai.claimIds[0]).validity,'contested');
    s.f.setAnalysisVersion('synthetic-analysis-v2');
    const renamed = await add([{kind: 'snapshot',id: s.snapshotId,attemptId: s.attemptId}],s.snapshotId,{competencyId: 'p',domain: 'project',claimId: 'new-name',statement: 'A new wording on the same original work'});
    assert.equal(renamed.disposition,'rejected');assert.equal(renamed.reason,'STATE_CONFLICT');assert.equal((await s.state()).learnerStateRevision,4);
  } finally {await s.f.close();}
});

test('A4: evidence queues enforce real membership, owner, course, and visible exact resource scope',async () => {
  const {setup} = await import('./review-support.ts');const s = await setup();
  try {
    const other = await s.f.login('other'),foreign = await s.f.login('foreign');
    const allocation = await command(s.f,s.teacher,`/api/activities/${s.activityId}/assignments`,{expectedActivityControlRevision: 1,studentIds: ['other']});
    assert.equal(allocation.statusCode,200,allocation.body);
    const opened = await command(s.f,other,`/api/assignments/${allocation.json().data.result.assignments[0].assignmentId}/attempts`,{});
    assert.equal(opened.statusCode,200,opened.body);const otherAttempt = opened.json().data.result.attemptId;
    const base = {expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision,expectedStateRevision: 0,purpose: 'explicit_analysis',assistanceRefs: [],coverageRefs: []};
    const privateParagraph = s.privateMaterial.material.paragraphs[0];
    const privateRef = {kind: 'resource',id: `resource:${s.privateMaterial.resourceVersionId}:${privateParagraph.paragraphId}`,
      resourceVersionId: s.privateMaterial.resourceVersionId,paragraphId: privateParagraph.paragraphId};
    for (const ref of [privateRef,{kind: 'snapshot',id: s.snapshotId,attemptId: otherAttempt},
      {kind: 'snapshot',id: 'missing-snapshot',attemptId: s.attemptId},{kind: 'context',id: 'other',revision: 1}]) {
      const response = await command(s.f,s.student,`/fixture/analysis/${s.attemptId}`,{...base,inputRefs: [ref]});
      assert.equal(response.statusCode,422,response.body);assert.equal(response.json().error.code,'INVALID_REFERENCE');
      assert.ok(!response.body.includes('PRIVATE_BODY'));assert.ok(!response.body.includes('PRIVATE_TITLE'));
    }
    const injected = await command(s.f,s.student,`/fixture/analysis/${s.attemptId}`,{...base,inputRefs: [],studentId: 'other',role: 'teacher'});
    assert.equal(injected.statusCode,400,injected.body);
    for (const headers of [other,foreign]) {
      const state = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/learner-state`,headers});assert.equal(state.statusCode,403,state.body);
      const queue = await command(s.f,headers,`/fixture/analysis/${s.attemptId}`,{...base,inputRefs: []});assert.equal(queue.statusCode,403,queue.body);
    }
    const publicParagraph = s.material.material.paragraphs[0];
    const visible = {kind: 'resource',id: `resource:${s.material.resourceVersionId}:${publicParagraph.paragraphId}`,resourceVersionId: s.material.resourceVersionId,paragraphId: publicParagraph.paragraphId};
    const queued = await s.queue([visible]);assert.equal(queued.binding.inputRefs[0].id,visible.id);
    s.f.db.withTransaction(tx => tx.run("UPDATE course_memberships SET active=0 WHERE course_id='course' AND user_id='student'"));
    const revoked = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/learner-state`,headers: s.student});assert.equal(revoked.statusCode,403,revoked.body);
    assert.throws(() => s.f.review.claimAnalysis(queued.jobId),(e: unknown) => (e as {code?:string}).code === 'FORBIDDEN');
  } finally {await s.f.close();}
});

test('A4: stdout and a bare passed verdict cannot replace exact trusted course-check provenance',async () => {
  const {setup,candidate,syntheticNode,run} = await import('./review-support.ts');const s = await setup();
  try {
    s.f.setTransport(syntheticNode('forged_check'));const checked = await run(s,'course_check');
    const queued = await s.queue([{kind: 'run',id: checked.runId,attemptId: s.attemptId}]),lease = s.f.review.claimAnalysis(queued.jobId)!;
    const result = s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(checked.runId,s.activityId,{state: 'supported_in_check',assistanceStatus: 'unknown',unknown: ['No guarantee of external assistance'],unresolved: true}))});
    assert.equal(result.disposition,'rejected');assert.equal(result.reason,'INVALID_REFERENCE');assert.equal((await s.state()).learnerStateRevision,0);
    s.f.setTransport(syntheticNode('trusted_check'));const trusted = await run(s,'course_check');
    const next = await s.queue([{kind: 'run',id: trusted.runId,attemptId: s.attemptId}]),nextLease = s.f.review.claimAnalysis(next.jobId)!;
    const valid = s.f.review.completeAnalysis({jobId: next.jobId,leaseToken: nextLease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(trusted.runId,s.activityId,{state: 'supported_in_check',assistanceStatus: 'unknown',unknown: ['No guarantee of external assistance'],unresolved: true}))});
    assert.equal(valid.disposition,'accepted');const claim = (await s.state()).claims[0];assert.equal(claim.state,'supported_in_check');
    assert.equal(claim.assistanceStatus,'unknown');assert.deepEqual(claim.evidenceGroupIds,[s.attemptId]);
  } finally {await s.f.close();}
});

test('A4: an actual stored compiler failure remains a tool gap instead of unsupported certainty about the learner',async () => {
  const {setup,candidate,syntheticNode,run} = await import('./review-support.ts');const s = await setup({process: true});
  try {
    const coverage = (await s.f.app.inject({url: `/api/attempts/${s.attemptId}/coverage`,headers: s.student})).json().data;
    assert.equal(coverage.collecting,true);assert.equal(coverage.intervals[0].rejections.length,0);
    s.f.setTransport(syntheticNode('compile_error'));const failed = await run(s);
    const observed = (await s.attempt()).runs.find((r: {runId:string}) => r.runId === failed.runId);assert.equal(observed.diagnostics.failureKind,'compile_error');
    const queued = await s.queue([{kind: 'run',id: failed.runId,attemptId: s.attemptId}]),lease = s.f.review.claimAnalysis(queued.jobId)!;
    const falselyCertain = s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(failed.runId,s.activityId,{assistanceStatus: 'none_observed_in_system',unresolved: false,unknown: []}))});
    assert.equal(falselyCertain.disposition,'rejected');assert.equal(falselyCertain.reason,'INVALID_REFERENCE');
    const next = await s.queue([{kind: 'run',id: failed.runId,attemptId: s.attemptId}]),nextLease = s.f.review.claimAnalysis(next.jobId)!;
    const unknown = s.f.review.completeAnalysis({jobId: next.jobId,leaseToken: nextLease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(failed.runId,s.activityId,{unknown: ['Compiler outcome does not establish knowledge']}))});
    assert.equal(unknown.disposition,'accepted');const claim = (await s.state()).claims[0];assert.equal(claim.state,'insufficient');
    assert.equal(claim.unresolved,true);assert.equal(claim.assistanceStatus,'unknown');assert.deepEqual(claim.unknown,['Compiler outcome does not establish knowledge']);
  } finally {await s.f.close();}
});

test('A4: repeating the same checked work under a new Run ID does not revive a withdrawn basis or create another observation group',async () => {
  const {setup,candidate,syntheticNode,run} = await import('./review-support.ts');const s = await setup({process: true});
  try {
    s.f.setTransport(syntheticNode('trusted_check'));const first = await run(s,'course_check');
    const q1 = await s.queue([{kind: 'run',id: first.runId,attemptId: s.attemptId}]),l1 = s.f.review.claimAnalysis(q1.jobId)!;
    const accepted = s.f.review.completeAnalysis({jobId: q1.jobId,leaseToken: l1.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(first.runId,s.activityId,{state: 'supported_in_check'}))});assert.equal(accepted.disposition,'accepted');
    const target = (await s.state()).claims[0];
    const correction = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{targetRef: {kind: 'claim',id: target.claimId,revision: 1},expectedStateRevision: 1,
      decision: 'correct',reason: 'The same repeated check is insufficient for this judgment',evidenceRefs: []});assert.equal(correction.statusCode,200,correction.body);
    const second = await run(s,'course_check');assert.notEqual(second.runId,first.runId);
    const q2 = await s.queue([{kind: 'run',id: second.runId,attemptId: s.attemptId}]),l2 = s.f.review.claimAnalysis(q2.jobId)!;
    const repeated = s.f.review.completeAnalysis({jobId: q2.jobId,leaseToken: l2.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(second.runId,s.activityId,{claimId: 'renamed-checked-claim',state: 'supported_in_check'}))});
    assert.equal(repeated.disposition,'rejected');assert.equal(repeated.reason,'STATE_CONFLICT');assert.equal((await s.state()).learnerStateRevision,2);
    const originalFile = (await s.attempt()).files[0];
    const saved = await command(s.f,s.student,`/api/attempts/${s.attemptId}/sync`,{expectedWorkspaceRevision: 1,clientId: 'page',clientSeq: 2,process: {captureRevision: 0},
      operations: [{kind: 'recycle',fileId: originalFile.fileId,baseVersion: originalFile.documentVersion},
        {kind: 'create',clientFileKey: 'replacement',path: originalFile.path,text: originalFile.text}]});assert.equal(saved.statusCode,200,saved.body);
    const nextSnapshot = await command(s.f,s.student,`/api/attempts/${s.attemptId}/snapshots`,{expectedWorkspaceRevision: 2});assert.equal(nextSnapshot.statusCode,200,nextSnapshot.body);
    const current = await s.attempt(),newFile = current.files.find((file: {lifecycle:string}) => file.lifecycle === 'active');assert.notEqual(newFile.fileId,originalFile.fileId);
    const third = await command(s.f,s.student,`/api/attempts/${s.attemptId}/runs`,{expectedAttemptRevision: current.attempt.attemptRevision,
      snapshotId: nextSnapshot.json().data.result.snapshotId,runtimeProfileVersion: s.f.profile.runtimeProfileVersion,entryFileId: newFile.fileId,
      input: {operation: 'stats',fileIds: [newFile.fileId]},mode: 'course_check'});assert.equal(third.statusCode,200,third.body);
    const thirdRun = third.json().data.result;await s.f.workspace.processJob(thirdRun.jobId);
    const q3 = await s.queue([{kind: 'run',id: thirdRun.runId,attemptId: s.attemptId}]),l3 = s.f.review.claimAnalysis(q3.jobId)!;
    const identicalFiles = s.f.review.completeAnalysis({jobId: q3.jobId,leaseToken: l3.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(thirdRun.runId,s.activityId,{state: 'supported_in_check'}))});
    assert.equal(identicalFiles.disposition,'rejected');assert.equal(identicalFiles.reason,'STATE_CONFLICT');
    const facts = await s.attempt();assert.equal(facts.runs.length,3,'All original executions remain facts');assert.deepEqual((await s.state()).claims[0].evidenceGroupIds,[s.attemptId]);
  } finally {await s.f.close();}
});

test('A4: stale underlying context is unavailable in the current projection and cannot be laundered through a claim reference',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const first = await command(s.f,s.student,'/api/courses/course/my-context',{expectedContextRevision: 0,goals: 'First self-reported goal',constraints: 'First context'},'context-one','PATCH');
    assert.equal(first.statusCode,200,first.body);
    const queued = await s.queue([{kind: 'context',id: 'student',revision: 1}]),lease = s.f.review.claimAnalysis(queued.jobId)!;
    const result = s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate('student',s.activityId))});
    assert.equal(result.disposition,'accepted');const target = (await s.state()).claims[0];
    const revised = await command(s.f,s.student,'/api/courses/course/my-context',{expectedContextRevision: 1,goals: 'Changed self-reported goal',constraints: 'Changed context'},'context-two','PATCH');
    assert.equal(revised.statusCode,200,revised.body);
    const state = await s.state();assert.equal(state.learnerStateRevision,1,'Self-report does not manufacture a new ability judgment');
    assert.equal(state.claims[0].references[0].status,'unavailable');assert.equal(state.claims[0].basisAvailable,false);
    const denied = await command(s.f,s.student,`/fixture/analysis/${s.attemptId}`,{expectedStateRevision: 1,expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision,
      purpose: 'explicit_analysis',inputRefs: [{kind: 'claim',id: target.claimId,revision: 1}],assistanceRefs: [],coverageRefs: []});
    assert.equal(denied.statusCode,422,denied.body);assert.equal(denied.json().error.code,'INVALID_REFERENCE');
    const help = await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question: 'Explain the approach',expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision});
    const prepared = await s.f.app.inject({method: 'POST',url: `/fixture/prepare/${s.attemptId}/${help.json().data.result.jobId}`,headers: s.student,payload: {}});
    assert.equal(prepared.statusCode,200,prepared.body);assert.ok(!prepared.body.includes(`claim:${target.claimId}:1`));assert.ok(prepared.body.includes('learner-state:1:unknown'));
  } finally {await s.f.close();}
});

test('A4: self-report invalidation returns committed stop identities and rolls back entirely on a late failure',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup({process: true});
  try {
    const help = await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question: 'Explain the approach',expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision});
    const h = help.json().data.result;
    const queued = await s.queue(undefined,{purpose: 'passive_analysis'}),lease = s.f.review.claimAnalysis(queued.jobId)!;
    const before = (await s.attempt()).attempt;
    const input = {expectedContextRevision: 0,goals: 'Revised self-report',constraints: 'Revised constraints'};
    s.f.injectFailure('INSERT INTO command_receipts');
    const failed = await command(s.f,s.student,'/api/courses/course/my-context',input,'atomic-context','PATCH');
    assert.equal(failed.statusCode,503,failed.body);s.f.injectFailure('');
    const initial = await s.f.app.inject({url: '/api/courses/course/my-context',headers: s.student});assert.equal(initial.json().data.contextRevision,0);
    assert.deepEqual((await s.attempt()).attempt,before);
    const waiting = await s.f.app.inject({url: `/api/jobs/${queued.jobId}`,headers: s.student});assert.equal(waiting.json().data.stopRequested,false);
    const saved = await command(s.f,s.student,'/api/courses/course/my-context',input,'atomic-context','PATCH');
    assert.equal(saved.statusCode,200,saved.body);const result = saved.json().data.result;
    assert.equal(result.contextRevision,1);assert.ok(result.stoppedJobIds.includes(h.jobId));assert.ok(result.stoppedJobIds.includes(queued.jobId));
    assert.deepEqual(result.affectedAttemptIds,[s.attemptId]);assert.equal((await s.state()).learnerStateRevision,0);
    const replay = await command(s.f,s.student,'/api/courses/course/my-context',input,'atomic-context','PATCH');assert.deepEqual(replay.json().data.result,result);
    const late = s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    assert.equal(late.disposition,'rejected');assert.equal((await s.state()).learnerStateRevision,0);
  } finally {s.f.injectFailure('');await s.f.close();}
});

test('A4: teacher correction preserves original ordinary runs and displayed-help receipts while new B2 context excludes withdrawn claims',async () => {
  const {setup,candidate,syntheticNode,run} = await import('./review-support.ts');const s = await setup({process: true});
  try {
    s.f.setTransport(syntheticNode('plain_pass'));const ordinary = await run(s);
    const queued = await s.queue([{kind: 'run',id: ordinary.runId,attemptId: s.attemptId}]),lease = s.f.review.claimAnalysis(queued.jobId)!;
    s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(ordinary.runId,s.activityId))});
    const target = (await s.state()).claims[0];
    const help = await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question: 'Explain the approach',expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision});
    const h = help.json().data.result,executed = await command(s.f,s.student,`/fixture/execute/${s.attemptId}/${h.jobId}`,{});
    assert.equal(executed.statusCode,200,executed.body);const action = executed.json().data.delivery,control = (await s.attempt()).attempt;
    const events = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/events?clientId=page&recoveryGeneration=generation&decisionEpoch=${control.decisionEpoch}&limit=100`,headers: s.student});
    const delivered = events.json().data.events.find((e: {payload?: {actionId:string}}) => e.payload?.actionId === action.actionId)?.payload;
    assert.ok(delivered,'Actual C delivery is required before recording display');
    const displayed = await command(s.f,s.student,`/api/actions/${action.actionId}/receipts`,{deliveryId: delivered.deliveryId,clientId: 'page',contentHash: action.contentHash,
      receiptKind: 'displayed',clientReceiptId: 'displayed-'+action.actionId});assert.equal(displayed.statusCode,200,displayed.body);
    const before = await s.attempt(),runBefore = before.runs.find((r: {runId:string}) => r.runId === ordinary.runId);
    const correction = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{targetRef: {kind: 'claim',id: target.claimId,revision: 1},expectedStateRevision: 1,
      decision: 'correct',reason: 'Revise the learner interpretation',evidenceRefs: []});assert.equal(correction.statusCode,200,correction.body);
    const after = await s.attempt();assert.deepEqual(after.runs.find((r: {runId:string}) => r.runId === ordinary.runId),runBefore);
    assert.equal(after.jobs.find((j: {jobId:string}) => j.jobId === ordinary.jobId).stopRequested,false);
    const records = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/teaching-records`,headers: s.student});
    const history = records.json().data.actions.find((a: {actionId:string}) => a.actionId === action.actionId);
    assert.equal(history.basisRevised,true);assert.ok(history.receipts.some((r: {receiptKind:string}) => r.receiptKind === 'displayed'));
    assert.ok(records.body.includes('Synthetic hint: explain the approach'));
    const newHelp = await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question: 'Explain the approach',expectedAttemptRevision: after.attempt.attemptRevision});
    const prepared = await s.f.app.inject({method: 'POST',url: `/fixture/prepare/${s.attemptId}/${newHelp.json().data.result.jobId}`,headers: s.student,payload: {}});
    assert.equal(prepared.statusCode,200,prepared.body);assert.ok(!prepared.body.includes(`claim:${target.claimId}`));assert.ok(prepared.body.includes('learner-state:2:unknown'));
    const fresh = await command(s.f,s.student,`/api/attempts/${s.attemptId}/snapshots`,{expectedWorkspaceRevision: after.attempt.workspaceRevision});
    const q2 = await s.queue([{kind: 'snapshot',id: fresh.json().data.result.snapshotId,attemptId: s.attemptId}]),l2 = s.f.review.claimAnalysis(q2.jobId)!;
    const ignoredHelp = s.f.review.completeAnalysis({jobId: q2.jobId,leaseToken: l2.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(fresh.json().data.result.snapshotId,s.activityId,{assistanceStatus: 'none_observed_in_system',unknown: [],unresolved: false}))});
    assert.equal(ignoredHelp.disposition,'rejected');assert.equal(ignoredHelp.reason,'INVALID_REFERENCE');
    await s.f.reopen();const persisted = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/teaching-records`,headers: s.student});
    assert.equal(persisted.json().data.actions[0].basisRevised,true);assert.equal(persisted.json().data.actions[0].receipts[0].receiptKind,'displayed');
  } finally {await s.f.close();}
});

test('A4: declared unknowns cannot be discarded by an unresolved=false flag',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup({process: true});
  try {
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    const result = s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId,{unresolved: false,unknown: ['Explanation is not yet observed']}))});
    assert.equal(result.disposition,'rejected');assert.equal(result.reason,'INVALID_REFERENCE');assert.equal((await s.state()).learnerStateRevision,0);
  } finally {await s.f.close();}
});

test('A4: original analysis currentness gates are checked again at completion',async t => {
  const {setup,candidate} = await import('./review-support.ts');
  for (const change of ['deadline','configuration','state','context','capture','assignment','membership','generation'] as const) await t.test(change,async () => {
    const s = await setup({process: true});
    try {
      const queued = await s.queue(undefined,{purpose: change === 'capture' ? 'passive_analysis' : 'explicit_analysis'}),lease = s.f.review.claimAnalysis(queued.jobId)!;
      const input = {jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))};
      if (change === 'deadline') s.f.advance(45001);
      if (change === 'configuration') s.f.setAnalysisVersion('new-trusted-analysis-config');
      if (change === 'state') {
        const newer = await s.queue(),l2 = s.f.review.claimAnalysis(newer.jobId)!;
        s.f.review.completeAnalysis({...input,jobId: newer.jobId,leaseToken: l2.leaseToken});
      }
      if (change === 'context') {
        const response = await command(s.f,s.student,'/api/courses/course/my-context',{expectedContextRevision: 0,goals: 'New',constraints: 'New'},'change-context','PATCH');assert.equal(response.statusCode,200,response.body);
      }
      if (change === 'capture') {
        const response = await command(s.f,s.student,`/api/attempts/${s.attemptId}/controls`,{expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision,control: {kind: 'capture',value: false}});
        assert.equal(response.statusCode,200,response.body);
      }
      if (change === 'assignment') {
        const response = await command(s.f,s.teacher,`/api/assignments/${s.allocationId}/controls`,{expectedAssignmentRevision: 1,action: 'pause',reason: 'Pause'});assert.equal(response.statusCode,200,response.body);
      }
      if (change === 'membership') s.f.db.withTransaction(tx => tx.run("UPDATE course_memberships SET active=0 WHERE course_id='course' AND user_id='student'"));
      if (change === 'generation') s.f.restoreGeneration();
      if (change === 'generation') assert.throws(() => s.f.review.completeAnalysis(input),(e: unknown) => (e as {code?:string}).code === 'RECOVERY_REQUIRED');
      else {
        const result = s.f.review.completeAnalysis(input);assert.equal(result.disposition,'rejected');assert.deepEqual(result.claimIds,[]);
        assert.equal(result.reason,change === 'membership' ? 'FORBIDDEN' : change === 'state' ? 'VERSION_CONFLICT' : 'STATE_CONFLICT');
        const teacher = await s.f.app.inject({url: `/fixture/analysis/${s.attemptId}/${queued.jobId}`,headers: s.teacher});
        assert.equal(teacher.statusCode,200,teacher.body);assert.equal(teacher.json().data.rawBodyText,input.bodyJson);
      }
      const state = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/learner-state`,headers: s.teacher});assert.equal(state.statusCode,200,state.body);
      assert.equal(state.json().data.learnerStateRevision,change === 'state' ? 1 : 0);
    } finally {await s.f.close();}
  });
});

test('A4: an old goal version check cannot establish a claim for a new fixed activity goal version',async () => {
  const {setup,candidate,syntheticNode,run} = await import('./review-support.ts');const s = await setup({process: true});
  try {
    s.f.setTransport(syntheticNode('trusted_check'));const checked = await run(s,'course_check');
    const content = structuredClone(s.content);
    content.goals = content.goals.map((g: {competencyVersion:number}) => ({...g,competencyVersion: 2}));
    for (const rows of [content.tasks,content.observations,content.rubricCriteria]) for (const row of rows)
      row.goalRefs = row.goalRefs.map((g: {competencyVersion:number}) => ({...g,competencyVersion: 2}));
    const created = await command(s.f,s.teacher,'/api/courses/course/blueprints',{mode: 'manual',content});assert.equal(created.statusCode,200,created.body);
    const blueprintId = created.json().data.result.draft.blueprintId;
    const check = await command(s.f,s.teacher,`/api/blueprints/${blueprintId}/checks`,{expectedRevision: 1});assert.equal(check.statusCode,200,check.body);
    const release = await command(s.f,s.teacher,`/api/blueprints/${blueprintId}/releases`,{expectedRevision: 1,confirmed: true});assert.equal(release.statusCode,200,release.body);
    const activity = release.json().data.result.activityVersionId;
    const assignment = await command(s.f,s.teacher,`/api/activities/${activity}/assignments`,{expectedActivityControlRevision: 1,studentIds: ['student']});assert.equal(assignment.statusCode,200,assignment.body);
    const opened = await command(s.f,s.student,`/api/assignments/${assignment.json().data.result.assignments[0].assignmentId}/attempts`,{});assert.equal(opened.statusCode,200,opened.body);
    const attemptId = opened.json().data.result.attemptId;
    const attempt = (await s.f.app.inject({url: `/api/attempts/${attemptId}`,headers: s.student})).json().data.attempt;
    const queued = await command(s.f,s.student,`/fixture/analysis/${attemptId}`,{expectedAttemptRevision: attempt.attemptRevision,expectedStateRevision: 0,purpose: 'explicit_analysis',
      inputRefs: [{kind: 'run',id: checked.runId,attemptId: s.attemptId}],assistanceRefs: [],coverageRefs: []});assert.equal(queued.statusCode,200,queued.body);
    const jobId = queued.json().data.result.jobId,lease = s.f.review.claimAnalysis(jobId)!;
    const result = s.f.review.completeAnalysis({jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(checked.runId,activity,{scope: {kind: 'course'},competencyVersion: 2,state: 'supported_in_check'}))});
    assert.equal(result.disposition,'rejected');assert.equal(result.reason,'INVALID_REFERENCE');assert.equal((await s.state()).learnerStateRevision,0);
  } finally {await s.f.close();}
});

test('A4: non-UTF8 scalar text cannot occupy the original analysis slot or be silently normalized',async () => {
  const {setup} = await import('./review-support.ts');const s = await setup();
  try {
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    const input = {jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: '\ud800'};
    assert.throws(() => s.f.review.completeAnalysis(input),(e: unknown) => (e as {code?:string}).code === 'INVALID_REQUEST');
    const stored = await s.f.app.inject({url: `/fixture/analysis/${s.attemptId}/${queued.jobId}`,headers: s.teacher});assert.equal(stored.statusCode,422,stored.body);
    assert.equal((await s.state()).learnerStateRevision,0);
    const validBytes = s.f.review.completeAnalysis({...input,bodyJson: 'not JSON\r\n'});assert.equal(validBytes.disposition,'rejected');
  } finally {await s.f.close();}
});

test('A4: teacher replacement requires a new verified basis and defer preserves uncertainty and decision history',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup({process: true});
  try {
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    const target = (await s.state()).claims[0],file = (await s.attempt()).files[0];
    const saved = await command(s.f,s.student,`/api/attempts/${s.attemptId}/sync`,{expectedWorkspaceRevision: 1,clientId: 'page',clientSeq: 2,process: {captureRevision: 0},
      operations: [{kind: 'update',fileId: file.fileId,baseVersion: file.documentVersion,text: 'int main(void){return 2;}\n'}]});assert.equal(saved.statusCode,200,saved.body);
    const snap = await command(s.f,s.student,`/api/attempts/${s.attemptId}/snapshots`,{expectedWorkspaceRevision: 2});assert.equal(snap.statusCode,200,snap.body);
    const snapshotId = snap.json().data.result.snapshotId;
    const replacement = candidate(snapshotId,s.activityId,{statement: 'Synthetic teacher judgment on the revised work'}).claims[0];
    const correction = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{targetRef: {kind: 'claim',id: target.claimId,revision: 1},expectedStateRevision: 1,
      decision: 'correct',reason: 'Review revised evidence',evidenceRefs: [{kind: 'snapshot',id: snapshotId,attemptId: s.attemptId}],replacement});
    assert.equal(correction.statusCode,200,correction.body);const state = await s.state();assert.equal(state.learnerStateRevision,2);
    const newClaim = state.claims.find((c: {claimId:string}) => c.claimId !== target.claimId);assert.equal(newClaim.source,'teacher_judgment');
    assert.equal(newClaim.sourceId,correction.json().data.result.decisionId);assert.equal(newClaim.claimRevision,1);
    const defer = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{targetRef: {kind: 'claim',id: newClaim.claimId,revision: 1},expectedStateRevision: 2,
      decision: 'defer',reason: 'Need the student explanation',evidenceRefs: []});assert.equal(defer.statusCode,200,defer.body);
    const deferred = await s.state();assert.equal(deferred.learnerStateRevision,3);assert.equal(deferred.decisions.length,2);
    const current = deferred.claims.find((c: {claimId:string}) => c.claimId === newClaim.claimId);assert.equal(current.validity,'contested');assert.equal(current.unresolved,true);
    const stale = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{targetRef: {kind: 'claim',id: target.claimId,revision: 1},expectedStateRevision: 1,
      decision: 'confirm',reason: 'Stale form',evidenceRefs: []});assert.equal(stale.statusCode,409,stale.body);
    assert.equal(stale.json().error.code,'VERSION_CONFLICT');assert.equal((await s.state()).learnerStateRevision,3);
  } finally {await s.f.close();}
});

test('A4: a late dispute write failure restores the prior basis, epochs, Job, events, and retry identity',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const first = await s.queue(),firstLease = s.f.review.claimAnalysis(first.jobId)!;
    s.f.review.completeAnalysis({jobId: first.jobId,leaseToken: firstLease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    const target = (await s.state()).claims[0],pending = await s.queue();s.f.review.claimAnalysis(pending.jobId);
    const state = await s.state(),control = (await s.attempt()).attempt;
    const job = async () => (await s.f.app.inject({url: `/api/jobs/${pending.jobId}`,headers: s.student})).json().data;
    const events = async () => (await s.f.app.inject({url: `/api/attempts/${s.attemptId}/events?recoveryGeneration=generation&decisionEpoch=${control.decisionEpoch}&limit=100`,headers: s.teacher})).json().data;
    const beforeJob = await job(),beforeEvents = await events();
    const input = {targetRef: {kind: 'claim',id: target.claimId,revision: 1},expectedStateRevision: 1,reason: 'Synthetic student disputes this interpretation'};
    s.f.injectFailure('INSERT INTO learner_disputes');
    const failed = await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,input,'atomic-dispute');
    assert.equal(failed.statusCode,503,failed.body);assert.equal(failed.json().error.code,'PERSISTENCE_UNAVAILABLE');
    s.f.injectFailure('');
    assert.deepEqual(await s.state(),state);assert.deepEqual((await s.attempt()).attempt,control);
    assert.deepEqual(await job(),beforeJob);assert.deepEqual(await events(),beforeEvents);
    const retried = await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,input,'atomic-dispute');
    assert.equal(retried.statusCode,200,retried.body);const committed = await s.state(),afterEvents = await events();
    assert.equal(committed.learnerStateRevision,2);assert.equal(committed.claims[0].validity,'contested');assert.equal(committed.disputes.length,1);
    assert.equal((await job()).stopRequested,true);
    const replay = await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,input,'atomic-dispute');
    assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().data.result.disputeId,retried.json().data.result.disputeId);
    assert.deepEqual(await s.state(),committed);assert.deepEqual(await events(),afterEvents);
  } finally {s.f.injectFailure('');await s.f.close();}
});

test('A4: paused collection blocks a new passive analysis and explicit analysis cannot erase its assistance gap',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup({process: true});
  try {
    const paused = await command(s.f,s.student,`/api/attempts/${s.attemptId}/controls`,{expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision,control: {kind: 'capture',value: false}});
    assert.equal(paused.statusCode,200,paused.body);assert.equal((await s.attempt()).attempt.collecting,false);
    const passive = await command(s.f,s.student,`/fixture/analysis/${s.attemptId}`,{expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision,
      expectedStateRevision: 0,purpose: 'passive_analysis',inputRefs: [{kind: 'snapshot',id: s.snapshotId,attemptId: s.attemptId}],assistanceRefs: [],coverageRefs: []});
    assert.equal(passive.statusCode,409,passive.body);assert.equal(passive.json().error.code,'STATE_CONFLICT');
    const wrong = await s.queue(),lease = s.f.review.claimAnalysis(wrong.jobId)!;
    const refused = s.f.review.completeAnalysis({jobId: wrong.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId,{assistanceStatus: 'none_observed_in_system',unresolved: false,unknown: []}))});
    assert.equal(refused.disposition,'rejected');assert.equal(refused.reason,'INVALID_REFERENCE');assert.equal((await s.state()).learnerStateRevision,0);
    const allowed = await s.queue(),allowedLease = s.f.review.claimAnalysis(allowed.jobId)!;
    const accepted = s.f.review.completeAnalysis({jobId: allowed.jobId,leaseToken: allowedLease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId,{unknown: ['Collection is paused; assistance outside captured events is unknown']}))});
    assert.equal(accepted.disposition,'accepted');const claim = (await s.state()).claims[0];
    assert.equal(claim.assistanceStatus,'unknown');assert.equal(claim.unresolved,true);assert.equal((await s.attempt()).attempt.collecting,false);
  } finally {await s.f.close();}
});

test('A4: candidate admission wins before an old teacher form and the stale form cannot overwrite it',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const accept = async (extra: object = {}) => {
      const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
      return s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId,extra))});
    };
    await accept();const first = (await s.state()).claims[0];
    const oldForm = {targetRef: {kind: 'claim',id: first.claimId,revision: first.claimRevision},expectedStateRevision: 1,decision: 'defer',reason: 'Synthetic teacher will inspect later',evidenceRefs: []};
    const newAnalysis = await accept({competencyId: 'p',domain: 'project'});assert.equal(newAnalysis.disposition,'accepted');
    const state = await s.state(),control = (await s.attempt()).attempt;assert.equal(state.learnerStateRevision,2);
    const failed = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,oldForm,'teacher-before-candidate');
    assert.equal(failed.statusCode,409,failed.body);assert.equal(failed.json().error.code,'VERSION_CONFLICT');
    assert.deepEqual(await s.state(),state);assert.deepEqual((await s.attempt()).attempt,control);
    const currentForm = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{...oldForm,expectedStateRevision: 2},'teacher-after-candidate');
    assert.equal(currentForm.statusCode,200,currentForm.body);assert.equal((await s.state()).learnerStateRevision,3);assert.equal((await s.state()).decisions.length,1);
  } finally {await s.f.close();}
});

test('A4: an evidence storage outage rolls back analysis rather than becoming a model rejection',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    const input = {jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))};
    const before = await s.state(),job = async () => (await s.f.app.inject({url: `/api/jobs/${queued.jobId}`,headers: s.student})).json().data;
    const beforeJob = await job();
    s.f.injectReadFailure('SELECT * FROM workspace_files');
    assert.throws(() => s.f.review.completeAnalysis(input),(error: unknown) => (error as {code?: string}).code === 'PERSISTENCE_UNAVAILABLE');
    s.f.injectReadFailure('');
    assert.deepEqual(await s.state(),before);assert.deepEqual(await job(),beforeJob);
    const notStored = await s.f.app.inject({url: `/fixture/analysis/${s.attemptId}/${queued.jobId}`,headers: s.teacher});
    assert.equal(notStored.statusCode,422,notStored.body);assert.equal(notStored.json().error.code,'INVALID_REFERENCE');
    const retried = s.f.review.completeAnalysis(input);assert.equal(retried.disposition,'accepted');assert.equal((await s.state()).learnerStateRevision,1);
  } finally {s.f.injectReadFailure('');await s.f.close();}
});

test('A4: a damaged original queue receipt cannot grant an analysis execution lease',async () => {
  const {setup} = await import('./review-support.ts');const s = await setup();
  try {
    const queued = await s.queue([]);
    const readJob = async () => (await s.f.app.inject({url: `/api/jobs/${queued.jobId}`,headers: s.student})).json().data;
    const job = await readJob();
    // Approved fault injection: corrupt a receipt column while preserving its original JSON.
    s.f.db.withTransaction(tx => tx.run('UPDATE command_receipts SET actor_id=? WHERE receipt_id=?','other',job.requestReceiptId));
    try {assert.throws(() => s.f.review.claimAnalysis(queued.jobId),(error: unknown) => (error as {code?:string}).code === 'PERSISTENCE_UNAVAILABLE');}
    finally {s.f.db.withTransaction(tx => tx.run('UPDATE command_receipts SET actor_id=? WHERE receipt_id=?','student',job.requestReceiptId));}
    assert.deepEqual(await readJob(),job);
  } finally {await s.f.close();}
});

test('A4: a teacher decision reference inherits its primitive basis and cannot launder a later withdrawal',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup();
  try {
    const first = await s.queue(),lease = s.f.review.claimAnalysis(first.jobId)!;
    s.f.review.completeAnalysis({jobId: first.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    const target = (await s.state()).claims[0];
    const confirmed = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{targetRef: {kind: 'claim',id: target.claimId,revision: 1},expectedStateRevision: 1,
      decision: 'confirm',reason: 'Synthetic teacher retains the insufficient judgment',evidenceRefs: []});assert.equal(confirmed.statusCode,200,confirmed.body);
    const decisionId = confirmed.json().data.result.decisionId;
    const basedOnDecision = await s.queue([{kind: 'teacher_decision',id: decisionId}]),decisionLease = s.f.review.claimAnalysis(basedOnDecision.jobId)!;
    const result = s.f.review.completeAnalysis({jobId: basedOnDecision.jobId,leaseToken: decisionLease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(decisionId,s.activityId,{competencyId: 'p',domain: 'project'}))});assert.equal(result.disposition,'accepted');
    const related = (await s.state()).claims.find((value: {competencyId:string}) => value.competencyId === 'p');assert.deepEqual(related.evidenceGroupIds,[s.attemptId]);
    const corrected = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{targetRef: {kind: 'claim',id: target.claimId,revision: 2},expectedStateRevision: 3,
      decision: 'correct',reason: 'Synthetic teacher withdraws the underlying interpretation',evidenceRefs: []});assert.equal(corrected.statusCode,200,corrected.body);
    const state = await s.state(),derived = state.claims.find((value: {claimId:string}) => value.claimId === related.claimId);
    assert.equal(derived.validity,'contested');assert.equal(derived.basisAvailable,false);
    const oldDecision = await command(s.f,s.student,`/fixture/analysis/${s.attemptId}`,{expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision,expectedStateRevision: 4,
      purpose: 'explicit_analysis',inputRefs: [{kind: 'teacher_decision',id: decisionId}],assistanceRefs: [],coverageRefs: []});
    assert.equal(oldDecision.statusCode,422,oldDecision.body);assert.equal(oldDecision.json().error.code,'INVALID_REFERENCE');
  } finally {await s.f.close();}
});

test('A4: an in-flight explicit analysis survives capture changes and retains the original binding and real coverage gap',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup({process: true});
  try {
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId)!;
    const before = (await s.attempt()).attempt;
    for (const value of [false,true]) {
      const changed = await command(s.f,s.student,`/api/attempts/${s.attemptId}/controls`,{expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision,control: {kind: 'capture',value}});
      assert.equal(changed.statusCode,200,changed.body);
    }
    const control = (await s.attempt()).attempt;
    assert.equal(control.decisionEpoch,before.decisionEpoch);assert.equal(control.collecting,true);assert.equal(control.captureRevision,before.captureRevision+2);
    const job = (await s.attempt()).jobs.find((value: {jobId:string}) => value.jobId === queued.jobId);
    assert.equal(job.status,'running');assert.equal(job.stopRequested,false);
    const raw = JSON.stringify(candidate(s.snapshotId,s.activityId,{unknown: ['Collection was paused while the explicit request was running']}));
    const completed = s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,recoveryGeneration: s.f.generation(),bodyJson: raw});
    assert.equal(completed.disposition,'accepted');assert.equal(completed.learnerStateRevision,1);
    const claim = (await s.state()).claims[0];assert.equal(claim.assistanceStatus,'unknown');assert.equal(claim.unresolved,true);
    const coverage = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/coverage`,headers: s.student});
    assert.equal(coverage.statusCode,200,coverage.body);assert.ok(coverage.json().data.intervals.some((value: {state:string}) => value.state === 'paused'));
    const archived = await s.f.app.inject({url: `/fixture/analysis/${s.attemptId}/${queued.jobId}`,headers: s.teacher});
    assert.equal(archived.statusCode,200,archived.body);assert.equal(archived.json().data.rawBodyText,raw);
    assert.equal(queued.binding.captureRevision,before.captureRevision);
  } finally {await s.f.close();}
});

test('A4: received help without a display receipt remains an unresolved assistance gap',async () => {
  const {setup,candidate} = await import('./review-support.ts');const s = await setup({process: true});
  try {
    const help = await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question: 'Explain the approach',expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision});
    assert.equal(help.statusCode,200,help.body);
    const executed = await command(s.f,s.student,`/fixture/execute/${s.attemptId}/${help.json().data.result.jobId}`,{});
    assert.equal(executed.statusCode,200,executed.body);const action = executed.json().data.delivery,control = (await s.attempt()).attempt;
    assert.equal(action.disposition,'pending');
    const events = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/events?clientId=page&recoveryGeneration=generation&decisionEpoch=${control.decisionEpoch}&limit=100`,headers: s.student});
    assert.equal(events.statusCode,200,events.body);
    const delivered = events.json().data.events.find((value: {payload?: {actionId:string}}) => value.payload?.actionId === action.actionId)?.payload;
    assert.ok(delivered);
    const received = await command(s.f,s.student,`/api/actions/${action.actionId}/receipts`,{deliveryId: delivered.deliveryId,clientId: 'page',contentHash: action.contentHash,
      receiptKind: 'received',clientReceiptId: 'received-'+action.actionId});assert.equal(received.statusCode,200,received.body);
    const records = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/teaching-records`,headers: s.student});
    assert.equal(records.statusCode,200,records.body);assert.deepEqual(records.json().data.actions,[]);
    const coverage = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/coverage`,headers: s.student});
    assert.equal(coverage.statusCode,200,coverage.body);assert.equal(coverage.json().data.collecting,true);
    assert.ok(coverage.json().data.intervals.every((value: {state:string;rejections:unknown[]}) => value.state !== 'paused' && value.rejections.length === 0));
    const observed = await s.queue(),observedLease = s.f.review.claimAnalysis(observed.jobId)!;
    const wrongObservation = s.f.review.completeAnalysis({jobId: observed.jobId,leaseToken: observedLease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId,{assistanceStatus: 'observed_help'}))});
    assert.equal(wrongObservation.disposition,'rejected');assert.equal(wrongObservation.reason,'INVALID_REFERENCE');
    const none = await s.queue(),noneLease = s.f.review.claimAnalysis(none.jobId)!;
    const missingDisplay = s.f.review.completeAnalysis({jobId: none.jobId,leaseToken: noneLease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId,{assistanceStatus: 'none_observed_in_system',unknown: [],unresolved: false}))});
    assert.equal(missingDisplay.disposition,'rejected');assert.equal(missingDisplay.reason,'INVALID_REFERENCE');assert.equal((await s.state()).learnerStateRevision,0);
    const unknown = await s.queue(),unknownLease = s.f.review.claimAnalysis(unknown.jobId)!;
    const accepted = s.f.review.completeAnalysis({jobId: unknown.jobId,leaseToken: unknownLease.leaseToken,recoveryGeneration: s.f.generation(),
      bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId,{unknown: ['The client received help but has not reported it displayed']}))});
    assert.equal(accepted.disposition,'accepted');const claim = (await s.state()).claims[0];assert.equal(claim.assistanceStatus,'unknown');assert.equal(claim.unresolved,true);
    const history = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/teaching-records`,headers: s.teacher});
    assert.equal(history.statusCode,200,history.body);assert.equal(history.json().data.actions[0].receipts[0].receiptKind,'received');
  } finally {await s.f.close();}
});

test('A4: event delivery checks current revision without requiring the full evidence projection',async()=>{
 const {setup,candidate}=await import('./review-support.ts');const s=await setup();
 try{const queued=await s.queue(),lease=s.f.review.claimAnalysis(queued.jobId)!;s.f.review.completeAnalysis({jobId:queued.jobId,leaseToken:lease.leaseToken,recoveryGeneration:s.f.generation(),bodyJson:JSON.stringify(candidate(s.snapshotId,s.activityId))});
 const help=await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{question:'Explain this',expectedAttemptRevision:(await s.attempt()).attempt.attemptRevision});assert.equal(help.statusCode,200,help.body);
 const executed=await command(s.f,s.student,`/fixture/execute/${s.attemptId}/${help.json().data.result.jobId}`,{});assert.equal(executed.statusCode,200,executed.body);const control=(await s.attempt()).attempt;
 s.f.injectReadFailure('artifact_snapshots');const unavailable=await s.f.app.inject({url:`/api/attempts/${s.attemptId}/learner-state`,headers:s.student});assert.equal(unavailable.statusCode,503,unavailable.body);
 const events=await s.f.app.inject({url:`/api/attempts/${s.attemptId}/events?clientId=revision-page&recoveryGeneration=generation&decisionEpoch=${control.decisionEpoch}&limit=100`,headers:s.student});assert.equal(events.statusCode,200,events.body);assert(events.json().data.events.some((event:{payload?:{actionId:string}})=>event.payload?.actionId===executed.json().data.delivery.actionId));assert(events.body.includes('Synthetic hint: explain the approach'));
 }finally{await s.f.close();}
});

test('A4: review and dispute receipts distinguish first commit and replay without another state change',async()=>{
 const {setup,candidate}=await import('./review-support.ts');const s=await setup();
 try{const queued=await s.queue(),lease=s.f.review.claimAnalysis(queued.jobId)!;s.f.review.completeAnalysis({jobId:queued.jobId,leaseToken:lease.leaseToken,recoveryGeneration:s.f.generation(),bodyJson:JSON.stringify(candidate(s.snapshotId,s.activityId))});const claim=(await s.state()).claims[0];
 const input={targetRef:{kind:'claim',id:claim.claimId,revision:claim.claimRevision},expectedStateRevision:1,decision:'defer',reason:'More evidence needed',evidenceRefs:[]};
 const first=await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,input,'review-flag');assert.equal(first.statusCode,200,first.body);assert.equal(first.json().data.replayed,false);
 const replay=await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,input,'review-flag');assert.equal(replay.json().data.replayed,true);assert.deepEqual(replay.json().data.result,first.json().data.result);
 const state=await s.state(),current=state.claims[0],disputeInput={targetRef:{kind:'claim',id:current.claimId,revision:current.claimRevision},expectedStateRevision:state.learnerStateRevision,reason:'I have a different explanation'};
 const dispute=await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,disputeInput,'dispute-flag');assert.equal(dispute.statusCode,200,dispute.body);assert.equal(dispute.json().data.replayed,false);
 const repeated=await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,disputeInput,'dispute-flag');assert.equal(repeated.json().data.replayed,true);assert.deepEqual(repeated.json().data.result,dispute.json().data.result);assert.equal((await s.state()).learnerStateRevision,dispute.json().data.result.learnerStateRevision);
 }finally{await s.f.close();}
});

test('A4: independent fresh factory stays within the approved 31-table scope and retains its database',async()=>{
 const {createReviewDatabase,openSyntheticDatabase}=await import('../server/db/transaction.ts');let db=createReviewDatabase();const file=db.file;
 try{const tables=db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"));assert.equal(tables.length,31);assert(!tables.some(row=>['workspace_submissions','workspace_reopen_grants'].includes(String(row.name))));db.close();db=openSyntheticDatabase(file);assert.equal(db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).length,31);
 }finally{db.close();}
});

test('A4: one authorized projection reuses workspace reads but the next read sees corrected state',async()=>{
 const {setup,candidate}=await import('./review-support.ts');const s=await setup();
 try{const base=candidate(s.snapshotId,s.activityId),body={...base,claims:[base.claims[0],{...base.claims[0],competencyId:'p',domain:'project'},{...base.claims[0],competencyId:'a',domain:'ai_collaboration'}]};
 const q=await s.queue(),lease=s.f.review.claimAnalysis(q.jobId)!;const result=s.f.review.completeAnalysis({jobId:q.jobId,leaseToken:lease.leaseToken,recoveryGeneration:s.f.generation(),bodyJson:JSON.stringify(body)});assert.equal(result.disposition,'accepted');
 s.f.resetReadMeasurements();const state=await s.state();assert.equal(state.claims.length,3);assert(state.claims.every((c:{basisAvailable:boolean})=>c.basisAvailable));const reads=s.f.snapshotReads();assert(reads<=1,`Single projection repeated the same workspace ${reads} times`);
 const target=state.claims[0];const correction=await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,{targetRef:{kind:'claim',id:target.claimId,revision:target.claimRevision},expectedStateRevision:state.learnerStateRevision,decision:'correct',reason:'Withdraw this basis',evidenceRefs:[]});assert.equal(correction.statusCode,200,correction.body);
 const changed=await s.state();assert(changed.learnerStateRevision>state.learnerStateRevision);assert.equal(changed.claims.find((c:{claimId:string})=>c.claimId===target.claimId).validity,'withdrawn');
 console.info(`A4 projection measurement: 3 claims sharing one workspace, snapshot reads=${reads}; next authorized read observes correction.`);
 }finally{await s.f.close();}
});


test('A4: missing persisted Run input or entry files reject analysis as an invalid reference',async t => {
  const {setup}=await import('./review-support.ts');
  for(const missing of ['input','entry'] as const) await t.test(missing,async()=>{
    const s=await setup();
    try {
      const before=await s.attempt(),file=before.files[0];
      const accepted=await command(s.f,s.student,`/api/attempts/${s.attemptId}/runs`,{
        expectedAttemptRevision:before.attempt.attemptRevision,snapshotId:s.snapshotId,
        runtimeProfileVersion:s.f.profile.runtimeProfileVersion,entryFileId:file.fileId,
        input:{operation:'stats',fileIds:[file.fileId]},mode:'run'});
      assert.equal(accepted.statusCode,200,accepted.body);
      const runId=accepted.json().data.result.runId,attemptRevision=(await s.attempt()).attempt.attemptRevision;
      // Fault injection changes retained data only; assertions use the authenticated public analysis seam.
      s.f.db.withTransaction(tx=>{
        const row=tx.get('SELECT submission_json FROM workspace_runs WHERE run_id=?',runId)!;
        const submission=JSON.parse(String(row.submission_json));
        if(missing==='input')submission.input.fileIds=['missing-file'];
        else submission.entryFileId='missing-file';
        tx.run('UPDATE workspace_runs SET submission_json=? WHERE run_id=?',JSON.stringify(submission),runId);
      });
      const response=await command(s.f,s.student,`/fixture/analysis/${s.attemptId}`,{
        expectedAttemptRevision:attemptRevision,expectedStateRevision:0,purpose:'explicit_analysis',
        inputRefs:[{kind:'run',id:runId,attemptId:s.attemptId}],assistanceRefs:[],coverageRefs:[]});
      assert.equal(response.statusCode,422,response.body);
      assert.equal(response.json().error.code,'INVALID_REFERENCE');
      assert.equal((await s.state()).learnerStateRevision,0);
    } finally {await s.f.close();}
  });
});


test('A4: reconciling a revised basis preserves the original student cancellation reason',async()=>{
  const {setup,candidate}=await import('./review-support.ts');const s=await setup();
  try {
    const help=await command(s.f,s.student,`/api/attempts/${s.attemptId}/help`,{
      question:'Explain the approach',expectedAttemptRevision:(await s.attempt()).attempt.attemptRevision});
    assert.equal(help.statusCode,200,help.body);const jobId=help.json().data.result.jobId;
    const executed=await command(s.f,s.student,`/fixture/execute/${s.attemptId}/${jobId}`,{});
    assert.equal(executed.statusCode,200,executed.body);const original=executed.json().data.delivery;
    const cancelled=await command(s.f,s.student,`/api/jobs/${jobId}/cancel`,{reason:'student_stopped'});
    assert.equal(cancelled.statusCode,200,cancelled.body);
    const history=async()=>{
      const response=await s.f.app.inject({url:`/api/attempts/${s.attemptId}/teaching-records`,headers:s.teacher});
      assert.equal(response.statusCode,200,response.body);
      return response.json().data.actions.find((a:{actionId:string})=>a.actionId===original.actionId);
    };
    const before=await history();assert.equal(before.disposition,'cancelled');assert.equal(before.stopReason,'student_stopped');
    const queued=await s.queue(),lease=s.f.review.claimAnalysis(queued.jobId)!;
    const analysis=s.f.review.completeAnalysis({jobId:queued.jobId,leaseToken:lease.leaseToken,recoveryGeneration:s.f.generation(),
      bodyJson:JSON.stringify(candidate(s.snapshotId,s.activityId))});assert.equal(analysis.disposition,'accepted');
    const attempt=(await s.attempt()).attempt;
    const poll=await s.f.app.inject({url:`/api/attempts/${s.attemptId}/events?clientId=page&recoveryGeneration=generation&decisionEpoch=${attempt.decisionEpoch}&limit=100`,headers:s.student});
    assert.equal(poll.statusCode,200,poll.body);
    const after=await history();assert.equal(after.basisRevised,true);
    assert.equal(after.disposition,'cancelled');assert.equal(after.stopReason,'student_stopped');
    assert.equal(after.actionId,before.actionId);assert.equal(after.contentHash,before.contentHash);
    assert.deepEqual(after.receipts,before.receipts);
    const repeat=await command(s.f,s.student,`/api/jobs/${jobId}/cancel`,{reason:'student_stopped'});
    assert.equal(repeat.statusCode,200,repeat.body);assert.deepEqual((await history()),after);
  } finally {await s.f.close();}
});
