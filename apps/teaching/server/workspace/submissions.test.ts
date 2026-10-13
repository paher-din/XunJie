import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sha256 } from '../../runner/snapshot.ts';
import { createAttempt, freezeSnapshot } from './snapshots.ts';
import { claimRun, controlCommand, markRunUnknown, readRecovery, reconcileRun, runCommand, submitCommand } from './commands.ts';
import type { CommandContext, RuntimeConfiguration, WorkspaceState } from './commands.ts';
import { latestSubmission, planResumeRevision, planSubmission, reopenView } from './submissions.ts';
import type { SubmissionBasis } from './submissions.ts';
import { validateRunResult } from '../records/runner.ts';
import type { Profile } from '../../contracts/runner/index.ts';
import type { Job, Purpose } from '../../contracts/records/index.ts';
import { assigned, command, files, fixture, grantReopen, markReviewed, opened, recovery, resumeRevision, reviewed,
  snapshot, submit, view } from './test-support.ts';

const clock = '2026-10-12T00:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(clock) + ms).toISOString();
const profile: Profile = { runtimeProfileVersion: 'synthetic-profile', imageDigest: `sha256:${sha256('manifest')}`,
  compilerImage: `sha256:${sha256('compiler')}`, runtimeImage: `sha256:${sha256('runtime')}`, approvedResultFiles: ['report.txt'] };
// The teaching purposes a stage change invalidates. Ordinary runs are deliberately absent (task record §6).
const revisionCancelPurposes: Purpose[] = ['student_help','reminder','explicit_analysis','passive_analysis'];

/** A synthetic attempt holding one confirmed snapshot and one trusted course check whose verdict FAILED. */
function planned(generation = 'gen') {
  const id = `synthetic-${randomUUID()}`;
  const attempt = createAttempt([], { attemptId: id, assignmentId: `assignment-${id}`, activityVersionId: 'synthetic-activity',
    courseId: 'synthetic-course', studentId: 'synthetic-student' }, true);
  const source = '#include <stdio.h>\nint main(void){puts("old snapshot");return 0;}';
  const files = [{ fileId: 'source', attemptId: id, path: 'main.c', text: source, documentVersion: 1,
      contentHash: sha256(source), lifecycle: 'active' as const },
    { fileId: 'input', attemptId: id, path: 'a.txt', text: 'C and memory.\n', documentVersion: 1,
      contentHash: sha256('C and memory.\n'), lifecycle: 'active' as const }];
  const frozen = freezeSnapshot(attempt, files, 0, `snapshot-${id}`, clock);
  const state: WorkspaceState = { attempt, files, snapshots: [frozen], checks: [], runs: [], submissions: [], grants: [],
    records: { receipts: [], commandAliases: [], events: [], jobs: [], serverSeq: 0 } };
  const context = (key: string): CommandContext => ({ identity: { actorId: attempt.studentId, command: 'submissions',
    target: `/api/attempts/${id}/submissions`, scope: { courseId: attempt.courseId, studentId: attempt.studentId, attemptId: id },
    idempotencyKey: key, recoveryGeneration: generation }, generation, now: clock, commandId: `command-${key}`,
    receiptId: `receipt-${key}`, eventId: `event-${key}`, assignmentActive: true, authorize: () => true });
  const runtime: RuntimeConfiguration = { ready: true, recoveryGeneration: generation, profile, policyVersion: 'synthetic-check-policy',
    checkRuleVersion: 'textscope-core-v1', checkCancelPurposes: revisionCancelPurposes };
  const request = { expectedAttemptRevision: 1, snapshotId: frozen.snapshotId, runtimeProfileVersion: profile.runtimeProfileVersion,
    entryFileId: 'source', input: { operation: 'stats' as const, fileIds: ['input'] }, mode: 'course_check' as const };
  const ids = { runId: `run-${id}`, jobId: `job-${id}` };
  const claimed = claimRun(runCommand(state, context('run'), request, runtime, ids, at(100000)).state,
    ids.jobId, 'lease', at(90000), generation, clock);
  const runSubmission = claimed.runs[0]!.submission;
  const record = { runId: ids.runId, snapshotId: request.snapshotId, snapshotHash: runSubmission.identity.snapshotHash,
    inputHash: runSubmission.identity.inputHash, runtimeProfileVersion: profile.runtimeProfileVersion,
    imageDigest: profile.imageDigest, unitTerminated: true, verdict: 'failed' };
  // The failed verdict is a confirmed run fact, so the check stage is ended and the result hash is present.
  const checked = reconcileRun(claimed, ids.jobId, { ...validateRunResult(runSubmission, record), resultRef: 'ref' },
    'lease', generation, at(1000));
  return { id, state: checked, context, snapshot: frozen, ids, revision: checked.attempt.attemptRevision,
    epoch: checked.attempt.decisionEpoch };
}
type Planned = ReturnType<typeof planned>;
const basis = (f: Planned, extra: Partial<SubmissionBasis> = {}): SubmissionBasis =>
  ({ attempt: f.state.attempt, snapshots: f.state.snapshots, submissions: f.state.submissions, grants: f.state.grants,
    runs: f.state.runs, checks: f.state.checks, ...extra });
const submitContext = (key = 'submit') => ({ assignmentActive: true, now: at(2000), generation: 'gen', receiptId: `receipt-${key}` });
const grantOf = (f: Planned, submissionId: string, attemptRevision: number, state: 'valid'|'consumed'|'superseded' = 'valid') =>
  ({ grantId: `grant-${randomUUID()}`, attemptId: f.id, courseId: 'synthetic-course', studentId: 'synthetic-student',
    submissionId, attemptRevision, state, reason: 'Revise the report coverage', grantedBy: 'synthetic-teacher',
    grantedAt: at(3000), receiptId: 'receipt-grant',
    // Only a consumed grant carries consumption facts: the DDL CHECK and `readGrants` both bind
    // `state='consumed'` to the presence of a consuming receipt, so a superseded row must not have one.
    ...(state === 'consumed' ? { consumedReceiptId: 'receipt-old', consumedAt: at(3500) } : {}) });

