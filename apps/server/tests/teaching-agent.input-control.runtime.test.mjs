import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { openProductRuntime, restoreProductRecovery } from '@xunjie/product-runtime';
import { runPublishedAggregation } from './support/teaching-recovery.mjs';
import { executionActionSchema } from '@xunjie/contracts/execution';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { StorageError } from '@xunjie/storage';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

test('an expired student question pauses every queued input with its original reason', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { calls: [{ id: 'expiring-question', name: 'student_ask', arguments: {
    question: '等待你的明确预测。', source: '当前任务', options: [], allowText: true, skippable: true } }] }));
  try {
    const activity = await f.activity(), c = await f.controlled(activity, { limits: { waitMs: 1500 } });
    c.agent.resume();
    const original = await c.send('先问我，再等回应。');
    await until(async () => (await c.agent.conversation(c.identity, activity.activityId)).questions[0]?.state === 'pending', 'The original question waits.');
    const queued = await c.send('等完整一轮结束后再处理。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } });
    const final = await until(async () => {
      const value = await c.agent.conversation(c.identity, activity.activityId);
      return value.runs[0]?.state === 'paused' ? value : null;
    }, 'The expired question closes the original Run.');
    assert.equal(final.runs[0].runId, original.runId);
    const pending = final.inputs.find(input => input.inputId === queued.inputId);
    assert.equal(pending.state, 'paused'); assert.equal(pending.reason, 'student-response-expired');
    assert.ok((await c.agent.events(c.identity, activity.activityId)).some(event => event.kind === 'inputs-paused'
      && event.body.inputIds.includes(queued.inputId)));
    assert.equal(f.payloads.length, 1);
  } finally { await f.close(); }
});

