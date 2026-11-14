import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFileBackend, provisionStorage, openStorage } from '@xunjie/storage';
import { createChunkChannel, createChunkClient } from '@xunjie/storage/chunk-channel';
import { createAgentRuntime } from '@xunjie/agent-runtime';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { agentServiceMigrations, validateAgentServiceStorage, collectAgentServiceSources, validateAgentServiceSources } from '../dist/transport/session-storage.js';

test('the Agent service restores its original input and transport resources together', async t => {
  const pg = await nativeFixture(); let storage, runtime;
  t.after(async () => { await runtime?.close(); await storage?.close(); await pg.close(); });
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: agentServiceMigrations });
  storage = await openStorage({ binding, migrations: agentServiceMigrations, backend: createFileBackend({ id: 'files', root: pg.root + '/files' }) });
  const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  runtime = createAgentRuntime(storage, { authorize: async () => {} });
  const sessionId = randomUUID();
  await runtime.initialize({ sessionId, identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
  const source = { grantId: randomUUID(), sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID() };
  const channel = createChunkChannel(storage).wrap(value => runtime.accept(identity, value.args.input));
  const send = createChunkClient(value => channel(value, source));
  const input = { requestId: randomUUID(), sessionId, text: 'x'.repeat(300000) };
  const call = { version: 2, operation: 'accept', identity, sessionId, args: { input } }, transferId = randomUUID();
  // The first reply is deliberately not acknowledged so the backup must retain its originals.
  const received = await send(call, { transferId, durable: true, acknowledge: false });
  assert.deepEqual(await send(call, { transferId, durable: true, acknowledge: false }), received);
  await runtime.closeWrites(); await runtime.drain();
  await validateAgentServiceStorage(storage);
  const sources = await collectAgentServiceSources(storage);
  assert.ok(sources.entries.some(entry => entry.kind === 'agent_chunk_parts' && entry.resources.length));
  await validateAgentServiceSources(storage, sources);
  await assert.rejects(validateAgentServiceSources(storage, { ...sources,
    entries: sources.entries.filter(entry => entry.kind !== 'agent_chunk_parts') }), { code: 'corrupt' });
  assert.equal((await runtime.request(identity, sessionId, input.requestId)).receipt.runId, received.runId);
});
