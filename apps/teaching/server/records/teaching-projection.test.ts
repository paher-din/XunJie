import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ObjectRef } from '../../contracts/workspace/index.ts';
import type { TeachingActionRecord, TeachingEventPayload, TeachingEventsPage } from '../../contracts/records/index.ts';
import { fixture, assigned, opened, files, snapshot, view, command, origin, type Headers } from '../workspace/test-support.ts';
import { readTeachingRecordsInTransaction } from './teaching.ts';
import { createTeachingRecordsApp } from './application.ts';

const content = 'Check the smallest input, then explain the scan loop.';
const body = { kind: 'student_help', actionType: 'hint', content, rationale: 'Check one condition.',
  expectedStudentAction: 'Try a small case.', evidenceIds: [], resourceRefs: [], assistanceContext: 'Unknown', unresolved: [],
  policyChecks: { containsWholeSolution: false, writesStudentWork: false, runsCode: false, makesFormalEvaluation: false } };

async function setup() {
  const f = await fixture(undefined, { teaching: true });
  const student = await f.login('student'), teacher = await f.login('teacher');
  const { activityId, assignmentId } = await assigned(f, teacher);
  const attemptId = await opened(f, student, assignmentId);
  const created = await files(f, student, attemptId);
  const snapshotId = await snapshot(f, student, attemptId);
  const versions = { activityVersionId: activityId, policyVersionId: 'help-v1', modelConfigVersion: 'synthetic-model-v1',
    promptVersion: 'synthetic-prompt-v1', schemaVersion: 'synthetic-schema-v1' };
  const state = () => view(f, student, attemptId);
  const records = () => f.db.withTransaction(tx => readTeachingRecordsInTransaction(tx, { courseId: 'course', studentId: 'student', attemptId }));
  async function codeRef(): Promise<ObjectRef> {
    const file = (await state()).files.find((item: {fileId: string}) => item.fileId === created.source)!;
    return { kind: 'code', attemptId, snapshotId, fileId: file.fileId, path: file.path,
      documentVersion: file.documentVersion, contentHash: file.contentHash,
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 } };
  }
  async function round(objectRef?: ObjectRef) {
    const asked = await command(f, student, `/fixture/help/${attemptId}`, { question: 'Explain this original object.', versions,
      expectedAttemptRevision: (await state()).attempt.attemptRevision, ...(objectRef ? { objectRef } : {}) });
    assert.equal(asked.statusCode, 200, asked.body);
    const help = asked.json().data as { jobId: string; messageId: string };
    const attempt = (await state()).attempt;
    const completed = await command(f, student, `/fixture/complete/${attemptId}`, { jobId: help.jobId, leaseToken: 'synthetic-worker-lease',
      versions, bodyJson: JSON.stringify(body), usage: { status: 'unknown' }, calls: 0, elapsedMs: 0,
      basis: { attemptRevision: attempt.attemptRevision, decisionEpoch: attempt.decisionEpoch, captureRevision: attempt.captureRevision,
        relatedStateRevision: 0, inputRefs: [], assistanceRefs: [], coverageRefs: [] } });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().data.disposition, 'pending');
    const action = records().actions.find(a => a.actionId === completed.json().data.actionId)!;
    return { help, action };
  }
  async function page(extra: { clientId?: string; decisionEpoch?: number; recoveryGeneration?: string; afterServerSeq?: number } = {}, headers = student) {
    const attempt = (await state()).attempt;
    const query = new URLSearchParams({ limit: '100', afterServerSeq: '0', clientId: 'page-a', recoveryGeneration: f.generation(),
      decisionEpoch: String(attempt.decisionEpoch) });
    for (const [key, value] of Object.entries(extra)) query.set(key, String(value));
    return f.app.inject({ url: `/api/attempts/${attemptId}/events?${query}`, headers });
  }
  return { f, student, teacher, activityId, assignmentId, attemptId, created, snapshotId, versions, state, records, codeRef, round, page };
}

