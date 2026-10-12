import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fixture, assigned, opened, files, view, command, type Fixture } from '../workspace/test-support.ts';
import { sha256 } from '../../runner/snapshot.ts';
import { readTeachingRecordsInTransaction, invalidateTeachingInTransaction } from './teaching.ts';
import { enqueueStoredJob, readAttempt, readJobs, saveJob } from '../db/records-adapter.ts';
import { claimJob } from './jobs.ts';
import type { Purpose } from '../../contracts/records/index.ts';

async function setup() {
  const f = await fixture(undefined, { teaching: true });
  const student = await f.login('student'), teacher = await f.login('teacher');
  const allocation = await assigned(f, teacher), attemptId = await opened(f, student, allocation.assignmentId);
  const created = await files(f, student, attemptId);
  const versions = { activityVersionId: allocation.activityId, policyVersionId: 'help-v1', modelConfigVersion: 'model-v1',
    promptVersion: 'prompt-v1', schemaVersion: 'schema-v1' };
  const state = () => view(f, student, attemptId);
  async function ask(question = 'Explain the scan.', key = 'question-1', objectRef?: object) {
    return command(f, student, `/fixture/help/${attemptId}`, { question, versions,
      expectedAttemptRevision: (await state()).attempt.attemptRevision, ...(objectRef ? { objectRef } : {}) }, key);
  }
  async function complete(jobId: string, content = 'Review the scan loop.', raw?: string, leaseToken = 'worker-lease') {
    const attempt = (await state()).attempt;
    return command(f, student, `/fixture/complete/${attemptId}`, { jobId, leaseToken, versions,
      bodyJson: raw ?? JSON.stringify(body(content)), usage: { status: 'unknown' }, calls: 1, elapsedMs: 10,
      basis: { attemptRevision: attempt.attemptRevision, decisionEpoch: attempt.decisionEpoch,
        captureRevision: attempt.captureRevision, relatedStateRevision: 0, inputRefs: [], assistanceRefs: [], coverageRefs: [] } });
  }
  async function page(afterServerSeq = 0, limit = 100, clientId = 'page-a') {
    const attempt = (await state()).attempt;
    return f.app.inject({ url: `/api/attempts/${attemptId}/events?${new URLSearchParams({ afterServerSeq: String(afterServerSeq),
      limit: String(limit), clientId, recoveryGeneration: f.generation(), decisionEpoch: String(attempt.decisionEpoch) })}`, headers: student });
  }
  const records = () => f.db.withTransaction(tx => readTeachingRecordsInTransaction(tx, { courseId: 'course', studentId: 'student', attemptId }));
  return { f, student, teacher, ...allocation, attemptId, fileId: created.source, versions, state, ask, complete, page, records };
}
function body(content: string) {
  return { kind: 'student_help', actionType: 'hint', content, rationale: 'Check one condition.', expectedStudentAction: 'Try the case.',
    evidenceIds: [], resourceRefs: [], assistanceContext: 'Unknown', unresolved: [],
    policyChecks: { containsWholeSolution: false, writesStudentWork: false, runsCode: false, makesFormalEvaluation: false } };
}
function snapshot(f: Fixture) {
  return sha256(JSON.stringify(f.db.withTransaction(tx => ({
    attempts: tx.all('SELECT * FROM attempts'), jobs: tx.all('SELECT * FROM jobs'), actions: tx.all('SELECT * FROM teaching_actions'),
    messages: tx.all('SELECT * FROM teaching_messages'), deliveries: tx.all('SELECT * FROM teaching_deliveries'),
    actionReceipts: tx.all('SELECT * FROM teaching_action_receipts'), receipts: tx.all('SELECT * FROM command_receipts'),
    events: tx.all('SELECT * FROM audit_events'), sessions: tx.all('SELECT user_id,last_active_at_ms FROM sessions ORDER BY user_id'),
    activityControls: tx.all('SELECT * FROM activity_controls'), assignments: tx.all('SELECT * FROM assignments'),
    bindings: tx.all('SELECT * FROM workspace_command_bindings'), processRecords: tx.all('SELECT * FROM workspace_process_records') }))));
}
/** A real persisted analysis job on the help command's receipt; only the executing side would enqueue one. */
function queueAnalysis(s: {f: Fixture; attemptId: string}, purpose: Purpose) {
  const jobId = randomUUID();
  s.f.db.withTransaction(tx => {
    const attempt = readAttempt(tx, s.attemptId);
    const receipt = tx.get("SELECT receipt_id FROM command_receipts WHERE command='shared.help.request' ORDER BY server_seq DESC LIMIT 1");
    enqueueStoredJob(tx, { jobId, kind: purpose, purpose,
      scope: { courseId: attempt.courseId, studentId: attempt.studentId, attemptId: attempt.attemptId },
      requestReceiptId: String(receipt!.receipt_id), status: 'queued', stopRequested: false,
      expectedRevision: attempt.attemptRevision, decisionEpoch: attempt.decisionEpoch,
      recoveryGeneration: s.f.generation(), acceptedAt: new Date(s.f.timestamp()).toISOString(),
      deadline: new Date(s.f.timestamp() + 120000).toISOString(), attemptCount: 0 });
  });
  return jobId;
}

