import './model-cleanup-source-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { provisionStorage, openStorage, createFileBackend } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
const { createModelGateway, modelMigrations } = await import('@xunjie/model-gateway');
const { createLearningModelClient, createLearningModelService } = await import('@xunjie/model-gateway/service');

for (const view of ['read', 'list', 'unconfirmed']) test('model ' + view + ': a stale dispatched row cannot hide a completed owner result or authorize a replay', { timeout: 60000 }, async () => {
  const pg = await nativeFixture(), started = Promise.withResolvers(), release = Promise.withResolvers();
  let storage, gateway, sends = 0, armed = false, intercepted = false;
  const upstream = createServer(async (_request, response) => {
    sends++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '原回答进度'.repeat(120) }, finish_reason: null }] }) + '\n\n');
    started.resolve(); await release.promise;
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: modelMigrations });
    storage = await openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'read-race', root: join(pg.root, 'model') }) });
    const identity = { kind: 'personal', environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), name: '学生' };
    // Delay only the public durable-read acknowledgement. The old row and final result are both real PostgreSQL reads.
    const boundary = new Proxy(storage, { get(target, property) {
      if (property === 'read') return async (sql, args) => {
        const snapshot = await target.read(sql, args);
        const selected = view === 'list' ? sql.startsWith('SELECT body FROM model_attempts WHERE scope=') : sql.startsWith('SELECT * FROM model_attempts WHERE id=');
        if (armed && !intercepted && selected) {
          intercepted = true; armed = false;
          assert.equal(snapshot.rows[0].body.state, 'dispatched');
          release.resolve(); await gateway.checks.drain();
          assert.equal((await target.read(sql, args)).rows[0].body.state, 'completed');
        }
        return snapshot;
      };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    gateway = await createModelGateway(boundary, { holder: 'device', authorize: async () => {} });
    const connectionId = randomUUID();
    await gateway.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '完成边界竞态', protocol: 'chat-completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'race', dialect: 'standard', parameterMode: 'plain',
      enabled: true, contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-read-race-key' } });
    const client = createLearningModelClient(async request => JSON.parse(JSON.stringify(await createLearningModelService(gateway, async () => {})(JSON.parse(JSON.stringify(request))))));
    const segmentId = randomUUID(), attemptId = randomUUID();
    await client.segments.create(identity, { requestId: randomUUID(), segmentId, source: { connectionId, version: 1 }, purpose: 'learning', prefix: { system: '回答当前输入', tools: [] }, portable: [] });
    await client.checks.receive(identity, { attemptId, purpose: 'learning', segmentId, expectedSequence: 0,
      input: { text: '继续原输入', images: [], toolResults: [] }, limits: { maxOutputTokens: 1024, timeoutMs: 10000 } });
    await client.checks.dispatch(identity, attemptId); await started.promise;
    if (view === 'unconfirmed') {
      const reader = await createModelGateway(storage, { holder: 'device', authorize: async () => {} });
      const unknown = await reader.checks.read(identity, attemptId);
      assert.equal(unknown.state, 'unknown'); assert.equal(unknown.reason, 'dispatch-unconfirmed');
      assert.equal((await reader.checks.dispatch(identity, attemptId)).state, 'unknown');
      assert.equal(sends, 1, 'an unconfirmed task must not be replayed by another owner instance');
      release.resolve(); await gateway.checks.drain();
      const completed = await reader.checks.read(identity, attemptId);
      assert.equal(completed.state, 'completed'); assert.ok(completed.resultRef); assert.equal(completed.physicalRequestEnded, true);
      reader.closeWrites(); await reader.checks.drain();
    } else {
      armed = true;
      const result = view === 'read' ? await gateway.checks.read(identity, attemptId) : (await gateway.checks.list(identity)).find(item => item.attemptId === attemptId);
      assert.equal(intercepted, true); assert.equal(result.state, 'completed', 'the read must refresh the durable row after its local task disappears');
      assert.equal(result.physicalRequestEnded, true); assert.ok(result.resultRef); assert.match(result.text, /原回答进度/);
      const next = await client.checks.dispatch(identity, attemptId);
      assert.equal(next.resultRef, result.resultRef); assert.equal(next.state, 'completed'); assert.equal(sends, 1);
    }
  } finally {
    release.resolve(); gateway?.closeWrites(); await gateway?.checks.drain(); await storage?.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await pg.close();
  }
});
