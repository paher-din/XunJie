import assert from 'node:assert/strict';
import { test } from 'node:test';
import { command,setup } from './review-support.ts';

// A5 batch two: after a teacher has reviewed one attempt, the next version of the project is created by copying the
// blueprint the reviewed activity version came from, and the new attempt reads only the applicable, still-valid
// history. Everything here reuses A2's copy/check/release/assign chain, C2's attempt creation and A4's state read;
// the only production addition is the teacher-visible `sourceBlueprintId` on the activity view.

/** Copies the blueprint behind the given fixed activity version into a fresh draft, the way M-08 describes. */
async function copyFromActivity(s: Awaited<ReturnType<typeof setup>>, activityVersionId: string,
  sourceRevision: number, patch: object) {
  const view = await s.f.app.inject({url: `/api/activities/${activityVersionId}`,headers: s.teacher});
  assert.equal(view.statusCode,200,view.body);
  const sourceBlueprintId = view.json().data.sourceBlueprintId as string;
  assert.ok(sourceBlueprintId,'the responsible teacher resolves the fixed version back to its blueprint');
  const copied = await command(s.f,s.teacher,'/api/courses/course/blueprints',
    {mode: 'copy',sourceBlueprintId,expectedSourceRevision: sourceRevision},'a5-copy');
  assert.equal(copied.statusCode,200,copied.body);
  const draft = copied.json().data.result.draft as {blueprintId: string;revision: number;
    source: {blueprintId: string;revision: number}};
  assert.notEqual(draft.blueprintId,sourceBlueprintId);
  assert.equal(draft.revision,1);
  assert.deepEqual(draft.source,{courseId: 'course',blueprintId: sourceBlueprintId,revision: sourceRevision});
  // The teacher's change lands in the new version; the copied-from draft is not rewritten by it.
  const edited = await command(s.f,s.teacher,`/api/blueprints/${draft.blueprintId}`,
    {expectedRevision: 1,patch},'a5-copy-edit','PATCH');
  assert.equal(edited.statusCode,200,edited.body);
  return {blueprintId: draft.blueprintId,sourceBlueprintId,sourceRevision};
}

test('A5: the next project version is copied from the reviewed blueprint and assigned as a new attempt',async () => {
  const s = await setup();
  try {
    // The student cannot see design-side provenance even though the teacher can.
    const asStudent = await s.f.app.inject({url: `/api/activities/${s.activityId}`,headers: s.student});
    assert.equal(asStudent.statusCode,200,asStudent.body);
    assert.equal(Object.hasOwn(asStudent.json().data,'sourceBlueprintId'),false);
    const sourceBefore = await s.f.app.inject({url: `/api/activities/${s.activityId}`,headers: s.teacher});
    const sourceTitle = sourceBefore.json().data.content.content.projectTitle as string;
    const copied = await copyFromActivity(s,s.activityId,1,{projectTitle: 'TextScope revised'});
    // The copied-from draft keeps its own revision and content: editing the new version never rewrites old requirements.
    const sourceAfter = await s.f.app.inject({url: `/api/blueprints/${copied.sourceBlueprintId}`,headers: s.teacher});
    assert.equal(sourceAfter.statusCode,200,sourceAfter.body);
    assert.equal(sourceAfter.json().data.revision,copied.sourceRevision);
    assert.equal(sourceAfter.json().data.content.projectTitle,sourceTitle);
    const newDraft = await s.f.app.inject({url: `/api/blueprints/${copied.blueprintId}`,headers: s.teacher});
    assert.equal(newDraft.json().data.content.projectTitle,'TextScope revised');
    assert.equal(newDraft.json().data.revision,2);
    const check = await command(s.f,s.teacher,`/api/blueprints/${copied.blueprintId}/checks`,{expectedRevision: 2});
    assert.equal(check.statusCode,200,check.body);
    const release = await command(s.f,s.teacher,`/api/blueprints/${copied.blueprintId}/releases`,{expectedRevision: 2,confirmed: true});
    assert.equal(release.statusCode,200,release.body);
    const nextActivityId = release.json().data.result.activityVersionId as string;
    assert.notEqual(nextActivityId,s.activityId);
    const nextRelease = await s.f.app.inject({url: `/api/activities/${nextActivityId}`,headers: s.teacher});
    assert.equal(nextRelease.json().data.sourceBlueprintId,copied.blueprintId);
    const allocated = await command(s.f,s.teacher,`/api/activities/${nextActivityId}/assignments`,
      {expectedActivityControlRevision: 1,studentIds: ['student']});
    assert.equal(allocated.statusCode,200,allocated.body);
    const nextAllocationId = allocated.json().data.result.assignments[0].assignmentId as string;
    const opened = await command(s.f,s.student,`/api/assignments/${nextAllocationId}/attempts`,{});
    assert.equal(opened.statusCode,200,opened.body);
    const nextAttemptId = opened.json().data.result.attemptId as string;
    assert.notEqual(nextAttemptId,s.attemptId);
    const next = await s.f.app.inject({url: `/api/attempts/${nextAttemptId}`,headers: s.student});
    assert.equal(next.statusCode,200,next.body);
    assert.equal(next.json().data.attempt.activityVersionId,nextActivityId);
    // The reviewed attempt keeps pointing at the old fixed version.
    assert.equal((await s.attempt()).attempt.activityVersionId,s.activityId);
  } finally { await s.f.close(); }
});

