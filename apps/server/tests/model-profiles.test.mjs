import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModelProfiles } from '../../../packages/model-gateway/dist/profiles.js';

const day = 24 * 60 * 60 * 1000;
const interval = 10 * 60 * 1000;
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
  const result = await profiles.read({ ...query, modelIds: ['future-lab/orbit-2099', 'orbit-2099'], refresh: true });
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
  await profiles.read({ ...query, refresh: true });
  for (const modelId of ['future-lab/orbit-2099', 'gpt-5.2']) {
    for (const levels of [['none', 'medium'], []]) {
      const resolved = profiles.resolve({ ...query, modelId, reasoningLevels: levels });
      assert.equal(resolved.source, 'manual');
      assert.deepEqual(resolved.efforts, ['auto', ...levels]);
      if (modelId === 'future-lab/orbit-2099') {
        assert.equal(resolved.contextWindow, 128000, 'manual thinking levels do not erase capacity metadata');
        assert.equal(resolved.maxOutputTokens, 8192);
      }
    }
  }
});

test('catalogue capacity parsing retains 1M output limits', async () => {
  const source = catalogue();
  source['future-lab'].models['orbit-2099'].limit = { context: 1048576, output: 1048576 };
  const profiles = createModelProfiles(async () => response(source));
  const result = await profiles.read({ ...query, refresh: true });
  assert.equal(result.profiles[0].contextWindow, 1048576);
  assert.equal(result.profiles[0].maxOutputTokens, 1048576);
});

test('explicit refresh discovers a future model and changed effort metadata without a static-code update', async () => {
  let current = catalogue(), calls = 0, time = Date.UTC(2026, 10, 10);
  const profiles = createModelProfiles(async () => { calls++; return response(current); }, () => time);
  const input = { ...query, modelIds: ['orbit-2100'] };
  const unknown = (await profiles.read({ ...input, refresh: true })).profiles[0];
  assert.equal(unknown.source, 'unknown');
  assert.deepEqual(unknown.efforts, ['auto']);
  current = catalogue(['none', 'medium', 'max'], 256000);
  current['future-lab'].models['orbit-2100'] = current['future-lab'].models['orbit-2099'];
  assert.equal((await profiles.read(input)).profiles[0].source, 'unknown');
  time += interval;
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
  const result = await profiles.read({ ...query, refresh: true });
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
  const original = await profiles.read({ ...query, refresh: true });
  for (failure of ['network', 'http', 'json', 'empty']) {
    time += day;
    const result = await profiles.read({ ...query, refresh: true });
    assert.equal(result.stale, true, failure);
    assert.equal(result.updatedAt, original.updatedAt, failure);
    assert.deepEqual(result.profiles, original.profiles, failure);
  }
  failure = undefined; time += interval;
  const recovered = await profiles.read({ ...query, refresh: true });
  assert.equal(recovered.stale, false);
  assert.equal(recovered.updatedAt, new Date(time).toISOString());
  assert.deepEqual(recovered.profiles, original.profiles);
});

test('read-only callers return immediately while refresh callers merge one in-flight fetch', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const profiles = createModelProfiles(async () => { calls++; await gate; return response(catalogue()); });
  assert.equal((await profiles.read(query)).stale, true);
  assert.equal(calls, 0, 'read-only lookup cannot start external IO');
  const reads = Array.from({ length: 8 }, () => profiles.read({ ...query, refresh: true }));
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal((await profiles.read(query)).profiles[0].source, 'unknown');
  release();
  const results = await Promise.all(reads);
  for (const result of results) {
    assert.equal(result.stale, false);
    assert.deepEqual(result, results[0]);
  }
  assert.equal(calls, 1);
});

test('ordinary refresh uses ten minutes from request start; reads never refresh even expired cache', async () => {
  let calls = 0, time = Date.UTC(2026, 10, 10);
  const profiles = createModelProfiles(async () => { calls++; time += 5000; return response(catalogue()); }, () => time);
  const start = time;
  const initial = await profiles.read({ ...query, refresh: true });
  time = start + interval - 1;
  assert.deepEqual(await profiles.read({ ...query, refresh: true }), initial);
  assert.equal(calls, 1);
  time += 1;
  const refreshed = await profiles.read({ ...query, refresh: true });
  assert.equal(calls, 2);
  assert.equal(refreshed.updatedAt, new Date(time).toISOString());
  time += day;
  assert.equal((await profiles.read(query)).stale, true);
  assert.equal(calls, 2);
});

