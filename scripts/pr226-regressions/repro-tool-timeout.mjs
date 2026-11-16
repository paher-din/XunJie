import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';
import { AgentError } from '../../packages/agent-runtime/dist/errors.js';
import { executeTools, createToolRegistry } from '../../packages/agent-runtime/dist/tools.js';
import { randomUUID } from 'node:crypto';

function fixture(executors, overrides = {}) {
  const controller = new AbortController();
  const results = new Map(), started = [], contexts = [];
  const calls = executors.map((_, index) => ({ toolCallId: `call-${index}`, nativeCallId: `native-${index}`,
    callIndex: index, name: `tool-${index}`, input: {}, executionMode: 'foreground', state: 'pending' }));
  const options = {
    calls, signal: controller.signal,
    budget: { maxCallMs: 10, deadline: new Date(Date.now() + 1000).toISOString() },
    registry: createToolRegistry(executors.map((execute, index) => ({
      definition: { name: `tool-${index}` }, supportsBackground: true, execute,
    }))),
    store: {
      async startToolCall(id) { started.push(id); return true; },
      async saveToolResult(id, result, taskId) {
        assert.equal(results.has(id), false, 'a closed timeout result cannot be rewritten by late completion');
        results.set(id, { result, taskId }); return false;
      },
    },
    isActive: async () => !controller.signal.aborted,
    contextFor(call) {
      const context = { sessionId: 'session', turnId: 'turn', stepId: 'step', toolCallId: call.toolCallId,
        signal: controller.signal, inputIds: [], originInputId: null, visibleAnswerInputIds: [],
        async assertActive() { controller.signal.throwIfAborted(); },
      };
      contexts.push(context); return context;
    },
    ...overrides,
  };
  return { options, controller, results, started, contexts, run: () => executeTools(options) };
}
const success = { kind: 'completed', outcome: 'success', summary: 'done' };

test('timeout leaves a late external write unknown, aborts only that call, and continues the batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let written = false, received, aborted = false, nextSignal;
  const h = fixture([
    async (_call, ctx) => {
      received = ctx;
      ctx.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      await new Promise(resolve => setTimeout(resolve, 50));
      written = true; // The external owner ignored cancellation; its write still committed.
      return success;
    },
    async (_call, ctx) => { nextSignal = ctx.signal; await ctx.assertActive(); return success; },
  ]);
  const running = h.run(); await nextTick();
  t.mock.timers.tick(10); await nextTick();
  assert.equal(await running, 'done');
  assert.equal(h.results.get('call-0').result.kind, 'outcome_unknown');
  assert.equal(aborted, true, 'the executor receives the timeout cancellation signal');
  await assert.rejects(() => received.assertActive(), 'writes after timeout must fail the call fence');
  assert.equal(h.controller.signal.aborted, false);
  assert.equal(nextSignal.aborted, false);
  assert.equal(h.results.get('call-1').result.kind, 'completed');
  t.mock.timers.tick(40); await nextTick();
  assert.equal(written, true);
  assert.equal(h.results.get('call-0').result.kind, 'outcome_unknown');
});

test('timeout preserves known handles and redelivers cancellation for a late acceptance of only this call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const deliveries = [], tasks = new Map([
    ['late-task', { turnId: 'turn', callId: 'call-0', cancelled: false }],
    ['same-turn-other-call', { turnId: 'turn', callId: 'call-1', cancelled: false }],
    ['previous-turn', { turnId: 'previous-turn', callId: 'other', cancelled: false }],
  ]);
  const h = fixture([async (_call, ctx) => {
    await ctx.reportEffect?.({ requestRef: 'owner-request' });
    await new Promise(resolve => setTimeout(resolve, 50));
    return { kind: 'accepted', taskId: 'late-task', summary: 'accepted' };
  }], {
    async onCallTimeout(call, reference) {
      deliveries.push({ callId: call.toolCallId, ...reference });
      const task = tasks.get(reference.taskId);
      if (task?.turnId === 'turn' && task.callId === call.toolCallId) task.cancelled = true;
    },
  });
  const running = h.run(); await nextTick(); t.mock.timers.tick(10); await nextTick();
  assert.equal(await running, 'done');
  assert.equal(h.results.get('call-0').result.requestRef, 'owner-request');
  assert.deepEqual(deliveries, [{ callId: 'call-0', requestRef: 'owner-request' }]);
  t.mock.timers.tick(40); await nextTick();
  assert.equal(deliveries.at(-1).taskId, 'late-task');
  assert.equal(tasks.get('late-task').cancelled, true);
  assert.equal(tasks.get('same-turn-other-call').cancelled, false);
  assert.equal(tasks.get('previous-turn').cancelled, false);
  assert.equal(h.results.get('call-0').result.kind, 'outcome_unknown');
});

