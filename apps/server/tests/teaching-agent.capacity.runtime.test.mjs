import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

async function capacity(c, contextWindow, maxOutputTokens) {
  const selection = await c.models.selection.read(c.identity);
  const { choice } = await c.models.selection.snapshot(c.identity, selection.version);
  const connection = choice.connection;
  await c.models.save(c.identity, { requestId: randomUUID(), connectionId: connection.connectionId,
    expectedVersion: connection.version, name: connection.name, protocol: connection.protocol,
    baseUrl: connection.baseUrl, path: connection.path, modelId: connection.modelId,
    dialect: connection.dialect, parameterMode: connection.parameterMode, enabled: true,
    contextWindow, maxOutputTokens, credential: { action: 'keep' } });
}

async function terminal(c, accepted, agent = c.agent) {
  return until(async () => {
    const run = await agent.run(c.identity, accepted.input.scope.activityId, accepted.runId);
    return ['completed', 'paused', 'failed', 'stopped'].includes(run.state) ? run : null;
  }, 'The capacity-limited Run reaches a terminal state.', 30000);
}

async function calls(c, run, payloads, agent = c.agent) {
  const events = (await agent.events(c.identity, run.activityId)).filter(event => event.body.runId === run.runId);
  const assembled = events.filter(event => event.kind === 'context-assembled');
  const reservations = events.filter(event => event.kind === 'budget-reserved');
  assert.equal(assembled.length, payloads.length);
  assert.equal(reservations.length, payloads.length);
  const snapshots = [];
  for (let index = 0; index < assembled.length; index++) {
    const event = assembled[index], reservation = reservations[index];
    const snapshot = await agent.snapshot(c.identity, run.activityId, event.body.snapshotId);
    const payload = payloads[index], output = payload.max_tokens ?? payload.max_output_tokens ?? payload.max_completion_tokens;
    const { rows: [step] } = await c.storage.read('SELECT output_reserved,plan FROM teaching_steps WHERE step_id=$1', [reservation.body.stepId]);
    assert.equal(output, reservation.body.outputTokens);
    assert.equal(output, Number(step.output_reserved));
    assert.equal(output, step.plan.input.limits.maxOutputTokens);
    assert.equal(output, snapshot.maxOutputTokens);
    assert.equal(output, snapshot.contextManifest.capacity.outputReserve);
    assert.equal(output, event.body.capacity.outputReserve);
    assert.equal(event.body.capacity.counter, 'estimated');
    assert.ok(output + event.body.capacity.estimatedInputTokens <= snapshot.contextWindow);
    assert.deepEqual(snapshot.payload, payload);
    snapshots.push(snapshot);
  }
  return { events, snapshots };
}

function nativeReply(protocol, response) {
  if (protocol === 'chat-completions') return reply(response, { text: '保留模型规格，按本次预算回答。' });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = value => response.write((protocol === 'messages' ? 'event: ' + value.type + '\ndata: ' : 'data: ')
    + JSON.stringify(value) + '\n\n');
  if (protocol === 'responses') {
    send({ type: 'response.created', response: { id: 'capacity-response', object: 'response', status: 'in_progress', output: [] } });
    send({ type: 'response.completed', response: { id: 'capacity-response', object: 'response', status: 'completed',
      output: [{ id: 'capacity-message', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: '按本次预算回答。', annotations: [] }] }],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
  } else {
    send({ type: 'message_start', message: { id: 'capacity-message', type: 'message', role: 'assistant',
      model: 'fixture-input-control', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '按本次预算回答。' } });
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 20, output_tokens: 10 } });
    send({ type: 'message_stop' });
  }
  response.end();
}

for (const protocol of ['chat-completions', 'responses', 'messages']) {
  test(`${protocol}: a 1M context and output specification uses the normal 64K Run allowance without spurious compaction`, { timeout: 180000 }, async () => {
    const f = await fixture((_payload, response) => nativeReply(protocol, response), {}, protocol);
    try {
      const activity = await f.activity(), c = await f.controlled(activity);
      await capacity(c, 1_048_576, 1_048_576);
      let lastSnapshot;
      for (const question of ['记录原观测：37。', '沿原观测继续。']) {
        const accepted = await c.send(question), run = await terminal(c, accepted);
        assert.equal(run.state, 'completed', run.reason);
        assert.equal(run.model.contextWindow, 1_048_576);
        assert.equal(run.model.maxOutputTokens, 1_048_576);
        const { events, snapshots } = await calls(c, run, [f.payloads.at(-1)]);
        assert.equal(snapshots[0].maxOutputTokens, 65_536);
        assert.equal(snapshots[0].resolvedAgent.model.maxOutputTokens, 1_048_576);
        assert.equal(events.filter(event => event.kind === 'context-compaction-selected').length, 0);
        lastSnapshot = snapshots[0];
      }
      c.agent.close(); await c.agent.drain();
      const reopened = c.makeAgent();
      await reopened.validate();
      assert.deepEqual(await reopened.snapshot(c.identity, activity.activityId, lastSnapshot.snapshotId), lastSnapshot);
      assert.equal(f.payloads.length, 2);
    } finally { await f.close(); }
  });
}

test('available context reduces the call reservation without rewriting a larger saved output limit', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await capacity(c, 32_768, 1_048_576);
    const accepted = await c.send('按实际可用空间回答。'), run = await terminal(c, accepted);
    assert.equal(run.state, 'completed', run.reason);
    const { events, snapshots } = await calls(c, run, f.payloads);
    assert.equal(snapshots[0].maxOutputTokens, 32_768 - events.find(event => event.kind === 'context-assembled').body.capacity.estimatedInputTokens);
    assert.equal(snapshots[0].model.maxOutputTokens, 1_048_576);
    assert.equal(snapshots[0].resolvedAgent.model.maxOutputTokens, 1_048_576);
  } finally { await f.close(); }
});

