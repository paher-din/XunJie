import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

test('bounded discovery loads a fixed approved executor only after its native pair and survives reopening', { timeout: 180000 }, async () => {
  let discovered;
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'original.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '获准原件的观察是 83。' };
  const f = await fixture((payload, response, index) => {
    const result = payload.messages.filter(message => message.role === 'tool').at(-1);
    if (index === 1) {
      assert.ok(payload.tools.some(tool => tool.function.name === 'discover_tools'));
      assert.ok(!payload.tools.some(tool => tool.function.description.includes('DEFERRED_SOURCE')));
      reply(response, { calls: [{ id: 'discover-original', name: 'discover_tools', arguments: {
        purpose: 'DEFERRED_SOURCE', source: null, object: work.objectId, cursor: null, pageSize: 2,
      } }] });
    } else if (index === 2) {
      discovered = (JSON.parse(result.content).result ?? JSON.parse(result.content)).entries;
      assert.equal(discovered.length, 2);
      reply(response, { calls: [{ id: 'load-original', name: 'load_tools', arguments: { bindingIds: [discovered[0].bindingId] } }] });
    } else if (index === 3) {
      const selected = payload.tools.find(tool => tool.function.description.includes('DEFERRED_SOURCE_0'));
      assert.ok(selected);
      assert.ok(!payload.tools.some(tool => tool.function.description.includes('DEFERRED_SOURCE_1')));
      reply(response, { calls: [{ id: 'invoke-original', name: selected.function.name,
        arguments: { objectId: work.objectId, contentId: work.contentId } }] });
    } else reply(response, { text: '从获准第二来源的固定作品读到观察 83。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    const tools = { ...c.tools, contributions: async scope => {
      const base = await c.tools.contributions(scope), original = base.find(tool => tool.definition.name === 'read_work');
      return [...base, ...Array.from({ length: 12 }, (_, index) => ({ ...original,
        source: { ...original.source, sourceId: 'course:source-' + index },
        definition: { ...original.definition, description: 'DEFERRED_SOURCE_' + index } }))];
    } };
    const agent = c.makeAgent({ tools });
    const accepted = await c.send('先发现并加载需要的来源，再读取原件。', undefined, [work], agent);
    await until(async () => {
      if (f.failures.length) throw f.failures[0];
      const run = await agent.run(c.identity, activity.activityId, accepted.runId);
      if (['failed','paused'].includes(run.state)) throw new Error(JSON.stringify(run));
      return run.state === 'completed';
    }, 'Discovery, loading and the real original read complete.');
    const events = await agent.events(c.identity, activity.activityId);
    const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled')
      .map(event => agent.snapshot(c.identity, activity.activityId, event.body.snapshotId)));
    assert.notEqual(snapshots[2].segmentId, snapshots[1].segmentId);
    assert.equal(snapshots[0].resolvedAgent.tools.filter(tool => tool.source.kind === 'course').length, 0);
    const invoked = (await agent.conversation(c.identity, activity.activityId)).tools;
    assert.deepEqual(invoked.map(tool => tool.outcome), ['completed','completed','completed']);
    assert.match(JSON.stringify(invoked.at(-1).result), /83/);
    agent.close(); await agent.drain();
    const reopened = c.makeAgent({ tools });
    assert.deepEqual(await reopened.snapshot(c.identity, activity.activityId, snapshots[0].snapshotId), snapshots[0]);
    assert.equal(f.payloads.length, 4);
  } finally { await f.close(); }
});

