import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StorageError } from '@xunjie/storage';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

// Only the upstream model is controlled. Sources, commands, resources, budgets and
// restart are exercised through the production Agent receiver/run/query seam.
test('large tool results keep a complete original and bounded native feedback, then read the same bytes after restart',
  { timeout: 180000 }, async () => {
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'large-evidence.txt', kind: 'text',
      encoding: 'utf8', mediaType: 'text/plain', value: '观测🙂'.repeat(4500) + '\nEND-ORIGINAL-216' };
    let original, firstRange;
    const f = await fixture((payload, response, index) => {
      if (index === 1) {
        assert.ok(payload.tools.some(tool => tool.function.name === 'read_tool_result'));
        reply(response, { calls: [{ id: 'large-original', name: 'read_work',
          arguments: { objectId: work.objectId, contentId: work.contentId } }] });
      } else if (index === 2) {
        const pair = payload.messages.find(message => message.role === 'tool' && message.tool_call_id === 'large-original');
        assert.ok(Buffer.byteLength(pair.content, 'utf8') <= 8192);
        const projection = JSON.parse(pair.content); // No cut-off JSON fragments.
        original = projection.original;
        assert.equal(original.encoding, 'utf8');
        assert.equal(original.readTool, 'read_tool_result');
        assert.match(original.commandId, /^[0-9a-f-]{36}$/);
        assert.match(original.sha256, /^[0-9a-f]{64}$/);
        assert.equal(projection.truncated, true);
        assert.equal(projection.byteRange.offset, 0);
        assert.ok(projection.byteRange.end < original.byteLength);
        assert.doesNotMatch(pair.content, /END-ORIGINAL-216/);
        reply(response, { calls: [{ id: 'read-original-range', name: 'read_tool_result',
          arguments: { commandId: original.commandId, offset: 2049, limit: 8192 } }] });
      } else if (index === 3) {
        const pair = payload.messages.find(message => message.role === 'tool' && message.tool_call_id === 'read-original-range');
        assert.ok(Buffer.byteLength(pair.content, 'utf8') <= 8192);
        const range = JSON.parse(pair.content).result ?? JSON.parse(pair.content);
        assert.equal(range.base64, firstRange.base64, 'Recovery preserves the first accepted bytes.');
        assert.deepEqual(range.byteRange, firstRange.byteRange);
        assert.equal(range.nextOffset, firstRange.nextOffset);
        assert.equal(firstRange.source.commandId, original.commandId);
        assert.equal(firstRange.version, 1);
        assert.equal(firstRange.sha256, original.sha256);
        assert.equal(firstRange.byteLength, original.byteLength);
        assert.equal(firstRange.byteRange.offset, 2049);
        assert.ok(firstRange.byteRange.end > 2049 && firstRange.byteRange.end <= 2049 + 8192);
        assert.equal(Buffer.from(firstRange.base64, 'base64').length, firstRange.byteRange.end - 2049);
        assert.equal(typeof firstRange.preview, 'string');
        reply(response, { calls: [{ id: 'read-original-after-restart', name: 'read_tool_result',
          arguments: { commandId: original.commandId, offset: 2049, limit: 8192 } }] });
      } else {
        assert.equal(index, 4, 'Recovery repeats only the explicitly requested range, never the original work read.');
        const pair = payload.messages.find(message => message.role === 'tool' && message.tool_call_id === 'read-original-after-restart');
        assert.ok(Buffer.byteLength(pair.content, 'utf8') <= 8192);
        const range = JSON.parse(pair.content).result ?? JSON.parse(pair.content);
        assert.equal(range.base64, firstRange.base64, 'The actual new read returns identical original bytes.');
        assert.equal(range.sha256, firstRange.sha256);
        assert.deepEqual(range.source, firstRange.source);
        assert.deepEqual(range.byteRange, firstRange.byteRange);
        assert.equal(range.nextOffset, firstRange.nextOffset);
        reply(response, { text: '重开后在原 Run 实际续读相同原件字节；只依据读过的部分解释。' });
      }
    });
    try {
      const activity = await f.activity('核对大结果固定原件'), c = await f.controlled(activity);
      await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      let receives = 0;
      const models = { ...c.models, checks: { ...c.models.checks, async receive(...args) {
        const received = await c.models.checks.receive(...args);
        // Lose only the real Gateway's receipt after the original and first range are
        // persisted. This creates a recoverable pause without touching owner tables.
        if (++receives === 3) throw new StorageError('resource-busy');
        return received;
      } } };
      const agent = c.makeAgent({ models }); agent.resume();
      const accepted = await c.send('读取固定原件，再继续读取后面的部分。', undefined, [work], agent);
      await until(async () => {
        if (f.failures.length) throw f.failures[0];
        const run = await agent.run(c.identity, activity.activityId, accepted.runId);
        if (['failed', 'stopped'].includes(run.state)) throw new Error(JSON.stringify(run));
        return run.state === 'paused' && run.reason === 'resource-busy';
      }, 'The real owner receipt loss pauses the original Run before the next model request.');
      await agent.drain();
      const conversation = await agent.conversation(c.identity, activity.activityId);
      assert.equal(f.payloads.length, 2, 'The third native model request has not been sent.');
      firstRange = conversation.tools.find(tool => tool.callId === 'read-original-range').result;
      assert.equal(conversation.tools.length, 2);
      assert.deepEqual(conversation.tools.map(tool => tool.outcome), ['completed', 'completed']);
      const recorded = conversation.tools.find(tool => tool.callId === 'large-original');
      assert.equal(recorded.commandId, original.commandId);
      assert.equal(recorded.result.file.value, work.value);
      // Independently reconstruct the result bytes from the public original record.
      const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
      const bytes = Buffer.from(JSON.stringify(sorted(recorded.result)), 'utf8');
      assert.equal(original.byteLength, bytes.length);
      assert.equal(original.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.deepEqual(Buffer.from(firstRange.base64, 'base64'), bytes.subarray(2049, firstRange.byteRange.end));
      const events = await agent.events(c.identity, activity.activityId);
      assert.equal(events.filter(event => event.kind === 'tool-permitted').length, 2);
      agent.close(); await agent.drain();
      // The current workspace changes while the original Command's resource is retained.
      await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 1,
        files: [{ ...work, contentId: randomUUID(), value: 'NEW-WORKSPACE-HEAD-MUST-NOT-REPLACE-216' }] });
      const reopened = c.makeAgent();
      assert.deepEqual(await reopened.conversation(c.identity, activity.activityId), conversation);
      assert.deepEqual(await reopened.events(c.identity, activity.activityId), events);
      assert.equal(f.payloads.length, 2, 'Opening the owner alone does not replay model or tool operations.');
      const continued = await reopened.continueRun(c.identity, activity.activityId, accepted.runId,
        { version: 2, requestId: randomUUID(), inputs: [] });
      assert.equal(continued.runId, accepted.runId, 'Continue the original Run, without granting a successor access.');
      reopened.resume();
      const final = await until(async () => {
        if (f.failures.length) throw f.failures[0];
        const run = await reopened.run(c.identity, activity.activityId, accepted.runId);
        if (['paused', 'failed', 'stopped'].includes(run.state)) throw new Error(JSON.stringify(run));
        return run.state === 'completed' ? run : null;
      }, 'The original Run really reads the retained byte range again after reopening.');
      assert.deepEqual(final.usage, { state: 'final', inputTokens: 80, outputTokens: 40, totalTokens: 120 });
      const after = await reopened.conversation(c.identity, activity.activityId);
      assert.equal(after.runs.length, 1);
      assert.equal(after.tools.filter(tool => tool.name === 'read_work').length, 1);
      assert.equal(after.tools.filter(tool => tool.name === 'read_tool_result').length, 2);
      assert.ok(after.tools.every(tool => tool.runId === accepted.runId && tool.outcome === 'completed'));
      assert.deepEqual(after.tools.find(tool => tool.callId === 'large-original'), recorded);
      assert.deepEqual(after.tools.find(tool => tool.callId === 'read-original-after-restart').result, firstRange);
      assert.deepEqual(Buffer.from(after.tools.find(tool => tool.callId === 'read-original-after-restart').result.base64, 'base64'),
        bytes.subarray(2049, firstRange.byteRange.end));
      assert.equal((await reopened.events(c.identity, activity.activityId)).filter(event => event.kind === 'tool-permitted').length, 3);
      assert.equal(f.payloads.length, 4);
      assert.deepEqual(f.failures, []);
    } finally { await f.close(); }
  });

