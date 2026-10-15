import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'ui30-hdl-20261015');
const ledger = JSON.parse(readFileSync(join(source, 'browser-completion-after.json'), 'utf8'));
const finalRuntime = JSON.parse(readFileSync(join(source, 'final-runtime-status.json'), 'utf8'));
const completionRuntime = JSON.parse(readFileSync(join(source, 'completion-current-runtime.json'), 'utf8'));
const jsonl = name => readFileSync(join(source, name), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const sha256 = value => createHash('sha256').update(value).digest('hex');

const generation = 'synthetic-generation-c6772623-ba28-4c50-a853-337f77382452';
assert.equal(ledger.scope, 'Fresh local synthetic engineering validation; no real learner data');
assert.equal(ledger.recoveryGeneration, generation);

const find = (rows, key, value) => {
  const row = rows.find(item => item[key] === value);
  assert.ok(row, `Missing ${key}=${value}`);
  return row;
};
const receiptsFor = actionId => ledger.teachingReceipts.filter(row => row.action_id === actionId);
const messagesFor = jobId => ledger.messages.filter(row => row.job_id === jobId);
const actionsFor = jobId => ledger.actions.filter(row => row.job_id === jobId);

const displayed = {
  jobId: '70d697fc-0389-4cb5-a19b-9d68515db10d',
  modelMessageId: '92e9f7a9-dc89-4ee9-9f76-77242b10f013',
  actionId: '5b918f49-a908-4b4a-864f-7b6d50f021c3',
  deliveryId: 'c4396c80-94c4-4828-9783-f3766b67fcb2',
  contentHash: 'e0aded304a3a979c45ed00fc1dd0b5e6b0d2d5523e58a94d2d644958174bc0fd',
};
const displayedJob = find(ledger.jobs, 'job_id', displayed.jobId);
assert.equal(displayedJob.status, 'succeeded');
assert.equal(displayedJob.recovery_generation, generation);
const displayedMessage = find(ledger.messages, 'message_id', displayed.modelMessageId);
assert.equal(displayedMessage.job_id, displayed.jobId);
assert.equal(displayedMessage.author_kind, 'model');
assert.equal(displayedMessage.content_hash, displayed.contentHash);
const displayedAction = find(ledger.actions, 'action_id', displayed.actionId);
assert.equal(displayedAction.job_id, displayed.jobId);
assert.equal(displayedAction.message_id, displayed.modelMessageId);
assert.equal(displayedAction.content_hash, displayed.contentHash);
assert.equal(displayedAction.disposition, 'stale');
assert.equal(displayedAction.action_json.stopReason, 'learner_state_revised');
assert.equal(displayedAction.action_json.basisRevised, true);
assert.deepEqual(displayedAction.action_json.targetVersions, {
  activityVersionId: '813eeec7-d356-4e50-87ba-acd1b6fb3ebe',
  policyVersionId: 'synthetic-robert-course-hdl-help',
  modelConfigVersion: 'deepseek-flash-v1',
  promptVersion: 'student-help-v1',
  schemaVersion: 'student-help-v1',
});
assert.equal(displayedAction.action_json.basis.objectRef.snapshotId, '992df0be-69e1-47ea-a28b-436b55bbc22b');
assert.equal(displayedAction.action_json.basis.objectRef.fileId, '1ff729fe-3365-4cb0-8e07-2bc4a558783c');
assert.equal(displayedAction.action_json.basis.objectRef.documentVersion, 2);
assert.equal(displayedAction.action_json.basis.hdl.buildId, '2a28b361-05fa-4b35-bb92-4a57a7db208c');
assert.equal(displayedAction.action_json.basis.hdl.buildStatus, 'failed');
const displayedDelivery = find(ledger.deliveries, 'delivery_id', displayed.deliveryId);
assert.equal(displayedDelivery.action_id, displayed.actionId);
assert.equal(displayedDelivery.content_hash, displayed.contentHash);
assert.equal(displayedDelivery.recovery_generation, generation);
assert.deepEqual(receiptsFor(displayed.actionId).map(row => [row.receipt_kind, row.server_seq]), [
  ['received', 46], ['displayed', 48], ['acknowledged', 50],
]);
assert.ok(receiptsFor(displayed.actionId).every(row =>
  row.delivery_id === displayed.deliveryId && row.content_hash === displayed.contentHash));

const stale = {
  jobId: '765530ca-367c-4ca1-b496-d5365584cdff',
  modelMessageId: 'f118e4d9-4920-475d-829c-50ffe804b1dc',
  actionId: '1e32c2ec-60f2-4fa3-93fb-547e607e12ac',
  contentHash: 'eff856ab1bd45c3d905c2427ac401f8bd5376957d9cd38d1da9b8f4fce6d0117',
};
const staleJob = find(ledger.jobs, 'job_id', stale.jobId);
assert.equal(staleJob.status, 'succeeded');
assert.equal(staleJob.recovery_generation, generation);
const staleMessage = find(ledger.messages, 'message_id', stale.modelMessageId);
assert.equal(staleMessage.job_id, stale.jobId);
assert.equal(staleMessage.author_kind, 'model');
assert.equal(staleMessage.content_hash, stale.contentHash);
const staleAction = find(ledger.actions, 'action_id', stale.actionId);
assert.equal(staleAction.job_id, stale.jobId);
assert.equal(staleAction.message_id, stale.modelMessageId);
assert.equal(staleAction.content_hash, stale.contentHash);
assert.equal(staleAction.disposition, 'stale');
assert.equal(staleAction.action_json.stopReason, 'learner_state_revised');
assert.equal(staleAction.action_json.basisRevised, true);
assert.equal(staleAction.action_json.basis.hdl.snapshotId, '6d0ed106-5b29-4603-98d5-1fef95ac3914');
assert.equal(staleAction.action_json.basis.hdl.buildId, 'd8174bc9-ac86-4a9f-928f-e5692aa567e3');
assert.equal(staleAction.action_json.basis.hdl.sessionId, 'c69decae-f4c2-4cc3-9fa3-0138d30ca22c');
assert.equal(staleAction.action_json.basis.hdl.sessionRevision, 3);
assert.equal(staleAction.action_json.basis.hdl.confirmedSequence, 2);
assert.equal(staleAction.action_json.basis.hdl.simTimePs, '20000');
assert.equal(staleAction.action_json.basis.hdl.operationId, '16235ed5-73b7-42e0-b8eb-d4535abaebe0');
assert.equal(staleAction.action_json.basis.hdl.resultHash, '229a353b8933e6ef0abc2d964d69d53da27f90addb298a5f753bdc281e49e583');
const staleOperation = find(ledger.operations, 'operation_id', staleAction.action_json.basis.hdl.operationId);
assert.equal(staleOperation.session_id, staleAction.action_json.basis.hdl.sessionId);
assert.equal(staleOperation.sequence, staleAction.action_json.basis.hdl.confirmedSequence);
assert.equal(staleOperation.result_json.resultHash, staleAction.action_json.basis.hdl.resultHash);
assert.equal(staleOperation.result_hash, sha256(staleOperation.result_json_text));
assert.notEqual(staleOperation.result_hash, staleOperation.result_json.resultHash,
  'The row JSON checksum must not replace the HDL protocol resultHash');
const staleReceipts = receiptsFor(stale.actionId);
assert.deepEqual(staleReceipts.map(row => [row.receipt_kind, row.server_seq]), [
  ['received', 234], ['received', 237], ['received', 240],
]);
assert.ok(staleReceipts.every(row => row.content_hash === stale.contentHash));
assert.ok(!staleReceipts.some(row => ['displayed', 'acknowledged'].includes(row.receipt_kind)));

const unavailableJobId = '8d88a61e-30a9-4d6d-8ea9-3b27dfeebd93';
assert.equal(find(ledger.jobs, 'job_id', unavailableJobId).status, 'failed');
assert.equal(messagesFor(unavailableJobId).filter(row => row.author_kind === 'model').length, 0);
assert.equal(actionsFor(unavailableJobId).length, 0);
assert.ok(ledger.snapshots.some(row => row.snapshot_id === 'f3e8643d-cda4-47df-9477-af99f49a0fe0'));

const originalTransport = jsonl('model-transport-public.jsonl');
assert.equal(originalTransport.filter(row => row.kind === 'http-start').length, 2);
assert.deepEqual(originalTransport.filter(row => row.kind === 'http-response').map(row => row.status), [200, 200]);
assert.deepEqual(originalTransport.filter(row => row.kind === 'model-result').map(row => row.usage), [
  { status: 'actual', inputTokens: 2933, outputTokens: 507 },
  { status: 'actual', inputTokens: 2704, outputTokens: 466 },
]);
const completionTransport = jsonl('model-transport-completion.jsonl');
assert.equal(completionTransport.filter(row => row.kind === 'http-start').length, 4);
assert.equal(completionTransport.filter(row => row.kind === 'http-response' && row.status === 200).length, 4);
assert.equal(finalRuntime.process.modelEnabled, false);
assert.equal(completionRuntime.process.modelEnabled, false);
assert.equal(finalRuntime.node.recoveryGeneration, generation);
assert.equal(completionRuntime.node.recoveryGeneration, generation);

for (const name of ['browser-hdl-agent-body.png', 'browser-hdl-agent-receipts.png',
  'browser-board-help-selection.png', 'browser-board-help-stale.png', 'browser-budget-off-save-v4.png']) {
  assert.ok(existsSync(join(source, name)), `Missing ${name}`);
}

const result = {
  status: 'verified',
  source: 'PR81 archived public synthetic evidence',
  displayedChain: {
    jobId: displayed.jobId,
    messageId: displayed.modelMessageId,
    actionId: displayed.actionId,
    historicalReceipts: { received: 46, displayed: 48, acknowledged: 50 },
    laterDisposition: 'stale',
    laterReason: 'learner_state_revised',
  },
  staleChain: {
    jobId: stale.jobId,
    messageId: stale.modelMessageId,
    actionId: stale.actionId,
    receipts: { received: [234, 237, 240], displayed: [], acknowledged: [] },
    finalDisposition: 'stale',
    finalReason: 'learner_state_revised',
  },
  unavailableChain: { jobId: unavailableJobId, status: 'failed', modelMessages: 0, actions: 0, laterSaveSnapshotPresent: true },
  transport: {
    originalUiBatchHttp200: 2,
    completionWindowHttp200: 4,
    completionWindowAttribution: 'Includes independent C-side activity; no job foreign key, so it is not wholly attributed to UI30.',
  },
  boundary: 'Engineering provenance/currentness/receipt verification only. Public evidence omits complete message bodies and cannot complete formal teacher semantic review.',
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
