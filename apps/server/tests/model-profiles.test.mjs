import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModelProfiles } from '../../../packages/learning-space/dist/model-connections/profiles.js';

const day = 24 * 60 * 60 * 1000;
const query = { baseUrl: 'https://relay.example/custom/v1', protocol: 'chat-completions', modelIds: ['future-lab/orbit-2099'] };
const catalogue = (levels = ['low', 'high'], context = 128000) => ({
  'future-lab': { api: 'https://api.future.example/v1', models: {
    'orbit-2099': { canonical_model_id: 'future-lab/orbit-2099', reasoning: true,
      reasoning_options: [{ type: 'effort', values: levels }], limit: { context, output: 8192 } },
  } },
});
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('downloads the whole catalogue once and matches model identities behind a custom relay URL', async () => {
  const calls = [];
  const profiles = createModelProfiles(async (url, options) => { calls.push({ url, options }); return response(catalogue()); });
  const result = await profiles.read({ ...query, modelIds: ['future-lab/orbit-2099', 'orbit-2099'] });
  assert.equal(result.stale, false);
  assert.ok(result.updatedAt);
  for (const profile of result.profiles) {
    assert.equal(profile.source, 'catalogue');
    assert.equal(profile.dialect, 'standard');
    assert.deepEqual(profile.efforts, ['auto', 'low', 'high']);
    assert.equal(profile.contextWindow, 128000);
    assert.equal(profile.maxOutputTokens, 8192);
  }
  assert.deepEqual(result.profiles.map(profile => profile.modelId), ['future-lab/orbit-2099', 'orbit-2099']);
  await profiles.read({ ...query, baseUrl: 'https://another-relay.example/v1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://models.dev/api.json', 'no private relay/model query is sent to the catalogue');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('manual declarations override catalogue and static profiles, including an explicit empty declaration', async () => {
  const profiles = createModelProfiles(async () => response(catalogue()));
  await profiles.read(query);
  for (const modelId of ['future-lab/orbit-2099', 'gpt-5.2']) {
    for (const levels of [['none', 'medium'], []]) {
      const resolved = profiles.resolve({ ...query, modelId, reasoningLevels: levels });
      assert.equal(resolved.source, 'manual');
      assert.deepEqual(resolved.efforts, ['auto', ...levels]);
    }
  }
});

test('explicit refresh discovers a future model and changed effort metadata without a static-code update', async () => {
  let current = catalogue(), calls = 0, time = Date.UTC(2026, 10, 10);
  const profiles = createModelProfiles(async () => { calls++; return response(current); }, () => time);
  const input = { ...query, modelIds: ['orbit-2100'] };
  const unknown = (await profiles.read(input)).profiles[0];
  assert.equal(unknown.source, 'unknown');
  assert.deepEqual(unknown.efforts, ['auto']);
  current = catalogue(['none', 'medium', 'max'], 256000);
  current['future-lab'].models['orbit-2100'] = current['future-lab'].models['orbit-2099'];
  assert.equal((await profiles.read(input)).profiles[0].source, 'unknown');
  time += 1;
  const refreshed = await profiles.read({ ...input, refresh: true });
  assert.equal(calls, 2);
  assert.equal(refreshed.stale, false);
  assert.equal(refreshed.updatedAt, new Date(time).toISOString());
  assert.equal(refreshed.profiles[0].source, 'catalogue');
  assert.deepEqual(refreshed.profiles[0].efforts, ['auto', 'none', 'medium', 'max']);
  assert.equal(refreshed.profiles[0].contextWindow, 256000);
});

test('unknown models remain usable with auto when the initial catalogue request fails', async () => {
  const profiles = createModelProfiles(async () => { throw new Error('offline'); });
  const result = await profiles.read(query);
  assert.equal(result.stale, true);
  assert.equal(result.updatedAt, undefined);
  assert.equal(result.profiles[0].source, 'unknown');
  assert.deepEqual(result.profiles[0].efforts, ['auto']);
});

test('failed refreshes preserve the last good cache and timestamp, then recover', async () => {
  let failure, time = Date.UTC(2026, 10, 10);
  const profiles = createModelProfiles(async () => {
    if (failure === 'network') throw new Error('offline');
    if (failure === 'http') return new Response('unavailable', { status: 503 });
    if (failure === 'json') return new Response('{');
    if (failure === 'empty') return response({});
    return response(catalogue());
  }, () => time);
  const original = await profiles.read(query);
  for (failure of ['network', 'http', 'json', 'empty']) {
    time += day;
    const result = await profiles.read({ ...query, refresh: true });
    assert.equal(result.stale, true, failure);
    assert.equal(result.updatedAt, original.updatedAt, failure);
    assert.deepEqual(result.profiles, original.profiles, failure);
  }
  failure = undefined;
  const recovered = await profiles.read({ ...query, refresh: true });
  assert.equal(recovered.stale, false);
  assert.equal(recovered.updatedAt, new Date(time).toISOString());
  assert.deepEqual(recovered.profiles, original.profiles);
});

test('concurrent reads and refreshes share one in-flight catalogue fetch', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const profiles = createModelProfiles(async () => { calls++; await gate; return response(catalogue()); });
  const reads = Array.from({ length: 8 }, (_, index) => profiles.read({ ...query, refresh: index % 2 === 0 }));
  assert.equal(calls, 1);
  release();
  const results = await Promise.all(reads);
  for (const result of results) {
    assert.equal(result.stale, false, 'all callers wait for the shared fetch, including ordinary reads');
    assert.deepEqual(result, results[0]);
  }
  assert.equal(calls, 1);
});

test('the cache lasts 24 hours and explicit refresh bypasses TTL and failure backoff', async () => {
  let calls = 0, time = Date.UTC(2026, 10, 10), offline = false;
  const profiles = createModelProfiles(async () => {
    calls++;
    if (offline) throw new Error('offline');
    return response(catalogue());
  }, () => time);
  const initial = await profiles.read(query);
  time += day - 1;
  assert.deepEqual(await profiles.read(query), initial);
  assert.equal(calls, 1);
  time += 1;
  const expired = await profiles.read(query);
  assert.equal(calls, 2);
  assert.equal(expired.stale, false);
  assert.equal(expired.updatedAt, new Date(time).toISOString());
  await profiles.read({ ...query, refresh: true });
  assert.equal(calls, 3, 'refresh runs even at the exact time of the successful fetch');
  offline = true;
  assert.equal((await profiles.read({ ...query, refresh: true })).stale, true);
  assert.equal(calls, 4);
  offline = false;
  assert.equal((await profiles.read({ ...query, refresh: true })).stale, false);
  assert.equal(calls, 5, 'refresh retries immediately after failure');
});
