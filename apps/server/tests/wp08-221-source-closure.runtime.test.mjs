import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { ownerSourceClosureSchema, sourceClosureCounts } from '@xunjie/storage/source-closure';
import { createAgentRuntime } from '@xunjie/agent-runtime';
import { agentServiceMigrations, collectAgentServiceSources, validateAgentServiceSources } from '@xunjie/agents/transport/session-storage';
import { createSpaces, createLearningData, spaceCourseMigrations, learningMigrations } from '@xunjie/learning-space';
import { collectLearningSources, validateLearningSources } from '@xunjie/learning-space/learning-data/source-closure';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

async function fixture(t) {
  const pg = await nativeFixture(), storages = [];
  let runtime;
  t.after(async () => { await runtime?.close(); for (const storage of storages.reverse()) await storage.close(); await pg.close(); });
  async function open(name, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations });
    const backend = createFileBackend({ id: name, root: join(pg.root, name) });
    const storage = await openStorage({ binding, migrations, backend }); storages.push(storage); return { storage, backend };
  }
  const space = await open('space', spaceCourseMigrations), spaces = createSpaces(space.storage), identity = await spaces.personal();
  const data = await open('data', learningMigrations);
  await spaces.bindMember(identity, { ...data.storage.owner, version: 1 });
  const learning = createLearningData(data.storage, spaces);
  const activity = await learning.create(identity, { requestId: randomUUID(), goal: '保留原始来源', question: '', references: [] });
  const text = '固定来源：37 volts', material = await learning.materials.receive(identity, activity.activityId, { requestId: randomUUID(), materialId: randomUUID(),
    name: 'fixed.md', mediaType: 'text/markdown', dataBase64: Buffer.from(text).toString('base64') });
  const agent = await open('agent', agentServiceMigrations);
  const local = await agent.storage.stageResource({ uploadId: randomUUID(), scope: 'agent-source-test', bytes: Buffer.from('原始 Agent 记录'), mediaType: 'text/plain', contentVersion: 1 });
  await agent.storage.request({ requestId: randomUUID(), fingerprint: 'agent-source-reference' }, tx => tx.reference('agent-source-test', local.resourceId));
  runtime = createAgentRuntime(agent.storage, { authorize: spaces.authorize, pipeline: {
    async plan(snapshot, ids) { return { kind: 'operation', operation: { operationId: ids.operationId, kind: 'source.test', bindingId: 'source-test:1', input: {} },
      snapshot: { inputIds: [snapshot.run.inputId] } }; },
    async dispatch(_snapshot, _step, _permit, assertDispatch) { await assertDispatch(); return { state: 'completed', value: { resourceId: local.resourceId } }; },
    async reconcile() { return null; },
    async apply(_snapshot, _step, result) { return { state: {}, complete: true, events: [{ kind: 'source-observed', body: result.value }] }; },
  } });
  async function run(reference) {
    const sessionId = randomUUID();
    await runtime.initialize({ sessionId, identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
    const input = await runtime.accept(identity, { requestId: randomUUID(), sessionId, text: '保留此原文', context: { reference } });
    await runtime.advance(input.runId);
    assert.equal((await runtime.run(identity, sessionId, input.runId)).state, 'completed');
  }
  async function closeGates() {
    runtime.closeWrites(); runtime.closeDispatch(); await runtime.drain();
    for (const storage of [agent.storage, data.storage]) { await storage.participant().closeWrites(); await storage.participant().closeDispatch(); await storage.participant().drain(); }
  }
  return { identity, data, agent, learning, activity, text, material, local, run, closeGates };
}

test('v2 Agent service closure retains kernel and transport facts with actual bytes and excludes foreign resource ownership', async t => {
  const f = await fixture(t), learning = await collectLearningSources(f.data.storage);
  const original = learning.entries.find(entry => entry.kind === 'personal_material_versions').resources[0];
  await f.run({ owner: f.data.storage.owner, resourceId: original.resourceId });
  await f.closeGates();
  const closure = await collectAgentServiceSources(f.agent.storage);
  assert.ok(ownerSourceClosureSchema.safeParse(closure).success);
  assert.deepEqual(closure, JSON.parse(JSON.stringify(closure)));
  assert.deepEqual(await collectAgentServiceSources(f.agent.storage), closure);
  const counts = sourceClosureCounts(closure);
  assert.equal(counts.agent_runtime_sessions, 1); assert.equal(counts.agent_runs, 1); assert.equal(counts.agent_inputs, 1); assert.equal(counts.agent_steps, 1);
  assert.ok(closure.entries.every(entry => entry.owner === 'xunjie.agent-service' && entry.activityId === undefined));
  const resources = closure.entries.flatMap(entry => entry.resources);
  assert.ok(resources.some(resource => resource.resourceId === f.local.resourceId && resource.sha256 === f.local.sha256));
  assert.ok(!resources.some(resource => resource.resourceId === original.resourceId));
  await validateAgentServiceSources(f.agent.storage, closure);
  const tampered = structuredClone(closure); tampered.entries[0].digest = '0'.repeat(64);
  await assert.rejects(validateAgentServiceSources(f.agent.storage, tampered), { code: 'corrupt' });
  await f.agent.backend.remove(f.local.locator.key); // Simulate loss of this temporary owner's retained original.
  await assert.rejects(collectAgentServiceSources(f.agent.storage), { code: 'corrupt' });
});

test('the learning owner closure retains its real material version and rejects altered manifests or lost originals', async t => {
  const f = await fixture(t); await f.closeGates();
  const closure = await collectLearningSources(f.data.storage);
  assert.ok(ownerSourceClosureSchema.safeParse(closure).success);
  assert.deepEqual(await collectLearningSources(f.data.storage), closure);
  assert.equal(sourceClosureCounts(closure).activities, 1);
  const version = closure.entries.find(entry => entry.kind === 'personal_material_versions');
  assert.ok(version.fixedId.includes(f.material.materialId));
  assert.equal(version.resources[0].sha256, createHash('sha256').update(f.text).digest('hex'));
  assert.equal(version.resources[0].byteLength, Buffer.byteLength(f.text));
  await validateLearningSources(f.data.storage, closure);
  const tampered = structuredClone(closure); tampered.entries.find(entry => entry.kind === 'personal_material_versions').resources[0].sha256 = '0'.repeat(64);
  await assert.rejects(validateLearningSources(f.data.storage, tampered), { code: 'corrupt' });
  const original = await f.data.storage.resource(version.resources[0].resourceId);
  await f.data.backend.remove(original.locator.key);
  await assert.rejects(collectLearningSources(f.data.storage), { code: 'corrupt' });
});
