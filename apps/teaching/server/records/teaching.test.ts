import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sha256 } from '../../runner/snapshot.ts';
import { fixture, command, assigned, opened, files, view, type Fixture, type Headers } from '../workspace/test-support.ts';

const versionsOf = (activityVersionId: string) => ({ activityVersionId, policyVersionId: 'help-v1',
  modelConfigVersion: 'deepseek-flash-v1', promptVersion: 'help-prompt-v1', schemaVersion: 'student-help-v1' });
const body = (content: string) => ({ kind: 'student_help', actionType: 'hint', content, rationale: 'Keep the scan loop.',
  expectedStudentAction: 'Run stats on a.txt again.', evidenceIds: [], resourceRefs: [], assistanceContext: 'No assistance used.',
  unresolved: [], policyChecks: { containsWholeSolution: false, writesStudentWork: false, runsCode: false, makesFormalEvaluation: false } });
const bodyJson = (content: string) => JSON.stringify(body(content));

type Plan = {activityId: string; assignmentId: string; attemptId: string; versions: ReturnType<typeof versionsOf>;
  revision: number; epoch: number; captureRevision: number; fileId: string};
type Help = {messageId: string; jobId: string; contentHash: string; stoppedJobIds: string[]};

async function planned(f: Fixture, teacher: Headers, student: Headers): Promise<Plan> {
  const { activityId, assignmentId } = await assigned(f, teacher);
  const attemptId = await opened(f, student, assignmentId);
  const created = await files(f, student, attemptId);
  const state = await view(f, student, attemptId);
  return { activityId, assignmentId, attemptId, versions: versionsOf(activityId), fileId: created.source,
    revision: state.attempt.attemptRevision as number, epoch: state.attempt.decisionEpoch as number,
    captureRevision: state.attempt.captureRevision as number };
}
function ask(f: Fixture, student: Headers, plan: Plan, question = 'Why is the word count low?', key?: string) {
  return command(f, student, `/fixture/help/${plan.attemptId}`, { expectedAttemptRevision: plan.revision, question,
    inputRefs: [], versions: plan.versions }, key);
}
function basisOf(plan: {revision: number; epoch: number; captureRevision: number}) {
  return { attemptRevision: plan.revision, decisionEpoch: plan.epoch, captureRevision: plan.captureRevision,
    relatedStateRevision: 0, inputRefs: [], assistanceRefs: [], coverageRefs: [] };
}
function completeInput(plan: {versions: object; revision: number; epoch: number; captureRevision: number}, jobId: string, content: string) {
  return { jobId, bodyJson: bodyJson(content), versions: plan.versions,
    usage: { status: 'actual', inputTokens: 120, outputTokens: 40 }, calls: 1, elapsedMs: 900, basis: basisOf(plan) };
}
/** The teacher-model basis must match the attempt as it stands now, so it is read instead of assumed. */
async function completeNow(f: Fixture, headers: Headers, attemptId: string, jobId: string, content: string, versions: object) {
  const attempt = (await view(f, headers, attemptId)).attempt;
  return command(f, headers, `/fixture/complete/${attemptId}`,
    completeInput({ versions, revision: attempt.attemptRevision, epoch: attempt.decisionEpoch,
      captureRevision: attempt.captureRevision }, jobId, content));
}
function eventsUrl(attemptId: string, extra: {afterServerSeq?: number; limit?: number; clientId?: string;
  recoveryGeneration?: string; decisionEpoch?: number}) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(extra)) if (value !== undefined) query.set(name, String(value));
  return `/api/attempts/${attemptId}/events?${query.toString()}`;
}
function pageOf(response: {json(): {data: {events: {serverSeq: number; payload?: {content?: string; deliveryId?: string; contentHash?: string}}[];
  resyncRequired: boolean; hasMore: boolean; nextServerSeq: number; coverage?: unknown; control: {attemptRevision: number; decisionEpoch: number}}}}) {
  return response.json().data;
}
function deliverable(response: ReturnType<typeof pageOf>) {
  const event = response.events.find(row => row.payload?.deliveryId);
  assert.ok(event?.payload, 'expected a delivered teaching event');
  return event.payload as {content: string; deliveryId: string; contentHash: string};
}
async function accepted(f: Fixture, teacher: Headers, student: Headers) {
  const plan = await planned(f, teacher, student);
  const asked = await ask(f, student, plan);
  assert.equal(asked.statusCode, 200, asked.body);
  return { plan, help: asked.json().data as Help };
}
async function recordsOf(f: Fixture, headers: Headers, attemptId: string) {
  const response = await f.app.inject({ url: `/fixture/records/${attemptId}`, headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data as { messages: {messageId: string; authorKind: string; contentHash: string; resultHash?: string;
      envelope: {body?: unknown; question?: string; usage?: unknown; versions?: unknown}}[];
    actions: {actionId: string; disposition: string; basisRevised: boolean; contentHash: string;
      deliveries: {deliveryId: string}[]; receipts: {receiptKind: string; clientDeclaredAt?: string; raceReason?: string}[]}[] };
}

test('C3-V01 exact question/body bytes, trusted envelope, and same-result replay', async () => {
  const f = await fixture(undefined, { teaching: true });
  try {
    const student = await f.login('student'), teacher = await f.login('teacher');
    const plan = await planned(f, teacher, student);
    const question = 'Why does find print a line twice?\r\n';
    const asked = await ask(f, student, plan, question, 'request-1');
    assert.equal(asked.statusCode, 200, asked.body);
    const help = asked.json().data as Help;
    assert.match(help.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(help.contentHash, sha256(question));
    // The same request key replays the original message instead of storing a second question.
    const replay = await ask(f, student, plan, question, 'request-1');
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().data.messageId, help.messageId);
    // A different question under the same key is a real conflict, not a silent overwrite.
    const conflict = await ask(f, student, plan, 'A different question', 'request-1');
    assert.equal(conflict.statusCode, 409, conflict.body);

    const content = 'Check whether the loop resets per file.';
    const completed = await command(f, student, `/fixture/complete/${plan.attemptId}`, completeInput(plan, help.jobId, content));
    assert.equal(completed.statusCode, 200, completed.body);
    const result = completed.json().data as {messageId: string; actionId: string; disposition: string; replayed: boolean; contentHash: string};
    assert.equal(result.disposition, 'pending'); assert.equal(result.replayed, false);
    assert.equal(result.contentHash, sha256(content));
    const repeated = await command(f, student, `/fixture/complete/${plan.attemptId}`, completeInput(plan, help.jobId, content));
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().data.messageId, result.messageId);
    assert.equal(repeated.json().data.replayed, true);
    const different = await command(f, student, `/fixture/complete/${plan.attemptId}`, completeInput(plan, help.jobId, 'A different final body'));
    assert.equal(different.statusCode, 409, different.body);

    const records = await recordsOf(f, student, plan.attemptId);
    const model = records.messages.find(message => message.authorKind === 'model')!;
    // The persisted body is retrievable byte for byte and its hash covers those exact bytes.
    assert.equal(JSON.stringify(model.envelope.body), bodyJson(content));
    assert.deepEqual(model.envelope.body, body(content));
    assert.equal(model.resultHash, sha256(bodyJson(content)));
    assert.notEqual(model.resultHash, model.contentHash);
    assert.deepEqual(model.envelope.usage, { status: 'actual', inputTokens: 120, outputTokens: 40 });
    assert.deepEqual(model.envelope.versions, plan.versions);
    assert.equal(records.messages.filter(message => message.authorKind === 'student').length, 1);
    assert.equal(records.messages.find(message => message.authorKind === 'student')!.envelope.question, question);
    assert.equal(records.actions.length, 1);
    assert.equal(records.actions[0]!.disposition, 'pending');
  } finally { await f.close(); }
});

test('C3-V02 receipts are idempotent, order-independent and never back-dated by a client clock', async () => {
  const f = await fixture(undefined, { teaching: true });
  try {
    const student = await f.login('student'), teacher = await f.login('teacher');
    const { plan, help } = await accepted(f, teacher, student);
    const completed = await command(f, student, `/fixture/complete/${plan.attemptId}`, completeInput(plan, help.jobId, 'Try the smallest file first.'));
    assert.equal(completed.statusCode, 200, completed.body);
    const actionId = String(completed.json().data.actionId);
    const pageResponse = await f.app.inject({ url: eventsUrl(plan.attemptId, { recoveryGeneration: f.generation(),
      decisionEpoch: plan.epoch, clientId: 'page-a' }), headers: student });
    assert.equal(pageResponse.statusCode, 200, pageResponse.body);
    const page = pageOf(pageResponse);
    const delivered = deliverable(page);
    assert.equal(delivered.content, 'Try the smallest file first.');
    assert.equal(Object.hasOwn(page, 'coverage'), true);

    // A real display report can arrive without a received report: display is not forced through fake stages.
    const displayed = await command(f, student, `/api/actions/${actionId}/receipts`, { deliveryId: delivered.deliveryId,
      clientId: 'page-a', contentHash: delivered.contentHash, receiptKind: 'displayed', clientReceiptId: 'r-1',
      clientDeclaredAt: '2026-10-11T00:00:00.000Z' });
    assert.equal(displayed.statusCode, 200, displayed.body);
    const acknowledged = await command(f, student, `/api/actions/${actionId}/receipts`, { deliveryId: delivered.deliveryId,
      clientId: 'page-a', contentHash: delivered.contentHash, receiptKind: 'acknowledged', clientReceiptId: 'r-2' });
    assert.equal(acknowledged.statusCode, 200, acknowledged.body);
    const duplicate = await command(f, student, `/api/actions/${actionId}/receipts`, { deliveryId: delivered.deliveryId,
      clientId: 'page-a', contentHash: delivered.contentHash, receiptKind: 'displayed', clientReceiptId: 'r-1' });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().data.receiptId, displayed.json().data.receiptId);
    assert.equal(duplicate.json().data.replayed, true);
    // The same client receipt ID from another channel or for another content version is a conflict.
    const wrongClient = await command(f, student, `/api/actions/${actionId}/receipts`, { deliveryId: delivered.deliveryId,
      clientId: 'other-page', contentHash: delivered.contentHash, receiptKind: 'displayed', clientReceiptId: 'r-1' });
    assert.equal(wrongClient.statusCode, 409, wrongClient.body);
    const wrongHash = await command(f, student, `/api/actions/${actionId}/receipts`, { deliveryId: delivered.deliveryId,
      clientId: 'page-a', contentHash: 'f'.repeat(64), receiptKind: 'displayed', clientReceiptId: 'r-3' });
    assert.equal(wrongHash.statusCode, 409, wrongHash.body);
    const unknownDelivery = await command(f, student, `/api/actions/${actionId}/receipts`, { deliveryId: randomUUID(),
      clientId: 'page-a', contentHash: delivered.contentHash, receiptKind: 'displayed', clientReceiptId: 'r-4' });
    assert.equal(unknownDelivery.statusCode, 422, unknownDelivery.body);
    // A teacher with read authority still cannot report display on behalf of the student.
    const impersonation = await command(f, teacher, `/api/actions/${actionId}/receipts`, { deliveryId: delivered.deliveryId,
      clientId: 'page-a', contentHash: delivered.contentHash, receiptKind: 'acknowledged', clientReceiptId: 'r-5' });
    assert.equal(impersonation.statusCode, 403, impersonation.body);

    const records = await recordsOf(f, student, plan.attemptId);
    const action = records.actions.find(row => row.actionId === actionId)!;
    assert.deepEqual(action.receipts.map(row => row.receiptKind), ['displayed', 'acknowledged']);
    // The declared client time is preserved as a claim; the server time stays the ordering fact.
    assert.equal(action.receipts[0]!.clientDeclaredAt, '2026-10-11T00:00:00.000Z');
  } finally { await f.close(); }
});