test('C4-V01 a fixed submission freezes the confirmed snapshot and records a failing verdict without gating', () => {
  const f = planned();
  const plan = planSubmission(basis(f), { expectedAttemptRevision: f.revision, snapshotId: f.snapshot.snapshotId,
    reflection: 'Chose a dynamic array; the merge order is still unclear.', checkRunIds: [f.ids.runId] },
    { submissionId: 'submission-1' }, submitContext());
  assert.equal(plan.attempt.status, 'submitted');
  // Exactly one revision step from the persisted value, so `saveAttempt`'s compare-and-set accepts it.
  assert.equal(plan.attempt.attemptRevision, f.revision + 1);
  assert.equal(plan.attempt.decisionEpoch, f.epoch + 1);
  assert.deepEqual(plan.cancelPurposes, revisionCancelPurposes);
  assert.equal(plan.submission.snapshotId, f.snapshot.snapshotId);
  assert.equal(plan.submission.snapshotHash, f.snapshot.hash);
  assert.equal(plan.submission.workspaceRevision, f.snapshot.workspaceRevision);
  // The submission records the revision the student's CAS named, not the one the attempt moved to.
  assert.equal(plan.submission.attemptRevision, f.revision);
  assert.equal(plan.submission.decisionEpoch, f.epoch);
  assert.equal(plan.submission.reflection, 'Chose a dynamic array; the merge order is still unclear.');
  // A failed course check is a matching reference and never blocks the submission: correctness is the teacher's call.
  assert.deepEqual(plan.submission.checkRefs, [{ runId: f.ids.runId, snapshotId: f.snapshot.snapshotId,
    resultHash: f.state.runs[0]!.resultHash, verdict: 'failed' }]);
  // An active limited-help check phase ends with the submission, monotonically, so tutoring is not left disabled
  // after a later reopen. The already ended phase is unchanged and the input state is never mutated.
  const active = planSubmission(basis(f, { checks: [{ ...f.state.checks[0]!, state: 'active' }] }),
    { expectedAttemptRevision: f.revision, snapshotId: f.snapshot.snapshotId, checkRunIds: [] },
    { submissionId: 'submission-2' }, submitContext());
  assert.deepEqual(active.checks.map(check => check.state), ['ended']);
  assert.equal(f.state.checks[0]!.state, 'ended');
  assert.equal(f.state.attempt.status, 'active');
  assert.equal(f.state.submissions.length, 0);
  // The reflection is optional: the course, not C, decides whether an activity requires one (task record §6).
  assert.equal(active.submission.reflection, undefined);
  assert.equal(active.submission.checkRefs.length, 0);
  // A ready attempt activates and submits in the same single revision step.
  const ready = planned(), fromReady = planSubmission(basis(ready, { attempt: { ...ready.state.attempt,
      status: 'ready', attemptRevision: 1, decisionEpoch: 0 } }),
    { expectedAttemptRevision: 1, snapshotId: ready.snapshot.snapshotId, checkRunIds: [] },
    { submissionId: 'submission-3' }, submitContext());
  assert.equal(fromReady.attempt.attemptRevision, 2);
  assert.equal(fromReady.attempt.status, 'submitted');
});

test('C4-V02 submission guards reject a stale revision, a paused assignment, an unconfirmed snapshot and a mismatched check', () => {
  const f = planned(), ids = { submissionId: 'submission-1' }, context = submitContext();
  const good = { expectedAttemptRevision: f.revision, snapshotId: f.snapshot.snapshotId, checkRunIds: [f.ids.runId] };
  assert.throws(() => planSubmission(basis(f), { ...good, expectedAttemptRevision: f.revision + 1 }, ids, context), /version conflict/i);
  assert.throws(() => planSubmission(basis(f), good, ids, { ...context, assignmentActive: false }), /pause cannot be overridden/i);
  assert.throws(() => planSubmission(basis(f), { ...good, snapshotId: 'unknown-snapshot' }, ids, context), /snapshot unavailable/i);
  // A snapshot of another activity version is not this attempt's confirmed artifact.
  const foreign = { ...f.snapshot, snapshotId: 'foreign', activityVersionId: 'other-activity' };
  assert.throws(() => planSubmission(basis(f, { snapshots: [...f.state.snapshots, foreign] }),
    { ...good, snapshotId: 'foreign' }, ids, context), /snapshot unavailable/i);
  assert.throws(() => planSubmission(basis(f), { ...good, checkRunIds: ['unknown-run'] }, ids, context), /does not match/i);
  assert.throws(() => planSubmission(basis(f), { ...good, checkRunIds: [f.ids.runId, f.ids.runId] }, ids, context), /distinct/i);
  assert.throws(() => planSubmission(basis(f), { ...good, checkRunIds: Array.from({ length: 17 }, () => f.ids.runId) },
    ids, context), /bounded/i);
  // An ordinary run is not a trusted course check.
  const ordinary = { ...f.state.runs[0]!, runId: 'ordinary-run',
    submission: { ...f.state.runs[0]!.submission, mode: 'run' as const } };
  assert.throws(() => planSubmission(basis(f, { runs: [...f.state.runs, ordinary] }),
    { ...good, checkRunIds: ['ordinary-run'] }, ids, context), /does not match/i);
  // A check bound to a different snapshot does not match this submission even though it belongs to the attempt.
  const otherSnapshot = freezeSnapshot(f.state.attempt, f.state.files, 0, 'other-snapshot', at(500));
  const drifted = { ...ordinary, runId: 'drifted-run', submission: { ...ordinary.submission, mode: 'check' as const,
    identity: { ...ordinary.submission.identity, snapshotId: 'other-snapshot' } } };
  assert.throws(() => planSubmission(basis(f, { snapshots: [...f.state.snapshots, otherSnapshot],
    runs: [...f.state.runs, drifted] }), { ...good, checkRunIds: ['drifted-run'] }, ids, context), /does not match/i);
  for (const status of ['submitted','reviewed','paused'] as const)
    assert.throws(() => planSubmission(basis(f, { attempt: { ...f.state.attempt, status } }), good, ids, context), /read-only/i);
  assert.throws(() => planSubmission(basis(f), { ...good, reflection: 'a'.repeat(4097) }, ids, context), /reflection limit/i);
  assert.throws(() => planSubmission(basis(f), { ...good, reflection: '\uD800' }, ids, context), /unicode/i);
  assert.throws(() => planSubmission(basis(f), good, ids, { ...context, now: 'not-a-time' }), /trusted time/i);
  assert.throws(() => planSubmission(basis(f), good, { submissionId: '' }, context), /submission reference/i);
  const done = planSubmission(basis(f), good, ids, context);
  assert.throws(() => planSubmission(basis(f, { submissions: [done.submission] }), good, ids, context), /must be unique/i);
  assert.throws(() => planSubmission(basis(f), { ...good, shell: 'arbitrary' } as never, ids, context), /approved command fields/i);
});

