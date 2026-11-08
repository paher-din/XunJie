import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

function compactionRequest(payload) {
  for (const message of payload.messages ?? []) {
    const texts = typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(part => part.text);
    for (const text of texts) try {
      const value = JSON.parse(text);
      if (value.kind === 'xunjie.context-compaction') return value;
    } catch { /* Ordinary learning messages are text. */ }
  }
  return null;
}

function summary(source) {
  return { version: 1, sourceDigest: source.sourceDigest, retainedDigest: source.retainedDigest,
    retainedIds: source.retained.map(item => item.id),
    facts: [{ text: '原观测为 37，学生尚未确认原因。', sources: [source.messages[0].eventId] }],
    inferences: [], contradictions: [], unknowns: [], unfinished: [] };
}

async function completed(agent, identity, activityId, runId) {
  return until(async () => {
    const run = await agent.run(identity, activityId, runId);
    if (['paused', 'failed', 'stopped'].includes(run.state)) throw new Error(JSON.stringify(run));
    return run.state === 'completed' ? run : null;
  }, 'The original learning Run completes.', 30000).catch(async error => {
    error.message += '\n' + JSON.stringify({ run: await agent.run(identity, activityId, runId),
      events: (await agent.events(identity, activityId)).filter(event => event.body.runId === runId)
        .map(event => ({ kind: event.kind, reason: event.body.reason, stepId: event.body.stepId })) });
    throw error;
  });
}

async function seedHistory(c) {
  for (let i = 0; i < 7; i++) {
    const accepted = await c.send(`历史 ${i + 1}：` + 'observation 37; cause unconfirmed. '.repeat(280));
    await completed(c.agent, c.identity, accepted.input.scope.activityId, accepted.runId);
  }
}