function data(response: {statusCode: number; body: string; json(): {data: TeachingEventsPage}}) {
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data;
}
function payloadFor(page: TeachingEventsPage, actionId: string): TeachingEventPayload {
  const payload = page.events.find(event => event.payload?.actionId === actionId)?.payload;
  assert(payload?.content, 'original authorized body must accompany the association');
  return payload;
}
function assertAssociation(payload: TeachingEventPayload, action: TeachingActionRecord) {
  assert.equal(payload.actionId, action.actionId); assert.equal(payload.contentHash, action.contentHash);
  assert.equal(payload.jobId, action.jobId); assert.equal(payload.messageId, action.messageId);
  assert.equal(payload.generation, action.generation); assert.deepEqual(payload.scope, action.scope);
  assert.deepEqual(payload.targetVersions, action.targetVersions);
  assert.deepEqual(payload.basis, { attemptRevision: action.basis.attemptRevision, decisionEpoch: action.basis.decisionEpoch,
    captureRevision: action.basis.captureRevision, relatedStateRevision: action.basis.relatedStateRevision,
    ...(action.basis.objectRef ? { objectRef: action.basis.objectRef } : {}) });
  assert.deepEqual(Object.keys(payload).sort(), ['actionId', 'contentHash', 'disposition', 'createdAt', 'basisRevised',
    'scope', 'jobId', 'messageId', 'generation', 'targetVersions', 'basis', 'actionType', 'content', 'rationale',
    'expectedStudentAction', 'assistanceContext', 'evidenceIds', 'resourceRefs', 'unresolved', 'deliveryId'].sort());
  assert.equal(payload.content, content); assert(payload.deliveryId);
}
function assertMetadataOnly(page: TeachingEventsPage) {
  for (const event of page.events) {
    assert.equal(event.payload, undefined);
    assert.deepEqual(Object.keys(event).sort(), ['serverSeq', 'eventId', 'type', 'occurredAt'].sort());
  }
}

test('I0-B-D01-01 first body delivery exposes only the original Action association before any displayed receipt', async () => {
  const s = await setup();
  try {
    const ref = await s.codeRef(), { help, action } = await s.round(ref);
    const response = await s.page(), payload = payloadFor(data(response), action.actionId);
    assertAssociation(payload, action); assert.deepEqual(payload.basis!.objectRef, ref);
    assert.equal(payload.jobId, help.jobId); assert.notEqual(payload.messageId, help.messageId, 'answer Message is not the question Message');
    assert.deepEqual(s.records().actions[0]!.receipts, [], 'association does not need a fabricated display report');
    assert.equal(s.records().actions[0]!.deliveries.length, 1);
    for (const value of ['PRIVATE_TITLE', 'PRIVATE_BODY', 'worker-lease', 'bodyJsonText', 'resultHash', 'policyChecks',
      'inputRefs', 'assistanceRefs', 'coverageRefs', 'leaseToken', 'elapsedMs', 'usage']) assert(!response.body.includes(value), value);
  } finally { await s.f.close(); }
});

test('I0-B-D01-02 equal bodies from different Jobs retain separate original code/run bindings and suppress the replaced epoch', async () => {
  const s = await setup();
  try {
    const code = await s.codeRef(), first = await s.round(code);
    const firstPage = data(await s.page()), firstPayload = payloadFor(firstPage, first.action.actionId);
    assertAssociation(firstPayload, first.action);
    const run = await command(s.f, s.student, `/api/attempts/${s.attemptId}/runs`, {
      expectedAttemptRevision: (await s.state()).attempt.attemptRevision, snapshotId: s.snapshotId,
      runtimeProfileVersion: s.f.profile.runtimeProfileVersion, entryFileId: s.created.source,
      input: { operation: 'stats', fileIds: [s.created.input] }, mode: 'run' });
    assert.equal(run.statusCode, 200, run.body);
    const ref: ObjectRef = { kind: 'run', attemptId: s.attemptId, snapshotId: s.snapshotId, runId: run.json().data.result.runId };
    const second = await s.round(ref), secondPage = data(await s.page());
    const secondPayload = payloadFor(secondPage, second.action.actionId);
    assertAssociation(secondPayload, second.action); assert.deepEqual(secondPayload.basis!.objectRef, ref);
    assert.equal(firstPayload.contentHash, secondPayload.contentHash); assert.equal(firstPayload.content, secondPayload.content);
    assert.notEqual(firstPayload.jobId, secondPayload.jobId); assert.notEqual(firstPayload.messageId, secondPayload.messageId);
    assert.notEqual(firstPayload.actionId, secondPayload.actionId);
    assert.equal(secondPage.events.some(event => event.payload?.actionId === first.action.actionId), false);
    const oldEpoch = data(await s.page({ decisionEpoch: first.action.basis.decisionEpoch }));
    assert.equal(oldEpoch.resyncRequired, true); assert.deepEqual(oldEpoch.events, []);
    assert.deepEqual(s.records().actions.find(a => a.actionId === first.action.actionId)!.basis.objectRef, code);
    assert(s.records().actions.every(action => action.receipts.length === 0));
    assert.equal((await s.state()).runs.length, 1, 'projection neither reruns nor constructs another Run');
  } finally { await s.f.close(); }
});

