// Deterministic research only: public composition APIs, fake model and course tool.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as CheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
import { nativeFixture, toolName, toolInput, toolCallId } from '../fixtures.mjs';

const deferred = () => Promise.withResolvers();
const protocols = ['chat', 'responses', 'messages'];
const toolChunks = (name = toolName) => {
  const args = JSON.stringify(toolInput);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(toolCallId), name, argumentsDelta: args.slice(0, 7) },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(toolCallId), argumentsDelta: args.slice(7) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(toolCallId), name, arguments: args } },
  ];
};
const finish = (protocol, kind = 'tool-calls') => ({ type: 'finish', reason: { kind },
  replayState: { response: nativeFixture(protocol) } });
const stop = () => [{ type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture complete' } },
  { type: 'finish', reason: { kind: 'stop' } }];
function waitAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error('fixture aborted'));
    signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true });
  });
}
class FixtureAdapter extends LlmAdapter {
  scripts = new Map();
  requests = [];
  async resolveModel(provider, model) {
    return { provider, id: model, name: model };
  }
  async *stream(options) {
    this.requests.push({ sessionId: options.sessionId, messages: structuredClone(options.messages),
      tools: structuredClone(options.tools), aborted: options.signal.aborted });
    const entry = this.scripts.get(options.sessionId)?.shift();
    assert.ok(entry, `Unscripted request for ${options.sessionId}`);
    if (entry.inspect) entry.inspect(options);
    for (const chunk of entry.chunks ?? []) yield chunk;
    entry.ready?.resolve();
    if (entry.hang) await waitAbort(options.signal);
    if (entry.gate) await entry.gate.promise;
    if (entry.terminal) yield entry.terminal;
  }
}
async function makeRuntime(root, adapter, execute, beforeBatch) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(ProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  // Public custom-executor composition, used only as a crash-injection seam.
  const native = new NativeToolExecutor(ctx);
  ctx.tools.setExecutor({ describe: tools => native.describe(tools),
    async execute(input) {
      if (beforeBatch) await beforeBatch(ctx, input);
      return native.execute(input);
    } });
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' });
  await ctx.plugin(CheckpointPolicy);
  ctx.llm.registerAdapter(['fixture'], adapter);
  ctx.tools.register({ name: toolName, description: 'Fake course observation; no external effect',
    parameters: { type: 'object', properties: { objectRef: { type: 'string' } }, required: ['objectRef'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { observed: { type: 'string' } }, required: ['observed'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) { assert.deepEqual(args, toolInput); return execute(args, exec, ctx); },
  });
  const errors = [];
  ctx.on('agent/error', ({ error }) => errors.push(String(error)));
  return { ctx, errors };
}
const send = agent => agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture course observation' }] }));
const create = (ctx, id, protocol = 'responses') => ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'fixture', model: protocol } });
const events = agent => agent.session.snapshotEvents();
const endReasons = agent => events(agent).filter(e => e.type === 'turn/end').map(e => e.data.reason);
async function stored(ctx, id) {
  const handle = await ctx.sessionPersistence.open(SessionId(id), 'read');
  try { return (await handle.read()).events; } finally { await handle.close(); }
}
function nativeIn(messages, protocol) {
  const prior = messages.find(m => m.role === 'assistant' && m.source?.replayState);
  assert.ok(prior, 'expected prior assistant replay state');
  assert.deepEqual(prior.source.replayState.response, nativeFixture(protocol));
  return prior;
}
async function close(ctx, handles) {
  // Explicit handle disposal before root shutdown avoids the documented root flush limitation.
  for (const h of handles) { await ctx.sessions.flush(h.agent.session); await h.dispose(); }
  await ctx.fiber.dispose();
}
async function normal(root, protocol) {
  const adapter = new FixtureAdapter();
  const id = `normal-${protocol}`, ready = deferred(), gate = deferred();
  let bodies = 0, durableAtBody;
  adapter.scripts.set(id, [{ chunks: toolChunks(), ready, gate, terminal: finish(protocol) },
    { chunks: stop(), inspect: options => {
      nativeIn(options.messages, protocol);
      assert.ok(options.messages.some(m => m.source?.kind === 'tool' && m.source.callId === toolCallId));
      assert.deepEqual(options.tools.map(t => t.name), [toolName]);
    } }]);
  const { ctx, errors } = await makeRuntime(root, adapter, async (_args, exec) => {
    bodies++;
    const log = await stored(ctx, id);
    assert.ok(log.some(e => e.type === 'assistant/message'));
    assert.ok(log.some(e => e.type === 'tool/call'));
    nativeIn(log.filter(e => e.type === 'assistant/message').map(e => e.data.message), protocol);
    durableAtBody = log.map(e => e.type);
    return { observed: 'fixture-result' };
  });
  const h = await create(ctx, id, protocol);
  try {
    send(h.agent); await ready.promise;
    assert.equal(bodies, 0);
    assert.equal(events(h.agent).filter(e => e.type === 'assistant/message').length, 0);
    gate.resolve(); await h.agent.whenIdle();
    assert.equal(bodies, 1); assert.equal(adapter.requests.length, 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(endReasons(h.agent), [{ kind: 'completed' }]);
    await ctx.sessions.flush(h.agent.session);
    const durable = await stored(ctx, id);
    return { protocol, modelCalls: 2, toolBodies: bodies, noBodyBeforeFinish: true,
      completeNativeReplayEqual: true, toolResultPaired: true, durableAtBody,
      events: durable, status: 'passed' };
  } finally { await close(ctx, [h]); }
}
async function finishCase(root, kind) {
  const adapter = new FixtureAdapter(), id = `finish-${kind}`;
  const terminal = ['error', 'aborted'].includes(kind)
    ? { type: 'finish', reason: { kind, failure: { code: 'FIXTURE_FAILURE', message: 'fixture failed' } } }
    : kind === 'missing' ? undefined : kind === 'missing-guarded'
      ? { type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_TERMINAL', message: 'ModelGateway guard rejected missing terminal' } } }
      : finish('responses', kind);
  adapter.scripts.set(id, [{ chunks: toolChunks(), terminal }, { chunks: stop() }]);
  let bodies = 0;
  const { ctx, errors } = await makeRuntime(root, adapter, async () => { bodies++; return { observed: 'fixture-result' }; });
  const h = await create(ctx, id);
  try {
    send(h.agent); await h.agent.whenIdle();
    assert.equal(bodies, kind === 'missing' ? 1 : 0);
    return { case: kind, toolBodies: bodies, modelCalls: adapter.requests.length, endings: endReasons(h.agent), errors,
      status: kind === 'missing' ? 'upstream-contract-gap-confirmed' : 'passed',
      responsibility: kind === 'missing-guarded' ? 'fixture adapter emits error; application ModelGateway must enforce protocol terminal' : 'unmodified upstream behavior' };
  } finally { await close(ctx, [h]); }
}
async function cancelCase(root, activity) {
  const adapter = new FixtureAdapter(), a = `cancel-${activity}-a`, b = `cancel-${activity}-b`;
  const ar = deferred(), br = deferred(), bg = deferred();
  let aSignal, bSignal, aBodies = 0, bBodies = 0;
  adapter.scripts.set(a, activity === 'model'
    ? [{ chunks: toolChunks(), ready: ar, hang: true }, { chunks: stop() }]
    : [{ chunks: toolChunks(), terminal: finish('responses') }, { chunks: stop() }]);
  adapter.scripts.set(b, [{ chunks: toolChunks(), terminal: finish('responses') }, { chunks: stop() }]);
  const { ctx, errors } = await makeRuntime(root, adapter, async (_args, exec) => {
    if (exec.agent.id === a) { aBodies++; aSignal = exec.signal; ar.resolve(); await waitAbort(exec.signal); }
    bBodies++; bSignal = exec.signal; br.resolve(); await bg.promise;
    assert.equal(exec.signal.aborted, false);
    return { observed: 'fixture-result' };
  });
  const ah = await create(ctx, a), bh = await create(ctx, b);
  try {
    send(ah.agent); send(bh.agent); await Promise.all([ar.promise, br.promise]);
    ah.agent.cancel({ kind: 'user' }); await ah.agent.whenIdle();
    assert.equal(bSignal.aborted, false);
    assert.equal(endReasons(bh.agent).length, 0);
    if (activity === 'tool') assert.equal(aSignal.aborted, true);
    bg.resolve(); await bh.agent.whenIdle();
    assert.deepEqual(endReasons(bh.agent), [{ kind: 'completed' }]);
    send(ah.agent); await ah.agent.whenIdle();
    assert.deepEqual(endReasons(ah.agent), [{ kind: 'aborted', reason: { kind: 'user' } }, { kind: 'completed' }]);
    return { activity, aBodies, bBodies, aEndings: endReasons(ah.agent), bEndings: endReasons(bh.agent),
      bSignalUnabortedDuringCancel: true, aAcceptsNextTurn: true, errors, status: 'passed' };
  } finally { bg.resolve(); await close(ctx, [ah, bh]); }
}
async function unknownName(root) {
  const adapter = new FixtureAdapter(), id = 'unknown-tool-name';
  adapter.scripts.set(id, [{ chunks: toolChunks('not_registered'), terminal: finish('responses') }, { chunks: stop() }]);
  let bodies = 0;
  const { ctx } = await makeRuntime(root, adapter, async () => { bodies++; return { observed: 'fixture-result' }; });
  const h = await create(ctx, id);
  try {
    send(h.agent); await h.agent.whenIdle(); assert.equal(bodies, 0);
    const results = events(h.agent).filter(e => e.type === 'tool/result');
    assert.equal(results.length, 1); assert.equal(results[0].data.message.isError, true);
    return { status: 'passed', bodies, results };
  } finally { await close(ctx, [h]); }
}
async function crashChild(root, mode, protocol) {
  const adapter = new FixtureAdapter(), id = `crash-${mode}-${protocol}`;
  adapter.scripts.set(id, [{ chunks: toolChunks(), terminal: finish(protocol) }]);
  const park = async (ctx, where) => {
    const log = await stored(ctx, id);
    await writeFile(join(root, 'pre-crash.json'), JSON.stringify(log, null, 2));
    process.send({ ready: true, where, eventTypes: log.map(e => e.type) });
    await new Promise(() => { setInterval(() => {}, 1000); });
  };
  const { ctx } = await makeRuntime(root, adapter, async (_args, _exec, context) => {
    // This durable file is a FAKE external executor receipt, never a real course effect.
    await appendFile(join(root, 'fake-executor-receipts.jsonl'), JSON.stringify({ commandId: `${id}:${toolCallId}`, accepted: true }) + '\n');
    await park(context, 'tool-accepted-receipt-not-returned');
  }, mode === 'complete' ? async (context, input) => {
    // Fault injection only. Native executor has not yet logged tool/call.
    await context.sessions.flush(input.agent.session);
    await park(context, 'complete-response-before-tool-call');
  } : undefined);
  const h = await create(ctx, id, protocol); send(h.agent);
}
async function recover(root, mode, protocol) {
  const child = fork(process.argv[1], ['child', root, mode, protocol], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let childOutput = '';
  child.stderr.on('data', b => { childOutput += b; });
  child.stdout.on('data', b => { childOutput += b; });
  let marker;
  try {
    marker = await Promise.race([once(child, 'message').then(([m]) => m), once(child, 'exit').then(([code, signal]) => { throw new Error(`child premature exit ${code}/${signal}: ${childOutput}`); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL');
    const [code, signal] = await exited; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  const preCrash = JSON.parse(await readFile(join(root, 'pre-crash.json'), 'utf8'));
  assert.equal(preCrash.filter(e => e.type === 'assistant/message').length, 1);
  assert.equal(preCrash.filter(e => e.type === 'tool/call').length, mode === 'complete' ? 0 : 1);
  assert.equal(preCrash.filter(e => e.type === 'tool/result').length, 0);
  const adapter = new FixtureAdapter(), id = `crash-${mode}-${protocol}`;
  let bodies = 0, queries = 0;
  adapter.scripts.set(id, [{ chunks: stop(), inspect: o => nativeIn(o.messages, protocol) }]);
  const { ctx, errors } = await makeRuntime(root, adapter, async () => { bodies++; return { observed: 'unexpected replay' }; });
  const h = await ctx.agents.resume({ resumeSessionId: SessionId(id) });
  try {
    await h.agent.whenIdle();
    assert.equal(adapter.requests.length, 0); assert.equal(bodies, 0);
    const resumed = events(h.agent);
    nativeIn(resumed.filter(e => e.type === 'assistant/message').map(e => e.data.message), protocol);
    const results = resumed.filter(e => e.type === 'tool/result');
    assert.equal(results[0].data.error.code, mode === 'complete' ? 'TOOL_NOT_STARTED' : 'TOOL_OUTCOME_UNKNOWN');
    let queriedReceipt;
    if (mode === 'unknown') {
      // Application-owned stable identity query. Harness does not perform this query.
      const receipts = (await readFile(join(root, 'fake-executor-receipts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      queries++;
      queriedReceipt = receipts.find(r => r.commandId === `${id}:${toolCallId}`);
      assert.deepEqual(queriedReceipt, { commandId: `${id}:${toolCallId}`, accepted: true });
      assert.equal(receipts.length, 1);
    }
    // A deliberate NEW user turn uses restored native data; no model requery for the old intent.
    send(h.agent); await h.agent.whenIdle(); assert.equal(adapter.requests.length, 1); assert.equal(bodies, 0);
    return { mode, protocol, marker, signal: 'SIGKILL', preCrash, restoredEvents: resumed,
      repair: results[0], nativeEqual: true, modelCallsOnResume: 0, modelCallsAfterNewPrompt: 1,
      replayedBodies: bodies, applicationReceiptQueries: queries, queriedReceipt, errors, status: 'passed',
      limitation: mode === 'complete' ? 'resume repairs unstarted call; does not automatically dispatch saved intent' : 'unknown repair does not query external receipt automatically' };
  } finally { await close(ctx, [h]); }
}
if (process.argv[2] === 'child') {
  await crashChild(...process.argv.slice(3));
} else {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-harness-data-'));
  const results = { runtime: { node: process.version, platform: process.platform, arch: process.arch },
    upstream: '22ddee3792402c3e70ec5f86a63c3e3e895a2f60', normal: [], terminal: [], cancellation: [], recovery: [] };
  const step = async (label, run) => { console.error(`RUN ${label}`); const value = await run(); console.error(`OK ${label}`); return value; };
  try {
    for (const protocol of protocols) results.normal.push(await step(`normal ${protocol}`, () => normal(join(root, `normal-${protocol}`), protocol)));
    for (const kind of ['error', 'aborted', 'max-tokens', 'missing', 'missing-guarded']) results.terminal.push(await step(`terminal ${kind}`, () => finishCase(join(root, `finish-${kind}`), kind)));
    for (const activity of ['model', 'tool']) results.cancellation.push(await step(`cancel ${activity}`, () => cancelCase(join(root, `cancel-${activity}`), activity)));
    results.unknownToolName = await step('unknown tool name', () => unknownName(join(root, 'unknown-name')));
    for (const mode of ['complete', 'unknown']) for (const protocol of protocols) {
      const dir = join(root, `recover-${mode}-${protocol}`);
      results.recovery.push(await step(`recover ${mode} ${protocol}`, () => recover(dir, mode, protocol)));
    }
    results.status = 'completed';
    console.log(JSON.stringify(results, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}
