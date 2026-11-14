import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentRuntime, agentRuntimeMigrations } from '../../agent-runtime/dist/index.js';
import { createAgentSessionService, createAgentSessionClient } from '../dist/transport/session-service.js';
const jsonRoundtrip = value => JSON.parse(JSON.stringify(value));

test('session v2 client and service retain real core identity, receipts, run control and snapshots across JSON', async t => {
  const postgres = await nativeFixture();
  let storage, runtime;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: postgres.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
    storage = await openStorage({ binding, migrations: agentRuntimeMigrations,
      backend: createFileBackend({ id: 'agent', root: join(postgres.root, 'agent') }) });
    runtime = createAgentRuntime(storage, { authorize: async () => {} });
    const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
    const sessionId = randomUUID();
    const authorize = async who => {
      if (who.environmentId !== identity.environmentId || who.spaceId !== identity.spaceId
        || who.principalId !== identity.principalId || who.kind !== identity.kind) throw new StorageError('forbidden');
    };
    const service = createAgentSessionService(runtime, { audience: 'service', authorize, authorizeInitialize: async () => {} });
    const client = createAgentSessionClient(async call => jsonRoundtrip(await service(jsonRoundtrip(call))));
    const session = { sessionId, identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() };
    assert.deepEqual(await client.initialize(session), session);
    const input = { sessionId, requestId: randomUUID(), text: '解释递归', mode: 'steering', context: {} };
    const receipt = await client.accept(identity, input);
    assert.deepEqual(await client.accept(identity, input), receipt);
    assert.deepEqual(await client.request(identity, sessionId, input.requestId), { receipt, input });
    assert.equal(await client.request(identity, sessionId, randomUUID()), null);
    assert.equal((await client.run(identity, sessionId, receipt.runId)).sessionId, sessionId);
    await assert.rejects(client.run({ ...identity, principalId: randomUUID() }, sessionId, receipt.runId), { code: 'forbidden' });
    await assert.rejects(client.run(identity, randomUUID(), receipt.runId), { code: 'missing' });
    const before = await client.events(identity, sessionId);
    const call = { version: 2, operation: 'accept', identity, sessionId, args: { input } };
    for (const invalid of [{ ...call, version: 1 }, { ...call, operation: 'legacy.accept' }])
      await assert.rejects(service(jsonRoundtrip(invalid)), { code: 'incompatible' });
    for (const invalid of [{ ...call, trusted: true }, { ...call, args: { input: { ...input, sessionId: randomUUID() } } }])
      await assert.rejects(service(jsonRoundtrip(invalid)), { code: 'invalid' });
    const browser = createAgentSessionService(runtime, { audience: 'browser', authorize,
      authorizeInitialize: async () => {}, authorizeResolveWait: async () => {} });
    await assert.rejects(browser({ version: 2, operation: 'initialize', identity, sessionId, args: { session } }), { code: 'forbidden' });
    await assert.rejects(createAgentSessionClient(browser).resolveWait(identity, sessionId,
      { requestId: randomUUID(), waitId: randomUUID(), expectedVersion: 1, result: { success: true } }), { code: 'forbidden' });
    assert.deepEqual(await client.events(identity, sessionId), before);
    const unready = createAgentSessionClient(createAgentSessionService({ ...runtime, request: undefined }, { audience: 'service', authorize }));
    await assert.rejects(unready.request(identity, sessionId, input.requestId), { code: 'incompatible' });
    const oldCore = createAgentSessionClient(createAgentSessionService({ ...runtime, respond: undefined }, { audience: 'service', authorize }));
    await assert.rejects(oldCore.respond(identity, sessionId, { requestId: randomUUID(), waitId: randomUUID(), expectedVersion: 1, answer: {} }), { code: 'incompatible' });
    await assert.rejects(client.conversation(identity, sessionId), { code: 'incompatible' });
    const snapshot = await client.snapshot(identity, sessionId, receipt.runId);
    assert.deepEqual(snapshot.session, session);
    assert.equal(snapshot.inputs[0].inputId, receipt.inputId);
    assert.equal(snapshot.inputs[0].input.text, input.text);
    assert.deepEqual(snapshot.sessionState, {});
    assert.equal((await client.events(identity, sessionId))[0].kind, 'input-received');
    assert.equal((await client.continueRun(identity, sessionId, receipt.runId, randomUUID())).state, 'received');
    assert.equal((await client.stop(identity, sessionId, receipt.runId, randomUUID())).state, 'stopped');
    assert.equal((await client.events(identity, sessionId, 1)).at(-1).kind, 'run-stopped');
    await assert.rejects(client.continueRun(identity, sessionId, receipt.runId, randomUUID()), { code: 'conflict' });
  } finally {
    await runtime?.close(); await storage?.close(); await postgres.close();
  }
});

