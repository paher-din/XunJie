import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { agentRuntimeMigrations, createAgentRuntime } from '@xunjie/agent-runtime';
import { createWorkspaceAssistant } from '@xunjie/agents/workspace-assistant/index';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';

const tool = { name: 'read_result', description: '读取固定结果', strict: false,
  inputSchema: { type: 'object', properties: { range: { type: 'string' } }, required: [] } };
const protocolRoutes = {
  'chat-completions': { baseUrl: port => `http://127.0.0.1:${port}/v1`, path: '/chat/completions' },
  responses: { baseUrl: port => `http://127.0.0.1:${port}/v1`, path: '/responses' },
  messages: { baseUrl: port => `http://127.0.0.1:${port}`, path: '/v1/messages' },
};

test('Agent Step 和正式 read_work 向 Gateway 发送固定选区，并替换老化的 6 KiB 反馈', { timeout: 60_000 }, async t => {
  const payloads = [], storages = [];
  let rejected = 0;
  let withoutCompactablePrefix = false;
  const files = [
    { name: 'question.c', value: 'SELECTED_MARKER\nOUTSIDE_MARKER' },
    { name: 'fixed.c', value: 'x'.repeat(6144) + 'WORK_READ_TAIL' },
  ].map(file => ({ ...file, objectId: randomUUID(), contentId: randomUUID(), kind: 'code', encoding: 'utf8', mediaType: 'text/plain' }));
  const [selection, work] = files;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = Buffer.concat(chunks).toString();
    payloads.push(payload);
    const shaped = JSON.parse(payload);
    const summary = shaped.messages[0]?.content === 'fixture-capacity-summary';
    if ((payload.includes('CAPACITY_NO_PREFIX')
      || (payload.includes('CAPACITY_RETRY') && rejected === 0)) && !summary) {
      rejected++;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'maximum context length exceeded',
        type: 'invalid_request_error', code: 'context_length_exceeded' } }));
      return;
    }
    const lastMessage = shaped.messages.at(-1);
    const first = payloads.length === 1 || lastMessage?.role === 'user' && JSON.stringify(lastMessage.content).includes('REUSE_WARMUP');
    const id = 'fixture-step-' + payloads.length;
    const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixed-work-call', type: 'function',
      function: { name: 'read_work', arguments: JSON.stringify({ objectId: work.objectId, contentId: work.contentId, length: 7000 }) } }] }
      : { role: 'assistant', content: summary ? '保留原观察及版本' : '收到' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([{ id, object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: null }] },
      { id, object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }]
      .map(item => 'data: ' + JSON.stringify(item) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let fixture, runtime;
  t.after(async () => {
    await runtime?.close();
    for (const storage of storages.reverse()) await storage.close();
    await fixture?.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  fixture = await nativeFixture();
  const environmentId = randomUUID();
  async function open(name, migrations) {
    const owner = { environmentId, serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(fixture.root, name) }) });
    storages.push(storage);
    return storage;
  }
  const modelStorage = await open('step-gateway', modelMigrations), agentStorage = await open('step-kernel', agentRuntimeMigrations);
  const identity = { kind: 'personal', name: '学生', environmentId, spaceId: randomUUID(), principalId: randomUUID() };
  const activityId = randomUUID(), sessionId = randomUUID();
  const activity = { activityId, identity, target: { environmentId, serviceId: randomUUID(), version: 1 },
    goal: '核对固定作品', question: '', references: [], status: 'open', createdAt: new Date().toISOString() };
  const workspaceScene = createWorkspaceAssistant({ workspace: async () => activity, compaction: false, learning: {
    open: async () => activity,
    works: { content: async (_identity, _activity, contentId) => files.find(file => file.contentId === contentId),
      inspectVersion: async () => ({ retained: true, isCurrent: false, everPublished: true }) },
    drafts: { verifyReferences: async () => {} },
  } });
  const scene = { ...workspaceScene, compaction: { maxPerTurn: 1, provider: {
    id: 'capacity-summary', version: 1,
    prompt: () => ({ system: 'fixture-capacity-summary', text: '概括旧记录' }),
    parse: text => ({ observation: text }),
  }, select(history) {
    if (withoutCompactablePrefix) return null;
    const oldTurn = history[0]?.turnId;
    if (!oldTurn) return null;
    const messages = history.filter(entry => entry.turnId === oldTurn);
    if (!messages.length) return null;
    return { messages, remainder: history.slice(messages.length), sourceDigest: 'a'.repeat(64),
      retainedDigest: 'b'.repeat(64), sourceVersions: {}, policy: { maxSummaryTokens: 128 } };
  } } };
  const gateway = await createModelGateway(modelStorage, { holder: 'device', authorize: async () => {}, authorizePermit: async () => {} });
  const connectionId = randomUUID(), grantId = randomUUID();
  await gateway.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Step 回归',
    protocol: 'chat-completions', baseUrl: protocolRoutes['chat-completions'].baseUrl(upstream.address().port),
    path: '/chat/completions', modelId: 'fixture-model', dialect: 'standard', parameterMode: 'plain', enabled: true,
    contextWindow: 17_000, maxOutputTokens: 256, credential: { action: 'replace', value: 'synthetic-step-key' } });
  await gateway.selection.createGrant(identity, identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
  await gateway.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
  runtime = createAgentRuntime(agentStorage, { authorize: async () => {}, scenario: scene, gateway });
  await runtime.initialize({ identity, sessionId, scenario: scene.id, createdAt: activity.createdAt });
  const send = async (text, expected = 'completed', conversationId = sessionId) => {
    const requestId = randomUUID(), copy = 'SELECTED_MARKER';
    const action = { requestId, scope: { environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId },
      receiver: { receiverId: 'fixture-workspace', location: 'local', kind: 'question' },
      draft: { token: randomUUID(), question: text, references: [{ referenceId: randomUUID(), copy, sourceName: selection.name,
        source: { kind: 'work', objectId: selection.objectId, contentId: selection.contentId },
        range: { kind: 'code', start: 0, end: copy.length } }], bases: [] }, works: files, evidence: [] };
    const turn = await runtime.submit(identity, { requestId, sessionId: conversationId, text, context: { action } });
    await runtime.drain();
    const snapshot = await runtime.sessionSnapshot(identity, conversationId);
    const updated = snapshot.turns.find(item => item.turnId === turn.turnId);
    assert.equal(updated?.state, expected, JSON.stringify({
      reason: updated?.reason,
      attempts: snapshot.steps.filter(item => item.turnId === turn.turnId)
        .map(item => ({ errors: snapshot.attempts.filter(attempt => attempt.stepId === item.stepId).map(attempt => attempt.error),
          capacity: item.snapshot.requestCapacity?.pressure })),
    }));
    return snapshot;
  };
  const first = await send('请解释选区 ' + 'old context '.repeat(600));
  await send('继续核对');
  const final = await send('再次核对');
  assert.equal(payloads.length, 4);
  assert.equal(payloads[0].split('SELECTED_MARKER').length - 1, 1);
  assert.ok(payloads.every(payload => !payload.includes('OUTSIDE_MARKER')));
  assert.equal(payloads[1].split('SELECTED_MARKER').length - 1, 1, 'the tool-only continuation keeps a single selection');
  for (const payload of payloads.slice(1, 3)) assert.equal(payload.split('WORK_READ_TAIL').length - 1, 1);
  assert.doesNotMatch(payloads[3], /WORK_READ_TAIL/);
  assert.equal(payloads[3].split('早期工具反馈已压缩').length - 1, 1);
  assert.equal(final.toolCalls.length, 1);
  const earlier = first.attempts.at(-1);
  assert.deepEqual(await gateway.checks.requestPayload(identity, earlier.attemptId), JSON.parse(payloads[1]));

  await t.test('供应商返回上下文超限后，只派发一个确实更小的候选', async () => {
    const initial = payloads.length;
    const retried = await send('CAPACITY_RETRY');
    const out = payloads.slice(initial);
    assert.equal(rejected, 1);
    assert.equal(out.length, 3);
    assert.match(out[1], /fixture-capacity-summary/);
    assert.match(out[2], /CAPACITY_RETRY/);
    assert.ok(Buffer.byteLength(out[2]) < Buffer.byteLength(out[0]));
    assert.equal(retried.attempts.filter(attempt => attempt.error === 'context-capacity-exceeded').length, 1);
  });
  await t.test('没有闭合旧前缀时，供应商拒绝后不重复派发', async () => {
    const conversationId = randomUUID();
    await runtime.initialize({ identity, sessionId: conversationId, scenario: scene.id, createdAt: activity.createdAt });
    const initial = payloads.length;
    const snapshot = await send('CAPACITY_NO_PREFIX', 'failed', conversationId);
    assert.equal(payloads.length - initial, 1);
    assert.equal(snapshot.attempts.length, 1);
    assert.equal(snapshot.attempts[0].error, 'context-capacity-exceeded');
  });
  for (const reused of [false, true]) {
    await t.test(`压力预检取消${reused ? '续接的旧段' : '本步刚创建的段'}后，外发请求重建一次固定选区`, async () => {
      const conversationId = reused ? randomUUID() : sessionId;
      if (reused) {
        await runtime.initialize({ identity, sessionId: conversationId, scenario: scene.id, createdAt: activity.createdAt });
        await send('REUSE_WARMUP', 'completed', conversationId);
        assert.match(payloads.at(-1), /SELECTED_MARKER/);
      }
      const before = payloads.length;
      withoutCompactablePrefix = true;
      try {
        const snapshot = await send('REBUILD_QUESTION ' + '问'.repeat(reused ? 6_500 : 9_800), 'completed', conversationId);
        assert.equal(payloads.length - before, 1, 'preflight and summary do not dispatch');
        const attempt = snapshot.attempts.find(item => item.error === 'context-pressure');
        assert.ok(attempt, 'final request reached the pressure threshold');
        const cancelled = await gateway.checks.readRecorded(identity, attempt.attemptId);
        assert.equal(cancelled.state, 'cancelled');
        assert.equal(cancelled.segment.sequence > 0, reused);
        assert.equal((await gateway.segments.read(identity, cancelled.segment.segmentId)).closed, true);
        const step = snapshot.steps.find(item => item.stepId === attempt.stepId);
        assert.equal(step.snapshot.attemptContexts[attempt.attemptId].materials
          .find(item => item.label === selection.name).readState, reused ? 'reference-only' : 'included');
        const dispatched = await gateway.checks.readRecorded(identity, snapshot.attempts.at(-1).attemptId);
        assert.notEqual(dispatched.segment.segmentId, cancelled.segment.segmentId);
        const finalPayload = JSON.parse(payloads.at(-1));
        assert.deepEqual(await gateway.checks.requestPayload(identity, dispatched.attemptId), finalPayload);
        const finalMessages = JSON.stringify(finalPayload.messages);
        assert.equal(finalMessages.split('SELECTED_MARKER').length - 1, 1);
        assert.ok(finalMessages.indexOf('REBUILD_QUESTION') < finalMessages.indexOf('SELECTED_MARKER'));
        assert.doesNotMatch(finalMessages, /OUTSIDE_MARKER/);
        assert.equal(snapshot.toolCalls.length, 1, 'rebuilding does not reexecute completed tools');
      } finally {
        withoutCompactablePrefix = false;
      }
    });
  }
  await t.test('学生明确请求阅读全文时最终请求包含选区外正文', async () => {
    const conversationId = randomUUID();
    await runtime.initialize({ identity, sessionId: conversationId, scenario: scene.id, createdAt: activity.createdAt });
    const before = payloads.length;
    await send('请通读全文并指出问题', 'completed', conversationId);
    assert.equal(payloads.length - before, 1);
    assert.match(payloads.at(-1), /SELECTED_MARKER/);
    assert.match(payloads.at(-1), /OUTSIDE_MARKER/);
  });
});