test('C4-V03 resume_revision consumes only a current grant on the latest submission and never reopens by itself', () => {
  const f = planned();
  const submitted = planSubmission(basis(f), { expectedAttemptRevision: f.revision, snapshotId: f.snapshot.snapshotId,
    checkRunIds: [] }, { submissionId: 'submission-1' }, submitContext());
  // The teacher's formal feedback moves the attempt to `reviewed`; C4 consumes that state, it does not create it.
  const reviewedAttempt = { ...submitted.attempt, status: 'reviewed' as const,
    attemptRevision: submitted.attempt.attemptRevision + 1, decisionEpoch: submitted.attempt.decisionEpoch + 1 };
  const reviewedBasis = (extra: Partial<SubmissionBasis> = {}) =>
    basis(f, { attempt: reviewedAttempt, submissions: [submitted.submission], ...extra });
  const reopen = { assignmentActive: true, now: at(4000), receiptId: 'receipt-resume' };
  const grant = grantOf(f, 'submission-1', reviewedAttempt.attemptRevision);
  // Without a grant the reviewed artifact stays read-only: nothing reopens on the student's behalf.
  assert.throws(() => planResumeRevision(reviewedBasis(), reviewedAttempt.attemptRevision, reopen), /reopen permission/i);
  const resumed = planResumeRevision(reviewedBasis({ grants: [grant] }), reviewedAttempt.attemptRevision, reopen);
  assert.equal(resumed.attempt.status, 'active');
  assert.equal(resumed.attempt.attemptRevision, reviewedAttempt.attemptRevision + 1);
  assert.equal(resumed.attempt.decisionEpoch, reviewedAttempt.decisionEpoch + 1);
  assert.equal(resumed.grant.state, 'consumed');
  assert.equal(resumed.grant.consumedReceiptId, 'receipt-resume');
  assert.equal(resumed.grant.consumedAt, at(4000));
  assert.deepEqual(resumed.cancelPurposes, revisionCancelPurposes);
  // The fixed submission and its references survive the reopen untouched.
  assert.equal(latestSubmission({ submissions: [submitted.submission] })?.submissionId, 'submission-1');
  assert.equal(submitted.submission.snapshotId, f.snapshot.snapshotId);
  assert.equal(submitted.submission.attemptRevision, f.revision);
  assert.throws(() => planResumeRevision(reviewedBasis({ grants: [grant] }), reviewedAttempt.attemptRevision + 1, reopen), /version conflict/i);
  assert.throws(() => planResumeRevision(reviewedBasis({ grants: [grant] }), reviewedAttempt.attemptRevision,
    { ...reopen, assignmentActive: false }), /pause cannot be overridden/i);
  for (const state of ['consumed','superseded'] as const)
    assert.throws(() => planResumeRevision(reviewedBasis({ grants: [grantOf(f, 'submission-1', reviewedAttempt.attemptRevision, state)] }),
      reviewedAttempt.attemptRevision, reopen), /reopen permission/i);
  // A grant left behind at an older revision no longer matches the attempt the student is looking at.
  assert.throws(() => planResumeRevision(reviewedBasis({ attempt: { ...reviewedAttempt,
    attemptRevision: reviewedAttempt.attemptRevision + 1 }, grants: [grant] }), reviewedAttempt.attemptRevision + 1, reopen),
    /reopen permission/i);
  // Only a reviewed attempt resumes revision; a submitted one waits for the teacher's formal feedback.
  assert.throws(() => planResumeRevision(basis(f, { attempt: submitted.attempt, submissions: [submitted.submission],
    grants: [grant] }), submitted.attempt.attemptRevision, reopen), /reviewed attempt/i);
  assert.throws(() => planResumeRevision(reviewedBasis({ submissions: [] }), reviewedAttempt.attemptRevision, reopen), /No fixed submission/i);
  // After a real revision round the newest submission is the only reopen target, so a grant still naming the older
  // one cannot reopen the artifact even at a matching revision.
  const second = planSubmission(basis(f, { attempt: resumed.attempt, submissions: [submitted.submission] }),
    { expectedAttemptRevision: resumed.attempt.attemptRevision, snapshotId: f.snapshot.snapshotId, checkRunIds: [] },
    { submissionId: 'submission-2' }, submitContext('second'));
  const reviewedSecond = { ...second.attempt, status: 'reviewed' as const,
    attemptRevision: second.attempt.attemptRevision + 1, decisionEpoch: second.attempt.decisionEpoch + 1 };
  const both = [submitted.submission, second.submission];
  assert.throws(() => planResumeRevision(basis(f, { attempt: reviewedSecond, submissions: both,
    grants: [grantOf(f, 'submission-1', reviewedSecond.attemptRevision)] }), reviewedSecond.attemptRevision, reopen),
    /reopen permission/i);
  assert.equal(planResumeRevision(basis(f, { attempt: reviewedSecond, submissions: both,
    grants: [grantOf(f, 'submission-2', reviewedSecond.attemptRevision)] }), reviewedSecond.attemptRevision, reopen).attempt.status, 'active');
  // `reopenView` reports the most recently saved grant as its own persisted fact, and separately whether the
  // student can consume it. A real `valid` row is therefore never folded into `none` and never attributed to an
  // older grant the teacher has already replaced.
  assert.deepEqual(reopenView(reviewedBasis(), true), { state: 'none', actionable: false });
  const actionable = reopenView(reviewedBasis({ grants: [grant] }), true);
  assert.deepEqual({ state: actionable.state, actionable: actionable.actionable, grantId: actionable.grantId,
    submissionId: actionable.submissionId },
    { state: 'valid', actionable: true, grantId: grant.grantId, submissionId: 'submission-1' });
  const consumed = reopenView(basis(f, { attempt: resumed.attempt, submissions: [submitted.submission],
    grants: [resumed.grant] }), true);
  assert.equal(consumed.state, 'consumed');
  assert.equal(consumed.actionable, false);
  assert.equal(consumed.consumedAt, resumed.grant.consumedAt);
  // An older superseded grant must not hide the newer `valid` one: the attempt revision moved on after the teacher
  // issued it, which is what an ordinary assignment pause does.
  const movedAttempt = { ...reviewedAttempt, attemptRevision: reviewedAttempt.attemptRevision + 1,
    decisionEpoch: reviewedAttempt.decisionEpoch + 1 };
  const afterSupersede = reopenView(basis(f, { attempt: movedAttempt, submissions: [submitted.submission],
    grants: [grantOf(f, 'submission-1', reviewedAttempt.attemptRevision, 'superseded'), grant] }), true);
  assert.equal(afterSupersede.grantId, grant.grantId);
  assert.equal(afterSupersede.state, 'valid');
  assert.equal(afterSupersede.actionable, false);
  // A lone `valid` row whose revision moved is granted-but-spent, not "never granted". The student's page has to be
  // able to tell those apart, so this may not collapse to `none`.
  const lone = reopenView(basis(f, { attempt: movedAttempt, submissions: [submitted.submission], grants: [grant] }), true);
  assert.deepEqual({ state: lone.state, actionable: lone.actionable, grantId: lone.grantId },
    { state: 'valid', actionable: false, grantId: grant.grantId });
  assert.notEqual(lone.state, 'none');
  // A grant naming an older submission reports itself rather than the settled grant that came before it.
  const olderSubmission = reopenView(basis(f, { attempt: reviewedSecond, submissions: both,
    grants: [resumed.grant, grantOf(f, 'submission-1', reviewedSecond.attemptRevision)] }), true);
  assert.equal(olderSubmission.state, 'valid');
  assert.equal(olderSubmission.actionable, false);
  assert.equal(olderSubmission.submissionId, 'submission-1');
  assert.notEqual(olderSubmission.grantId, resumed.grant.grantId);
  // The projection and the consuming command share one predicate, so a view claiming `actionable` is a view the
  // command accepts, and every view denying it is one the command refuses for a stated reason.
  for (const row of [reviewedBasis(), reviewedBasis({ grants: [grant] }),
    basis(f, { attempt: movedAttempt, submissions: [submitted.submission], grants: [grant] }),
    basis(f, { attempt: resumed.attempt, submissions: [submitted.submission], grants: [resumed.grant] }),
    basis(f, { attempt: reviewedSecond, submissions: both,
      grants: [resumed.grant, grantOf(f, 'submission-1', reviewedSecond.attemptRevision)] })]) {
    const view = reopenView(row, true);
    if (view.actionable) assert.equal(planResumeRevision(row, row.attempt.attemptRevision, reopen).grant.grantId, view.grantId);
    else assert.throws(() => planResumeRevision(row, row.attempt.attemptRevision, reopen),
      /reopen permission|reviewed attempt|version conflict|pause cannot be overridden/i);
  }
});