test('stopping before a completed model read intent is associated forbids a new result read, including after reopening',
  { timeout: 180000 }, async () => {
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'stop-before-range.txt', kind: 'text',
      encoding: 'utf8', mediaType: 'text/plain', value: 'STOP-READ-ORIGINAL-216\n'.repeat(1500) };
    let entered, release, original;
    const observed = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture((payload, response, index) => {
      if (index === 1) reply(response, { calls: [{ id: 'stop-fixed-work', name: 'read_work',
        arguments: { objectId: work.objectId, contentId: work.contentId } }] });
      else {
        assert.equal(index, 2, 'A stopped Run cannot ask for another model continuation.');
        original = JSON.parse(payload.messages.find(message => message.tool_call_id === 'stop-fixed-work').content).original;
        reply(response, { calls: [{ id: 'stop-before-result-read', name: 'read_tool_result',
          arguments: { commandId: original.commandId, offset: 1024, limit: 8192 } }] });
      }
    });
    try {
      const activity = await f.activity(), c = await f.controlled(activity);
      await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      let held = false;
      const models = { ...c.models, checks: { ...c.models.checks, async read(...args) {
        const fact = await c.models.checks.read(...args);
        if (!held && fact.state === 'completed' && fact.toolIntents?.some(intent => intent.name === 'read_tool_result')) {
          held = true; entered();
          // Delay only delivery of an already durable model result. No tool or
          // Agent internals are substituted; stop wins before command dispatch.
          await gate;
        }
        return fact;
      } } };
      const agent = c.makeAgent({ models }); agent.resume();
      const accepted = await c.send('读取原件后，再读取一个范围。', undefined, [work], agent);
      await until(async () => {
        if (f.failures.length) throw f.failures[0];
        return held;
      }, 'The real Gateway has completed the range-read intent before dispatch.');
      await observed;
      await agent.stop(c.identity, activity.activityId, accepted.runId, { requestId: randomUUID() });
      release();
      await until(async () => (await agent.run(c.identity, activity.activityId, accepted.runId)).state === 'stopped',
        'Stopping must win before a new result read can be dispatched.');
      await agent.drain();
      const events = await agent.events(c.identity, activity.activityId);
      assert.deepEqual(events.filter(event => event.kind === 'tool-permitted').map(event => event.body.commandId), [original.commandId]);
      const conversation = await agent.conversation(c.identity, activity.activityId);
      assert.equal(conversation.tools.find(tool => tool.callId === 'stop-fixed-work').outcome, 'completed');
      assert.ok(conversation.tools.filter(tool => tool.name === 'read_tool_result').every(tool => tool.outcome === 'not-dispatched'));
      assert.equal(f.payloads.length, 2);
      agent.close(); await agent.drain();
      const reopened = c.makeAgent(); reopened.resume();
      await reopened.drain();
      assert.equal((await reopened.run(c.identity, activity.activityId, accepted.runId)).state, 'stopped');
      assert.deepEqual(await reopened.events(c.identity, activity.activityId), events);
      assert.equal(f.payloads.length, 2, 'Reopening never grants dispatch to the stopped read.');
      assert.deepEqual(f.failures, []);
    } finally { release(); await f.close(); }
  });