function reply(protocol) {
  const calls = [
    { id: 'call_projection_1', range: 'first' },
    { id: 'call_projection_2', range: 'second' },
  ];
  if (protocol === 'chat-completions') {
    return [
      { id: 'projection-chat', object: 'chat.completion.chunk', model: 'fixture-model',
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls.map((call, index) => ({ index,
          id: call.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify({ range: call.range }) } })) },
          finish_reason: null }] },
      { id: 'projection-chat', object: 'chat.completion.chunk', model: 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
    ].map(item => 'data: ' + JSON.stringify(item) + '\n\n').join('') + 'data: [DONE]\n\n';
  }
  if (protocol === 'responses') {
    return 'data: ' + JSON.stringify({ type: 'response.completed', response: {
      id: 'projection-response', object: 'response', status: 'completed',
      output: calls.map((call, index) => ({ id: 'projection-call-' + index, type: 'function_call',
        call_id: call.id, name: tool.name, arguments: JSON.stringify({ range: call.range }), status: 'completed' })),
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    } }) + '\n\n';
  }
  const events = [
    { type: 'message_start', message: { id: 'projection-message', type: 'message', role: 'assistant',
      model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 0 } } },
    ...calls.flatMap((call, index) => [
      { type: 'content_block_start', index,
        content_block: { type: 'tool_use', id: call.id, name: tool.name, input: {} } },
      { type: 'content_block_delta', index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ range: call.range }) } },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 20, output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return events.map(item => 'event: ' + item.type + '\ndata: ' + JSON.stringify(item) + '\n\n').join('');
}

