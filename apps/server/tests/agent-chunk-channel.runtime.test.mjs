import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { chunkChannelMigrationSql, createChunkChannel, createChunkClient } from '../../../packages/learning-space/dist/teaching-agent/chunk-channel.js';

const source = () => ({ grantId: randomUUID(), sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID() });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const wire = (operation, transferId, rest = {}) => ({ chunkChannel: 1, operation, transferId, ...rest });
async function fixture(t) {
  const pg = await nativeFixture();
  const migrations = [{ version: 1, name: 'chunk-channel', sql: chunkChannelMigrationSql }];
  const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations });
  const backend = createFileBackend({ id: 'files', root: pg.root + '/objects' });
  const handles = [];
  async function open() { const storage = await openStorage({ binding, migrations, backend }); handles.push(storage); return storage; }
  t.after(async () => { try { for (const handle of handles.reverse()) await handle.close(); } finally { await pg.close(); } });
  return { open };
}

test('large Unicode request and reply cross the bounded JSON wire and persist across reopen', { timeout: 60000 }, async t => {
  const f = await fixture(t), storage = await f.open(), actor = source();
  const value = { text: '中文🙂'.repeat(190000) };
  let executed = 0, handler = createChunkChannel(storage).wrap(async input => { executed++; assert.deepEqual(input, value); return { reply: value.text }; });
  let transferId;
  const client = createChunkClient(async payload => {
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 1024 * 1024);
    transferId = payload.transferId;
    const reply = await handler(payload, actor);
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 1024 * 1024);
    return JSON.parse(JSON.stringify(reply));
  });
  assert.deepEqual(await client(value, { acknowledge: true }), { reply: value.text });
  handler = createChunkChannel(await f.open()).wrap(() => { throw new Error('must not execute again'); });
  assert.equal((await handler(wire('metadata', transferId), actor)).state, 'acknowledged');
  assert.equal((await handler(wire('execute', transferId), actor)).state, 'acknowledged');
  assert.equal(executed, 1);
});

test('duplicate chunks are immutable, completed replies can be reread, and every source field isolates access', { timeout: 60000 }, async t => {
  const f = await fixture(t), storage = await f.open(), actor = source(), id = randomUUID();
  let count = 0;
  const handler = createChunkChannel(storage).wrap(value => ({ value, count: ++count }));
  const bytes = Buffer.from('"hello"');
  await handler(wire('begin', id, { byteLength: bytes.length, sha256: digest(bytes) }), actor);
  const put = wire('put', id, { index: 0, data: bytes.toString('base64') });
  await handler(put, actor); await handler(put, actor);
  await assert.rejects(handler({ ...put, data: Buffer.from('"other"').toString('base64') }, actor), { code: 'identity-conflict' });
  const reply = await handler(wire('execute', id), actor);
  assert.deepEqual(await handler(wire('execute', id), actor), reply);
  const reopened = createChunkChannel(await f.open()).wrap(() => { throw new Error('duplicate'); });
  assert.deepEqual(await reopened(wire('execute', id), actor), reply);
  for (const key of Object.keys(actor)) {
    const other = { ...actor, [key]: randomUUID() };
    for (const operation of ['metadata', 'get', 'ack', 'execute']) {
      await assert.rejects(reopened(wire(operation, id, operation === 'get' ? { index: 0 } : {}), other), { code: 'missing' });
    }
  }
  assert.equal(count, 1);
});

test('two storage handles invoke a handler at most once; thrown external effects remain unknown and cannot be acknowledged', { timeout: 60000 }, async t => {
  const f = await fixture(t), storage = await f.open(), actor = source(), id = randomUUID();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let effects = 0;
  const first = createChunkChannel(storage).wrap(async () => { effects++; entered(); await held; throw new Error('effect receipt lost'); });
  const second = createChunkChannel(await f.open()).wrap(() => { effects++; return 'duplicate'; });
  const bytes = Buffer.from('{}');
  await first(wire('begin', id, { byteLength: bytes.length, sha256: digest(bytes) }), actor);
  await first(wire('put', id, { index: 0, data: bytes.toString('base64') }), actor);
  const running = first(wire('execute', id), actor);
  await started;
  assert.equal((await second(wire('execute', id), actor)).state, 'unknown');
  release();
  assert.equal((await running).state, 'unknown');
  assert.equal((await second(wire('metadata', id), actor)).state, 'unknown');
  await assert.rejects(second(wire('ack', id), actor), { code: 'conflict' });
  const client = createChunkClient(payload => second(payload, actor));
  await assert.rejects(client({}, { transferId: id }), { code: 'commit-unknown' });
  assert.equal(effects, 1);
});


