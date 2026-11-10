import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCatalogueCache, CatalogueFailure, readCatalogueJson } from '../../../packages/learning-space/dist/model-connections/catalogue-cache.js';
import { createModelDirectory, parseSupplierModels } from '../../../packages/learning-space/dist/model-connections/directory.js';
import { createModelProfiles } from '../../../packages/learning-space/dist/model-connections/profiles.js';

const json = value => new Response(JSON.stringify(value));
const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '测试' };
const publicData = { future: { api: 'https://provider.example/v1', models: {
  'new-model': { name: '新模型', reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }], limit: { context: 1000000, output: 1048576 } },
} } };
const source = { baseUrl: 'https://provider.example/v1', protocol: 'chat-completions', modelsUrl: 'https://provider.example/v1/models',
  catalogues: ['future'], models: [{ modelId: 'seed', contextWindow: 128000 }] };
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

test('manual bypasses successful ten-minute cooldown, keeps 3s burst debounce and merges in-flight', async () => {
  let now = 1000000, calls = 0, release;
  const cache = createCatalogueCache(() => now);
  const load = async () => { calls++; return ['cached']; };
  assert.equal((await cache.refresh('one', load)).status, 'ready');
  now += 2999;
  assert.equal((await cache.refresh('one', load, true)).status, 'cooldown');
  assert.equal(calls, 1);
  now++;
  await cache.refresh('one', load, true);
  assert.equal(calls, 2);
  now += 3000;
  assert.equal((await cache.refresh('one', load)).status, 'cooldown');
  const gate = new Promise(resolve => { release = resolve; });
  const first = cache.refresh('one', async () => { calls++; await gate; return ['new']; }, true);
  const second = cache.refresh('one', load, true);
  await tick(); assert.equal(calls, 3);
  release();
  assert.deepEqual(await first, await second);
});

test('backoff persists attempt/success/retry state and honors 429 Retry-After even for manual refresh', async () => {
  let now = 1000000, calls = 0;
  const saved = new Map();
  const persistence = { async load() { return structuredClone(saved); }, async save(k, v) { saved.set(k, structuredClone(v)); } };
  let cache = createCatalogueCache(() => now, persistence); await cache.initialize();
  await cache.refresh('key', async () => 'last-good');
  const successAt = cache.read('key').updatedAt;
  const fail = async () => { calls++; throw new CatalogueFailure('offline'); };
  for (const delay of [5000, 15000, 30000, 60000, 120000, 240000, 300000, 300000]) {
    now = Math.max(now + 3000, cache.state('key').retryAt ?? 0);
    await cache.refresh('key', fail, true);
    assert.equal(cache.state('key').retryAt, now + delay);
    assert.equal(cache.state('key').data, 'last-good');
    assert.equal(cache.read('key').updatedAt, successAt);
    assert.equal((await cache.refresh('key', fail, true)).status, 'cooldown');
  }
  assert.equal(calls, 8);
  cache = createCatalogueCache(() => now, persistence); await cache.initialize();
  assert.equal((await cache.refresh('key', fail, true)).status, 'cooldown');
  assert.equal(calls, 8);
  now = cache.state('key').retryAt;
  await cache.refresh('key', async () => readCatalogueJson(new Response('', { status: 429, headers: { 'retry-after': '600' } }), () => now), true);
  assert.equal(cache.read('key').error, 'rate-limited');
  assert.equal(cache.state('key').retryAt, now + 600000);
});

test('provider-specific capacity, effort defaults, protocol lists and toggles are parsed without retaining raw payload', () => {
  assert.deepEqual(parseSupplierModels({ data: [{ id: 'model', context_length: 1048576, limit: { output: 1048576 },
    think_efforts: { valid_efforts: ['low', 'high', 'max'], default_effort: 'high' },
    supported_endpoints: ['/v1/messages', '/v1/responses'], sealed: 'must-not-persist' }] }), [{
    modelId: 'model', contextWindow: 1048576, maxOutputTokens: 1048576,
    efforts: ['low', 'high', 'max'], defaultEffort: 'high', reasoningKind: 'effort', protocols: ['messages', 'responses'],
  }]);
  assert.equal(parseSupplierModels({ data: [{ id: 'toggle', supports_thinking_type: 'both' }] })[0].reasoningKind, 'toggle');
  assert.deepEqual(parseSupplierModels({ data: [{ id: 'toggle', supports_thinking_type: 'both' }] })[0].efforts, ['none', 'enabled']);
  assert.deepEqual(parseSupplierModels({ data: [{ id: 'plain', capabilities: { reasoning: false }, supported_endpoints: ['chat.completions'] }] }),
    [{ modelId: 'plain', reasoningKind: 'none', efforts: [], protocols: ['chat-completions'] }]);
  assert.throws(() => parseSupplierModels({ data: [{ id: 'secret-value' }] }, 'secret-value'), /invalid-response/);
  assert.throws(() => parseSupplierModels({ nonsense: true }), /invalid-response/);
});