test('review: a new help key creates a new round; original key returns the original IDs', async () => {
  const s = await setup();
  try {
    const first = await s.ask(); assert.equal(first.statusCode, 200, first.body);
    const again = await s.ask(); assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().data.jobId, first.json().data.jobId);
    const epoch = (await s.state()).attempt.decisionEpoch;
    const second = await s.ask('Explain a different condition.', 'question-2'); assert.equal(second.statusCode, 200, second.body);
    assert.notEqual(second.json().data.jobId, first.json().data.jobId);
    assert.equal((await s.state()).attempt.decisionEpoch, epoch + 1);
    const stopped = (await s.state()).jobs.find((job: { jobId: string }) => job.jobId === first.json().data.jobId);
    assert.equal(stopped.stopRequested, true);
  } finally { await s.f.close(); }
});

test('review: original body JSON bytes survive persistence and a real reopen', async () => {
  const s = await setup();
  try {
    const asked = await s.ask(); assert.equal(asked.statusCode, 200, asked.body);
    const raw = JSON.stringify(body('Unicode 😀\r\n'), null, 2);
    const completed = await s.complete(asked.json().data.jobId, '', raw); assert.equal(completed.statusCode, 200, completed.body);
    await s.f.reopen();
    const response = await s.f.app.inject({ url: `/api/attempts/${s.attemptId}/teaching-records`, headers: s.teacher });
    assert.equal(response.statusCode, 200, response.body);
    const model = response.json().data.messages.find((message: { authorKind: string }) => message.authorKind === 'model');
    assert.equal(model.envelope.bodyJsonText, raw);
  } finally { await s.f.close(); }
});

