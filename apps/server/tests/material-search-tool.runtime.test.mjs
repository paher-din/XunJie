import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime } from '@xunjie/product-runtime';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

async function until(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(description);
}
function chat(response, { text = '', call, finish = call ? 'tool_calls' : 'stop' }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = { role: 'assistant', content: text, ...(call ? { tool_calls: [{ index: 0, id: call.id,
    type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : {}) };
  for (const value of [
    { id: 'fixture-wp08-219', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'fixture-wp08-219', choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(value) + '\n\n');
  response.end('data: [DONE]\n\n');
}

test('Agent searches fixed personal notes and reads explicit student facts through real tool records', { timeout: 180000 }, async () => {
  const payloads = [];
  const noteText = '我的电路笔记\n\n串联电路电流处处相等；请优先用节点法。';
  const noteIndex = noteText.indexOf('节点法');
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    payloads.push(payload);
    const index = payloads.length;
    if (index === 1) chat(response, { call: { id: 'search-personal', name: 'search_materials',
      arguments: { query: '节点法', scope: { courseMaterials: true, personalMaterialIds: [materialId], skillAttachments: true } } } });
    else if (index === 2) {
      const result = payload.messages.find(message => message.role === 'tool');
      assert.equal(result?.tool_call_id, 'search-personal');
      assert.match(result.content, /节点法/);
      assert.match(result.content, /电路笔记\.md/);
      assert.match(result.content, /stored-text/);
      const observed = JSON.parse(result.content);
      assert.equal(observed.search.matches[0].source.label, '电路笔记.md');
      assert.equal(observed.search.matches[0].source.kind, 'personal-material');
      assert.ok(observed.search.sources.some(source => source.state === 'searched' && source.source.label === '电路笔记.md'));
      assert.equal(observed.search.coverage.searchedSourceCount >= 1, true);
      chat(response, { call: { id: 'read-note', name: 'read_personal_material',
        arguments: { materialId, version: 1, start: noteIndex, length: 3 } } });
    } else if (index === 3) {
      const result = payload.messages.find(message => message.role === 'tool' && message.tool_call_id === 'read-note');
      assert.match(result.content, /节点法/);
      assert.match(result.content, /stored-text-range/);
      chat(response, { call: { id: 'read-facts', name: 'read_student_facts', arguments: { query: null, scope: 'eligible' } } });
    } else {
      const result = payload.messages.find(message => message.role === 'tool' && message.tool_call_id === 'read-facts');
      assert.match(result.content, /先画图再写公式/);
      assert.match(result.content, /unreviewed/);
      chat(response, { text: '已按你的明确偏好先画图，并引用个人笔记中的串联电路说明。' });
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-wp08-219-tools-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  let materialId;
  try {
    await runtime.install({ profile: 'local' });
    let endpoint = (await runtime.start()).endpoint;
    const api = async (route, body) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), { headers: {
        'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value = await response.json();
      assert.equal(response.status, 200, route + ': ' + JSON.stringify(value)); return value;
    };
    const connectionId = randomUUID(), grantId = randomUUID();
    await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '工具检索真实模型',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions',
      modelId: 'fixture-wp08-219', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-wp08-219-key' } });
    await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
    await api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
    const activity = await api('activities', { requestId: randomUUID(), goal: '按我的笔记和偏好解释电路', question: '', references: [] });
    const text = noteText;
    materialId = randomUUID();
    const material = await api(`materials/${activity.activityId}`, { requestId: randomUUID(), materialId,
      name: '电路笔记.md', mediaType: 'text/markdown', dataBase64: Buffer.from(text, 'utf8').toString('base64') });
    const range = { kind: 'text', start: text.indexOf('串联电路'), end: text.indexOf('串联电路') + 5 };
    const reference = { referenceId: randomUUID(), source: { kind: 'personal-material', activityId: activity.activityId,
      materialId, version: 1, sha256: material.versions[0].sha256 }, range, copy: text.slice(range.start, range.end), sourceName: '电路笔记.md' };
    const draft = await api(`drafts/${activity.activityId}`);
    const savedDraft = await api(`drafts/${activity.activityId}`, { requestId: randomUUID(), draftId: draft.draftId,
      baseRevision: 0, question: '请记住：我喜欢先画图再写公式。', references: [reference], bases: [] });
    const receiver = (await api(`agent/${activity.activityId}/capabilities`)).receiver;
    const input = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
      principalId: activity.identity.principalId, activityId: activity.activityId }, receiver,
      draft: { token: randomUUID(), question: savedDraft.question, references: [reference], bases: [] }, works: [], evidence: [] };
    const intent = await api(`intents/${activity.activityId}`, input);
    const dispatched = await api(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
    assert.equal(dispatched.state, 'accepted');
    const runId = JSON.parse(dispatched.receipt.detail).runId;
    let conversation;
    try {
      conversation = await until(async () => {
        const value = await api(`agent/${activity.activityId}/conversation`);
        const run = value.runs.find(item => item.runId === runId);
        if (run && ['failed', 'paused', 'stopped'].includes(run.state))
          throw new Error('Run did not complete: ' + JSON.stringify(value) + '\n' + await readFile(join(root, 'logs', 'runtime.log'), 'utf8'));
        return run?.state === 'completed' ? value : null;
      }, 'The Agent did not complete search and facts tools.');
    } catch (error) {
      const value = await api(`agent/${activity.activityId}/conversation`);
      throw new Error(error.message + '\nNOW ' + JSON.stringify(value) + '\nPAYLOADS ' + payloads.length);
    }
    assert.equal(payloads.length, 4);
    assert.ok(payloads[0].tools.some(tool => tool.function.name === 'search_materials'));
    assert.ok(payloads[0].tools.some(tool => tool.function.name === 'read_personal_material'));
    assert.ok(payloads[0].tools.some(tool => tool.function.name === 'read_student_facts'));
    assert.equal(conversation.tools.length, 3);
    assert.deepEqual(conversation.tools.map(item => item.outcome), ['completed', 'completed', 'completed']);
    const search = conversation.tools.find(item => item.name === 'search_materials');
    assert.equal(search.result.search.matches[0].source.kind, 'personal-material');
    assert.equal(search.result.search.matches[0].source.label, '电路笔记.md');
    assert.equal(search.result.search.matches[0].locator.start, noteIndex);
    const note = conversation.tools.find(item => item.name === 'read_personal_material');
    assert.equal(note.result.name, '电路笔记.md');
    assert.equal(note.result.text, '节点法');
    assert.equal(note.result.readMethod, 'stored-text-range');
    const facts = conversation.tools.find(item => item.name === 'read_student_facts');
    assert.ok(facts.result.facts.some(fact => fact.statement.includes('先画图再写公式')));
    assert.equal(facts.result.facts[0].reviewStatus, 'unreviewed');
    assert.ok(facts.result.facts[0].source.eventId);
    const payloadsBeforeRestart = payloads.length;
    await runtime.stop();
    endpoint = (await runtime.start()).endpoint;
    assert.deepEqual(await api(`agent/${activity.activityId}/conversation`), conversation,
      'Restart re-reads the retained tool records and search/fact selection without rewriting them.');
    assert.equal(payloads.length, payloadsBeforeRestart, 'Restart must not search again or call the model.');
  } finally {
    await runtime.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    if (process.env.XJ_KEEP) console.error('KEPT ROOT', root);
    else await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