test('required input exceeding the estimated context pauses without a zero-token reservation or native request', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await capacity(c, 128, 1_048_576);
    const accepted = await c.send('保留完整问题，不截断。'), run = await terminal(c, accepted);
    assert.equal(run.state, 'paused');
    assert.equal(run.reason, 'capacity-exceeded');
    assert.equal(f.payloads.length, 0);
    const events = (await c.agent.events(c.identity, activity.activityId)).filter(event => event.body.runId === run.runId);
    assert.equal(events.filter(event => event.kind === 'budget-reserved').length, 0);
    const paused = events.find(event => event.kind === 'capacity-paused');
    assert.equal(paused.body.counting, 'estimated');
    assert.ok(paused.body.requiredScope.questions.includes(accepted.input.requestId));
  } finally { await f.close(); }
});

for (const usage of ['final', 'unknown']) {
  test(`${usage} usage still exhausts the original Run output allowance across tool steps`, { timeout: 180000 }, async () => {
    const f = await fixture((_payload, response, index) => {
      const call = { id: 'capacity-discover-' + index, name: 'discover_tools',
        arguments: { purpose: '核对可用工具', source: null, object: null, cursor: null, pageSize: 1 } };
      if (usage === 'final') return reply(response, { calls: [call] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ id: 'capacity-unknown', choices: [{ index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: 'tool_calls' }] }) + '\n\n');
      response.end('data: [DONE]\n\n');
    });
    try {
      const activity = await f.activity(), c = await f.controlled(activity, { limits: { maxOutputTokens: 20 } });
      await capacity(c, 262_144, 1_048_576);
      const accepted = await c.send('在当前额度内核对工具。'), run = await terminal(c, accepted);
      assert.equal(run.state, 'paused');
      assert.equal(run.reason, 'output-token-budget-exhausted');
      assert.deepEqual(f.payloads.map(payload => payload.max_tokens), usage === 'final' ? [20, 10] : [20]);
      const { events } = await calls(c, run, f.payloads);
      assert.equal(events.filter(event => event.kind === 'context-compaction-selected').length, 0);
      await c.agent.validate();
    } finally { await f.close(); }
  });
}

test('a paid summary caps only its own call and continuation uses the remaining Run budget with the original model identity', { timeout: 180000 }, async () => {
  const f = await fixture((payload, response) => {
    const source = payload.messages.flatMap(message => typeof message.content === 'string' ? [message.content]
      : (message.content ?? []).map(part => part.text)).map(text => {
      try { return JSON.parse(text); } catch { return null; }
    }).find(value => value?.kind === 'xunjie.context-compaction');
    reply(response, { text: source ? JSON.stringify({ version: 1, sourceDigest: source.sourceDigest,
      retainedDigest: source.retainedDigest, retainedIds: source.retained.map(item => item.id),
      facts: [{ text: '原观测为 37。', sources: [source.messages[0].eventId] }],
      inferences: [], contradictions: [], unknowns: [], unfinished: [] }) : '原观测为 37。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await capacity(c, 262_144, 1_048_576);
    const first = await c.send('原观测为 37。', undefined, [{ objectId: randomUUID(), contentId: randomUUID(),
      name: '原始观察.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: 'observation; '.repeat(5500) }]);
    assert.equal((await terminal(c, first)).state, 'completed');
    const next = await c.send('沿原观测继续。'), run = await terminal(c, next);
    assert.equal(run.state, 'completed', run.reason);
    assert.deepEqual(f.payloads.slice(1).map(payload => payload.max_tokens), [2048, 65_526]);
    const { events, snapshots } = await calls(c, run, f.payloads.slice(1));
    assert.equal(events.filter(event => event.kind === 'context-compacted').length, 1);
    assert.equal(snapshots[1].model.maxOutputTokens, 1_048_576);
    assert.equal(run.initialResolvedAgentId, snapshots[0].resolvedAgent.resolvedId);
    const { rows: [record] } = await c.storage.read('SELECT body FROM teaching_compactions WHERE run_id=$1', [run.runId]);
    assert.equal(record.body.resolvedAgent.model.maxOutputTokens, 1_048_576);
    assert.notEqual(record.body.resolvedAgent.resolvedId, snapshots[0].resolvedAgent.resolvedId);
    assert.equal(record.body.resolvedAgent.resolvedId, snapshots[1].resolvedAgent.resolvedId);
    c.agent.close(); await c.agent.drain();
    const reopened = c.makeAgent();
    await reopened.validate();
    for (const snapshot of snapshots) assert.deepEqual(await reopened.snapshot(c.identity, activity.activityId, snapshot.snapshotId), snapshot);
    assert.equal(f.payloads.length, 3, 'Restore never creates another paid request.');
  } finally { await f.close(); }
});

test('clamping a 1M output limit does not relax the existing conservative Run input allowance', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { calls: [{ id: 'capacity-input-bound', name: 'discover_tools',
    arguments: { purpose: '核对可用工具', source: null, object: null, cursor: null, pageSize: 1 } }] }));
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await capacity(c, 1_048_576, 1_048_576);
    const accepted = await c.send('按原资源额度继续。'), run = await terminal(c, accepted);
    assert.equal(run.state, 'paused');
    assert.equal(run.reason, 'input-token-budget-exhausted');
    assert.equal(f.payloads.length, 1);
    const { events } = await calls(c, run, f.payloads);
    assert.equal(events.find(event => event.kind === 'budget-reserved').body.inputReserve, 1_048_576);
    assert.equal(f.payloads[0].max_tokens, 65_536);
  } finally { await f.close(); }
});