test('failed ordinary events keep ten-minute request-start gate while explicit retry honors the short failure backoff', async () => {
  let now = 1000000, calls = 0;
  const cache = createCatalogueCache(() => now);
  const fail = async () => { calls++; throw new CatalogueFailure('offline'); };
  await cache.refresh('failed', fail);
  now += 5000;
  assert.equal((await cache.refresh('failed', fail)).status, 'cooldown');
  assert.equal(calls, 1);
  assert.equal((await cache.refresh('failed', fail, true)).status, 'failed');
  assert.equal(calls, 2);
});

test('cached seeds return with no IO; supplier progresses independently from a slow public catalogue', async () => {
  let release, publicCalls = 0, supplierCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = createCatalogueCache();
  const profiles = createModelProfiles(async (url, options) => {
    publicCalls++; assert.equal(url, 'https://models.dev/api.json'); assert.equal(options.headers, undefined);
    await gate; return json(publicData);
  }, Date.now, cache);
  const directory = createModelDirectory(profiles, { authorize: async () => {}, key: new Uint8Array(32), source: () => source,
    credential: async () => 'synthetic-secret', requestFetch: async () => async (url, options) => {
      supplierCalls++; assert.equal(url, source.modelsUrl); assert.equal(options.headers.authorization, 'Bearer synthetic-secret');
      return json({ data: [{ id: 'new-model', context_length: 262144 }] });
    } });
  assert.equal((await directory.read(identity, {})).models[0].modelId, 'seed');
  assert.equal(publicCalls + supplierCalls, 0);
  const busy = directory.read(identity, { refresh: true });
  await tick();
  const partial = await directory.read(identity, {});
  assert.equal(partial.catalogue.status, 'refreshing');
  assert.equal(partial.supplier.status, 'ready');
  assert.equal(partial.models[0].contextWindow, 262144);
  release();
  const complete = await busy;
  assert.equal(complete.models[0].maxOutputTokens, 1048576);
  assert.equal(complete.models[0].contextWindow, 262144, 'account metadata takes precedence over shared catalogue');
  assert.equal(publicCalls, 1); assert.equal(supplierCalls, 1);
});

test('owner, credential, variant and endpoint isolate supplier cache; missing credential never uses a previous owner list', async () => {
  const saved = new Map(), cache = createCatalogueCache(Date.now, {
    async load() { return saved; }, async save(key, value) { saved.set(key, structuredClone(value)); },
  });
  const profiles = createModelProfiles(async () => json(publicData), Date.now, cache);
  let secret = 'private-fixture-a', calls = 0;
  const directory = createModelDirectory(profiles, { authorize: async () => {}, key: new Uint8Array(32).fill(9),
    source: input => ({ ...source, modelsUrl: input.baseUrl ?? source.modelsUrl }), credential: async () => secret,
    requestFetch: async () => async () => { calls++; return json({ data: [{ id: 'private-account-model' }] }); } });
  await directory.read(identity, { refresh: true });
  assert.equal((await directory.read(identity, {})).models[0].modelId, 'private-account-model');
  for (const [who, input] of [[{ ...identity, principalId: randomUUID() }, {}], [identity, { variantId: 'other' }],
    [identity, { baseUrl: 'https://other.example/v1/models' }]]) {
    assert.equal((await directory.read(who, input)).models.some(model => model.modelId === 'private-account-model'), false);
  }
  secret = 'private-fixture-b'; assert.equal((await directory.read(identity, {})).models.some(model => model.modelId === 'private-account-model'), false);
  secret = ''; assert.equal((await directory.read(identity, {})).supplier.status, 'needs-credential');
  assert.equal(calls, 1);
  const persisted = JSON.stringify([...saved]);
  assert.equal(persisted.includes('private-fixture'), false);
  assert.equal(persisted.includes(identity.principalId), false);
  assert.match([...saved.keys()].find(key => key.startsWith('supplier:')), /^supplier:[a-f0-9]{64}$/);
});

test('refreshed public model facts supersede offline seeds field by field', async () => {
  const profiles = createModelProfiles(async () => json(publicData));
  const seeded = { ...source, models: [{ modelId: 'new-model', contextWindow: 128000, maxOutputTokens: 32000,
    defaultEffort: 'high', efforts: ['low'] }] };
  const directory = createModelDirectory(profiles, { authorize: async () => {}, key: new Uint8Array(32), source: () => seeded,
    credential: async () => '', requestFetch: async () => { throw new Error('no credential, no supplier request'); } });
  assert.equal((await directory.read(identity, {})).models[0].contextWindow, 128000);
  const updated = (await directory.read(identity, { refresh: true })).models[0];
  assert.equal(updated.contextWindow, 1000000);
  assert.equal(updated.maxOutputTokens, 1048576);
  assert.deepEqual(updated.efforts, ['low', 'high']);
  assert.equal(updated.defaultEffort, 'high', 'missing public fields still use the seed');
});

test('malformed/oversized responses preserve last good values; errors never include upstream text', async () => {
  assert.deepEqual(await readCatalogueJson(json({ data: [] })), { data: [] });
  await assert.rejects(readCatalogueJson(new Response('not-json')), /invalid-response/);
  await assert.rejects(readCatalogueJson(new Response('12345'), Date.now, 4), /invalid-response/);
  await assert.rejects(readCatalogueJson(new Response('secret text', { status: 401 })), error => error.kind === 'unauthorized' && !error.message.includes('secret'));
});