test('C4-V04 recovery separates confirmed, unknown and in-flight outcomes without touching the attempt', () => {
  const f = planned();
  const context = { recoveryGeneration: 'gen', resyncRequired: false, assignmentActive: true, feedback: { status: 'unavailable' as const } };
  const withJobs = (jobs: Job[]) => readRecovery({ ...f.state, records: { ...f.state.records, jobs } }, context, () => true);
  // A run whose lease expired without a node fact is reconciled to `outcome_unknown` by C2's existing path.
  const disconnected = markRunUnknown({ ...f.state, records: { ...f.state.records,
    jobs: f.state.records.jobs.map(job => ({ ...job, status: 'running' as const })) } }, f.ids.jobId, 'gen');
  const unknown = readRecovery(disconnected, context, () => true);
  // An executor disconnect stays unknown and is never reported as a confirmed result.
  assert.deepEqual(unknown.runs.map(run => ({ status: run.jobStatus, outcome: run.outcome })),
    [{ status: 'outcome_unknown', outcome: 'unknown' }]);
  assert.equal(unknown.resyncRequired, false);
  assert.equal(unknown.feedback.status, 'unavailable');
  assert.equal(unknown.attempt.attemptId, f.id);
  assert.equal(unknown.attempt.activityVersionId, 'synthetic-activity');
  assert.equal(unknown.latestSnapshotId, f.snapshot.snapshotId);
  assert.equal(unknown.files.length, 2);
  assert.deepEqual(unknown.files.map(row => row.path).sort(), ['a.txt','main.c']);
  assert.equal(unknown.submissions.length, 0);
  assert.deepEqual(unknown.reopen, { state: 'none', actionable: false });
  assert.throws(() => readRecovery(f.state, context, () => false), /denied/i);
  assert.deepEqual(readRecovery(f.state, context, () => true).runs.map(run => run.outcome), ['confirmed']);
  assert.equal(readRecovery(f.state, { ...context, resyncRequired: true,
    feedback: { status: 'available', feedbackRevision: 2, entries: [] } }, () => true).feedback.status, 'available');
  // A succeeded job without a result is incomplete, not confirmed.
  assert.deepEqual(readRecovery({ ...f.state, runs: f.state.runs.map(({ runId, jobId, submission }) => ({ runId, jobId, submission })) },
    context, () => true).runs.map(run => run.outcome), ['incomplete']);
  for (const [status, outcome] of [['queued','in_flight'],['running','in_flight'],['cancelling','in_flight'],
    ['failed','failed'],['cancelled','cancelled'],['stale','stale'],['timed_out','timed_out']] as const)
    assert.deepEqual(withJobs(f.state.records.jobs.map(job => ({ ...job, status }))).runs.map(run => run.outcome), [outcome],
      `job status ${status}`);
  // A pending question is the student's own help request that has not reached a terminal fact.
  const helpJob: Job = { ...f.state.records.jobs[0]!, jobId: 'help-job', kind: 'student_help',
    purpose: 'student_help', status: 'queued', deadline: at(45000) };
  const pending = withJobs([...f.state.records.jobs, helpJob]);
  assert.deepEqual(pending.pendingQuestions.map(row => ({ jobId: row.jobId, status: row.jobStatus })),
    [{ jobId: 'help-job', status: 'queued' }]);
  // The projection is read-only: the state it was given is unchanged and nothing was enqueued.
  assert.equal(f.state.records.jobs.length, 1);
  assert.equal(f.state.attempt.status, 'active');
  assert.equal(f.state.submissions.length, 0);
});

test('C4-V05 a fixed submission is idempotent, conflicts on a differing digest and never repeats the side effect', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login(), other = await f.login('other');
    const allocation = await assigned(f, teacher), id = await opened(f, student, allocation.assignmentId);
    await files(f, student, id);
    const snap = await snapshot(f, student, id), before = await view(f, student, id);
    const body = { expectedAttemptRevision: before.attempt.attemptRevision, snapshotId: snap, reflection: 'Dynamic array route.' };
    const submissionCount = () => f.db.withTransaction(tx => tx.get('SELECT COUNT(*) AS n FROM workspace_submissions')!.n);
    const first = await submit(f, student, id, body, 'submit-once');
    assert.equal(first.statusCode, 200, first.body);
    const result = first.json().data.result;
    assert.equal(result.status, 'submitted');
    assert.equal(result.attemptRevision, before.attempt.attemptRevision + 1);
    assert.equal(result.decisionEpoch, before.attempt.decisionEpoch + 1);
    assert.equal(submissionCount(), 1);
    // AC-06: the same key and digest return the original submission and receipt rather than a second business action.
    // A submission has no sync alias, so a different key is a different command and is covered below instead.
    const replay = await submit(f, student, id, body, 'submit-once');
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().data.replayed, true);
    for (const field of ['receiptId','commandId','serverSeq','committedAt','result'])
      assert.deepEqual(replay.json().data[field], first.json().data[field]);
    assert.equal(submissionCount(), 1);
    // AC-06: the same key with a differing digest is a conflict, never a silent second submission.
    const conflict = await submit(f, student, id, { ...body, reflection: 'A different reflection.' }, 'submit-once');
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
    // A new key is a new command, and the read-only stage refuses it instead of fixing a second artifact.
    const fresh = await submit(f, student, id, { ...body, reflection: 'A different reflection.' }, 'submit-fresh');
    assert.equal(fresh.statusCode, 409, fresh.body);
    assert.equal(fresh.json().error.code, 'STATE_CONFLICT');
    assert.equal(submissionCount(), 1);
    // AC-12: a stale recovery generation is reconciled explicitly, not replayed under a new key.
    f.restoreGeneration();
    const stale = await submit(f, student, id, body, 'submit-once');
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, 'RECOVERY_REQUIRED');
    assert.equal(submissionCount(), 1);
    // The artifact is read-only: no further edit or snapshot can rewrite the fixed submission's basis.
    const current = await view(f, student, id);
    const edit = await command(f, student, `/api/attempts/${id}/sync`, { expectedWorkspaceRevision: current.attempt.workspaceRevision,
      clientId: 'page', clientSeq: 40, operations: [{ kind: 'update', fileId: current.files[0].fileId, baseVersion: 1, text: 'changed' }] });
    assert.equal(edit.statusCode, 409, edit.body);
    assert.equal(edit.json().error.code, 'STATE_CONFLICT');
    assert.equal((await command(f, student, `/api/attempts/${id}/snapshots`,
      { expectedWorkspaceRevision: current.attempt.workspaceRevision })).json().error.code, 'STATE_CONFLICT');
    // Ownership: another student of the same course gets no submission and no existence leak.
    assert.equal((await f.app.inject({ url: `/api/attempts/${id}`, headers: other })).statusCode, 403);
    assert.equal((await f.app.inject({ url: `/api/attempts/${id}/recovery`, headers: other })).statusCode, 403);
    assert.equal((await submit(f, other, id, body)).statusCode, 403);
    assert.equal(submissionCount(), 1);
    // The course teacher reads the submission but cannot write the student's artifact.
    const teacherRead = await f.app.inject({ url: `/api/attempts/${id}/recovery`, headers: teacher });
    assert.equal(teacherRead.statusCode, 200, teacherRead.body);
    assert.equal(teacherRead.json().data.submissions.length, 1);
    assert.equal(teacherRead.json().data.submissions[0].hasReflection, true);
    assert.equal(teacherRead.json().data.submissions[0].snapshotId, snap);
    // The recovery projection reports only that a reflection exists; A5's review surface reads the student's own
    // text from the workspace view, so a teacher review is never reconstructed from a hash or a digest.
    assert.equal('reflection' in teacherRead.json().data.submissions[0], false);
    const teacherView = await f.app.inject({ url: `/api/attempts/${id}`, headers: teacher });
    assert.equal(teacherView.statusCode, 200, teacherView.body);
    assert.equal(teacherView.json().data.submissions[0].reflection, 'Dynamic array route.');
  } finally { await f.close(); }
});