test('I0-B-D01-03 unrelated capture/reminder revisions advance without re-stamping or blocking the original help basis', async () => {
  const s = await setup();
  try {
    const { action } = await s.round();
    for (const control of [{ kind: 'capture', value: false }, { kind: 'reminders', value: true }]) {
      const changed = await command(s.f, s.student, `/api/attempts/${s.attemptId}/controls`, {
        expectedAttemptRevision: (await s.state()).attempt.attemptRevision, control });
      assert.equal(changed.statusCode, 200, changed.body);
    }
    const page = data(await s.page());
    assert(page.control.attemptRevision > action.basis.attemptRevision);
    assert(page.control.captureRevision > action.basis.captureRevision);
    assert.equal(page.control.decisionEpoch, action.basis.decisionEpoch);
    const payload = payloadFor(page, action.actionId); assertAssociation(payload, action);
    assert.equal(Object.hasOwn(payload.basis!, 'objectRef'), false, 'no absent ObjectRef is synthesized');
  } finally { await s.f.close(); }
});

test('I0-B-D01-04 unauthorized users, teacher reads, wrong epochs and restored generations never disclose the student payload', async () => {
  const s = await setup();
  try {
    const { action } = await s.round(await s.codeRef());
    for (const user of ['other', 'foreign']) {
      const denied = await s.page({}, await s.f.login(user)); assert.equal(denied.statusCode, 403, denied.body);
      assert(!denied.body.includes(action.jobId)); assert(!denied.body.includes(content));
    }
    assertMetadataOnly(data(await s.page({}, s.teacher)));
    const old = data(await s.page({ decisionEpoch: action.basis.decisionEpoch + 1 }));
    assert.equal(old.resyncRequired, true); assert.deepEqual(old.events, []);
    payloadFor(data(await s.page()), action.actionId);
    s.f.restoreGeneration();
    const stale = data(await s.page({ recoveryGeneration: action.generation }));
    assert.equal(stale.resyncRequired, true); assert.deepEqual(stale.events, []);
    assertMetadataOnly(data(await s.page()));
  } finally { await s.f.close(); }
});

test('I0-B-D01-05 stopped succeeded Job loses its old delivery payload without erasing the generated association', async () => {
  const s = await setup();
  try {
    const { action } = await s.round(await s.codeRef());
    assertAssociation(payloadFor(data(await s.page()), action.actionId), action);
    const stopped = await command(s.f, s.student, `/api/jobs/${action.jobId}/cancel`, { reason: 'student_stopped' });
    assert.equal(stopped.statusCode, 200, stopped.body);
    assert.equal(stopped.json().data.result.status, 'succeeded'); assert.equal(stopped.json().data.result.stopRequested, true);
    assertMetadataOnly(data(await s.page()));
    const persisted = s.records().actions.find(a => a.actionId === action.actionId)!;
    assert.equal(persisted.jobId, action.jobId); assert.deepEqual(persisted.basis, action.basis); assert.equal(persisted.disposition, 'cancelled');
  } finally { await s.f.close(); }
});

test('I0-B-D01-06 changed code cannot receive the old snapshot-target association', async () => {
  const s = await setup();
  try {
    const ref = await s.codeRef(), { action } = await s.round(ref);
    payloadFor(data(await s.page()), action.actionId);
    assert.equal(ref.kind, 'code'); if (ref.kind !== 'code') throw new Error('code reference required');
    const edited = await command(s.f, s.student, `/api/attempts/${s.attemptId}/sync`, {
      expectedWorkspaceRevision: (await s.state()).attempt.workspaceRevision, clientId: 'page-a', clientSeq: 25,
      operations: [{ kind: 'update', fileId: ref.fileId, baseVersion: ref.documentVersion, text: 'Changed code.' }] });
    assert.equal(edited.statusCode, 200, edited.body); assertMetadataOnly(data(await s.page()));
    assert.deepEqual(s.records().actions[0]!.basis.objectRef, ref);
  } finally { await s.f.close(); }
});

