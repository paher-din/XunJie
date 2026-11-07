import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StorageError } from '@xunjie/storage';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

test('initial segment receipt loss and Agent restart reuse the original segment before any model dispatch', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    const creates = [];
    let lose = true;
    const models = { ...c.models, segments: { ...c.models.segments, async create(who, body) {
      const created = await c.models.segments.create(who, body);
      creates.push(structuredClone(body));
      if (lose) { lose = false; throw new StorageError('resource-busy'); }
      return created;
    } } };
    const first = c.makeAgent({ models }); first.resume();
    const accepted = await c.send('保留原段后再开始回答。', undefined, [], first);
    await until(async () => (await first.run(c.identity, activity.activityId, accepted.runId)).state === 'paused', 'The original create receipt is lost.');
    assert.equal(creates.length, 1); assert.equal(f.payloads.length, 0);
    first.closeDispatch(); first.close(); await first.drain();
    const restarted = c.makeAgent({ models }); restarted.resume();
    const resumed = await restarted.continueRun(c.identity, activity.activityId, accepted.runId, { version: 2, requestId: randomUUID(), inputs: [] });
    assert.equal(resumed.runId, accepted.runId);
    const done = await until(async () => {
      const run = await restarted.run(c.identity, activity.activityId, accepted.runId);
      return run.state === 'completed' ? run : null;
    }, 'The original Run completes after restart.');
    assert.equal(done.segmentId, creates[0].segmentId, 'Recovery must find the original created segment.');
    assert.equal(creates.length, 1, 'Recovery reads the original segment instead of creating another.');
    assert.equal(f.payloads.length, 1);
    assert.deepEqual(done.usage, { state: 'final', inputTokens: 20, outputTokens: 10, totalTokens: 30 });
    assert.equal((await restarted.events(c.identity, activity.activityId)).some(event => event.kind.startsWith('model-switch-')), false);
  } finally { await f.close(); }
});

test('a fenced Agent with a delayed create receipt cannot overwrite its successor or dispatch another model call', { timeout: 180000 }, async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const f = await fixture();
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    let created;
    const models = { ...c.models, segments: { ...c.models.segments, async create(who, body) {
      const result = await c.models.segments.create(who, body); created = structuredClone(body); await delayed; return result;
    } } };
    const first = c.makeAgent({ models, leaseMs: 300 });
    const accepted = await c.send('新推进者继续原段，旧推进者不能回写。', undefined, [], first);
    await until(() => created, 'The original Gateway create commits but its reply is delayed.');
    first.closeDispatch(); first.closeWrites();
    const successor = c.makeAgent({ leaseMs: 300 }); successor.resume();
    const completed = await until(async () => {
      const value = await successor.run(c.identity, activity.activityId, accepted.runId); return value.state === 'completed' ? value : null;
    }, 'The successor claims the expired lease and reconciles the original create.');
    assert.equal(completed.segmentId, created.segmentId); assert.equal(f.payloads.length, 1);
    release(); await first.drain();
    assert.deepEqual(await successor.run(c.identity, activity.activityId, accepted.runId), completed);
    assert.equal(f.payloads.length, 1);
    await successor.validate();
  } finally { release(); await f.close(); }
});

for (const lost of ['close', 'create']) test(`${lost} receipt loss resumes the fixed model switch under competing Agents without reassembly`, { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    const calls = { close: [], create: [] };
    let armed = false, drop = true, forbidAssembly = false;
    const models = { ...c.models, segments: { ...c.models.segments,
      async close(who, id, body) {
        const result = await c.models.segments.close(who, id, body);
        if (armed) calls.close.push({ id, body: structuredClone(body) });
        if (armed && lost === 'close' && drop) { drop = false; throw new StorageError('unavailable'); }
        return result;
      },
      async create(who, body) {
        const result = await c.models.segments.create(who, body);
        if (armed) calls.create.push(structuredClone(body));
        if (armed && lost === 'create' && drop) { drop = false; throw new StorageError('unavailable'); }
        return result;
      },
    } };
    const tools = { ...c.tools,
      async contributions(scope) {
        if (forbidAssembly) throw new Error('A received transition must not rediscover tools.');
        return c.tools.contributions(scope);
      },
      async definitions(scope) {
        if (forbidAssembly) throw new Error('A received transition must not rediscover tools.');
        return c.tools.definitions(scope);
      },
    };
    const first = c.makeAgent({ models, tools });
    const input = await c.send('先保留原回答及预算。', undefined, [], first);
    const original = await until(async () => {
      const value = await first.run(c.identity, activity.activityId, input.runId);
      return value.state === 'completed' ? value : null;
    }, 'The original model call completes.');
    armed = true;
    const selection = await c.models.selection.read(c.identity), control = { requestId: randomUUID(), selectionVersion: selection.version };
    const paused = await first.switchModel(c.identity, activity.activityId, control);
    assert.equal(paused.state, 'paused');
    first.close(); await first.drain(); forbidAssembly = true;
    const a = c.makeAgent({ models, tools }), b = c.makeAgent({ models, tools });
    await Promise.all([a.switchModel(c.identity, activity.activityId, control), b.switchModel(c.identity, activity.activityId, control)]);
    const complete = await a.switchModel(c.identity, activity.activityId, control);
    assert.equal(complete.state, 'completed');
    assert.equal(complete.fromSegmentId, original.segmentId); assert.equal(complete.toSegmentId, paused.toSegmentId);
    assert.equal(calls.close.length, 1, 'A closed predecessor is reconciled without another close.');
    assert.equal(calls.create.length, 1, 'The fixed successor is created only once.');
    assert.equal(calls.create[0].segmentId, paused.toSegmentId);
    assert.equal((await c.models.segments.read(c.identity, original.segmentId)).closed, true);
    assert.equal((await c.models.segments.read(c.identity, complete.toSegmentId)).closed, false);
    assert.deepEqual(await a.run(c.identity, activity.activityId, input.runId), original, 'Switching does not rewrite the original Run or its budget usage.');
    const events = await a.events(c.identity, activity.activityId);
    assert.equal(events.filter(event => event.kind === 'model-switch-requested').length, 1);
    assert.equal(events.filter(event => event.kind === 'model-switch-completed').length, 1);
    assert.equal(f.payloads.length, 1);
  } finally { await f.close(); }
});