test('C4-V06 teacher review, reopen grant and the student own resume_revision form the revision chain', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login();
    const allocation = await assigned(f, teacher), id = await opened(f, student, allocation.assignmentId);
    const created = await files(f, student, id), firstSnapshot = await snapshot(f, student, id);
    const before = await view(f, student, id);
    const submitted = await submit(f, student, id, { expectedAttemptRevision: before.attempt.attemptRevision,
      snapshotId: firstSnapshot, reflection: 'First submission.' });
    assert.equal(submitted.statusCode, 200, submitted.body);
    const submissionId = String(submitted.json().data.result.submissionId);
    const submittedRevision = Number(submitted.json().data.result.attemptRevision);
    // A grant before formal feedback is refused: the artifact is submitted, not yet reviewed.
    assert.equal((await grantReopen(f, teacher, id, submissionId, submittedRevision)).json().error.code, 'STATE_CONFLICT');
    const review = await markReviewed(f, teacher, id, submittedRevision);
    assert.equal(review.statusCode, 200, review.body);
    assert.equal(review.json().data.result.status, 'reviewed');
    const reviewedRevision = Number(review.json().data.result.attemptRevision);
    assert.equal((await view(f, student, id)).attempt.status, 'reviewed');
    // AC-09: without a permission the student cannot reopen, and the system does not reopen for them.
    const denied = await resumeRevision(f, student, id, reviewedRevision);
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(denied.json().error.code, 'STATE_CONFLICT');
    const granted = await grantReopen(f, teacher, id, submissionId, reviewedRevision, 'Revise the report coverage', 'grant-key');
    assert.equal(granted.statusCode, 200, granted.body);
    const grantResult = granted.json().data.result;
    // Saving the permission keeps the artifact read-only at `reviewed` and moves the CAS forward by one.
    assert.equal(grantResult.status, 'reviewed');
    assert.equal(grantResult.attemptRevision, reviewedRevision + 1);
    assert.deepEqual(grantResult.supersededGrantIds, []);
    assert.equal((await view(f, student, id)).attempt.status, 'reviewed');
    assert.equal((await view(f, student, id)).reopen.state, 'valid');
    assert.equal((await view(f, student, id)).reopen.actionable, true);
    // A replay of the same teacher command returns the original grant instead of creating a second one.
    const replayed = await grantReopen(f, teacher, id, submissionId, reviewedRevision, 'Revise the report coverage', 'grant-key');
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.equal(replayed.json().data.replayed, true);
    assert.equal(replayed.json().data.result.grantId, grantResult.grantId);
    assert.equal(f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM workspace_reopen_grants WHERE state='valid'")!.n), 1);
    const resumed = await resumeRevision(f, student, id, grantResult.attemptRevision, 'resume-key');
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().data.result.status, 'active');
    assert.equal(resumed.json().data.result.grantId, grantResult.grantId);
    assert.equal(resumed.json().data.result.submissionId, submissionId);
    assert.equal(resumed.json().data.result.attemptRevision, grantResult.attemptRevision + 1);
    assert.equal(resumed.json().data.replayed, false);
    // The grant is consumed exactly once; a further explicit command finds a stage that is no longer reviewed.
    assert.equal(f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM workspace_reopen_grants WHERE state='consumed'")!.n), 1);
    assert.equal((await resumeRevision(f, student, id, Number(resumed.json().data.result.attemptRevision))).json().error.code, 'STATE_CONFLICT');
    // AC-06: replaying the student's own command returns the original receipt and consumes nothing twice.
    const replayResume = await resumeRevision(f, student, id, grantResult.attemptRevision, 'resume-key');
    assert.equal(replayResume.statusCode, 200, replayResume.body);
    assert.equal(replayResume.json().data.replayed, true);
    assert.equal(f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM workspace_reopen_grants WHERE state='consumed'")!.n), 1);
    // AC-09: the student revises, and the new submission fixes a new snapshot while the old one stays readable.
    const edit = await command(f, student, `/api/attempts/${id}/sync`, { expectedWorkspaceRevision: 1, clientId: 'page',
      clientSeq: 50, operations: [{ kind: 'update', fileId: created.source, baseVersion: 1,
        text: '#include <stdio.h>\nint main(void){puts("revised snapshot");}\n' }] });
    assert.equal(edit.statusCode, 200, edit.body);
    const secondSnapshot = await snapshot(f, student, id);
    assert.notEqual(secondSnapshot, firstSnapshot);
    const current = await view(f, student, id);
    const second = await submit(f, student, id, { expectedAttemptRevision: current.attempt.attemptRevision,
      snapshotId: secondSnapshot, reflection: 'Revised after feedback.' });
    assert.equal(second.statusCode, 200, second.body);
    assert.notEqual(second.json().data.result.submissionId, submissionId);
    const history = await view(f, student, id);
    assert.equal(history.submissions.length, 2);
    // Old submissions and their original references are preserved verbatim, not overwritten by the new one.
    assert.equal(history.submissions[0].submissionId, submissionId);
    assert.equal(history.submissions[0].snapshotId, firstSnapshot);
    assert.equal(history.submissions[0].reflection, 'First submission.');
    assert.equal(history.submissions[1].snapshotId, secondSnapshot);
    const oldSnapshot = await f.app.inject({ url: `/api/attempts/${id}/snapshots/${firstSnapshot}`, headers: student });
    assert.equal(oldSnapshot.statusCode, 200, oldSnapshot.body);
    assert.match(oldSnapshot.json().data.files.find((row: {fileId: string}) => row.fileId === created.source).text, /old snapshot/);
    const restored = await recovery(f, student, id, { recoveryGeneration: f.generation(),
      decisionEpoch: history.attempt.decisionEpoch });
    assert.equal(restored.resyncRequired, false);
    assert.equal(restored.latestSubmissionId, String(second.json().data.result.submissionId));
    assert.equal(restored.latestSnapshotId, secondSnapshot);
    assert.equal(restored.reopen.state, 'consumed');
    assert.equal(restored.reopen.actionable, false);
    assert.equal(restored.submissions.length, 2);
    assert.equal(restored.attempt.status, 'submitted');
    assert.equal(restored.feedback.status, 'unavailable');
    assert.ok(restored.coverage);
  } finally { await f.close(); }
});

