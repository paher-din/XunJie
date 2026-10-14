import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidate,command,run,setup,syntheticNode } from './review-support.ts';

// A5's public seams: the teacher feedback/reopen commands, the student/teacher feedback read and READ-11's teacher
// review context. Every case drives the real Fastify route over the real SQLite transaction; only the runner and the
// model provider are the same explicit synthetic stand-ins A4 already uses.

test('A5: formative feedback cites a submission without moving the learning stage',async () => {
  const s = await setup();
  try {
    // Every formal feedback record binds a real fixed submission, so an attempt with none is refused.
    const early = await s.feedback({kind: 'formative',summary: 'Note before submitting',reason: 'Interim',evidenceRefs: []});
    assert.equal(early.statusCode,422,early.body);
    const submission = await s.submit();
    const before = (await s.attempt()).attempt;
    const saved = await s.feedback({kind: 'formative',submissionId: submission.submissionId,
      summary: 'Interim note on the current draft',reason: 'Interim guidance',evidenceRefs: []});
    assert.equal(saved.statusCode,200,saved.body);
    assert.equal(saved.json().data.result.reviewed,false);
    const after = (await s.attempt()).attempt;
    assert.equal(after.status,'submitted');
    // Only the teaching-basis invalidation moves the versions here; the stage itself did not change.
    assert.equal(after.attemptRevision,before.attemptRevision + 1);
    const view = await s.feedbackView(s.student);
    assert.equal(view.feedbackRevision,1);
    assert.equal(view.entries[0]!.kind,'formative');
    // The submission review is still available afterwards and performs the stage move.
    const review = await s.feedback({kind: 'submission_review',submissionId: submission.submissionId,
      summary: 'Final evaluation',reason: 'Rubric criterion r',evidenceRefs: []});
    assert.equal(review.statusCode,200,review.body);
    assert.equal(review.json().data.result.reviewed,true);
    assert.equal((await s.attempt()).attempt.status,'reviewed');
    assert.equal((await s.feedbackView(s.student)).feedbackRevision,2);
  } finally { await s.f.close(); }
});