test('business-managed waits outlive the ordinary RPC timeout but never the Turn deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let signal;
  const h = fixture([async (_call, ctx) => {
    signal = ctx.signal;
    await new Promise(resolve => setTimeout(resolve, 50));
    return success;
  }]);
  h.options.registry.get('tool-0').timeoutPolicy = 'business';
  const running = h.run(); await nextTick();
  t.mock.timers.tick(10); await nextTick();
  assert.equal(h.results.size, 0, 'question/task waiting is not a short RPC');
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(40); await nextTick();
  assert.equal(await running, 'done');
  assert.equal(h.results.get('call-0').result.kind, 'completed');

  const blocked = fixture([async () => new Promise(() => {})]);
  blocked.options.registry.get('tool-0').timeoutPolicy = 'business';
  blocked.options.budget.deadline = new Date(Date.now() + 20).toISOString();
  const hardLimit = blocked.run(); await nextTick();
  t.mock.timers.tick(20); await nextTick();
  assert.equal(await hardLimit, 'done');
  assert.equal(blocked.results.get('call-0').result.kind, 'outcome_unknown');
});

test('Stop aborts a tool immediately and a late acceptance reopens durable Turn cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let accepted, abortSeen = false, reopened = 0;
  const h = fixture([
    async (_call, ctx) => {
      ctx.signal.addEventListener('abort', () => { abortSeen = true; }, { once: true });
      return new Promise(resolve => { accepted = resolve; });
    },
    async () => assert.fail('Stop must not start the next call'),
  ], {
    async onLateAcceptance() { reopened++; },
  });
  const saves = [];
  h.options.store.saveToolResult = async (id, result, taskId) => { saves.push({ id, result, taskId }); return true; };
  const running = h.run(); await nextTick();
  h.controller.abort(); await nextTick();
  assert.equal(await running, 'stopped');
  assert.equal(abortSeen, true);
  assert.deepEqual(h.started, ['call-0']);
  accepted({ kind: 'accepted', taskId: 'late-after-stop', summary: 'accepted' }); await nextTick();
  assert.equal(reopened, 1);
  assert.deepEqual(saves.map(s => s.taskId), ['late-after-stop']);
});

test('accepted result racing with Stop during the active check still reaches the late-acceptance fence', async () => {
  let checks = 0, reopened = 0;
  const h = fixture([async () => ({ kind: 'accepted', taskId: 'race-task', summary: 'accepted' })], {
    async isActive() { return ++checks === 1; },
    async onLateAcceptance() { reopened++; },
  });
  h.options.store.saveToolResult = async (_id, result) => { assert.equal(result.taskId, 'race-task'); return true; };
  assert.equal(await h.run(), 'stopped');
  assert.equal(reopened, 1);
});

test('a timeout before dispatch is provably not_started and cannot later execute', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let release, dispatched = false;
  const h = fixture([async () => { dispatched = true; return success; }]);
  h.options.contextFor = () => ({ signal: h.controller.signal,
    assertActive: () => new Promise(resolve => { release = resolve; }),
  });
  const running = h.run(); await nextTick();
  t.mock.timers.tick(10); await nextTick();
  assert.equal(await running, 'done');
  assert.equal(h.results.get('call-0').result.kind, 'not_started');
  release(); await nextTick();
  assert.equal(dispatched, false);
});