test('catalogue matches exact preset channels, including inferred URLs and ambiguous shared endpoints', async () => {
  const model = context => ({ limit: { context, output: context / 2 }, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] });
  const data = {
    zhipuai: { api: 'https://open.bigmodel.cn/api/paas/v4', models: { 'channel-model': model(1000000) } },
    'coding-catalogue': { api: 'https://open.bigmodel.cn/api/coding/paas/v4', models: { 'channel-model': model(200000) } },
    moonshotai: { api: 'https://api.moonshot.cn/v1', models: { 'channel-model': model(1000000) } },
    'kimi-code-plan-cn': { api: 'https://api.kimi.com/coding/v1', models: { 'channel-model': model(300000) } },
    xiaomi: { api: 'https://api.xiaomimimo.com/v1', models: { 'channel-model': model(1000000) } },
    'xiaomi-token-plan-cn': { api: 'https://token-plan-cn.xiaomimimo.com/v1', models: { 'channel-model': model(400000) } },
    'opencode-go': { api: 'https://opencode.ai/inference/go/openai/v1', models: { 'channel-model': model(500000) } },
  };
  const profiles = createModelProfiles(async () => response(data));
  await profiles.update();
  for (const [presetId, variantId, baseUrl, context] of [
    ['zhipu', 'api', data.zhipuai.api, 1000000], ['zhipu', 'coding', data['coding-catalogue'].api, 200000],
    ['kimi', 'code', data['kimi-code-plan-cn'].api, 300000], ['mimo', 'token', data['xiaomi-token-plan-cn'].api, 400000],
    ['opencode-go', 'go', data['opencode-go'].api, 500000],
  ]) {
    const route = { presetId, variantId, baseUrl, protocol: 'chat-completions', modelId: 'channel-model' };
    assert.equal(profiles.resolve(route).contextWindow, context, `${presetId}/${variantId}`);
    assert.equal((await profiles.read({ baseUrl, protocol: route.protocol, modelIds: [route.modelId] })).profiles[0].contextWindow, context);
  }
  const shared = { baseUrl: 'https://open.bigmodel.cn/api/anthropic', protocol: 'messages', modelId: 'channel-model' };
  assert.equal(profiles.resolve(shared).contextWindow, undefined, 'shared endpoint alone does not identify API vs Coding');
  assert.equal(profiles.resolve({ ...shared, presetId: 'zhipu', variantId: 'coding' }).contextWindow, 200000);
  assert.equal(profiles.resolve({ ...shared, presetId: 'zhipu', variantId: 'api' }).contextWindow, 1000000);
  assert.equal(profiles.resolve({ ...shared, presetId: 'zhipu', variantId: 'unknown' }).contextWindow, undefined);
  assert.deepEqual(profiles.directoryEntries([], shared.baseUrl, { ...shared, presetId: 'zhipu', variantId: 'coding' })
    .map(entry => entry.contextWindow), [200000]);
});

test('missing channel metadata never borrows ordinary API limits and conflicting relay models have no arbitrary capacity', async () => {
  const profiles = createModelProfiles(async () => response({
    zhipuai: { api: 'https://open.bigmodel.cn/api/paas/v4', models: { 'unknown-channel-model': { limit: { context: 1000000, output: 131072 } } } },
    other: { api: 'https://other.example/v1', models: { 'unknown-channel-model': { limit: { context: 200000, output: 32768 } } } },
  }));
  await profiles.update();
  for (const route of [
    { presetId: 'zhipu', variantId: 'coding', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
    { presetId: 'custom', baseUrl: 'https://relay.example/v1' },
    { baseUrl: 'https://open.bigmodel.cn/unrecognized/v1' },
  ]) {
    const profile = profiles.resolve({ ...route, protocol: 'chat-completions', modelId: 'unknown-channel-model' });
    assert.equal(profile.contextWindow, undefined);
    assert.equal(profile.maxOutputTokens, undefined);
  }
});