test('A5: a feedback thread can only be revised inside the scope that owns it',async () => {
  const s = await setup();
  try {
    const submission = await s.submit();
    // Adversarial synthetic precondition: a `feedback_id` that already exists, but under another course. Only the
    // scope check stops a teacher here from appending onto another scope's thread and reading its revision count.
    s.f.db.withTransaction(tx => tx.run(`INSERT INTO teacher_feedback(feedback_id,feedback_revision,course_id,student_id,
      attempt_id,submission_id,teacher_id,kind,expected_state_revision,feedback_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      'foreign-thread',1,'foreign-course','student',s.attemptId,submission.submissionId,'foreign','submission_review',0,
      JSON.stringify({feedbackId: 'foreign-thread',feedbackRevision: 1,courseId: 'foreign-course',studentId: 'student',
        attemptId: s.attemptId,submissionId: submission.submissionId,teacherId: 'foreign',kind: 'submission_review',
        expectedStateRevision: 0,summary: 'Other course evaluation',reason: 'Other course reason',evidenceRefs: [],
        claimRefs: [],createdAt: new Date().toISOString()}),new Date().toISOString()));
    const hijack = await s.feedback({kind: 'formative',feedbackId: 'foreign-thread',submissionId: submission.submissionId,
      summary: 'Appended onto another scope',reason: 'Should be refused',evidenceRefs: []});
    assert.equal(hijack.statusCode,422,hijack.body);
    assert.equal(hijack.json().error.code,'INVALID_REFERENCE');
    // Nothing was appended in this scope, and the foreign row is untouched.
    assert.equal((await s.feedbackView(s.teacher)).feedbackRevision,0);
  } finally { await s.f.close(); }
});

test('A5: the review context keeps an unresolvable competency listed and narrows history to this attempt',async () => {
  const s = await setup();
  try {
    // A claim whose basis names a self-report revision that a later edit makes unreachable: the reference must be
    // reported `unavailable` and the claim must stay in its competency line rather than vanish from the teacher view.
    const first = await command(s.f,s.student,'/api/courses/course/my-context',
      {expectedContextRevision: 0,goals: 'Explain pointers',constraints: 'Time'},'context-one','PATCH');
    assert.equal(first.statusCode,200,first.body);
    const queued = await s.queue([{kind: 'context',id: 'student',revision: 1}]);
    const lease = s.f.review.claimAnalysis(queued.jobId);
    assert.ok(lease);
    const accepted = s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,
      recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate('student',s.activityId))});
    assert.equal(accepted.disposition,'accepted');
    const target = (await s.state()).claims[0]!;
    // A teacher decision about this attempt is recorded, and must not be attributed to another attempt's view.
    const decision = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,
      {targetRef: {kind: 'claim',id: target.claimId,revision: target.claimRevision},expectedStateRevision: 1,
        decision: 'confirm',reason: 'Confirmed from the fixed snapshot',evidenceRefs: []},'confirm-key');
    assert.equal(decision.statusCode,200,decision.body);
    const revised = await command(s.f,s.student,'/api/courses/course/my-context',
      {expectedContextRevision: 1,goals: 'Changed goal',constraints: 'Changed context'},'context-two','PATCH');
    assert.equal(revised.statusCode,200,revised.body);
    const response = await s.reviewContext();
    assert.equal(response.statusCode,200,response.body);
    const data = response.json().data as {competencies: Record<string,{claimId: string;basisAvailable: boolean;
      references: {status: string}[]}[]>;decisions: {attemptId: string}[];disputes: {attemptId: string}[]};
    const listed = Object.values(data.competencies).flat();
    assert.equal(listed.length,1);
    assert.equal(listed[0]!.claimId,target.claimId);
    assert.equal(listed[0]!.basisAvailable,false);
    assert.deepEqual(listed[0]!.references.map(reference => reference.status),['unavailable']);
    assert.deepEqual(data.decisions.map(entry => entry.attemptId),[s.attemptId]);
    assert.deepEqual(data.disputes,[]);
  } finally { await s.f.close(); }
});

test('A5: a teacher reads one attempt context with artifact, help and competency facts kept apart',async () => {
  const s = await setup();
  try {
    await s.submit({reflection: 'Synthetic reflection about the chosen route'});
    const response = await s.reviewContext();
    assert.equal(response.statusCode,200,response.body);
    const data = response.json().data;
    assert.equal(data.submission.reflection,'Synthetic reflection about the chosen route');
    assert.equal(data.submissions.length,1);
    assert.equal(data.submissions[0].latest,true);
    assert.deepEqual(Object.keys(data.competencies).sort(),['ai_collaboration','domain','project']);
    assert.equal(data.learnerStateRevision,0);
    assert.equal(data.feedback.feedbackRevision,0);
    assert.deepEqual(data.feedback.entries,[]);
    assert.equal(data.reopen.state,'none');
    assert.equal(data.attempt.status,'submitted');
    // Artifact facts carry identity/version/hash and never the file text; the private answer never appears at all.
    assert.equal(data.artifact.length,1);
    assert.equal(Object.hasOwn(data.artifact[0],'text'),false);
    assert.equal(data.artifact[0].path,'main.c');
    const serialized = JSON.stringify(data);
    assert.equal(serialized.includes('PRIVATE_BODY'),false);
    assert.equal(serialized.includes('PRIVATE_TITLE'),false);
    // The read is teacher-only and an attempt selects only its own submissions.
    const asStudent = await s.reviewContext(s.student);
    assert.equal(asStudent.statusCode,403,asStudent.body);
    const missing = await s.reviewContext(s.teacher,'not-a-submission');
    assert.equal(missing.statusCode,422,missing.body);
  } finally { await s.f.close(); }
});

test('A5: formal feedback saves in its own record and moves a submitted attempt to reviewed in one transaction',async () => {
  const s = await setup();
  try {
    const submission = await s.submit();
    const before = await s.state();
    // The stage move is one CAS-visible revision step, measured against the attempt as it was before the command.
    const beforeReview = (await s.attempt()).attempt;
    // The exact request body is reused for the replay, because the same key with different input must conflict.
    const requestBody = {expectedFeedbackRevision: 0,expectedStateRevision: 0,
      expectedAttemptRevision: beforeReview.attemptRevision,kind: 'submission_review',
      submissionId: submission.submissionId,
      summary: 'The comparison is present; the reasoning behind the second route is thin.',
      reason: 'Rubric criterion r needs the trade-off stated.',evidenceRefs: []};
    const saved = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/feedback`,requestBody,'feedback-key');
    assert.equal(saved.statusCode,200,saved.body);
    const result = saved.json().data.result;
    assert.equal(result.reviewed,true);assert.equal(result.submissionId,submission.submissionId);
    assert.equal(result.kind,'submission_review');
    const attempt = (await s.attempt()).attempt;
    assert.equal(attempt.status,'reviewed');
    // Two revision steps land in this one transaction: C4's `submitted`→`reviewed` move, and C3's teaching-basis
    // invalidation that the related formal feedback triggers. A page holding the pre-command state must re-sync
    // either way, and the command reports the real post-state rather than its own intermediate value.
    assert.equal(attempt.attemptRevision,beforeReview.attemptRevision + 2);
    assert.equal(attempt.decisionEpoch,beforeReview.decisionEpoch + 2);
    assert.equal(result.attemptRevision,attempt.attemptRevision);
    assert.equal(result.decisionEpoch,attempt.decisionEpoch);
    // A formal evaluation is not a claim correction: the learner state revision is untouched.
    assert.equal((await s.state()).learnerStateRevision,before.learnerStateRevision);
    // Same key and same body returns the original result instead of a second stage move or a second record.
    const replay = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/feedback`,requestBody,'feedback-key');
    assert.equal(replay.statusCode,200,replay.body);
    assert.equal(replay.json().data.replayed,true);
    assert.equal(replay.json().data.result.feedbackId,result.feedbackId);
    assert.equal((await s.feedbackView(s.teacher)).feedbackRevision,1);
    // Reusing the key with different input conflicts instead of silently applying the new input.
    const conflicted = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/feedback`,
      {...requestBody,summary: 'Different summary'},'feedback-key');
    assert.equal(conflicted.statusCode,409,conflicted.body);
    assert.equal(conflicted.json().error.code,'IDEMPOTENCY_CONFLICT');
    // A stale revision CAS and a student writer are both refused.
    const stale = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/feedback`,
      {expectedFeedbackRevision: 0,expectedStateRevision: 0,kind: 'formative',submissionId: submission.submissionId,
        summary: 'Second',reason: 'Second reason',evidenceRefs: []},'stale-key');
    assert.equal(stale.statusCode,409,stale.body);
    const asStudent = await s.feedback({kind: 'formative',submissionId: submission.submissionId,summary: 'Student written',
      reason: 'Student reason',evidenceRefs: []},s.student,'student-key');
    assert.equal(asStudent.statusCode,403,asStudent.body);
  } finally { await s.f.close(); }
});

test('A5: feedback revisions append, stay readable and keep the submission they evaluated',async () => {
  const s = await setup();
  try {
    const submission = await s.submit();
    const first = await s.feedback({kind: 'submission_review',submissionId: submission.submissionId,
      summary: 'First evaluation',reason: 'First reason',evidenceRefs: []});
    assert.equal(first.statusCode,200,first.body);
    const feedbackId = first.json().data.result.feedbackId;
    const second = await s.feedback({kind: 'submission_review',feedbackId,submissionId: submission.submissionId,
      summary: 'Revised evaluation after re-reading the file',reason: 'Second reason',evidenceRefs: []});
    assert.equal(second.statusCode,200,second.body);
    assert.equal(second.json().data.result.feedbackId,feedbackId);
    assert.equal(second.json().data.result.feedbackRevision,2);
    assert.equal(second.json().data.result.reviewed,false);
    const view = await s.feedbackView(s.teacher);
    assert.equal(view.feedbackRevision,2);
    assert.equal(view.entries.length,2);
    assert.equal(view.entries[0]!.feedbackRevision,1);assert.equal(view.entries[0]!.current,false);
    assert.equal(view.entries[1]!.feedbackRevision,2);assert.equal(view.entries[1]!.current,true);
    assert.deepEqual(view.entries.map(entry => entry.submissionId),[submission.submissionId,submission.submissionId]);
    // The student reads the same formal feedback about their own attempt.
    const studentView = await s.feedbackView(s.student);
    assert.equal(studentView.feedbackRevision,2);
    assert.equal(studentView.entries[1]!.current,true);
    // A revision of a feedback thread that was never saved is not a new thread.
    const unknown = await s.feedback({kind: 'formative',feedbackId: 'never-saved',submissionId: submission.submissionId,
      summary: 'Third',reason: 'Third reason',evidenceRefs: []});
    assert.equal(unknown.statusCode,422,unknown.body);
  } finally { await s.f.close(); }
});

test('A5: the revision permission keeps the artifact read-only until the student consumes it',async () => {
  const s = await setup();
  try {
    const submission = await s.submit();
    // A permission on an attempt that has not been reviewed is refused; C4 owns that stage guard.
    const early = await s.reopenGrant({submissionId: submission.submissionId,reason: 'Too early'});
    assert.equal(early.statusCode,409,early.body);
    const review = await s.feedback({kind: 'submission_review',submissionId: submission.submissionId,
      summary: 'Needs a revision of the second route',reason: 'Rubric criterion r',evidenceRefs: []});
    assert.equal(review.statusCode,200,review.body);
    const granted = await s.reopenGrant({submissionId: submission.submissionId,reason: 'Please revise the route comparison'});
    assert.equal(granted.statusCode,200,granted.body);
    const grant = granted.json().data.result;
    assert.equal(grant.status,'reviewed');assert.equal(grant.submissionId,submission.submissionId);
    assert.equal((await s.attempt()).attempt.status,'reviewed');
    const view = await s.feedbackView(s.student);
    assert.equal(view.reopen.state,'valid');assert.equal(view.reopen.actionable,true);
    assert.equal(view.reopen.grantId,grant.grantId);
    // The artifact stays read-only until the student's own command consumes the permission.
    const blocked = await command(s.f,s.student,`/api/attempts/${s.attemptId}/sync`,
      {expectedWorkspaceRevision: 1,clientId: 'page',clientSeq: 2,
        operations: [{kind: 'create',clientFileKey: 'second',path: 'second.c',text: 'int x;\n'}]},'blocked-write');
    assert.equal(blocked.statusCode,409,blocked.body);
    const resumed = await command(s.f,s.student,`/api/attempts/${s.attemptId}/controls`,
      {expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision,control: {kind: 'resume_revision'}},'resume-key');
    assert.equal(resumed.statusCode,200,resumed.body);
    assert.equal((await s.attempt()).attempt.status,'active');
    const after = await s.feedbackView(s.student);
    assert.equal(after.reopen.state,'consumed');assert.equal(after.reopen.actionable,false);
    // A second consumption of the same permission is refused; the system never continues on the student's behalf.
    const again = await command(s.f,s.student,`/api/attempts/${s.attemptId}/controls`,
      {expectedAttemptRevision: (await s.attempt()).attempt.attemptRevision,control: {kind: 'resume_revision'}},'resume-again');
    assert.equal(again.statusCode,409,again.body);
    // The old submission and its evaluation survive the revision round trip.
    const context = await s.reviewContext(s.teacher,submission.submissionId);
    assert.equal(context.statusCode,200,context.body);
    assert.equal(context.json().data.submission.submissionId,submission.submissionId);
    assert.equal(context.json().data.submissions[0].latest,true);
    assert.equal(context.json().data.feedback.entries[0].submissionId,submission.submissionId);
  } finally { await s.f.close(); }
});

test('A5: a permission may save the formal feedback for the same submission in one command',async () => {
  const s = await setup();
  try {
    const submission = await s.submit();
    await s.feedback({kind: 'submission_review',submissionId: submission.submissionId,
      summary: 'First evaluation',reason: 'First reason',evidenceRefs: []});
    const combined = await s.reopenGrant({submissionId: submission.submissionId,reason: 'Revise and resubmit',
      feedback: {kind: 'submission_review',expectedFeedbackRevision: 1,expectedStateRevision: 0,
        summary: 'Also add the missing trade-off',reason: 'Second reason',evidenceRefs: []}});
    assert.equal(combined.statusCode,200,combined.body);
    const result = combined.json().data.result;
    assert.ok(result.feedback,combined.body);
    assert.equal(result.feedback!.feedbackRevision,1);
    const view = await s.feedbackView(s.teacher);
    assert.equal(view.feedbackRevision,2);
    assert.equal(view.entries[1]!.feedbackId,result.feedback!.feedbackId);
    assert.equal(view.entries[1]!.submissionId,submission.submissionId);
    assert.equal(view.reopen.state,'valid');assert.equal(view.reopen.actionable,true);
    // The embedded feedback cannot name another submission: the permission is bound to the latest one.
    const other = await s.reopenGrant({submissionId: 'not-the-latest',reason: 'Revise',
      feedback: {kind: 'formative',expectedFeedbackRevision: 2,expectedStateRevision: 0,summary: 'X',reason: 'Y',evidenceRefs: []}});
    assert.equal(other.statusCode,422,other.body);
  } finally { await s.f.close(); }
});

test('A5: a student dispute resolves against the exact saved feedback and its evaluated claims',async () => {
  const s = await setup();
  try {
    const queued = await s.queue(),claimed = s.f.review.claimAnalysis(queued.jobId);
    assert.ok(claimed);
    const accepted = s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: claimed.leaseToken,
      recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(candidate(s.snapshotId,s.activityId))});
    assert.equal(accepted.disposition,'accepted');
    const submission = await s.submit();
    const saved = await s.feedback({kind: 'submission_review',submissionId: submission.submissionId,
      summary: 'Evaluation resting on the current candidate',reason: 'Rubric criterion r',evidenceRefs: []});
    assert.equal(saved.statusCode,200,saved.body);
    const feedbackId = saved.json().data.result.feedbackId;
    const view = await s.feedbackView(s.student);
    assert.equal(view.entries[0]!.claimRefs.length,1);
    assert.equal(view.entries[0]!.claimRefs[0]!.id,accepted.claimIds[0]);
    // Before the dispute the evaluation rests on a still-current basis and no dispute targets it.
    const before = await s.feedbackView(s.student);
    assert.equal(before.entries[0]!.disputed,false);
    assert.deepEqual(before.entries[0]!.basis,[{claimId: accepted.claimIds[0]!,claimRevision: 1,status: 'current'}]);
    // The claim now reaches `contested` and the dependent teaching context is invalidated in the same transaction.
    const dispute = await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,
      {expectedStateRevision: (await s.state()).learnerStateRevision,targetRef: {kind: 'feedback',id: feedbackId,revision: 1},
        reason: 'The evaluation missed the trade-off I did state.'},'dispute-key');
    assert.equal(dispute.statusCode,200,dispute.body);
    assert.equal(dispute.json().data.result.currentTarget,true);
    const state = await s.state();
    assert.equal(state.claims.at(-1).validity,'contested');
    // The same read now marks the revision disputed and reports the basis as revised: the evaluation rested on
    // claim revision 1, the dispute appended a contested revision, and the two must stay distinguishable.
    const after = await s.feedbackView(s.student);
    assert.equal(after.entries[0]!.disputed,true);
    assert.equal(after.entries[0]!.basis[0]!.claimId,accepted.claimIds[0]);
    assert.equal(after.entries[0]!.basis[0]!.status,'revised');
    // A reference to feedback that was never saved stays unresolved instead of inventing a formal record.
    const unknown = await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,
      {expectedStateRevision: state.learnerStateRevision,targetRef: {kind: 'feedback',id: 'never-saved',revision: 1},
        reason: 'Unknown target'},'dispute-unknown');
    assert.equal(unknown.statusCode,422,unknown.body);
  } finally { await s.f.close(); }
});

test('A5: a failing feedback write rolls the record and the stage change back together',async () => {
  const s = await setup();
  try {
    const submission = await s.submit();
    const before = (await s.attempt()).attempt,stateBefore = await s.state();
    s.f.injectFailure('INSERT INTO teacher_feedback');
    const failed = await s.feedback({kind: 'submission_review',submissionId: submission.submissionId,
      summary: 'Should not persist',reason: 'Injected failure',evidenceRefs: []});
    assert.equal(failed.statusCode,503,failed.body);
    s.f.injectFailure('');
    // Neither half of the command survives: the attempt is still `submitted` and no revision was appended.
    const after = (await s.attempt()).attempt;
    assert.equal(after.status,'submitted');
    assert.equal(after.attemptRevision,before.attemptRevision);
    assert.equal(after.decisionEpoch,before.decisionEpoch);
    assert.equal((await s.feedbackView(s.teacher)).feedbackRevision,0);
    assert.equal((await s.state()).learnerStateRevision,stateBefore.learnerStateRevision);
    // The same command then succeeds on a clean store, so the rollback left no partial receipt behind.
    const retried = await s.feedback({kind: 'submission_review',submissionId: submission.submissionId,
      summary: 'Persisted after rollback',reason: 'Retry after failure',evidenceRefs: []});
    assert.equal(retried.statusCode,200,retried.body);
    assert.equal((await s.attempt()).attempt.status,'reviewed');
    assert.equal((await s.feedbackView(s.teacher)).feedbackRevision,1);
  } finally { await s.f.close(); }
});

test('A5: the recovery view reports the real formal feedback and the attempt lifecycle links up end to end',async () => {
  const s = await setup();
  try {
    const initial = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/recovery`,headers: s.student});
    assert.equal(initial.statusCode,200,initial.body);
    assert.equal(initial.json().data.feedback.status,'available');
    assert.equal(initial.json().data.feedback.feedbackRevision,0);
    assert.deepEqual(initial.json().data.feedback.entries,[]);
    // A trusted course check is bound to the submitted snapshot, so the fixed submission carries its real reference.
    s.f.setTransport(syntheticNode('trusted_check'));
    const check = await run(s,'course_check');
    const submission = await s.submit({checkRunIds: [check.runId]});
    const reviewed = await s.feedback({kind: 'submission_review',submissionId: submission.submissionId,
      summary: 'Evaluation with a trusted check present',reason: 'Rubric criterion r',evidenceRefs: []});
    assert.equal(reviewed.statusCode,200,reviewed.body);
    const granted = await s.reopenGrant({submissionId: submission.submissionId,reason: 'Please revise'});
    assert.equal(granted.statusCode,200,granted.body);
    const recovery = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/recovery`,headers: s.student});
    assert.equal(recovery.statusCode,200,recovery.body);
    const data = recovery.json().data as {attempt: {status: string};reopen: {state: string;actionable: boolean};
      runs: {runId: string;mode: string;outcome: string}[];
      feedback: {status: string;feedbackRevision: number;entries: {feedbackId: string;revision: number;submissionId: string}[]}};
    assert.equal(data.feedback.status,'available');
    assert.equal(data.feedback.feedbackRevision,1);
    assert.equal(data.feedback.entries[0]!.revision,1);
    assert.equal(data.feedback.entries[0]!.submissionId,submission.submissionId);
    assert.equal(data.reopen.state,'valid');assert.equal(data.reopen.actionable,true);
    assert.equal(data.attempt.status,'reviewed');
    assert.ok(data.runs.some(entry => entry.mode === 'check' && ['confirmed','incomplete'].includes(entry.outcome)),JSON.stringify(data.runs));
    // The teacher context ties the reviewed submission, its check reference and the formal feedback together.
    const context = await s.reviewContext(s.teacher,submission.submissionId);
    assert.equal(context.statusCode,200,context.body);
    const contextData = context.json().data as {submission: {checkRefs: unknown[]};runs: unknown[];
      feedback: {entries: {submissionId: string}[]};reopen: {actionable: boolean}};
    assert.equal(contextData.submission.checkRefs.length,1);
    assert.equal(contextData.runs.length,1);
    assert.equal(contextData.feedback.entries[0]!.submissionId,submission.submissionId);
    assert.equal(contextData.reopen.actionable,true);
  } finally { await s.f.close(); }
});