test('review: limit-one cursor pages progress, stay in scope and do not repeat deliveries', async () => {
  const s = await setup();
  try {
    const asked = await s.ask(), completed = await s.complete(asked.json().data.jobId);
    assert.equal(completed.statusCode, 200, completed.body);
    let cursor = 0, gotContent = false;
    const seen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const response = await s.page(cursor, 1); assert.equal(response.statusCode, 200, response.body);
      const page = response.json().data;
      for (const event of page.events) {
        assert.ok(event.serverSeq > cursor);
        assert.equal(seen.has(event.serverSeq), false); seen.add(event.serverSeq);
        gotContent ||= Boolean(event.payload?.content);
      }
      assert.ok(page.nextServerSeq >= cursor);
      cursor = page.nextServerSeq;
      if (!page.hasMore) break;
    }
    assert.equal(gotContent, true);
    const tail = await s.page(cursor, 1); assert.equal(tail.statusCode, 200, tail.body);
    assert.deepEqual(tail.json().data.events, []);
    const other = await s.f.login('other');
    const allocation = await command(s.f, s.teacher, `/api/activities/${s.activityId}/assignments`,
      { expectedActivityControlRevision: 1, studentIds: ['other'] });
    assert.equal(allocation.statusCode, 200, allocation.body);
    const otherAttempt = await opened(s.f, other, allocation.json().data.result.assignments[0].assignmentId);
    const otherState = await view(s.f, other, otherAttempt);
    const otherHelp = await command(s.f, other, `/fixture/help/${otherAttempt}`, { expectedAttemptRevision: otherState.attempt.attemptRevision,
      question: 'Another student question.', versions: s.versions });
    assert.equal(otherHelp.statusCode, 200, otherHelp.body);
    assert.deepEqual((await s.page(cursor)).json().data.events, []);
  } finally { await s.f.close(); }
});

test('review: a send without displayed does not survive cancellation or leak through raw reads', async () => {
  const s = await setup();
  try {
    const asked = await s.ask(), completed = await s.complete(asked.json().data.jobId);
    assert.equal(completed.statusCode, 200, completed.body);
    const raw = await s.f.app.inject({ url: `/api/attempts/${s.attemptId}/teaching-records`, headers: s.student });
    assert.equal(raw.statusCode, 200, raw.body);
    assert.equal(raw.json().data.messages.some((message: { authorKind: string }) => message.authorKind === 'model'), false);
    const firstPage = await s.page(); assert.equal(firstPage.statusCode, 200, firstPage.body);
    const delivery = firstPage.json().data.events.find((event: { payload?: { deliveryId?: string } }) => event.payload?.deliveryId).payload;
    const stopped = await command(s.f, s.student, `/api/jobs/${asked.json().data.jobId}/cancel`, {}, 'stop-1');
    assert.equal(stopped.statusCode, 200, stopped.body);
    assert.equal(s.records().actions[0]!.disposition, 'cancelled');
    const reread = await s.page(); assert.equal(reread.statusCode, 200, reread.body);
    assert.equal(reread.json().data.events.some((event: { payload?: { content?: string } }) => event.payload?.content), false);
    const displayed = await command(s.f, s.student, `/api/actions/${completed.json().data.actionId}/receipts`, {
      deliveryId: delivery.deliveryId, contentHash: delivery.contentHash, clientId: 'page-a', receiptKind: 'displayed',
      clientReceiptId: 'late-display', versions: s.versions });
    assert.equal(displayed.statusCode, 200, displayed.body);
    assert.match(displayed.json().data.raceReason, /cancelled|stop_requested/);
    assert.equal(s.records().actions[0]!.disposition, 'cancelled');
    const history = await s.f.app.inject({ url: `/api/attempts/${s.attemptId}/teaching-records`, headers: s.student });
    assert.equal(history.json().data.messages.some((message: { authorKind: string }) => message.authorKind === 'model'), true);
    await s.f.reopen();
    assert.equal((await s.page()).json().data.events.some((event: { payload?: { content?: string } }) => event.payload?.content), false);
  } finally { await s.f.close(); }
});