test('input revisions, personal preferences and controls survive maintenance, read-only restore and fenced takeover', { timeout: 300000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (_payload, response, index) => {
    if (index === 1) { await gate; response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":{"message":"controlled failure"}}'); }
    else reply(response, { text: '接管后只采用明确选择的修订内容。' });
  });
  const directory = await mkdtemp(join(tmpdir(), 'xj-input-recovery-'));
  let target;
  try {
    await f.configure();
    const preferenceInput = { requestId: randomUUID(), expectedVersion: 0, busyInputMode: 'queue' };
    const preference = await f.api('agent-settings', preferenceInput);
    const activity = await f.activity(), base = `agent/${activity.activityId}`, original = await f.send(activity, '原任务等待受控失败。');
    await until(() => f.payloads.length === 1, 'The original request starts.');
    const queued = await f.send(activity, '接收时的排队原文。', { version: 1, mode: 'queue', basis: { source: 'preference', preferenceVersion: 1 } });
    const edit = { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'revise', text: '接管后使用这个修订版本。' };
    const edited = await f.api(`${base}/inputs/${queued.inputId}/control`, edit);
    release();
    await until(async () => (await f.api(`${base}/runs/${original.runId}`)).state === 'failed', 'The round pauses all queued content.');
    const before = await f.api(`${base}/conversation`), context = await f.api('context'), key = randomBytes(32);
    await f.runtime.setCredential('input-recovery-key', key.toString('base64'));
    const backup = await f.runtime.recovery.backup({ directory, recoveryKeyRef: 'input-recovery-key', leaveClosed: true });
    const targetRoot = join(directory, 'target');
    const restored = await restoreProductRecovery({ root: targetRoot, resources: f.resources, backupDirectory: join(directory, backup.backupId), key });
    for (const owner of restored.owners) await owner.close?.();
    target = openProductRuntime({ root: targetRoot, resources: f.resources });
    let state = await target.start();
    const api = async (route, body, headers = {}) => {
      const response = await fetch(state.endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal(state.state, 'maintenance');
    assert.deepEqual((await api(`${base}/conversation`)).body.inputs, before.inputs);
    assert.deepEqual((await api(`${base}/controls/${edit.requestId}`)).body, edited);
    assert.deepEqual((await api('agent-settings')).body, preference);
    assert.equal((await api('agent-settings', { requestId: randomUUID(), expectedVersion: 1, busyInputMode: 'steering' })).status, 503);
    assert.equal(f.payloads.length, 1);
    assert.equal((await target.recovery.takeover({ sourceRoot: f.root, receivers: [] })).phase, 'active');
    const after = (await api('context')).body;
    assert.notEqual(after.clientNamespace, context.clientNamespace);
    const input = { version: 2, requestId: randomUUID(), inputs: [{ inputId: queued.inputId, expectedVersion: 2 }] };
    assert.equal((await api(`${base}/runs/${original.runId}/continue`, input, { 'x-xj-namespace': context.clientNamespace })).status, 403);
    const continued = await api(`${base}/runs/${original.runId}/continue`, input, { 'x-xj-namespace': after.clientNamespace });
    assert.equal(continued.status, 200);
    await until(async () => (await api(`${base}/runs/${continued.body.runId}`)).body.state === 'completed', 'Selected revision resumes only after takeover.');
    await target.stop(); state = await target.start();
    assert.equal((await api(`${base}/controls/${input.requestId}`)).body.continuedRunId, continued.body.runId);
    assert.deepEqual((await api('agent-settings/receipts/' + preferenceInput.requestId)).body, preference);
    assert.equal(f.payloads.length, 2);
    assert.match(JSON.stringify(f.payloads[1]), /接管后使用这个修订版本/);
  } finally {
    release(); await target?.stop(); await f.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xj-input-recovery-')) throw new Error('Unexpected cleanup target');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('two advancing owners preserve a permitted real tool and reject the unstarted batch after a lost steering commit receipt', { timeout: 240000 }, async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), dispatched = new Promise(resolve => { started = resolve; });
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'batch.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '真实批次读取：29。' };
  const f = await fixture((_payload, response, index) => index === 1 ? reply(response, { calls: [
    { id: 'permitted-read', name: 'read_work', arguments: { objectId: work.objectId, contentId: work.contentId } },
    { id: 'unstarted-read', name: 'read_work', arguments: { objectId: work.objectId, contentId: work.contentId } },
  ] }) : reply(response, { text: '保留已许可的实际读取，未开始项依新方向停止。' }));
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    let lostId = '', lost = false, dispatches = 0;
    const boundary = new Proxy(c.storage, { get(target, property) {
      if (property === 'request') return async (input, effect) => {
        const result = await target.request(input, effect);
        if (!lost && input.requestId === 'teaching-accept:' + lostId) { lost = true; throw new StorageError('commit-unknown'); }
        return result;
      };
      return Reflect.get(target, property);
    } });
    const first = c.makeAgent({ tools: { ...c.tools, dispatch: async (...args) => {
      const outcome = await c.tools.dispatch(...args); dispatches++; started(); await gate; return outcome;
    } } }, boundary), second = c.makeAgent();
    first.closeDispatch();
    const original = await c.send('执行批次读取。', undefined, [work], first);
    await c.send('模型建立前补充：核对固定来源。', undefined, [work], first);
    assert.equal(f.payloads.length, 0);
    first.resume();
    await dispatched;
    second.resume();
    lostId = randomUUID();
    const steering = actionInputSchema.parse({ ...original.input, requestId: lostId,
      draft: { ...original.input.draft, token: randomUUID(), question: '改变方向，未开始的批次不用再做。' } });
    const hash = createHash('sha256').update(JSON.stringify(steering)).digest('hex');
    await assert.rejects(first.accept(steering, hash), error => error.code === 'commit-unknown');
    const accepted = await second.query(lostId, hash);
    assert.equal(accepted.state, 'accepted');
    assert.deepEqual(await second.accept(steering, hash), accepted);
    release();
    const final = await until(async () => {
      const value = await second.conversation(c.identity, activity.activityId);
      return value.runs[0]?.state === 'completed' ? value : null;
    }, 'The original Run settles once under competing production owners.');
    assert.equal(final.runs.length, 1);
    assert.equal(final.tools.find(tool => tool.callId === 'permitted-read').result.file.value, work.value);
    assert.equal(final.tools.find(tool => tool.callId === 'unstarted-read').outcome, 'not-dispatched');
    assert.equal(final.inputs.filter(input => input.requestId === lostId).length, 1);
    const events = await second.events(c.identity, activity.activityId);
    assert.equal(events.filter(event => event.kind === 'input-adopted' && event.body.inputId === JSON.parse(accepted.detail).inputId).length, 1);
    assert.equal(events.filter(event => event.kind === 'tool-permitted').length, 1);
    assert.equal(dispatches, 1);
    assert.equal(f.payloads.length, 2);
    assert.match(JSON.stringify(f.payloads[0]), /模型建立前补充：核对固定来源/);
  } finally { release(); await f.close(); }
});

test('explicit continuation after a model failure carries verified tool effects into a new model segment', { timeout: 240000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'measured.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '已核实的独立实测：水位是 31.75 cm。' };
  const f = await fixture(async (_payload, response, index) => {
    if (index === 1) reply(response, { calls: [{ id: 'measured-source', name: 'read_work', arguments: { objectId: work.objectId, contentId: work.contentId } }] });
    else if (index === 2) { await gate; response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":{"message":"controlled failure"}}'); }
    else reply(response, { text: '沿已核实的原结果解释新的问题。' });
  });
  try {
    await f.configure();
    const activity = await f.activity(), base = `agent/${activity.activityId}`;
    await f.api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    const first = await f.send(activity, '实际读取固定测量资料。', undefined, [work]);
    await until(() => f.payloads.length === 2, 'The real tool completed before holding only the following model response.');
    const queued = await f.send(activity, '继续解释原实测依据，不重新实验。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } });
    release();
    await until(async () => (await f.api(`${base}/runs/${first.runId}`)).state === 'failed', 'The original model transport fails.');
    await f.configure();
    const next = await f.api(`${base}/runs/${first.runId}/continue`, { version: 2, requestId: randomUUID(), inputs: [{ inputId: queued.inputId, expectedVersion: 1 }] });
    await until(async () => (await f.api(`${base}/runs/${next.runId}`)).state === 'completed', 'Only the explicitly selected input starts a successor.');
    assert.equal(f.payloads.length, 3);
    assert.match(JSON.stringify(f.payloads[2]), /31\.75 cm/);
    const value = await f.api(`${base}/conversation`), tool = value.tools.find(item => item.callId === 'measured-source');
    assert.equal(tool.outcome, 'completed');
    const event = (await f.api(`${base}/events`)).find(item => item.kind === 'context-assembled' && item.body.runId === next.runId);
    const snapshot = await f.api(`${base}/snapshots/${event.body.snapshotId}`);
    assert.ok(snapshot.sources.some(source => source.id === tool.commandId), 'A portable effect retains its original command provenance.');
    assert.notEqual(next.segmentId, value.runs[0].segmentId);
  } finally { release(); await f.close(); }
});

test('a long-tool deadline pauses unconsumed input even while steering discussion is generating', { timeout: 240000 }, async () => {
  let release, original, controlled;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (_payload, response, index) => {
    if (index === 1) reply(response, { calls: [{ id: 'deadline-aggregation', name: 'course_operation', arguments: {
      componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }] });
    else { await gate; reply(response, { text: '新的讨论已发生，原实验期限不能重置。' }); }
  });
  try {
    const activity = await f.browserCourse(), c = await f.controlled(activity, { limits: { waitMs: 2500 } });
    controlled = c;
    const binding = activity.course.components[0], manifest = binding.definition.manifest;
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
        instanceId: activity.activityId + ':table', componentId: manifest.componentId, version: manifest.version,
        definitionDigest: binding.definition.digest, stateVersion: 1, operationId: randomUUID(), content: manifest.initialState }) };
    await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    c.agent.resume();
    original = await c.send('运行真实聚合，但保留原等待期限。', undefined, [work]);
    const before = await until(async () => {
      const value = await c.agent.conversation(c.identity, activity.activityId);
      return value.waits.length && value.runs[0].state === 'waiting' ? value : null;
    }, 'The production tool has an accepted browser Wait.');
    await c.send('等待期间先讨论新的目标。');
    await until(() => f.payloads.length === 2, 'Steering starts discussion before the old Wait ends.');
    const pending = await c.send('尚未采用的下一项。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } });
    await until(async () => (await c.agent.conversation(c.identity, activity.activityId)).waits[0].state === 'expired', 'The original Wait expires.');
    release();
    const final = await until(async () => {
      const value = await c.agent.conversation(c.identity, activity.activityId);
      return value.runs[0].state === 'paused' ? value : null;
    }, 'Expiry must pause the original Run instead of completing discussion and advancing queue.');
    assert.equal(final.runs.length, 1);
    assert.equal(final.runs[0].reason, 'wait-expired');
    assert.ok(final.runs[0].completedAt, 'Hard expiry is terminal.');
    assert.equal(final.inputs.find(input => input.inputId === pending.inputId).state, 'paused');
    assert.equal(final.waits[0].deadline, before.waits[0].deadline);
    assert.equal(f.payloads.length, 2);
  } finally {
    release();
    if (original && controlled) await controlled.agent.stop(controlled.identity, original.input.scope.activityId, original.runId, { requestId: randomUUID() });
    await f.close();
  }
});

test('the real subject owns a persistent busy-input preference with immutable original receipts', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const original = await f.api('agent-settings');
    assert.equal(original.busyInputMode, 'steering');
    assert.equal(original.version, 0);
    const input = { requestId: randomUUID(), expectedVersion: 0, busyInputMode: 'queue' };
    const saved = await f.api('agent-settings', input);
    assert.equal(saved.version, 1);
    assert.equal(saved.busyInputMode, 'queue');
    assert.deepEqual(await f.api('agent-settings', input), saved);
    assert.deepEqual(await f.api('agent-settings/receipts/' + input.requestId), saved);
    assert.equal((await f.raw('agent-settings', { ...input, busyInputMode: 'steering' })).status, 409);
    assert.equal((await f.raw('agent-settings', { requestId: randomUUID(), expectedVersion: 0, busyInputMode: 'steering' })).status, 409);
    await f.restart();
    assert.deepEqual(await f.api('agent-settings'), saved);
    assert.deepEqual(await f.api('agent-settings/receipts/' + input.requestId), saved);
    assert.equal(f.payloads.length, 0, 'Settings and recovery never start teaching work.');
    assert.deepEqual(f.failures, []);
  } finally { await f.close(); }
});