test('timeout racing with Stop still queues cancellation and observes a later acceptance', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let received, accepted;
  const deliveries = [];
  const h = fixture([async (_call, ctx) => {
    received = ctx;
    await ctx.reportEffect?.({ taskId: 'known-task', requestRef: 'known-request' });
    return new Promise(resolve => { accepted = resolve; });
  }], {
    async onCallTimeout(call, ref) { deliveries.push({ callId: call.toolCallId, ...ref }); },
  });
  const running = h.run(); await nextTick();
  t.mock.timers.tick(10); h.controller.abort(); await nextTick();
  assert.equal(await running, 'stopped');
  assert.equal(received.signal.aborted, true);
  assert.ok(deliveries.some(d => d.taskId === 'known-task' && d.requestRef === 'known-request'));
  accepted({ kind: 'accepted', taskId: 'late-task', summary: 'accepted' }); await nextTick();
  assert.equal(deliveries.at(-1).taskId, 'late-task');
});

test('unknown-effect handles survive real PG persistence, Gateway feedback and subsequent history', {
  skip: !process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
}, async () => {
  const { harness, input } = await import('./harness.mjs');
  const tool = { definition: { name: 'write', description: 'write', inputSchema: { type: 'object' } },
    supportsBackground: false,
    async execute() { return { kind: 'outcome_unknown', reason: '执行效果未知，请查询', taskId: 'owner-task', requestRef: 'owner-request' }; },
  };
  const h = await harness([
    { text: 'write', toolIntents: [{ callId: 'write', name: 'write', arguments: {} }] },
    { text: 'query the existing request' },
  ], [tool]);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, 'write once'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.toolCalls[0].result.kind, 'outcome_unknown');
    const feedback = h.gateway.settles[0].results[0].text;
    assert.ok(feedback.includes('owner-task'), 'Gateway must receive the queryable taskId');
    assert.ok(feedback.includes('owner-request'), 'Gateway must receive the queryable requestRef');
    const { rows: [row] } = await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1', [h.session.sessionId]);
    const history = row.state.history.find(entry => entry.id === snap.toolCalls[0].toolCallId);
    const retained = JSON.parse(history.text);
    assert.equal(retained.taskId, 'owner-task');
    assert.equal(retained.requestRef, 'owner-request');
    assert.ok(retained.summary.includes('执行效果未知'));
  } finally { await h.close(); }
});

