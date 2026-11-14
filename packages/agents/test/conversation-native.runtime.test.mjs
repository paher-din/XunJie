import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { createAgentRuntime, agentRuntimeMigrations } from '../../agent-runtime/dist/index.js';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createConversationPipeline } from '../src/conversation/index.ts';
import { createUserQuestions } from '../src/capabilities/user-questions/index.ts';
import { createToolDiscovery } from '../src/capabilities/tool-discovery/index.ts';

const protocols = ['chat-completions', 'responses', 'messages'];
const tool = (name, args = {}, id = randomUUID()) => ({ name, args, id });
function answer(response, protocol, value) {
  const { text = '完成', tools = [], usage = { inputTokens: 7, outputTokens: 4 } } = value;
  const send = data => response.write('data: ' + JSON.stringify(data) + '\n\n');
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (protocol === 'chat-completions') {
    send({ id: 'native-chat', choices: [{ index: 0, delta: { role: 'assistant', content: text, reasoning_content: 'PRIVATE_PROVIDER_REASONING',
      ...(tools.length ? { tool_calls: tools.map((item, index) => ({ index, id: item.id, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } })) } : {}) }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: tools.length ? 'tool_calls' : 'stop' }] });
    send({ choices: [], usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens } });
    response.end('data: [DONE]\n\n');
  } else if (protocol === 'responses') {
    const output = tools.map(item => ({ id: 'item-' + item.id, type: 'function_call', call_id: item.id, name: item.name, arguments: JSON.stringify(item.args), status: 'completed' }));
    if (text) output.push({ id: 'visible', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
    send({ type: 'response.completed', response: { id: 'native-response', object: 'response', status: 'completed', output,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens } } }); response.end();
  } else {
    const emit = event => response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    emit({ type: 'message_start', message: { id: 'native-message', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: usage.inputTokens, output_tokens: 0 } } });
    let index = 0;
    if (tools.length) { emit({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: null } });
      emit({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'PRIVATE_PROVIDER_REASONING' } });
      emit({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'PRIVATE_PROVIDER_SIGNATURE' } }); emit({ type: 'content_block_stop', index }); index++; }
    if (text) { emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }); emit({ type: 'content_block_stop', index }); index++; }
    for (const item of tools) { emit({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: item.id, name: item.name, input: {} } });
      emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(item.args) } }); emit({ type: 'content_block_stop', index }); index++; }
    emit({ type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.outputTokens } });
    emit({ type: 'message_stop' }); response.end();
  }
}
async function fixture(protocol, run, settings = {}) {
  const pg = await nativeFixture(), owners = [], payloads = []; let models, runtime;
  let handler = async () => ({ text: '完成' });
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const activeProtocol = request.url.endsWith('/messages') ? 'messages' : request.url.endsWith('/responses') ? 'responses' : 'chat-completions';
    const payload = JSON.parse(Buffer.concat(chunks)); payloads.push({ payload, path: request.url, protocol: activeProtocol });
    try { const result = await handler(payload, payloads.length, response); if (result) answer(response, activeProtocol, result); }
    catch { response.destroy(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const identity = settings.identity ?? { kind: 'personal', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), name: '学生' };
    async function open(name, migrations) {
      const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: identity.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
      const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(pg.root, name) }) });
      owners.push(storage); return storage;
    }
    models = await createModelGateway(await open('models', modelMigrations), { holder: 'device', authorize: async () => {},
      authorizePermit: (who, permit) => runtime.assertDispatch(who, permit) });
    const connectionId = randomUUID();
    await models.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'Native fixture', protocol,
      baseUrl: `http://127.0.0.1:${upstream.address().port}/${protocol === 'messages' ? 'anthropic' : 'v1'}`,
      path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions', modelId: 'fixture', dialect: 'standard',
      parameterMode: 'plain', imageInput: settings.imageInput ?? false, contextWindow: settings.contextWindow ?? 262144, maxOutputTokens: settings.modelMaxOutputTokens ?? 2048,
      enabled: true, credential: { action: 'replace', value: 'synthetic-conversation-key' } });
    await models.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, owner: 'self' } });
    const storage = await open('agent', agentRuntimeMigrations);
    const scenario = { id: 'native-conversation', version: 1, context: async () => ({ system: '只按已授权事实回答。', facts: {}, sources: [{ id: 'rule', version: 1 }] }) };
    const options = { models, scenario, tools: [], ...settings };
    const start = () => { runtime = createAgentRuntime(storage, { authorize: async () => {}, pipeline: options.pipelineFactory ? options.pipelineFactory(options) : createConversationPipeline(options) }); };
    start();
    const sessionId = randomUUID();
    await runtime.initialize({ sessionId, identity, scenario: options.scenario.id, restartPolicy: 'explicit', createdAt: new Date().toISOString() });
    const h = { identity, sessionId, models, payloads, options, openOwner: open, modelRoot: join(pg.root, 'models'), async switchModel(next, maxOutputTokens = 2048, imageInput = settings.imageInput ?? false) {
      const id = randomUUID();
      await models.save(identity, { requestId: randomUUID(), connectionId: id, expectedVersion: 0, name: 'Switched model', protocol: next,
        baseUrl: `http://127.0.0.1:${upstream.address().port}/${next === 'messages' ? 'anthropic' : 'v1'}`, path: next === 'messages' ? '/v1/messages' : next === 'responses' ? '/responses' : '/chat/completions',
        modelId: 'switched', dialect: 'standard', parameterMode: 'plain', imageInput, contextWindow: 262144, maxOutputTokens, enabled: true, credential: { action: 'replace', value: 'synthetic-new-key' } });
      await models.selection.save(identity, { requestId: randomUUID(), expectedVersion: (await models.selection.read(identity)).version, source: { kind: 'personal', connectionId: id, owner: 'self' } });
    }, get runtime() { return runtime; },
      handle(value) { handler = value; }, async reopen() { await runtime.close(); start(); },
      async input(text = '开始') { return runtime.accept(identity, { sessionId, requestId: randomUUID(), text }); },
      async snapshot(runId) { return runtime.snapshot(identity, sessionId, runId); },
      async advance(runId) { for (let n = 0; n < 12; n++) { const result = await runtime.advance(runId); if (!result?.pending) return result; } throw Error('Run did not yield'); } };
    await run(h);
  } finally { await runtime?.close(); models?.closeWrites(); await models?.checks.drain();
    for (const storage of owners.reverse()) await storage.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await pg.close(); }
}
const question = label => ({ question: label, source: '当前学生输入', options: [{ id: 'yes', label: '确认' }], allowText: true, skippable: true });
test('retained large-result bytes cannot bypass a revoked source while its tool stays installed', { timeout: 60000 }, async () => {
  let allowed = true, proofReads = 0;
  const secret = 'REVOKED_SOURCE_TAIL_6f93';
  const original = { state: 'completed', feedback: { outcome: 'success', text: JSON.stringify({ text: '公开前缀'.repeat(3000) + secret }), images: [] },
    result: { text: '公开前缀'.repeat(3000) + secret } };
  const source = { id: 'source-owner', version: 1,
    async list() { return [{ definition: { name: 'read_source', description: 'Read one permitted source', inputSchema: { type: 'object', additionalProperties: false } }, effect: 'read', scope: {} }]; },
    async prepare(_context, offer, _intent, commandId) { return { commandId, name: offer.definition.name, effect: offer.effect, input: {} }; },
    async dispatch() { return original; },
    async reconcile() { proofReads++; if (!allowed) throw new StorageError('forbidden'); return original; } };
  await fixture('chat-completions', async h => {
    h.handle(async (payload, call) => {
      if (call === 1) return { text: '', tools: [tool('read_source', {}, 'read-permitted-source')] };
      if (call === 2) {
        const projection = payload.messages.filter(message => message.role === 'user').map(message => {
          try { const fact = JSON.parse(message.content); return fact.tool === 'read_source' ? JSON.parse(fact.text) : null; } catch { return null; }
        }).find(value => value?.original?.readTool === 'read_tool_result');
        assert.ok(projection, 'the model receives a real continuation handle from its settled original tool result');
        allowed = false;
        return { text: '', tools: [tool('read_tool_result', { commandId: projection.original.commandId, sha256: projection.original.sha256,
          offset: projection.original.byteLength - 64, limit: 64 }, 'read-revoked-tail')] };
      }
      return { text: '原来源已不可读取。' };
    });
    const input = await h.input('读取许可来源'); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'completed', snapshot.run.reason);
    assert.doesNotMatch(JSON.stringify(h.payloads), new RegExp(secret));
    assert.ok(proofReads > 0, 'the installed source owner must reauthorize the original version');
    const continuation = snapshot.steps.find(step => step.operation.kind === 'tool.call' && step.operation.input.command.name === 'read_tool_result');
    assert.equal(continuation.result.value.outcome.state, 'not-dispatched');
  }, { tools: [source] });
});
for (const protocol of protocols) test(protocol + ': every question wait survives reopen and blocks later effects until all explicit responses', { timeout: 60000 }, async () => {
  let effects = 0;
  const effect = { id: 'writes', version: 1, async list() { return [{ definition: { name: 'change', description: '', inputSchema: { type: 'object', additionalProperties: false } }, effect: 'write', scope: {} }]; },
    async prepare(_context, offer, _intent, commandId) { return { commandId, name: offer.definition.name, effect: offer.effect, input: {} }; },
    async dispatch(_context, _command, _permit, assertDispatch) { await assertDispatch(); effects++; return { state: 'completed', feedback: { outcome: 'success', text: 'changed', images: [] }, result: {} }; },
    async reconcile() { return null; } };
  await fixture(protocol, async h => {
    h.handle(async (_payload, n) => n === 1 ? { text: '', tools: [tool('student_ask', question('第一问'), 'ask-first'), tool('student_ask', question('第二问'), 'ask-second'), tool('change', {}, 'must-not-write')] } : { text: '收到两次明确回应。' });
    const input = await h.input(); await h.advance(input.runId);
    let snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'waiting'); assert.equal(effects, 0);
    assert.equal(snapshot.state.waitQueue.length, 2);
    assert.equal((await h.models.segments.read(h.identity, snapshot.sessionState.segment.segmentId)).pendingTools.length, 0);
    await h.reopen();
    let pending = snapshot.waits.find(wait => wait.state === 'pending');
    await h.runtime.respond(h.identity, h.sessionId, { requestId: randomUUID(), waitId: pending.waitId, expectedVersion: pending.version, answer: { kind: 'choice', optionId: 'yes' } });
    await h.advance(input.runId); snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'waiting'); assert.equal(h.payloads.length, 1);
    pending = snapshot.waits.find(wait => wait.state === 'pending');
    assert.equal(pending.presentation.question, '第二问');
    await h.runtime.respond(h.identity, h.sessionId, { requestId: randomUUID(), waitId: pending.waitId, expectedVersion: pending.version, answer: { kind: 'choice', optionId: 'yes' } });
    await h.advance(input.runId); snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'completed'); assert.equal(effects, 0); assert.equal(h.payloads.length, 2);
    assert.match(JSON.stringify(h.payloads[1].payload), /ask-first/); assert.match(JSON.stringify(h.payloads[1].payload), /ask-second/);
  }, { tools: [createUserQuestions(), effect] });
});