test('steering wakes discussion during a real long-tool Wait, then the original result resumes before FIFO', { timeout: 300000 }, async () => {
  let cleanupResult = async () => {};
  const f = await fixture((_payload, response, index) => index === 1
    ? reply(response, { calls: [{ id: 'original-aggregation', name: 'course_operation', arguments: {
      componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }] })
    : reply(response, { text: index === 2 ? '先讨论新目标，原计算仍需核对结果。'
      : index === 3 ? '原计算已核实，均值是 83.33333333333333。' : '整轮结束后才处理排队问题。' }));
  try {
    const activity = await f.browserCourse(), c = await f.controlled(activity);
    const { agent, identity, learning } = c;
    const binding = activity.course.components[0], manifest = binding.definition.manifest;
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
        instanceId: activity.activityId + ':table', componentId: manifest.componentId, version: manifest.version,
        definitionDigest: binding.definition.digest, stateVersion: 1, operationId: randomUUID(), content: manifest.initialState }) };
    await learning.works.sync(identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    agent.resume();
    const first = await c.send('运行真实分组计算，核对原结果。', undefined, [work]);
    const waiting = await until(async () => {
      const value = await agent.conversation(identity, activity.activityId);
      return value.waits.length && value.runs[0]?.state === 'waiting' ? value : null;
    }, 'The actual browser operation must persist its original Wait.');
    const commandId = waiting.tools[0].commandId, browserId = randomUUID();
    const claimed = await learning.executions.agent.claimBrowser(identity, activity.activityId, commandId, browserId,
      association => agent.assertCommandDispatch(identity, activity.activityId, association));
    const action = claimed.action;
    const acceptance = { receipt: { requestId: commandId, receiver: action.receiver, state: 'accepted',
      inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(action))).digest('hex'), receiptId: 'input-control:' + commandId, detail: '' },
      execution: { executionRef: randomUUID(), acceptedSeq: 1 } };
    const accepted = await learning.executions.agent.acceptBrowser(identity, activity.activityId, commandId, browserId, acceptance,
      association => agent.assertCommandDispatch(identity, activity.activityId, association));
    const { computed, resultInput } = await runPublishedAggregation(action, manifest);
    assert.equal(computed.result.value, 83.33333333333333, 'Execute the actual published Wasm, holding only result delivery.');
    const deliverResult = async () => {
      const result = await learning.executions.result(identity, activity.activityId, commandId, resultInput);
      const report = { ...result, state: 'succeeded', confirmedSeq: 3 };
      await learning.executions.report(identity, activity.activityId, commandId, report);
      return report;
    };
    cleanupResult = async () => { await deliverResult(); };
    await c.send('排队：整轮以后再处理。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } }, [work]);
    const steering = await c.send('补充：先讨论新的边界，保留原计算与作品。', undefined, [work]);
    const discussing = await until(async () => {
      const value = await agent.conversation(identity, activity.activityId);
      return value.messages.some(message => message.text === '先讨论新目标，原计算仍需核对结果。') ? value : null;
    }, 'Accepted steering wakes discussion while the original tool Wait remains.');
    assert.equal(discussing.runs.length, 1);
    assert.equal(discussing.runs[0].state, 'waiting');
    assert.equal(discussing.inputs.find(input => input.inputId === steering.inputId).adoptedRunId, first.runId);
    assert.equal(discussing.waits[0].waitId, waiting.waits[0].waitId);
    assert.equal(discussing.waits[0].deadline, waiting.waits[0].deadline);
    assert.equal(discussing.waits[0].state, 'pending');
    assert.equal(f.payloads.length, 2);
    const report = await deliverResult();
    const completed = await until(async () => {
      const value = await agent.conversation(identity, activity.activityId);
      return value.runs.length === 2 && value.runs.every(run => run.state === 'completed') ? value : null;
    }, 'The verified original result precedes the queued successor.');
    assert.equal(completed.tools.length, 1);
    assert.equal(completed.tools[0].commandId, commandId);
    assert.equal(completed.tools[0].result.query.output.output.value, 83.33333333333333);
    assert.equal((await learning.executions.read(identity, activity.activityId, commandId)).executionRef, accepted.executionRef);
    assert.equal((await learning.works.read(identity, activity.activityId)).files[0].contentId, work.contentId);
    assert.equal(f.payloads.length, 4);
    assert.match(JSON.stringify(f.payloads[2]), /83\.33333333333333/);
    await learning.executions.report(identity, activity.activityId, commandId, report);
    assert.equal((await agent.conversation(identity, activity.activityId)).runs.length, 2);
    assert.equal(f.payloads.length, 4);
    await agent.stop(identity, activity.activityId, first.runId, { requestId: randomUUID() });
    await agent.validate();
    assert.equal(f.payloads.length, 4, 'Archiving original cleanup must not change the immutable observed result or call a model.');
  } finally { try { await cleanupResult(); } finally { await f.close(); } }
});

