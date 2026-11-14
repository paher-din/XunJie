import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentRuntime, agentRuntimeMigrations } from '../dist/index.js';

test('independent sessions durably accept concurrent and repeated inputs without creating workspace facts', async () => {
  const postgres = await nativeFixture();
  let storage;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: postgres.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
    const backend = createFileBackend({ id: 'agent', root: join(postgres.root, 'agent-resources') });
    storage = await openStorage({ binding, migrations: agentRuntimeMigrations, backend });
    const identity = { kind: 'personal', name: '学生', environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID() };
    const session = { sessionId: randomUUID(), identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() };
    const runtime = createAgentRuntime(storage, { authorize: async () => {} });
    assert.deepEqual(await runtime.initialize(session), session);
    const input = { requestId: randomUUID(), sessionId: session.sessionId, text: '普通问题', mode: 'steering', context: {} };
    const receipts = await Promise.all(Array.from({ length: 5 }, () => runtime.accept(identity, input)));
    assert.ok(receipts.every(receipt => receipt.runId === receipts[0].runId));
    assert.equal((await runtime.events(identity, session.sessionId)).filter(event => event.kind === 'input-received').length, 1);
    const other = { ...input, requestId: randomUUID(), text: '补充一个例子' };
    const followup = await runtime.accept(identity, other);
    assert.equal(followup.runId, receipts[0].runId);
    const run = await runtime.run(identity, session.sessionId, receipts[0].runId);
    assert.equal(run.sessionId, session.sessionId);
    assert.equal(run.state, 'received');
    await assert.rejects(runtime.accept(identity, { ...input, text: '换掉原内容' }), { code: 'identity-conflict' });
    await assert.rejects(runtime.events({ ...identity, principalId: randomUUID() }, session.sessionId), { code: 'forbidden' });
    await runtime.close();
    await storage.close();
    storage = await openStorage({ binding, migrations: agentRuntimeMigrations, backend });
    const restarted = createAgentRuntime(storage, { authorize: async () => {} });
    assert.equal((await restarted.run(identity, session.sessionId, run.runId)).needsContinue, true);
    assert.equal((await restarted.events(identity, session.sessionId)).filter(event => event.kind === 'input-received').length, 2);
    assert.deepEqual(await restarted.accept(identity, input), receipts[0]);
    await restarted.close();
  } finally {
    await storage?.close();
    await postgres.close();
  }
});