test('real dependency adapters propagate business offers, references, deadline, segment and call-scoped abort', async () => {
  const { createAgentDependencyService, createAgentDependencyClient } = await import('../../packages/agents/dist/transport/session-dependencies.js');
  const sessionId = randomUUID(), turnId = randomUUID(), stepId = randomUUID(), toolCallId = randomUUID(), segmentId = randomUUID();
  const identity = { kind: 'personal', name: 'test', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const target = { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 };
  const session = { identity, sessionId, scenario: 'student-assistant', state: 'ready', deleted: false,
    owner: { target, installationId: randomUUID() } };
  const source = { assertAuthorized: async () => {}, sourceEnvironmentId: target.environmentId,
    sourceServiceId: target.serviceId, sourceInstallationId: session.owner.installationId };
  let remote, release, guards = 0;
  const service = createAgentDependencyService({ sessions: { read: async () => session }, learning: {}, courses: {},
    authorize: async () => {}, assertDispatch: async () => { guards++; },
    tools: async () => [{ definition: { name: 'remote', description: 'remote', inputSchema: { type: 'object' } },
      timeoutPolicy: 'business', supportsBackground: true,
      async execute(_call, ctx) {
        remote = ctx;
        await ctx.assertActive();
        await ctx.reportEffect?.({ taskId: 'real-task', requestRef: 'real-request' });
        await new Promise(resolve => { release = resolve; ctx.signal.addEventListener('abort', resolve, { once: true }); });
        return { kind: 'accepted', taskId: 'real-task', summary: 'late receipt' };
      } }],
  });
  const client = createAgentDependencyClient(call => service(JSON.parse(JSON.stringify(call)), source));
  const context = { sessionId, turnId, stepId, toolCallId, context: { system: '', facts: {}, sources: [] }, inputIds: [] };
  const [tool] = await client.forSession(identity, sessionId).tools(context);
  const controller = new AbortController(), references = [];
  const deadline = new Date(Date.now() + 5000).toISOString();
  const running = tool.execute({ toolCallId, nativeCallId: 'remote', callIndex: 0, name: 'remote', input: {}, executionMode: 'foreground' },
    { ...context, identity, signal: controller.signal, deadline, segmentId, originInputId: null, visibleAnswerInputIds: [],
      assertActive: async () => controller.signal.throwIfAborted(), reportEffect: async ref => { references.push(ref); } });
  try {
    for (let n = 0; n < 100 && !remote; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(remote, 'the remote tool actually executes');
    assert.equal(remote.deadline, deadline);
    assert.equal(remote.segmentId, segmentId);
    assert.equal(tool.timeoutPolicy, 'business');
    for (let n = 0; n < 100 && !references.some(ref => ref.taskId === 'real-task'); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(references.some(ref => ref.taskId === 'real-task' && ref.requestRef === 'real-request'));
    const before = guards; await remote.assertActive(); assert.ok(guards > before, 'remote fence checks the live permit');
    controller.abort();
    for (let n = 0; n < 100 && !remote.signal.aborted; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(remote.signal.aborted, true);
    await assert.rejects(() => remote.assertActive());
    assert.equal((await running).taskId, 'real-task');
  } finally { controller.abort(); release?.(); await running.catch(() => {}); }
});

test('question tool declares a business wait and caps its own question deadline at the Turn deadline', async () => {
  const { createUserQuestions } = await import('../../packages/agents/dist/capabilities/user-questions/index.js');
  const tool = createUserQuestions(), deadline = new Date(Date.now() + 1000).toISOString(); let seen;
  await tool.execute({ input: { question: 'continue?', source: 'test', options: [], allowText: true, skippable: true } }, {
    toolCallId: randomUUID(), originInputId: randomUUID(), inputIds: [], deadline,
    ask: async input => { seen = input; return { kind: 'closed' }; },
  });
  assert.equal(tool.timeoutPolicy, 'business');
  assert.equal(seen.deadline, deadline);
});

test('a business timeout result queues durable cancellation while an ordinary timeout without a task does not', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cancellations = [];
  const h = fixture([async (_call, ctx) => {
    await ctx.reportEffect?.({ taskId: 'control-id', requestRef: 'parent-request' });
    return { kind: 'outcome_unknown', reason: 'business wait expired', taskId: 'control-id', requestRef: 'parent-request' };
  }], { onCallTimeout: async (call, ref) => { cancellations.push({ callId: call.toolCallId, ...ref }); } });
  h.options.registry.get('tool-0').timeoutPolicy = 'business';
  assert.equal(await h.run(), 'done');
  assert.deepEqual(cancellations, [{ callId: 'call-0', taskId: 'control-id', requestRef: 'parent-request' }]);
  const ordinary = fixture([async () => new Promise(() => {})], {
    onCallTimeout: async () => assert.fail('ordinary tools have no durable task owner to cancel'),
  });
  ordinary.options.registry.get('tool-0').supportsBackground = false;
  const running = ordinary.run(); await nextTick(); t.mock.timers.tick(10); await nextTick();
  assert.equal(await running, 'done');
  assert.equal(ordinary.results.get('call-0').result.kind, 'outcome_unknown');
});

async function courseFixture() {
  const { createTeachingTools } = await import('../../packages/agents/dist/workspace-assistant/tools/tools.js');
  const identity = { kind: 'personal', name: 'test', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const activityId = randomUUID(), parent = randomUUID(), controlId = randomUUID();
  const course = { releaseId: randomUUID(), components: [{ key: 'lab', definition: { digest: 'a'.repeat(64), manifest: {
    formatVersion: 1, session: { parameters: { type: 'object', properties: {} },
      operation: { operationId: 'advance', parameters: { type: 'object', properties: {} } } },
  } } }] };
  const activity = { identity, activityId, course, status: 'open' };
  const request = { requestId: randomUUID(), receiver: { receiverId: 'agent-session:test', kind: 'question', location: 'remote' },
    scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId },
    draft: { token: randomUUID(), question: 'advance', references: [], bases: [] }, works: [], evidence: [] };
  const effects = { parentStops: 0 }, references = [], associations = [];
  const learning = { open: async () => activity, executions: { controlReceipt: async () => null, agent: {
    original: async (_identity, _activityId, association) => { associations.push(association); return ({ action: { execution: { instance: { key: 'lab', definitionDigest: 'a'.repeat(64) } }, receiver: { location: 'native' } }, association: {} }); },
    control: async () => null, read: async () => null,
    cleanup: async () => { effects.parentStops++; return null; },
    cleanupStatus: async () => null,
  } } };
  const host = createTeachingTools({ learning: () => learning, courses: { verifyComponentReference: async () => {} } });
  const scope = { identity, sessionId: randomUUID(), activity, input: request, runId: randomUUID(), stepId: randomUUID(),
    snapshotId: randomUUID(), attemptId: randomUUID(), assertDispatch: async () => {} };
  const controller = new AbortController();
  const ctx = { signal: controller.signal, deadline: new Date(Date.now() + 86_400_000).toISOString(),
    reportEffect: async ref => { references.push(ref); } };
  const run = () => host.execute(scope, { toolCallId: controlId, name: 'course_operation', executionMode: 'foreground',
    input: { componentKey: 'lab', operationId: 'advance', parameters: {}, requestId: parent, expectedSeq: 0 } }, ctx);
  return { identity, activity, parent, controlId, effects, references, associations, learning, scope, controller, ctx, run };
}

test('actual course control business timeout returns its controlId and never cleans up the parent session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = await courseFixture(), running = f.run();
  await nextTick(); t.mock.timers.tick(600_000); await nextTick();
  const result = await running;
  assert.equal(result.kind, 'outcome_unknown');
  assert.equal(result.taskId, f.controlId); assert.equal(result.requestRef, f.parent);
  assert.equal(f.effects.parentStops, 0, 'control timeout must not stop the parent session');
  assert.deepEqual(f.references[0], { taskId: f.controlId, requestRef: f.parent });
  assert.ok(f.associations.every(association => association.sessionId === f.scope.sessionId));
});

test('course host interruption closes foreground waiting without requesting task cleanup', async () => {
  const f = await courseFixture(), running = f.run(); await nextTick();
  f.controller.abort(new AgentError('host-interrupted'));
  assert.deepEqual(await running, { kind: 'interrupted', reason: 'host-interrupted' });
  assert.equal(f.effects.parentStops, 0);
});

test('a cancelled control receipt interrupts the operation without being failed or waiting on its parent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = await courseFixture(); let receiptState = 'dispatching', finished = false, reads = 0;
  const query = { requestId: f.parent, executionRef: randomUUID(), scope: f.scope.input.scope, output: null,
    statusKnowledge: 'confirmed', state: 'cancelled', session: { observations: [], appliedSeq: 0 } };
  f.learning.executions.controlReceipt = async () => ({ controlId: f.controlId, requestId: f.parent,
    executionRef: query.executionRef, status: receiptState, query });
  f.learning.executions.agent.control = async () => query;
  f.learning.executions.agent.read = async () => { reads++; return query; };
  const running = f.run().then(result => { finished = true; return result; }); await nextTick();
  assert.equal(finished, false, 'the parent terminal state is not this control receipt');
  receiptState = 'cancelled'; t.mock.timers.tick(1000); await nextTick();
  const result = await running;
  assert.equal(result.kind, 'interrupted'); assert.ok(result.reason.includes(f.controlId));
  assert.ok(result.reason.includes(f.parent)); assert.equal(reads, 2); assert.equal(f.effects.parentStops, 0);
});


test('a parent deadline winning the timer race cancels this call and retains a late receipt only as cancellation evidence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const deliveries = []; let accept;
  const h = fixture([async (_call, ctx) => {
    await ctx.reportEffect({ taskId: 'known', requestRef: 'request' });
    return new Promise(resolve => { accept = resolve; });
  }], { onCallTimeout: async (_call, reference) => { deliveries.push(reference); } });
  h.options.registry.get('tool-0').timeoutPolicy = 'business';
  h.options.budget.deadline = new Date(Date.now() + 20).toISOString();
  const running = h.run(); await nextTick();
  // Advance the wall clock without firing the per-call timer: the parent callback wins first.
  t.mock.timers.setTime(Date.now() + 20); h.controller.abort(new AgentError('deadline-exceeded')); await nextTick();
  assert.equal(await running, 'stopped');
  assert.ok(deliveries.some(ref => ref.taskId === 'known' && ref.requestRef === 'request'));
  accept({ kind: 'accepted', taskId: 'late', summary: 'accepted' }); await nextTick();
  assert.equal(deliveries.at(-1).taskId, 'late');
  assert.equal(h.results.size, 0, 'a late acceptance cannot replace the deadline unknown placeholder');
});

