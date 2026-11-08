import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { createModelGateway, modelMigrations } from '../../../packages/learning-space/dist/model-connections/index.js';
import { createLearningModelService, createLearningModelClient } from '../../../packages/learning-space/dist/model-connections/service.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(read, predicate) {
  for (let index = 0; index < 500; index++) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Model progress did not settle');
}
for (const failure of [false, true]) test(`real SDK/PG boundary: pending preview save ${failure ? 'fails without an unhandled rejection or consumable intent' : 'settles before final result and survives read-only reopen'}`, { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  let storage, gateway, release = deferred(), saveStarted = deferred(), sends = 0, readOnly = false;
  const key = 'synthetic-persist-key', text = '<p>' + '甲'.repeat(300) + '</p>';
  const upstream = createServer(async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    const payload = JSON.parse(Buffer.concat(parts));
    assert.ok(!JSON.stringify(payload).includes('json-string'));
    sends++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    // Two snapshots in the same throttle window, including a final unterminated tail flush.
    send({ tool_calls: [{ index: 0, id: 'original-call', type: 'function', function: { name: 'artifact_create', arguments: '{"html":"' + text.slice(0, 120) } }] });
    send({ tool_calls: [{ index: 0, function: { arguments: text.slice(120) + '","css":"private-css"}' } }] });
    send({}, 'tool_calls'); response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const identity = { kind: 'personal', name: '学习', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner: { environmentId: identity.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: modelMigrations });
    const backend = createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    storage = await openStorage({ binding, migrations: modelMigrations, backend });
    // Fault at the durable storage request seam; retain the real transactions and PG.
    const protectedStorage = () => new Proxy(storage, { get(target, property) {
      if (property === 'request') return async (request, apply) => {
        if (readOnly) throw new Error('read-only restoration attempted a write');
        if (request.fingerprint.startsWith('model-progress:')) {
          saveStarted.resolve(); await release.promise;
          if (failure) throw new StorageError('unavailable');
        }
        return target.request(request, apply);
      };
      if (readOnly && ['stageResource', 'pendingIntents'].includes(property)) return () => { throw new Error('read-only restoration attempted an effect'); };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    gateway = await createModelGateway(protectedStorage(), { holder: 'device', authorize: async () => {} });
    const boundary = () => createLearningModelClient(async request => JSON.parse(JSON.stringify(await createLearningModelService(gateway, async () => {})(JSON.parse(JSON.stringify(request))))));
    let client = boundary();
    const connectionId = randomUUID();
    await gateway.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Preview fixture', protocol: 'chat-completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'fixture', dialect: 'standard',
      parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: key } });
    const segmentId = randomUUID();
    await client.segments.create(identity, { requestId: randomUUID(), segmentId, purpose: 'learning', source: { connectionId, version: 1 },
      prefix: { system: 'Generate a static preview', tools: [{ name: 'artifact_create', description: '', progress: { kind: 'json-string', property: 'html' },
        inputSchema: { type: 'object', properties: { html: { type: 'string' }, css: { type: 'string' } }, required: ['html'], additionalProperties: false } }] }, portable: [] });
    const attemptId = randomUUID();
    await client.checks.receive(identity, { attemptId, purpose: 'learning', segmentId, expectedSequence: 0,
      input: { text: 'Create', images: [], toolResults: [] }, limits: { maxOutputTokens: 1000, timeoutMs: 10000 } });
    await client.checks.dispatch(identity, attemptId);
    await Promise.race([saveStarted.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Preview save never started')), 5000); timer.unref(); })]);
    assert.equal((await client.checks.read(identity, attemptId)).physicalRequestEnded, false, 'final result waits for durable progress');
    release.resolve();
    const result = await until(() => client.checks.read(identity, attemptId), value => value.physicalRequestEnded);
    assert.equal(sends, 1, 'preview never dispatches a second model request');
    if (failure) {
      assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'result-unconfirmed');
      assert.deepEqual(result.toolIntents ?? [], []);
      assert.equal(await client.checks.progress(identity, attemptId), null);
    } else {
      assert.equal(result.state, 'completed', result.reason);
      assert.equal(result.toolIntents[0].callId, 'original-call');
      assert.equal(result.toolIntents[0].arguments.html, text);
      const progress = await client.checks.progress(identity, attemptId);
      assert.equal(progress.text, '');
      assert.deepEqual(progress.tools, [{ callId: 'original-call', name: 'artifact_create', property: 'html', text: text.slice(0, -(key.length - 1)) }]);
      assert.ok(!JSON.stringify(progress).includes('private-css'));
      gateway.closeWrites(); await gateway.checks.drain(); await storage.close();
      storage = await openStorage({ binding, migrations: modelMigrations, backend });
      readOnly = true;
      gateway = await createModelGateway(protectedStorage(), { holder: 'device', authorize: async () => {} }); client = boundary();
      assert.deepEqual(await client.checks.progress(identity, attemptId), progress);
      assert.deepEqual(await client.checks.read(identity, attemptId), result);
      assert.equal(sends, 1, 'reopen/reads never regenerate or replay a tool');
      // Old serialized progress has no tools field and remains readable through the same port.
      readOnly = false;
      await storage.request({ requestId: randomUUID(), fingerprint: 'legacy-preview-fixture' }, async tx => {
        await tx.query('UPDATE model_attempt_progress SET body=$2 WHERE attempt_id=$1', [attemptId, { text: '旧正文', revision: 1 }]); return null;
      });
      readOnly = true;
      assert.deepEqual(await client.checks.progress(identity, attemptId), { text: '旧正文', revision: 1 });
      assert.equal(sends, 1);
    }
  } finally {
    release.resolve(); readOnly = false;
    gateway?.closeWrites(); await gateway?.checks.drain(); await storage?.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await fixture.close();
  }
});