test('stop accepted before final delivery wins the finish race while retaining the real completed model result', { timeout: 240000 }, async () => {
  let release, retained = false;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture((_payload, response) => reply(response, { text: '模型确实已经完成的原答复。' }));
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    const agent = c.makeAgent({ models: { ...c.models, results: { ...c.models.results, retain: async (...args) => {
      const original = await c.models.results.retain(...args);
      retained = true; await gate; return original;
    } } } });
    agent.resume();
    const first = await c.send('解释原问题。', undefined, [], agent);
    await until(() => retained, 'The real native result is retained before final delivery.');
    const queued = await c.send('不能在停止后自动处理。',
      { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } }, [], agent);
    await agent.stop(c.identity, activity.activityId, first.runId, { requestId: randomUUID() });
    release();
    const finished = await until(async () => {
      const value = await agent.conversation(c.identity, activity.activityId);
      return ['stopped', 'completed'].includes(value.runs[0]?.state) ? value : null;
    }, 'The ordered finish decision is persisted.');
    assert.equal(finished.runs[0].state, 'stopped');
    assert.equal(finished.inputs.find(item => item.inputId === queued.inputId).state, 'paused');
    assert.equal(finished.runs.length, 1);
    assert.ok(finished.messages.some(message => message.text === '模型确实已经完成的原答复。'));
    const events = await agent.events(c.identity, activity.activityId);
    assert.equal(events.filter(event => event.kind === 'run-completed').length, 0);
    assert.equal(events.filter(event => event.kind === 'run-stopped').length, 1);
    assert.equal(f.payloads.length, 1);
  } finally { release(); await f.close(); }
});