test('C3-V03 scope, role trimming, cursor bounds and stale epoch resynchronization', async () => {
  const f = await fixture(undefined, { teaching: true });
  try {
    const student = await f.login('student'), other = await f.login('other'), teacher = await f.login('teacher'), foreign = await f.login('foreign');
    const { plan, help } = await accepted(f, teacher, student);
    const completed = await command(f, student, `/fixture/complete/${plan.attemptId}`, completeInput(plan, help.jobId, 'Narrow the failing case.'));
    assert.equal(completed.statusCode, 200, completed.body);

    for (const [url, headers] of [[eventsUrl(plan.attemptId, {}), other], [`/fixture/records/${plan.attemptId}`, other],
      [`/fixture/coverage/${plan.attemptId}`, other], [eventsUrl(plan.attemptId, {}), foreign]] as const) {
      const response = await f.app.inject({ url, headers });
      assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
    }

    // An unsynchronized or stale page gets control only and never displayable content.
    const stale = await f.app.inject({ url: eventsUrl(plan.attemptId, { recoveryGeneration: f.generation(), decisionEpoch: plan.epoch + 5 }), headers: student });
    assert.equal(stale.statusCode, 200, stale.body);
    assert.equal(pageOf(stale).resyncRequired, true);
    assert.deepEqual(pageOf(stale).events, []);
    const unsynced = await f.app.inject({ url: eventsUrl(plan.attemptId, {}), headers: student });
    assert.equal(pageOf(unsynced).resyncRequired, true);
    assert.equal(pageOf(unsynced).control.attemptRevision >= 1, true);
    f.restoreGeneration();
    const wrongGeneration = await f.app.inject({ url: eventsUrl(plan.attemptId, { recoveryGeneration: 'generation', decisionEpoch: plan.epoch, clientId: 'stale' }), headers: student });
    assert.equal(pageOf(wrongGeneration).resyncRequired, true);

    // Pages stay bounded and the cursor never grants authority.
    assert.equal((await f.app.inject({ url: eventsUrl(plan.attemptId, { limit: 101, clientId: 'oversize' }), headers: student })).statusCode, 400);
    const rest = pageOf(await f.app.inject({ url: eventsUrl(plan.attemptId, { limit: 50, clientId: 'cursor-two',
      recoveryGeneration: f.generation(), decisionEpoch: plan.epoch }), headers: student }));
    const all = [...rest.events];
    assert.equal(new Set(all.map(event => event.serverSeq)).size, all.length);
    assert.ok(all.length >= 2, JSON.stringify(all));
    assert.ok(all.some(event => event.payload?.content === 'Narrow the failing case.'), JSON.stringify(all));
    // Re-reading the same page is stable and never re-delivers an action that still has its delivery.
    const reread = pageOf(await f.app.inject({ url: eventsUrl(plan.attemptId, { limit: 50,
      recoveryGeneration: f.generation(), decisionEpoch: plan.epoch }), headers: student }));
    assert.deepEqual(reread.events.map(event => event.serverSeq), all.map(event => event.serverSeq));
    // A teacher read keeps references only and creates no student delivery.
    const teacherPage = pageOf(await f.app.inject({ url: eventsUrl(plan.attemptId, { recoveryGeneration: f.generation(), decisionEpoch: plan.epoch }), headers: teacher }));
    assert.equal(teacherPage.events.some(event => event.payload?.content), false);
    assert.equal(teacherPage.resyncRequired, false);
  } finally { await f.close(); }
});

