import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createModelGateway, modelMigrations, createSpaces, spaceMigrations } from '@xunjie/learning-space';
import { provisionStorage, openStorage, createFileBackend } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

test('native summary reads only validated completed Responses summary text from the owned resource', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  const opened = [];
  const queued = [];
  let requests = 0, gateway;
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* The real SDK sends the saved request. */ }
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const value of queued.shift()) response.write((value.type ? 'event: ' + value.type + '\n' : '') + 'data: ' + JSON.stringify(value) + '\n\n');
    response.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const environmentId = randomUUID();
    const openOwner = async (unit, migrations) => {
      const binding = await provisionStorage({ admin: fixture.admin,
        owner: { environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
      const options = { binding, migrations, backend: createFileBackend({ id: unit, root: join(fixture.root, unit) }) };
      const storage = await openStorage(options); opened.push(storage);
      return { storage, options };
    };
    const spaces = createSpaces((await openOwner('space', spaceMigrations)).storage);
    const identity = await spaces.personal();
    const model = await openOwner('model', modelMigrations);
    gateway = await createModelGateway(model.storage, { authorize: spaces.authorize, holder: 'device' });
    const response = (summary, status = 'completed') => [{ type: 'response.' + status, response: {
      id: 'native-summary-response', object: 'response', status, output: [
        { id: 'reasoning', type: 'reasoning', content: [{ type: 'reasoning_text', text: 'PRIVATE-REASONING' }], summary },
        { id: 'answer', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: '公开答复。', annotations: [] }] },
      ], usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
    } }];
    const run = async (events, protocol = 'responses') => {
      queued.push(events);
      const connectionId = randomUUID(), attemptId = randomUUID();
      await gateway.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0,
        name: '原生摘要边界', protocol, baseUrl: `http://127.0.0.1:${upstream.address().port}/${protocol === 'messages' ? 'anthropic' : 'v1'}`,
        path: { responses: '/responses', 'chat-completions': '/chat/completions', messages: '/v1/messages' }[protocol],
        modelId: 'summary-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
        credential: { action: 'replace', value: 'synthetic-native-summary-key' } });
      await gateway.checks.receive(identity, { attemptId, purpose: 'connection-check', source: { connectionId, version: 1 },
        limits: { maxOutputTokens: 128, timeoutMs: 10000 } });
      assert.equal(await gateway.checks.summary(identity, attemptId), null, 'accepted requests have no summary');
      await gateway.checks.dispatch(identity, attemptId);
      for (let index = 0; index < 200; index++) {
        const fact = await gateway.checks.read(identity, attemptId);
        if (fact.physicalRequestEnded) return fact;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Native summary fixture did not finish');
    };
    const native = await run(response([
      { type: 'summary_text', text: '**已核对**固定输入。' }, { type: 'summary_text', text: '结果来自真实工具。' },
    ]));
    assert.equal(native.state, 'completed'); assert.ok(native.resultRef);
    assert.deepEqual(await gateway.checks.summary(identity, native.attemptId), {
      source: 'model-native', text: '**已核对**固定输入。\n\n结果来自真实工具。', truncated: false,
    });
    const physicalEnded = async value => model.storage.request({ requestId: randomUUID(), fingerprint: 'summary-physical-boundary' }, async tx => {
      await tx.query("UPDATE model_attempts SET body=jsonb_set(body,'{physicalRequestEnded}',$2::jsonb),physical_ended=$3 WHERE id=$1",
        [native.attemptId, JSON.stringify(value), value]); return null;
    });
    await physicalEnded(false);
    try {
      assert.equal(await gateway.checks.summary(identity, native.attemptId), null, 'a completed result cannot publish before its physical request ends');
    } finally { await physicalEnded(true); }
    await assert.rejects(gateway.checks.summary({ ...identity, principalId: randomUUID() }, native.attemptId));
    const absent = await run(response([]));
    assert.equal(absent.state, 'completed');
    assert.equal(await gateway.checks.summary(identity, absent.attemptId), null, 'raw reasoning is not a summary');
    const longText = '🧪'.repeat(7999) + 'x' + '🧪'.repeat(3000);
    const bounded = await run(response([{ type: 'summary_text', text: longText }]));
    const visible = await gateway.checks.summary(identity, bounded.attemptId);
    assert.equal(visible.source, 'model-native'); assert.ok(visible.text.length <= 16000);
    assert.equal(visible.truncated, true);
    assert.ok(longText.startsWith(visible.text)); assert.ok(!/[\uD800-\uDBFF]$/.test(visible.text));
    const incomplete = await run(response([{ type: 'summary_text', text: '尚未完成的摘要' }], 'incomplete'));
    assert.notEqual(incomplete.state, 'completed');
    assert.equal(await gateway.checks.summary(identity, incomplete.attemptId), null);
    const chat = await run([
      { id: 'chat-summary', choices: [{ index: 0, delta: { role: 'assistant', content: '公开答复。', reasoning_content: 'CHAT-PRIVATE' }, finish_reason: null }] },
      { id: 'chat-summary', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ], 'chat-completions');
    assert.equal(chat.state, 'completed'); assert.equal(await gateway.checks.summary(identity, chat.attemptId), null);
    const messages = await run([
      { type: 'message_start', message: { id: 'messages-summary', type: 'message', role: 'assistant', model: 'summary-fixture', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: null } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'MESSAGES-PRIVATE' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '公开答复。' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 7, output_tokens: 4 } },
      { type: 'message_stop' },
    ], 'messages');
    assert.equal(messages.state, 'completed'); assert.equal(await gateway.checks.summary(identity, messages.attemptId), null);

    gateway.closeWrites(); await gateway.checks.drain(); await model.storage.close();
    opened.splice(opened.indexOf(model.storage), 1);
    const reopened = await openStorage(model.options); opened.push(reopened);
    gateway = await createModelGateway(reopened, { authorize: spaces.authorize, holder: 'device' });
    assert.deepEqual(await gateway.checks.summary(identity, native.attemptId), {
      source: 'model-native', text: '**已核对**固定输入。\n\n结果来自真实工具。', truncated: false,
    });
    assert.equal(requests, 6, 'summary reads and owner restart never dispatch another model request');
    // Retain a checksum-valid but contradictory native resource to exercise semantic validation.
    const altered = JSON.parse(Buffer.from(await reopened.readResource(native.resultRef)).toString('utf8'));
    altered.output[0].summary[0].text = 'FORGED';
    const resource = await reopened.stageResource({ uploadId: randomUUID(), scope: 'summary-corruption',
      bytes: Buffer.from(JSON.stringify(altered)), mediaType: 'application/json', contentVersion: 1 });
    await reopened.request({ requestId: randomUUID(), fingerprint: 'summary-corruption' }, async tx => {
      await tx.reference('summary-corruption', resource.resourceId);
      await tx.query("UPDATE model_attempts SET body=jsonb_set(body,'{resultRef}',$2::jsonb) WHERE id=$1",
        [native.attemptId, JSON.stringify(resource.resourceId)]); return null;
    });
    await assert.rejects(gateway.checks.summary(identity, native.attemptId), { code: 'corrupt' });
  } finally {
    gateway?.closeWrites(); await gateway?.checks.drain();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    for (const storage of opened.reverse()) await storage.close();
    await fixture.close();
  }
});