test('stop keeps a stable original control receipt and pauses queued input without starting a successor', { timeout: 240000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (_payload, response) => { await gate; reply(response, { text: '原请求实际返回的内容。' }); });
  try {
    await f.configure();
    const activity = await f.activity(), base = `agent/${activity.activityId}`;
    const first = await f.send(activity, '正在处理的原问题。');
    await until(() => f.payloads.length === 1, 'Original model starts.');
    const queued = await f.send(activity, '停止后不得自动运行的队列。',
      { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } });
    const input = { requestId: randomUUID() };
    await f.api(`${base}/runs/${first.runId}/stop`, input);
    release();
    const stopped = await until(async () => {
      const value = await f.api(`${base}/conversation`);
      return value.runs[0]?.state === 'stopped' ? value : null;
    }, 'Stop closes the original round without promoting queue.');
    const receipt = await f.api(`${base}/controls/${input.requestId}`);
    assert.equal(receipt.operation, 'stop');
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.runId, first.runId);
    assert.equal(stopped.inputs.find(item => item.inputId === queued.inputId).state, 'paused');
    assert.equal(stopped.runs.length, 1);
    assert.equal(f.payloads.length, 1);
    assert.equal((await f.api(`${base}/runs/${first.runId}/stop`, input)).runId, first.runId);
    assert.deepEqual(await f.api(`${base}/controls/${input.requestId}`), receipt);
    await f.restart();
    assert.deepEqual(await f.api(`${base}/controls/${input.requestId}`), receipt);
    assert.equal((await f.api(`${base}/conversation`)).runs.length, 1);
  } finally { release(); await f.close(); }
});

test('recoverable pauses resume the same durable Run after configuration and restart without a new input', { timeout: 240000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { text: '配置恢复后继续原问题。' }));
  try {
    const activity = await f.activity(), base = `agent/${activity.activityId}`;
    const first = await f.send(activity, '先保留这个原始问题。');
    const paused = await until(async () => {
      const run = await f.api(`${base}/runs/${first.runId}`);
      return run.state === 'paused' && run.reason === 'model-not-selected' ? run : null;
    }, 'Missing configuration is a recoverable pause.');
    await f.restart();
    await f.configure();
    const input = { version: 2, requestId: randomUUID(), inputs: [] };
    const resumed = await f.api(`${base}/runs/${first.runId}/continue`, input);
    assert.equal(resumed.runId, first.runId, 'A recoverable nonterminal pause keeps the original Run identity.');
    const completed = await until(async () => {
      const value = await f.api(`${base}/conversation`);
      return value.runs[0]?.state === 'completed' ? value : null;
    }, 'Configuration recovery advances the original durable input.');
    assert.equal(completed.runs.length, 1);
    assert.equal(completed.inputs.length, 1);
    assert.equal(completed.inputs[0].inputId, first.inputId);
    assert.equal(completed.inputs[0].state, 'adopted');
    assert.equal(f.payloads.length, 1);
    const receipt = await f.api(`${base}/controls/${input.requestId}`);
    assert.equal(receipt.reason, 'resumed-original');
    assert.equal(receipt.continuedRunId, first.runId);
    assert.equal((await f.api(`${base}/runs/${first.runId}/continue`, input)).runId, first.runId);
    assert.equal((await f.api(`${base}/events`)).filter(event => event.kind === 'budget-reserved').length, 1);
    assert.equal(paused.attemptId, null);
  } finally { await f.close(); }
});

