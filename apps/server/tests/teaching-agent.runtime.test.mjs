import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, restoreProductRecovery } from '@xunjie/product-runtime';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

function stream(response, text, receiveAt) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
  const reply = () => {
    send({ id: 'teaching-' + receiveAt, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
    send({ id: 'teaching-' + receiveAt, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } });
    response.end('data: [DONE]\n\n');
  };
  return reply;
}

async function waitFor(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

test('a learning conversation persists across runs, restart, stop and transport reconstruction', { timeout: 240000 }, async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    received.push(payload);
    const index = received.length;
    const reply = stream(response, index === 3 ? '停止前的回答' : '回答' + index, index);
    if (index === 3) setTimeout(reply, 2500); else reply();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-teaching-agent-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  let failure;
  try {
    await runtime.install({ profile: 'local' });
    let { endpoint } = await runtime.start();
    const api = async (route, body) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), {
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const connectionId = randomUUID();
    assert.equal((await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: '学习对话测试', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      path: '/chat/completions', modelId: 'fixture-learning', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 8192, credential: { action: 'replace', value: 'synthetic-learning-key' } })).status, 200);
    const grantId = randomUUID();
    assert.equal((await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' })).status, 200);
    assert.equal((await api('models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId, grantId } })).status, 200);

    const activity = (await api('activities', { requestId: randomUUID(), goal: '理解循环不变量',
      question: '循环不变量为什么要在每次迭代开始时成立？', references: [] })).value;
    const path = 'intents/' + activity.activityId;
    const capabilities = (await api('agent/' + activity.activityId + '/capabilities')).value;
    assert.equal(capabilities.modelAvailable, true);
    const receiver = capabilities.receiver;
    assert.equal(receiver.kind, 'question');
    const scope = { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
      principalId: activity.identity.principalId, activityId: activity.activityId };
    const action = question => ({ requestId: randomUUID(), scope, receiver,
      draft: { token: randomUUID(), question, references: [], bases: [] }, works: [], evidence: [] });
    const first = action('请解释这段循环为什么不变量成立。');
    const prepared = await api(path, first);
    assert.equal(prepared.status, 200);
    assert.equal(prepared.value.inputDigest.length, 64);
    const dispatched = await api(path + '/' + first.requestId + '/dispatch', {});
    assert.equal(dispatched.status, 200);
    assert.equal(dispatched.value.state, 'accepted');
    assert.equal(dispatched.value.receipt.state, 'accepted');
    const firstRun = JSON.parse(dispatched.value.receipt.detail).runId;
    assert.match(dispatched.value.receipt.detail, /"runId":/);

    const conversation = await waitFor(async () => {
      const value = (await api('agent/' + activity.activityId + '/conversation')).value;
      return value.messages.some(message => message.role === 'assistant') ? value : null;
    }, 'The first learning answer was not persisted.');
    assert.equal(conversation.messages[0].role, 'student');
    assert.equal(conversation.messages[1].role, 'assistant');
    assert.equal(conversation.messages[1].text, '回答1');
    assert.equal(received.length, 1);
    assert.equal(received[0].max_tokens, 8192, 'the saved maximum output is not silently rewritten');
    assert.equal(received[0].messages[0].role, 'system');
    assert.match(received[0].messages[0].content, /循阶学习空间/);
    assert.match(received[0].messages[0].content, /理解循环不变量/);
    const lastContent = received[0].messages.at(-1).content;
    assert.match(Array.isArray(lastContent) ? lastContent.map(part => part.text ?? '').join('') : lastContent, /请解释这段循环/);

    const events = (await api('agent/' + activity.activityId + '/events')).value;
    assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
    assert.equal(events.filter(event => event.kind === 'input').length, 1);
    assert.equal(events.filter(event => event.kind === 'assistant').length, 1);
    assert.ok(events.some(event => event.kind === 'run-completed'));
    const assembled = events.find(event => event.kind === 'context-assembled');
    assert.ok(assembled);
    const snapshot = (await api('agent/' + activity.activityId + '/snapshots/' + assembled.body.snapshotId)).value;
    assert.deepEqual(snapshot.payload, received[0], 'the transport body must equal the saved reconstruction');
    assert.equal(snapshot.model.connectionId, connectionId);
    assert.equal(snapshot.maxOutputTokens, 8192);
    assert.ok(snapshot.sources.some(source => source.kind === 'platform'));

    const duplicate = await api(path + '/' + first.requestId + '/dispatch', {});
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.value.receipt.receiptId, dispatched.value.receipt.receiptId);
    assert.equal(received.length, 1, 'an accepted request is not dispatched twice');
    assert.equal((await api(path, { ...first, draft: { ...first.draft, question: '被替换的问题' } })).status, 409);
    assert.equal((await api('agent/' + activity.activityId + '/requests/' + first.requestId)).value.state, 'accepted');

    const second = action('那在循环结束时它又能说明什么？');
    assert.equal((await api(path, second)).status, 200);
    assert.equal((await api(path + '/' + second.requestId + '/dispatch', {})).status, 200);
    const continued = await waitFor(async () => {
      const value = (await api('agent/' + activity.activityId + '/conversation')).value;
      return value.messages.filter(message => message.role === 'assistant').length >= 2 ? value : null;
    }, 'The second learning answer was not persisted.');
    assert.equal(continued.messages.at(-1).text, '回答2');
    assert.equal(received.length, 2);
    assert.ok(received[1].messages.some(message => message.role === 'assistant' && message.content === '回答1'),
      'the next run continues the native model context across runs');

    await runtime.stop();
    ({ endpoint } = await runtime.start());
    const restarted = (await api('agent/' + activity.activityId + '/conversation')).value;
    assert.deepEqual(restarted.messages, continued.messages);
    assert.equal(received.length, 2, 'reading a conversation never calls the model');

    const third = action('如果我要停止一个很慢的回答呢？');
    assert.equal((await api(path, third)).status, 200);
    const thirdAccepted = await api(path + '/' + third.requestId + '/dispatch', {});
    assert.equal(thirdAccepted.status, 200);
    const runId = JSON.parse(thirdAccepted.value.receipt.detail).runId;
    await waitFor(async () => received.length === 3, 'The third call was not sent.');
    await new Promise(resolve => setTimeout(resolve, 300));
    const stop = await api('agent/' + activity.activityId + '/runs/' + runId + '/stop', { requestId: randomUUID() });
    assert.equal(stop.status, 200);
    const stopped = await waitFor(async () => {
      const value = (await api('agent/' + activity.activityId + '/runs/' + runId)).value;
      return value.state === 'stopped' ? value : null;
    }, 'The stopped run did not settle.');
    assert.equal(stopped.stopRequested, true);
    const afterStop = (await api('agent/' + activity.activityId + '/events')).value;
    assert.ok(afterStop.some(event => event.kind === 'stop-requested'));
    assert.ok(afterStop.some(event => event.kind === 'run-stopped'));
    const stoppedConversation = (await api('agent/' + activity.activityId + '/conversation')).value;
    assert.equal(stoppedConversation.messages.filter(message => message.role === 'student').length, 3);
  } catch (error) { failure = error; }
  finally {
    try { await runtime.stop(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
  if (failure) throw failure;
});

test('long histories, large inputs and saved 1M windows are used without probe limits', { timeout: 240000 }, async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    stream(response, '长上下文回答' + received.length, received.length)();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-teaching-long-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  let failure;
  try {
    await runtime.install({ profile: 'local' });
    const { endpoint } = await runtime.start();
    const api = async (route, body) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), {
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const connectionId = randomUUID();
    const save = (expectedVersion, contextWindow, maxOutputTokens) => api('models/connections', {
      requestId: randomUUID(), connectionId, expectedVersion, name: '长上下文模型', protocol: 'chat-completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'fixture-long',
      dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow, maxOutputTokens,
      credential: expectedVersion === 0 ? { action: 'replace', value: 'synthetic-long-key' } : { action: 'keep' } });
    assert.equal((await save(0, 262144, 8192)).status, 200);
    const grantId = randomUUID();
    assert.equal((await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' })).status, 200);
    assert.equal((await api('models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId, grantId } })).status, 200);
    const activity = (await api('activities', { requestId: randomUUID(), goal: '长上下文回归', question: '', references: [] })).value;
    const capabilities = (await api('agent/' + activity.activityId + '/capabilities')).value;
    const scope = { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
      principalId: activity.identity.principalId, activityId: activity.activityId };
    const big = { objectId: randomUUID(), contentId: randomUUID(), name: '大材料.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '巨大材料开始\n' + '甲'.repeat(70000) + '\n巨大材料结束' };
    const send = async (question, works = []) => {
      const before = received.length;
      const input = { requestId: randomUUID(), scope, receiver: capabilities.receiver,
        draft: { token: randomUUID(), question, references: [], bases: [] }, works, evidence: [] };
      const path = 'intents/' + activity.activityId;
      assert.equal((await api(path, input)).status, 200);
      const dispatched = await api(path + '/' + input.requestId + '/dispatch', {});
      assert.equal(dispatched.status, 200);
      assert.equal(dispatched.value.state, 'accepted');
      return waitFor(async () => {
        if (received.length <= before) return null;
        const conversation = (await api('agent/' + activity.activityId + '/conversation')).value;
        return conversation.runs.at(-1).state === 'completed' ? conversation : null;
      }, 'A long-context run did not complete.');
    };
    for (let index = 0; index < 10; index++) {
      const works = index === 0 || index === 9 ? [big] : [];
      await send(index === 9 ? '请结合这份大材料回答第 10 个问题。' : '第 ' + (index + 1) + ' 个问题。', works);
    }
    assert.equal(received.length, 10);
    const tenth = received[9];
    assert.ok(tenth.messages.length >= 20, 'more than eight conversation groups stay in the native context');
    assert.equal(tenth.messages.filter(message => message.role === 'user').length, 10);
    assert.equal(tenth.max_tokens, 8192);
    const tenthUser = tenth.messages.at(-1).content;
    const text = Array.isArray(tenthUser) ? tenthUser.map(part => part.text ?? '').join('') : tenthUser;
    assert.match(text, /巨大材料开始/);
    assert.ok(text.length > 65000, 'an input over 64 KiB reaches the transport unchanged');

    assert.equal((await save(1, 1048576, 16384)).status, 200);
    const eventsBefore = (await api('agent/' + activity.activityId + '/events')).value;
    const previousSegment = eventsBefore.filter(event => event.kind === 'context-assembled').at(-1).body.segmentId;
    await send('更换窗口后继续，并用更长的输出回答。');
    assert.equal(received.length, 11);
    assert.equal(received[10].max_tokens, 16384, 'a saved output above the probe limit is not silently rewritten');
    const eventsAfter = (await api('agent/' + activity.activityId + '/events')).value;
    const assembled = eventsAfter.filter(event => event.kind === 'context-assembled').at(-1);
    assert.notEqual(assembled.body.segmentId, previousSegment, 'a configuration change seals the old native segment');
    const snapshot = (await api('agent/' + activity.activityId + '/snapshots/' + assembled.body.snapshotId)).value;
    assert.equal(snapshot.contextWindow, 1048576);
    const roles = received[10].messages.map(message => message.role);
    assert.equal(roles[0], 'system');
    assert.equal(roles.filter(role => role === 'user').length, 11, 'a sealed segment keeps prior student turns with their native role');
    assert.equal(roles.filter(role => role === 'assistant').length, 10, 'a sealed segment keeps prior Agent turns with their native role');
    assert.equal(received[10].messages[1].content, '第 1 个问题。');
  } catch (error) { failure = error; }
  finally {
    try { await runtime.stop(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
  if (failure) throw failure;
});

test('learning text Q&A runs through all three native protocols with reconstructable snapshots', { timeout: 300000 }, async t => {
  for (const protocol of ['chat-completions', 'responses', 'messages']) await t.test(protocol, async () => {
    const received = [];
    const send = (response, value) => response.write((protocol === 'messages' ? 'event: ' + value.type + '\ndata: ' : 'data: ')
      + JSON.stringify(value) + '\n\n');
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push(JSON.parse(Buffer.concat(chunks)));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = '协议回答-' + protocol;
      if (protocol === 'chat-completions') {
        send(response, { id: 'native-chat', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
        send(response, { id: 'native-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        send(response, { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } });
        response.end('data: [DONE]\n\n');
      } else if (protocol === 'responses') {
        send(response, { type: 'response.created', response: { id: 'native-response', object: 'response', status: 'in_progress', output: [] } });
        send(response, { type: 'response.completed', response: { id: 'native-response', object: 'response', status: 'completed',
          output: [{ id: 'native-message', type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }] }],
          usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } } });
        response.end();
      } else {
        send(response, { type: 'message_start', message: { id: 'native-message', type: 'message', role: 'assistant',
          model: 'fixture-messages', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } });
        send(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
        send(response, { type: 'content_block_stop', index: 0 });
        send(response, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 11, output_tokens: 3 } });
        send(response, { type: 'message_stop' });
        response.end();
      }
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const root = await mkdtemp(join(tmpdir(), 'xj-teaching-protocol-' + protocol + '-'));
    const runtime = openProductRuntime({ root, resources: {
      nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
      webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
      windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
    let failure;
    try {
      await runtime.install({ profile: 'local' });
      const { endpoint } = await runtime.start();
      const api = async (route, body) => {
        const response = await fetch(new URL('/api/learning/' + route, endpoint), {
          headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
        return { status: response.status, value: await response.json() };
      };
      const connectionId = randomUUID(), port = upstream.address().port;
      const configuration = protocol === 'messages'
        ? { protocol, baseUrl: `http://127.0.0.1:${port}/anthropic`, path: '/v1/messages', dialect: 'deepseek', parameterMode: 'thinking' }
        : protocol === 'responses'
          ? { protocol, baseUrl: `http://127.0.0.1:${port}/v1`, path: '/responses', dialect: 'deepseek', parameterMode: 'thinking' }
          : { protocol, baseUrl: `http://127.0.0.1:${port}/v1`, path: '/chat/completions', dialect: 'standard', parameterMode: 'plain' };
      assert.equal((await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
        name: '三协议学习 ' + protocol, ...configuration, modelId: 'fixture-' + protocol, enabled: true,
        contextWindow: 262144, maxOutputTokens: 8192,
        credential: { action: 'replace', value: 'synthetic-protocol-key' } })).status, 200);
      const grantId = randomUUID();
      assert.equal((await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' })).status, 200);
      assert.equal((await api('models/selection', { requestId: randomUUID(), expectedVersion: 0,
        source: { kind: 'personal', connectionId, grantId } })).status, 200);
      const activity = (await api('activities', { requestId: randomUUID(), goal: '三协议问答', question: '', references: [] })).value;
      const capabilities = (await api('agent/' + activity.activityId + '/capabilities')).value;
      const action = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId,
        spaceId: activity.identity.spaceId, principalId: activity.identity.principalId, activityId: activity.activityId },
        receiver: capabilities.receiver, draft: { token: randomUUID(), question: '请用一句话说明当前活动目标。', references: [], bases: [] },
        works: [], evidence: [] };
      const path = 'intents/' + activity.activityId;
      assert.equal((await api(path, action)).status, 200);
      assert.equal((await api(path + '/' + action.requestId + '/dispatch', {})).status, 200);
      const conversation = await waitFor(async () => {
        const value = (await api('agent/' + activity.activityId + '/conversation')).value;
        return value.runs.at(-1)?.state === 'completed' ? value : null;
      }, 'The ' + protocol + ' learning answer did not complete.');
      assert.equal(conversation.messages.at(-1).role, 'assistant');
      assert.equal(conversation.messages.at(-1).text, '协议回答-' + protocol);
      assert.equal(received.length, 1);
      const events = (await api('agent/' + activity.activityId + '/events')).value;
      const assembled = events.find(event => event.kind === 'context-assembled');
      const snapshot = (await api('agent/' + activity.activityId + '/snapshots/' + assembled.body.snapshotId)).value;
      assert.equal(snapshot.model.protocol, protocol);
      assert.deepEqual(snapshot.payload, received[0], 'the actual transport body equals the saved reconstruction');
      const payload = received[0];
      if (protocol === 'chat-completions') {
        assert.equal(payload.max_tokens, 8192);
        assert.ok(Array.isArray(payload.messages));
      } else if (protocol === 'responses') {
        assert.equal(payload.max_output_tokens, 8192);
        assert.match(payload.instructions, /循阶学习空间/);
      } else {
        assert.equal(payload.max_tokens, 8192);
        assert.ok(String(payload.system).includes('循阶学习空间'));
      }
      assert.ok(events.some(event => event.kind === 'run-completed'));
    } catch (error) { failure = error; }
    finally {
      try { await runtime.stop(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
      upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    }
    if (failure) throw failure;
  });
});

test('a course release fixes its help policy and a disabled policy refuses without a model call', { timeout: 180000 }, async () => {
  const upstream = createServer(async (request, response) => {
    sent++;
    for await (const _chunk of request) { /* a refused question never reaches the model */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-teaching-course-policy-'));
  const runtime = openProductRuntime({ root, resources: {
    nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  let sent = 0, failure;
  try {
    await runtime.install({ profile: 'local' });
    const { endpoint } = await runtime.start();
    const control = (await import('@xunjie/product-runtime')).resolveCredential;
    const admin = { authorization: 'Bearer ' + await control(root, 'control') };
    const api = async (path, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + path, endpoint), {
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, value: await response.json().catch(() => null) };
    };
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const helpPolicy = { version: 1, questions: 'disabled', scope: 'course', note: '本任务由教师面批。' };
    const imported = await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
      course: { courseId, name: '禁用问答课程' }, task: { taskId, title: '课程内测验', summary: '' },
      release: { releaseId, objectives: ['完成课程内测验'], requirements: '独立完成。', materials: [], starterWorks: [],
        capabilities: [], helpPolicy }, resources: [] }, admin);
    assert.equal(imported.status, 200, JSON.stringify(imported.value));
    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'policy-student', password }, admin);
    assert.equal(member.status, 200);
    const logged = await api('login', { loginName: 'policy-student', password });
    assert.equal(logged.status, 200);
    const cookie = logged.headers.get('set-cookie').split(';')[0], identity = logged.value.identity;
    assert.equal((await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: true }, admin)).status, 200);
    const release = await api('releases/' + releaseId, undefined, { cookie });
    assert.equal(release.status, 200);
    assert.deepEqual(release.value.helpPolicy, helpPolicy);
    const activity = await api('course-activities', { requestId: randomUUID(), releaseId }, { cookie });
    assert.equal(activity.status, 200, JSON.stringify(activity.value));
    assert.deepEqual(activity.value.course.helpPolicy, helpPolicy);

    const connectionId = randomUUID(), grantId = randomUUID(), port = upstream.address().port;
    assert.equal((await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: '策略测试模型', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${port}/v1`, path: '/chat/completions',
      modelId: 'fixture-policy', dialect: 'standard', parameterMode: 'plain', enabled: true,
      credential: { action: 'replace', value: 'synthetic-policy-key' } }, { cookie })).status, 200);
    assert.equal((await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' }, { cookie })).status, 200);
    assert.equal((await api('models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId, grantId } }, { cookie })).status, 200);

    const capabilities = (await api('agent/' + activity.value.activityId + '/capabilities', undefined, { cookie })).value;
    assert.equal(capabilities.modelAvailable, true);
    const question = { requestId: randomUUID(), scope: { environmentId: activity.value.identity.environmentId,
      spaceId: activity.value.identity.spaceId, principalId: activity.value.identity.principalId, activityId: activity.value.activityId },
      receiver: capabilities.receiver, draft: { token: randomUUID(), question: '可以直接告诉我答案吗？', references: [], bases: [] },
      works: [], evidence: [] };
    const path = 'intents/' + activity.value.activityId;
    const prepared = await api(path, question, { cookie });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
    const dispatched = await api(path + '/' + question.requestId + '/dispatch', {}, { cookie });
    assert.equal(dispatched.status, 200, JSON.stringify(dispatched.value));
    assert.equal(dispatched.value.receipt.state, 'cancelled');
    assert.equal(JSON.parse(dispatched.value.receipt.detail).runId, null);
    await new Promise(resolve => setTimeout(resolve, 500));
    const conversation = (await api('agent/' + activity.value.activityId + '/conversation', undefined, { cookie })).value;
    assert.deepEqual(conversation.messages, []);
    assert.deepEqual(conversation.runs, []);
  } catch (error) { failure = error; }
  finally {
    try { await runtime.stop(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
  if (failure) throw failure;
  assert.equal(sent, 0);
});

test('a teaching conversation, event log and snapshot survive real backup, isolated restore and takeover', { timeout: 300000 }, async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    stream(response, '备份恢复后的回答', received.length)();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-teaching-recovery-'));
  const directory = await mkdtemp(join(tmpdir(), 'xj-teaching-backups-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  let target;
  let failure;
  try {
    await runtime.install({ profile: 'local' });
    const { endpoint } = await runtime.start();
    const api = async (route, body) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), {
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const connectionId = randomUUID(), port = upstream.address().port;
    assert.equal((await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: '恢复测试模型', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${port}/v1`, path: '/chat/completions',
      modelId: 'fixture-recovery', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 8192,
      credential: { action: 'replace', value: 'synthetic-recovery-key' } })).status, 200);
    const grantId = randomUUID();
    assert.equal((await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' })).status, 200);
    assert.equal((await api('models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId, grantId } })).status, 200);
    const activity = (await api('activities', { requestId: randomUUID(), goal: '恢复对话', question: '', references: [] })).value;
    const capabilities = (await api('agent/' + activity.activityId + '/capabilities')).value;
    const action = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId,
      spaceId: activity.identity.spaceId, principalId: activity.identity.principalId, activityId: activity.activityId },
      receiver: capabilities.receiver, draft: { token: randomUUID(), question: '备份之后这个问题还在吗？', references: [], bases: [] },
      works: [], evidence: [] };
    const path = 'intents/' + activity.activityId;
    assert.equal((await api(path, action)).status, 200);
    assert.equal((await api(path + '/' + action.requestId + '/dispatch', {})).status, 200);
    const before = await waitFor(async () => {
      const value = (await api('agent/' + activity.activityId + '/conversation')).value;
      return value.runs.at(-1)?.state === 'completed' ? value : null;
    }, 'The original recovered conversation did not complete.');
    const events = (await api('agent/' + activity.activityId + '/events')).value;
    const assembled = events.find(event => event.kind === 'context-assembled');
    const snapshot = (await api('agent/' + activity.activityId + '/snapshots/' + assembled.body.snapshotId)).value;

    const key = randomBytes(32);
    await runtime.setCredential('teaching-recovery', key.toString('base64'));
    const backup = await runtime.recovery.backup({ directory, recoveryKeyRef: 'teaching-recovery', leaveClosed: true });
    assert.equal(backup.services.length, 5, 'the teaching owner participates in the same backup boundary');
    const targetRoot = join(directory, 'target');
    const restored = await restoreProductRecovery({ root: targetRoot, resources, backupDirectory: join(directory, backup.backupId), key });
    try { assert.ok(restored.owners.length); } finally { for (const owner of restored.owners) await owner.close?.(); }
    target = openProductRuntime({ root: targetRoot, resources });
    const state = await target.start();
    assert.equal(state.state, 'maintenance');
    assert.equal((await target.recovery.takeover({ sourceRoot: root, receivers: [] })).phase, 'active');
    const targetApi = async (route) => {
      const response = await fetch(new URL('/api/learning/' + route, state.endpoint), { headers: { 'x-xj-space': 'personal' } });
      return { status: response.status, value: await response.json() };
    };
    const after = (await targetApi('agent/' + activity.activityId + '/conversation')).value;
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.runs.map(run => run.state), before.runs.map(run => run.state));
    assert.equal((await targetApi('agent/' + activity.activityId + '/snapshots/' + snapshot.snapshotId)).value.payloadSha256, snapshot.payloadSha256);
    assert.equal((await targetApi('agent/' + activity.activityId + '/events')).value.length, events.length);
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(received.length, 1, 'restoring and reading a conversation never calls the model');
  } catch (error) { failure = error; }
  finally {
    try { await target?.stop(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
    try { await runtime.stop(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (failure) throw failure;
});

test('incremental answer text is published after gateway persistence and settles into one message', { timeout: 180000 }, async () => {
  const first = '第一段回答：循环不变量必须在每次迭代开始时成立，这样才能由归纳假设推出下一次迭代仍然成立。';
  const second = '第二段回答：循环结束时，不变量与退出条件一起给出结论。';
  const upstream = createServer(async (request, response) => {
    for await (const ignored of request) { /* consume the native payload */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    send({ id: 'progress', choices: [{ index: 0, delta: { role: 'assistant', content: first }, finish_reason: null }] });
    await new Promise(resolve => setTimeout(resolve, 1500));
    send({ id: 'progress', choices: [{ index: 0, delta: { content: second }, finish_reason: null }] });
    send({ id: 'progress', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } });
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-teaching-progress-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  let failure;
  try {
    await runtime.install({ profile: 'local' });
    const { endpoint } = await runtime.start();
    const api = async (route, body) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), {
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const connectionId = randomUUID();
    assert.equal((await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: '增量回答模型', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      path: '/chat/completions', modelId: 'fixture-progress', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 8192,
      credential: { action: 'replace', value: 'synthetic-progress-key' } })).status, 200);
    const grantId = randomUUID();
    assert.equal((await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' })).status, 200);
    assert.equal((await api('models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId, grantId } })).status, 200);
    const activity = (await api('activities', { requestId: randomUUID(), goal: '观察增量回答', question: '', references: [] })).value;
    const capabilities = (await api('agent/' + activity.activityId + '/capabilities')).value;
    const action = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId,
      spaceId: activity.identity.spaceId, principalId: activity.identity.principalId, activityId: activity.activityId },
      receiver: capabilities.receiver, draft: { token: randomUUID(), question: '请解释循环不变量。', references: [], bases: [] },
      works: [], evidence: [] };
    const path = 'intents/' + activity.activityId;
    assert.equal((await api(path, action)).status, 200);
    assert.equal((await api(path + '/' + action.requestId + '/dispatch', {})).status, 200);
    const streaming = await waitFor(async () => {
      const value = (await api('agent/' + activity.activityId + '/conversation')).value;
      return value.messages.find(message => message.role === 'assistant' && message.state === 'streaming' && message.text) ?? null;
    }, 'Incremental answer text was never published.');
    assert.ok(first.startsWith(streaming.text), 'the live preview is a safe prefix of the answer');
    assert.ok(streaming.text.length > 0 && streaming.text.length < first.length,
      'the credentials withheld tail is not published early');
    assert.ok(!streaming.text.includes('synthetic-progress-key'));
    const completed = await waitFor(async () => {
      const value = (await api('agent/' + activity.activityId + '/conversation')).value;
      return value.runs.at(-1)?.state === 'completed' ? value : null;
    }, 'The incremental run did not complete.');
    const assistants = completed.messages.filter(message => message.role === 'assistant');
    assert.equal(assistants.length, 1, 'progress and the final answer share one message identity');
    assert.equal(assistants[0].eventId, streaming.eventId, 'the final answer replaces the streaming message in place');
    assert.equal(assistants[0].text, first + second);
    assert.equal(assistants[0].state, 'settled');
    const events = (await api('agent/' + activity.activityId + '/events')).value;
    const progress = events.filter(event => event.kind === 'assistant-progress');
    assert.ok(progress.length > 0);
    assert.deepEqual(progress.map(event => event.body.revision), progress.map((_, index) => index + 1));
    const reconstructed = progress.map(event => event.body.delta).join('');
    assert.ok((first + second).startsWith(reconstructed), 'stored deltas reconstruct a prefix of the answer');
    assert.ok(progress.every(event => event.seq < events.find(item => item.kind === 'assistant').seq),
      'the settled answer follows every increment');
    assert.ok(!JSON.stringify(events).includes('synthetic-progress-key'));
  } catch (error) { failure = error; }
  finally {
    try { await runtime.stop(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
  if (failure) throw failure;
});
