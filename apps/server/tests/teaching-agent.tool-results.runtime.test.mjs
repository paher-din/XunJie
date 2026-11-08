import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StorageError } from '@xunjie/storage';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { executionActionSchema } from '@xunjie/contracts/execution';
import { fixture, reply, until } from './support/teaching-input-control.mjs';
import { runPublishedAggregation } from './support/teaching-recovery.mjs';

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
          arguments: { commandId: original.commandId, sha256: original.sha256, offset: 2049, limit: 8192 } }] });
      } else if (index === 3) {
        const pair = payload.messages.find(message => message.role === 'tool' && message.tool_call_id === 'read-original-range');
        assert.ok(Buffer.byteLength(pair.content, 'utf8') <= 8192);
        const range = JSON.parse(pair.content).result ?? JSON.parse(pair.content);
        assert.equal(range.base64, firstRange.base64, 'Recovery preserves the first accepted bytes.');
        assert.deepEqual(range.byteRange, firstRange.byteRange);
        assert.equal(range.nextOffset, firstRange.nextOffset);
        assert.equal(firstRange.source.commandId, original.commandId);
        assert.equal(firstRange.formatVersion, 1);
        assert.equal(firstRange.version, original.sha256);
        assert.equal(firstRange.outcomeState, 'completed');
        assert.equal(firstRange.sha256, original.sha256);
        assert.equal(firstRange.byteLength, original.byteLength);
        assert.equal(firstRange.byteRange.offset, 2049);
        assert.ok(firstRange.byteRange.end > 2049 && firstRange.byteRange.end <= 2049 + 8192);
        assert.equal(Buffer.from(firstRange.base64, 'base64').length, firstRange.byteRange.end - 2049);
        assert.equal(typeof firstRange.preview, 'string');
        reply(response, { calls: [{ id: 'read-original-after-restart', name: 'read_tool_result',
          arguments: { commandId: original.commandId, sha256: original.sha256, offset: 2049, limit: 8192 } }] });
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
          arguments: { commandId: original.commandId, sha256: original.sha256, offset: 1024, limit: 8192 } }] });
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
        arguments: { commandId: original.commandId, sha256: original.sha256, offset, limit: 8192 } }] });
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
          arguments: { commandId: original.commandId, sha256: original.sha256, offset: 0, limit: 8192 } }] });
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

test('a derived result cannot expose revoked ancestor bytes through another platform read',
  { timeout: 180000 }, async () => {
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'ancestor-original.txt', kind: 'text',
      encoding: 'utf8', mediaType: 'text/plain', value: 'ANCESTOR-READ-CANARY-216\n'.repeat(1000) };
    let revoked = false, originalA, originalB;
    const f = await fixture((payload, response, index) => {
      if (index === 1) return reply(response, { calls: [{ id: 'lineage-A-work', name: 'read_work',
        arguments: { objectId: work.objectId, contentId: work.contentId } }] });
      if (index === 2) {
        originalA = JSON.parse(payload.messages.find(message => message.tool_call_id === 'lineage-A-work').content).original;
        return reply(response, { calls: [{ id: 'lineage-B-first-read', name: 'read_tool_result',
          arguments: { commandId: originalA.commandId, sha256: originalA.sha256, offset: 0, limit: 1024 } }] });
      }
      if (index === 3) {
        const feedback = JSON.parse(payload.messages.find(message => message.tool_call_id === 'lineage-B-first-read').content);
        const range = feedback.result ?? feedback;
        assert.equal(range.source.commandId, originalA.commandId);
        assert.equal(range.version, originalA.sha256);
        assert.match(Buffer.from(range.base64, 'base64').toString('utf8'), /ANCESTOR-READ-CANARY-216/,
          'B really retains bytes of A before the original contribution is revoked.');
        originalB = feedback.original;
        assert.notEqual(originalB.commandId, originalA.commandId);
        revoked = true;
        return reply(response, { calls: [{ id: 'lineage-C-after-revocation', name: 'read_tool_result',
          arguments: { commandId: originalB.commandId, sha256: originalB.sha256, offset: 0, limit: 4096 } }] });
      }
      assert.equal(index, 4);
      assert.ok(payload.tools.some(tool => tool.function.name === 'read_tool_result'));
      assert.ok(!payload.tools.some(tool => tool.function.name === 'read_work'));
      reply(response, { text: '派生结果仍受原工具来源资格约束，不能通过读取链绕过撤权。' });
    });
    try {
      const activity = await f.activity(), c = await f.controlled(activity);
      await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      const tools = { ...c.tools, contributions: async scope => (await c.tools.contributions(scope))
        .filter(tool => !revoked || tool.definition.name !== 'read_work') };
      const agent = c.makeAgent({ tools }); agent.resume();
      const accepted = await c.send('保留原结果及派生范围，核对撤权后不能间接读取原件。', undefined, [work], agent);
      await until(async () => {
        if (f.failures.length) throw f.failures[0];
        const run = await agent.run(c.identity, activity.activityId, accepted.runId);
        if (['paused', 'failed', 'stopped'].includes(run.state)) throw new Error(JSON.stringify(run));
        return run.state === 'completed';
      }, 'The platform reader must check the full original-command lineage.');
      const conversation = await agent.conversation(c.identity, activity.activityId);
      const source = conversation.tools.find(tool => tool.callId === 'lineage-A-work');
      const derived = conversation.tools.find(tool => tool.callId === 'lineage-B-first-read');
      const denied = conversation.tools.find(tool => tool.callId === 'lineage-C-after-revocation');
      assert.equal(source.outcome, 'completed');
      assert.equal(derived.outcome, 'completed');
      assert.equal(derived.arguments.commandId, source.commandId);
      assert.equal(denied.arguments.commandId, derived.commandId);
      assert.equal(denied.arguments.sha256, originalB.sha256);
      assert.equal(denied.runId, source.runId);
      assert.equal(denied.outcome, 'failed', 'The intermediary platform.tools binding cannot replace authorization of ancestor A.');
      assert.equal(denied.result.reason, 'forbidden');
      assert.equal(denied.result.base64, undefined);
      assert.deepEqual(conversation.waits, []);
      assert.equal(f.payloads.length, 4);
      assert.deepEqual(f.failures, []);
    } finally { await f.close(); }
  });