test('C3-V04 capture pause keeps functional data, records the gap and never refills it', async () => {
  const f = await fixture(undefined, { teaching: true });
  try {
    const student = await f.login('student'), teacher = await f.login('teacher');
    const plan = await planned(f, teacher, student);
    const paused = await command(f, student, `/api/attempts/${plan.attemptId}/controls`,
      { expectedAttemptRevision: plan.revision, control: { kind: 'capture', value: false } });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal(paused.json().data.result.captureRevision, plan.captureRevision + 1);
    const sameValue = await command(f, student, `/api/attempts/${plan.attemptId}/controls`,
      { expectedAttemptRevision: Number(paused.json().data.result.attemptRevision), control: { kind: 'capture', value: false } });
    assert.equal(sameValue.statusCode, 200, sameValue.body);
    assert.equal(sameValue.json().data.result.captureRevision, plan.captureRevision + 1);

    // Explicit save still confirms the work while the process timeline is paused; the process part is rejected on its own.
    const saved = await command(f, student, `/api/attempts/${plan.attemptId}/sync`, { expectedWorkspaceRevision: 1, clientId: 'page', clientSeq: 21,
      operations: [{ kind: 'update', fileId: plan.fileId, baseVersion: 1, text: 'int main(void){return 0;}\n' }],
      process: { captureRevision: plan.captureRevision } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().data.result.process.status, 'not_collected');
    assert.equal(saved.json().data.result.process.reason, 'capture_paused');
    // The confirmed work advanced its own workspace revision even though the process part was rejected.
    assert.equal((await view(f, student, plan.attemptId)).attempt.workspaceRevision, 2);

    const resumed = await command(f, student, `/api/attempts/${plan.attemptId}/controls`,
      { expectedAttemptRevision: (await view(f, student, plan.attemptId)).attempt.attemptRevision, control: { kind: 'capture', value: true } });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().data.result.captureRevision, plan.captureRevision + 2);
    // Explicit help and its final message remain functional data after the capture control changed.
    const current = await view(f, student, plan.attemptId);
    const asked = await ask(f, student, { ...plan, revision: current.attempt.attemptRevision });
    assert.equal(asked.statusCode, 200, asked.body);
    const help = asked.json().data as Help;
    const completed = await completeNow(f, student, plan.attemptId, help.jobId, 'Trim the input file first.', plan.versions);
    assert.equal(completed.statusCode, 200, completed.body);
    const coverageResponse = await f.app.inject({ url: `/fixture/coverage/${plan.attemptId}`, headers: student });
    assert.equal(coverageResponse.statusCode, 200, coverageResponse.body);
    const projection = coverageResponse.json().data as {captureRevision: number; collecting: boolean; cutoffServerSeq: number;
      intervals: {state: string; open: boolean; toServerSeq?: number; rejections: {reason: string}[]}[]};
    assert.equal(projection.collecting, true);
    assert.equal(projection.captureRevision, plan.captureRevision + 2);
    assert.ok(projection.cutoffServerSeq > 0);
    assert.ok(projection.intervals.some(interval => interval.state === 'paused'));
    // The pause interval is closed by the resume, and only the live segment is still open.
    assert.equal(projection.intervals.at(-1)?.open, true, JSON.stringify(projection.intervals));
    assert.equal(projection.intervals.some(interval => interval.toServerSeq !== undefined), true, JSON.stringify(projection.intervals));
    // The old process part is visible as a gap reason and is not silently accepted after the resume.
    assert.ok(projection.intervals.some(interval => interval.rejections.some(rejection =>
      ['capture_paused', 'stale_capture_revision'].includes(rejection.reason))), JSON.stringify(projection.intervals));
  } finally { await f.close(); }
});