test('review: a client report binds delivery and versions, and same HTTP key retries succeed', async () => {
  const s = await setup();
  try {
    const asked = await s.ask(), completed = await s.complete(asked.json().data.jobId);
    assert.equal(completed.statusCode, 200, completed.body);
    const p = (await s.page()).json().data.events.find((event: { payload?: { deliveryId?: string } }) => event.payload?.deliveryId).payload;
    const target = `/api/actions/${completed.json().data.actionId}/receipts`;
    const report = { clientId: 'page-a', deliveryId: p.deliveryId, contentHash: p.contentHash, receiptKind: 'received', clientReceiptId: 'received-1', versions: s.versions };
    const wrongClient = await command(s.f, s.student, target, { ...report, clientId: 'page-b', clientReceiptId: 'fresh-wrong-client' });
    assert.equal(wrongClient.statusCode, 409, wrongClient.body);
    const wrongVersion = await command(s.f, s.student, target, { ...report, clientReceiptId: 'fresh-wrong-version',
      versions: { ...s.versions, policyVersionId: 'other-policy' } });
    assert.equal(wrongVersion.statusCode, 409, wrongVersion.body);
    const first = await command(s.f, s.student, target, report, 'http-report-1'); assert.equal(first.statusCode, 200, first.body);
    const again = await command(s.f, s.student, target, report, 'http-report-1'); assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().data.receiptId, first.json().data.receiptId);
    assert.equal(s.records().actions[0]!.receipts.length, 1);
    assert.deepEqual((await s.page(0, 100, 'page-b')).json().data.events.filter((event: { payload?: { deliveryId?: string } }) =>
      event.payload?.deliveryId === p.deliveryId), []);
  } finally { await s.f.close(); }
});

test('review: capture controls preserve explicit help and historical coverage/real rejection reasons', async () => {
  const s = await setup();
  try {
    const asked = await s.ask(); assert.equal(asked.statusCode, 200, asked.body);
    const original = (await s.state()).attempt;
    const paused = await command(s.f, s.student, `/api/attempts/${s.attemptId}/controls`,
      { expectedAttemptRevision: original.attemptRevision, control: { kind: 'capture', value: false } });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(paused.json().data.result.decisionEpoch, original.decisionEpoch);
    const completed = await s.complete(asked.json().data.jobId); assert.equal(completed.statusCode, 200, completed.body);
    assert.equal((await s.page()).statusCode, 200);
    const coverage = await s.f.app.inject({ url: `/api/attempts/${s.attemptId}/coverage`, headers: s.student });
    const intervals = coverage.json().data.intervals;
    assert.equal(intervals[0].state, 'collecting');
    assert.deepEqual(intervals[0].rejections, []);
    const saved = await command(s.f, s.student, `/api/attempts/${s.attemptId}/sync`, { expectedWorkspaceRevision: 1,
      clientId: 'page-a', clientSeq: 11, operations: [{ kind: 'update', fileId: s.fileId, baseVersion: 1, text: 'changed' }],
      process: { captureRevision: original.captureRevision } });
    assert.equal(saved.statusCode, 200, saved.body);
    const rejected = (await s.f.app.inject({ url: `/api/attempts/${s.attemptId}/coverage`, headers: s.student })).json().data;
    assert.ok(rejected.intervals.some((interval: { rejections: { receiptId: string; reason: string }[] }) =>
      interval.rejections.some(rejection => rejection.receiptId === saved.json().data.receiptId && rejection.reason === 'capture_paused')));
  } finally { await s.f.close(); }
});