test('model and token budget basis persists across advances and owner reopen', { timeout: 60000 }, async () => {
  const read = { id: 'reads', version: 1, async list() { return [{ definition: { name: 'read', description: '', inputSchema: { type: 'object', additionalProperties: false } }, effect: 'read', scope: {} }]; },
    async prepare(_ctx, offer, _intent, commandId) { return { commandId, name: offer.definition.name, effect: offer.effect, input: {} }; },
    async dispatch() { return { state: 'completed', feedback: { outcome: 'success', text: '事实', images: [] }, result: {} }; }, async reconcile() { return null; } };
  await fixture('chat-completions', async h => {
    h.handle(async () => ({ text: '继续读取', tools: [tool('read')] }));
    const input = await h.input(); await h.advance(input.runId);
    let snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'paused'); assert.equal(snapshot.run.reason, 'model-step-budget-exhausted'); assert.equal(h.payloads.length, 2);
    assert.equal(snapshot.steps[0].snapshot.budgetBasis.maxModelSteps, 2);
    await h.reopen(); h.options.limits = { maxModelSteps: 16 };
    await h.runtime.continueRun(h.identity, h.sessionId, input.runId, randomUUID()); await h.advance(input.runId);
    snapshot = await h.snapshot(input.runId); assert.equal(snapshot.run.state, 'paused'); assert.equal(h.payloads.length, 2);
    assert.equal(snapshot.state.budget.modelSteps, 2); assert.equal(snapshot.state.budget.inputTokens, 14); assert.equal(snapshot.state.budget.outputTokens, 8);
  }, { tools: [read], limits: { maxModelSteps: 2 } });
});

for (const protocol of protocols) test(protocol + ': route and prefix transition closes original tools and carries authorized visible history only', { timeout: 60000 }, async () => {
  let h, effects = 0;
  const next = protocols[(protocols.indexOf(protocol) + 1) % protocols.length];
  const source = { id: 'facts', version: 1, async list() { return [{ definition: { name: 'fact', description: '', inputSchema: { type: 'object', additionalProperties: false } }, effect: 'read', scope: {} }]; },
    async prepare(_ctx, offer, _intent, commandId) { return { commandId, name: offer.definition.name, effect: offer.effect, input: {} }; },
    async dispatch() { effects++; await h.switchModel(next); return { state: 'completed', feedback: { outcome: 'success', text: 'AUTHORIZED_FACT_42', images: [] }, result: { value: 42 } }; }, async reconcile() { return null; } };
  await fixture(protocol, async value => {
    h = value;
    const originalClose = h.models.segments.close; let lost = false;
    h.models.segments.close = async (...args) => { const result = await originalClose(...args); if (!lost) { lost = true; throw new StorageError('unavailable'); } return result; };
    h.handle(async (_payload, n) => n === 1 ? { text: 'FIRST_VISIBLE_ANSWER', tools: [tool('fact', {}, 'foreign-native-call')] } : { text: '切换后根据历史回答。' });
    const input = await h.input('ORIGINAL_USER_INTENT'); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'completed'); assert.equal(effects, 1); assert.equal(h.payloads.length, 2); assert.equal(h.payloads[1].protocol, next);
    const portable = JSON.stringify(h.payloads[1].payload);
    assert.match(portable, /ORIGINAL_USER_INTENT/); assert.match(portable, /FIRST_VISIBLE_ANSWER/); assert.match(portable, /AUTHORIZED_FACT_42/);
    assert.doesNotMatch(portable, /PRIVATE_PROVIDER_REASONING|PRIVATE_PROVIDER_SIGNATURE|foreign-native-call/);
    const close = snapshot.steps.find(step => step.operation.kind === 'model.segment.close');
    assert.ok(close); assert.ok(snapshot.steps.findIndex(step => step.operation.kind === 'model.tools.settle') < snapshot.steps.indexOf(close));
    assert.equal((await h.models.segments.read(h.identity, close.operation.input.segmentId)).closed, true);
  }, { tools: [source] });
});

function compactionReply(payload) {
  const messages = payload.messages ?? payload.input ?? [];
  for (const message of [...messages].reverse()) {
    const text = typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('');
    try { const source = JSON.parse(text); if (source.sourceDigest && source.retainedDigest) return { text: JSON.stringify({ version: 1,
      sourceDigest: source.sourceDigest, retainedDigest: source.retainedDigest, retainedIds: source.retained.map(item => item.id),
      facts: [{ text: 'MEMORY_FACT', sources: [source.messages[0].eventId] }], inferences: [], contradictions: [], unknowns: [], unfinished: [] }) }; } catch {}
  }
  return null;
}
for (const protocol of protocols) test(protocol + ': compaction cannot reserve 512 input tokens from a Run with only 10 remaining', { timeout: 60000 }, async () => {
  await fixture(protocol, async h => {
    h.handle(async payload => compactionReply(payload) ?? { text: '保留原来源。'.repeat(40), tools: [tool('read')], usage: { inputTokens: 512, outputTokens: 4 } });
    const input = await h.input('读取原来源后继续解释。'); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.reason, 'input-budget-exhausted');
    assert.equal(snapshot.state.budget.inputTokens, 512); assert.equal(h.payloads.length, 1);
    assert.equal(snapshot.steps.some(step => step.operation.kind.startsWith('context.compaction.')), false,
      'insufficient reservation must block compaction before opening or closing any segment');
    assert.equal(snapshot.sessionState.activeCompaction, undefined);
    assert.match(JSON.stringify(snapshot.sessionState.history), /保留原来源/);
    const original = await h.models.segments.read(h.identity, snapshot.sessionState.segment.segmentId);
    assert.equal(original.closed, false); assert.equal(original.pendingTools.length, 0);
  }, { contextWindow: 512, modelMaxOutputTokens: 128, limits: { maxInputTokens: 522 },
    compaction: { policy: { triggerChars: 1 } }, tools: [installedTool('read', 'read', async () => ({ state: 'completed',
      feedback: { outcome: 'success', text: '原来源已读取。', images: [] }, result: { source: 'fixed-original' } }))] });
});

for (const boundary of ['open-dispatch', 'active-plan', 'call-dispatch'])
test('compaction rechecks the remaining 10-token budget at ' + boundary + ' and retains its original source', { timeout: 60000 }, async () => {
  // A composed planner can retain an earlier admission. Dispatch must inspect the actual current core snapshot.
  const advisory = snapshot => {
    const copy = structuredClone(snapshot);
    for (const step of copy.steps) if (step.snapshot.budgetBasis) step.snapshot.budgetBasis.maxInputTokens += 512;
    return copy;
  };
  let originalSource;
  await fixture('chat-completions', async h => {
    h.handle(async payload => compactionReply(payload) ?? { text: '不可丢弃的原来源。'.repeat(40), tools: [tool('read')], usage: { inputTokens: 512, outputTokens: 4 } });
    const input = await h.input('保留原来源并继续'); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.reason, 'input-budget-exhausted'); assert.equal(h.payloads.length, 1);
    const open = snapshot.steps.find(step => step.operation.kind === 'context.compaction.open');
    assert.ok(open); assert.deepEqual(open.snapshot.compaction, originalSource);
    if (boundary === 'open-dispatch') {
      assert.equal(open.result.value.preflightFailure, 'input-budget-exhausted');
      assert.equal(snapshot.sessionState.activeCompaction, undefined);
      assert.equal((await h.models.segments.read(h.identity, snapshot.sessionState.segment.segmentId)).closed, false);
      await assert.rejects(h.models.segments.read(h.identity, open.operation.input.input.segmentId), { code: 'missing' });
    } else {
      assert.deepEqual(snapshot.sessionState.activeCompaction.source, originalSource);
      assert.equal(snapshot.sessionState.activeCompaction.attemptId, open.snapshot.attemptId);
      const call = snapshot.steps.find(step => step.operation.kind === 'context.compaction.call');
      if (boundary === 'active-plan') assert.equal(call, undefined);
      else {
        assert.equal(call.operation.operationId, open.snapshot.attemptId);
        assert.equal(call.result.value.preflightFailure, 'input-budget-exhausted');
        await assert.rejects(h.models.checks.read(h.identity, call.operation.operationId), { code: 'missing' });
      }
    }
    assert.match(JSON.stringify(snapshot.sessionState.history), /不可丢弃的原来源/);
  }, { contextWindow: 512, modelMaxOutputTokens: 128, limits: { maxInputTokens: 522 }, compaction: { policy: { triggerChars: 1 } },
    tools: [installedTool('read', 'read', async () => ({ state: 'completed', feedback: { outcome: 'success', text: '固定来源', images: [] }, result: {} }))],
    pipelineFactory(options) {
      const pipeline = createConversationPipeline(options);
      return { ...pipeline,
        async plan(snapshot, ids) {
          let decision = await pipeline.plan(snapshot, ids);
          if (decision.kind === 'pause' && decision.reason === 'input-budget-exhausted'
            && !(boundary === 'active-plan' && snapshot.sessionState.activeCompaction)) {
            decision = await pipeline.plan(advisory(snapshot), ids);
            assert.equal(decision.kind, 'operation'); assert.match(decision.operation.kind, /^context\.compaction\./);
            decision.snapshot.budgetBasis = snapshot.steps.find(step => step.snapshot.budgetBasis).snapshot.budgetBasis;
          }
          if (decision.kind === 'operation' && decision.operation.kind === 'context.compaction.open') originalSource = structuredClone(decision.snapshot.compaction);
          return decision;
        },
        dispatch(snapshot, step, ...args) {
          return pipeline.dispatch(step.operation.kind === 'context.compaction.open' && boundary !== 'open-dispatch' ? advisory(snapshot) : snapshot, step, ...args);
        },
      };
    } });
});