async function until(read, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('model transition timed out');
}

for (const protocol of Object.keys(protocolRoutes)) {
  test(`${protocol}: 同段续接把旧工具反馈替换为短期表示，原始结果仍可还原`, { timeout: 60_000 }, async () => {
    const upstream = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the real encoded request */ }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(reply(protocol));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const fixture = await nativeFixture();
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
    const storage = await openStorage({ binding, migrations: modelMigrations,
      backend: createFileBackend({ id: 'projection', root: join(fixture.root, 'projection') }) });
    try {
      const gateway = await createModelGateway(storage, { holder: 'device', authorize: async () => {},
        authorizePermit: async () => {} });
      const identity = { kind: 'personal', name: '学生', environmentId: owner.environmentId,
        spaceId: randomUUID(), principalId: randomUUID() };
      const route = protocolRoutes[protocol];
      const connection = await gateway.save(identity, { requestId: randomUUID(), connectionId: randomUUID(),
        expectedVersion: 0, name: `${protocol} projection`, protocol, baseUrl: route.baseUrl(upstream.address().port),
        path: route.path, modelId: 'fixture-model', dialect: 'standard', parameterMode: 'plain', enabled: true,
        contextWindow: 128_000, maxOutputTokens: 4096,
        credential: { action: 'replace', value: 'synthetic-projection-key' } });
      const sessionId = randomUUID();
      const initialProjectionId = 'b'.repeat(64);
      const segment = await gateway.segments.create(identity, { requestId: randomUUID(), segmentId: randomUUID(),
        sessionId, source: { connectionId: connection.connectionId, version: connection.version }, purpose: 'learning',
        prefix: { system: '只使用真实读取到的结果。', tools: [tool] }, portable: [], projectionId: initialProjectionId });
      const authority = (attemptId, stepId) => ({ formatVersion: 1,
        permit: { sessionId, runId: randomUUID(), stepId, operationId: attemptId, generation: 1 } });
      const firstAttempt = randomUUID(), firstStep = randomUUID();
      const firstAuthority = authority(firstAttempt, firstStep);
      await gateway.checks.receive(identity, { attemptId: firstAttempt, purpose: 'learning',
        segmentId: segment.segmentId, expectedSequence: segment.sequence, authority: firstAuthority,
        input: { text: '读取固定结果', images: [], toolResults: [], observations: [] },
        limits: { maxOutputTokens: 256, timeoutMs: 10_000 } });
      await gateway.checks.dispatch(identity, firstAttempt, firstAuthority);
      const completed = await until(() => gateway.checks.read(identity, firstAttempt), fact => fact.state === 'completed');
      const callIds = completed.toolIntents.map(intent => intent.callId);
      assert.deepEqual(callIds, ['call_projection_1', 'call_projection_2']);
      const afterFirst = await gateway.segments.read(identity, segment.segmentId);
      const settled = await gateway.segments.settle(identity, segment.segmentId, { requestId: randomUUID(),
        expectedSequence: afterFirst.sequence,
        results: callIds.map((callId, index) => ({ callId, outcome: 'success',
          text: 'x'.repeat(6000) + `FULL_RESULT_TAIL_${index + 1}`, images: [] })) });

      const secondAttempt = randomUUID(), secondStep = randomUUID();
      const shorts = ['早期反馈|SHORT_ONLY_MARKER_1', '早期反馈|SHORT_ONLY_MARKER_2'];
      await gateway.checks.receive(identity, { attemptId: secondAttempt, purpose: 'learning',
        segmentId: segment.segmentId, expectedSequence: settled.sequence,
        authority: authority(secondAttempt, secondStep),
        input: { text: '继续解释', images: [], toolResults: [], observations: [],
          historyProjection: { projectionId: 'c'.repeat(64), baseProjectionId: initialProjectionId,
            replacements: callIds.map((callId, index) => ({ entryId: 'tool-entry-' + index, callId, text: shorts[index] })) } },
        limits: { maxOutputTokens: 256, timeoutMs: 10_000 } });
      const payload = await gateway.checks.requestPayload(identity, secondAttempt);
      const encoded = JSON.stringify(payload);
      assert.equal(encoded.includes('FULL_RESULT_TAIL_1'), false);
      assert.equal(encoded.includes('FULL_RESULT_TAIL_2'), false);
      assert.equal(encoded.split('SHORT_ONLY_MARKER_1').length - 1, 1);
      assert.equal(encoded.split('SHORT_ONLY_MARKER_2').length - 1, 1);
      if (protocol === 'chat-completions') {
        const calls = payload.messages.filter(message => message.role === 'assistant' && message.tool_calls?.length);
        const results = payload.messages.filter(message => message.role === 'tool');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].tool_calls.length, 2);
        assert.deepEqual(results.map(result => result.tool_call_id), callIds);
        assert.deepEqual(results.map(result => result.content), shorts);
      } else if (protocol === 'responses') {
        const calls = payload.input.filter(item => item.type === 'function_call');
        const results = payload.input.filter(item => item.type === 'function_call_output');
        assert.equal(calls.length, 2);
        assert.deepEqual(results.map(result => result.call_id), callIds);
        assert.deepEqual(results.map(result => result.output), shorts);
      } else {
        const calls = payload.messages.flatMap(message => Array.isArray(message.content)
          ? message.content.filter(part => part.type === 'tool_use') : []);
        const results = payload.messages.flatMap(message => Array.isArray(message.content)
          ? message.content.filter(part => part.type === 'tool_result') : []);
        assert.equal(calls.length, 2);
        assert.deepEqual(results.map(result => result.tool_use_id), callIds);
        assert.deepEqual(results.map(result => result.content[0].text), shorts);
      }
      const { rows: [stored] } = await storage.read('SELECT body FROM model_tool_results WHERE attempt_id=$1', [firstAttempt]);
      assert.equal(stored.body.length, 2);
      assert.ok(stored.body[0].text.includes('FULL_RESULT_TAIL_1'), '原始工具结果仍按原 Attempt 保留');
      assert.ok(stored.body[1].text.includes('FULL_RESULT_TAIL_2'), '同批另一结果也按原 Attempt 保留');
    } finally {
      await storage.close();
      await fixture.close();
      await new Promise(resolve => upstream.close(resolve));
    }
  });
}