test('review: A4 epoch/JSON/Job/Action invalidation commits together and stale CAS rolls back', async () => {
  const s = await setup();
  try {
    const asked = await s.ask(), completed = await s.complete(asked.json().data.jobId);
    assert.equal(completed.statusCode, 200, completed.body);
    const sent = (await s.page()).json().data.events.find((event: { payload?: { deliveryId?: string } }) => event.payload?.deliveryId).payload;
    const displayed = await command(s.f, s.student, `/api/actions/${completed.json().data.actionId}/receipts`, {
      deliveryId: sent.deliveryId, contentHash: sent.contentHash, clientId: 'page-a', receiptKind: 'displayed', clientReceiptId: 'shown-before-correction' });
    assert.equal(displayed.statusCode, 200, displayed.body);
    assert.equal((await command(s.f, s.student, `/api/jobs/${asked.json().data.jobId}/cancel`, {})).statusCode, 200);
    const next = await s.ask('A follow-up question.', 'question-2'); assert.equal(next.statusCode, 200, next.body);
    const nextResult = await s.complete(next.json().data.jobId); assert.equal(nextResult.statusCode, 200, nextResult.body);
    const attempt = (await s.state()).attempt, beforeBasis = s.records().actions.map(action => [action.actionId, action.basis]);
    const input = { actorId: 'teacher', courseId: 'course', studentId: 'student', attemptIds: [s.attemptId],
      expectedEpochs: { [s.attemptId]: attempt.decisionEpoch }, reason: 'Teacher corrected the basis.',
      causeRef: 'synthetic-decision', generation: s.f.generation(), now: new Date(s.f.timestamp()).toISOString() };
    const invalidated = s.f.db.withTransaction(tx => invalidateTeachingInTransaction(tx, input));
    assert.equal(invalidated.epochs[s.attemptId], attempt.decisionEpoch + 1);
    assert.equal((await s.state()).attempt.decisionEpoch, attempt.decisionEpoch + 1);
    assert.equal(s.records().actions.find(action => action.actionId === nextResult.json().data.actionId)!.disposition, 'stale');
    const history = s.records().actions.find(action => action.actionId === completed.json().data.actionId)!;
    assert.equal(history.disposition, 'cancelled'); assert.equal(history.basisRevised, true);
    assert.equal(history.receipts[0]!.receiptKind, 'displayed');
    assert.deepEqual(s.records().actions.map(action => [action.actionId, action.basis]), beforeBasis);
    const after = snapshot(s.f);
    assert.throws(() => s.f.db.withTransaction(tx => invalidateTeachingInTransaction(tx, input)), /epoch/);
    assert.deepEqual(snapshot(s.f), after);
    assert.equal((await s.page()).json().data.events.some((event: { payload?: { content?: string } }) => event.payload?.content), false);
  } finally { await s.f.close(); }
});

test('review: cancelling an old help Job leaves the new help Job usable', async () => {
  const s = await setup();
  try {
    const first = await s.ask(); assert.equal(first.statusCode, 200, first.body);
    assert.equal((await s.complete(first.json().data.jobId)).statusCode, 200);
    const second = await s.ask('Another question.', 'question-2'); assert.equal(second.statusCode, 200, second.body);
    const stopped = await command(s.f, s.student, `/api/jobs/${first.json().data.jobId}/cancel`, {});
    assert.equal(stopped.statusCode, 200, stopped.body);
    const newJob = (await s.state()).jobs.find((job: { jobId: string }) => job.jobId === second.json().data.jobId);
    assert.equal(newJob.stopRequested, false); assert.equal(newJob.status, 'queued');
    assert.equal((await s.complete(second.json().data.jobId)).statusCode, 200);
  } finally { await s.f.close(); }
});