for (const protocol of protocols) test(protocol + ': on-demand compaction adopts fixed source versions with the original native result', { timeout: 60000 }, async () => {
  await fixture(protocol, async h => {
    h.handle(async payload => compactionReply(payload) ?? { text: '历史可见回答。'.repeat(80) });
    let input = await h.input('OLD_USER_FACT'); await h.advance(input.runId);
    input = await h.input('FOLLOW_UP'); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'completed'); assert.equal(h.payloads.length, 3);
    const compaction = snapshot.steps.find(step => step.operation.kind === 'context.compaction.call');
    assert.ok(compaction); assert.equal(compaction.result.state, 'completed');
    assert.equal(snapshot.sessionState.compactionAdoption.attemptId, compaction.operation.operationId);
    assert.equal(snapshot.sessionState.compactionAdoption.sourceDigest, compaction.snapshot.compaction.sourceDigest);
    assert.match(JSON.stringify(h.payloads[2].payload), /MEMORY_FACT/); assert.match(JSON.stringify(h.payloads[2].payload), /FOLLOW_UP/);
    assert.doesNotMatch(JSON.stringify(h.payloads[2].payload), /PRIVATE_PROVIDER_REASONING/);
    const resultRef = compaction.result.value.attempt.resultRef;
    await h.reopen(); await h.advance(input.runId);
    assert.equal(h.payloads.length, 3); assert.equal((await h.snapshot(input.runId)).sessionState.compactionAdoption.resultRef, resultRef);
  }, { compaction: { policy: { triggerChars: 1 } } });
});

import { createStudentInputPolicy } from '../src/capabilities/input-policy/student.ts';
import { createHash } from 'node:crypto';
for (const protocol of protocols) test(protocol + ': optional student policy classifies only original user bytes before the primary answer', { timeout: 60000 }, async () => {
  await fixture(protocol, async h => {
    let classified;
    h.options.scenario.context = async snapshot => {
      assert.equal(snapshot.state.inputPolicies[Object.keys(snapshot.state.inputPolicies)[0]].creationAuthorization, 'request-learning');
      return { system: '回答学习问题。', facts: { retrieved: 'RETRIEVAL_MUST_NOT_AUTHORIZE_CREATE' }, sources: [] };
    };
    h.handle(async (payload, n) => {
      if (n !== 1) return { text: '可以先从当前概念开始。' };
      assert.doesNotMatch(JSON.stringify(payload), /RETRIEVAL_MUST_NOT_AUTHORIZE_CREATE/);
      assert.equal((payload.tools ?? []).length, 0);
      const messages = payload.messages ?? payload.input;
      const content = messages.at(-1).content;
      classified = JSON.parse(typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''));
      return { text: JSON.stringify({ inputDigest: classified.inputDigest, creationAuthorization: 'request-learning' }) };
    });
    const text = '我想学习递归，但还没有要求创建任何工作区。';
    const input = await h.input(text); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'completed'); assert.equal(h.payloads.length, 2);
    const record = snapshot.state.inputPolicies[input.inputId];
    assert.equal(record.inputDigest, createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));
    assert.equal(classified.text, text); assert.equal(record.inputId, input.inputId); assert.equal(record.version, 1);
    assert.equal(record.creationAuthorization, 'request-learning'); assert.ok(record.attemptId); assert.ok(record.resultRef);
    assert.equal(snapshot.state.budget.modelSteps, 2);
    await h.reopen(); await h.advance(input.runId); assert.equal(h.payloads.length, 2);
  }, { inputPolicy: createStudentInputPolicy() });
});

for (const protocol of protocols) test(protocol + ': stopping an in-flight original model operation cannot restart it or publish a late answer', { timeout: 60000 }, async () => {
  await fixture(protocol, async h => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    h.handle(async () => { started.resolve(); await release.promise; return { text: '不应在停止后发布' }; });
    const input = await h.input(); const advancing = h.advance(input.runId);
    await started.promise;
    await h.runtime.stop(h.identity, h.sessionId, input.runId, randomUUID()); release.resolve(); await advancing;
    await h.reopen(); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'stopped'); assert.equal(h.payloads.length, 1);
    assert.equal((await h.runtime.events(h.identity, h.sessionId)).some(event => event.kind === 'assistant'), false);
  });
});

test('safe model progress reaches core recordProgress with the original permit', { timeout: 60000 }, async () => {
  await fixture('chat-completions', async h => {
    const seen = [];
    h.options.progressPort = { async recordProgress(identity, permit, progress) { seen.push(permit); return h.runtime.recordProgress(identity, permit, progress); } };
    h.handle(async (_payload, _n, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'SAFE_PROGRESS_' + 'x'.repeat(400) }, finish_reason: null }] }) + '\n\n');
      await new Promise(resolve => setTimeout(resolve, 180));
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n'); response.end('data: [DONE]\n\n'); return null;
    });
    const input = await h.input(); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId), call = snapshot.steps.find(step => step.operation.kind === 'model.call');
    assert.ok(seen.length); assert.equal(seen[0].operationId, call.operation.operationId); assert.equal(seen[0].sessionId, h.sessionId);
    assert.ok((await h.runtime.events(h.identity, h.sessionId)).some(event => event.kind === 'model-progress' && event.body.text.startsWith('SAFE_PROGRESS_')));
  });
});

for (const protocol of protocols) test(protocol + ': a compaction result committed before worker interruption is adopted from its original attempt', { timeout: 60000 }, async () => {
  await fixture(protocol, async h => {
    let interrupted = false, summaryGenerated = false;
    const context = h.options.scenario.context;
    h.options.scenario.context = async snapshot => {
      if (!interrupted && summaryGenerated) { interrupted = true; throw Error('worker-interrupted-before-adoption'); }
      return context(snapshot);
    };
    h.handle(async payload => { const summary = compactionReply(payload); if (summary) summaryGenerated = true; return summary ?? { text: '可闭合的旧历史。'.repeat(50) }; });
    let input = await h.input('old'); await h.advance(input.runId);
    input = await h.input('new'); await assert.rejects(h.advance(input.runId), /worker-interrupted/);
    const before = await h.snapshot(input.runId), fixed = before.steps.find(step => step.operation.kind === 'context.compaction.call');
    assert.equal(h.payloads.length, 2); assert.equal((await h.models.checks.read(h.identity, fixed.operation.operationId)).state, 'completed');
    await h.reopen(); await h.runtime.continueRun(h.identity, h.sessionId, input.runId, randomUUID()); await h.advance(input.runId);
    const after = await h.snapshot(input.runId);
    assert.equal(after.run.state, 'completed'); assert.equal(h.payloads.length, 3);
    assert.equal(after.sessionState.compactionAdoption.attemptId, fixed.operation.operationId);
    assert.equal(after.steps.filter(step => step.operation.kind === 'context.compaction.call').length, 1);
  }, { compaction: { policy: { triggerChars: 1 } } });
});

import { rename, writeFile, unlink } from 'node:fs/promises';
for (const protocol of protocols) test(protocol + ': unknown compaction publication preserves its attempt and never generates a replacement', { timeout: 60000 }, async () => {
  await fixture(protocol, async h => {
    let restore = async () => {};
    h.handle(async payload => {
      const summary = compactionReply(payload); if (!summary) return { text: '旧资料。'.repeat(80) };
      const root = h.modelRoot, parked = root + '-held';
      await rename(root, parked); await writeFile(root, 'block only this fixture result backend');
      restore = async () => { await unlink(root); await rename(parked, root); };
      return summary;
    });
    try {
      let input = await h.input('old'); await h.advance(input.runId);
      input = await h.input('new'); await h.advance(input.runId); await restore(); restore = async () => {};
      const before = await h.snapshot(input.runId), fixed = before.steps.find(step => step.operation.kind === 'context.compaction.call');
      assert.equal(before.run.state, 'paused'); assert.equal(fixed.result.state, 'unknown'); assert.equal(h.payloads.length, 2);
      assert.equal(before.sessionState.compactionAdoption, undefined);
      await h.reopen(); await h.runtime.continueRun(h.identity, h.sessionId, input.runId, randomUUID()); await h.advance(input.runId);
      const after = await h.snapshot(input.runId);
      assert.equal(h.payloads.length, 2); assert.equal(after.steps.filter(step => step.operation.kind === 'context.compaction.call').length, 1);
      assert.equal(after.steps.find(step => step.operation.kind === 'context.compaction.call').operation.operationId, fixed.operation.operationId);
    } finally { await restore(); }
  }, { compaction: { policy: { triggerChars: 1 } } });
});

function installedTool(name, effect, dispatch) {
  return { id: name, version: 1,
    async list() { return [{ definition: { name, description: '', inputSchema: { type: 'object', additionalProperties: false } }, effect, scope: {} }]; },
    async prepare(_context, offer, _intent, commandId) { return { commandId, name, effect: offer.effect, input: {} }; },
    dispatch, async reconcile() { return null; } };
}
test('a refused question preparation still blocks subsequent effects while closing every native pair', { timeout: 60000 }, async () => {
  let effects = 0;
  await fixture('chat-completions', async h => {
    h.handle(async (_payload, n) => n === 1 ? { tools: [tool('student_ask', question('允许操作吗？')), tool('write')] } : { text: '该动作没有执行。' });
    const input = await h.input(); await h.advance(input.runId);
    assert.equal(effects, 0); assert.equal((await h.snapshot(input.runId)).run.state, 'completed');
    assert.match(JSON.stringify(h.payloads[1].payload), /explicit-response-required/);
  }, { tools: [{ ...createUserQuestions(), async prepare() { throw new StorageError('forbidden'); } },
    installedTool('write', 'write', async () => { effects++; return { state: 'completed', feedback: { outcome: 'success', text: 'changed', images: [] }, result: {} }; })] });
});
test('all accepted external waits survive independently and require trusted completion rather than a user answer', { timeout: 60000 }, async () => {
  let effects = 0;
  await fixture('chat-completions', async h => {
    h.handle(async (_payload, n) => n === 1 ? { tools: [tool('launch'), tool('launch')] } : { text: '两个外部结果均已确认。' });
    const input = await h.input(); await h.advance(input.runId);
    let snapshot = await h.snapshot(input.runId);
    assert.equal(effects, 2); assert.equal(snapshot.state.waitQueue.length, 2); assert.equal(h.payloads.length, 1);
    await h.reopen();
    await h.runtime.continueRun(h.identity, h.sessionId, input.runId, randomUUID());
    for (let n = 0; n < 2; n++) {
      snapshot = await h.snapshot(input.runId); const pending = snapshot.waits.find(wait => wait.state === 'pending');
      await assert.rejects(h.runtime.respond(h.identity, h.sessionId, { requestId: randomUUID(), waitId: pending.waitId, expectedVersion: pending.version, answer: { done: true } }), { code: 'forbidden' });
      await h.runtime.resolveWait(h.identity, h.sessionId, { requestId: randomUUID(), waitId: pending.waitId, expectedVersion: pending.version, result: { done: true, resultId: String(n) } });
      await h.advance(input.runId);
    }
    assert.equal((await h.snapshot(input.runId)).run.state, 'completed'); assert.equal(effects, 2); assert.equal(h.payloads.length, 2);
  }, { tools: [installedTool('launch', 'execute', async (_context, command) => { effects++; return { state: 'accepted',
    feedback: { outcome: 'success', text: 'accepted, completion unknown', images: [] }, result: { taskId: command.commandId },
    wait: { kind: 'external', presentation: { commandId: command.commandId }, deadline: null } }; })] });
});
test('the original 64-tool Run budget spans CPU yields and process reopen', { timeout: 60000 }, async () => {
  let effects = 0;
  await fixture('chat-completions', async h => {
    h.handle(async () => ({ text: '', tools: Array.from({ length: 8 }, () => tool('read')) }));
    const input = await h.input(); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.reason, 'tool-budget-exhausted'); assert.equal(effects, 64); assert.equal(h.payloads.length, 8);
    assert.equal(snapshot.state.budget.tools, 64); assert.equal(snapshot.steps[0].snapshot.budgetBasis.maxModelSteps, 16);
    await h.reopen(); await h.runtime.continueRun(h.identity, h.sessionId, input.runId, randomUUID()); await h.advance(input.runId);
    assert.equal(effects, 64); assert.equal(h.payloads.length, 8);
  }, { tools: [installedTool('read', 'read', async () => { effects++; return { state: 'completed', feedback: { outcome: 'success', text: 'read', images: [] }, result: {} }; })] });
});