for (const protocol of Object.keys(protocolRoutes)) {
  test(`${protocol}: 换段后可按可移植 entryId 替换已老化反馈`, { timeout: 60_000 }, async () => {
    const payloads = [];
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      payloads.push(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(reply(protocol));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const fixture = await nativeFixture();
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
    const storage = await openStorage({ binding, migrations: modelMigrations,
      backend: createFileBackend({ id: 'portable-projection', root: join(fixture.root, 'portable-projection') }) });
    try {
      const gateway = await createModelGateway(storage, { holder: 'device', authorize: async () => {},
        authorizePermit: async () => {} });
      const identity = { kind: 'personal', name: '学生', environmentId: owner.environmentId,
        spaceId: randomUUID(), principalId: randomUUID() };
      const route = protocolRoutes[protocol];
      const connection = await gateway.save(identity, { requestId: randomUUID(), connectionId: randomUUID(),
        expectedVersion: 0, name: `${protocol} portable projection`, protocol, baseUrl: route.baseUrl(upstream.address().port),
        path: route.path, modelId: 'fixture-model', dialect: 'standard', parameterMode: 'plain', enabled: true,
        contextWindow: 128_000, maxOutputTokens: 4096,
        credential: { action: 'replace', value: 'synthetic-portable-key' } });
      const sessionId = randomUUID(), initialProjectionId = 'b'.repeat(64), nextProjectionId = 'c'.repeat(64);
      const full = 'PORTABLE_FULL_MARKER_' + 'x'.repeat(6000);
      const segment = await gateway.segments.create(identity, { requestId: randomUUID(), segmentId: randomUUID(),
        sessionId, source: { connectionId: connection.connectionId, version: connection.version }, purpose: 'learning',
        prefix: { system: '只使用固定投影。', tools: [tool] },
        portable: [{ role: 'user', text: full, entryId: 'portable-entry-1' },
          { role: 'user', text: full, entryId: 'other-entry' }], projectionId: initialProjectionId });
      const previousAttemptId = randomUUID(), runId = randomUUID();
      const previousAuthority = { formatVersion: 1,
        permit: { sessionId, runId, stepId: randomUUID(), operationId: previousAttemptId, generation: 1 } };
      const previous = await gateway.checks.receive(identity, { attemptId: previousAttemptId, purpose: 'learning',
        segmentId: segment.segmentId, expectedSequence: segment.sequence, authority: previousAuthority,
        input: { text: '原工具反馈仍在近期窗口', images: [], toolResults: [], observations: [] },
        limits: { maxOutputTokens: 256, timeoutMs: 10_000 } });
      await gateway.checks.dispatch(identity, previousAttemptId, previousAuthority);
      const completed = await until(() => gateway.checks.read(identity, previousAttemptId), value => value.physicalRequestEnded);
      assert.equal(completed.state, 'completed');
      const head = await gateway.segments.read(identity, segment.segmentId);
      await gateway.segments.settle(identity, segment.segmentId, { requestId: randomUUID(), expectedSequence: head.sequence,
        results: completed.toolIntents.map(call => ({ callId: call.callId, text: '配对反馈', outcome: 'success', images: [] })) });
      const attemptId = randomUUID(), stepId = randomUUID();
      const authority = { formatVersion: 1, permit: { sessionId, runId, stepId, operationId: attemptId, generation: 1 } };
      const accepted = await gateway.checks.receive(identity, { attemptId, purpose: 'learning', segmentId: segment.segmentId,
        expectedSequence: head.sequence, authority,
        input: { text: '继续解释', images: [], toolResults: [], observations: [],
          historyProjection: { projectionId: nextProjectionId, baseProjectionId: initialProjectionId,
            replacements: [{ entryId: 'portable-entry-1', text: 'PORTABLE_SHORT_MARKER' }] } },
        limits: { maxOutputTokens: 256, timeoutMs: 10_000 } });
      const encoded = JSON.stringify(await gateway.checks.requestPayload(identity, attemptId));
      assert.equal(encoded.split('PORTABLE_FULL_MARKER_').length - 1, 1);
      assert.equal(encoded.split('PORTABLE_SHORT_MARKER').length - 1, 1);
      await gateway.checks.dispatch(identity, attemptId, authority);
      await until(() => gateway.checks.read(identity, attemptId), value => value.physicalRequestEnded);
      assert.equal(JSON.stringify(JSON.parse(payloads[1])), encoded);
      assert.deepEqual(JSON.parse(Buffer.from(await storage.readResource(accepted.requestRef)).toString()), JSON.parse(encoded));
      const original = Buffer.from(await storage.readResource(previous.requestRef)).toString();
      assert.equal(original.split('PORTABLE_FULL_MARKER_').length - 1, 2);
      assert.doesNotMatch(original, /PORTABLE_SHORT_MARKER/);
    } finally {
      await storage.close();
      await fixture.close();
      await new Promise(resolve => upstream.close(resolve));
    }
  });
}
