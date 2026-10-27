// RESEARCH ONLY: deterministic model/tool fixtures, local scratch SQLite, no network calls.
// Usage: PROBE_DEPS=/absolute/scratch/node_modules node probe.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { nativeFixture, toolCallId, toolName, toolInput } from '../fixtures.mjs';

const deps = process.env.PROBE_DEPS;
if (!deps) throw new Error('Set PROBE_DEPS to the temporary installation node_modules directory');
const { Agent } = await import(pathToFileURL(join(deps, '@earendil-works/pi-agent-core/dist/index.js')));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(deps, '@earendil-works/pi-ai/dist/index.js')));
const clone = structuredClone;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: 'fixture-model', name: 'fixture-model', api: 'openai-responses',
  provider: 'fixture-provider', baseUrl: 'https://invalid.example', reasoning: false,
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000, maxTokens: 1000 };

function store(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return {
    get(key) { const row = db.prepare('SELECT value FROM records WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined; },
    put(key, value) { db.prepare('INSERT INTO records VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); },
    close() { db.close(); },
  };
}

function initial(mode, scenario, protocol) {
  return { mode, scenario, protocol, phase: 'model', status: 'active', attempts: 0,
    budget: scenario === 'budget' ? 1 : 4, native: [], messages: [],
    trace: [], allowed: true, objectVersion: 1, expectedVersion: 1 };
}

function projected(tool = true, reason = tool ? 'toolUse' : 'stop') {
  return { role: 'assistant', content: tool
    ? [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: clone(toolInput) }]
    : [{ type: 'text', text: 'fixture complete' }],
    api: model.api, provider: model.provider, model: model.id,
    usage: clone(usage), stopReason: reason, timestamp: 0 };
}

function toolResult(result) {
  return { role: 'toolResult', toolCallId, toolName,
    content: [{ type: 'text', text: JSON.stringify(result) }], details: result,
    isError: result.status === 'denied', timestamp: 0 };
}

function rawToolResult(protocol, result) {
  const content = JSON.stringify(result);
  if (protocol === 'chat') return { role: 'tool', tool_call_id: toolCallId, content };
  if (protocol === 'responses') return { type: 'function_call_output', call_id: toolCallId, output: content };
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCallId, content }] };
}