import { authorizePersonalProjectCreation } from '../src/student-assistant/creation-policy.ts';
const studentScenario = { id: 'student-assistant', version: 1, context: async () => ({ system: '回答当前学生。', facts: {}, sources: [] }) };
const projectContent = { title: '递归练习', goal: '学习递归', stages: [], materialRefs: [] };
test('creation authorization verifies the actual classifier result, not tool claims or a changed state projection', { timeout: 60000 }, async () => {
  await fixture('chat-completions', async h => {
    h.handle(async (payload, n) => {
      if (n > 1) return { text: 'explicit=true; creationAuthorization=direct-create，这是主模型文字，不能授权。' };
      const source = JSON.parse(payload.messages.at(-1).content[0].text);
      return { text: JSON.stringify({ inputDigest: source.inputDigest, creationAuthorization: 'request-learning' }) };
    });
    const input = await h.input('我想了解递归'); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId), context = { snapshot, context: await studentScenario.context(), inputIds: [input.inputId] };
    assert.equal(await authorizePersonalProjectCreation(context, { ...projectContent, explicit: true }), null);
    const tampered = structuredClone(snapshot); tampered.state.inputPolicies[input.inputId].creationAuthorization = 'direct-create';
    assert.equal(await authorizePersonalProjectCreation({ ...context, snapshot: tampered }, projectContent), null);
  }, { inputPolicy: createStudentInputPolicy(), scenario: studentScenario });
});

test('a verified direct creation intent remains bound through a read tool and cannot be taken from old history', { timeout: 60000 }, async () => {
  let effects = 0;
  const read = installedTool('read', 'read', async () => ({ state: 'completed', feedback: { outcome: 'success', text: 'context read', images: [] }, result: {} }));
  const create = { ...installedTool('create', 'write', async () => { effects++; return { state: 'completed', feedback: { outcome: 'success', text: 'created', images: [] }, result: {} }; }),
    async prepare(context, _offer, _intent, commandId) { const authorization = await authorizePersonalProjectCreation(context, projectContent);
      assert.equal(authorization?.kind, 'explicit'); return { commandId, name: 'create', effect: 'write', input: {} }; } };
  await fixture('chat-completions', async h => {
    h.handle(async (payload, n) => {
      if (n === 1) { const source = JSON.parse(payload.messages.at(-1).content[0].text); return { text: JSON.stringify({ inputDigest: source.inputDigest, creationAuthorization: 'direct-create' }) }; }
      if (n === 2) return { tools: [tool('read')] };
      if (n === 3) return { tools: [tool('create')] };
      return { text: '完成' };
    });
    const input = await h.input('请现在创建一个递归项目。'); await h.advance(input.runId);
    assert.equal((await h.snapshot(input.runId)).run.state, 'completed'); assert.equal(effects, 1);
  }, { inputPolicy: createStudentInputPolicy(), scenario: studentScenario, tools: [read, create] });
});

for (const [answer, authorization] of [[{ kind: 'choice', optionId: 'create' }, true], [{ kind: 'choice', optionId: 'later' }, false],
  [{ kind: 'choice', optionId: 'generic' }, true], [{ kind: 'skip' }, false], [{ kind: 'text', text: '请创建这个项目。' }, true]]) {
  test('creation confirmation requires the actual consumed action or fixed semantic response: ' + JSON.stringify(answer), { timeout: 60000 }, async () => {
    await fixture('chat-completions', async h => {
      let offered = false;
      h.handle(async payload => {
        const last = payload.messages.at(-1).content;
        const text = typeof last === 'string' ? last : Array.isArray(last) ? last.map(part => part.text ?? '').join('') : '';
        try { const source = JSON.parse(text); if (source.inputDigest) return { text: JSON.stringify({ inputDigest: source.inputDigest,
          creationAuthorization: source.waitId ? (source.response.kind === 'text' || ['create', 'generic'].includes(source.response.optionId) ? 'direct-create' : 'ordinary') : 'request-learning' }) }; } catch {}
        if (!offered) { offered = true; return { tools: [tool('student_ask', { question: '是否创建项目和独立工作区？', source: '当前学习目标',
          options: [{ id: 'create', label: '创建项目和工作区' }, { id: 'later', label: '暂不创建' }, { id: 'generic', label: '同意' }], allowText: true, skippable: true })] }; }
        return { text: '按真实回应继续。' };
      });
      const input = await h.input('我想学习递归'); await h.advance(input.runId);
      const waiting = (await h.snapshot(input.runId)).waits.find(wait => wait.state === 'pending');
      await h.runtime.respond(h.identity, h.sessionId, { requestId: randomUUID(), waitId: waiting.waitId, expectedVersion: waiting.version, answer });
      await h.advance(input.runId);
      const snapshot = await h.snapshot(input.runId), context = { snapshot, context: await studentScenario.context(), inputIds: [] };
      const before = h.payloads.length, evidence = await authorizePersonalProjectCreation(context, projectContent);
      assert.equal(evidence?.kind === 'confirmed', authorization); assert.equal(h.payloads.length, before, 'authorization helper never dispatches a model');
      if (authorization) assert.equal(evidence.waitId, waiting.waitId);
      if (answer.kind !== 'skip') assert.ok(snapshot.state.responsePolicies[waiting.waitId]);
      if (authorization) {
        const changed = structuredClone(snapshot); changed.waits.find(wait => wait.waitId === waiting.waitId).response = { kind: 'text', text: '不要创建' };
        assert.equal(await authorizePersonalProjectCreation({ ...context, snapshot: changed }, projectContent), null);
        const changedQuestion = structuredClone(snapshot); changedQuestion.waits.find(wait => wait.waitId === waiting.waitId).presentation.question = '是否创建函数？';
        assert.equal(await authorizePersonalProjectCreation({ ...context, snapshot: changedQuestion }, projectContent), null);
        const missingResult = structuredClone(snapshot); missingResult.steps = missingResult.steps.filter(step => step.operation.kind !== 'input.policy.call');
        assert.equal(await authorizePersonalProjectCreation({ ...context, snapshot: missingResult }, projectContent), null);
      }
    }, { inputPolicy: createStudentInputPolicy(), scenario: studentScenario, tools: [createUserQuestions()] });
  });
}

for (const protocol of protocols) test(protocol + ': discovery-wrapped original project confirmation authorizes only its fixed question command', { timeout: 60000 }, async () => {
  let effects = 0, authorizationContext;
  const create = { ...installedTool('create', 'write', async (_context, _command, _permit, assertDispatch) => {
    await assertDispatch(); effects++;
    return { state: 'completed', feedback: { outcome: 'success', text: 'created', images: [] }, result: { created: true } };
  }),
    async prepare(context, _offer, _intent, commandId) {
      authorizationContext = context;
      assert.equal((await authorizePersonalProjectCreation(context, projectContent))?.kind, 'confirmed');
      return { commandId, name: 'create', effect: 'write', input: {} };
    } };
  await fixture(protocol, async h => {
    let offered = false, created = false;
    h.handle(async payload => {
      const last = (payload.messages ?? payload.input).at(-1).content;
      const text = typeof last === 'string' ? last : Array.isArray(last) ? last.map(part => part.text ?? '').join('') : '';
      try { const source = JSON.parse(text); if (source.inputDigest) return { text: JSON.stringify({ inputDigest: source.inputDigest,
        creationAuthorization: source.waitId ? 'direct-create' : 'request-learning' }) }; } catch {}
      if (!offered) { offered = true; return { tools: [tool('student_ask', { question: '是否现在为你创建个人项目和独立学习工作区？', source: '当前学习目标',
        options: [{ id: 'yes', label: '同意' }], allowText: true, skippable: false })] }; }
      if (!created) { created = true; return { tools: [tool('create')] }; }
      return { text: '已根据原问题的明确回应创建。' };
    });
    const input = await h.input('我想学习递归'); await h.advance(input.runId);
    const waiting = (await h.snapshot(input.runId)).waits.find(wait => wait.state === 'pending');
    assert.equal(waiting.presentation.moduleId, 'tool-discovery');
    await h.runtime.respond(h.identity, h.sessionId, { requestId: randomUUID(), waitId: waiting.waitId,
      expectedVersion: waiting.version, answer: { kind: 'choice', optionId: 'yes' } });
    await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId);
    assert.ok(snapshot.state.responsePolicies[waiting.waitId], 'the fixed response policy must exist before authorization');
    assert.equal(effects, 1, 'the original confirmed project must actually dispatch');
    assert.equal(snapshot.run.state, 'completed');
    const context = { ...authorizationContext, snapshot };
    assert.equal((await authorizePersonalProjectCreation(context, projectContent))?.kind, 'confirmed');
    for (const change of [
      changed => { changed.steps = changed.steps.filter(step => step.operation.kind !== 'conversation.wait'); },
      changed => { changed.steps = changed.steps.filter(step => step.operation.kind !== 'tool.call' || step.operation.operationId !== waiting.presentation.commandId); },
      changed => { changed.steps.find(step => step.operation.kind === 'tool.call' && step.operation.operationId === waiting.presentation.commandId).operation.input.binding.moduleId = 'forged'; },
      changed => { changed.steps.find(step => step.operation.kind === 'tool.call' && step.operation.operationId === waiting.presentation.commandId).operation.input.command.input.binding.moduleId = 'forged'; },
      changed => { changed.steps.find(step => step.operation.kind === 'tool.call' && step.operation.operationId === waiting.presentation.commandId).operation.input.command.input.command.input.question = '是否创建函数？'; },
    ]) {
      const changed = structuredClone(snapshot); change(changed);
      assert.equal(await authorizePersonalProjectCreation({ ...context, snapshot: changed }, projectContent), null,
        'presentation routing and a completed classifier cannot replace the original fixed command');
    }
    await h.reopen();
    assert.equal((await authorizePersonalProjectCreation({ ...context, snapshot: await h.snapshot(input.runId) }, projectContent))?.kind, 'confirmed');
  }, { inputPolicy: createStudentInputPolicy(), scenario: studentScenario,
    tools: [createToolDiscovery({ modules: [createUserQuestions(), create], initiallyVisible: () => true })] });
});