test('review: code changes suppress an old target and an obsolete worker lease cannot complete', async () => {
  const s = await setup();
  try {
    const workspace = await s.state(), file = workspace.files.find((item: { fileId: string }) => item.fileId === s.fileId);
    const frozen = await command(s.f, s.student, `/api/attempts/${s.attemptId}/snapshots`, { expectedWorkspaceRevision: 1 });
    assert.equal(frozen.statusCode, 200, frozen.body);
    const asked = await s.ask('Explain this code.', 'code-question', { kind: 'code', attemptId: s.attemptId,
      snapshotId: frozen.json().data.result.snapshotId, fileId: s.fileId, path: file.path,
      documentVersion: file.documentVersion, contentHash: file.contentHash });
    assert.equal(asked.statusCode, 200, asked.body);
    const jobId = asked.json().data.jobId;
    s.f.db.withTransaction(tx => {
      const job = readJobs(tx, 'course').find(item => item.jobId === jobId)!;
      saveJob(tx, claimJob(job, 'current-lease', job.deadline, s.f.generation(), new Date(s.f.timestamp()).toISOString()));
    });
    const attempt = (await s.state()).attempt, before = snapshot(s.f);
    const staleWorker = { jobId, versions: s.versions, bodyJson: JSON.stringify(body('An old worker result.')),
      usage: { status: 'unknown' }, calls: 1, elapsedMs: 1,
      basis: { attemptRevision: attempt.attemptRevision, decisionEpoch: attempt.decisionEpoch, captureRevision: attempt.captureRevision,
        relatedStateRevision: 0, inputRefs: [], assistanceRefs: [], coverageRefs: [] } };
    const obsolete = await command(s.f, s.student, `/fixture/complete/${s.attemptId}`, { ...staleWorker, leaseToken: 'obsolete-lease' });
    assert.equal(obsolete.statusCode, 409, obsolete.body);
    // Omitting the lease must fail outright; falling back to the persisted holder's token would make the
    // lease recheck pass for a caller that never proved it holds the job.
    const omitted = await command(s.f, s.student, `/fixture/complete/${s.attemptId}`, staleWorker);
    assert.equal(omitted.statusCode, 400, omitted.body);
    assert.equal(snapshot(s.f), before);
    const completed = await s.complete(jobId, 'Review the scan loop.', undefined, 'current-lease');
    assert.equal(completed.statusCode, 200, completed.body);
    const edited = await command(s.f, s.student, `/api/attempts/${s.attemptId}/sync`, { expectedWorkspaceRevision: 1,
      clientId: 'page-a', clientSeq: 25, operations: [{ kind: 'update', fileId: s.fileId, baseVersion: 1, text: 'New code.' }] });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal((await s.page()).json().data.events.some((event: { payload?: { content?: string } }) => event.payload?.content), false);
  } finally { await s.f.close(); }
});

test('review: A2 pause invalidates a generated Action atomically without extending its public result', async () => {
  const s = await setup();
  try {
    const asked = await s.ask(), completed = await s.complete(asked.json().data.jobId);
    assert.equal(completed.statusCode, 200, completed.body);
    for (const statement of ['UPDATE activity_controls', 'UPDATE assignments', 'INSERT INTO attempts', 'INSERT INTO jobs',
      'INSERT INTO teaching_actions', 'INSERT INTO audit_events', 'INSERT INTO command_receipts']) {
      const before = snapshot(s.f); s.f.injectFailure(statement);
      const failed = await command(s.f, s.teacher, `/api/activities/${s.activityId}/controls`,
        { expectedActivityControlRevision: 1, action: 'pause', reason: 'Teacher pause.' }, 'pause-activity');
      s.f.injectFailure('');
      assert.equal(failed.statusCode, 503, `${statement}: ${failed.body}`);
      assert.deepEqual(snapshot(s.f), before);
    }
    const paused = await command(s.f, s.teacher, `/api/activities/${s.activityId}/controls`,
      { expectedActivityControlRevision: 1, action: 'pause', reason: 'Teacher pause.' }, 'pause-activity');
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(Object.hasOwn(paused.json().data.result, 'invalidatedActionIds'), false);
    assert.equal(s.records().actions[0]!.disposition, 'cancelled');
    assert.equal((await s.state()).jobs[0].stopRequested, true);
    assert.equal((await s.page()).json().data.events.some((event: { payload?: { content?: string } }) => event.payload?.content), false);
  } finally { await s.f.close(); }
});