test('a paired accepted student Wait keeps its original command, deadline and Run budget through a switch and restart', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response, index) => index === 1
    ? reply(response, { calls: [{ id: 'segment-student-wait', name: 'student_ask', arguments: {
      question: '请保留原问题的预测。', source: '换段验收', options: [], allowText: true, skippable: true,
    } }] }) : reply(response, { text: '继续原问题的解释。' }));
  try {
    const activity = await f.activity(), c = await f.controlled(activity), first = c.makeAgent();
    const original = await c.send('请先问我预测，再等待明确回应。', undefined, [], first);
    await until(async () => {
      const value = await first.conversation(c.identity, activity.activityId);
      return value.questions[0]?.state === 'pending' && value.runs[0]?.state === 'waiting' && value.tools[0]?.state === 'waiting' ? value : null;
    }, 'The accepted question is paired and waiting.');
    const queued = await c.send('QUEUE_MUST_NOT_ENTER_SWITCH', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } }, [], first);
    const selection = await c.models.selection.read(c.identity);
    const createdBodies = [];
    const models = { ...c.models, segments: { ...c.models.segments, async create(who, body) {
      createdBodies.push(structuredClone(body)); return c.models.segments.create(who, body);
    } } };
    // New process handle, same durable owner facts. No Driver is running while the boundary switches.
    first.close(); await first.drain();
    const before = await first.conversation(c.identity, activity.activityId);
    const switcher = c.makeAgent({ models });
    const result = await switcher.switchModel(c.identity, activity.activityId, { requestId: randomUUID(), selectionVersion: selection.version });
    assert.equal(result.state, 'completed', 'An accepted effect with a closed native pairing may retain its logical Wait.');
    assert.equal(createdBodies.length, 1); assert.doesNotMatch(JSON.stringify(createdBodies), /QUEUE_MUST_NOT_ENTER_SWITCH/);
    const after = await switcher.conversation(c.identity, activity.activityId);
    for (const field of ['tools', 'waits', 'questions', 'runs', 'inputs']) assert.deepEqual(after[field], before[field], field);
    assert.equal(after.runs[0].runId, original.runId);
    assert.equal(after.inputs.find(item => item.inputId === queued.inputId).state, 'pending');
    assert.equal(f.payloads.length, 1, 'Switching cannot regenerate a model answer or recreate a question.');
    switcher.close(); await switcher.drain();
    const resumed = c.makeAgent();
    const question = after.questions[0], answer = { requestId: randomUUID(), questionVersion: question.version,
      waitVersion: question.waitVersion, answer: { kind: 'text', text: '原问题的明确预测是 37。' } };
    assert.equal((await resumed.respond(c.identity, activity.activityId, question.questionId, answer)).status, 'accepted');
    resumed.resume();
    const completed = await until(async () => {
      const value = await resumed.run(c.identity, activity.activityId, original.runId);
      return value.state === 'completed' ? value : null;
    }, 'The original Wait resumes on the new segment without resetting its Run.');
    assert.equal(completed.segmentId, result.toSegmentId);
    assert.deepEqual(completed.usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
    const final = await resumed.conversation(c.identity, activity.activityId);
    assert.equal(final.questions.length, 1); assert.equal(final.questions[0].questionId, question.questionId);
    assert.equal(final.tools.filter(tool => tool.name === 'student_ask').length, 1);
  } finally { await f.close(); }
});