test('a handler success followed by rolled back completion stays unknown; read-only metadata still works behind the owner gate', { timeout: 60000 }, async t => {
  const f = await fixture(t), storage = await f.open(), actor = source(), id = randomUUID();
  let effects = 0;
  const boundary = new Proxy(storage, { get(target, property) {
    if (property === 'request') return (input, effect) => target.request(input, async tx => {
      const result = await effect(tx);
      if (result?.state === 'completed') throw new StorageError('unavailable');
      return result;
    });
    const member = Reflect.get(target, property);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
  const handler = createChunkChannel(boundary).wrap(() => { effects++; return 'effect committed elsewhere'; });
  const client = createChunkClient(payload => handler(payload, actor));
  await assert.rejects(client({}, { transferId: id }), { code: 'commit-unknown', requestId: id });
  const reopened = createChunkChannel(await f.open()).wrap(() => { effects++; return null; });
  assert.equal((await reopened(wire('execute', id), actor)).state, 'unknown');
  await storage.participant().closeWrites();
  assert.equal((await reopened(wire('metadata', id), actor)).state, 'unknown');
  const empty = Buffer.from('{}');
  await assert.rejects(reopened(wire('begin', randomUUID(), { byteLength: 2, sha256: digest(empty) }), actor), { code: 'stale-generation' });
  assert.equal(effects, 1);
});

test('maintenance retains an interrupted unexecuted input, while incomplete effect replies still block validation', { timeout: 60000 }, async t => {
  const f = await fixture(t), storage = await f.open(), actor = source(), id = randomUUID();
  let failUpload = true, effects = 0;
  const boundary = new Proxy(storage, { get(target, property) {
    if (property === 'stageResource') return input => {
      if (failUpload) throw new StorageError('unavailable');
      return target.stageResource(input);
    };
    const member = Reflect.get(target, property);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
  const channel = createChunkChannel(boundary), handler = channel.wrap(value => { effects++; return value; });
  const bytes = Buffer.from('{"original":"input"}'), put = wire('put', id, { index: 0, data: bytes.toString('base64') });
  await handler(wire('begin', id, { byteLength: bytes.length, sha256: digest(bytes) }), actor);
  await assert.rejects(handler(put, actor), { code: 'unavailable' });
  await createChunkChannel(await f.open()).validate();
  assert.equal(effects, 0);
  failUpload = false; await handler(put, actor);
  failUpload = true;
  assert.equal((await handler(wire('execute', id), actor)).state, 'unknown');
  await assert.rejects(channel.validate(), { code: 'resource-busy' });
  assert.equal((await handler(wire('execute', id), actor)).state, 'unknown');
  assert.equal(effects, 1);
});

test('source admission enforces count and retained bytes; acknowledgement frees capacity, and full input hash is mandatory', { timeout: 60000 }, async t => {
  const f = await fixture(t), storage = await f.open(), actor = source();
  let effects = 0;
  const handler = createChunkChannel(storage).wrap(() => { effects++; return null; });
  const ids = Array.from({ length: 16 }, () => randomUUID());
  const tiny = Buffer.from('{}');
  for (const id of ids) await handler(wire('begin', id, { byteLength: 2, sha256: digest(tiny) }), actor);
  await assert.rejects(handler(wire('begin', randomUUID(), { byteLength: 2, sha256: digest(tiny) }), actor), { code: 'conflict' });
  await handler(wire('ack', ids[0]), actor);
  const id = randomUUID();
  await handler(wire('begin', id, { byteLength: 2, sha256: digest(Buffer.from('[]')) }), actor);
  await handler(wire('put', id, { index: 0, data: tiny.toString('base64') }), actor);
  await assert.rejects(handler(wire('execute', id), actor), { code: 'corrupt' });
  await assert.rejects(handler(wire('put', id, { index: 0, data: Buffer.alloc(256 * 1024 + 1).toString('base64') }), actor), { code: 'invalid' });
  await assert.rejects(handler(wire('begin', randomUUID(), { byteLength: 16 * 1024 * 1024 + 1, sha256: digest(tiny) }), source()), { code: 'invalid' });
  const other = source(), large = [];
  for (let n = 0; n < 4; n++) {
    const next = randomUUID(); large.push(next);
    await handler(wire('begin', next, { byteLength: 16 * 1024 * 1024, sha256: digest(tiny) }), other);
  }
  await assert.rejects(handler(wire('begin', randomUUID(), { byteLength: 1, sha256: digest(tiny) }), other), { code: 'conflict' });
  await handler(wire('ack', large[0]), other);
  await handler(wire('begin', randomUUID(), { byteLength: 1, sha256: digest(tiny) }), other);
  assert.equal(effects, 0);
});


test('ordinary calls release their small reply and void handler results normalize to null', { timeout: 60000 }, async t => {
  const f = await fixture(t), storage = await f.open(), actor = source();
  let storageCalls = 0, liveChecks = 0;
  Object.defineProperty(actor, 'assertAuthorized', { value: async () => { liveChecks++; } });
  const boundary = new Proxy(storage, { get(target, property) {
    const member = Reflect.get(target, property);
    return typeof member === 'function' ? (...args) => { storageCalls++; return member.apply(target, args); } : member;
  } });
  const channel = createChunkChannel(boundary), handler = channel.wrap((_input, trusted) => {
    assert.equal(trusted, actor);
    assert.equal(trusted.assertAuthorized, actor.assertAuthorized);
    return undefined;
  }, { authorize: async (_input, trusted) => {
    assert.equal(trusted, actor);
    await trusted.assertAuthorized();
  } });
  for (let index = 0; index < 17; index++) assert.equal(await handler({ operation: 'assert' }, actor), null);
  assert.equal(storageCalls, 0);
  assert.equal(liveChecks, 34);
  const client = createChunkClient(payload => handler(payload, actor)), id = randomUUID();
  assert.equal(await client({}, { transferId: id }), null);
  assert.equal((await handler(wire('metadata', id), actor)).state, 'completed');
  assert.equal(await client({}, { transferId: id }), null);
  await channel.validate();
  await handler(wire('ack', id), actor);
  await storage.collect({ olderThan: new Date(Date.now() + 1000) });
  await channel.validate();
});

test('member revocation blocks each reply fragment using the original input while completed metadata remains readable', { timeout: 60000 }, async t => {
  const f = await fixture(t), storage = await f.open(), actor = source(), id = randomUUID();
  const input = { memberId: randomUUID(), activityId: randomUUID(), text: 'original scope '.repeat(30000) };
  let allowed = false, effects = 0, checks = 0;
  const authorize = async (payload, trusted) => {
    checks++;
    assert.deepEqual(payload, input);
    assert.deepEqual(trusted, actor);
    if (!allowed) throw new StorageError('forbidden');
  };
  const handler = createChunkChannel(storage).wrap(() => { effects++; return { text: 'reply'.repeat(90000) }; }, { authorize });
  const client = createChunkClient(payload => handler(payload, actor));
  await assert.rejects(client(input, { transferId: id }), { code: 'forbidden' });
  assert.equal((await handler(wire('metadata', id), actor)).state, 'receiving');
  assert.equal(effects, 0);
  allowed = true;
  assert.equal((await handler(wire('execute', id), actor)).state, 'completed');
  assert.ok((await handler(wire('get', id, { index: 0 }), actor)).data);
  allowed = false;
  const reopened = createChunkChannel(await f.open()).wrap(() => { effects++; return null; }, { authorize });
  for (const index of [0, 1]) {
    await assert.rejects(reopened(wire('get', id, { index }), actor), { code: 'forbidden' });
  }
  assert.equal((await reopened(wire('metadata', id), actor)).state, 'completed');
  assert.equal((await reopened(wire('execute', id), actor)).state, 'completed');
  assert.equal(effects, 1);
  assert.equal(checks, 5);
});

test('inline small requests take one call; large replies take only that call plus parts and ack, without retrying lost replies', { timeout: 60000 }, async t => {
  const f = await fixture(t), storage = await f.open(), actor = source();
  const large = { text: '中文🙂'.repeat(160000) };
  let effects = 0;
  const handler = createChunkChannel(storage).wrap(input => { effects++; return input.large ? large : 'small reply'; });
  const calls = [];
  const client = createChunkClient(async payload => {
    calls.push(payload);
    const reply = await handler(JSON.parse(JSON.stringify(payload)), actor);
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 1024 * 1024);
    return JSON.parse(JSON.stringify(reply));
  });
  assert.equal(await client({ large: false }, { inline: true, acknowledge: true }), 'small reply');
  assert.deepEqual(calls, [{ large: false }]);
  calls.length = 0;
  assert.deepEqual(await client({ large: true }, { inline: true, acknowledge: true }), large);
  const parts = Math.ceil(Buffer.byteLength(JSON.stringify(large)) / (256 * 1024));
  assert.equal(calls.length, 1 + parts + 1);
  assert.deepEqual(calls[0], { large: true });
  assert.deepEqual(calls.slice(1).map(call => call.operation), [...Array(parts).fill('get'), 'ack']);
  assert.equal(new Set(calls.slice(1).map(call => call.transferId)).size, 1);
  assert.equal((await handler(wire('metadata', calls[1].transferId), actor)).state, 'acknowledged');
  let deliveries = 0;
  const lostReply = createChunkClient(async payload => {
    deliveries++;
    await handler(payload, actor);
    throw new Error('response lost after execution');
  });
  await assert.rejects(lostReply({ large: false }, { inline: true }), { code: 'commit-unknown' });
  assert.equal(deliveries, 1);
  assert.equal(effects, 3);
});