test('long conversation uses a bounded tool-free paid summary then continues without replacing the original record', { timeout: 180000 }, async () => {
  const f = await fixture((payload, response) => {
    const source = compactionRequest(payload);
    reply(response, { text: source ? JSON.stringify(summary(source)) : '原观测为 37，学生尚未确认原因。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    const agent = c.agent, originals = [];
    for (let i = 0; i < 8; i++) {
      const question = `第 ${i + 1} 次原始交流：` + 'observation 37; cause unconfirmed. '.repeat(280);
      originals.push(question);
      const accepted = await c.send(question);
      await completed(agent, c.identity, activity.activityId, accepted.runId);
    }
    const next = await c.send('请沿原观测继续，保留未知原因。');
    const run = await completed(agent, c.identity, activity.activityId, next.runId);
    const calls = f.payloads.filter(payload => compactionRequest(payload));
    assert.ok(calls.length > 0, 'Real accumulated history must cause an actual summary request through ModelGateway.');
    for (const call of calls) assert.equal(call.tools?.length ?? 0, 0, 'Summary generation cannot acquire tool effects.');
    const events = await agent.events(c.identity, activity.activityId);
    const adoptions = events.filter(event => event.kind === 'context-compacted');
    assert.ok(adoptions.length > 0);
    assert.equal(events.filter(event => event.kind.startsWith('model-switch-')).length, 0);
    const conversation = await agent.conversation(c.identity, activity.activityId);
    for (const text of originals) assert.ok(conversation.messages.some(message => message.role === 'student' && message.text.includes(text)));
    assert.ok(!conversation.messages.some(message => message.text.includes('retainedDigest')), 'Internal summaries are not student answers.');
    assert.ok(f.payloads.some(payload => JSON.stringify(payload).includes('原观测为 37') && !compactionRequest(payload)));
    assert.equal(run.usage.state, 'final');
    const last = events.filter(event => event.kind === 'context-assembled').at(-1);
    const snapshot = await agent.snapshot(c.identity, activity.activityId, last.body.snapshotId);
    const before = f.payloads.length;
    agent.close(); await agent.drain();
    const reopened = c.makeAgent();
    assert.deepEqual(await reopened.snapshot(c.identity, activity.activityId, snapshot.snapshotId), snapshot);
    assert.deepEqual((await reopened.conversation(c.identity, activity.activityId)).messages, conversation.messages);
    assert.equal(f.payloads.length, before, 'Reopening the complete conversation is pure reading.');
  } finally { await f.close(); }
});

test('a changed required input rejects the old summary before adopting a new context', { timeout: 180000 }, async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  const f = await fixture(async (payload, response) => {
    const source = compactionRequest(payload);
    if (source) { started(); await gate; reply(response, { text: JSON.stringify(summary(source)) }); }
    else reply(response, { text: '保留原始事实。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await seedHistory(c);
    const pending = await c.send('旧方向：解释电路的未知原因。');
    await began;
    const control = await c.agent.controlInput(c.identity, activity.activityId, pending.inputId,
      { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'revise', text: '新方向：先检查测量条件。' });
    assert.equal(control.status, 'accepted');
    release();
    const run = await until(async () => {
      const value = await c.agent.run(c.identity, activity.activityId, pending.runId);
      return ['completed', 'failed', 'paused', 'stopped'].includes(value.state) ? value : null;
    }, 'The original summary is accepted or rejected.');
    assert.equal(run.state, 'paused');
    assert.equal(run.reason, 'compaction-source-changed');
    const events = await c.agent.events(c.identity, activity.activityId);
    assert.equal(events.filter(event => event.kind === 'context-compacted').length, 0);
    assert.equal(f.payloads.length, 8, 'An obsolete summary does not cause a learning continuation.');
    const input = (await c.agent.conversation(c.identity, activity.activityId)).inputs.find(input => input.inputId === pending.inputId);
    assert.equal(input.version, 2); assert.equal(input.input.draft.question, '新方向：先检查测量条件。');
    assert.deepEqual(run.usage, { state: 'final', inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  } finally { release(); await f.close(); }
});

test('stop after native successor creation prevents adoption and leaves an explicit later question usable', { timeout: 180000 }, async () => {
  let release, created, summarize = false, hold = true;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { created = resolve; });
  const f = await fixture((payload, response) => {
    const source = compactionRequest(payload);
    if (source) summarize = true;
    reply(response, { text: source ? JSON.stringify(summary(source)) : '依原记录继续。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await seedHistory(c);
    c.agent.close(); await c.agent.drain();
    const models = { ...c.models, segments: { ...c.models.segments, async create(identity, input) {
      const result = await c.models.segments.create(identity, input);
      if (hold && summarize && input.prefix.tools.length) { hold = false; created(); await gate; }
      return result;
    } } };
    const agent = c.makeAgent({ models, leaseMs: 250 }); agent.resume();
    const original = await c.send('整理后继续当前问题。', undefined, [], agent);
    await entered;
    await agent.stop(c.identity, activity.activityId, original.runId, { requestId: randomUUID() });
    release();
    await until(async () => (await agent.run(c.identity, activity.activityId, original.runId)).state === 'stopped', 'Stop fences the adoption.');
    assert.equal((await agent.events(c.identity, activity.activityId)).filter(event => event.kind === 'context-compacted'
      && event.body.runId === original.runId).length, 0);
    const next = await c.send('我明确重新提问：从完整历史继续。', undefined, [], agent);
    await completed(agent, c.identity, activity.activityId, next.runId);
    assert.ok((await agent.conversation(c.identity, activity.activityId)).messages.some(message => message.text === '依原记录继续。'));
  } finally { release(); await f.close(); }
});

test('compacting a closed native tool pair preserves the current adopted question, fixed work and original effect identities', { timeout: 180000 }, async () => {
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'fixed-observation.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: 'CURRENT_FIXED_WORK_MUST_SURVIVE\n' + 'observation 37; reason unknown. '.repeat(2300) };
  const f = await fixture((payload, response, index) => {
    const source = compactionRequest(payload);
    if (source) reply(response, { text: JSON.stringify(summary(source)) });
    else if (index === 1) reply(response, { calls: [{ id: 'native-id-must-stay-on-original-route', name: 'read_work',
      arguments: { objectId: work.objectId, contentId: work.contentId } }] });
    else reply(response, { text: '沿原件解释；未重做读取。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    const accepted = await c.send('CURRENT_QUESTION：读取这份固定作品，解释未知原因。', undefined, [work]);
    const run = await completed(c.agent, c.identity, activity.activityId, accepted.runId);
    const summaryCall = f.payloads.find(payload => compactionRequest(payload));
    assert.ok(summaryCall, 'Closed tool history triggers compaction within the same Run.');
    const source = compactionRequest(summaryCall);
    assert.ok(source.retained.some(item => item.kind === 'input' && JSON.stringify(item.content).includes('CURRENT_QUESTION')));
    assert.ok(source.retained.some(item => item.kind === 'effect'));
    const finalPayload = JSON.stringify(f.payloads.at(-1));
    const lastMessage = f.payloads.at(-1).messages.at(-1);
    assert.equal(lastMessage.role, 'user', 'A fresh continuation ends with the actual current student question.');
    assert.match(JSON.stringify(lastMessage.content), /CURRENT_QUESTION/);
    const texts = f.payloads.at(-1).messages.flatMap(message => typeof message.content === 'string'
      ? [message.content] : (message.content ?? []).map(part => part.text));
    assert.ok(texts.some(text => text?.includes(JSON.stringify(work.value))), 'Current fixed work is host-retained even when the summary omits its text.');
    assert.match(finalPayload, /CURRENT_QUESTION/);
    assert.doesNotMatch(finalPayload, /native-id-must-stay-on-original-route/);
    const conversation = await c.agent.conversation(c.identity, activity.activityId);
    assert.equal(conversation.tools.length, 1);
    assert.ok(finalPayload.includes(conversation.tools[0].commandId));
    assert.ok(JSON.stringify(lastMessage.content).includes(conversation.tools[0].commandId),
      'The actual continuation user turn carries the original completed read, even after a summary-only step.');
    assert.match(JSON.stringify(lastMessage.content), /completed/);
    assert.deepEqual(run.usage, { state: 'final', inputTokens: 60, outputTokens: 30, totalTokens: 90 });
    const events = await c.agent.events(c.identity, activity.activityId);
    const adoption = events.find(event => event.kind === 'context-compacted');
    assert.ok(adoption.body.source.events.some(event => event.kind === 'tools-paired'));
    assert.equal(events.filter(event => event.kind === 'tool-permitted').length, 1);
  } finally { await f.close(); }
});

for (const lost of ['summary-close', 'summary-create', 'summary-return', 'adoption-close', 'adoption-create']) test(`restart reconciles the original summary and native segments after ${lost} acknowledgement loss`, { timeout: 180000 }, async () => {
  let summaryIssued = false, drop = true;
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'retained.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '原件中的观察为 37。' + 'observation 37; cause unknown. '.repeat(2400) };
  const f = await fixture((payload, response, index) => {
    const source = compactionRequest(payload);
    if (source) { summaryIssued = true; reply(response, { text: JSON.stringify(summary(source)) }); }
    else if (index === 1) reply(response, { calls: [{ id: 'original-only-read', name: 'read_work',
      arguments: { objectId: work.objectId, contentId: work.contentId } }] });
    else reply(response, { text: '读取和摘要均只执行一次，沿原结果继续。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    const lose = stage => { if (drop && lost === stage) { drop = false; throw new StorageError('resource-busy'); } };
    const models = { ...c.models, segments: { ...c.models.segments,
      async close(...args) { const result = await c.models.segments.close(...args);
        lose(summaryIssued ? 'adoption-close' : 'summary-close'); return result; },
      async create(identity, input) { const result = await c.models.segments.create(identity, input);
        if (!input.prefix.tools.length) lose('summary-create');
        else if (summaryIssued) lose('adoption-create');
        return result;
      },
    }, checks: { ...c.models.checks, async read(...args) {
      const result = await c.models.checks.read(...args);
      if (summaryIssued && result.state === 'completed') lose('summary-return');
      return result;
    } } };
    const first = c.makeAgent({ models });
    const accepted = await c.send('请核对原件与未知原因。', undefined, [work], first);
    await until(async () => (await first.run(c.identity, activity.activityId, accepted.runId)).state === 'paused', 'The original boundary reply is lost.');
    first.close(); await first.drain();
    const reopened = c.makeAgent({ models });
    await reopened.continueRun(c.identity, activity.activityId, accepted.runId, { version: 2, requestId: randomUUID(), inputs: [] });
    const run = await completed(reopened, c.identity, activity.activityId, accepted.runId);
    assert.equal(drop, false);
    assert.equal(f.payloads.filter(payload => compactionRequest(payload)).length, 1);
    assert.equal(f.payloads.length, 3);
    const events = await reopened.events(c.identity, activity.activityId);
    assert.equal(events.filter(event => event.kind === 'context-compacted').length, 1);
    assert.equal((await reopened.conversation(c.identity, activity.activityId)).tools.length, 1);
    assert.deepEqual(run.usage, { state: 'final', inputTokens: 60, outputTokens: 30, totalTokens: 90 });
    await reopened.validate();
  } finally { await f.close(); }
});

test('an unknown summary outcome keeps its original attempt and budget until that same result is confirmed', { timeout: 180000 }, async () => {
  let hide = true, summaryIssued = false;
  const f = await fixture((payload, response) => {
    const source = compactionRequest(payload);
    if (source) summaryIssued = true;
    reply(response, { text: source ? JSON.stringify(summary(source)) : '沿原记录继续。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await seedHistory(c);
    c.agent.close(); await c.agent.drain();
    const models = { ...c.models, checks: { ...c.models.checks, async read(...args) {
      const result = await c.models.checks.read(...args);
      return hide && summaryIssued && result.state === 'completed' ? { ...result, state: 'unknown', reason: 'result-unconfirmed',
        resultRef: null, text: '', usage: { state: 'unknown' } } : result;
    } } };
    const first = c.makeAgent({ models });
    const original = await c.send('现在继续这段长对话。', undefined, [], first);
    const paused = await until(async () => {
      const run = await first.run(c.identity, activity.activityId, original.runId); return run.state === 'paused' ? run : null;
    }, 'The summary outcome remains unknown.');
    assert.equal(paused.reason, 'result-unknown');
    assert.equal(paused.completedAt, null);
    assert.equal(f.payloads.filter(payload => compactionRequest(payload)).length, 1);
    first.close(); await first.drain();
    hide = false;
    const reopened = c.makeAgent({ models });
    const continuation = await reopened.continueRun(c.identity, activity.activityId, original.runId,
      { version: 2, requestId: randomUUID(), inputs: [] });
    assert.equal(continuation.runId, original.runId);
    const run = await completed(reopened, c.identity, activity.activityId, original.runId);
    assert.equal(f.payloads.filter(payload => compactionRequest(payload)).length, 1);
    assert.deepEqual(run.usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
    assert.equal((await reopened.events(c.identity, activity.activityId)).filter(event => event.kind === 'context-compacted').length, 1);
  } finally { await f.close(); }
});

test('two generations adopt one summary while steering and queue keep their original order', { timeout: 180000 }, async () => {
  let release, summaryIssued = false;
  const gate = new Promise(resolve => { release = resolve; }), received = [];
  const f = await fixture((payload, response) => {
    const source = compactionRequest(payload);
    if (source) summaryIssued = true;
    reply(response, { text: source ? JSON.stringify(summary(source)) : '按实际学生输入继续。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await seedHistory(c); c.agent.close(); await c.agent.drain();
    const models = { ...c.models, checks: { ...c.models.checks, async read(...args) {
      const result = await c.models.checks.read(...args);
      if (summaryIssued && result.state === 'completed' && result.text.includes('retainedDigest')) {
        received.push(result.attemptId); await gate;
      }
      return result;
    } } };
    const first = c.makeAgent({ models, driverId: 'compaction-first', leaseMs: 300 });
    const second = c.makeAgent({ models, driverId: 'compaction-second', leaseMs: 300 });
    const original = await c.send('继续当前问题 CURRENT_DIRECTION。', undefined, [], first);
    await until(() => received.length === 1, 'The first driver awaits its original summary receipt.');
    const queued = await c.send('QUEUE_LATER：下一轮才解释。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } }, [], second);
    const steered = await c.send('STEERING_NOW：当前先核实测量条件。', { version: 1, mode: 'steering', basis: { source: 'explicit', preferenceVersion: 0 } }, [], second);
    assert.equal(queued.runId, original.runId); assert.equal(steered.runId, original.runId);
    first.closeDispatch(); second.resume();
    await until(() => received.length >= 2, 'A new generation reconciles the same paid summary.');
    assert.equal(new Set(received).size, 1);
    await second.assertModelDispatch(c.identity, activity.activityId, { runId: original.runId, activityId: activity.activityId,
      driverId: 'compaction-second', generation: 2, attemptId: received[0], dispatch: false });
    release();
    const run = await completed(second, c.identity, activity.activityId, original.runId);
    await until(async () => {
      const value = await second.conversation(c.identity, activity.activityId);
      return value.inputs.find(item => item.inputId === queued.inputId)?.state === 'adopted'
        && value.runs.every(item => item.state === 'completed');
    }, 'The queued input starts after the original Run completes.');
    await first.drain();
    assert.equal(f.payloads.filter(payload => compactionRequest(payload)).length, 1);
    assert.equal(f.payloads.length, 10);
    assert.match(JSON.stringify(f.payloads[8]), /STEERING_NOW/);
    assert.doesNotMatch(JSON.stringify(f.payloads[8]), /QUEUE_LATER/);
    assert.match(JSON.stringify(f.payloads[9]), /QUEUE_LATER/);
    const events = await second.events(c.identity, activity.activityId);
    assert.equal(events.filter(event => event.kind === 'context-compacted').length, 1);
    assert.equal(events.filter(event => event.kind === 'context-compaction-generated').length, 1);
    assert.deepEqual(run.usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
  } finally { release(); await f.close(); }
});

test('a confirmed provider capacity refusal keeps its failed attempt and uses one budgeted compaction continuation', { timeout: 180000 }, async () => {
  const f = await fixture((payload, response, index) => {
    const source = compactionRequest(payload);
    if (index === 2) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'The context window was exceeded.' } }));
    } else reply(response, { text: source ? JSON.stringify(summary(source)) : '原观测为 37；未知原因仍待核实。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    const before = await c.send('原观测为 37，尚未核实原因。');
    await completed(c.agent, c.identity, activity.activityId, before.runId);
    const current = await c.send('继续解释原观测，并保留未知。');
    const run = await completed(c.agent, c.identity, activity.activityId, current.runId);
    const events = (await c.agent.events(c.identity, activity.activityId)).filter(event => event.body.runId === current.runId);
    assert.equal(f.payloads.length, 4);
    assert.equal(f.payloads.filter(payload => compactionRequest(payload)).length, 1);
    assert.equal(events.filter(event => event.kind === 'budget-reserved').length, 3);
    assert.equal(events.filter(event => event.kind === 'context-compacted').length, 1);
    const failedRequest = events.find(event => event.kind === 'context-assembled');
    const failed = await c.models.checks.read(c.identity, failedRequest.body.attemptId);
    assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'context-capacity-exceeded');
    assert.ok(failed.resultRef);
    assert.deepEqual((await c.agent.snapshot(c.identity, activity.activityId, failedRequest.body.snapshotId)).payload, f.payloads[1]);
    assert.equal(run.usage.state, 'partial', 'Unknown rejected-call usage is retained as unknown, not counted as zero.');
  } finally { await f.close(); }
});

for (const failure of ['missing-retained-id', 'unverifiable-source', 'malformed-json', 'provider-failure']) {
  test(`a ${failure} summary is charged but never replaces the original context`, { timeout: 180000 }, async () => {
    const f = await fixture((payload, response) => {
      const source = compactionRequest(payload);
      if (!source) return reply(response, { text: '原观测为 37，原因未知。' });
      if (failure === 'provider-failure') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Rejected summary request.' } }));
        return;
      }
      const value = summary(source);
      if (failure === 'missing-retained-id') value.retainedIds.pop();
      if (failure === 'unverifiable-source') value.facts[0].sources = [randomUUID()];
      reply(response, { text: failure === 'malformed-json' ? 'not JSON' : JSON.stringify(value) });
    });
    try {
      const activity = await f.activity(), c = await f.controlled(activity);
      await seedHistory(c);
      const accepted = await c.send('保留原问题与当前未知，不补造结论。');
      const run = await until(async () => {
        const value = await c.agent.run(c.identity, activity.activityId, accepted.runId);
        return value.state === 'paused' ? value : null;
      }, 'Invalid summary pauses with its original paid attempt.');
      assert.equal(run.reason, failure === 'provider-failure' ? 'upstream-http' : 'compaction-invalid-summary');
      const events = (await c.agent.events(c.identity, activity.activityId)).filter(event => event.body.runId === run.runId);
      assert.equal(events.filter(event => event.kind === 'context-compacted').length, 0);
      assert.equal(events.filter(event => event.kind === 'context-compaction-rejected').length, 1);
      assert.equal(events.filter(event => event.kind === 'budget-settled').length, 1);
      assert.equal(f.payloads.length, 8);
      assert.equal(run.usage.state, failure === 'provider-failure' ? 'unknown' : 'final');
      const conversation = await c.agent.conversation(c.identity, activity.activityId);
      assert.equal(conversation.inputs.length, 8);
      assert.ok(conversation.messages.some(message => message.text.includes('历史 1：')));
      c.agent.close(); await c.agent.drain();
      const reopened = c.makeAgent();
      await reopened.validate();
      assert.deepEqual(await reopened.conversation(c.identity, activity.activityId), conversation);
      assert.equal(f.payloads.length, 8, 'Pure restore/read never regenerates a rejected summary.');
    } finally { await f.close(); }
  });
}

test('a second explicit context refusal pauses the original Run without another compaction or reset budget', { timeout: 180000 }, async () => {
  const f = await fixture((payload, response, index) => {
    const source = compactionRequest(payload);
    if (index === 2 || index === 4) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'context_length_exceeded' } }));
    } else reply(response, { text: source ? JSON.stringify(summary(source)) : '原观测为 37，原因未知。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    const before = await c.send('原观测为 37，原因尚未核实。');
    await completed(c.agent, c.identity, activity.activityId, before.runId);
    const accepted = await c.send('继续核对原观测。');
    const run = await until(async () => {
      const value = await c.agent.run(c.identity, activity.activityId, accepted.runId);
      return value.state === 'paused' ? value : null;
    }, 'Repeated confirmed capacity refusal is bounded.');
    assert.equal(run.reason, 'capacity-exceeded');
    const events = (await c.agent.events(c.identity, activity.activityId)).filter(event => event.body.runId === run.runId);
    assert.equal(events.filter(event => event.kind === 'model-capacity-rejected').length, 2);
    assert.equal(events.filter(event => event.kind === 'budget-reserved').length, 3);
    assert.equal(events.filter(event => event.kind === 'context-compacted').length, 1);
    assert.equal(f.payloads.length, 4);
    assert.equal(run.usage.state, 'partial');
  } finally { await f.close(); }
});

test('source rejection after a lost adoption receipt releases the transition for an explicit successor', { timeout: 180000 }, async () => {
  let summaryIssued = false, lose = true;
  const f = await fixture((payload, response) => {
    const source = compactionRequest(payload);
    if (source) summaryIssued = true;
    reply(response, { text: source ? JSON.stringify(summary(source)) : '沿最新明确问题继续，旧记录仍可核对。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await seedHistory(c); c.agent.close(); await c.agent.drain();
    const models = { ...c.models, segments: { ...c.models.segments, async create(identity, input) {
      const value = await c.models.segments.create(identity, input);
      if (lose && summaryIssued && input.prefix.tools.length) { lose = false; throw new StorageError('resource-busy'); }
      return value;
    } } };
    const agent = c.makeAgent({ models });
    const accepted = await c.send('原问题：解释观测。', undefined, [], agent);
    await until(async () => (await agent.run(c.identity, activity.activityId, accepted.runId)).state === 'paused', 'Adoption receipt is lost.');
    const revised = await agent.controlInput(c.identity, activity.activityId, accepted.inputId,
      { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'revise', text: '新问题：只核对测量条件。' });
    assert.equal(revised.status, 'accepted');
    await agent.continueRun(c.identity, activity.activityId, accepted.runId, { version: 2, requestId: randomUUID(), inputs: [] });
    const rejected = await until(async () => {
      const run = await agent.run(c.identity, activity.activityId, accepted.runId);
      return run.state === 'paused' && run.reason === 'compaction-source-changed' ? run : null;
    }, 'The obsolete summary is rejected.');
    assert.equal((await agent.events(c.identity, activity.activityId)).filter(event => event.kind === 'context-compacted').length, 0);
    const continuation = await agent.continueRun(c.identity, activity.activityId, rejected.runId,
      { version: 2, requestId: randomUUID(), inputs: [{ inputId: accepted.inputId, expectedVersion: 2 }] });
    assert.notEqual(continuation.runId, rejected.runId);
    await completed(agent, c.identity, activity.activityId, continuation.runId);
    assert.match(JSON.stringify(f.payloads.at(-1)), /新问题：只核对测量条件/);
    await agent.validate();
  } finally { await f.close(); }
});

test('the summary consumes the original model step allowance and cannot reset it by changing segments', { timeout: 180000 }, async () => {
  const f = await fixture((payload, response) => {
    const source = compactionRequest(payload);
    reply(response, { text: source ? JSON.stringify(summary(source)) : '原观测为 37，原因未知。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await seedHistory(c); c.agent.close(); await c.agent.drain();
    const agent = c.makeAgent({ limits: { maxModelSteps: 1 } });
    const accepted = await c.send('请继续原观测，只能使用本次额度。', undefined, [], agent);
    const run = await until(async () => {
      const value = await agent.run(c.identity, activity.activityId, accepted.runId);
      return value.state === 'paused' ? value : null;
    }, 'The original model step budget remains exhausted after compaction.');
    assert.equal(run.reason, 'model-step-budget-exhausted');
    assert.equal(f.payloads.length, 8);
    const events = (await agent.events(c.identity, activity.activityId)).filter(event => event.body.runId === run.runId);
    assert.equal(events.filter(event => event.kind === 'budget-reserved').length, 1);
    assert.equal(events.filter(event => event.kind === 'context-compacted').length, 1);
    assert.deepEqual(run.usage, { state: 'final', inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  } finally { await f.close(); }
});

test('required fixed work that leaves no summary source capacity is preserved with a specific pause scope', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { text: '保留完整观测。' }));
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    const history = await c.send('原观测为 37，原因待核实。');
    await completed(c.agent, c.identity, activity.activityId, history.runId);
    const selection = await c.models.selection.read(c.identity);
    const { choice } = await c.models.selection.snapshot(c.identity, selection.version);
    const connection = choice.connection;
    await c.models.save(c.identity, { requestId: randomUUID(), connectionId: connection.connectionId, expectedVersion: connection.version,
      name: connection.name, protocol: connection.protocol, baseUrl: connection.baseUrl, path: connection.path,
      modelId: connection.modelId, dialect: connection.dialect, parameterMode: connection.parameterMode, enabled: true,
      contextWindow: 16384, maxOutputTokens: 2048, credential: { action: 'keep' } });
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: '不可截断的当前观察.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: 'required observation; '.repeat(4000) };
    const accepted = await c.send('当前必保留问题。', undefined, [work]);
    const run = await until(async () => {
      const value = await c.agent.run(c.identity, activity.activityId, accepted.runId);
      return value.state === 'paused' ? value : null;
    }, 'Required contents cannot be silently truncated to fit a summary.');
    assert.equal(run.reason, 'compaction-source-capacity-exceeded');
    assert.equal(f.payloads.length, 1);
    const paused = (await c.agent.events(c.identity, activity.activityId)).find(event => event.kind === 'capacity-paused' && event.body.runId === run.runId);
    assert.ok(paused.body.requiredScope.questions.includes(accepted.input.requestId));
    assert.ok(paused.body.requiredScope.works.includes(work.contentId));
    assert.ok(paused.body.requiredScope.workNames.includes(work.name));
    const original = (await c.agent.conversation(c.identity, activity.activityId)).inputs.find(input => input.inputId === accepted.inputId);
    assert.equal(original.input.works[0].value, work.value);
  } finally { await f.close(); }
});

for (const route of ['chat-completions', 'responses', 'messages', 'responses-terminal']) {
  test(`${route} explicit capacity rejection retains its native attempt and never retries an uncompressible source`, { timeout: 180000 }, async () => {
    const f = await fixture((_payload, response) => {
      const error = { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'The context window was exceeded.' };
      if (route === 'responses-terminal') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ type: 'response.failed', response: { id: 'capacity-response', object: 'response',
          status: 'failed', output: [], error } }) + '\n\n');
      } else {
        response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error }));
      }
    });
    try {
      const activity = await f.activity(), c = await f.controlled(activity);
      const selection = await c.models.selection.read(c.identity);
      const { choice } = await c.models.selection.snapshot(c.identity, selection.version);
      const connection = choice.connection, protocol = route === 'responses-terminal' ? 'responses' : route;
      await c.models.save(c.identity, { requestId: randomUUID(), connectionId: connection.connectionId, expectedVersion: connection.version,
        name: connection.name, protocol, baseUrl: connection.baseUrl.replace(/\/v1$/, protocol === 'messages' ? '/anthropic' : '/v1'),
        path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions',
        modelId: connection.modelId, dialect: 'deepseek', parameterMode: 'plain', enabled: true,
        contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-capacity-key' } });
      const accepted = await c.send('当前问题与原件必须保留。');
      const run = await until(async () => {
        const value = await c.agent.run(c.identity, activity.activityId, accepted.runId);
        return value.state === 'paused' ? value : null;
      }, 'Uncompressible context refusal pauses without retrying.');
      assert.equal(run.reason, 'compaction-source-capacity-exceeded');
      const attempt = await c.models.checks.read(c.identity, run.attemptId);
      assert.equal(attempt.state, 'failed'); assert.equal(attempt.reason, 'context-capacity-exceeded');
      assert.ok(attempt.resultRef); assert.equal(attempt.physicalRequestEnded, true);
      assert.equal(attempt.usage.state, 'unknown'); assert.equal(f.payloads.length, 1);
      assert.equal((await c.agent.events(c.identity, activity.activityId)).filter(event => event.kind === 'model-capacity-rejected').length, 1);
    } finally { await f.close(); }
  });
}