test('the accepted result version stays byte-identical after the same real course command completes; an unknown hash never selects latest',
  { timeout: 180000 }, async () => {
    let original, firstRange;
    const f = await fixture((payload, response, index) => {
      if (index === 1) return reply(response, { calls: [{ id: 'versioned-course-operation', name: 'course_operation',
        arguments: { componentKey: 'table', operationId: 'aggregate',
          parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }] });
      if (index === 2) return reply(response, { calls: [{
        id: 'read-accepted-version', name: 'read_tool_result',
        arguments: { commandId: original.commandId, sha256: original.sha256, offset: 0, limit: 128 } }] });
      const pair = payload.messages.findLast(message => message.role === 'tool');
      const expectedCallId = index === 3 ? 'read-accepted-version'
        : index === 4 ? 'read-accepted-version-after-completion' : 'read-unavailable-version';
      assert.equal(pair.tool_call_id, expectedCallId);
      const transport = JSON.parse(pair.content);
      // Chat Completions preserves business errors in its native error envelope;
      // text still contains the actual bounded teaching-tool projection.
      const feedback = transport.outcome === 'error' && typeof transport.text === 'string'
        ? JSON.parse(transport.text) : transport;
      const range = feedback.result ?? feedback;
      if (index === 3 || index === 4) {
        assert.equal(range.formatVersion, 1);
        assert.equal(range.version, original.sha256);
        assert.equal(range.sha256, original.sha256);
        assert.equal(range.source.commandId, original.commandId);
        assert.equal(range.outcomeState, 'accepted', 'Reading bytes does not change the original effect to completed.');
        assert.deepEqual(range.byteRange, { offset: 0, end: 128 });
        if (index === 3) {
          firstRange = range;
          return reply(response, { calls: [{ id: 'read-accepted-version-after-completion', name: 'read_tool_result',
            arguments: { commandId: original.commandId, sha256: original.sha256, offset: 0, limit: 128 } }] });
        }
        assert.equal(range.base64, firstRange.base64, 'The old version returns identical bytes after latest has changed.');
        return reply(response, { calls: [{ id: 'read-unavailable-version', name: 'read_tool_result',
          arguments: { commandId: original.commandId, sha256: '0'.repeat(64), offset: 0, limit: 128 } }] });
      }
      assert.equal(index, 5);
      assert.equal(transport.outcome, 'error');
      assert.equal(range.reason, 'missing');
      assert.equal(range.base64, undefined, 'An unknown version must not fall back to the current resource.');
      reply(response, { text: '原命令完成后仍可重读已接受版本；未知版本没有退回最新结果。' });
    });
    try {
      const activity = await f.browserCourse(), c = await f.controlled(activity);
      const binding = activity.course.components[0], manifest = binding.definition.manifest;
      const definition = { definitionId: 'acceptance.result-versions', version: 1, purpose: '核对同一真实命令的固定结果版本',
        prompt: { platform: '按真实工具来源解释；不把已接受声称为完成。', runtime: '只读取本 Run 的固定结果版本。' },
        capabilities: [{ sourceId: 'platform.student', required: true }, { sourceId: 'platform.learning', required: false },
          { sourceId: 'platform.tools', required: true }, { sourceId: 'course:' + activity.course.releaseId + ':table', required: true }],
        contextPolicy: { version: 1, maxSystemChars: 400000, maxInputChars: 1000000 },
        outputContract: { kind: 'text', instructions: '区分已接受、未知及已完成。' }, budgetPolicy: { version: 1, retryLimit: 0 } };
      const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
        mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
          instanceId: activity.activityId + ':table', componentId: manifest.componentId, version: manifest.version,
          definitionDigest: binding.definition.digest, stateVersion: 1, operationId: randomUUID(), content: manifest.initialState }) };
      await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      const agent = c.makeAgent({ definition }); agent.resume();
      const accepted = await c.send('运行原计算，保留每个实际结果版本。', undefined, [work], agent);
      const before = await until(async () => {
        if (f.failures.length) throw f.failures[0];
        const value = await agent.conversation(c.identity, activity.activityId);
        return value.runs[0]?.state === 'waiting' && value.tools[0]?.outcome === 'accepted' ? value : null;
      }, 'The production course command is accepted but not completed.');
      const originalRecord = before.tools[0];
      original = JSON.parse(originalRecord.feedback).original;
      const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
      const acceptedBytes = Buffer.from(JSON.stringify(sorted(originalRecord.result)), 'utf8');
      assert.equal(createHash('sha256').update(acceptedBytes).digest('hex'), original.sha256);
      // Complete the published Wasm through the actual execution owner. Its
      // reconciliation replaces the original command's latest outcome/resource.
      const browserId = randomUUID(), execution = c.learning.executions;
      const { action } = await execution.agent.claimBrowser(c.identity, activity.activityId, original.commandId, browserId,
        association => agent.assertCommandDispatch(c.identity, activity.activityId, association));
      await execution.agent.acceptBrowser(c.identity, activity.activityId, original.commandId, browserId, {
        receipt: { requestId: original.commandId, receiver: action.receiver, state: 'accepted',
          inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(action))).digest('hex'),
          receiptId: 'versioned-result:' + original.commandId, detail: '' }, execution: { executionRef: randomUUID(), acceptedSeq: 1 },
      }, association => agent.assertCommandDispatch(c.identity, activity.activityId, association));
      const { computed, resultInput } = await runPublishedAggregation(action, manifest);
      assert.equal(computed.result.value, 83.33333333333333);
      const result = await execution.result(c.identity, activity.activityId, original.commandId, resultInput);
      await execution.report(c.identity, activity.activityId, original.commandId, { ...result, state: 'succeeded', confirmedSeq: 3 });
      await until(async () => {
        if (f.failures.length) throw f.failures[0];
        const run = await agent.run(c.identity, activity.activityId, accepted.runId);
        if (['paused', 'failed', 'stopped'].includes(run.state)) throw new Error(JSON.stringify(run));
        return run.state === 'completed';
      }, 'The same Run reads the retained accepted version after real completion.');
      const after = await agent.conversation(c.identity, activity.activityId);
      const latest = after.tools.find(tool => tool.commandId === original.commandId);
      assert.equal(latest.outcome, 'completed');
      assert.deepEqual(Buffer.from(firstRange.base64, 'base64'), acceptedBytes.subarray(0, 128));
      assert.equal(after.tools.find(tool => tool.callId === 'read-accepted-version').outcome, 'completed');
      assert.notEqual(JSON.parse(latest.feedback).original.sha256, original.sha256, 'Latest now describes a different result version.');
      const reread = after.tools.find(tool => tool.callId === 'read-accepted-version-after-completion');
      assert.equal(reread.outcome, 'completed');
      assert.equal(reread.result.outcomeState, 'accepted');
      assert.equal(reread.result.version, original.sha256);
      assert.deepEqual(Buffer.from(reread.result.base64, 'base64'), acceptedBytes.subarray(0, 128));
      assert.equal(after.tools.find(tool => tool.callId === 'read-unavailable-version').outcome, 'failed');
      const versions = (await agent.events(c.identity, activity.activityId)).filter(event => event.kind === 'tool-result'
        && event.body.commandId === original.commandId && event.body.resourceId);
      assert.ok(versions.some(event => event.body.outcome.state === 'accepted'));
      assert.ok(versions.some(event => event.body.outcome.state === 'completed'));
      assert.equal(new Set(versions.map(event => event.body.resourceId)).size >= 2, true);
      assert.equal(f.payloads.length, 5);
      assert.deepEqual(f.failures, []);
    } finally { await f.close(); }
  });

test('knowing an original command does not authorize its bytes in another Run or activity', { timeout: 180000 }, async () => {
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'private-original.txt', kind: 'text',
    encoding: 'utf8', mediaType: 'text/plain', value: 'RESULT-SCOPE-CANARY-216' };
  let originalCommandId, originalSha256, stage = 'source';
  const f = await fixture((payload, response, index) => {
    if (stage === 'source' && index === 1) reply(response, { calls: [{ id: 'scope-original', name: 'read_work',
      arguments: { objectId: work.objectId, contentId: work.contentId } }] });
    else if (stage === 'source') {
      const pair = payload.messages.findLast(message => message.role === 'tool');
      originalCommandId = JSON.parse(pair.content).original.commandId;
      originalSha256 = JSON.parse(pair.content).original.sha256;
      reply(response, { text: '原 Run 的固定资料已读取。' });
    } else if (!payload.messages.some(message => message.tool_calls?.some(call => call.id === stage))) {
      reply(response, { calls: [{ id: stage, name: 'read_tool_result',
        arguments: { commandId: originalCommandId, sha256: originalSha256, offset: 0, limit: 8192 } }] });
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