test('A5: the follow-up attempt reads applicable valid history and carries no withdrawn or unrelated claims',async () => {
  const s = await setup();
  try {
    const base = (await import('./review-support.ts')).candidate(s.snapshotId,s.activityId) as {claims: object[]};
    const claim = (base.claims as {competencyId: string;competencyVersion: number;domain: string}[])[0]!;
    const body = {kind: 'learner_analysis',claims: [
      {...claim,scope: {kind: 'course'},statement: 'Course-scope explanation, unresolved',unresolved: true,assistanceStatus: 'unknown'},
      {...claim,competencyId: 'p',domain: 'project',scope: {kind: 'course'},statement: 'Compare routes'},
      {...claim,competencyId: 'a',domain: 'ai_collaboration',scope: {kind: 'activity',activityVersionId: s.activityId},statement: 'Checks AI output'},
    ]};
    const queued = await s.queue(),lease = s.f.review.claimAnalysis(queued.jobId);
    assert.ok(lease);
    const accepted = s.f.review.completeAnalysis({jobId: queued.jobId,leaseToken: lease.leaseToken,
      recoveryGeneration: s.f.generation(),bodyJson: JSON.stringify(body)});
    assert.equal(accepted.disposition,'accepted');
    assert.equal(accepted.claimIds.length,3);
    const course = accepted.claimIds[0]!,project = accepted.claimIds[1]!,ai = accepted.claimIds[2]!;
    // The teacher withdraws the first course-scope claim; its basis must stop being usable.
    const correction = await command(s.f,s.teacher,`/api/attempts/${s.attemptId}/reviews`,
      {targetRef: {kind: 'claim',id: course,revision: 1},expectedStateRevision: (await s.state()).learnerStateRevision,
        decision: 'correct',reason: 'The explanation overstates what the file shows',evidenceRefs: []},'a5-correct');
    assert.equal(correction.statusCode,200,correction.body);
    // AC-09's chain starts from a fixed submission closed by a formal feedback, not from the claim correction above:
    // a `reviews` decision is a judgment about claims, while a formal `Feedback` is the evaluation of the artifact.
    const submission = await s.submit({reflection: 'My own account of the route comparison'});
    const sealed = await s.feedback({kind: 'submission_review',submissionId: submission.submissionId,
      summary: 'The comparison is present; state the trade-off explicitly.',reason: 'Rubric criterion r',evidenceRefs: []});
    assert.equal(sealed.statusCode,200,sealed.body);
    assert.equal(sealed.json().data.result.reviewed,true);
    assert.equal((await s.attempt()).attempt.status,'reviewed');
    const sealedView = await s.feedbackView(s.student);
    assert.equal(sealedView.entries.length,1);
    assert.equal(sealedView.entries[0]!.kind,'submission_review');
    assert.equal(sealedView.entries[0]!.submissionId,submission.submissionId);
    // The saved evaluation names the exact claims and revisions it rested on: the withdrawn one is already excluded.
    const basisRefs = sealedView.entries[0]!.claimRefs;
    assert.deepEqual(basisRefs.map(ref => ref.revision),[1,1]);
    assert.deepEqual([...basisRefs.map(ref => ref.id)].sort(),[project,ai].sort());
    // The reviewed attempt stays fixed on the original activity version while the follow-up version is built.
    assert.equal((await s.attempt()).attempt.activityVersionId,s.activityId);
    // Now the follow-up version and attempt.
    const {blueprintId: copiedId} = await copyFromActivity(s,s.activityId,1,{projectTitle: 'TextScope follow-up'});
    const check = await command(s.f,s.teacher,`/api/blueprints/${copiedId}/checks`,{expectedRevision: 2});
    assert.equal(check.statusCode,200,check.body);
    const release = await command(s.f,s.teacher,`/api/blueprints/${copiedId}/releases`,{expectedRevision: 2,confirmed: true});
    assert.equal(release.statusCode,200,release.body);
    const nextActivityId = release.json().data.result.activityVersionId as string;
    const allocated = await command(s.f,s.teacher,`/api/activities/${nextActivityId}/assignments`,
      {expectedActivityControlRevision: 1,studentIds: ['student']});
    assert.equal(allocated.statusCode,200,allocated.body);
    const opened = await command(s.f,s.student,`/api/assignments/${allocated.json().data.result.assignments[0].assignmentId}/attempts`,{});
    assert.equal(opened.statusCode,200,opened.body);
    const nextAttemptId = opened.json().data.result.attemptId as string;
    const read = await s.f.app.inject({url: `/api/attempts/${nextAttemptId}/learner-state`,headers: s.student});
    assert.equal(read.statusCode,200,read.body);
    const claims = read.json().data.claims as {claimId: string;competencyId: string;domain: string;validity: string;
      unresolved: boolean;assistanceStatus: string}[];
    const byClaim = new Map(claims.map(entry => [entry.claimId,entry]));
    // Applicable course-scope history is read; the withdrawn claim is present for audit but is not valid.
    assert.equal(byClaim.get(course)!.validity,'withdrawn');
    assert.equal(claims.filter(entry => entry.validity === 'active').some(entry => entry.claimId === course),false);
    const kept = claims.filter(entry => entry.competencyId === 'p').at(-1)!;
    assert.equal(kept.validity,'active');
    // Unknown stays unknown rather than being upgraded into support.
    assert.equal(kept.unresolved,true);
    assert.equal(kept.assistanceStatus,'unknown');
    // The old version's activity-scoped claim is not carried into the new activity version.
    assert.equal(claims.some(entry => entry.competencyId === 'a'),false);
    // The reviewed attempt still holds its own claim, so the exclusion is a projection rule and not a lost record.
    const original = (await s.state()).claims as {claimId: string}[];
    assert.equal(original.some(entry => entry.claimId === project),true);
    // AC-09's full chain: after the formal feedback and the new activity, the follow-up attempt's own help request
    // reads the effective state. The withdrawn claim and the other activity version's claim must not return as
    // current support, and the revision the helper sees is the real one for this course/student.
    const next = await s.f.app.inject({url: `/api/attempts/${nextAttemptId}`,headers: s.student});
    assert.equal(next.statusCode,200,next.body);
    const help = await command(s.f,s.student,`/api/attempts/${nextAttemptId}/help`,
      {question: 'Which route should I compare next, and why?',
        expectedAttemptRevision: (next.json().data.attempt as {attemptRevision: number}).attemptRevision},'a5-follow-up-help');
    assert.equal(help.statusCode,200,help.body);
    const jobId = help.json().data.result.jobId as string;
    const prepared = await s.f.app.inject({method: 'POST',url: `/fixture/prepare/${nextAttemptId}/${jobId}`,
      headers: s.student,payload: {}});
    assert.equal(prepared.statusCode,200,prepared.body);
    const stateRevision = (await s.f.app.inject({url: `/api/attempts/${nextAttemptId}/learner-state`,headers: s.student}))
      .json().data.learnerStateRevision as number;
    // The reference content is JSON embedded in a JSON string, so its keys arrive escaped.
    assert.ok(prepared.body.includes(`learnerStateRevision\\":${stateRevision}`),'the helper reads the real state revision: '+prepared.body);
    assert.ok(prepared.body.includes(`claim:${project}:1`),'the applicable active claim is offered as context');
    assert.equal(prepared.body.includes(course),false,'a withdrawn claim must not come back as current support');
    assert.equal(prepared.body.includes(ai),false,"the other activity version's claim is not applicable here");
  } finally { await s.f.close(); }
});