async function worker(folder, phase) {
  const runs = store(join(folder, 'run.sqlite'));
  const executor = store(join(folder, 'executor.sqlite'));
  const state = runs.get('run');
  const save = () => runs.put('run', state);
  const cut = (where) => {
    const selected = ['revoked', 'changed_object'].includes(state.scenario) ? 'after_complete' : state.scenario;
    if (phase === 'first' && selected === where) process.exit(73);
  };
  let candidateRaw;

  // ModelGateway substitute: terminal classification, raw record and projection are application work.
  function nextModel() {
    if (state.attempts >= state.budget) {
      state.status = 'budget_exhausted'; save();
      return { ...projected(false, 'error'), errorMessage: 'fixture budget exhausted' };
    }
    state.attempts++;
    state.trace.push('model_attempt'); save();
    cut('before_complete');
    if (state.scenario === 'partial' && state.attempts === 1) {
      state.status = 'model_interrupted'; save();
      return { ...projected(true, 'error'), errorMessage: 'fixture missing successful terminal' };
    }
    const first = state.attempts === 1;
    candidateRaw = first ? nativeFixture(state.protocol) : { fixture_final: true, protocol: state.protocol };
    return projected(first);
  }

  function commitAssistant(message, transcript) {
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      state.error = message.errorMessage;
      if (state.status === 'active') state.status = 'failed';
      state.messages = clone(transcript); save(); return;
    }
    if (state.scenario === 'save_failure') throw new Error('fixture persistence failure');
    assert(candidateRaw, 'a complete native response must accompany its projection');
    state.native.push({ kind: 'assistant', raw: clone(candidateRaw) });
    state.messages = clone(transcript);
    state.phase = message.stopReason === 'toolUse' ? 'tool' : 'done';
    if (state.phase === 'tool') state.command = { id: 'fixture-run/step-1/tool-1', input: clone(toolInput) };
    else state.status = 'completed';
    state.trace.push('assistant_committed'); save();
    candidateRaw = undefined;
    if (state.phase === 'tool') cut('after_complete');
  }

  // Separate executor DB represents a component whose accepted result can outlive the caller.
  // Stable identity, querying and execution-time checks are host responsibilities in BOTH modes.
  function executeOrQuery() {
    assert.equal(state.phase, 'tool');
    assert.equal(state.native[0].kind, 'assistant');
    let command = executor.get(state.command.id);
    if (command) {
      assert.deepEqual(command.input, state.command.input);
      state.trace.push('query_existing'); save();
      return command.result;
    }
    if (!state.allowed || state.objectVersion !== state.expectedVersion) {
      state.trace.push('execution_denied'); save();
      return { status: 'denied' };
    }
    const waiting = ['wait', 'cancel_wait'].includes(state.scenario);
    command = { input: clone(state.command.input), effectCount: waiting ? 0 : 1,
      result: { status: waiting ? 'pending' : 'completed', observation: 'fixture-observation' } };
    executor.put(state.command.id, command);
    state.trace.push('executor_accepted'); save();
    cut('after_accept');
    return command.result;
  }

  function acceptTool(result, transcript) {
    if (result.status === 'pending') {
      state.status = 'waiting'; save(); return;
    }
    state.native.push({ kind: 'tool', raw: rawToolResult(state.protocol, result) });
    state.messages = clone(transcript);
    state.phase = 'model'; state.status = 'active';
    state.trace.push('tool_result_committed'); save();
  }

  try {
    if (state.status === 'cancelled') return;
    if (phase === 'resume' && state.scenario === 'before_complete') {
      state.status = 'model_outcome_unknown'; save(); return;
    }
    // Core cannot continue from an assistant tool call. The wrapper must recover that boundary.
    if (phase === 'resume' && state.phase === 'tool') {
      const result = executeOrQuery();
      if (result.status === 'pending') { state.status = 'waiting'; save(); return; }
      acceptTool(result, [...state.messages, toolResult(result)]);
    }

    if (state.mode === 'self') {
      while (state.status === 'active') {
        if (state.phase === 'model') {
          const message = nextModel();
          if (message.stopReason === 'error') { save(); return; }
          commitAssistant(message, [...state.messages, message]);
        }
        if (state.phase === 'tool') {
          const result = executeOrQuery();
          acceptTool(result, [...state.messages, toolResult(result)]);
        }
      }
      return;
    }

    const agent = new Agent({
      initialState: { model, messages: state.messages, tools: [{
        name: toolName, label: toolName, description: 'fixture course observation',
        parameters: { type: 'object', properties: { objectRef: { type: 'string' } }, required: ['objectRef'] },
        execute: async () => {
          const result = executeOrQuery();
          if (result.status === 'pending') { state.status = 'waiting'; save(); }
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        },
      }] },
      streamFn: () => {
        const stream = new AssistantMessageEventStream();
        const message = nextModel();
        // Simulate a partially streamed call followed by an adapter-classified failure.
        stream.push({ type: 'start', partial: projected(true) });
        if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
        else stream.push({ type: 'done', reason: message.stopReason, message });
        return stream;
      },
      finishTurn: () => state.status === 'waiting' ? { action: 'end' } : undefined,
    });
    agent.subscribe(async (event) => {
      if (event.type !== 'message_end') return;
      if (event.message.role === 'assistant') commitAssistant(event.message, agent.state.messages);
      if (event.message.role === 'toolResult') {
        // Pending receipt is a transient projection; no incomplete result is sent to the model.
        if (event.message.details?.status !== 'pending') acceptTool(event.message.details, agent.state.messages);
      }
    });
    if (phase === 'first') await agent.prompt('observe the fixture object');
    else await agent.continue();
  } catch (error) {
    state.error = String(error.message); state.status = 'failed'; save();
    if (state.scenario !== 'save_failure') throw error;
  } finally {
    runs.close(); executor.close();
  }
}