test('a failed round pauses all remaining inputs and only explicitly selected content continues in a linked Run', { timeout: 240000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (_payload, response, index) => {
    if (index === 1) {
      await gate;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Controlled transport failure', type: 'server_error' } }));
    } else reply(response, { text: '只继续学生明确选择的内容。' });
  });
  try {
    await f.configure();
    const activity = await f.activity(), base = `agent/${activity.activityId}`;
    const first = await f.send(activity, '可能失败的原任务。');
    await until(() => f.payloads.length === 1, 'The original model request starts.');
    const unselected = await f.send(activity, '未选择的补充 UNSELECTED-STEERING。');
    const selected = await f.send(activity, '明确选择的排队内容 SELECTED-QUEUE。',
      { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } });
    release();
    const failed = await until(async () => {
      const value = await f.api(`${base}/conversation`);
      return value.runs.some(run => run.runId === first.runId && ['failed', 'paused'].includes(run.state)) ? value : null;
    }, 'Failure pauses advancement rather than automatically starting queue.');
    assert.equal(failed.runs.length, 1);
    assert.equal(f.payloads.length, 1);
    for (const id of [unselected.inputId, selected.inputId]) {
      const item = failed.inputs.find(input => input.inputId === id);
      assert.equal(item.state, 'paused');
      assert.ok(item.reason);
    }
    const legacy = { requestId: randomUUID() };
    assert.equal((await f.raw(`${base}/runs/${first.runId}/continue`, legacy)).status, 409,
      'An old unqualified continue wire cannot manufacture a new retry round.');
    assert.equal((await f.api(`${base}/controls/${legacy.requestId}`)).reason, 'select-inputs');
    const input = { version: 2, requestId: randomUUID(), inputs: [{ inputId: selected.inputId, expectedVersion: 1 }] };
    const continued = await f.api(`${base}/runs/${first.runId}/continue`, input);
    assert.notEqual(continued.runId, first.runId);
    assert.equal(continued.previousRunId, first.runId);
    await until(async () => (await f.api(`${base}/runs/${continued.runId}`)).state === 'completed', 'The explicit successor completes.');
    assert.equal((await f.api(`${base}/runs/${first.runId}/continue`, input)).runId, continued.runId);
    const control = await f.api(`${base}/controls/${input.requestId}`);
    assert.equal(control.status, 'accepted');
    assert.equal(control.continuedRunId, continued.runId);
    assert.equal(f.payloads.length, 2);
    assert.match(JSON.stringify(f.payloads[1]), /SELECTED-QUEUE/);
    assert.doesNotMatch(JSON.stringify(f.payloads[1]), /UNSELECTED-STEERING/);
    const final = await f.api(`${base}/conversation`);
    assert.equal(final.inputs.find(item => item.inputId === unselected.inputId).state, 'paused');
    assert.equal(final.inputs.find(item => item.inputId === selected.inputId).adoptedRunId, continued.runId);
    assert.equal(final.runs[0].state, failed.runs[0].state, 'A terminal Run never revives.');
  } finally { release(); await f.close(); }
});

test('new steering pairs unpermitted old native tool calls as not executed, then still uses the real tool', { timeout: 240000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'basis.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '真实固定文件：边界值 17。' };
  const f = await fixture(async (_payload, response, index) => {
    if (index === 1) {
      const args = JSON.stringify({ objectId: work.objectId, contentId: work.contentId }), cut = Math.floor(args.length / 2);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ id: 'old-tool-stream', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
        { index: 0, id: 'old-read', type: 'function', function: { name: 'read_work', arguments: args.slice(0, cut) } },
      ] }, finish_reason: null }] }) + '\n\n');
      await gate;
      for (const chunk of [
        { id: 'old-tool-stream', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] }, finish_reason: null }] },
        { id: 'old-tool-stream', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
      ]) response.write('data: ' + JSON.stringify(chunk) + '\n\n');
      response.end('data: [DONE]\n\n'); return;
    }
    if (index < 3) reply(response, { calls: [{ id: index === 1 ? 'old-read' : 'new-read', name: 'read_work',
      arguments: { objectId: work.objectId, contentId: work.contentId } }] });
    else reply(response, { text: '依据真实读取的边界值 17 继续。' });
  });
  try {
    await f.configure();
    const activity = await f.activity(), base = `agent/${activity.activityId}`;
    await f.api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    const first = await f.send(activity, '先读取固定文件。', undefined, [work]);
    await until(() => f.payloads.length === 1, 'The original request starts before tool intents complete.');
    await f.send(activity, '补充：先按新目标决定，再读取同一固定依据。', undefined, [work]);
    release();
    const completed = await until(async () => {
      const value = await f.api(`${base}/conversation`);
      return value.runs.find(run => run.runId === first.runId)?.state === 'completed' ? value : null;
    }, 'The original Run completes using a fresh decision and a real source read.');
    const old = completed.tools.find(tool => tool.callId === 'old-read'), current = completed.tools.find(tool => tool.callId === 'new-read');
    assert.equal(old.outcome, 'not-dispatched');
    assert.equal(old.result.reason, 'steering-before-dispatch');
    assert.equal(current.outcome, 'completed');
    assert.equal(current.result.file.value, work.value);
    const events = await f.api(`${base}/events`);
    assert.equal(events.filter(event => event.kind === 'tool-permitted' && event.body.commandId === old.commandId).length, 0);
    assert.equal(events.filter(event => event.kind === 'tool-permitted' && event.body.commandId === current.commandId).length, 1);
    assert.ok(JSON.stringify(f.payloads[1]).includes('old-read'));
    assert.match(JSON.stringify(f.payloads[1]), /not-executed/);
    assert.equal(f.payloads.length, 3);
  } finally { release(); await f.close(); }
});