test('browser responses and trusted Node wait results cross JSON without sharing execution authority', async () => {
  const postgres = await nativeFixture();
  let storage, runtime;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: postgres.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
    storage = await openStorage({ binding, migrations: agentRuntimeMigrations,
      backend: createFileBackend({ id: 'agent', root: join(postgres.root, 'agent') }) });
    const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
    const pipeline = {
      async plan(snapshot, ids) {
        if (snapshot.waits.some(wait => wait.state === 'consumed')) return { kind: 'complete' };
        return { kind: 'operation', operation: { operationId: ids.operationId, kind: 'await-input', bindingId: 'fixture-v1', input: {} }, snapshot: {} };
      },
      async dispatch() { return { state: 'completed', value: {} }; },
      async reconcile() { return null; },
      async apply(snapshot) {
        return { state: {}, wait: { kind: snapshot.session.scenario, presentation: { question: '继续吗？' }, deadline: null } };
      },
      async validateResponse(_snapshot, wait, answer) {
        if (wait.kind !== 'user' || typeof answer.text !== 'string') throw new StorageError('forbidden');
      },
    };
    runtime = createAgentRuntime(storage, { authorize: async () => {}, pipeline });
    const authorize = async () => {};
    const nodeService = createAgentSessionService(runtime, { audience: 'service', authorize,
      authorizeInitialize: async () => {}, authorizeResolveWait: async () => {} });
    const browserService = createAgentSessionService(runtime, { audience: 'browser', authorize });
    const connect = service => createAgentSessionClient(async call => jsonRoundtrip(await service(jsonRoundtrip(call))));
    const node = connect(nodeService), browser = connect(browserService);
    const sessions = [];
    for (const scenario of ['user', 'worker']) {
      const sessionId = randomUUID();
      await node.initialize({ sessionId, identity, scenario, restartPolicy: 'explicit', createdAt: new Date().toISOString() });
      const accepted = await browser.accept(identity, { sessionId, requestId: randomUUID(), text: '继续', mode: 'steering', context: {} });
      await runtime.advance(accepted.runId);
      const snapshot = await browser.snapshot(identity, sessionId, accepted.runId);
      assert.equal(snapshot.run.state, 'waiting');
      assert.equal(snapshot.steps.length, 1);
      const wait = snapshot.waits[0];
      const request = { requestId: randomUUID(), waitId: wait.waitId, expectedVersion: wait.version };
      if (scenario === 'user') {
        const response = { ...request, answer: { text: '是' } };
        const receipt = await browser.respond(identity, sessionId, response);
        assert.deepEqual(receipt, { runId: accepted.runId, waitId: wait.waitId });
        assert.deepEqual(await browser.respond(identity, sessionId, response), receipt);
      } else {
        await assert.rejects(browser.respond(identity, sessionId, { ...request, answer: { text: '我声称已执行' } }), { code: 'forbidden' });
        const resolution = { ...request, result: { completed: true, source: 'trusted-node' } };
        await assert.rejects(browser.resolveWait(identity, sessionId, resolution), { code: 'forbidden' });
        const untrusted = connect(createAgentSessionService(runtime, { audience: 'service', authorize }));
        await assert.rejects(untrusted.resolveWait(identity, sessionId, resolution), { code: 'forbidden' });
        assert.equal((await node.snapshot(identity, sessionId, accepted.runId)).waits[0].state, 'pending');
        const receipt = await node.resolveWait(identity, sessionId, resolution);
        assert.deepEqual(receipt, { runId: accepted.runId, waitId: wait.waitId });
        assert.deepEqual(await node.resolveWait(identity, sessionId, resolution), receipt);
      }
      await runtime.advance(accepted.runId);
      assert.equal((await node.run(identity, sessionId, accepted.runId)).state, 'completed');
      sessions.push({ sessionId, accepted });
    }
    const [user, worker] = sessions;
    const workerWait = (await node.snapshot(identity, worker.sessionId, worker.accepted.runId)).waits[0];
    await assert.rejects(browser.respond(identity, user.sessionId, { requestId: randomUUID(), waitId: workerWait.waitId,
      expectedVersion: workerWait.version, answer: { text: '跨会话' } }), { code: 'missing' });
  } finally {
    await runtime?.close(); await storage?.close(); await postgres.close();
  }
});