test('a large structured reference is reconstructed as valid canonical JSON from bounded production reads',
  { timeout: 180000 }, async () => {
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'structured-reference.txt', kind: 'text',
      encoding: 'utf8', mediaType: 'text/plain', value: '结构🙂'.repeat(1000) };
    const reference = { referenceId: randomUUID(), source: { kind: 'work', objectId: work.objectId, contentId: work.contentId },
      range: { kind: 'text', start: 0, end: work.value.length }, copy: work.value, sourceName: work.name };
    let original, offset = 0;
    const chunks = [];
    const f = await fixture((payload, response, index) => {
      if (index === 1) return reply(response, { calls: [{ id: 'structured-original', name: 'read_reference',
        arguments: { referenceId: reference.referenceId } }] });
      const pair = payload.messages.findLast(message => message.role === 'tool');
      assert.ok(Buffer.byteLength(pair.content, 'utf8') <= 8192);
      const projection = JSON.parse(pair.content);
      if (index === 2) {
        assert.equal(projection.truncated, true);
        original = projection.original;
        assert.ok(original.byteLength > 8192);
      } else {
        const range = projection.result ?? projection;
        assert.equal(range.source.commandId, original.commandId);
        assert.equal(range.sha256, original.sha256);
        assert.equal(range.byteRange.offset, offset);
        assert.ok(range.byteRange.end > offset && range.byteRange.end - offset <= 8192);
        const bytes = Buffer.from(range.base64, 'base64');
        assert.equal(bytes.length, range.byteRange.end - offset);
        chunks.push(bytes); offset = range.byteRange.end;
        if (range.nextOffset === null) {
          const complete = Buffer.concat(chunks);
          assert.equal(complete.length, original.byteLength);
          assert.equal(createHash('sha256').update(complete).digest('hex'), original.sha256);
          assert.deepEqual(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(complete)), { reference });
          return reply(response, { text: '完整重建结构化原引用；来源、范围与正文均与原件一致。' });
        }
        assert.equal(range.nextOffset, offset);
      }
      reply(response, { calls: [{ id: 'structured-range-' + index, name: 'read_tool_result',
        arguments: { commandId: original.commandId, offset, limit: 8192 } }] });
    });
    try {
      const activity = await f.activity(), c = await f.controlled(activity);
      await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      const input = actionInputSchema.parse({ requestId: randomUUID(), scope: { environmentId: c.identity.environmentId, spaceId: c.identity.spaceId,
        principalId: c.identity.principalId, activityId: activity.activityId }, receiver: c.agent.receiver.identity,
        draft: { token: randomUUID(), question: '读取完整原引用，保留嵌套的来源与范围。', references: [reference], bases: [] }, works: [work], evidence: [] });
      const receipt = await c.agent.accept(input, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
      const runId = JSON.parse(receipt.detail).runId; c.agent.resume();
      await until(async () => {
        if (f.failures.length) throw f.failures[0];
        const run = await c.agent.run(c.identity, activity.activityId, runId);
        if (['paused', 'failed', 'stopped'].includes(run.state)) throw new Error(JSON.stringify(run));
        return run.state === 'completed';
      }, 'The production range reader reconstructs the entire structured reference.');
      const conversation = await c.agent.conversation(c.identity, activity.activityId);
      assert.deepEqual(conversation.tools.find(tool => tool.callId === 'structured-original').result, { reference });
      const ranges = conversation.tools.filter(tool => tool.name === 'read_tool_result');
      assert.ok(ranges.length >= 2, 'The original requires several bounded reads.');
      assert.ok(ranges.every(tool => tool.outcome === 'completed' && tool.runId === runId));
      assert.equal((await c.agent.events(c.identity, activity.activityId)).filter(event => event.kind === 'tool-permitted').length,
        1 + ranges.length, 'Every range uses an independent budgeted Command.');
      assert.deepEqual(f.failures, []);
    } finally { await f.close(); }
  });

