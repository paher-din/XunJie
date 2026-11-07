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
        purpose: 'DEFERRED_SOURCE', source: null, object: null, cursor: null, pageSize: 2,
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
    assert.deepEqual(conversation.tools.map(tool => tool.outcome), ['completed','completed','completed','not-dispatched','not-dispatched','not-dispatched']);
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
    assert.equal(toolsRead.filter(tool => tool.outcome === 'not-dispatched').length, 2);
  } finally { await f.close(); }
});
