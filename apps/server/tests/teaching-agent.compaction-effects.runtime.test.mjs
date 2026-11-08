import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { executionActionSchema } from '@xunjie/contracts/execution';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

// Real production owners, native PostgreSQL, published course definitions and resource storage.
// Browser acceptance/result delivery and upstream model transports are controlled here;
// this does not run a browser Worker or establish browser/executor acceptance.
const nativeCallId = 'compaction-effects-original-native-call';
const lateMarker = 'CONTROLLED_LATE_RESULT_FOR_ORIGINAL_COMMAND';
const observation = 'observation=37; cause=unknown. ';

function compactionRequest(payload) {
  for (const message of payload.messages ?? []) {
    const texts = typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(part => part.text);
    for (const text of texts) {
      let value;
      try { value = JSON.parse(text); } catch { continue; }
      if (value?.kind === 'xunjie.context-compaction') return value;
    }
  }
  return null;
}

function summary(source) {
  return { version: 1, sourceDigest: source.sourceDigest, retainedDigest: source.retainedDigest,
    retainedIds: source.retained.map(item => item.id), facts: [], inferences: [], contradictions: [],
    unknowns: [{ text: '原操作仅已接受，结果尚未确认。', sources: [source.messages.at(-1).eventId] }], unfinished: [] };
}