test('C4-V07 stale revisions, old submissions, paused assignments and foreign actors are refused', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login(), other = await f.login('other');
    const foreign = await f.login('foreign');
    const allocation = await assigned(f, teacher), id = await opened(f, student, allocation.assignmentId);
    await files(f, student, id);
    const chain = await reviewed(f, student, teacher, id, { reflection: 'First submission.' });
    const validGrants = () => f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM workspace_reopen_grants WHERE state='valid'")!.n);
    // AC-08: a stale expectedAttemptRevision is a version conflict, not a late write.
    assert.equal((await grantReopen(f, teacher, id, chain.submissionId, chain.reviewedRevision - 1)).json().error.code, 'VERSION_CONFLICT');
    assert.equal((await markReviewed(f, teacher, id, chain.reviewedRevision)).json().error.code, 'STATE_CONFLICT');
    const granted = await grantReopen(f, teacher, id, chain.submissionId, chain.reviewedRevision);
    assert.equal(granted.statusCode, 200, granted.body);
    const grantRevision = Number(granted.json().data.result.attemptRevision);
    const grantId = String(granted.json().data.result.grantId);
    // A second grant supersedes the first, and the superseded revision can no longer reopen the artifact.
    const second = await grantReopen(f, teacher, id, chain.submissionId, grantRevision, 'Narrow the revision scope');
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json().data.result.supersededGrantIds, [grantId]);
    assert.equal(f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM workspace_reopen_grants WHERE state='superseded'")!.n), 1);
    assert.equal(validGrants(), 1);
    assert.equal((await resumeRevision(f, student, id, grantRevision)).json().error.code, 'VERSION_CONFLICT');
    // AC-08: an assignment pause moves the attempt CAS forward, so it overrides the personal reopen and leaves the
    // surviving grant unconsumed rather than silently spending the teacher's permission.
    const paused = await command(f, teacher, `/api/assignments/${allocation.assignmentId}/controls`,
      { expectedAssignmentRevision: 1, action: 'pause', reason: 'Course pause' });
    assert.equal(paused.statusCode, 200, paused.body);
    const pausedRevision = (await view(f, teacher, id)).attempt.attemptRevision as number;
    assert.equal(pausedRevision, Number(second.json().data.result.attemptRevision) + 1);
    assert.equal((await resumeRevision(f, student, id, pausedRevision)).json().error.code, 'STATE_CONFLICT');
    assert.equal(validGrants(), 1);
    // The pause made the grant unspendable, not absent. The recovery read still has to show it, so the student's
    // page can tell "teacher granted it, a pause voided it, the teacher must grant again" from "never granted" —
    // and it must point at the grant the teacher actually issued last, not the one that grant superseded.
    const pausedView = await recovery(f, student, id, { recoveryGeneration: f.generation(),
      decisionEpoch: (await view(f, student, id)).attempt.decisionEpoch });
    assert.equal(pausedView.reopen.state, 'valid');
    assert.equal(pausedView.reopen.actionable, false);
    assert.equal(pausedView.reopen.grantId, String(second.json().data.result.grantId));
    assert.equal(pausedView.reopen.submissionId, chain.submissionId);
    assert.equal((await command(f, teacher, `/api/assignments/${allocation.assignmentId}/controls`,
      { expectedAssignmentRevision: 2, action: 'resume', reason: 'Course resumed' })).statusCode, 200);
    // Resuming the assignment does not restore the grant the pause made stale: the permission was issued against a
    // decision epoch that no longer holds, so the teacher grants again on the current revision instead.
    assert.equal((await resumeRevision(f, student, id, pausedRevision)).json().error.code, 'STATE_CONFLICT');
    const reissued = await grantReopen(f, teacher, id, chain.submissionId, pausedRevision, 'Granted again after the pause');
    assert.equal(reissued.statusCode, 200, reissued.body);
    assert.deepEqual(reissued.json().data.result.supersededGrantIds, [String(second.json().data.result.grantId)]);
    assert.equal(f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM workspace_reopen_grants WHERE state='superseded'")!.n), 2);
    assert.equal(validGrants(), 1);
    const reissuedRevision = Number(reissued.json().data.result.attemptRevision);
    // Permissions: a teacher cannot consume the student's permission, and another student cannot read or reopen.
    assert.equal((await resumeRevision(f, teacher, id, reissuedRevision)).json().error.code, 'FORBIDDEN');
    assert.equal((await resumeRevision(f, other, id, reissuedRevision)).json().error.code, 'FORBIDDEN');
    assert.equal((await grantReopen(f, student, id, chain.submissionId, reissuedRevision)).json().error.code, 'FORBIDDEN');
    assert.equal((await grantReopen(f, other, id, chain.submissionId, reissuedRevision)).json().error.code, 'FORBIDDEN');
    assert.equal((await f.app.inject({ url: `/api/attempts/${id}/recovery`, headers: foreign })).statusCode, 403);
    assert.equal(validGrants(), 1);
    // The student's own explicit command consumes the surviving grant.
    const resumed = await resumeRevision(f, student, id, reissuedRevision);
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().data.result.status, 'active');
    assert.equal(validGrants(), 0);
    // AC-09: a grant may only be saved on the latest submission, so an old one cannot be reopened.
    const revised = await snapshot(f, student, id);
    const state = await view(f, student, id);
    const next = await submit(f, student, id, { expectedAttemptRevision: state.attempt.attemptRevision, snapshotId: revised });
    assert.equal(next.statusCode, 200, next.body);
    const nextSubmissionId = String(next.json().data.result.submissionId);
    const nextReview = await markReviewed(f, teacher, id, Number(next.json().data.result.attemptRevision));
    assert.equal(nextReview.statusCode, 200, nextReview.body);
    const reviewedNow = Number(nextReview.json().data.result.attemptRevision);
    assert.equal((await grantReopen(f, teacher, id, chain.submissionId, reviewedNow)).json().error.code, 'INVALID_REFERENCE');
    const latest = await grantReopen(f, teacher, id, nextSubmissionId, reviewedNow);
    assert.equal(latest.statusCode, 200, latest.body);
    const restored = await recovery(f, student, id, { recoveryGeneration: f.generation(),
      decisionEpoch: (await view(f, student, id)).attempt.decisionEpoch });
    assert.equal(restored.submissions.length, 2);
    assert.equal(restored.reopen.state, 'valid');
    assert.equal(restored.reopen.actionable, true);
    assert.equal(restored.reopen.submissionId, nextSubmissionId);
    assert.equal(restored.attempt.status, 'reviewed');
  } finally { await f.close(); }
});

test('C4-V08 submission invalidates in-flight teaching in the same short transaction', async () => {
  const f = await fixture(undefined, { teaching: true });
  try {
    const teacher = await f.login('teacher'), student = await f.login();
    const { activityId, assignmentId } = await assigned(f, teacher), id = await opened(f, student, assignmentId);
    await files(f, student, id);
    const versions = { activityVersionId: activityId, policyVersionId: 'help-v1', modelConfigVersion: 'deepseek-flash-v1',
      promptVersion: 'help-prompt-v1', schemaVersion: 'student-help-v1' };
    const asked = await command(f, student, `/fixture/help/${id}`, { expectedAttemptRevision: (await view(f, student, id)).attempt.attemptRevision,
      question: 'Why is the word count low?', inputRefs: [], versions });
    assert.equal(asked.statusCode, 200, asked.body);
    const jobId = String(asked.json().data.jobId);
    // A pending, not-yet-displayed teaching action exists before the submission, so its invalidation is observable.
    const current = await view(f, student, id);
    const completed = await command(f, student, `/fixture/complete/${id}`, { jobId, leaseToken: 'worker-lease',
      bodyJson: JSON.stringify({ kind: 'student_help', actionType: 'hint', content: 'Check the separator rule.',
        rationale: 'Keep the scan loop.', expectedStudentAction: 'Run stats again.', evidenceIds: [], resourceRefs: [],
        assistanceContext: 'No assistance used.', unresolved: [],
        policyChecks: { containsWholeSolution: false, writesStudentWork: false, runsCode: false, makesFormalEvaluation: false } }),
      versions, usage: { status: 'actual', inputTokens: 120, outputTokens: 40 }, calls: 1, elapsedMs: 900,
      basis: { attemptRevision: current.attempt.attemptRevision, decisionEpoch: current.attempt.decisionEpoch,
        captureRevision: current.attempt.captureRevision, relatedStateRevision: 0, inputRefs: [], assistanceRefs: [], coverageRefs: [] } });
    assert.equal(completed.statusCode, 200, completed.body);
    const actionId = String(completed.json().data.actionId);
    assert.equal(completed.json().data.disposition, 'pending');
    // A second question is still queued when the student submits, so the same short transaction has a genuinely
    // in-flight job to cancel as well as a settled one whose terminal fact must not be rewritten.
    const inFlight = await command(f, student, `/fixture/help/${id}`, { expectedAttemptRevision: (await view(f, student, id)).attempt.attemptRevision,
      question: 'Should the separator rule change?', inputRefs: [], versions });
    assert.equal(inFlight.statusCode, 200, inFlight.body);
    const inFlightJobId = String(inFlight.json().data.jobId);
    assert.notEqual(inFlightJobId, jobId);
    const snap = await snapshot(f, student, id);
    const beforeSubmit = await view(f, student, id);
    assert.equal(beforeSubmit.jobs.find((row: {jobId: string}) => row.jobId === inFlightJobId).status, 'queued');
    const submitted = await submit(f, student, id, { expectedAttemptRevision: beforeSubmit.attempt.attemptRevision, snapshotId: snap });
    assert.equal(submitted.statusCode, 200, submitted.body);
    // The stage change and the invalidation of the corresponding teaching purpose commit together. Only the queued
    // job is listed: the settled one already recorded its own stop request, so the submission leaves that fact alone.
    assert.deepEqual(submitted.json().data.result.cancelledJobIds, [inFlightJobId]);
    const after = await view(f, student, id);
    const settled = after.jobs.find((row: {jobId: string}) => row.jobId === jobId);
    const queued = after.jobs.find((row: {jobId: string}) => row.jobId === inFlightJobId);
    assert.equal(queued.status, 'cancelled');
    assert.equal(queued.stopRequested, true);
    // The submission never rewrites an already settled job fact, not even to repeat a stop it has already made.
    assert.deepEqual(settled, beforeSubmit.jobs.find((row: {jobId: string}) => row.jobId === jobId));
    assert.equal(settled.status, 'succeeded');
    assert.equal(after.attempt.status, 'submitted');
    // The invalidated action is never deliverable: an undisplayed action stays outside the student audience, while
    // the teacher audience still sees exactly the original record with its disposition moved off `pending`.
    assert.deepEqual((await f.app.inject({ url: `/fixture/records/${id}`, headers: student })).json().data.actions, []);
    const records = (await f.app.inject({ url: `/fixture/records/${id}`, headers: teacher })).json().data;
    assert.equal(records.actions.length, 1);
    assert.equal(records.actions[0].actionId, actionId);
    assert.notEqual(records.actions[0].disposition, 'pending');
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT COUNT(*) AS n FROM workspace_submissions')!.n), 1);
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT snapshot_id FROM workspace_submissions')!.snapshot_id), snap);
    // AC-08: a completion arriving after the stage change cannot restore the expired teaching state.
    const late = await command(f, student, `/fixture/complete/${id}`, { jobId, leaseToken: 'worker-lease',
      bodyJson: JSON.stringify({ kind: 'student_help', actionType: 'hint', content: 'Late answer.', rationale: 'Late.',
        expectedStudentAction: 'Read it.', evidenceIds: [], resourceRefs: [], assistanceContext: 'No assistance used.',
        unresolved: [], policyChecks: { containsWholeSolution: false, writesStudentWork: false, runsCode: false,
          makesFormalEvaluation: false } }),
      versions, usage: { status: 'actual', inputTokens: 10, outputTokens: 5 }, calls: 1, elapsedMs: 500,
      basis: { attemptRevision: current.attempt.attemptRevision, decisionEpoch: current.attempt.decisionEpoch,
        captureRevision: current.attempt.captureRevision, relatedStateRevision: 0, inputRefs: [], assistanceRefs: [], coverageRefs: [] } });
    assert.notEqual(late.statusCode, 200, late.body);
    const lateRecords = (await f.app.inject({ url: `/fixture/records/${id}`, headers: teacher })).json().data;
    assert.equal(lateRecords.actions.length, 1);
    assert.equal(lateRecords.actions[0].disposition, records.actions[0].disposition);
  } finally { await f.close(); }
});

