import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFileBackend, openStorage, provisionStorage, prepareStorageRestore, finalizeStorageRestore, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentRuntime, agentRuntimeMigrations } from '../dist/index.js';
import { collectAgentRuntimeBoundary, collectAgentRuntimeReceiverBoundary, validateAgentRuntimeBoundary } from '../dist/maintenance.js';

let postgres;
const exec = promisify(execFile);
async function pgTool(fixture, name, args) {
  const connection = fixture.admin;
  try { return await exec(fixture.tool(name), ['-h', connection.host, '-p', String(connection.port), '-U', connection.user,
    '-d', connection.database, ...args], { env: { ...process.env, PGPASSWORD: connection.password }, timeout: 30000 }); }
  catch { throw new Error(name + ' failed'); }
}
before(async () => { postgres = await nativeFixture(); });
after(async () => { await postgres?.close(); });
const pipeline = (overrides = {}) => ({
  async plan(_snapshot, ids) { return { kind: 'operation', operation: { operationId: ids.operationId, kind: 'fixture-operation', bindingId: 'fixture-v1', input: {} }, snapshot: {} }; },
  async dispatch() { return { state: 'completed', value: { result: 'retained' } }; },
  async reconcile() { return null; },
  async apply(snapshot) { return { state: snapshot.state, complete: true }; },
  ...overrides,
});
async function fixture(t, plan = pipeline()) {
  const options = { owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID() };
  const binding = await provisionStorage({ admin: postgres.admin, ...options, migrations: agentRuntimeMigrations });
  const backend = createFileBackend({ id: 'agent', root: postgres.root + '/' + options.owner.serviceId });
  const storage = await openStorage({ binding, migrations: agentRuntimeMigrations, backend });
  const runtime = createAgentRuntime(storage, { authorize: async () => {}, pipeline: plan });
  t.after(async () => { try { await runtime.close(); } finally { await storage.close(); } });
  const identity = { environmentId: options.owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '维护学生' };
  const sessionId = randomUUID();
  await runtime.initialize({ sessionId, identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
  const input = { requestId: randomUUID(), sessionId, text: '原始问题', context: { fixed: 'original' } };
  const accepted = await runtime.accept(identity, input);
  async function quiesce() {
    runtime.closeWrites(); runtime.closeDispatch(); await runtime.drain();
    await storage.participant().closeWrites(); await storage.participant().closeDispatch(); await storage.participant().drain();
  }
  return { options, binding, backend, storage, runtime, identity, sessionId, input, accepted, quiesce };
}

test('a closed drained core produces a complete v2 inventory without activity aliases', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(collectAgentRuntimeBoundary(f.storage), { code: 'maintenance' });
  await f.runtime.advance(f.accepted.runId); await f.quiesce();
  const material = await collectAgentRuntimeBoundary(f.storage);
  assert.equal(material.kind, 'xunjie.agent-runtime.boundary/2');
  assert.deepEqual(material.unresolved, []); assert.equal(material.settled, 1);
  assert.equal(material.retained.checkpoints, 1); assert.deepEqual(material.blocking, []);
  assert.equal(material.evidence.tables.agent_steps.count, 1);
  assert.equal(material.evidence.tables.agent_inputs.count, 1);
  assert.equal(material.evidence.sources.owner, 'xunjie.agent-runtime');
  await validateAgentRuntimeBoundary(f.storage, material);
  const receiver = await collectAgentRuntimeReceiverBoundary(f.storage);
  assert.equal(receiver.kind, 'xunjie.agent-runtime.receiver-boundary/2');
  assert.deepEqual(receiver.unresolved, []);
  await assert.rejects(validateAgentRuntimeBoundary(f.storage, { ...material, kind: 'xunjie.teaching-agent.boundary' }), { code: 'incompatible' });
  await assert.rejects(validateAgentRuntimeBoundary(f.storage, { ...material, evidence: { ...material.evidence,
    tables: { ...material.evidence.tables, agent_steps: { count: 1, sha256: '0'.repeat(64) } } } }), { code: 'corrupt' });
});

test('receiver fencing excludes dormant waits but retains unknown dispatch and explicit continuations', { timeout: 60000 }, async t => {
  for (const kind of ['logical', 'accepted', 'continuation', 'unknown', 'stopping', 'continuation-stopping']) {
    const continuation = kind === 'continuation' || kind === 'continuation-stopping';
    const f = await fixture(t, pipeline({
      async dispatch() {
        if (kind === 'unknown') throw new Error('original response lost');
        return { state: kind === 'accepted' || kind === 'stopping' ? 'accepted' : 'completed', value: {} };
      },
      async apply(snapshot, step) { return { state: snapshot.state, ...(continuation ? { keepDispatch: true } : {}),
        wait: { kind: 'opaque-wait', presentation: { prompt: '等待原结果' }, deadline: null,
          ...(continuation ? { continuationOperationId: step.operation.operationId } : {}) } }; },
    }));
    await f.runtime.advance(f.accepted.runId);
    if (kind.endsWith('stopping')) await f.runtime.stop(f.identity, f.sessionId, f.accepted.runId, randomUUID());
    await f.quiesce();
    const boundary = await collectAgentRuntimeBoundary(f.storage), receiver = await collectAgentRuntimeReceiverBoundary(f.storage);
    assert.equal(boundary.unresolved.length, 1, kind);
    const original = boundary.unresolved[0];
    assert.equal(original.sessionId, f.sessionId); assert.equal(original.activityId, undefined);
    assert.equal(original.requestId, f.input.requestId); assert.equal(original.inputDigest, f.accepted.inputDigest);
    assert.equal(original.executionRef, f.accepted.runId);
    if (kind === 'logical') {
      assert.equal(original.statusKnowledge, 'confirmed'); assert.equal(original.disposition, 'paused');
      assert.deepEqual(receiver.unresolved, []); assert.equal(receiver.evidence.dormantRuns, 1);
      assert.equal(receiver.settled, 0, 'dormant is not falsely marked complete');
    } else {
      assert.equal(original.statusKnowledge, 'unknown'); assert.equal(receiver.unresolved.length, 1, kind);
      if (kind.endsWith('stopping')) assert.equal(original.disposition, 'stop-pending');
    }
    await validateAgentRuntimeBoundary(f.storage, boundary);
  }
  const queued = await fixture(t); await queued.quiesce();
  const accepted = await collectAgentRuntimeBoundary(queued.storage);
  assert.equal(accepted.unresolved[0].disposition, 'accepted-not-started');
  assert.deepEqual((await collectAgentRuntimeReceiverBoundary(queued.storage)).unresolved, []);
});

test('boundary validation rejects changed snapshots, source hashes and original input receipts', { timeout: 60000 }, async t => {
  const f = await fixture(t); await f.runtime.advance(f.accepted.runId);
  const snapshot = await f.runtime.snapshot(f.identity, f.sessionId, f.accepted.runId), step = snapshot.steps[0];
  await f.quiesce();
  const material = await collectAgentRuntimeBoundary(f.storage);
  const sourceHash = structuredClone(material); sourceHash.evidence.sources.entries[0].digest = '0'.repeat(64);
  await assert.rejects(validateAgentRuntimeBoundary(f.storage, sourceHash), { code: 'corrupt' });
  async function fault(effect) {
    await f.storage.participant().resume();
    await f.storage.request({ requestId: randomUUID(), fingerprint: 'maintenance corruption fixture' }, async tx => { await effect(tx); return null; });
    await f.storage.participant().closeWrites(); await f.storage.participant().closeDispatch();
  }
  await fault(tx => tx.query('UPDATE agent_steps SET snapshot=$2 WHERE step_id=$1', [step.stepId, { changed: 'valid JSON, wrong checkpoint' }]));
  await assert.rejects(validateAgentRuntimeBoundary(f.storage, material), { code: 'corrupt' });
  await fault(tx => tx.query('UPDATE agent_steps SET snapshot=$2 WHERE step_id=$1', [step.stepId, step.snapshot]));
  await validateAgentRuntimeBoundary(f.storage, material);
  const requestKey = 'agent-input:' + f.input.requestId;
  const originalReceipt = await f.storage.receipt(requestKey);
  await fault(tx => tx.query('UPDATE _storage_requests SET result=$2 WHERE request_id=$1', [requestKey, { ...f.accepted, inputDigest: '0'.repeat(64) }]));
  await assert.rejects(validateAgentRuntimeBoundary(f.storage, material), { code: 'corrupt' });
  await fault(tx => tx.query('UPDATE _storage_requests SET result=$2 WHERE request_id=$1', [requestKey, f.accepted]));
  await validateAgentRuntimeBoundary(f.storage, material);
  await fault(tx => tx.query('UPDATE _storage_requests SET committed_at=$2 WHERE request_id=$1', [requestKey, '2020-01-01T00:00:00.000Z']));
  await assert.rejects(validateAgentRuntimeBoundary(f.storage, material), { code: 'corrupt' });
  await fault(tx => tx.query('UPDATE _storage_requests SET committed_at=$2 WHERE request_id=$1', [requestKey, originalReceipt.committedAt]));
  await validateAgentRuntimeBoundary(f.storage, material);
  await fault(tx => tx.query('UPDATE _storage_requests SET fingerprint=$2 WHERE request_id=$1', [requestKey, '0'.repeat(64)]));
  await assert.rejects(validateAgentRuntimeBoundary(f.storage, material), { code: 'corrupt' });
  await fault(tx => tx.query('UPDATE _storage_requests SET fingerprint=$2 WHERE request_id=$1', [requestKey, f.accepted.inputDigest]));
  await validateAgentRuntimeBoundary(f.storage, material);
});

test('a legal v2 backup validates after independent PostgreSQL restore and requires its retained bytes', { timeout: 60000 }, async t => {
  let resource;
  const f = await fixture(t, pipeline({ async plan(_snapshot, ids) { return { kind: 'operation',
    operation: { operationId: ids.operationId, kind: 'fixture-operation', bindingId: 'fixture-v1', input: {} },
    snapshot: { source: 'fixed core evidence', resourceId: resource.resourceId } }; } }));
  const bytes = Buffer.from('core checkpoint original bytes');
  resource = await f.storage.stageResource({ uploadId: randomUUID(), scope: 'core-checkpoint', bytes, mediaType: 'text/plain', contentVersion: 1 });
  await f.storage.request({ requestId: randomUUID(), fingerprint: 'retain checkpoint bytes' }, async tx => {
    await tx.reference('core-checkpoint:' + resource.resourceId, resource.resourceId); return null;
  });
  await f.runtime.advance(f.accepted.runId); await f.quiesce();
  const material = await collectAgentRuntimeBoundary(f.storage);
  assert.equal(material.retained.resources, 1); assert.equal(material.retained.checkpoints, 1);
  await validateAgentRuntimeBoundary(f.storage, material);
  const target = await nativeFixture(); let restored, readOnly;
  t.after(async () => { try { await readOnly?.close(); await restored?.close(); } finally { await target.close(); } });
  const dump = postgres.root + '/' + randomUUID() + '.dump';
  const backend = createFileBackend({ id: 'agent', root: target.root + '/objects' }); let manifest;
  await f.storage.snapshot(randomUUID(), async snapshot => {
    manifest = snapshot.manifest;
    await pgTool(postgres, 'pg_dump', ['-Fc', '-n', f.binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
    for (const reference of manifest.resources) await backend.put(reference.locator.key, await f.storage.readResourceObject(reference.resourceId));
  });
  const binding = await prepareStorageRestore({ admin: target.admin, ...f.options });
  await pgTool(target, 'pg_restore', ['--exit-on-error', '--role', binding.migratorRole, '--no-owner', '--no-acl', dump]);
  restored = await finalizeStorageRestore({ admin: target.admin, binding, migrations: agentRuntimeMigrations, manifest, backend });
  await validateAgentRuntimeBoundary(restored, material);
  assert.deepEqual(await collectAgentRuntimeBoundary(restored), material);
  assert.deepEqual(Buffer.from(await restored.readResource(resource.resourceId)), bytes);
  readOnly = createAgentRuntime(restored, { authorize: async () => {}, readOnly: true });
  const snapshot = await readOnly.snapshot(f.identity, f.sessionId, f.accepted.runId);
  assert.equal(snapshot.run.state, 'completed'); assert.equal(snapshot.inputs[0].input.text, '原始问题');
  await backend.remove(resource.locator.key);
  await assert.rejects(validateAgentRuntimeBoundary(restored, material), { code: 'corrupt' });
});

test('independent restore preserves pending cancellation and delivers it only after the read-only host resumes', { timeout: 60000 }, async t => {
  const f = await fixture(t, pipeline({
    async apply(snapshot) { return { state: snapshot.state, wait: { kind: 'logical', presentation: {}, deadline: null } }; },
    async cancel() { throw new StorageError('unavailable'); },
  }));
  await f.runtime.advance(f.accepted.runId);
  const original = (await f.runtime.snapshot(f.identity, f.sessionId, f.accepted.runId)).steps[0];
  await assert.rejects(f.runtime.stop(f.identity, f.sessionId, f.accepted.runId, randomUUID()), { code: 'unavailable' });
  await f.quiesce();
  const material = await collectAgentRuntimeBoundary(f.storage);
  assert.equal(material.unresolved[0].disposition, 'stop-pending');
  const target = await nativeFixture(); let restored, runtime;
  t.after(async () => { try { await runtime?.close(); await restored?.close(); } finally { await target.close(); } });
  const dump = postgres.root + '/' + randomUUID() + '.dump'; let manifest;
  await f.storage.snapshot(randomUUID(), async snapshot => {
    manifest = snapshot.manifest;
    await pgTool(postgres, 'pg_dump', ['-Fc', '-n', f.binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
  });
  const binding = await prepareStorageRestore({ admin: target.admin, ...f.options });
  await pgTool(target, 'pg_restore', ['--exit-on-error', '--role', binding.migratorRole, '--no-owner', '--no-acl', dump]);
  restored = await finalizeStorageRestore({ admin: target.admin, binding, migrations: agentRuntimeMigrations, manifest,
    backend: createFileBackend({ id: 'agent', root: target.root + '/objects' }) });
  await validateAgentRuntimeBoundary(restored, material);
  const delivered = [];
  runtime = createAgentRuntime(restored, { authorize: async () => {}, readOnly: true, pipeline: pipeline({
    async plan() { assert.fail('cancellation recovery never plans a business operation'); },
    async dispatch() { assert.fail('cancellation recovery never dispatches a business operation'); },
    async cancel(snapshot, step) {
      assert.equal(snapshot.run.state, 'stopped'); assert.deepEqual(step, original);
      delivered.push(step.operation.operationId);
    },
  }) });
  await runtime.drain();
  assert.deepEqual(delivered, []); assert.deepEqual(await collectAgentRuntimeBoundary(restored), material);
  await restored.participant().resume(); await runtime.resume(); await runtime.drain();
  assert.deepEqual(delivered, [original.operation.operationId]);
  assert.equal((await runtime.run(f.identity, f.sessionId, f.accepted.runId)).state, 'stopped');
  runtime.closeWrites(); await runtime.drain();
  await restored.participant().closeWrites(); await restored.participant().closeDispatch(); await restored.participant().drain();
  const acknowledged = await collectAgentRuntimeBoundary(restored);
  assert.deepEqual(acknowledged.unresolved, []);
  await validateAgentRuntimeBoundary(restored, acknowledged);
});