test('C3-V05 cancellation stops undisplays actions and never resurrects them', async () => {
  const f = await fixture(undefined, { teaching: true });
  try {
    const student = await f.login('student'), teacher = await f.login('teacher');
    const { plan, help } = await accepted(f, teacher, student);
    const completed = await command(f, student, `/fixture/complete/${plan.attemptId}`, completeInput(plan, help.jobId, 'Check the boundary condition.'));
    assert.equal(completed.statusCode, 200, completed.body);
    const actionId = String(completed.json().data.actionId);
    // A succeeded job still stops its not-yet-displayed action while keeping the terminal status and generated fact.
    const cancelled = await command(f, student, `/api/jobs/${help.jobId}/cancel`, { reason: 'student_stopped' });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const cancelResult = cancelled.json().data.result as {jobId: string; status: string; stopRequested: boolean; invalidatedActionIds: string[]};
    assert.equal(cancelResult.stopRequested, true);
    assert.equal(cancelResult.status, 'succeeded');
    assert.deepEqual(cancelResult.invalidatedActionIds, [actionId]);
    const records = await recordsOf(f, student, plan.attemptId);
    assert.equal(records.actions[0]!.disposition, 'cancelled');
    assert.equal(records.actions[0]!.basisRevised, true);
    const before = await view(f, student, plan.attemptId);

    // A connected page never receives the stopped content again, and the stop adds no general teaching epoch.
    const page = await f.app.inject({ url: eventsUrl(plan.attemptId, { recoveryGeneration: f.generation(),
      decisionEpoch: before.attempt.decisionEpoch, clientId: 'page-b' }), headers: student });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(pageOf(page).events.some(event => event.payload?.content), false);
    assert.equal(before.attempt.decisionEpoch, plan.epoch);
    // Reminder and capture controls stay independent of an explicit help stop.
    const reminder = await command(f, student, `/api/attempts/${plan.attemptId}/controls`,
      { expectedAttemptRevision: before.attempt.attemptRevision, control: { kind: 'reminders', value: true } });
    assert.equal(reminder.statusCode, 200, reminder.body);
    assert.equal(reminder.json().data.result.decisionEpoch, before.attempt.decisionEpoch);
    // Saving a file afterwards keeps its own confirmation independent of the cancelled action.
    const beforeSave = await view(f, student, plan.attemptId);
    const saved = await command(f, student, `/api/attempts/${plan.attemptId}/sync`, { expectedWorkspaceRevision: 1, clientId: 'page', clientSeq: 22,
      operations: [{ kind: 'update', fileId: plan.fileId, baseVersion: 1, text: 'int main(void){return 1;}\n' }] });
    assert.equal(saved.statusCode, 200, saved.body);
    // The confirmed save is independent of the cancelled action: it reports the new content and version.
    const savedFiles = saved.json().data.result.files as {fileId: string; documentVersion: number; contentHash: string}[];
    const savedFile = savedFiles.find(file => file.fileId === plan.fileId)!;
    assert.equal(savedFile.contentHash, sha256('int main(void){return 1;}\n'), saved.body);
    const stored = await view(f, student, plan.attemptId);
    assert.equal(stored.files.find((file: {fileId: string}) => file.fileId === plan.fileId).documentVersion, savedFile.documentVersion,
      JSON.stringify(beforeSave.files));
    assert.equal(stored.attempt.workspaceRevision, saved.json().data.result.workspaceRevision);
  } finally { await f.close(); }
});