test('C4-V09 submissions, grants and recovery survive a restart, and a late failure rolls the whole command back', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login();
    const allocation = await assigned(f, teacher), id = await opened(f, student, allocation.assignmentId);
    await files(f, student, id);
    const snap = await snapshot(f, student, id), before = await view(f, student, id);
    const counts = () => f.db.withTransaction(tx => ({ receipts: tx.get('SELECT COUNT(*) AS n FROM command_receipts')!.n,
      events: tx.get('SELECT COUNT(*) AS n FROM audit_events')!.n,
      submissions: tx.get('SELECT COUNT(*) AS n FROM workspace_submissions')!.n,
      grants: tx.get('SELECT COUNT(*) AS n FROM workspace_reopen_grants')!.n }));
    const baseline = counts();
    // AC-12: a failure while writing the submission leaves no receipt, no event, no submission and no stage change.
    f.injectFailure('INSERT INTO workspace_submissions');
    const failed = await submit(f, student, id, { expectedAttemptRevision: before.attempt.attemptRevision, snapshotId: snap }, 'retry-submit');
    assert.equal(failed.statusCode, 503, failed.body);
    assert.equal(failed.json().error.code, 'PERSISTENCE_UNAVAILABLE');
    assert.deepEqual(counts(), baseline);
    assert.equal((await view(f, student, id)).attempt.status, before.attempt.status);
    assert.equal((await view(f, student, id)).attempt.attemptRevision, before.attempt.attemptRevision);
    f.injectFailure('');
    // The retried command is the first real business action for that key: no duplicate side effect was recorded.
    const retried = await submit(f, student, id, { expectedAttemptRevision: before.attempt.attemptRevision, snapshotId: snap }, 'retry-submit');
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(counts().submissions, 1);
    const submissionId = String(retried.json().data.result.submissionId);
    const review = await markReviewed(f, teacher, id, Number(retried.json().data.result.attemptRevision));
    assert.equal(review.statusCode, 200, review.body);
    const granted = await grantReopen(f, teacher, id, submissionId, Number(review.json().data.result.attemptRevision));
    assert.equal(granted.statusCode, 200, granted.body);
    const grantRevision = Number(granted.json().data.result.attemptRevision);
    const grantId = String(granted.json().data.result.grantId);
    // AC-12: a failure while consuming the grant leaves the attempt reviewed and the grant still valid.
    f.injectFailure('UPDATE workspace_reopen_grants');
    const failedResume = await resumeRevision(f, student, id, grantRevision);
    assert.equal(failedResume.statusCode, 503, failedResume.body);
    assert.equal(counts().grants, 1);
    assert.equal((await view(f, student, id)).attempt.status, 'reviewed');
    assert.equal((await view(f, student, id)).reopen.state, 'valid');
    // The actionable computation is derived from persisted rows only, so it survives the restart unchanged.
    assert.equal((await view(f, student, id)).reopen.actionable, true);
    f.injectFailure('');
    // AC-12: an application restart keeps the confirmed submission, the grant and the reviewed stage.
    await f.reopen();
    const restored = await view(f, student, id);
    assert.equal(restored.attempt.status, 'reviewed');
    assert.equal(restored.attempt.attemptRevision, grantRevision);
    assert.equal(restored.submissions.length, 1);
    assert.equal(restored.submissions[0].submissionId, submissionId);
    assert.equal(restored.reopen.state, 'valid');
    assert.equal(restored.reopen.grantId, grantId);
    const frozen = await f.app.inject({ url: `/api/attempts/${id}/snapshots/${snap}`, headers: student });
    assert.equal(restored.submissions[0].snapshotHash, frozen.json().data.hash);
    const recovered = await recovery(f, student, id, { recoveryGeneration: f.generation(), decisionEpoch: restored.attempt.decisionEpoch });
    assert.equal(recovered.resyncRequired, false);
    assert.equal(recovered.submissions[0].submissionId, submissionId);
    assert.ok(recovered.submissions[0].serverSeq > 0);
    assert.equal(recovered.submissions[0].hasReflection, false);
    // A page that has not synchronized, or holds a stale epoch or generation, is told to re-sync.
    assert.equal((await recovery(f, student, id)).resyncRequired, true);
    assert.equal((await recovery(f, student, id, { recoveryGeneration: f.generation(),
      decisionEpoch: restored.attempt.decisionEpoch + 1 })).resyncRequired, true);
    const generationBefore = (await recovery(f, student, id)).recoveryGeneration;
    f.restoreGeneration();
    const staleRead = await recovery(f, student, id, { recoveryGeneration: generationBefore, decisionEpoch: restored.attempt.decisionEpoch });
    assert.equal(staleRead.resyncRequired, true);
    assert.notEqual(staleRead.recoveryGeneration, generationBefore);
    // The recovery read is side-effect free: no receipt, event, submission or grant, and no stage or version move.
    const beforeRead = counts(), stageBefore = (await view(f, student, id)).attempt;
    await recovery(f, student, id, { recoveryGeneration: f.generation(), decisionEpoch: stageBefore.decisionEpoch });
    await recovery(f, student, id);
    assert.deepEqual(counts(), beforeRead);
    const stageAfter = (await view(f, student, id)).attempt;
    assert.equal(stageAfter.status, stageBefore.status);
    assert.equal(stageAfter.attemptRevision, stageBefore.attemptRevision);
    assert.equal(stageAfter.decisionEpoch, stageBefore.decisionEpoch);
    // The student's own explicit command still consumes the surviving grant after the restart and generation change.
    const resumed = await resumeRevision(f, student, id, grantRevision);
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().data.result.status, 'active');
    assert.equal(f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM workspace_reopen_grants WHERE state='consumed'")!.n), 1);
  } finally { await f.close(); }
});