test('queue preserves a student Wait while later steering supersedes the question without inventing an answer', { timeout: 240000 }, async () => {
  const question = { question: '先预测结果？', source: '当前学习目标',
    options: [{ id: 'one', label: '1' }], allowText: true, skippable: true };
  const f = await fixture((_payload, response, index) => index === 1
    ? reply(response, { calls: [{ id: 'wait-prediction', name: 'student_ask', arguments: question }] })
    : reply(response, { text: index === 2 ? '先按新的补充讨论。' : '然后处理原排队问题。' }));
  try {
    await f.configure();
    const activity = await f.activity(), base = `agent/${activity.activityId}`;
    const first = await f.send(activity, '请先问我的预测。');
    const original = await until(async () => {
      const value = await f.api(`${base}/conversation`);
      return value.questions.find(item => item.state === 'pending');
    }, 'The original question and Wait must exist.');
    await f.send(activity, '排队：之后解释延伸问题。',
      { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } });
    assert.equal((await f.api(`${base}/conversation`)).questions[0].state, 'pending');
    assert.equal(f.payloads.length, 1, 'Queue does not answer or release a student Wait.');
    await f.send(activity, '改为先讨论我的新目标，不再等待预测。');
    const completed = await until(async () => {
      const value = await f.api(`${base}/conversation`);
      return value.runs.length === 2 && value.runs.every(run => run.state === 'completed') ? value : null;
    }, 'Steering releases discussion through an explicit supersession fact.');
    assert.equal(completed.questions[0].state, 'superseded');
    assert.equal(completed.questions[0].response, null);
    assert.equal(completed.waits.find(wait => wait.waitId === original.waitId).state, 'consumed');
    const late = { requestId: randomUUID(), questionVersion: original.version, waitVersion: original.waitVersion,
      answer: { kind: 'text', text: '晚回应 LATE-UNUSED。' } };
    const rejected = await f.api(`${base}/questions/${original.questionId}/responses`, late);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, 'question-superseded');
    assert.deepEqual(await f.api(`${base}/responses/${late.requestId}`), rejected);
    assert.equal(f.payloads.length, 3);
    assert.doesNotMatch(JSON.stringify(f.payloads), /LATE-UNUSED/);
    const events = await f.api(`${base}/events`);
    assert.equal(events.filter(event => event.kind === 'student-response' && event.body.status === 'accepted').length, 0);
    assert.equal(events.filter(event => event.kind === 'question-superseded').length, 1);
    assert.equal(completed.runs[0].runId, first.runId);
  } finally { await f.close(); }
});

test('unconsumed inputs have immutable edits, removal and promotion with original control receipts', { timeout: 240000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (_payload, response, index) => {
    if (index === 1) await gate;
    reply(response, { text: '实际回复 ' + index });
  });
  try {
    await f.configure();
    const activity = await f.activity(), base = `agent/${activity.activityId}`;
    const root = await f.send(activity, '处理当前问题。');
    await until(() => f.payloads.length === 1, 'The current request starts.');
    const delivery = { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } };
    const edited = await f.send(activity, '旧版本待处理内容 EDIT-OLD。', delivery);
    const removed = await f.send(activity, '应移除 REMOVE-NEVER。', delivery);
    const promoted = await f.send(activity, '转引导 PROMOTE-NOW。', delivery);
    const edit = { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'revise', text: '新版本待处理内容 EDIT-NEW。' };
    const route = `${base}/inputs/${edited.inputId}/control`;
    const receipt = await f.api(route, edit);
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.input.version, 2);
    assert.equal(receipt.input.input.draft.question, '新版本待处理内容 EDIT-NEW。');
    assert.deepEqual(await f.api(route, edit), receipt);
    assert.deepEqual(await f.api(`${base}/controls/${edit.requestId}`), receipt);
    const unchanged = await f.api(`intents/${activity.activityId}/${edited.input.requestId}`);
    assert.equal(unchanged.input.draft.question, '旧版本待处理内容 EDIT-OLD。', 'Editing never changes original reliable request bytes.');
    const stale = await f.api(route, { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'remove' });
    assert.equal(stale.status, 'rejected');
    assert.equal(stale.reason, 'version-mismatch');
    const removal = await f.api(`${base}/inputs/${removed.inputId}/control`,
      { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'remove' });
    assert.equal(removal.input.state, 'removed');
    const promotion = await f.api(`${base}/inputs/${promoted.inputId}/control`,
      { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'promote' });
    assert.equal(promotion.input.state, 'superseded');
    assert.ok(promotion.replacementInputId);
    release();
    const completed = await until(async () => {
      const value = await f.api(`${base}/conversation`);
      return value.runs.length === 2 && value.runs.every(run => run.state === 'completed') ? value : null;
    }, 'Promoted input steers now, then only the edited FIFO entry starts a successor.');
    assert.equal(completed.inputs.find(input => input.inputId === promotion.replacementInputId).adoptedRunId, root.runId);
    assert.equal(f.payloads.length, 3);
    assert.match(JSON.stringify(f.payloads[1]), /PROMOTE-NOW/);
    assert.match(JSON.stringify(f.payloads[2]), /EDIT-NEW/);
    assert.doesNotMatch(JSON.stringify(f.payloads), /REMOVE-NEVER|EDIT-OLD/);
    const tooLate = await f.api(route, { ...edit, requestId: randomUUID(), expectedVersion: 2, text: '不能覆盖已采用内容' });
    assert.equal(tooLate.status, 'rejected');
    assert.equal(tooLate.reason, 'input-consumed');
    assert.deepEqual(await f.api(`${base}/controls/${edit.requestId}`), receipt, 'Original receipts remain immutable after consumption.');
    assert.deepEqual(f.failures, []);
  } finally { release(); await f.close(); }
});

