import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentRuntime, agentRuntimeMigrations } from '../dist/index.js';

test('a saved operation dispatches once and a stop fences an operation still being prepared', async () => {
  const pg = await nativeFixture();
  let storage, runtime;
  const physical = [];
  const upstream = createServer((request, response) => {
    physical.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ text: '原调用的结果' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const planning = new Promise(resolve => { entered = resolve; });
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
    storage = await openStorage({ binding, migrations: agentRuntimeMigrations,
      backend: createFileBackend({ id: 'agent', root: join(pg.root, 'agent-resources') }) });
    const identity = { kind: 'personal', name: '学生', environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID() };
    // This boundary adapter uses a real external HTTP effect; the kernel retains its identity.
    const pipeline = {
      async plan(snapshot, ids) {
        if (snapshot.state.finished) return { kind: 'complete' };
        const input = snapshot.inputs.at(-1).input;
        if (input.text === '等待准备') { entered(); await gate; }
        return { kind: 'operation', operation: { operationId: ids.operationId,
          kind: 'external-request', bindingId: 'fixture-http-v1', input: { text: input.text } }, snapshot: {} };
      },
      async dispatch(_snapshot, step, _permit, assertDispatch) {
        await assertDispatch();
        const result = await fetch(`http://127.0.0.1:${upstream.address().port}/${step.operation.operationId}`);
        return { state: 'completed', value: await result.json() };
      },
      async reconcile() { return null; },
      async apply(_snapshot, _step, result) {
        return { state: { finished: true }, events: [{ kind: 'assistant', body: { text: result.value.text } }] };
      },
    };
    runtime = createAgentRuntime(storage, { authorize: async () => {}, pipeline });
    const makeSession = async () => {
      const sessionId = randomUUID();
      await runtime.initialize({ sessionId, identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
      return sessionId;
    };
    const sessionId = await makeSession();
    const first = await runtime.accept(identity, { requestId: randomUUID(), sessionId, text: '完成原调用' });
    await Promise.all([runtime.advance(first.runId), runtime.advance(first.runId)]);
    await runtime.advance(first.runId);
    assert.equal(physical.length, 1);
    assert.equal((await runtime.run(identity, sessionId, first.runId)).state, 'completed');
    assert.equal((await runtime.events(identity, sessionId)).filter(event => event.kind === 'assistant').length, 1);

    const secondSession = await makeSession();
    const second = await runtime.accept(identity, { requestId: randomUUID(), sessionId: secondSession, text: '等待准备' });
    const advancing = runtime.advance(second.runId);
    await planning;
    await runtime.stop(identity, secondSession, second.runId, randomUUID());
    release();
    await advancing;
    assert.equal(physical.length, 1, 'stopping before admission prevents the first physical request');
    assert.equal((await runtime.run(identity, secondSession, second.runId)).state, 'stopped');
  } finally {
    release();
    await runtime?.close();
    await storage?.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await pg.close();
  }
});