test('host interruption only ends the wait, including late acceptance and reference reports', async () => {
  let accept, ctx; const cancellations = [];
  const h = fixture([async (_call, context) => { ctx = context; return new Promise(resolve => { accept = resolve; }); }], {
    onCallTimeout: async (_call, reference) => { cancellations.push(reference); },
    onLateAcceptance: async () => assert.fail('host interruption cannot rearm Stop'),
  });
  const running = h.run(); await nextTick(); h.controller.abort(new AgentError('host-interrupted'));
  assert.equal(await running, 'stopped');
  await ctx.reportEffect({ taskId: 'independent-task' });
  accept({ kind: 'accepted', taskId: 'independent-task', summary: 'accepted' }); await nextTick();
  assert.deepEqual(cancellations, []); assert.equal(h.results.size, 0);
});

test('an ordinary unknown return rearms cancellation when its real handle arrives later', async () => {
  let ctx; const deliveries = [];
  const h = fixture([async (_call, context) => { ctx = context;
    return { kind: 'outcome_unknown', reason: 'unconfirmed', requestRef: 'real-request' }; }], {
    onCallTimeout: async (_call, reference) => { deliveries.push(reference); },
  });
  h.options.registry.get('tool-0').supportsBackground = false;
  assert.equal(await h.run(), 'done');
  await ctx.reportEffect({ taskId: 'late-task' });
  assert.deepEqual(deliveries.at(-1), { requestRef: 'real-request', taskId: 'late-task' });
  assert.equal(h.results.get('call-0').result.kind, 'outcome_unknown');
});