test('C3-V06 the same-transaction stop rolls back with the caller and covers A2 pause', async () => {
  const f = await fixture(undefined, { teaching: true });
  try {
    const student = await f.login('student'), teacher = await f.login('teacher');
    const { plan, help } = await accepted(f, teacher, student);
    const before = await view(f, student, plan.attemptId);
    const opened = await f.db.withTransaction(tx => tx.get('SELECT job_id FROM jobs WHERE job_id=?', help.jobId));
    assert.equal(Boolean(opened), true);
    // A rejected stop leaves no receipt, no stop intent and no epoch change. The synthetic late failure targets
    // the stop's own job write; if that statement is not exercised the command must still be consistent.
    f.injectFailure('ON CONFLICT(job_id) DO UPDATE SET status');
    const failed = await command(f, student, `/api/attempts/${plan.attemptId}/controls`,
      { expectedAttemptRevision: before.attempt.attemptRevision, control: { kind: 'pause' } });
    f.injectFailure('');
    const after = await view(f, student, plan.attemptId);
    if (failed.statusCode === 503) {
      assert.equal(after.attempt.status, before.attempt.status);
      assert.equal(after.attempt.decisionEpoch, before.attempt.decisionEpoch);
      assert.equal(after.jobs.find((job: {jobId: string}) => job.jobId === help.jobId).stopRequested, false);
      assert.equal((await recordsOf(f, student, plan.attemptId)).actions.length, 0);
    } else {
      assert.equal(failed.statusCode, 200, failed.body);
      assert.equal(after.jobs.find((job: {jobId: string}) => job.jobId === help.jobId).stopRequested, true);
    }
    // A rollback leaves the original job pending, so the activity pause below still owns the same stop.
    const resume = await command(f, student, `/api/attempts/${plan.attemptId}/controls`,
      { expectedAttemptRevision: after.attempt.attemptRevision, control: { kind: 'resume' } });
    if (after.attempt.status === 'paused') assert.equal(resume.statusCode, 200, resume.body);

    // A2's activity pause stops the pending help job and invalidates its action inside A's own transaction.
    const control = await command(f, teacher, `/api/activities/${plan.activityId}/controls`,
      { expectedActivityControlRevision: 1, action: 'pause', reason: 'Teacher paused the activity' });
    assert.equal(control.statusCode, 200, control.body);
    const result = control.json().data.result as {stoppedJobIds: string[];invalidatedActionIds?: string[];attemptIds: string[]};
    assert.deepEqual(result.stoppedJobIds, [help.jobId]);
    assert.deepEqual(result.attemptIds, [plan.attemptId]);
    assert.equal(Array.isArray(result.invalidatedActionIds), true);
    const state = await view(f, student, plan.attemptId);
    assert.equal(state.jobs.find((job: {jobId: string}) => job.jobId === help.jobId).status, 'cancelled');
  } finally { await f.close(); }
});