test('steering received during generation continues the same Run before any queued input and preserves the original answer', { timeout: 240000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (_payload, response, index) => {
    if (index === 1) await gate;
    reply(response, { text: ['原方向的真实片段。', '已采用补充的目标。', '最后处理排队内容。'][index - 1] ?? '不应有额外调用' });
  });
  try {
    await f.configure();
    const activity = await f.activity(), base = `agent/${activity.activityId}`;
    const first = await f.send(activity, '解释原方向。');
    await until(() => f.payloads.length === 1, 'The original request has already been sent.');
    const steering = await f.send(activity, '补充目标：只解释边界，保留原实验。');
    const queued = await f.send(activity, '排队秘密标记 Q-LATER。',
      { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } });
    assert.equal(steering.runId, first.runId);
    const received = (await f.api(`${base}/conversation`)).inputs.find(input => input.inputId === steering.inputId);
    assert.equal(received.state, 'pending', 'Received is distinct from adopted by a model step.');
    release();
    const completed = await until(async () => {
      const value = await f.api(`${base}/conversation`);
      return value.runs.length === 2 && value.runs.every(run => run.state === 'completed') ? value : null;
    }, 'The steering must be consumed in the original round before FIFO starts a successor.');
    assert.equal(completed.inputs.find(input => input.inputId === steering.inputId).adoptedRunId, first.runId);
    assert.equal(completed.inputs.find(input => input.inputId === queued.inputId).adoptedRunId, completed.runs[1].runId);
    assert.equal(f.payloads.length, 3);
    assert.doesNotMatch(JSON.stringify(f.payloads[0]), /补充目标|Q-LATER/, 'An already sent request stays immutable.');
    assert.match(JSON.stringify(f.payloads[1]), /补充目标/);
    assert.doesNotMatch(JSON.stringify(f.payloads[1]), /Q-LATER/, 'Unconsumed queue is not model context.');
    assert.ok(completed.messages.some(message => message.text === '原方向的真实片段。'));
    assert.ok(completed.messages.some(message => message.text === '已采用补充的目标。'));
    const events = await f.api(`${base}/events`);
    assert.equal(events.filter(event => event.kind === 'run-completed' && event.body.runId === first.runId).length, 1);
    assert.equal(events.filter(event => event.kind === 'input-adopted' && event.body.inputId === steering.inputId).length, 1);
    assert.deepEqual(f.failures, []);
  } finally { release(); await f.close(); }
});

test('queue receives immediately, survives restart, and starts successors FIFO only after the complete round', { timeout: 240000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (_payload, response, index) => {
    if (index === 1) await gate;
    reply(response, { text: ['先完成当前解释。', '已处理排队甲。', '已处理排队乙。'][index - 1] ?? '不应有额外调用' });
  });
  try {
    await f.configure();
    const activity = await f.activity(), base = `agent/${activity.activityId}`;
    const first = await f.send(activity, '先完整解释当前问题。');
    await until(() => f.payloads.length === 1, 'The original model request starts.');
    const delivery = { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } };
    const second = await f.send(activity, '排队甲：再解释边界。', delivery);
    const third = await f.send(activity, '排队乙：最后检查。', delivery);
    const received = await f.api(`${base}/conversation`);
    assert.equal(received.runs.length, 1, 'Receiving queue entries does not start competing Runs.');
    assert.equal(f.payloads.length, 1);
    assert.deepEqual(received.inputs.filter(input => input.mode === 'queue').map(input => [input.requestId, input.state]),
      [[second.input.requestId, 'pending'], [third.input.requestId, 'pending']]);
    release();
    const completed = await until(async () => {
      const value = await f.api(`${base}/conversation`);
      return value.runs.length === 3 && value.runs.every(run => run.state === 'completed') ? value : null;
    }, 'Only complete normal rounds advance the explicit queue.');
    assert.equal(completed.runs[1].previousRunId, first.runId);
    assert.equal(completed.runs[2].previousRunId, completed.runs[1].runId);
    assert.match(JSON.stringify(f.payloads[1]), /排队甲：再解释边界/);
    assert.doesNotMatch(JSON.stringify(f.payloads[0]), /排队甲/);
    assert.equal(f.payloads.length, 3);
    const before = completed.inputs;
    await f.restart();
    assert.deepEqual((await f.api(`${base}/conversation`)).inputs, before);
    assert.equal(f.payloads.length, 3, 'Restart and query never consume an input twice.');
    assert.deepEqual(f.failures, []);
  } finally { release(); await f.close(); }
});
