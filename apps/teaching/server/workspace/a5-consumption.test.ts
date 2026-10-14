import assert from 'node:assert/strict';
import test from 'node:test';
import type {AttemptRecovery} from '../../contracts/workspace/index.ts';
import {feedbackResultSchema,reopenResultSchema} from '../../contracts/review/index.ts';
import {command,setup} from '../../tests/review-support.ts';

test('C4/A5: persisted recovery separates scope CAS from exact thread revisions across feedback and reopen',async () => {
  const s = await setup();
  try {
    const submission = await s.submit();
    const first = await s.feedback({kind: 'submission_review',submissionId: submission.submissionId,
      summary: 'Review the fixed artifact',reason: 'Synthetic review',evidenceRefs: []});
    assert.equal(first.statusCode,200,first.body);
    const thread = feedbackResultSchema.parse(first.json().data.result);
    const second = await s.feedback({kind: 'formative',summary: 'Another feedback thread',reason: 'Synthetic note',evidenceRefs: []});
    assert.equal(second.statusCode,200,second.body);
    const other = feedbackResultSchema.parse(second.json().data.result);
    assert.equal(other.threadRevision,1);assert.equal(other.feedbackRevision,2);
    const revised = await s.feedback({kind: 'formative',feedbackId: thread.feedbackId,
      summary: 'Revise the first thread',reason: 'Synthetic correction',evidenceRefs: []});
    assert.equal(revised.statusCode,200,revised.body);
    const revision = feedbackResultSchema.parse(revised.json().data.result);
    assert.equal(revision.threadRevision,2);assert.equal(revision.feedbackRevision,3);
    const granted = await s.reopenGrant({submissionId: submission.submissionId,reason: 'Allow explicit revision',
      feedback: {kind: 'formative',expectedFeedbackRevision: revision.feedbackRevision,expectedStateRevision: 0,
        summary: 'A note accompanying the permission',reason: 'Synthetic permission note',evidenceRefs: []}});
    assert.equal(granted.statusCode,200,granted.body);
    const permission = reopenResultSchema.parse(granted.json().data.result);
    assert.ok(permission.feedback);
    assert.equal(permission.feedback.threadRevision,1);assert.equal(permission.feedback.feedbackRevision,4);

    const recover = async (headers = s.student) => {
      const response = await s.f.app.inject({url: `/api/attempts/${s.attemptId}/recovery`,headers});
      assert.equal(response.statusCode,200,response.body);
      const data = response.json().data as AttemptRecovery;
      assert.equal(data.feedback.status,'available');
      assert.ok(data.feedback.status === 'available');
      return {...data,feedback: data.feedback};
    };
    const before = await recover();
    assert.equal(before.feedback.feedbackRevision,4);
    assert.deepEqual(before.feedback.entries.map(entry => [entry.feedbackId,entry.revision]),
      [[thread.feedbackId,1],[other.feedbackId,1],[thread.feedbackId,2],[permission.feedback.feedbackId,1]]);
    assert.ok(before.feedback.entries.every(entry => entry.submissionId === submission.submissionId));
    assert.equal(before.attempt.status,'reviewed');assert.equal(before.reopen.actionable,true);
    // C supplies the transaction to the attached A5 reader; reopening that database must preserve both counters.
    await s.f.reopen();
    const recovered = await recover();
    assert.deepEqual(recovered.feedback,before.feedback);
    assert.deepEqual((await recover(s.teacher)).feedback,recovered.feedback);
    assert.deepEqual(recovered.reopen,before.reopen);

    const next = await s.feedback({kind: 'formative',feedbackId: thread.feedbackId,
      expectedFeedbackRevision: recovered.feedback.feedbackRevision,
      summary: 'Continue using the recovered scope version',reason: 'Synthetic follow-up',evidenceRefs: []});
    assert.equal(next.statusCode,200,next.body);
    const saved = feedbackResultSchema.parse(next.json().data.result);
    assert.equal(saved.threadRevision,3);assert.equal(saved.feedbackRevision,5);
    const stale = await s.feedback({kind: 'formative',expectedFeedbackRevision: recovered.feedback.feedbackRevision,
      summary: 'Stale page',reason: 'Synthetic stale write',evidenceRefs: []});
    assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().error.code,'VERSION_CONFLICT');

    // The other thread remains at revision 1 despite scope CAS 5; the recovery entry is an exact dispute reference.
    const target = recovered.feedback.entries.find(entry => entry.feedbackId === other.feedbackId)!;
    const dispute = await command(s.f,s.student,`/api/attempts/${s.attemptId}/disputes`,
      {expectedStateRevision: (await s.state()).learnerStateRevision,
        targetRef: {kind: 'feedback',id: target.feedbackId,revision: target.revision},reason: 'Question this exact note'});
    assert.equal(dispute.statusCode,200,dispute.body);
    assert.equal(dispute.json().data.result.currentTarget,true);
    const view = await s.feedbackView();
    assert.equal(view.feedbackRevision,5);
    assert.equal(view.entries.find(entry => entry.feedbackId === other.feedbackId)!.disputed,true);
    assert.equal((await recover()).feedback.feedbackRevision,5);
  } finally { await s.f.close(); }
});