for (const lost of ['close', 'create']) test(`an assembly-change ${lost} receipt loss keeps the received definition when configuration changes again`, { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const activity = await f.activity(), c = await f.controlled(activity), first = c.makeAgent();
    const original = await c.send('固定第一版依据。', undefined, [], first);
    await until(async () => (await first.run(c.identity, activity.activityId, original.runId)).state === 'completed', 'The first assembly completes.');
    const event = (await first.events(c.identity, activity.activityId)).find(item => item.kind === 'context-assembled');
    const originalSnapshot = await first.snapshot(c.identity, activity.activityId, event.body.snapshotId);
    let definition = structuredClone(originalSnapshot.resolvedAgent.definition);
    definition.version = 2; definition.prompt.runtime += '\nASSEMBLY_RULE_V2';
    first.close(); await first.drain();
    const receipts = { close: [], create: [] };
    let drop = true;
    const models = { ...c.models, segments: { ...c.models.segments,
      async close(who, id, body) {
        const result = await c.models.segments.close(who, id, body); receipts.close.push({ id, body: structuredClone(body) });
        if (lost === 'close' && drop) { drop = false; throw new StorageError('resource-busy'); } return result;
      },
      async create(who, body) {
        const result = await c.models.segments.create(who, body); receipts.create.push(structuredClone(body));
        if (lost === 'create' && drop) { drop = false; throw new StorageError('resource-busy'); } return result;
      },
    } };
    const interrupted = c.makeAgent({ models, definition: async () => definition });
    const input = await c.send('继续同一活动的新问题。', undefined, [], interrupted);
    await until(async () => (await interrupted.run(c.identity, activity.activityId, input.runId)).state === 'paused', 'The assembly transition loses its receipt.');
    interrupted.close(); await interrupted.drain();
    definition = { ...definition, version: 3, prompt: { ...definition.prompt, runtime: 'ASSEMBLY_RULE_V3' } };
    const resumed = c.makeAgent({ models, definition: async () => definition });
    await resumed.continueRun(c.identity, activity.activityId, input.runId, { version: 2, requestId: randomUUID(), inputs: [] });
    const completed = await until(async () => {
      const value = await resumed.run(c.identity, activity.activityId, input.runId); return value.state === 'completed' ? value : null;
    }, 'The received assembly completes without being replaced.');
    assert.equal(receipts.close.length, 1); assert.equal(receipts.create.length, 1);
    assert.equal(completed.segmentId, receipts.create[0].segmentId);
    assert.match(JSON.stringify(f.payloads.at(-1)), /ASSEMBLY_RULE_V2/); assert.doesNotMatch(JSON.stringify(f.payloads.at(-1)), /ASSEMBLY_RULE_V3/);
    const assembled = (await resumed.events(c.identity, activity.activityId)).filter(item => item.kind === 'context-assembled').at(-1);
    const snapshot = await resumed.snapshot(c.identity, activity.activityId, assembled.body.snapshotId);
    assert.equal(snapshot.resolvedAgent.definition.version, 2, 'The recorded assembly must match the actual restored create body.');
    assert.equal((await resumed.events(c.identity, activity.activityId)).filter(item => item.kind.startsWith('model-switch-')).length, 0);
    assert.equal(f.payloads.length, 2);
  } finally { await f.close(); }
});

test('a switch requested while the first assembly is resolving seals the segment actually reached at the boundary', { timeout: 180000 }, async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const f = await fixture();
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    let resolving = false, firstLookup = true;
    const tools = { ...c.tools, async contributions(scope) {
      if (firstLookup) { firstLookup = false; resolving = true; await delayed; }
      return c.tools.contributions(scope);
    } };
    const first = c.makeAgent({ tools }), switcher = c.makeAgent();
    const original = await c.send('先完成真实的第一段回答。', undefined, [], first);
    await until(() => resolving, 'The first assembly has not created a segment yet.');
    const selection = await c.models.selection.read(c.identity), control = { requestId: randomUUID(), selectionVersion: selection.version };
    assert.equal((await switcher.switchModel(c.identity, activity.activityId, control)).state, 'paused');
    release();
    const completed = await until(async () => {
      const value = await first.run(c.identity, activity.activityId, original.runId); return value.state === 'completed' ? value : null;
    }, 'The original first call reaches the boundary.');
    const switched = await switcher.switchModel(c.identity, activity.activityId, control);
    assert.equal(switched.state, 'completed'); assert.equal(switched.fromSegmentId, completed.segmentId);
    assert.equal((await c.models.segments.read(c.identity, completed.segmentId)).closed, true);
    assert.equal(f.payloads.length, 1);
  } finally { release(); await f.close(); }
});