test('revoking the original tool contribution forbids reading its retained result through the still-available platform reader',
  { timeout: 180000 }, async () => {
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'revoked-original.txt', kind: 'text',
      encoding: 'utf8', mediaType: 'text/plain', value: 'REVOKED-RESULT-CANARY-216\n'.repeat(1500) };
    let revoked = false, original;
    const f = await fixture((payload, response, index) => {
      if (index === 1) reply(response, { calls: [{ id: 'before-source-revocation', name: 'read_work',
        arguments: { objectId: work.objectId, contentId: work.contentId } }] });
      else if (index === 2) {
        assert.ok(payload.tools.some(tool => tool.function.name === 'read_tool_result'));
        original = JSON.parse(payload.messages.find(message => message.tool_call_id === 'before-source-revocation').content).original;
        revoked = true;
        reply(response, { calls: [{ id: 'after-source-revocation', name: 'read_tool_result',
          arguments: { commandId: original.commandId, offset: 0, limit: 8192 } }] });
      } else {
        assert.equal(index, 3);
        assert.ok(payload.tools.some(tool => tool.function.name === 'read_tool_result'), 'The platform reader itself remains available.');
        assert.ok(!payload.tools.some(tool => tool.function.name === 'read_work'), 'The original contribution has been revoked.');
        reply(response, { text: '原工具来源已撤销，不能借范围读取继续取得原件。' });
      }
    });
    try {
      const activity = await f.activity(), c = await f.controlled(activity);
      await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      const tools = { ...c.tools, contributions: async scope => (await c.tools.contributions(scope))
        .filter(tool => !revoked || tool.definition.name !== 'read_work') };
      const agent = c.makeAgent({ tools }); agent.resume();
      const accepted = await c.send('原件读取后核对下一范围的资格。', undefined, [work], agent);
      await until(async () => {
        if (f.failures.length) throw f.failures[0];
        const run = await agent.run(c.identity, activity.activityId, accepted.runId);
        if (['paused', 'failed', 'stopped'].includes(run.state)) throw new Error(JSON.stringify(run));
        return run.state === 'completed';
      }, 'The original binding revocation must deny the platform range read.');
      const conversation = await agent.conversation(c.identity, activity.activityId);
      const source = conversation.tools.find(tool => tool.callId === 'before-source-revocation');
      const denied = conversation.tools.find(tool => tool.callId === 'after-source-revocation');
      assert.equal(source.commandId, original.commandId);
      assert.equal(source.outcome, 'completed');
      assert.equal(source.result.file.value, work.value, 'The retained audit original is not rewritten.');
      assert.equal(denied.runId, source.runId, 'This is a same-Run eligibility check, not merely Run isolation.');
      assert.equal(denied.name, 'read_tool_result');
      assert.equal(denied.outcome, 'failed');
      assert.equal(denied.result.reason, 'forbidden');
      assert.equal(denied.result.base64, undefined);
      assert.doesNotMatch(JSON.stringify(denied.result), /REVOKED-RESULT-CANARY-216/);
      assert.deepEqual(conversation.waits, []);
      assert.equal(f.payloads.length, 3);
      assert.deepEqual(f.failures, []);
    } finally { await f.close(); }
  });