test('I0-B-D01-07 a same-path same-text replacement file never inherits the recycled instance association', async () => {
  const s = await setup();
  try {
    const ref = await s.codeRef(), { action } = await s.round(ref);
    payloadFor(data(await s.page()), action.actionId);
    assert.equal(ref.kind, 'code'); if (ref.kind !== 'code') throw new Error('code reference required');
    const state = await s.state(), original = state.files.find((file: {fileId: string}) => file.fileId === ref.fileId)!;
    const replaced = await command(s.f, s.student, `/api/attempts/${s.attemptId}/sync`, {
      expectedWorkspaceRevision: state.attempt.workspaceRevision, clientId: 'page-a', clientSeq: 26,
      operations: [{ kind: 'recycle', fileId: ref.fileId, baseVersion: ref.documentVersion },
        { kind: 'create', clientFileKey: 'replacement', path: ref.path, text: original.text }] });
    assert.equal(replaced.statusCode, 200, replaced.body);
    const next = (await s.state()).files.find((file: {fileId: string; lifecycle: string; path: string}) => file.lifecycle === 'active' && file.path === ref.path)!;
    assert.notEqual(next.fileId, ref.fileId); assert.equal(next.contentHash, ref.contentHash);
    assertMetadataOnly(data(await s.page())); assert.deepEqual(s.records().actions[0]!.basis.objectRef, ref);
  } finally { await s.f.close(); }
});

test('I0-B-D01-08 another client cannot replay the original Delivery; displayed history stays on its authorized route', async () => {
  const s = await setup();
  try {
    const { action } = await s.round(), delivered = payloadFor(data(await s.page()), action.actionId);
    const displayed = await command(s.f, s.student, `/api/actions/${action.actionId}/receipts`, {
      deliveryId: delivered.deliveryId, contentHash: delivered.contentHash, clientId: 'page-a',
      receiptKind: 'displayed', clientReceiptId: randomUUID() });
    assert.equal(displayed.statusCode, 200, displayed.body);
    assertMetadataOnly(data(await s.page({ clientId: 'page-b' })));
    assert.equal(s.records().actions[0]!.deliveries.length, 1, 'already displayed content is not freshly delivered to unlock its association');
    const history = await s.f.app.inject({ url: `/api/attempts/${s.attemptId}/teaching-records`, headers: s.student });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.json().data.actions[0].jobId, action.jobId);
    assert.equal(history.json().data.messages.find((message: {messageId: string}) => message.messageId === action.messageId).envelope.body.content, content);
    const denied = await s.f.app.inject({ url: `/api/attempts/${s.attemptId}/teaching-records`, headers: await s.f.login('other') });
    assert.equal(denied.statusCode, 403, denied.body);
  } finally { await s.f.close(); }
});

test('I0-B-D01-09 the same-transaction related-state guard suppresses new projection while preserving shown history', async () => {
  const s = await setup();
  let reader: Awaited<ReturnType<typeof createTeachingRecordsApp>> | undefined;
  try {
    const { action } = await s.round();
    let relatedStateRevision = 0;
    // A supplies this original same-transaction guard. The synthetic test changes its answer, not permissions,
    // worker identity, or the C3 database schema; it does not claim an actual A4 host integration.
    reader = await createTeachingRecordsApp({ db: s.f.db, origin, signingSecret: s.f.signingSecret,
      currentGeneration: s.f.generation, now: s.f.timestamp,
      isTeachingBasisCurrent: (_tx, _scope, basis) => basis.relatedStateRevision === relatedStateRevision });
    const page = (headers: Headers) => reader!.app.inject({ url: `/api/attempts/${s.attemptId}/events?${new URLSearchParams({
      limit: '100', afterServerSeq: '0', clientId: 'page-a', recoveryGeneration: s.f.generation(), decisionEpoch: String(action.basis.decisionEpoch) })}`, headers });
    const payload = payloadFor(data(await page(s.student)), action.actionId); assertAssociation(payload, action);
    const displayed = await command(s.f, s.student, `/api/actions/${action.actionId}/receipts`, { deliveryId: payload.deliveryId,
      contentHash: payload.contentHash, clientId: 'page-a', receiptKind: 'displayed', clientReceiptId: randomUUID() });
    assert.equal(displayed.statusCode, 200, displayed.body);
    relatedStateRevision = 1;
    assertMetadataOnly(data(await page(s.student)));
    const history = await s.f.app.inject({ url: `/api/attempts/${s.attemptId}/teaching-records`, headers: s.student });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.json().data.actions[0].basisRevised, true);
    assert.equal(history.json().data.actions[0].receipts[0].receiptKind, 'displayed');
    assert.equal(history.json().data.messages.find((message: {messageId: string}) => message.messageId === action.messageId).envelope.body.content, content);
  } finally { await reader?.app.close(); await s.f.close(); }
});