test('source-version changes reject a completed summary without replacing its original operation', { timeout: 60000 }, async () => {
  await fixture('chat-completions', async h => {
    let version = 1;
    h.options.scenario.context = async () => ({ system: '按来源版本回答。', facts: { version }, sources: [{ id: 'reference', version }] });
    h.handle(async payload => { const summary = compactionReply(payload); if (summary) version = 2; return summary ?? { text: '固定旧历史'.repeat(80) }; });
    let input = await h.input('old'); await h.advance(input.runId); input = await h.input('new'); await h.advance(input.runId);
    const before = await h.snapshot(input.runId), call = before.steps.find(step => step.operation.kind === 'context.compaction.call');
    assert.equal(before.run.reason, 'compaction-source-changed'); assert.equal(before.sessionState.compactionAdoption, undefined);
    assert.equal((await h.models.checks.read(h.identity, call.operation.operationId)).state, 'completed');
    await h.runtime.continueRun(h.identity, h.sessionId, input.runId, randomUUID()); await h.advance(input.runId);
    assert.equal(h.payloads.length, 2); assert.equal((await h.snapshot(input.runId)).steps.filter(step => step.operation.kind === 'context.compaction.call').length, 1);
  }, { compaction: { policy: { triggerChars: 1 } } });
});

for (const protocol of protocols) test(protocol + ': stop during compaction revokes only its original permit and cannot adopt or resend the summary', { timeout: 60000 }, async () => {
  await fixture(protocol, async h => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    h.handle(async payload => { const summary = compactionReply(payload); if (summary) { started.resolve(); await release.promise; return summary; } return { text: '旧历史'.repeat(100) }; });
    let input = await h.input('old'); await h.advance(input.runId); input = await h.input('new');
    const advancing = h.advance(input.runId); await started.promise;
    await h.runtime.stop(h.identity, h.sessionId, input.runId, randomUUID()); release.resolve(); await advancing;
    const before = await h.snapshot(input.runId), original = before.steps.find(step => step.operation.kind === 'context.compaction.call');
    await h.reopen(); await h.advance(input.runId);
    const after = await h.snapshot(input.runId);
    assert.equal(after.run.state, 'stopped'); assert.equal(h.payloads.length, 2); assert.equal(after.sessionState.compactionAdoption, undefined);
    assert.equal(after.steps.find(step => step.operation.kind === 'context.compaction.call').operation.operationId, original.operation.operationId);
    assert.equal((await h.runtime.events(h.identity, h.sessionId)).some(event => event.kind === 'context-compacted'), false);
  }, { compaction: { policy: { triggerChars: 1 } } });
});
test('model output uses the persisted 65536 Run cap without applying a 2048-token probe cap', { timeout: 60000 }, async () => {
  await fixture('chat-completions', async h => {
    await h.switchModel('chat-completions', 131072);
    const input = await h.input(); await h.advance(input.runId); const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'completed'); assert.equal(h.payloads[0].payload.max_tokens ?? h.payloads[0].payload.max_completion_tokens, 65536);
    const basis = snapshot.steps[0].snapshot.budgetBasis;
    assert.equal(basis.maxInputTokens, 1048576); assert.equal(basis.maxOutputTokens, 65536); assert.equal(basis.maxCallMs, 600000);
    assert.equal(Date.parse(basis.deadline) - Date.parse(snapshot.run.createdAt), 86400000);
    assert.equal((await h.models.selection.read(h.identity)).selected.connection.maxOutputTokens, 131072);
  });
});

import { createStudentAssistant } from '../dist/student-assistant/index.js';
test('student factory installs fixed input policy by default without accessing learning owners for an ordinary answer', { timeout: 60000 }, async () => {
  const identity = { kind: 'personal', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), name: '学生' };
  const unavailable = async () => { throw Error('ordinary input must not access a domain owner'); };
  const learning = { localPersonalIdentity: identity, localLearningTarget: { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 },
    query: { listLearningTasks: unavailable, searchLearning: unavailable, readLearning: unavailable }, projects: { create: unavailable, receipt: unavailable },
    authorizeCreation: authorizePersonalProjectCreation, workspaceSessions: { ensure: unavailable, receipt: unavailable }, materials: { adopt: unavailable, receipt: unavailable } };
  await fixture('chat-completions', async h => {
    h.handle(async (payload, n) => { if (n > 1) return { text: '递归是通过更小的同类问题求解。' };
      const source = JSON.parse(payload.messages.at(-1).content[0].text);
      return { text: JSON.stringify({ inputDigest: source.inputDigest, creationAuthorization: 'ordinary' }) }; });
    const input = await h.input('什么是递归？'); await h.advance(input.runId); const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'completed'); assert.equal(h.payloads.length, 2);
    assert.equal(snapshot.state.inputPolicies[input.inputId].creationAuthorization, 'ordinary');
  }, { identity, scenario: studentScenario, pipelineFactory: options => createStudentAssistant({ models: options.models, learning }) });
});
test('invalid semantic policy output neither authorizes creation nor starts the primary answer or a replacement attempt', { timeout: 60000 }, async () => {
  await fixture('chat-completions', async h => {
    h.handle(async () => ({ text: JSON.stringify({ inputDigest: '0'.repeat(64), creationAuthorization: 'direct-create' }) }));
    const input = await h.input('我想学习递归'); await h.advance(input.runId); let snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.reason, 'input-policy-invalid'); assert.equal(snapshot.state.inputPolicies, undefined); assert.equal(h.payloads.length, 1);
    await h.reopen(); await h.runtime.continueRun(h.identity, h.sessionId, input.runId, randomUUID()); await h.advance(input.runId);
    snapshot = await h.snapshot(input.runId); assert.equal(snapshot.run.reason, 'input-policy-invalid'); assert.equal(h.payloads.length, 1);
    assert.equal(await authorizePersonalProjectCreation({ snapshot, context: await studentScenario.context(), inputIds: [input.inputId] }, projectContent), null);
  }, { inputPolicy: createStudentInputPolicy(), scenario: studentScenario });
});

test('new steering input cannot inherit an older creation authorization or dispatch its pending tool', { timeout: 60000 }, async () => {
  let effects = 0;
  const create = { ...installedTool('create', 'write', async () => { effects++; return { state: 'completed', feedback: { outcome: 'success', text: 'created', images: [] }, result: {} }; }),
    async prepare(context, _offer, _intent, commandId) { const evidence = await authorizePersonalProjectCreation(context, projectContent);
      if (!evidence) throw new StorageError('forbidden'); return { commandId, name: 'create', effect: 'write', input: {} }; } };
  await fixture('chat-completions', async h => {
    let added, policyCalls = 0;
    h.handle(async payload => {
      const content = payload.messages.at(-1).content, text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
      try { const source = JSON.parse(text); if (source.inputDigest) return { text: JSON.stringify({ inputDigest: source.inputDigest,
        creationAuthorization: ++policyCalls === 1 ? 'direct-create' : 'ordinary' }) }; } catch {}
      if (!added) { added = await h.input('先不要创建，只解释概念。'); return { tools: [tool('create')] }; }
      return { text: '不创建，继续解释。' };
    });
    const input = await h.input('请创建递归项目。'); await h.advance(input.runId); const snapshot = await h.snapshot(input.runId);
    assert.equal(effects, 0); assert.equal(snapshot.run.state, 'completed'); assert.equal(snapshot.state.inputPolicies[added.inputId].creationAuthorization, 'ordinary');
    assert.equal(await authorizePersonalProjectCreation({ snapshot, context: await studentScenario.context(), inputIds: [input.inputId] }, projectContent), null);
  }, { inputPolicy: createStudentInputPolicy(), scenario: studentScenario, tools: [create] });
});