test('review: pausing capture persistently stops passive analysis and a resume never revives it', async () => {
  const s = await setup();
  try {
    const asked = await s.ask(); assert.equal(asked.statusCode, 200, asked.body);
    const passiveJobId = queueAnalysis(s, 'passive_analysis');
    const attempt = (await s.state()).attempt;
    const paused = await command(s.f, s.student, `/api/attempts/${s.attemptId}/controls`,
      { expectedAttemptRevision: attempt.attemptRevision, control: { kind: 'capture', value: false } });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.deepEqual(paused.json().data.result.cancelledJobIds, [passiveJobId]);
    const analysis = () => s.f.db.withTransaction(tx => readJobs(tx, 'course')).filter(job => job.purpose === 'passive_analysis')
      .map(job => [job.stopRequested, job.status]);
    // The stop is persisted rather than merely planned: the job row itself carries the intent and a terminal status.
    assert.deepEqual(analysis(), [[true, 'cancelled']]);
    // The explicit help round the capture switch never owned still completes and stays deliverable.
    const completed = await s.complete(asked.json().data.jobId); assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(s.records().actions[0]!.disposition, 'pending');
    const resumed = await command(s.f, s.student, `/api/attempts/${s.attemptId}/controls`,
      { expectedAttemptRevision: (await s.state()).attempt.attemptRevision, control: { kind: 'capture', value: true } });
    assert.equal(resumed.statusCode, 200, resumed.body);
    // Resuming does not accept the old passive analysis: the stopped job keeps its intent and status.
    assert.deepEqual(analysis(), [[true, 'cancelled']]);
    assert.equal(s.records().actions[0]!.disposition, 'pending');
  } finally { await s.f.close(); }
});

test('review: client cancelled/stale/failed reports need no delivery and erase no other fact', async () => {
  const s = await setup();
  try {
    const asked = await s.ask(), completed = await s.complete(asked.json().data.jobId);
    assert.equal(completed.statusCode, 200, completed.body);
    const actionId = completed.json().data.actionId;
    const sent = (await s.page()).json().data.events.find((event: { payload?: { deliveryId?: string } }) => event.payload?.deliveryId).payload;
    const target = `/api/actions/${actionId}/receipts`;
    const displayed = await command(s.f, s.student, target, { deliveryId: sent.deliveryId, contentHash: sent.contentHash,
      clientId: 'page-a', receiptKind: 'displayed', clientReceiptId: 'shown-1', versions: s.versions });
    assert.equal(displayed.statusCode, 200, displayed.body);
    const before = (await s.state()).attempt;
    for (const [receiptKind, clientReceiptId] of [['cancelled', 'client-1'], ['stale', 'client-2'], ['failed', 'client-3']] as const) {
      const reported = await command(s.f, s.student, target, { contentHash: sent.contentHash, clientId: 'page-a',
        receiptKind, clientReceiptId });
      assert.equal(reported.statusCode, 200, `${receiptKind}: ${reported.body}`);
      assert.equal(reported.json().data.receiptKind, receiptKind);
    }
    const action = s.records().actions[0]!;
    assert.deepEqual(action.receipts.map(receipt => receipt.receiptKind), ['displayed', 'cancelled', 'stale', 'failed']);
    // A client-side stop report is a channel fact: it neither revokes the display nor rolls back current control.
    assert.equal(action.disposition, 'pending');
    const after = (await s.state()).attempt;
    assert.deepEqual([after.decisionEpoch, after.captureRevision, after.attemptRevision],
      [before.decisionEpoch, before.captureRevision, before.attemptRevision]);
    // The same client receipt id returns the original fact instead of appending a second one.
    const replay = await command(s.f, s.student, target, { contentHash: sent.contentHash, clientId: 'page-a',
      receiptKind: 'cancelled', clientReceiptId: 'client-1' });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().data.replayed, true);
    assert.equal(s.records().actions[0]!.receipts.length, 4);
    // An already displayed action is not handed to another channel because a client reported a failure.
    assert.equal((await s.page(0, 100, 'page-b')).json().data.events
      .some((event: { payload?: { content?: string } }) => event.payload?.content), false);
  } finally { await s.f.close(); }
});

test('review: verification script has no automatic deletion or toolchain installation', () => {
  const script = readFileSync(new URL('../../tools/wsl-verify.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /\brm\s+-|\bcurl\s|\bnpm\s+ci\b|node-gyp/);
});