test('repeated pages are stable, changed catalogs reject old cursors and discovered versions do not grant permission', { timeout: 180000 }, async () => {
  let first, second, revision = 1;
  const query = { purpose: 'PAGED_SOURCE', source: null, object: null, cursor: null, pageSize: 2 };
  const f = await fixture((payload, response, index) => {
    const content = payload.messages.filter(message => message.role === 'tool').at(-1)?.content;
    const call = (name, args) => reply(response, { calls: [{ id: 'page-' + index, name, arguments: args }] });
    if (index === 1) call('discover_tools', query);
    else if (index === 2) { first = JSON.parse(content).result ?? JSON.parse(content); assert.equal(first.entries.length, 2); assert.ok(first.nextCursor); call('discover_tools', query); }
    else if (index === 3) { assert.deepEqual((JSON.parse(content).result ?? JSON.parse(content)).entries, first.entries); assert.equal((JSON.parse(content).result ?? JSON.parse(content)).nextCursor, first.nextCursor); call('discover_tools', { ...query, cursor: first.nextCursor }); }
    else if (index === 4) {
      second = JSON.parse(content).result ?? JSON.parse(content); assert.equal(second.page, 2);
      assert.ok(second.entries.every(entry => !first.entries.some(original => original.bindingId === entry.bindingId)));
      revision = 2; call('discover_tools', { ...query, cursor: second.nextCursor });
    } else if (index === 5) { assert.match(content, /identity-conflict/); call('load_tools', { bindingIds: [first.entries[0].bindingId] }); }
    else if (index === 6) { assert.match(content, /identity-conflict/); call('load_tools', { bindingIds: ['0'.repeat(64)] }); }
    else { assert.match(content, /forbidden/); reply(response, { text: '目录版本已变化；没有加载旧版或未发现的能力。' }); }
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    const tools = { ...c.tools, contributions: async scope => {
      const base = await c.tools.contributions(scope), original = base.find(tool => tool.definition.name === 'read_work');
      return [...base, ...Array.from({ length: 9 }, (_, index) => ({ ...original,
        source: { ...original.source, sourceId: 'course:paged-' + index, version: String(revision) },
        definition: { ...original.definition, description: 'PAGED_SOURCE_' + index + '_v' + revision } }))];
    } };
    const agent = c.makeAgent({ tools }), accepted = await c.send('按页发现课程能力。', undefined, [], agent);
    await until(async () => {
      if (f.failures.length) throw f.failures[0];
      return (await agent.run(c.identity, activity.activityId, accepted.runId)).state === 'completed';
    }, 'Bounded pages reject changed and unapproved bindings.');
    const conversation = await agent.conversation(c.identity, activity.activityId);
    assert.deepEqual(conversation.tools.map(tool => tool.outcome), ['completed','completed','completed','failed','failed','failed']);
    const events = await agent.events(c.identity, activity.activityId);
    const last = await agent.snapshot(c.identity, activity.activityId, events.filter(event => event.kind === 'context-assembled').at(-1).body.snapshotId);
    assert.ok(last.resolvedAgent.tools.every(binding => binding.source.kind !== 'course'));
  } finally { await f.close(); }
});

test('the page ceiling cannot be bypassed by editing the public cursor and directory failure never becomes an empty success', { timeout: 180000 }, async () => {
  const { StorageError } = await import('@xunjie/storage');
  let failed = false, first;
  const query = { purpose: 'CEILING_SOURCE', source: null, object: null, cursor: null, pageSize: 1 };
  const f = await fixture((payload, response, index) => {
    const nativePair = payload.messages.filter(message => message.role === 'tool').at(-1)?.content;
    const portable = JSON.stringify(payload);
    const parsed = JSON.parse(nativePair ?? '{}');
    const result = parsed.result ?? parsed;
    const call = args => reply(response, { calls: [{ id: 'ceiling-' + index, name: 'discover_tools', arguments: args }] });
    if (index === 1) call(query);
    else if (index === 2) {
      first = result;
      const cursor = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
      cursor.page = 0;
      call({ ...query, cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') });
    } else if (index === 3) {
      assert.match(JSON.stringify(result), /invalid/);
      call({ ...query, cursor: first.nextCursor });
    } else if (index < 10) {
      assert.equal(result.page, index - 2);
      call({ ...query, cursor: result.nextCursor });
    } else if (index === 10) {
      assert.equal(result.page, 8); assert.equal(result.limitReached, true); assert.equal(result.nextCursor, null);
      failed = true; call(query);
    } else { assert.match(nativePair ?? portable, /unavailable/); assert.ok(!result.entries); reply(response, { text: '目录读取失败；不能声称无匹配能力。' }); }
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    const tools = { ...c.tools, contributions: async scope => {
      if (failed) throw new StorageError('unavailable');
      const base = await c.tools.contributions(scope), original = base.find(tool => tool.definition.name === 'read_work');
      return [...base, ...Array.from({ length: 10 }, (_, index) => ({ ...original,
        source: { ...original.source, sourceId: 'course:ceiling-' + index },
        definition: { ...original.definition, description: 'CEILING_SOURCE_' + index } }))];
    } };
    const agent = c.makeAgent({ tools }), accepted = await c.send('核对目录页数上限和读取失败。', undefined, [], agent);
    await until(async () => {
      if (f.failures.length) throw f.failures[0];
      return (await agent.run(c.identity, activity.activityId, accepted.runId)).state === 'completed';
    }, 'The cursor ceiling and explicit directory failure complete.');
    const toolsRead = (await agent.conversation(c.identity, activity.activityId)).tools;
    assert.equal(toolsRead.filter(tool => tool.outcome === 'completed').length, 8);
    assert.equal(toolsRead.filter(tool => tool.outcome === 'failed').length, 2);
  } finally { await f.close(); }
});

test('a retained binding without newly added metadata still invokes the unchanged approved executor after upgrade', { timeout: 180000 }, async () => {
  let upgraded = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'legacy-binding.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '升级前原件观测为 71。' };
  const f = await fixture(async (_payload, response, index) => {
    if (index === 1) { await gate; reply(response, { calls: [{ id: 'legacy-approved-read', name: 'read_work',
      arguments: { objectId: work.objectId, contentId: work.contentId } }] }); }
    else reply(response, { text: '同一获准 executor 读取原观测 71；附加目录 metadata 不改变原命令。' });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    const tools = { ...c.tools, contributions: async scope => (await c.tools.contributions(scope)).map(item => {
      if (upgraded) return item;
      const { purpose, resultSchema, ...legacy } = item; return legacy;
    }) };
    const agent = c.makeAgent({ tools }), accepted = await c.send('读取升级前固定原件。', undefined, [work], agent);
    await until(() => f.payloads.length === 1, 'The old binding is persisted before its model result.');
    const firstEvent = (await agent.events(c.identity, activity.activityId)).find(event => event.kind === 'context-assembled');
    const original = await agent.snapshot(c.identity, activity.activityId, firstEvent.body.snapshotId);
    assert.ok(!Object.hasOwn(original.resolvedAgent.tools.find(tool => tool.executor.toolName === 'read_work'), 'resultSchema'));
    upgraded = true; release();
    await until(async () => {
      if (f.failures.length) throw f.failures[0];
      return (await agent.run(c.identity, activity.activityId, accepted.runId)).state === 'completed';
    }, 'A metadata-only upgrade must preserve the original executor eligibility.');
    const conversation = await agent.conversation(c.identity, activity.activityId);
    assert.equal(conversation.tools[0].outcome, 'completed');
    assert.equal(conversation.tools[0].result.file.value, work.value);
    assert.deepEqual(await agent.snapshot(c.identity, activity.activityId, original.snapshotId), original);
  } finally { release(); await f.close(); }
});

test('only a permitted discovery command reads the real catalog when eight intents share one remaining tool slot', { timeout: 180000 }, async () => {
  let armed = false, reads = 0;
  const f = await fixture((_payload, response) => {
    armed = true;
    reply(response, { calls: Array.from({ length: 8 }, (_, index) => ({ id: 'budget-discovery-' + index, name: 'discover_tools',
      arguments: { purpose: 'read_work', source: 'platform.learning', object: null, cursor: null, pageSize: 1 } })) });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    const tools = { ...c.tools, contributions: async scope => {
      if (armed) reads++;
      return c.tools.contributions(scope);
    } };
    const agent = c.makeAgent({ tools, limits: { maxToolCommands: 1 } });
    const accepted = await c.send('在剩余一次目录预算内查找工具。', undefined, [], agent);
    await until(async () => (await agent.run(c.identity, activity.activityId, accepted.runId)).state === 'paused', 'The original tool budget pauses the Run.');
    assert.equal((await agent.run(c.identity, activity.activityId, accepted.runId)).reason, 'tool-budget-exhausted');
    assert.equal(reads, 1, 'Only the permitted command may perform catalog owner IO.');
    const records = (await agent.conversation(c.identity, activity.activityId)).tools;
    assert.equal(records.filter(tool => tool.outcome === 'completed').length, 1);
    assert.equal(records.filter(tool => tool.outcome === 'not-dispatched').length, 7);
    assert.equal(f.payloads.length, 1);
  } finally { await f.close(); }
});

test('two loads in one native step share the same 32-tool ceiling before their pair is adopted', { timeout: 180000 }, async () => {
  let agent, current, bulk = false;
  const f = await fixture(async (payload, response, index) => {
    const records = index === 1 ? [] : (await agent.conversation(current.identity, current.activityId)).tools;
    const pages = records.filter(record => record.name === 'discover_tools' && record.outcome === 'completed');
    const entries = [...new Map(pages.flatMap(record => record.result.entries).map(entry => [entry.bindingId, entry])).values()];
    const loaded = new Set(records.filter(record => record.name === 'load_tools' && record.outcome === 'completed').flatMap(record => record.result.bindingIds));
    if (entries.length < 40) {
      const cursor = pages.at(-1)?.result.nextCursor ?? null;
      assert.ok(!pages.length || cursor, 'All forty small contributions fit inside the eight bounded pages.');
      reply(response, { calls: [{ id: 'cap-page-' + index, name: 'discover_tools', arguments: {
        purpose: 'LOADCAP', source: 'course:cap-', object: null, cursor, pageSize: 8,
      } }] });
    } else if (loaded.size < 24) reply(response, { calls: [{ id: 'cap-serial-' + index, name: 'load_tools',
      arguments: { bindingIds: entries.slice(loaded.size, loaded.size + 8).map(entry => entry.bindingId) } }] });
    else if (!bulk) {
      bulk = true;
      reply(response, { calls: [0, 1].map(batch => ({ id: 'cap-same-step-' + batch, name: 'load_tools',
        arguments: { bindingIds: entries.slice(24 + batch * 8, 32 + batch * 8).map(entry => entry.bindingId) } })) });
    } else {
      assert.equal(loaded.size, 32, 'The second same-step load cannot adopt a forty-tool set.');
      assert.equal(payload.tools.filter(tool => tool.function.description === 'LOADCAP').length, 32);
      reply(response, { text: '已加载 32 项，第二次同一步加载明确达到上限。' });
    }
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity); current = activity;
    const tools = { ...c.tools, contributions: async scope => {
      const base = await c.tools.contributions(scope), { purpose, resultSchema, ...original } = base.find(tool => tool.definition.name === 'read_work');
      return [...base, ...Array.from({ length: 40 }, (_, index) => ({ ...original,
        source: { ...original.source, sourceId: 'course:cap-' + String(index).padStart(2, '0') },
        resourceScope: { activityId: scope.activity.activityId }, definition: { ...original.definition, description: 'LOADCAP' } }))];
    } };
    agent = c.makeAgent({ tools });
    const accepted = await c.send('分批加载目录工具，最后两批共享同一步上限。', undefined, [], agent);
    await until(async () => {
      if (f.failures.length) throw f.failures[0];
      const run = await agent.run(c.identity, activity.activityId, accepted.runId);
      if (['paused', 'failed'].includes(run.state)) throw new Error(JSON.stringify(run));
      return run.state === 'completed';
    }, 'The same-step loads observe the shared capacity limit.');
    const bulkRecords = (await agent.conversation(c.identity, activity.activityId)).tools.filter(tool => tool.callId.startsWith('cap-same-step-'));
    assert.deepEqual(bulkRecords.map(tool => tool.outcome), ['completed', 'failed']);
  } finally { await f.close(); }
});

test('a segment continuation that exceeds capacity identifies the original adopted question and work without pending input', { timeout: 180000 }, async () => {
  let version = 1;
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'capacity-original.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '必须保留的固定观察。'.repeat(20) };
  const f = await fixture((_payload, response) => {
    version = 2;
    reply(response, { calls: [{ id: 'capacity-before-transition', name: 'read_work', arguments: { objectId: work.objectId, contentId: work.contentId } }] });
  });
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    const agent = c.makeAgent({ definition: async () => ({ definitionId: 'acceptance.discovery-capacity', version, purpose: '保留固定来源',
      prompt: { platform: '只解释固定真实来源。', runtime: '继续同一问题，保留原操作状态。' },
      capabilities: [{ sourceId: 'platform.student', required: true }, { sourceId: 'platform.learning', required: true }],
      contextPolicy: { version: 1, maxSystemChars: 400000, maxInputChars: version === 1 ? 1000000 : 80 },
      outputContract: { kind: 'text', instructions: '说明实际来源。' }, budgetPolicy: { version: 1, retryLimit: 0 } }) });
    const accepted = await c.send('保留当前问题与原件，换段后继续。', undefined, [work], agent);
    await until(async () => (await agent.run(c.identity, activity.activityId, accepted.runId)).state === 'paused', 'The new fixed capacity pauses without losing its original source.');
    const run = await agent.run(c.identity, activity.activityId, accepted.runId);
    assert.equal(run.reason, 'capacity-exceeded');
    const pause = (await agent.events(c.identity, activity.activityId)).find(event => event.kind === 'capacity-paused');
    assert.deepEqual(pause.body.requiredScope.questions, [accepted.input.requestId]);
    assert.deepEqual(pause.body.requiredScope.works, [work.contentId]);
    assert.deepEqual(pause.body.requiredScope.workNames, [work.name]);
    assert.equal(f.payloads.length, 1);
  } finally { await f.close(); }
});