for (const protocol of protocols) test(protocol + ': a consumed generic create button for a function is not project authorization', { timeout: 60000 }, async () => {
  await fixture(protocol, async h => {
    let offered = false;
    h.handle(async payload => {
      const messages = payload.messages ?? payload.input;
      const content = messages.at(-1).content, text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
      try { const source = JSON.parse(text); if (source.inputDigest) return { text: JSON.stringify({ inputDigest: source.inputDigest,
        creationAuthorization: source.waitId ? 'ordinary' : 'request-learning' }) }; } catch {}
      if (!offered) { offered = true; return { tools: [tool('student_ask', { question: '要创建一个名为 factorial 的函数吗？', source: '当前代码问题',
        options: [{ id: 'create', label: '创建' }], allowText: true, skippable: true })] }; }
      return { text: '这里只讨论创建函数。' };
    });
    const input = await h.input('我想学习递归函数'); await h.advance(input.runId);
    const wait = (await h.snapshot(input.runId)).waits.find(wait => wait.state === 'pending');
    await h.runtime.respond(h.identity, h.sessionId, { requestId: randomUUID(), waitId: wait.waitId, expectedVersion: wait.version, answer: { kind: 'choice', optionId: 'create' } });
    await h.advance(input.runId); const snapshot = await h.snapshot(input.runId);
    assert.equal(await authorizePersonalProjectCreation({ snapshot, context: await studentScenario.context(), inputIds: [] }, projectContent), null);
    assert.equal(snapshot.state.responsePolicies[wait.waitId].creationAuthorization, 'ordinary');
  }, { inputPolicy: createStudentInputPolicy(), scenario: studentScenario, tools: [createUserQuestions()] });
});
for (const ending of ['resolved', 'stopped']) test('an explicit tool continuation keeps only its original permit live until ' + ending, { timeout: 60000 }, async () => {
  let originalPermit, launches = 0;
  await fixture('chat-completions', async h => {
    h.handle(async (_payload, n) => n === 1 ? { tools: [tool('launch')] } : { text: '已收到外部完成事实。' });
    const input = await h.input(); await h.advance(input.runId); const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'waiting');
    await h.runtime.assertDispatch(h.identity, originalPermit);
    const waiting = snapshot.waits.find(wait => wait.state === 'pending');
    assert.equal(waiting.continuationOperationId, originalPermit.operationId);
    assert.equal(snapshot.steps.find(step => step.operation.operationId === originalPermit.operationId).continuationOpen, true);
    const segment = await h.models.segments.read(h.identity, snapshot.sessionState.segment.segmentId);
    assert.equal(segment.pendingTools.length, 0, 'accepted continuation already closed its native model pair');
    if (ending === 'resolved') await h.runtime.resolveWait(h.identity, h.sessionId, { requestId: randomUUID(), waitId: waiting.waitId, expectedVersion: waiting.version, result: { completed: true } });
    else await h.runtime.stop(h.identity, h.sessionId, input.runId, randomUUID());
    await assert.rejects(h.runtime.assertDispatch(h.identity, originalPermit), { code: 'stale-generation' });
    await h.advance(input.runId); assert.equal((await h.snapshot(input.runId)).run.state, ending === 'resolved' ? 'completed' : 'stopped');
    assert.equal(launches, 1);
  }, { tools: [installedTool('launch', 'execute', async (_context, command, permit) => { originalPermit = permit; launches++;
    return { state: 'accepted', continuation: true, feedback: { outcome: 'success', text: 'accepted', images: [] }, result: { id: command.commandId },
      wait: { kind: 'external', presentation: { commandId: command.commandId }, deadline: null } }; })] });
});

for (const protocol of protocols) test(protocol + ': steering interrupts a question without answering it or repeating an accepted external effect', { timeout: 60000 }, async () => {
  let launches = 0;
  const external = installedTool('launch', 'execute', async (_context, command) => {
    launches++;
    return { state: 'accepted', feedback: { outcome: 'success', text: 'external accepted', images: [] }, result: { taskId: command.commandId },
      wait: { kind: 'external', presentation: { commandId: command.commandId }, deadline: null } };
  });
  await fixture(protocol, async h => {
    h.handle(async (_payload, n) => n === 1 ? { tools: [tool('launch'), tool('student_ask', question('是否创建个人项目？')),
      tool('student_ask', question('旧输入的第二个问题？'))] } : { text: '只解释新概念，不创建项目。' });
    const input = await h.input('解释原来的概念'); await h.advance(input.runId);
    let snapshot = await h.snapshot(input.runId);
    const externalWait = snapshot.waits.find(wait => wait.state === 'pending');
    const steering = await h.input('先不创建，只解释递归。');
    snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.waits.find(wait => wait.waitId === externalWait.waitId).state, 'pending', 'external effects are not interruptible by default');
    assert.equal(steering.runId, input.runId);
    await h.runtime.resolveWait(h.identity, h.sessionId, { requestId: randomUUID(), waitId: externalWait.waitId,
      expectedVersion: externalWait.version, result: { done: true } });
    await h.advance(input.runId);
    snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'completed');
    assert.equal(snapshot.waits.filter(wait => wait.kind === 'user').length, 0, 'questions from the superseded input are not opened later');
    assert.equal(launches, 1);
  }, { tools: [external, createUserQuestions()] });
});

test('steering cancels a visible question with a null answer and continues using the actual cancellation observation', { timeout: 60000 }, async () => {
  await fixture('chat-completions', async h => {
    h.handle(async (_payload, n) => n === 1 ? { tools: [tool('student_ask', question('是否创建个人项目？')),
      tool('student_ask', question('另一个旧问题？'))] } : { text: '继续解释递归。' });
    const input = await h.input('我想学习递归'); await h.advance(input.runId);
    let snapshot = await h.snapshot(input.runId);
    const wait = snapshot.waits.find(wait => wait.state === 'pending');
    assert.equal(wait.interruptible, true);
    const steering = await h.input('先不要创建，只解释递归。');
    snapshot = await h.snapshot(input.runId);
    const cancelled = snapshot.waits.find(item => item.waitId === wait.waitId);
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.response, null);
    await assert.rejects(h.runtime.respond(h.identity, h.sessionId, { requestId: randomUUID(), waitId: wait.waitId,
      expectedVersion: wait.version, answer: { kind: 'choice', optionId: 'yes' } }));
    await h.reopen(); await h.runtime.continueRun(h.identity, h.sessionId, input.runId, randomUUID());
    await h.advance(input.runId); snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'completed'); assert.equal(snapshot.waits.length, 1);
    const model = snapshot.steps.filter(step => step.operation.kind === 'model.call').at(-1);
    assert.ok(model.snapshot.inputIds.includes(steering.inputId));
    const observation = model.operation.input.input.observations.map(item => JSON.parse(item.text)).find(item => item.waitId === wait.waitId);
    assert.equal(observation.kind, 'wait-cancelled'); assert.equal(observation.state, 'cancelled'); assert.equal(observation.answer, null);
    assert.equal(await authorizePersonalProjectCreation({ snapshot: { ...snapshot, session: { ...snapshot.session, scenario: 'student-assistant' } },
      context: { system: '', facts: {}, sources: [] }, inputIds: [steering.inputId] }, projectContent), null);
    const calls = h.payloads.length; await h.advance(input.runId); assert.equal(h.payloads.length, calls);
  }, { tools: [createUserQuestions()] });
});