async function dependencyFixture(execute) {
  const { createAgentDependencyService, createAgentDependencyClient } = await import('../../packages/agents/dist/transport/session-dependencies.js');
  const identity = { kind: 'personal', name: 'test', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const target = { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 };
  const session = { identity, sessionId: randomUUID(), scenario: 'student-assistant', state: 'ready', deleted: false,
    owner: { target, installationId: randomUUID() } };
  const source = { assertAuthorized: async () => {}, sourceEnvironmentId: target.environmentId,
    sourceServiceId: target.serviceId, sourceInstallationId: session.owner.installationId };
  const counts = { read: 0, cancel: 0 }; const originalCalls = [];
  const activity = { identity, activityId: randomUUID(), target };
  const options = { sessions: { read: async () => session },
    learning: { open: async () => activity, executions: { agent: { original: async (...args) => { originalCalls.push(args); return null; } } } },
    courses: {}, authorize: async () => {}, assertDispatch: async () => {},
    tools: async () => [{ definition: { name: 'remote', description: 'remote', inputSchema: { type: 'object' } },
      supportsBackground: true, timeoutPolicy: 'business', execute }],
  };
  const service = createAgentDependencyService(options);
  const client = createAgentDependencyClient(call => {
    if (call.operation === 'tools.control') counts[call.args.action]++;
    return service(JSON.parse(JSON.stringify(call)), source);
  });
  const context = { sessionId: session.sessionId, turnId: randomUUID(), stepId: randomUUID(), toolCallId: randomUUID(),
    context: { system: '', facts: {}, sources: [] }, inputIds: [] };
  const call = { toolCallId: context.toolCallId, nativeCallId: 'remote', callIndex: 0, name: 'remote', input: {}, executionMode: 'foreground' };
  const controller = new AbortController(), references = [];
  const ctx = { ...context, identity, signal: controller.signal, originInputId: null, visibleAnswerInputIds: [],
    deadline: new Date(Date.now() + 86_400_000).toISOString(), assertActive: async () => controller.signal.throwIfAborted(),
    reportEffect: async ref => { references.push(ref); } };
  const deps = client.forSession(identity, session.sessionId);
  const [tool] = await deps.tools(context);
  const wireExecute = () => client.invoke({ version: 2, operation: 'tools.execute', identity, sessionId: session.sessionId,
    permit: { sessionId: session.sessionId, runId: context.turnId, stepId: context.stepId, operationId: context.toolCallId, generation: 1 },
    args: { module: { id: 'remote', version: 1 }, context: { ...context, deadline: ctx.deadline }, call } });
  const control = action => service({ version: 2, operation: 'tools.control', identity, sessionId: session.sessionId,
    args: { action, turnId: context.turnId, stepId: context.stepId, toolCallId: context.toolCallId, deadline: ctx.deadline } }, source);
  return { session, activity, options, client, deps, context, ctx, call, tool, controller, references, counts, originalCalls, control, wireExecute };
}

test('remote reference observation stops after a trusted handle and retains both refs in a later acceptance', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let release; const f = await dependencyFixture(async (_call, ctx) => {
    await ctx.reportEffect({ taskId: 'real-task', requestRef: 'real-request' });
    await new Promise(resolve => { release = resolve; });
    return { kind: 'accepted', taskId: 'real-task', summary: 'accepted' };
  });
  const running = f.tool.execute(f.call, f.ctx); await nextTick(); t.mock.timers.tick(100); await nextTick();
  try {
    assert.deepEqual(f.references.at(-1), { taskId: 'real-task', requestRef: 'real-request' });
    const count = f.counts.read; t.mock.timers.tick(60_000); await nextTick();
    assert.equal(f.counts.read, count, 'handle observation must stop during a long business wait');
    release(); await running;
    assert.deepEqual(f.references.at(-1), { taskId: 'real-task', requestRef: 'real-request' });
  } finally { release?.(); await running.catch(() => {}); }
});

