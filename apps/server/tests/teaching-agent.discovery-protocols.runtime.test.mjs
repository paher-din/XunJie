import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

// Controlled provider events enter the real SDK. Owners, native pairing and tools stay real.
function nativeReply(protocol, response, { call, text = '' }) {
  if (protocol === 'chat-completions') return reply(response, { text, calls: call ? [call] : [] });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = value => response.write((protocol === 'messages' ? 'event: ' + value.type + '\n' : '')
    + 'data: ' + JSON.stringify(value) + '\n\n');
  if (protocol === 'responses') {
    send({ type: 'response.completed', response: { id: 'discovery-response', object: 'response', status: 'completed',
      output: call ? [{ id: 'item-' + call.id, type: 'function_call', call_id: call.id, name: call.name,
        arguments: JSON.stringify(call.arguments), status: 'completed' }] : [{ id: 'discovery-text', type: 'message', role: 'assistant',
        status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
  } else {
    for (const event of [
      { type: 'message_start', message: { id: 'discovery-message', type: 'message', role: 'assistant', model: 'fixture-input-control',
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: call
        ? { type: 'tool_use', id: call.id, name: call.name, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: call
        ? { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } : { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { input_tokens: 20, output_tokens: 10 } },
      { type: 'message_stop' },
    ]) send(event);
  }
  response.end();
}

function toolDefinitions(protocol, payload) {
  return payload.tools.map(tool => protocol === 'chat-completions' ? tool.function
    : { ...tool, parameters: protocol === 'messages' ? tool.input_schema : tool.parameters });
}
function toolFeedback(protocol, payload, callId) {
  let text;
  if (protocol === 'chat-completions') text = payload.messages.find(message => message.tool_call_id === callId).content;
  else if (protocol === 'responses') text = payload.input.find(item => item.type === 'function_call_output' && item.call_id === callId).output;
  else {
    const result = payload.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(part => part.type === 'tool_result' && part.tool_use_id === callId);
    text = result.content.find(part => part.type === 'text').text;
  }
  const parsed = JSON.parse(text);
  return parsed.result ?? parsed;
}

for (const protocol of ['chat-completions', 'responses', 'messages']) {
  test(`${protocol}: discovery loads a fixed executor into the next segment and calls the real original`, { timeout: 180000 }, async () => {
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'protocol-original.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '固定课程工具读取的原件观测值为 83。' };
    let entry, alias, realRead;
    const f = await fixture((payload, response, index) => {
      const tools = toolDefinitions(protocol, payload);
      if (index === 1) {
        for (const name of ['discover_tools', 'load_tools', 'read_tool_result']) assert.ok(tools.some(tool => tool.name === name));
        assert.ok(!tools.some(tool => tool.description === 'DEFERRED_PROTOCOL'));
        nativeReply(protocol, response, { call: { id: 'discover-protocol', name: 'discover_tools', arguments: {
          purpose: 'DEFERRED_PROTOCOL', source: null, object: null, cursor: null, pageSize: 2,
        } } });
      } else if (index === 2) {
        const entries = toolFeedback(protocol, payload, 'discover-protocol').entries;
        assert.equal(entries.length, 1); entry = entries[0];
        assert.equal(entry.source.sourceId, 'course:deferred');
        assert.deepEqual(entry.executor, realRead.executor);
        assert.ok(!tools.some(tool => tool.description === 'DEFERRED_PROTOCOL'), 'discovery alone does not load a tool');
        nativeReply(protocol, response, { call: { id: 'load-protocol', name: 'load_tools', arguments: { bindingIds: [entry.bindingId] } } });
      } else if (index === 3) {
        const lastInput = protocol === 'responses' ? payload.input.at(-1) : payload.messages.at(-1);
        assert.equal(lastInput.role, 'user', 'a new assembly segment must end with the fixed current user intent');
        const loaded = tools.find(tool => tool.description === 'DEFERRED_PROTOCOL');
        assert.ok(loaded, 'the paired load enables its actual definition in a new segment');
        alias = loaded.name;
        assert.notEqual(alias, 'read_work', 'same-name sources have distinct model aliases');
        assert.deepEqual(loaded.parameters, realRead.definition.inputSchema);
        nativeReply(protocol, response, { call: { id: 'invoke-protocol', name: alias,
          arguments: { objectId: work.objectId, contentId: work.contentId } } });
      } else {
        assert.equal(index, 4);
        assert.match(JSON.stringify(toolFeedback(protocol, payload, 'invoke-protocol')), /83/);
        nativeReply(protocol, response, { text: '从固定课程工具和原件 protocol-original.txt 读到观测 83。' });
      }
    }, {}, protocol);
    try {
      const activity = await f.activity(), c = await f.controlled(activity);
      await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      const tools = { ...c.tools, contributions: async scope => {
        const base = await c.tools.contributions(scope);
        realRead = base.find(tool => tool.definition.name === 'read_work'); assert.ok(realRead);
        return [...base, { ...realRead, source: { ...realRead.source, kind: 'course', sourceId: 'course:deferred' },
          definition: { ...realRead.definition, description: 'DEFERRED_PROTOCOL' } }];
      } };
      const agent = c.makeAgent({ tools });
      const accepted = await c.send('发现并加载获准的课程来源，读取我选定的原件后解释。', undefined, [work], agent);
      await until(async () => {
        if (f.failures.length) throw f.failures[0];
        const run = await agent.run(c.identity, activity.activityId, accepted.runId);
        if (['failed', 'paused'].includes(run.state)) throw new Error(JSON.stringify(run));
        return run.state === 'completed';
      }, 'Discovery, loading, actual executor and source explanation complete.');
      const events = await agent.events(c.identity, activity.activityId);
      const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled')
        .map(event => agent.snapshot(c.identity, activity.activityId, event.body.snapshotId)));
      assert.equal(snapshots.length, 4); assert.equal(f.payloads.length, 4);
      for (const [index, snapshot] of snapshots.entries()) {
        assert.deepEqual(snapshot.payload, f.payloads[index]);
        assert.equal(snapshot.resolvedAgent.model.protocol, protocol);
        assert.equal(snapshot.contextManifest.payloadSha256, snapshot.payloadSha256);
        assert.equal(snapshot.resolvedAgent.tools.some(binding => binding.source.sourceId === 'course:deferred'), index >= 2);
      }
      assert.equal(snapshots[0].segmentId, snapshots[1].segmentId);
      assert.notEqual(snapshots[1].segmentId, snapshots[2].segmentId);
      assert.equal(snapshots[2].segmentId, snapshots[3].segmentId);
      const binding = snapshots[2].resolvedAgent.tools.find(tool => tool.modelName === alias);
      assert.equal(binding.bindingId, entry.bindingId); assert.deepEqual(binding.source, entry.source);
      assert.deepEqual(binding.executor, realRead.executor);
      assert.equal(binding.executor.toolName, 'read_work'); assert.equal(binding.effect, 'read');
      const conversation = await agent.conversation(c.identity, activity.activityId);
      assert.deepEqual(conversation.tools.map(tool => [tool.callId, tool.name, tool.outcome]), [
        ['discover-protocol', 'discover_tools', 'completed'], ['load-protocol', 'load_tools', 'completed'], ['invoke-protocol', 'read_work', 'completed'],
      ]);
      assert.equal(new Set(conversation.tools.map(tool => tool.commandId)).size, 3);
      assert.equal(conversation.tools[2].source.contentId, work.contentId);
      assert.match(JSON.stringify(conversation.tools[2].result), /83/);
      assert.match(conversation.messages.findLast(message => message.role === 'assistant').text, /protocol-original\.txt.*83/);
      agent.close(); await agent.drain();
      const reopened = c.makeAgent({ tools });
      assert.deepEqual(await reopened.conversation(c.identity, activity.activityId), conversation);
      for (const snapshot of snapshots) assert.deepEqual(await reopened.snapshot(c.identity, activity.activityId, snapshot.snapshotId), snapshot);
      assert.equal(f.payloads.length, 4, 'reopening and reading cannot dispatch model or tool work');
    } finally { await f.close(); }
  });
}