async function slowText(response, protocol, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = event => response.write((protocol === 'messages' ? 'event: ' + event.type + '\n' : '') + 'data: ' + JSON.stringify(event) + '\n\n');
  if (protocol === 'chat-completions') {
    send({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  } else if (protocol === 'responses') {
    send({ type: 'response.output_item.added', output_index: 0, item: { id: 'visible', type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
    send({ type: 'response.content_part.added', item_id: 'visible', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    send({ type: 'response.output_text.delta', item_id: 'visible', output_index: 0, content_index: 0, delta: text });
  } else {
    send({ type: 'message_start', message: { id: 'slow-message', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  }
  await new Promise(resolve => setTimeout(resolve, 240));
  if (protocol === 'chat-completions') {
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } });
    response.end('data: [DONE]\n\n');
  } else if (protocol === 'responses') {
    send({ type: 'response.completed', response: { id: 'slow-response', object: 'response', status: 'completed',
      output: [{ id: 'visible', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } } }); response.end();
  } else {
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
    send({ type: 'message_stop' }); response.end();
  }
}
for (const protocol of protocols) for (const sink of ['port', 'callback']) test(protocol + ': slow internal policy and compaction stay private while model answers stream through ' + sink, { timeout: 60000 }, async () => {
  await fixture(protocol, async h => {
    const published = [];
    const publish = async (identity, permit, progress) => {
      published.push(permit.operationId);
      return h.runtime.recordProgress(identity, permit, progress);
    };
    if (sink === 'port') h.options.progressPort = { recordProgress: publish };
    else h.options.progress = async (snapshot, _step, permit, progress) => publish(snapshot.session.identity, permit, progress);
    h.handle(async (payload, _n, response) => {
      const messages = payload.messages ?? payload.input, content = messages.at(-1).content;
      const text = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
      let source; try { source = JSON.parse(text); } catch {}
      const summary = compactionReply(payload);
      const result = summary?.text ?? (source?.inputDigest ? JSON.stringify({ inputDigest: source.inputDigest, creationAuthorization: 'ordinary' })
        : 'PUBLIC_ANSWER_' + '可见解释'.repeat(100));
      await slowText(response, protocol, result + (source?.inputDigest ? ' '.repeat(300) : ''));
      return null;
    });
    const first = await h.input('先解释概念'); await h.advance(first.runId);
    const next = await h.input('再解释一遍'); await h.advance(next.runId);
    const snapshots = [await h.snapshot(first.runId), await h.snapshot(next.runId)];
    assert.ok(snapshots.every(snapshot => snapshot.run.state === 'completed'));
    const steps = snapshots.flatMap(snapshot => snapshot.steps);
    const internal = steps.filter(step => ['input.policy.call', 'context.compaction.call'].includes(step.operation.kind));
    assert.equal(internal.filter(step => step.operation.kind === 'input.policy.call').length, 2);
    assert.equal(internal.filter(step => step.operation.kind === 'context.compaction.call').length, 1);
    for (const step of internal) {
      const fact = await h.models.checks.read(h.identity, step.operation.operationId);
      assert.equal(fact.state, 'completed'); assert.ok(fact.resultRef);
      assert.ok(await h.models.checks.progress(h.identity, fact.attemptId), 'internal progress remains at its original model owner');
      assert.ok(!published.includes(step.operation.operationId), 'internal model operation reached a public progress sink: ' + step.operation.kind);
    }
    const events = await h.runtime.events(h.identity, h.sessionId);
    const progress = events.filter(event => event.kind === 'model-progress');
    const answers = steps.filter(step => step.operation.kind === 'model.call');
    for (const step of answers) assert.ok(progress.some(event => event.body.operationId === step.operation.operationId), 'ordinary answers still stream with their original permit');
    const messages = events.filter(event => ['model-progress', 'assistant'].includes(event.kind));
    assert.equal(messages.filter(event => event.kind === 'assistant').length, 2);
    assert.ok(messages.every(event => event.body.text.startsWith('PUBLIC_ANSWER_')), 'internal JSON leaked into user messages');
  }, { inputPolicy: createStudentInputPolicy(), compaction: { policy: { triggerChars: 1 } } });
});

for (const protocol of protocols) test(protocol + ': student factory uses only explicit owner tool modules without a local learning host', { timeout: 60000 }, async () => {
  let reads = 0, active;
  const remote = installedTool('owner_read', 'read', async (context, command, permit, assertDispatch) => {
    await assertDispatch(); await active.runtime.assertDispatch(active.identity, permit);
    assert.equal(context.snapshot.session.scenario, 'student-assistant');
    assert.match(context.context.system, /你是循阶主页学习助手/);
    assert.equal(context.snapshot.state.inputPolicies[context.inputIds[0]].creationAuthorization, 'ordinary');
    reads++;
    return { state: 'completed', feedback: { outcome: 'success', text: 'OWNER_FACT', images: [] }, result: { commandId: command.commandId } };
  });
  await fixture(protocol, async h => {
    active = h;
    h.handle(async payload => {
      const summary = compactionReply(payload); if (summary) return summary;
      const messages = payload.messages ?? payload.input, content = messages.at(-1).content;
      const text = typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
      try { const source = JSON.parse(text); if (source.inputDigest) return { text: JSON.stringify({ inputDigest: source.inputDigest, creationAuthorization: 'ordinary' }) }; } catch {}
      const names = (payload.tools ?? []).map(item => item.function?.name ?? item.name);
      assert.deepEqual(names, ['owner_read'], 'explicit tools replace all local defaults');
      return reads ? { text: '根据数据 owner 的获准事实回答。'.repeat(15) } : { tools: [tool('owner_read')] };
    });
    const input = await h.input('查询当前获准资料'); await h.advance(input.runId);
    const next = await h.input('接着说明'); await h.advance(next.runId);
    const first = await h.snapshot(input.runId), second = await h.snapshot(next.runId);
    assert.equal(first.run.state, 'completed'); assert.equal(second.run.state, 'completed'); assert.equal(reads, 1);
    assert.equal(first.state.inputPolicies[input.inputId].creationAuthorization, 'ordinary');
    assert.equal(second.state.inputPolicies[next.inputId].creationAuthorization, 'ordinary');
    assert.ok(second.steps.some(step => step.operation.kind === 'context.compaction.call' && step.result.state === 'completed'));
    assert.equal((await h.models.segments.read(h.identity, first.steps.find(step => step.operation.kind === 'model.call').operation.input.segmentId)).pendingTools.length, 0);
  }, { scenario: studentScenario, pipelineFactory(options) {
    const configured = { models: options.models, tools: Object.freeze([remote]), compaction: { policy: { triggerChars: 1 } } };
    for (const key of ['learning', 'documents', 'skills']) Object.defineProperty(configured, key, { get() { throw Error('explicit tools must not touch local ' + key); } });
    return createStudentAssistant(configured);
  } });
});

const continuedPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function payloadImages(value) {
  if (!value || typeof value !== 'object') return [];
  if (['image_url', 'input_image', 'image'].includes(value.type)) return [value];
  return Object.values(value).flatMap(payloadImages);
}
for (const [from, to] of [['chat-completions', 'responses'], ['responses', 'messages'], ['messages', 'chat-completions']]) {
  test(from + ': fixed source image is reauthorized into the first ' + to + ' call without repeating its tool', { timeout: 60000 }, async () => {
    let active, original, calls = 0, validations = 0;
    const page = { ...installedTool('page', 'read', async (_context, command) => {
      calls++;
      const image = await active.models.images.upload(active.identity, { requestId: randomUUID(), imageId: randomUUID(), mediaType: 'image/png', dataBase64: continuedPng });
      original = { state: 'completed', feedback: { outcome: 'success', text: '原固定页图', images: [{ imageId: image.imageId, version: 1 }] },
        result: { readingId: 'fixed-source-reading', page: 2, sha256: image.sha256, commandId: command.commandId } };
      await active.switchModel(to); return original;
    }), async reconcile() { validations++; return original; } };
    await fixture(from, async h => {
      active = h;
      h.handle(async (_payload, n) => n === 1 ? { tools: [tool('page', {}, 'original-provider-tool-id')] } : { text: '按原固定图像说明。' });
      const input = await h.input(); await h.advance(input.runId);
      const snapshot = await h.snapshot(input.runId);
      assert.equal(snapshot.run.state, 'completed'); assert.equal(calls, 1); assert.ok(validations > 0);
      assert.equal(h.payloads[1].protocol, to);
      const images = payloadImages(h.payloads[1].payload); assert.equal(images.length, 1);
      const base64 = to === 'messages' ? images[0].source.data : (to === 'responses' ? images[0].image_url : images[0].image_url.url).split(',')[1];
      assert.equal(base64, continuedPng);
      assert.doesNotMatch(JSON.stringify(h.payloads[1].payload), /original-provider-tool-id|PRIVATE_PROVIDER_SIGNATURE|PRIVATE_PROVIDER_REASONING/);
      assert.equal(snapshot.steps.filter(step => step.operation.kind === 'tool.call').length, 1);
      const model = snapshot.steps.filter(step => step.operation.kind === 'model.call').at(-1);
      assert.ok(model.snapshot.imageInputBytes > 0); assert.equal(model.operation.input.input.images.length, 1);
      assert.equal(model.snapshot.inputReserve, 262144, 'the full model context reservation covers text and images together');
    }, { imageInput: true, tools: [page] });
  });
}

test('fixed images survive Run reopen and compaction through original read-only source facts', { timeout: 60000 }, async () => {
  let active, original, calls = 0, sourceRun;
  const page = { ...installedTool('page', 'read', async context => {
    calls++; sourceRun = context.snapshot.run.runId;
    const image = await active.models.images.upload(active.identity, { requestId: randomUUID(), imageId: randomUUID(), mediaType: 'image/png', dataBase64: continuedPng });
    original = { state: 'completed', feedback: { outcome: 'success', text: '固定图像', images: [{ imageId: image.imageId, version: 1 }] }, result: { readingId: 'original-reading', page: 2, sha256: image.sha256 } };
    return original;
  }), async reconcile(context) { assert.equal(context.snapshot.run.runId, sourceRun); return original; } };
  await fixture('messages', async h => {
    active = h;
    h.handle(async (payload, n) => compactionReply(payload) ?? (n === 1 ? { tools: [tool('page')] } : { text: '原图已读取。'.repeat(30) }));
    const first = await h.input('读取原图'); await h.advance(first.runId);
    await h.reopen(); await h.switchModel('responses');
    const next = await h.input('继续依据原图'); await h.advance(next.runId);
    const snapshot = await h.snapshot(next.runId);
    assert.equal(snapshot.run.state, 'completed'); assert.equal(calls, 1);
    assert.equal(snapshot.steps.filter(step => step.operation.kind === 'context.compaction.call').length, 1);
    assert.equal(payloadImages(h.payloads.at(-1).payload).length, 1);
    assert.equal(snapshot.sessionState.imageSources[0].origin.snapshot.sessionState.imageSources, undefined, 'source receipts do not recursively capture session history');
  }, { imageInput: true, tools: [page], compaction: { policy: { triggerChars: 1 } } });
});
for (const reason of ['revoked', 'no-images']) test('image continuation pauses for ' + reason + ' without sending a text-only visual claim', { timeout: 60000 }, async () => {
  let active, original, calls = 0;
  const page = { ...installedTool('page', 'read', async () => {
    calls++;
    const image = await active.models.images.upload(active.identity, { requestId: randomUUID(), imageId: randomUUID(), mediaType: 'image/png', dataBase64: continuedPng });
    original = { state: 'completed', feedback: { outcome: 'success', text: '固定图像', images: [{ imageId: image.imageId, version: 1 }] }, result: { sha256: image.sha256 } };
    await active.switchModel('responses', 2048, reason !== 'no-images'); return original;
  }), async reconcile() { if (reason === 'revoked') throw new StorageError('forbidden'); return original; } };
  await fixture('chat-completions', async h => {
    active = h; h.handle(async () => ({ tools: [tool('page')] }));
    const input = await h.input(); await h.advance(input.runId); const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'paused'); assert.equal(snapshot.run.reason, reason === 'revoked' ? 'image-source-unavailable' : 'image-input-unavailable');
    assert.equal(h.payloads.length, 1); assert.equal(calls, 1);
    assert.equal((await h.models.segments.read(h.identity, snapshot.sessionState.imageSources[0].segmentId)).pendingTools.length, 0);
  }, { imageInput: true, tools: [page] });
});
test('an interrupted image continuation adopts its original completed attempt after source revocation without a second physical request', { timeout: 60000 }, async () => {
  let active, original, calls = 0, revoked = false, interrupted = false;
  const page = { ...installedTool('page', 'read', async () => {
    calls++;
    const image = await active.models.images.upload(active.identity, { requestId: randomUUID(), imageId: randomUUID(), mediaType: 'image/png', dataBase64: continuedPng });
    original = { state: 'completed', feedback: { outcome: 'success', text: '固定图像', images: [{ imageId: image.imageId, version: 1 }] }, result: { sha256: image.sha256 } };
    await active.switchModel('messages'); return original;
  }), async reconcile() { if (revoked) throw new StorageError('forbidden'); return original; } };
  await fixture('chat-completions', async h => {
    active = h; h.handle(async (_payload, n) => n === 1 ? { tools: [tool('page')] } : { text: '原图回答已付费完成。' });
    const input = await h.input(); await assert.rejects(h.advance(input.runId), /worker-interrupted-after-image-result/);
    const before = await h.snapshot(input.runId), fixed = before.steps.filter(step => step.operation.kind === 'model.call').at(-1);
    assert.equal((await h.models.checks.read(h.identity, fixed.operation.operationId)).state, 'completed');
    revoked = true; await h.reopen(); await h.runtime.continueRun(h.identity, h.sessionId, input.runId, randomUUID()); await h.advance(input.runId);
    const after = await h.snapshot(input.runId);
    assert.equal(after.run.state, 'completed'); assert.equal(h.payloads.length, 2); assert.equal(calls, 1);
    assert.equal(after.steps.filter(step => step.operation.kind === 'model.call').at(-1).operation.operationId, fixed.operation.operationId);
  }, { imageInput: true, tools: [page], pipelineFactory(options) {
    const pipeline = createConversationPipeline(options);
    return { ...pipeline, async apply(snapshot, step, result) {
      if (!interrupted && step.operation.kind === 'model.call' && step.snapshot.imageSourceIds?.length) {
        interrupted = true; throw Error('worker-interrupted-after-image-result');
      }
      return pipeline.apply(snapshot, step, result);
    } };
  } });
});

test('a destination rejection for fixed image refs pauses without transferring or re-uploading the source', { timeout: 60000 }, async () => {
  let active, original, uploads = 0;
  const page = { ...installedTool('page', 'read', async () => {
    uploads++;
    const image = await active.models.images.upload(active.identity, { requestId: randomUUID(), imageId: randomUUID(), mediaType: 'image/png', dataBase64: continuedPng });
    original = { state: 'completed', feedback: { outcome: 'success', text: '固定图像', images: [{ imageId: image.imageId, version: 1 }] }, result: { sha256: image.sha256 } };
    await active.switchModel('messages'); return original;
  }), async reconcile() { return original; } };
  await fixture('chat-completions', async h => {
    active = h;
    const receive = h.models.checks.receive;
    // Paired owner's public receive seam rejects refs whose fixed destination differs from the segment.
    h.models.checks.receive = async (identity, input) => {
      if (input.input.images.length) throw new StorageError('conflict');
      return receive(identity, input);
    };
    h.handle(async () => ({ tools: [tool('page')] }));
    const input = await h.input(); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'paused'); assert.equal(snapshot.run.reason, 'image-owner-route-unavailable');
    assert.equal(h.payloads.length, 1); assert.equal(uploads, 1);
    assert.equal(snapshot.sessionState.imageSources[0].images[0].imageId, original.feedback.images[0].imageId);
  }, { imageInput: true, tools: [page] });
});

test('unknown image result publication keeps the exact original attempt and never repeats the page tool or paid request', { timeout: 60000 }, async () => {
  let active, original, calls = 0;
  const page = { ...installedTool('page', 'read', async () => {
    calls++;
    const image = await active.models.images.upload(active.identity, { requestId: randomUUID(), imageId: randomUUID(), mediaType: 'image/png', dataBase64: continuedPng });
    original = { state: 'completed', feedback: { outcome: 'success', text: '固定图像', images: [{ imageId: image.imageId, version: 1 }] }, result: { sha256: image.sha256 } };
    await active.switchModel('responses'); return original;
  }), async reconcile() { return original; } };
  await fixture('chat-completions', async h => {
    active = h; let restore = async () => {};
    h.handle(async (_payload, n) => {
      if (n === 1) return { tools: [tool('page')] };
      const root = h.modelRoot, parked = root + '-image-held';
      await rename(root, parked); await writeFile(root, 'block only this fixture image result publication');
      restore = async () => { await unlink(root); await rename(parked, root); };
      return { text: '原图片的回答不可重派。' };
    });
    try {
      const input = await h.input(); await h.advance(input.runId); await restore(); restore = async () => {};
      const before = await h.snapshot(input.runId), fixed = before.steps.filter(step => step.operation.kind === 'model.call').at(-1);
      assert.equal(fixed.result.state, 'unknown'); assert.equal(h.payloads.length, 2);
      await h.reopen(); await h.runtime.continueRun(h.identity, h.sessionId, input.runId, randomUUID()); await h.advance(input.runId);
      const after = await h.snapshot(input.runId);
      assert.equal(after.steps.filter(step => step.operation.kind === 'model.call').at(-1).operation.operationId, fixed.operation.operationId);
      assert.equal(after.steps.filter(step => step.operation.kind === 'model.call').at(-1).result.state, 'unknown');
      assert.notEqual(after.run.state, 'completed'); assert.equal(h.payloads.length, 2); assert.equal(calls, 1);
    } finally { await restore(); }
  }, { imageInput: true, tools: [page] });
});

test('the real fixed PDF reading and document module reauthorize original page bytes on a fresh native segment', { timeout: 60000 }, async () => {
  const { createLearningData, learningMigrations } = await import('@xunjie/learning-space');
  const { createSessionMaterials } = await import('@xunjie/learning-space/learning-data/session-materials');
  const { createDocumentTools } = await import('../dist/capabilities/documents/index.js');
  const { fixedPdf } = await import('../../../apps/server/tests/fixtures/pdf-material.mjs');
  await fixture('chat-completions', async h => {
    const data = await h.openOwner('fixed-page-owner', learningMigrations), target = { ...data.owner, version: 1 };
    const learning = createLearningData(data, { resolveBinding: async () => target });
    const activity = await learning.create(h.identity, { requestId: randomUUID(), goal: '固定 PDF 页图依据', question: '', references: [] });
    const materials = createSessionMaterials(data, { openScope: (identity, scope) => scope.kind === 'workspace'
      ? learning.open(identity, scope.activityId) : Promise.reject(new StorageError('forbidden')) });
    const document = await materials.pdf.upload(h.identity, activity.activityId, { requestId: randomUUID(), documentId: randomUUID(), name: 'fixed-page.pdf', dataBase64: fixedPdf().toString('base64') });
    const reading = await materials.pdf.read(h.identity, activity.activityId, { requestId: randomUUID(), documentId: document.documentId, pages: [2], region: null });
    h.options.scenario.context = async () => ({ system: '依据固定 PDF 页图解释。', facts: { workspace: activity }, sources: [] });
    h.options.tools = [createDocumentTools({ materials, models: h.models, source: { sourceId: 'fixed-data', owner: target } })];
    await h.reopen();
    let uploads = 0;
    const upload = h.models.images.upload;
    h.models.images.upload = async (...args) => { const result = await upload(...args); uploads++; if (uploads === 1) await h.switchModel('responses'); return result; };
    h.handle(async (_payload, n) => n === 1 ? { tools: [tool('read_pdf_images', { documentId: document.documentId,
      sha256: document.sha256, readingId: reading.readingId, pages: [2] }, 'original-pdf-provider-call')] } : { text: '依据原第 2 页图像解释。' });
    const input = await h.input('解释第 2 页图像'); await h.advance(input.runId);
    const snapshot = await h.snapshot(input.runId);
    assert.equal(snapshot.run.state, 'completed', snapshot.run.reason); assert.equal(h.payloads.length, 2); assert.equal(uploads, 1);
    const images = payloadImages(h.payloads[1].payload); assert.equal(images.length, 1);
    const bytes = Buffer.from(images[0].image_url.split(',')[1], 'base64');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), reading.pages[0].image.sha256);
    assert.doesNotMatch(JSON.stringify(h.payloads[1].payload), /original-pdf-provider-call|PRIVATE_PROVIDER_SIGNATURE/);
    assert.equal(snapshot.steps.filter(step => step.operation.kind === 'tool.call').length, 1);
  }, { imageInput: true, scenario: { id: 'workspace-assistant', version: 1, context: async () => ({ system: '', facts: {}, sources: [] }) } });
});

for (const transition of ['prefix', 'route']) test('compaction and ' + transition + ' retain the original accepted effect, late Wait result and data-only course facts', { timeout: 60000 }, async () => {
  let effects = 0, prefix = 'HELP_POLICY_FIXED';
  const deadline = new Date(Date.now() + 60000).toISOString();
  const job = installedTool('job', 'execute', async () => { effects++;
    return { state: 'accepted', feedback: { outcome: 'success', text: '任务已接收，完成仍待确认。', images: [] }, result: { state: 'accepted' },
      wait: { kind: 'external', deadline, presentation: { owner: 'original-result-owner' } } };
  });
  await fixture('chat-completions', async h => {
    let summaries = 0;
    h.options.scenario.context = async () => ({ system: prefix, facts: { objective: 'PORTABLE_COURSE_OBJECTIVE',
      requirements: 'PORTABLE_COURSE_REQUIREMENT', materials: [{ title: 'PORTABLE_MATERIAL_TITLE', materialId: 'fixed-material' }] }, sources: [{ id: 'course-rule', version: 1 }] });
    h.handle(async (payload, n) => { const summary = compactionReply(payload); if (summary) { summaries++; return summary; }
      return n === 1 ? { text: '按原任务核对。', tools: [tool('job', {}, 'private-original-native-call')] } : { text: '只解释原操作与真实结果，不重做。' };
    });
    const input = await h.input('运行一次原任务'); await h.advance(input.runId);
    const before = await h.snapshot(input.runId), toolStep = before.steps.find(step => step.operation.kind === 'tool.call'), wait = before.waits.find(wait => wait.state === 'pending');
    await h.runtime.accept(h.identity, { requestId: randomUUID(), sessionId: h.sessionId, mode: 'queue', text: 'UNADOPTED_QUEUE_TEXT' });
    await h.input('补充：保留原计算，只解释后续结果。'); await h.advance(input.runId);
    assert.equal(h.payloads.length, 1, 'an accepted external effect remains a real wait, never a fabricated response');
    if (transition === 'route') await h.switchModel('responses'); else prefix += '\nPREFIX_CHANGED';
    const pending = (await h.snapshot(input.runId)).waits.find(item => item.waitId === wait.waitId);
    assert.equal(pending.state, 'pending'); assert.equal(pending.deadline, deadline); assert.equal(pending.response, null);
    await h.runtime.resolveWait(h.identity, h.sessionId, { requestId: randomUUID(), waitId: wait.waitId, expectedVersion: wait.version,
      result: { executionRef: 'original-execution', marker: 'LATE_ORIGINAL_RESULT' } });
    await h.advance(input.runId);
    const after = await h.snapshot(input.runId); assert.equal(after.run.state, 'completed'); assert.equal(effects, 1); assert.equal(summaries, 1);
    const payload = h.payloads.at(-1).payload, lines = (payload.messages ?? payload.input).flatMap(message => {
      const content = message.content; return (typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('')).split('\n');
    });
    const facts = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).find(item => item?.kind === 'continuation-facts');
    assert.ok(facts, 'actual model input must carry original structural effect and Wait facts independently of summary prose');
    assert.equal(facts.effects[0].commandId, toolStep.operation.operationId); assert.equal(facts.effects[0].state, 'accepted');
    const original = facts.waits.find(item => item.waitId === wait.waitId);
    assert.equal(original.commandId, toolStep.operation.operationId); assert.equal(original.deadline, deadline); assert.equal(original.state, 'consumed');
    assert.equal(original.response.marker, 'LATE_ORIGINAL_RESULT');
    const sent = JSON.stringify(payload); assert.doesNotMatch(sent, /UNADOPTED_QUEUE_TEXT|private-original-native-call|PRIVATE_PROVIDER_SIGNATURE/);
    const system = JSON.stringify(payload.system ?? payload.instructions ?? payload.messages?.filter(message => message.role === 'system') ?? '');
    assert.match(system, /HELP_POLICY_FIXED/); assert.doesNotMatch(system, /PORTABLE_COURSE_OBJECTIVE|PORTABLE_COURSE_REQUIREMENT|PORTABLE_MATERIAL_TITLE/);
    assert.equal(sent.split('PORTABLE_COURSE_OBJECTIVE').length - 1, 1);
    const paid = h.payloads.length; await h.reopen(); await h.snapshot(input.runId); assert.equal(h.payloads.length, paid);
    assert.equal((await h.snapshot(input.runId)).sessionState.waitFacts[0].waitId, wait.waitId);
  }, { tools: [job], compaction: { policy: { triggerChars: 1 } } });
});