function successorReply(response, protocol, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = event => response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
  if (protocol === 'responses') {
    send({ type: 'response.completed', response: { id: 'compaction-successor-response', object: 'response', status: 'completed',
      output: [{ id: 'compaction-successor-message', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
  } else {
    send({ type: 'message_start', message: { id: 'compaction-successor-message', type: 'message', role: 'assistant',
      model: 'compaction-effects-messages', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 0 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 20, output_tokens: 10 } });
    send({ type: 'message_stop' });
  }
  response.end();
}

async function completed(agent, identity, activityId, runId) {
  return until(async () => {
    const run = await agent.run(identity, activityId, runId);
    assert.ok(!['paused', 'failed', 'stopped'].includes(run.state), 'Unexpected Run termination: ' + JSON.stringify(run));
    return run.state === 'completed' ? run : null;
  }, 'The original Run completes from its original execution result.', 60000);
}

async function switchRoute(c, agent, activityId, protocol) {
  const selection = await c.models.selection.read(c.identity);
  const previous = (await c.models.selection.snapshot(c.identity, selection.version)).choice.connection;
  const connectionId = randomUUID(), grantId = randomUUID();
  await c.models.save(c.identity, { requestId: randomUUID(), connectionId, expectedVersion: 0,
    name: '压缩后显式跨协议换模型', protocol,
    baseUrl: previous.baseUrl.replace(/\/v1$/, '') + (protocol === 'messages' ? '/anthropic' : '/v1'),
    path: protocol === 'messages' ? '/v1/messages' : '/responses', modelId: 'compaction-effects-' + protocol,
    dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 2048,
    credential: { action: 'replace', value: 'synthetic-compaction-successor-key' } });
  await c.models.selection.createGrant(c.identity, c.identity, { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
  const selected = await c.models.selection.save(c.identity, { requestId: randomUUID(), expectedVersion: selection.version,
    source: { kind: 'personal', connectionId, grantId } });
  const switched = await agent.switchModel(c.identity, activityId, { requestId: randomUUID(), selectionVersion: selected.version });
  assert.equal(switched.state, 'completed');
  return switched;
}

for (const { protocol, delivery } of [
  { protocol: 'responses', delivery: 'during-summary' },
  { protocol: 'messages', delivery: 'after-switch' },
]) test(`compaction preserves an accepted course Command/Wait with result delivery ${delivery} and a Chat → ${protocol} switch`,
  { timeout: 300000 }, async () => {
    let releaseSummary, heldSource, holdSummary = false, operationIssued = false;
    const summaryGate = new Promise(resolve => { releaseSummary = resolve; });
    const f = await fixture(async (payload, response) => {
      const source = compactionRequest(payload);
      if (source) {
        if (holdSummary) { heldSource = structuredClone(source); await summaryGate; }
        return reply(response, { text: JSON.stringify(summary(source)) });
      }
      if (payload.model === 'compaction-effects-' + protocol)
        return successorReply(response, protocol, '跨路线只解释原操作，不重新执行。');
      if (!operationIssued && JSON.stringify(payload).includes('START_ORIGINAL_COURSE_OPERATION')) {
        operationIssued = true;
        return reply(response, { calls: [{ id: nativeCallId, name: 'course_operation', arguments: {
          componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' },
        } }] });
      }
      reply(response, { text: '保留原观测；操作状态只按原结果核对。' });
    });
    let cleanupExecution = async () => {};
    try {
      const activity = await f.browserCourse(), c = await f.controlled(activity);
      const { identity, learning } = c;
      let agent = c.agent;
      agent.resume(); // The controlled fixture starts without a ticker; pending executions need its Wait scanner.
      // Accumulate genuine completed turns below the compaction trigger, without SQL seeding.
      for (let index = 0; index < 6; index++) {
        const history = await c.send(`已完成历史 ${index + 1}：` + observation.repeat(320));
        await completed(agent, identity, activity.activityId, history.runId);
      }
      assert.equal(f.payloads.filter(compactionRequest).length, 0, 'Compaction starts only after the course operation has been accepted.');
      const binding = activity.course.components[0], manifest = binding.definition.manifest;
      const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
        mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
          instanceId: activity.activityId + ':table', componentId: manifest.componentId, version: manifest.version,
          definitionDigest: binding.definition.digest, stateVersion: 1, operationId: randomUUID(), content: manifest.initialState }) };
      await learning.works.sync(identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      const original = await c.send('START_ORIGINAL_COURSE_OPERATION：运行原分组计算，等待真实回执。\n' + observation.repeat(320), undefined, [work]);
      const waiting = await until(async () => {
        const value = await agent.conversation(identity, activity.activityId);
        return value.waits[0]?.state === 'pending' && value.runs.find(run => run.runId === original.runId)?.state === 'waiting'
          ? value : null;
      }, 'The production course tool creates an original Command and pending Wait.');
      const originalTool = waiting.tools[0], originalWait = waiting.waits[0];
      const commandId = originalTool.commandId, browserId = randomUUID();
      const claimed = await learning.executions.agent.claimBrowser(identity, activity.activityId, commandId, browserId,
        association => agent.assertCommandDispatch(identity, activity.activityId, association));
      const action = claimed.action;
      const acceptance = { receipt: { requestId: commandId, receiver: action.receiver, state: 'accepted',
        inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(action))).digest('hex'),
        receiptId: 'compaction-effects:' + commandId, detail: '' }, execution: { executionRef: randomUUID(), acceptedSeq: 1 } };
      const accepted = await learning.executions.agent.acceptBrowser(identity, activity.activityId, commandId, browserId, acceptance,
        association => agent.assertCommandDispatch(identity, activity.activityId, association));
      assert.equal(claimed.association.runId, original.runId);
      assert.equal(claimed.association.commandId, commandId);
      assert.equal(claimed.association.stepId, originalTool.stepId);
      assert.equal(claimed.association.snapshotId, originalTool.snapshotId);

      // Controlled execution boundary: persist a labelled synthetic artifact through the real result owner.
      // No browser algorithm, Worker, or runtime build is invoked in this test.
      const output = { marker: lateMarker, value: 37 }, text = JSON.stringify(output), bytes = Buffer.from(text);
      const resultInput = { contentId: randomUUID(), output, text, name: 'controlled-late-result.json', mediaType: 'application/json',
        sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
      let report;
      const deliverResult = async () => {
        if (!report) {
          const result = await learning.executions.result(identity, activity.activityId, commandId, resultInput);
          report = { ...result, state: 'succeeded', confirmedSeq: result.confirmedSeq + 1 };
        }
        return learning.executions.report(identity, activity.activityId, commandId, report);
      };
      cleanupExecution = deliverResult;
      const acceptedHistory = (await learning.executions.history(identity, activity.activityId)).entries;
      assert.equal(acceptedHistory.length, 1);
      assert.deepEqual(acceptedHistory[0].acceptance, acceptance);

      holdSummary = true;
      const steering = await c.send('压缩历史后继续讨论原计算；不能重做原操作。', undefined, [work], agent);
      assert.equal(steering.runId, original.runId);
      await until(() => heldSource, 'Long history dispatches the paid summary while the original execution is pending.');
      assert.ok(heldSource.retained.some(item => item.kind === 'effect' && item.content.commandId === commandId
        && item.content.state === 'accepted'), 'The summary preserves the original accepted Command independently of its prose.');
      assert.ok(heldSource.retained.some(item => item.kind === 'wait' && item.content.wait_id === originalWait.waitId
        && item.content.command_id === commandId && item.content.state === 'pending'), 'The pending Wait is structurally retained.');
      assert.ok(!JSON.stringify(heldSource).includes(lateMarker), 'A summary selected before completion cannot invent the late result.');
      const summaryPayload = f.payloads.find(payload => compactionRequest(payload));
      assert.equal(summaryPayload.tools?.length ?? 0, 0);
      const whileSummarizing = await agent.conversation(identity, activity.activityId);
      assert.equal(whileSummarizing.tools.length, 1);
      assert.equal(whileSummarizing.waits[0].waitId, originalWait.waitId);
      assert.equal(whileSummarizing.waits[0].deadline, originalWait.deadline);
      assert.equal(whileSummarizing.waits[0].state, 'pending');

      if (delivery === 'during-summary') {
        await deliverResult();
        await until(async () => {
          const value = await agent.conversation(identity, activity.activityId);
          return value.waits[0]?.state === 'consumed' && value.tools[0]?.outcome === 'completed' ? value : null;
        }, 'The late result is durably associated while the summary response is still held.', 60000);
        assert.equal((await agent.events(identity, activity.activityId)).filter(event => event.kind === 'context-compacted').length, 0);
      }
      releaseSummary();
      if (delivery === 'during-summary') await completed(agent, identity, activity.activityId, original.runId);
      else await until(async () => {
        const value = await agent.conversation(identity, activity.activityId);
        const events = await agent.events(identity, activity.activityId);
        return events.some(event => event.kind === 'context-compacted')
          && value.runs.find(run => run.runId === original.runId)?.state === 'waiting' ? value : null;
      }, 'The compacted continuation returns to the original pending execution Wait.', 60000);

      const compactedEvents = await agent.events(identity, activity.activityId);
      const adoption = compactedEvents.find(event => event.kind === 'context-compacted');
      assert.ok(adoption);
      assert.equal(adoption.body.runId, original.runId);
      assert.equal(compactedEvents.filter(event => event.kind === 'context-compacted').length, 1);
      assert.equal(compactedEvents.filter(event => event.kind.startsWith('model-switch-')).length, 0);
      assert.ok(adoption.body.source.events.some(event => event.kind === 'tools-paired'), 'Only the closed native pair is compacted.');
      const beforeSwitch = await agent.conversation(identity, activity.activityId);
      assert.equal(beforeSwitch.tools[0].commandId, commandId);
      assert.equal(beforeSwitch.waits[0].waitId, originalWait.waitId);
      assert.equal(beforeSwitch.waits[0].deadline, originalWait.deadline);
      const compactedSnapshotEvent = compactedEvents.filter(event => event.kind === 'context-assembled').at(-1);
      const compactedSnapshot = await agent.snapshot(identity, activity.activityId, compactedSnapshotEvent.body.snapshotId);
      assert.deepEqual(compactedSnapshot.payload, f.payloads.at(-1));
      const compactedRequest = JSON.stringify(compactedSnapshot.payload);
      assert.ok(compactedRequest.includes(commandId));
      assert.ok(compactedRequest.includes(originalWait.waitId));
      assert.ok(compactedRequest.includes(originalWait.deadline));
      assert.ok(!compactedRequest.includes(nativeCallId), 'Native call identities stay on the original segment.');
      if (delivery === 'during-summary') assert.ok(compactedRequest.includes(lateMarker), 'The post-summary request includes the separately persisted late observation.');
      else assert.equal(beforeSwitch.waits[0].state, 'pending');

      agent.close(); await agent.drain();
      agent = c.makeAgent();
      const callsBeforeSwitch = f.payloads.length;
      const switched = await switchRoute(c, agent, activity.activityId, protocol);
      assert.notEqual(switched.toSegmentId, compactedSnapshot.segmentId);
      assert.equal(f.payloads.length, callsBeforeSwitch, 'Explicit switching creates a route, not another paid response or course operation.');
      const afterSwitch = await agent.conversation(identity, activity.activityId);
      for (const field of ['tools', 'waits', 'runs', 'inputs']) assert.deepEqual(afterSwitch[field], beforeSwitch[field], field);
      if (delivery === 'after-switch') {
        await deliverResult(); agent.resume();
        await completed(agent, identity, activity.activityId, original.runId);
      } else {
        const next = await c.send('换模型后解释原计算的固定结果，不重跑。', undefined, [work], agent);
        await completed(agent, identity, activity.activityId, next.runId);
      }

      const final = await agent.conversation(identity, activity.activityId);
      assert.equal(final.tools.length, 1); assert.equal(final.tools[0].commandId, commandId);
      assert.equal(final.tools[0].stepId, originalTool.stepId); assert.equal(final.tools[0].callId, nativeCallId);
      assert.equal(final.tools[0].outcome, 'completed');
      assert.equal(final.tools[0].result.query.output.contentId, resultInput.contentId);
      assert.deepEqual(final.tools[0].result.query.output.output, output);
      assert.equal(final.waits.length, 1); assert.equal(final.waits[0].waitId, originalWait.waitId);
      assert.equal(final.waits[0].deadline, originalWait.deadline); assert.equal(final.waits[0].state, 'consumed');
      const execution = await learning.executions.read(identity, activity.activityId, commandId);
      assert.equal(execution.executionRef, accepted.executionRef);
      assert.equal(execution.requestId, commandId); assert.equal(execution.state, 'succeeded');
      const history = (await learning.executions.history(identity, activity.activityId)).entries;
      assert.equal(history.length, 1); assert.deepEqual(history[0].action, acceptedHistory[0].action);
      assert.deepEqual(history[0].acceptance, acceptance);
      const artifact = await learning.executions.artifact(identity, activity.activityId, commandId);
      assert.equal(artifact.executionRef, accepted.executionRef); assert.equal(artifact.text, text);
      const events = await agent.events(identity, activity.activityId);
      assert.equal(events.filter(event => event.kind === 'tool-permitted').length, 1);
      assert.equal(events.filter(event => event.kind === 'wait-consumed' && event.body.waitId === originalWait.waitId).length, 1);
      assert.equal(events.filter(event => event.kind === 'model-switch-completed').length, 1);
      const successorCalls = f.payloads.filter(payload => payload.model === 'compaction-effects-' + protocol);
      assert.equal(successorCalls.length, 1, 'The new protocol only continues the original facts.');
      const sent = JSON.stringify(successorCalls[0]);
      assert.ok(sent.includes(commandId)); assert.ok(sent.includes(lateMarker)); assert.ok(!sent.includes(nativeCallId));
      if (delivery === 'after-switch') { assert.ok(sent.includes(originalWait.waitId)); assert.ok(sent.includes(originalWait.deadline)); }
      const latest = await agent.snapshot(identity, activity.activityId, events.filter(event => event.kind === 'context-assembled').at(-1).body.snapshotId);
      assert.equal(latest.segmentId, switched.toSegmentId);
      assert.deepEqual(latest.payload, successorCalls[0], 'The successor snapshot is the actual cross-protocol transport request.');
      assert.equal(f.payloads.filter(compactionRequest).length, 1, 'The accepted summary is not regenerated by switching.');

      agent.close(); await agent.drain();
      const reopened = c.makeAgent(), callsBeforeRead = f.payloads.length;
      assert.deepEqual((await reopened.conversation(identity, activity.activityId)).tools, final.tools);
      assert.deepEqual((await reopened.conversation(identity, activity.activityId)).waits, final.waits);
      assert.deepEqual(await reopened.snapshot(identity, activity.activityId, latest.snapshotId), latest);
      // Repeating the same executor report cannot consume the Wait or ask the model again.
      await deliverResult();
      assert.deepEqual((await reopened.conversation(identity, activity.activityId)).tools, final.tools);
      assert.equal((await reopened.events(identity, activity.activityId)).filter(event => event.kind === 'wait-consumed'
        && event.body.waitId === originalWait.waitId).length, 1);
      assert.equal(f.payloads.length, callsBeforeRead);
      assert.deepEqual(f.failures, []);
    } finally {
      releaseSummary();
      try { await cleanupExecution(); } finally { await f.close(); }
    }
  });