test('knowing an original command does not authorize its bytes in another Run or activity', { timeout: 180000 }, async () => {
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'private-original.txt', kind: 'text',
    encoding: 'utf8', mediaType: 'text/plain', value: 'RESULT-SCOPE-CANARY-216' };
  let originalCommandId, stage = 'source';
  const f = await fixture((payload, response, index) => {
    if (stage === 'source' && index === 1) reply(response, { calls: [{ id: 'scope-original', name: 'read_work',
      arguments: { objectId: work.objectId, contentId: work.contentId } }] });
    else if (stage === 'source') {
      const pair = payload.messages.findLast(message => message.role === 'tool');
      originalCommandId = JSON.parse(pair.content).original.commandId;
      reply(response, { text: '原 Run 的固定资料已读取。' });
    } else if (!payload.messages.some(message => message.tool_calls?.some(call => call.id === stage))) {
      reply(response, { calls: [{ id: stage, name: 'read_tool_result',
        arguments: { commandId: originalCommandId, offset: 0, limit: 8192 } }] });
    } else {
      const pair = payload.messages.findLast(message => message.role === 'tool' && message.tool_call_id === stage);
      assert.ok(pair, 'The denied read still closes its native tool pair.');
      assert.doesNotMatch(pair.content, /RESULT-SCOPE-CANARY-216/);
      assert.match(pair.content, /forbidden|not-executed/);
      reply(response, { text: '当前 Run 没有该原件的读取范围。' });
    }
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    c.agent.resume();
    async function completed(activityId, runId) {
      await until(async () => {
        if (f.failures.length) throw f.failures[0];
        const run = await c.agent.run(c.identity, activityId, runId);
        if (['paused', 'failed'].includes(run.state)) throw new Error(JSON.stringify(run));
        return run.state === 'completed';
      }, 'The scope check must settle without reading foreign bytes.');
    }
    const source = await c.send('读取本 Run 的固定原件。', undefined, [work]);
    await completed(activity.activityId, source.runId);
    stage = 'denied-other-run';
    const next = await c.send('尝试按已知原 command 读取。');
    await completed(activity.activityId, next.runId);
    const denied = (await c.agent.conversation(c.identity, activity.activityId)).tools.find(tool => tool.callId === stage);
    assert.ok(['failed', 'not-dispatched'].includes(denied.outcome));
    assert.doesNotMatch(JSON.stringify(denied.result), /RESULT-SCOPE-CANARY-216/);

    stage = 'denied-other-activity';
    const other = await f.activity('另一个活动不能取得原件范围');
    const input = structuredClone(next.input);
    input.requestId = randomUUID(); input.scope.activityId = other.activityId; input.draft.token = randomUUID();
    const receipt = await c.agent.accept(input, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
    const otherRun = JSON.parse(receipt.detail).runId;
    await completed(other.activityId, otherRun);
    const otherDenied = (await c.agent.conversation(c.identity, other.activityId)).tools.find(tool => tool.callId === stage);
    assert.ok(['failed', 'not-dispatched'].includes(otherDenied.outcome));
    assert.doesNotMatch(JSON.stringify(otherDenied.result), /RESULT-SCOPE-CANARY-216/);
    assert.equal(f.payloads.length, 6);
    assert.deepEqual(f.failures, []);
  } finally { await f.close(); }
});