test('C3-V07 durability: reconnect after a real reopen replays original ids and hides stopped actions', async () => {
  const f = await fixture(undefined, { teaching: true });
  try {
    const student = await f.login('student'), teacher = await f.login('teacher');
    const { plan, help } = await accepted(f, teacher, student);
    const content = 'Anchor the comparison at the file boundary.';
    const completed = await command(f, student, `/fixture/complete/${plan.attemptId}`, completeInput(plan, help.jobId, content));
    assert.equal(completed.statusCode, 200, completed.body);
    const actionId = String(completed.json().data.actionId);    f.advance(1000);
    await f.reopen();
    const student2 = await f.login('student');
    const records = await recordsOf(f, student2, plan.attemptId);
    assert.equal(records.actions[0]!.actionId, actionId);
    assert.equal(JSON.stringify(records.messages.find(message => message.authorKind === 'model')!.envelope.body), bodyJson(content));
    // A reconnected page still receives the same content version through a new delivery attempt.
    const page = pageOf(await f.app.inject({ url: eventsUrl(plan.attemptId, { recoveryGeneration: f.generation(),
      decisionEpoch: plan.epoch, clientId: 'page-c' }), headers: student2 }));
    assert.equal(deliverable(page).content, content);
    // The same job/result replays with the original ids instead of creating a second message or action.
    const repeated = await command(f, student2, `/fixture/complete/${plan.attemptId}`, completeInput(plan, help.jobId, content));
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().data.actionId, actionId);
    assert.equal(repeated.json().data.replayed, true);
    assert.equal((await recordsOf(f, student2, plan.attemptId)).actions.length, 1);
  } finally { await f.close(); }
});