test('C4-V10 the submission command plan is replayable and guards the authorized student scope', () => {
  const f = planned();
  const request = { expectedAttemptRevision: f.revision, snapshotId: f.snapshot.snapshotId, checkRunIds: [] };
  const ids = { submissionId: 'submission-1' };
  const done = submitCommand(f.state, f.context('submit'), request, ids);
  assert.equal(done.state.attempt.status, 'submitted');
  assert.equal(done.state.submissions.length, 1);
  assert.equal(done.replayed, false);
  // A replay under the same identity returns the original receipt and adds no second submission.
  const replay = submitCommand(done.state, f.context('submit'), request, { submissionId: 'unused' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.receiptId, done.receipt.receiptId);
  assert.equal(replay.state.submissions.length, 1);
  // A differing digest under the same key is an idempotency conflict, not a new submission.
  assert.throws(() => submitCommand(done.state, f.context('submit'), { ...request, reflection: 'Different.' },
    { submissionId: 'unused' }), /mismatch/i);
  // Ownership: another student's identity, course or attempt is refused before any plan is made.
  const identity = f.context('submit').identity;
  for (const patch of [{ actorId: 'someone-else' }, { scope: { ...identity.scope, courseId: 'other' } },
    { scope: { ...identity.scope, attemptId: 'other-attempt' } }, { scope: { ...identity.scope, studentId: 'other' } }])
    assert.throws(() => submitCommand(f.state, { ...f.context('submit'), identity: { ...identity, ...patch } }, request, ids),
      /Authorized student/i);
  // The control path carries resume_revision through the same receipt and stop semantics.
  const reviewedState = { ...done.state, attempt: { ...done.state.attempt, status: 'reviewed' as const } };
  const grant = grantOf(f, 'submission-1', reviewedState.attempt.attemptRevision);
  const controlContext = (key: string): CommandContext => ({ ...f.context(key),
    identity: { ...f.context(key).identity, command: 'controls', target: `/api/attempts/${f.id}/controls` } });
  const resumed = controlCommand({ ...reviewedState, grants: [grant] }, controlContext('resume'),
    reviewedState.attempt.attemptRevision, { kind: 'resume_revision' });
  assert.equal(resumed.state.attempt.status, 'active');
  assert.equal(resumed.state.grants[0]!.state, 'consumed');
  assert.equal(resumed.state.submissions.length, 1);
  assert.equal(resumed.replayed, false);
  assert.equal(controlCommand({ ...reviewedState, grants: [grant] }, controlContext('resume'),
    reviewedState.attempt.attemptRevision, { kind: 'resume_revision' }).receipt.receiptId, resumed.receipt.receiptId);
  // An ordinary lifecycle flag never reaches the submission domain as a reopen.
  assert.throws(() => controlCommand(reviewedState, controlContext('other'), reviewedState.attempt.attemptRevision,
    { kind: 'resume' }), /Invalid attempt transition/i);
  assert.throws(() => controlCommand(reviewedState, controlContext('revision'), reviewedState.attempt.attemptRevision,
    { kind: 'resume_revision' }), /reopen permission/i);
});


test('C4-V11 grants issued during assignment or activity pause are not actionable in either public view', async t => {
  for (const paused of ['assignment', 'activity'] as const) await t.test(paused, async () => {
    const f = await fixture();
    try {
      const teacher = await f.login('teacher'), student = await f.login();
      const allocation = await assigned(f, teacher), id = await opened(f, student, allocation.assignmentId);
      await files(f, student, id);
      const chain = await reviewed(f, student, teacher, id);
      const target = paused === 'assignment'
        ? '/api/assignments/' + allocation.assignmentId + '/controls'
        : '/api/activities/' + allocation.activityId + '/controls';
      const revisionField = paused === 'assignment' ? 'expectedAssignmentRevision' : 'expectedActivityControlRevision';
      assert.equal((await command(f, teacher, target, { [revisionField]: 1, action: 'pause', reason: 'Pause before granting' })).statusCode, 200);
      const current = await view(f, student, id);
      const granted = await grantReopen(f, teacher, id, chain.submissionId, current.attempt.attemptRevision);
      assert.equal(granted.statusCode, 200, granted.body);
      const revision = Number(granted.json().data.result.attemptRevision);
      for (const headers of [student, teacher]) {
        const workspace = await view(f, headers, id);
        const restored = await recovery(f, headers, id, { recoveryGeneration: f.generation(), decisionEpoch: workspace.attempt.decisionEpoch });
        for (const projection of [workspace, restored]) {
          assert.equal(projection.reopen.state, 'valid');
          assert.equal(projection.reopen.grantId, granted.json().data.result.grantId);
          assert.equal(projection.reopen.actionable, false);
        }
      }
      assert.equal((await resumeRevision(f, student, id, revision)).json().error.code, 'STATE_CONFLICT');
      assert.equal((await command(f, teacher, target, { [revisionField]: 2, action: 'resume', reason: 'Resume availability' })).statusCode, 200);
      const active = await view(f, student, id);
      const reissued = await grantReopen(f, teacher, id, chain.submissionId, active.attempt.attemptRevision);
      assert.equal(reissued.statusCode, 200, reissued.body);
      const restored = await recovery(f, student, id);
      assert.equal(restored.reopen.actionable, true);
      assert.equal((await view(f, student, id)).reopen.actionable, true);
      assert.equal((await resumeRevision(f, student, id, Number(reissued.json().data.result.attemptRevision))).statusCode, 200);
    } finally { await f.close(); }
  });
});

test('C4-V12 current teacher retains recovery history after student withdrawal but cannot see an actionable grant', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login();
    const allocation = await assigned(f, teacher), id = await opened(f, student, allocation.assignmentId);
    await files(f, student, id);
    const chain = await reviewed(f, student, teacher, id);
    const granted = await grantReopen(f, teacher, id, chain.submissionId, chain.reviewedRevision);
    assert.equal(granted.statusCode, 200, granted.body);
    f.db.withTransaction(tx => tx.run("UPDATE course_memberships SET active=0 WHERE user_id='student'"));
    for (const projection of [await view(f, teacher, id), await recovery(f, teacher, id)]) {
      assert.equal(projection.reopen.state, 'valid');
      assert.equal(projection.reopen.actionable, false);
      assert.equal(projection.submissions.length, 1);
    }
    for (const suffix of ['', '/recovery']) {
      assert.equal((await f.app.inject({ url: '/api/attempts/' + id + suffix, headers: student })).statusCode, 403);
    }
  } finally { await f.close(); }
});
