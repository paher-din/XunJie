import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createAgentRuntime, agentRuntimeMigrations } from '@xunjie/agent-runtime';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { createConversationPipeline } from '../src/conversation/index.ts';
import { StorageError } from '@xunjie/storage';
import { createUserQuestions } from '@xunjie/agents/capabilities/user-questions/index';
import { createSkillTools } from '@xunjie/agents/capabilities/skills';
import { createToolDiscovery } from '../src/capabilities/tool-discovery/index.ts';
import { skillFixture, packageInput } from '../../learning-space/test/support/session-skills.mjs';

function answer(response, protocol, { text = '', calls = [] }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
  if (protocol === 'chat-completions') {
    send({ id: 'discovery-chat', choices: [{ index: 0, delta: { role: 'assistant', content: text,
      ...(calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
    send({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
    response.end('data: [DONE]\n\n');
  } else if (protocol === 'responses') {
    const output = calls.map(call => ({ id: 'item-' + call.id, type: 'function_call', call_id: call.id, name: call.name,
      arguments: JSON.stringify(call.arguments), status: 'completed' }));
    if (text) output.push({ id: 'visible', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
    send({ type: 'response.completed', response: { id: 'discovery-responses', object: 'response', status: 'completed', output,
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } }); response.end();
  } else {
    const emit = value => response.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n');
    emit({ type: 'message_start', message: { id: 'discovery-messages', type: 'message', role: 'assistant', model: 'fixture', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    let index = 0;
    if (text) { emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }); emit({ type: 'content_block_stop', index }); index++; }
    for (const call of calls) { emit({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
      emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } });
      emit({ type: 'content_block_stop', index }); index++; }
    emit({ type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
    emit({ type: 'message_stop' }); response.end();
  }
}
const call = (name, args = {}, id = name) => ({ id, name, arguments: args });
function feedback(payload, protocol) {
  if (protocol === 'chat-completions') return payload.messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
  if (protocol === 'responses') return payload.input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
  return payload.messages.flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === 'tool_result').map(part => JSON.parse(typeof part.content === 'string' ? part.content : part.content.map(value => value.text ?? '').join(''))) : []);
}
const toolNames = (payload, protocol) => (payload.tools ?? []).map(tool => protocol === 'chat-completions' ? tool.function.name : tool.name);

async function fixture(t, protocol = 'chat-completions', options = {}) {
  const f = await skillFixture(t), payloads = [], failures = [];
  let runtime, models, handler = () => ({ text: '完成' }), installOptions;
  const upstream = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks)); payloads.push(payload);
      answer(response, protocol, await handler(payload, payloads.length));
    } catch (error) { failures.push(error); response.destroy(error); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  f.beforeClose(async () => { await runtime?.close(); models?.closeWrites(); await models?.checks.drain();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  models = await createModelGateway(await f.open('models', modelMigrations), { authorize: f.host.authorize, holder: 'device',
    authorizePermit: (who, permit) => runtime.assertDispatch(who, permit) });
  const connectionId = randomUUID();
  await models.save(f.identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '发现真实技能模块', protocol,
    baseUrl: `http://127.0.0.1:${upstream.address().port}/${protocol === 'messages' ? 'anthropic' : 'v1'}`,
    path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions',
    modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 2048,
    credential: { action: 'replace', value: 'synthetic-discovery-key' } });
  await models.selection.save(f.identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, owner: 'self' } });
  const coreStorage = await f.open('core', agentRuntimeMigrations);
  const install = (modules = [createSkillTools({ owner: f.target, skills: f.skills })], extra = {}) => {
    installOptions = { modules, ...extra };
    const base = createToolDiscovery(installOptions), discovery = installOptions.decorate ? installOptions.decorate(base) : base;
    runtime = createAgentRuntime(coreStorage, { authorize: f.host.authorize, pipeline: createConversationPipeline({ models, tools: [discovery],
      scenario: { id: 'student-assistant', version: 1, context: async () => ({ system: '从获准工具目录按需发现和加载。', facts: {}, sources: [] }) } }) });
    return discovery;
  };
  let discovery = install(options.modules, options);
  const sessionId = f.session.sessionId;
  await runtime.initialize({ sessionId, identity: f.identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
  return { ...f, models, payloads, failures, sessionId, get runtime() { return runtime; }, get discovery() { return discovery; },
    handle(value) { handler = value; }, async input(text = '按 sorting 技能核对原观察') {
      return runtime.accept(f.identity, { requestId: randomUUID(), sessionId, text });
    }, async advance(runId) { for (let n = 0; n < 12; n++) { const result = await runtime.advance(runId); if (!result?.pending) return result; } throw Error('Run did not yield'); },
    async context(runId) { const snapshot = await runtime.snapshot(f.identity, sessionId, runId); return { snapshot, context: { system: '', facts: {}, sources: [] }, inputIds: [snapshot.run.inputId] }; },
    async reopen(extra = {}) { await runtime.close(); discovery = install(extra.modules ?? installOptions.modules, { ...installOptions, ...extra }); } };
}

for (const protocol of ['chat-completions', 'responses', 'messages']) test(protocol + ': discovery loads the real Skill module only after its native pair settles and resumes the fixed original command', { timeout: 60000 }, async t => {
  const f = await fixture(t, protocol), input = packageInput('sorting'), imported = await f.skills.import(f.identity, input);
  let selected, activeRunId, pairChecks = 0;
  const settle = f.models.segments.settle;
  f.models.segments.settle = async (...args) => {
    const loading = args[2].results.some(result => result.callId === 'load_tools');
    if (loading) assert.ok(!(await f.discovery.list(await f.context(activeRunId))).some(offer => offer.definition.name === 'skill_load'));
    const result = await settle(...args);
    if (loading) { pairChecks++;
      assert.ok(!(await f.discovery.list(await f.context(activeRunId))).some(offer => offer.definition.name === 'skill_load'),
        'Even the native owner commit is not a published core settlement yet');
    }
    return result;
  };
  f.handle(async (payload, n) => {
    const names = toolNames(payload, protocol);
    if (n === 1) { assert.deepEqual(names.sort(), ['discover_tools', 'load_tools']); return { calls: [call('discover_tools', { purpose: 'skill_load' })] }; }
    if (n === 2) { const page = feedback(payload, protocol).at(-1); assert.equal(page.entries?.length, 1, JSON.stringify(page)); selected = page.entries[0];
      assert.equal(selected.moduleId, 'skills'); assert.equal(selected.moduleVersion, 1); assert.ok(!names.includes('skill_load'));
      return { calls: [call('load_tools', { bindingIds: [selected.bindingId] })] }; }
    if (n === 3) { assert.ok(names.includes('skill_load'));
      return { calls: [call('skill_load', { skillId: imported.skillId, version: 1 }, 'real-fixed-skill')] }; }
    assert.equal(n, 4); assert.equal(feedback(payload, protocol).at(-1).content, input.files[0].content);
    return { text: '已从固定原文读取，不执行 scripts。' };
  });
  const receipt = await f.input(); activeRunId = receipt.runId; await f.advance(receipt.runId);
  assert.equal(pairChecks, 1); assert.deepEqual(f.failures, []);
  const ctx = await f.context(receipt.runId);
  assert.equal(ctx.snapshot.run.state, 'completed', ctx.snapshot.run.reason);
  const tools = ctx.snapshot.steps.filter(step => step.operation.kind === 'tool.call');
  assert.deepEqual(tools.map(step => step.result.value.outcome.state), ['completed', 'completed', 'completed']);
  assert.equal(tools[2].result.value.outcome.result.loaded.content, input.files[0].content);
  assert.equal(f.payloads.length, 4);
  const load = tools[1], beforePair = structuredClone(ctx);
  beforePair.snapshot.steps = beforePair.snapshot.steps.filter(step => step.number <= load.number);
  beforePair.snapshot.sessionState.effects = [];
  assert.ok(!(await f.discovery.list(beforePair)).some(offer => offer.definition.name === 'skill_load'));
  await f.reopen(); await f.advance(receipt.runId); assert.equal(f.payloads.length, 4);
});

const catalogModule = (count, moduleId = 'catalog-notes') => ({ id: moduleId, version: 1,
  async list() { return Array.from({ length: count }, (_, index) => ({ definition: { name: 'note_' + index, description: '"'.repeat(1000),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, effect: 'read', scope: { sourceId: 'course:notes', objectId: 'note-' + index, sourceVersion: 1 } })); },
  async prepare() { throw Error('This test must never invoke a hidden note'); }, async dispatch() { throw Error('Discovery is not execution'); }, async reconcile() { return null; } });
const control = async (module, ctx, name, args) => {
  const offer = (await module.list(ctx)).find(item => item.definition.name === name), commandId = randomUUID();
  const command = await module.prepare(ctx, offer, { callId: name + '-' + commandId, name, arguments: args }, commandId);
  return { command, outcome: await module.dispatch(ctx, command, { sessionId: ctx.snapshot.session.sessionId,
    runId: ctx.snapshot.run.runId, operationId: commandId }, async () => {}) };
};

test('versioned discovery pages have deterministic byte-bounded receipts and an unforgeable eight-page ceiling', { timeout: 60000 }, async t => {
  const source = catalogModule(80, 'opaque:' + String.fromCharCode(1).repeat(193));
  const f = await fixture(t, 'chat-completions', { modules: [source] }), receipt = await f.input(), ctx = await f.context(receipt.runId);
  const module = f.discovery, query = { pageSize: 8 };
  const first = (await control(module, ctx, 'discover_tools', query)).outcome;
  assert.equal(first.state, 'completed'); assert.ok(first.result.entries.length < 8, 'Escaped metadata must reduce the page without truncating IDs');
  assert.ok(Buffer.byteLength(first.feedback.text) <= 8192); assert.deepEqual(JSON.parse(first.feedback.text), first.result);
  const repeated = (await control(module, ctx, 'discover_tools', query)).outcome;
  assert.deepEqual(repeated.result.entries, first.result.entries); assert.equal(repeated.result.nextCursor, first.result.nextCursor);
  let page = first.result;
  for (let n = 2; n <= 8; n++) {
    page = (await control(module, ctx, 'discover_tools', { ...query, cursor: page.nextCursor })).outcome.result;
    assert.equal(page.page, n); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
  }
  assert.equal(page.limitReached, true); assert.equal(page.hasMore, true); assert.equal(page.nextCursor, null);
  const forged = JSON.parse(Buffer.from(first.result.nextCursor, 'base64url'));
  for (const value of [{ ...forged, page: 0 }, { ...forged, offset: forged.offset + 1 }, { ...forged, page: 8 }]) {
    const outcome = (await control(module, ctx, 'discover_tools', { ...query, cursor: Buffer.from(JSON.stringify(value)).toString('base64url') })).outcome;
    assert.equal(outcome.state, 'failed'); assert.equal(outcome.result.reason, 'invalid');
  }
  source.version = 2;
  const changed = (await control(module, ctx, 'discover_tools', { ...query, cursor: first.result.nextCursor })).outcome;
  assert.equal(changed.result.reason, 'identity-conflict');
  const malformed = (await control(module, ctx, 'discover_tools', { cursor: 'not-a-json-cursor' })).outcome;
  assert.equal(malformed.result.reason, 'invalid');
  await assert.rejects(control(module, ctx, 'load_tools', { bindingIds: [first.result.entries[0].bindingId] }), { code: 'forbidden' }, 'An unsettled returned page is not a core receipt');
});

for (const protocol of ['chat-completions', 'responses', 'messages']) test(protocol + ': discovery in the same native batch cannot authorize load or execution', { timeout: 60000 }, async t => {
  const f = await fixture(t, protocol), receipt = await f.input(), ctx = await f.context(receipt.runId);
  const page = (await control(f.discovery, ctx, 'discover_tools', { purpose: 'skill_load' })).outcome.result;
  const bindingId = page.entries[0].bindingId;
  f.handle((_payload, n) => n === 1 ? { calls: [call('discover_tools', { purpose: 'skill_load' }, 'new-page'),
    call('load_tools', { bindingIds: [bindingId] }, 'not-yet-discovered')] } : { text: '需要先完成发现再加载。' });
  await f.advance(receipt.runId);
  assert.deepEqual(f.failures, []);
  const context = await f.context(receipt.runId), outcomes = context.snapshot.steps.filter(step => step.operation.kind === 'tool.call').map(step => step.result.value.outcome);
  assert.deepEqual(outcomes.map(outcome => outcome.state), ['completed', 'not-dispatched']);
  assert.ok(!(await f.discovery.list(context)).some(offer => offer.definition.name === 'skill_load'));
  assert.equal((await f.skills.resolveSession(f.identity, f.sessionId)).loaded.length, 0);
});

for (const protocol of ['chat-completions', 'responses', 'messages']) test(protocol + ': revocation while the model is generating rejects the fixed tool rather than reading a same-name replacement', { timeout: 60000 }, async t => {
  const f = await fixture(t, protocol), input = packageInput('sorting'), imported = await f.skills.import(f.identity, input);
  let bindingId, removed = false;
  f.handle(async (payload, n) => {
    if (n === 1) return { calls: [call('discover_tools', { purpose: 'skill_load' })] };
    if (n === 2) { bindingId = feedback(payload, protocol).at(-1).entries[0].bindingId; return { calls: [call('load_tools', { bindingIds: [bindingId] })] }; }
    if (n === 3) {
      assert.ok(toolNames(payload, protocol).includes('skill_load'));
      await f.skills.remove(f.identity, { requestId: randomUUID(), skillId: imported.skillId }); removed = true;
      await f.skills.import(f.identity, packageInput('sorting', { source: 'local:replacement' }));
      return { calls: [call('skill_load', { skillId: imported.skillId, version: 1 }, 'revoked-original')] };
    }
    assert.equal(n, 4); assert.ok(!toolNames(payload, protocol).includes('skill_load'));
    return { text: '原固定来源已撤销，未替换或读取新来源。' };
  });
  const receipt = await f.input(); await f.advance(receipt.runId);
  assert.equal(removed, true); assert.deepEqual(f.failures, []);
  const ctx = await f.context(receipt.runId), step = ctx.snapshot.steps.filter(step => step.operation.kind === 'tool.call').at(-1);
  assert.equal(step.result.value.outcome.state, 'not-dispatched');
  assert.equal((await f.skills.resolveSession(f.identity, f.sessionId)).loaded.length, 0);
  assert.doesNotMatch(JSON.stringify(f.payloads), /Original sorting body/);
  await f.reopen(); await f.advance(receipt.runId); assert.equal(f.payloads.length, 4);
});

for (const changedCode of [false, true]) test('lost owner reply recovers only the original module command after reopen; changed module code=' + changedCode, { timeout: 60000 }, async t => {
  let lose = true, blocked = false, reads = 0, replacementDispatches = 0;
  const decorate = base => ({ ...base, async dispatch(ctx, command, permit, guard) {
    const result = await base.dispatch(ctx, command, permit, guard);
    if (command.input.kind === 'delegate' && lose) { lose = false; blocked = true; throw new StorageError('unavailable'); }
    return result;
  }, async reconcile(ctx, command) { return blocked && command.input.kind === 'delegate' ? null : base.reconcile(ctx, command); } });
  const f = await fixture(t, 'chat-completions', { decorate }), originalLoad = f.skills.loadSession;
  f.skills.loadSession = async (...args) => { reads++; return originalLoad(...args); };
  const original = packageInput('sorting'), imported = await f.skills.import(f.identity, original);
  f.handle((payload, n) => n === 1 ? { calls: [call('discover_tools', { purpose: 'skill_load' })] }
    : n === 2 ? { calls: [call('load_tools', { bindingIds: [feedback(payload, 'chat-completions').at(-1).entries[0].bindingId] })] }
    : n === 3 ? { calls: [call('skill_load', { skillId: imported.skillId, version: 1 }, 'fixed-read')] }
    : { text: '保留原操作结果。' });
  const receipt = await f.input(); await f.advance(receipt.runId);
  const before = await f.context(receipt.runId), unknown = before.snapshot.steps.find(step => step.operation.kind === 'tool.call' && step.operation.input.command.input.kind === 'delegate');
  assert.equal(before.snapshot.run.reason, 'result-unknown'); assert.equal(reads, 1); assert.equal(f.payloads.length, 3);
  blocked = false;
  if (changedCode) {
    const next = { ...createSkillTools({ owner: f.target, skills: f.skills }), version: 2,
      async dispatch() { replacementDispatches++; throw Error('No same-name fallback'); } };
    await f.reopen({ modules: [next] });
  } else await f.reopen();
  await f.runtime.continueRun(f.identity, f.sessionId, receipt.runId, randomUUID()); await f.advance(receipt.runId);
  const after = await f.context(receipt.runId), recovered = after.snapshot.steps.find(step => step.stepId === unknown.stepId);
  assert.equal(after.snapshot.run.state, 'completed', after.snapshot.run.reason);
  assert.equal(recovered.operation.operationId, unknown.operation.operationId);
  if (changedCode) { assert.equal(recovered.result.value.outcome.state, 'failed'); assert.equal(recovered.result.value.outcome.result.reason, 'incompatible'); }
  else { assert.equal(recovered.result.value.outcome.result.loaded.content, original.files[0].content);
    assert.equal(recovered.operation.input.command.input.binding.moduleId, 'skills'); }
  assert.equal(reads, 1); assert.equal(replacementDispatches, 0); assert.equal(f.payloads.length, 4);
  assert.deepEqual(f.failures, []);
});

test('initially visible user-question module retains explicit response validation through discovery composition', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'chat-completions', { modules: [createUserQuestions()], initiallyVisible: binding => binding.moduleId === 'user-questions' });
  f.handle((payload, n) => {
    if (n === 1) { assert.ok(toolNames(payload, 'chat-completions').includes('student_ask')); return { calls: [call('student_ask', {
      question: '要继续核对原观察吗？', source: '当前明确问题', options: [{ id: 'yes', label: '继续' }], allowText: false, skippable: true,
    })] }; }
    return { text: '收到了对应问题的明确回应。' };
  });
  const receipt = await f.input(); await f.advance(receipt.runId);
  const before = await f.context(receipt.runId), wait = before.snapshot.waits[0];
  assert.equal(before.snapshot.run.state, 'waiting'); assert.equal(wait.presentation.toolDiscovery.moduleId, 'user-questions');
  await assert.rejects(f.runtime.respond(f.identity, f.sessionId, { requestId: randomUUID(), waitId: wait.waitId, expectedVersion: wait.version,
    answer: { kind: 'choice', optionId: 'forged' } }), { code: 'invalid' });
  const response = { requestId: randomUUID(), waitId: wait.waitId, expectedVersion: wait.version, answer: { kind: 'choice', optionId: 'yes' } };
  await f.runtime.respond(f.identity, f.sessionId, response); await f.advance(receipt.runId);
  assert.equal((await f.context(receipt.runId)).snapshot.run.state, 'completed');
  assert.deepEqual(f.failures, []); assert.equal(f.payloads.length, 2);
});

test('load admissions share a 32-binding ceiling and a failed thirty-third selection never becomes visible', { timeout: 60000 }, async t => {
  const base = catalogModule(40), source = { ...base, async list(ctx) { return (await base.list(ctx)).map(item => ({ ...item,
    definition: { ...item.definition, description: '固定来源目录项' } })); } };
  const f = await fixture(t, 'chat-completions', { modules: [source] }), entries = [];
  f.handle((payload, n) => {
    if (n === 1) return { calls: [call('discover_tools', { pageSize: 8 }, 'page-1')] };
    const prior = feedback(payload, 'chat-completions').at(-1);
    if (n <= 6) {
      entries.push(...prior.entries);
      if (n < 6) return { calls: [call('discover_tools', { pageSize: 8, cursor: prior.nextCursor }, 'page-' + n)] };
    }
    if (n >= 6 && n <= 9) {
      const offset = (n - 6) * 8;
      return { calls: [call('load_tools', { bindingIds: entries.slice(offset, offset + 8).map(item => item.bindingId) }, 'load-' + n)] };
    }
    if (n === 10) { assert.equal(toolNames(payload, 'chat-completions').length, 34); return { calls: [call('load_tools', { bindingIds: [entries[32].bindingId] }, 'over-limit')] }; }
    assert.equal(n, 11); assert.ok(!toolNames(payload, 'chat-completions').includes(entries[32].modelName));
    return { text: '保留32项固定选择，未加载超限项。' };
  });
  const receipt = await f.input(); await f.advance(receipt.runId);
  const ctx = await f.context(receipt.runId);
  assert.deepEqual(f.failures, []); assert.equal(ctx.snapshot.run.state, 'completed', ctx.snapshot.run.reason);
  assert.equal((await f.discovery.list(ctx)).length, 34);
  const rejected = ctx.snapshot.steps.filter(step => step.operation.kind === 'tool.call').at(-1);
  assert.equal(rejected.result.value.outcome.state, 'not-dispatched'); assert.equal(rejected.result.value.outcome.result.reason, 'invalid');
});

test('a same-name binding in another installed module keeps its own schema and fixed executor', { timeout: 60000 }, async t => {
  const called = [], module = (id, value) => ({ id, version: 1,
    list: async () => [{ definition: { name: 'read_same_name', description: id, inputSchema: { type: 'object', properties: { value: { const: value } }, required: ['value'], additionalProperties: false } }, effect: 'read', scope: { sourceId: id, fixedVersion: 1 } }],
    prepare: async (_ctx, offer, intent, commandId) => ({ commandId, name: offer.definition.name, effect: offer.effect, input: intent.arguments }),
    async dispatch(_ctx, command, _permit, guard) { await guard(); called.push(id); return { state: 'completed', feedback: { outcome: 'success', text: JSON.stringify({ value: command.input.value }), images: [] }, result: { value: command.input.value } }; },
    reconcile: async () => null });
  const f = await fixture(t, 'chat-completions', { modules: [module('owner-a', 'A'), module('owner-b', 'B')] });
  let selected;
  f.handle((payload, n) => {
    if (n === 1) return { calls: [call('discover_tools', { source: 'owner-b' })] };
    if (n === 2) { selected = feedback(payload, 'chat-completions').at(-1).entries[0]; assert.equal(selected.moduleId, 'owner-b');
      return { calls: [call('load_tools', { bindingIds: [selected.bindingId] })] }; }
    if (n === 3) { assert.ok(selected.modelName.startsWith('read_same_name_')); return { calls: [call(selected.modelName, { value: 'B' }, 'fixed-owner-b')] }; }
    assert.equal(n, 4); assert.deepEqual(feedback(payload, 'chat-completions').at(-1), { value: 'B' }); return { text: '仅调用原B来源。' };
  });
  const receipt = await f.input(); await f.advance(receipt.runId);
  assert.deepEqual(f.failures, []); assert.deepEqual(called, ['owner-b']);
  assert.equal((await f.context(receipt.runId)).snapshot.run.state, 'completed');
});

test('directory owner failure remains explicit instead of manufacturing an empty discovery receipt', { timeout: 60000 }, async t => {
  const owner = { ...catalogModule(1), async list() { throw new StorageError('unavailable'); } };
  const f = await fixture(t, 'chat-completions', { modules: [owner] }), receipt = await f.input(), ctx = await f.context(receipt.runId);
  await assert.rejects(f.discovery.list(ctx), { code: 'unavailable' });
  await assert.rejects(f.advance(receipt.runId), { code: 'unavailable' });
  assert.equal(f.payloads.length, 0);
  assert.equal(ctx.snapshot.steps.length, 0);
});

test('revocation at the delegated owner guard prevents the original read even after preparation succeeded', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = packageInput('sorting'), imported = await f.skills.import(f.identity, input);
  const original = createSkillTools({ owner: f.target, skills: f.skills }), load = f.skills.loadSession;
  let allowed = true, reads = 0;
  f.skills.loadSession = async (...args) => { reads++; return load(...args); };
  const guarded = { ...original, list: ctx => allowed ? original.list(ctx) : [], async dispatch(ctx, command, permit, assertDispatch) {
    await assertDispatch(); allowed = false; return original.dispatch(ctx, command, permit, assertDispatch);
  } };
  await f.reopen({ modules: [guarded], initiallyVisible: binding => binding.moduleId === 'skills' });
  f.handle((_payload, n) => n === 1 ? { calls: [call('skill_load', { skillId: imported.skillId, version: 1 })] } : { text: '来源已撤权，未读取。' });
  const receipt = await f.input(); await f.advance(receipt.runId);
  const ctx = await f.context(receipt.runId), tool = ctx.snapshot.steps.find(step => step.operation.kind === 'tool.call');
  assert.equal(tool.result.value.outcome.state, 'failed'); assert.equal(tool.result.value.outcome.result.reason, 'identity-conflict');
  assert.equal(reads, 0); assert.deepEqual(f.failures, []); assert.equal(ctx.snapshot.run.state, 'completed');
});

test('session effects without original module binding provenance cannot reload tools in a later Run', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  f.handle((payload, n) => n === 1 ? { calls: [call('discover_tools', { purpose: 'skill_load' })] }
    : n === 2 ? { calls: [call('load_tools', { bindingIds: [feedback(payload, 'chat-completions').at(-1).entries[0].bindingId] })] }
    : { text: '固定选择已结算。' });
  const first = await f.input(); await f.advance(first.runId);
  const completed = await f.context(first.runId);
  assert.ok((await f.discovery.list(completed)).some(offer => offer.definition.name === 'skill_load'));
  const next = await f.input('后续问题'), context = await f.context(next.runId);
  // Published generic effects without these fields are history only; a same-name result is never authority.
  for (const effect of context.snapshot.sessionState.effects) { delete effect.moduleId; delete effect.moduleVersion; delete effect.bindingId; }
  assert.ok(!(await f.discovery.list(context)).some(offer => offer.definition.name === 'skill_load'));
  assert.equal(context.snapshot.steps.length, 0); assert.deepEqual(f.failures, []);
});

test('a delegated owner commit with a lost reply reconciles its fixed receipt instead of reporting a failed effect', { timeout: 60000 }, async t => {
  const receipts = new Map(); let writes = 0;
  const owner = { id: 'write-owner', version: 1,
    list: async () => [{ definition: { name: 'save_original', description: '保存原操作', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, effect: 'write', scope: { sourceId: 'original-write-owner', sourceVersion: 1 } }],
    prepare: async (_ctx, offer, _intent, commandId) => ({ commandId, name: offer.definition.name, effect: offer.effect, input: {} }),
    async dispatch(_ctx, command, _permit, guard) { await guard(); writes++;
      receipts.set(command.commandId, { state: 'completed', feedback: { outcome: 'success', text: '原操作已保存', images: [] }, result: { commandId: command.commandId } });
      throw new StorageError('unavailable'); },
    reconcile: async (_ctx, command) => receipts.get(command.commandId) ?? null };
  const f = await fixture(t, 'chat-completions', { modules: [owner], initiallyVisible: () => true });
  f.handle((_payload, n) => n === 1 ? { calls: [call('save_original')] } : { text: '已核对原回执。' });
  const receipt = await f.input(); await f.advance(receipt.runId);
  const ctx = await f.context(receipt.runId), saved = ctx.snapshot.steps.find(step => step.operation.kind === 'tool.call');
  assert.equal(saved.result.value.outcome.state, 'completed'); assert.equal(writes, 1);
  assert.equal(saved.result.value.outcome.result.commandId, saved.operation.operationId);
  assert.equal(ctx.snapshot.run.state, 'completed'); assert.deepEqual(f.failures, []);
});

test('an unknown delegated write stays unknown when its original module version is absent, then recovers only after that version returns', { timeout: 60000 }, async t => {
  const receipts = new Map(); let writes = 0, readable = false, replacements = 0;
  const owner = { id: 'fixed-write-owner', version: 1,
    list: async () => [{ definition: { name: 'save_fixed', description: '保存固定来源', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, effect: 'write', scope: { sourceId: 'fixed-owner', sourceVersion: 1 } }],
    prepare: async (_ctx, offer, _intent, commandId) => ({ commandId, name: offer.definition.name, effect: offer.effect, input: {} }),
    async dispatch(_ctx, command, _permit, guard) { await guard(); writes++;
      receipts.set(command.commandId, { state: 'completed', feedback: { outcome: 'success', text: '原写入已确认', images: [] }, result: { commandId: command.commandId } });
      throw new StorageError('unavailable'); },
    reconcile: async (_ctx, command) => readable ? receipts.get(command.commandId) ?? null : null };
  const f = await fixture(t, 'chat-completions', { modules: [owner], initiallyVisible: () => true });
  f.handle((_payload, n) => n === 1 ? { calls: [call('save_fixed')] } : { text: '只保留原写入。' });
  const receipt = await f.input(); await f.advance(receipt.runId);
  let ctx = await f.context(receipt.runId);
  const original = ctx.snapshot.steps.find(step => step.operation.kind === 'tool.call');
  assert.equal(ctx.snapshot.run.reason, 'result-unknown'); assert.equal(writes, 1);
  readable = true;
  await f.reopen({ modules: [{ ...owner, version: 2, async dispatch() { replacements++; throw Error('Must not substitute a new executor'); } }] });
  await f.runtime.continueRun(f.identity, f.sessionId, receipt.runId, randomUUID()); await f.advance(receipt.runId);
  ctx = await f.context(receipt.runId);
  assert.equal(ctx.snapshot.run.reason, 'result-unknown'); assert.equal(f.payloads.length, 1);
  assert.equal(ctx.snapshot.steps.find(step => step.stepId === original.stepId).result.state, 'unknown');
  await f.reopen({ modules: [owner] });
  await f.runtime.continueRun(f.identity, f.sessionId, receipt.runId, randomUUID()); await f.advance(receipt.runId);
  ctx = await f.context(receipt.runId);
  assert.equal(ctx.snapshot.run.state, 'completed'); assert.equal(writes, 1); assert.equal(replacements, 0);
  assert.equal(ctx.snapshot.steps.find(step => step.stepId === original.stepId).result.value.outcome.result.commandId, original.operation.operationId);
  assert.deepEqual(f.failures, []);
});

test('bound session-effect facts retain cross-Run selection only with the original module, version and binding digest', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = packageInput('sorting'), imported = await f.skills.import(f.identity, input);
  f.handle((payload, n) => {
    if (n === 1) return { calls: [call('discover_tools', { purpose: 'skill_load' })] };
    if (n === 2) return { calls: [call('load_tools', { bindingIds: [feedback(payload, 'chat-completions').at(-1).entries[0].bindingId] })] };
    if (n === 4) {
      assert.ok(toolNames(payload, 'chat-completions').includes('skill_load'), 'the actual next Run keeps the settled selection');
      return { calls: [call('skill_load', { skillId: imported.skillId, version: imported.version })] };
    }
    return { text: '原选择已结算。' };
  });
  const received = await f.input(); await f.advance(received.runId);
  const first = await f.context(received.runId), next = await f.input('下一轮'), ctx = await f.context(next.runId);
  const bound = first.snapshot.sessionState.effects;
  assert.ok(bound.every(effect => effect.moduleId === 'tool-discovery' && effect.moduleVersion === 1 && typeof effect.bindingId === 'string'));
  assert.ok((await f.discovery.list(ctx)).some(offer => offer.definition.name === 'skill_load'));
  for (const change of [{ moduleId: 'different-module' }, { moduleVersion: 2 }, { bindingId: '0'.repeat(64) }, { resultDigest: '0'.repeat(64) }]) {
    ctx.snapshot.sessionState.effects = bound.map(effect => ({ ...effect, ...change }));
    assert.ok(!(await f.discovery.list(ctx)).some(offer => offer.definition.name === 'skill_load'));
  }
  assert.equal(ctx.snapshot.steps.length, 0);
  await f.reopen(); await f.runtime.continueRun(f.identity, f.sessionId, next.runId, randomUUID()); await f.advance(next.runId);
  const after = await f.context(next.runId);
  assert.equal(after.snapshot.run.state, 'completed'); assert.equal(f.payloads.length, 5);
  assert.equal(after.snapshot.steps.find(step => step.operation.kind === 'tool.call').result.value.outcome.result.loaded.content, input.files[0].content);
  assert.deepEqual(f.failures, []);
});