test('remote host interruption does not send tools.control cancel or abort the independent owner', async () => {
  let remote, release;
  const f = await dependencyFixture(async (_call, ctx) => { remote = ctx;
    await new Promise(resolve => { release = resolve; });
    return { kind: 'accepted', taskId: 'independent', summary: 'accepted' };
  });
  const running = f.tool.execute(f.call, f.ctx); await nextTick();
  try {
    f.controller.abort(new AgentError('host-interrupted'));
    assert.deepEqual(await running, { kind: 'interrupted', reason: 'host-interrupted' });
    assert.equal(f.counts.cancel, 0); assert.equal(remote.signal.aborted, false);
  } finally { release?.(); await nextTick(); await running.catch(() => {}); }
});

test('cancel-before-execute tombstones survive their expired deadline and reject late dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = await dependencyFixture(async () => assert.fail('a cancelled call must never dispatch'));
  f.ctx.deadline = new Date(Date.now() + 10).toISOString();
  const receipt = await f.control('cancel');
  assert.equal(receipt.cancelled, true); assert.equal(receipt.found, false); assert.deepEqual(receipt.reference, {});
  t.mock.timers.tick(11);
  await assert.rejects(() => f.wireExecute());
  assert.equal((await f.control('read')).cancelled, true, 'deadline expiry cannot evict the cancellation tombstone');
});

test('tools.control retains trusted accepted/unknown refs even when the executor did not call reportEffect', async () => {
  for (const result of [{ kind: 'accepted', taskId: 'actual-task', summary: 'accepted' },
    { kind: 'outcome_unknown', taskId: 'actual-task', requestRef: 'actual-request', reason: 'unknown' }]) {
    const f = await dependencyFixture(async () => result);
    f.call.input = { taskId: 'forged-task', requestRef: 'forged-request' };
    assert.deepEqual((await f.control('read')).reference, {});
    await f.wireExecute();
    assert.deepEqual((await f.control('read')).reference, { taskId: 'actual-task',
      ...(result.requestRef ? { requestRef: result.requestRef } : {}) });
  }
});

test('execution association retains the actual session across wire and rejects another session', async () => {
  const f = await dependencyFixture(async () => success);
  f.session.scenario = 'workspace-assistant'; f.session.workspace = { activityId: f.activity.activityId, target: f.activity.target };
  const association = { sessionId: f.session.sessionId, runId: f.context.turnId, stepId: f.context.stepId,
    snapshotId: randomUUID(), commandId: f.context.toolCallId, assertDispatch: async () => {} };
  await f.deps.learning.executions.agent.original(f.ctx.identity, f.activity.activityId, association, randomUUID());
  assert.equal(f.originalCalls[0][2].sessionId, f.session.sessionId);
  await assert.rejects(() => f.deps.learning.executions.agent.original(f.ctx.identity, f.activity.activityId,
    { ...association, sessionId: randomUUID() }, randomUUID()));
  assert.equal(f.originalCalls.length, 1);
  await assert.rejects(() => f.client.forSession(f.ctx.identity, randomUUID()).tools(f.context),
    'a directory returning a different actual session must fail the owner guard');
});