if (process.argv[2] === '--worker') {
  await worker(process.argv[3], process.argv[4]);
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'xunjie-core-probe-'));
  const results = [];
  const runChild = (folder, phase, expected = 0) => {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', folder, phase],
      { encoding: 'utf8', env: process.env, timeout: 20000 });
    assert.equal(result.status, expected, `${phase}: ${result.stderr}`);
  };
  try {
    for (const mode of ['self', 'pi-core']) {
      for (const protocol of ['chat', 'responses', 'messages']) {
        for (const scenario of ['normal', 'partial', 'save_failure', 'before_complete', 'after_complete', 'after_accept', 'wait', 'cancel_wait', 'budget', 'revoked', 'changed_object']) {
          const folder = mkdtempSync(join(scratch, `${mode}-${protocol}-${scenario}-`));
          const runs = store(join(folder, 'run.sqlite'));
          const executor = store(join(folder, 'executor.sqlite'));
          const st = initial(mode, scenario, protocol);
          runs.put('run', st);
          const crash = ['before_complete', 'after_complete', 'after_accept', 'revoked', 'changed_object'].includes(scenario);
          runChild(folder, 'first', crash ? 73 : 0);
          if (scenario === 'revoked' || scenario === 'changed_object') {
            const state = runs.get('run');
            if (scenario === 'revoked') state.allowed = false;
            else state.objectVersion = 2;
            runs.put('run', state);
          }
          if (crash) runChild(folder, 'resume');
          if (['wait', 'cancel_wait'].includes(scenario)) {
            assert.equal(runs.get('run').status, 'waiting');
            assert.equal(runs.get('run').attempts, 1);
            const command = executor.get('fixture-run/step-1/tool-1');
            command.result.status = 'completed'; command.effectCount = 1;
            executor.put('fixture-run/step-1/tool-1', command);
            if (scenario === 'cancel_wait') { const state = runs.get('run'); state.status = 'cancelled'; runs.put('run', state); }
            runChild(folder, 'resume');
          }
          const end = runs.get('run');
          const effectCount = executor.get('fixture-run/step-1/tool-1')?.effectCount ?? 0;
          const noEffect = ['partial', 'save_failure', 'before_complete', 'revoked', 'changed_object'].includes(scenario);
          assert.equal(effectCount, noEffect ? 0 : 1, `${mode}/${protocol}/${scenario}: effect count`);
          if (!['partial', 'save_failure', 'before_complete'].includes(scenario)) {
            assert.deepEqual(end.native[0].raw, nativeFixture(protocol), 'native record survives child restart and JSON SQLite round trip');
          }
          if (scenario === 'before_complete') { assert.equal(end.status, 'model_outcome_unknown'); assert.equal(end.attempts, 1); }
          else if (scenario === 'partial') { assert.equal(end.status, 'model_interrupted'); assert.equal(end.attempts, 1); }
          else if (scenario === 'budget') { assert.equal(end.status, 'budget_exhausted'); assert.equal(end.attempts, 1); }
          else if (scenario === 'cancel_wait') { assert.equal(end.status, 'cancelled'); assert.equal(end.attempts, 1); }
          else if (scenario !== 'save_failure') { assert.equal(end.status, 'completed'); assert.equal(end.attempts, 2); }
          if (scenario === 'after_accept') assert(end.trace.includes('query_existing'));
          if (scenario === 'save_failure') { assert.equal(end.native.length, 0); assert.equal(end.status, 'failed'); }
          results.push({ mode, protocol, scenario, passed: true, modelAttempts: end.attempts,
            effects: effectCount, status: end.status, error: end.error ?? null });
          runs.close(); executor.close();
        }
      }
    }
    let directCalls = 0;
    const bare = new Agent({ initialState: { model, messages: [projected(true)] },
      streamFn: () => { directCalls++; throw new Error('unexpected model call'); } });
    await assert.rejects(() => bare.continue(), /Cannot continue from message role: assistant/);
    assert.equal(directCalls, 0);
    results.push({ scenario: 'bare-core-assistant-resume', expectedLimitation: true,
      observed: 'Cannot continue from message role: assistant', modelAttempts: directCalls });

    // Verify the actual Agent waits for an async persistence barrier before dispatching a tool.
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let atBarrier;
    const reached = new Promise(resolve => { atBarrier = resolve; });
    let toolExecutions = 0;
    const gated = new Agent({ initialState: { model, tools: [{ name: toolName, label: toolName,
      description: 'fixture', parameters: { type: 'object', properties: {} },
      execute: async () => { toolExecutions++; return { content: [{ type: 'text', text: 'done' }], details: {} }; } }] },
      finishTurn: () => ({ action: 'end' }),
      streamFn: () => { const s = new AssistantMessageEventStream(); s.push({ type: 'done', reason: 'toolUse', message: projected(true) }); return s; } });
    gated.subscribe(async event => { if (event.type === 'message_end' && event.message.role === 'assistant') { atBarrier(); await barrier; } });
    const inFlight = gated.prompt('fixture');
    await reached;
    assert.equal(toolExecutions, 0);
    release(); await inFlight;
    assert.equal(toolExecutions, 1);
    results.push({ scenario: 'async-persistence-barrier', passed: true, toolsBeforeRelease: 0, toolsAfterRelease: 1 });

    let modelStarted;
    const started = new Promise(resolve => { modelStarted = resolve; });
    const cancellable = new Agent({ initialState: { model }, streamFn: (_model, _context, options) => {
      const stream = new AssistantMessageEventStream();
      options.signal.addEventListener('abort', () => stream.push({ type: 'error', reason: 'aborted',
        error: { ...projected(false, 'aborted'), errorMessage: 'fixture aborted' } }), { once: true });
      modelStarted();
      return stream;
    } });
    const independent = new Agent({ initialState: { model }, streamFn: () => {
      const stream = new AssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: projected(false) });
      return stream;
    } });
    const cancelledRun = cancellable.prompt('fixture cancellation');
    await started;
    const otherRun = independent.prompt('fixture independent');
    cancellable.abort();
    await Promise.all([cancelledRun, otherRun]);
    assert.equal(cancellable.state.messages.at(-1).stopReason, 'aborted');
    assert.equal(independent.state.messages.at(-1).stopReason, 'stop');
    results.push({ scenario: 'per-agent-cancellation', passed: true, cancelled: 'aborted', independent: 'stop' });

    const version = JSON.parse(readFileSync(join(deps, '@earendil-works/pi-agent-core/package.json'))).version;
    process.stdout.write(JSON.stringify({ date: '2026-10-27', runtime: process.version,
      platform: process.platform, arch: process.arch, piCoreVersion: version,
      providerCalls: 0, productionCode: false, cases: results.length, results }, null, 2) + '\n');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
