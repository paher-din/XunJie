import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelProviderPresets, getModelPreset, resolvePresetModelRoute } from '../dist/model-presets.js';

test('six discovery presets keep ordinary API and subscription routes separate', () => {
  assert.deepEqual(modelProviderPresets.map(preset => preset.id), ['deepseek', 'opencode-go', 'command-code', 'zhipu', 'kimi', 'mimo']);
  assert.equal(getModelPreset('zhipu')?.id, 'api');
  assert.equal(getModelPreset('kimi')?.id, 'api');
  assert.equal(getModelPreset('mimo')?.id, 'api');
  for (const [id, variant] of [['zhipu', 'coding'], ['kimi', 'code'], ['mimo', 'token']] as const) {
    assert.notEqual(getModelPreset(id)?.baseUrls['chat-completions'], getModelPreset(id, variant)?.baseUrls['chat-completions']);
    assert.equal(getModelPreset(id, 'misspelled-plan'), undefined);
  }
  assert.equal(getModelPreset('custom'), undefined);
  const go = getModelPreset('opencode-go')!;
  assert.equal(go.modelsUrl, 'https://opencode.ai/inference/go/v1/models');
  for (const base of Object.values(go.baseUrls)) assert.equal(base.includes('/zen/'), false);
});

test('mixed-provider models route by their actual native protocol, with live restrictions authoritative', () => {
  assert.deepEqual(resolvePresetModelRoute('command-code', 'api', 'claude-sonnet-4-6'),
    { protocol: 'messages', baseUrl: 'https://api.commandcode.ai/provider' });
  assert.equal(resolvePresetModelRoute('command-code', 'api', 'claude-sonnet-4-6', []), undefined);
  assert.deepEqual(resolvePresetModelRoute('command-code', 'api', 'brand-new-model', ['responses']),
    { protocol: 'responses', baseUrl: 'https://api.commandcode.ai/provider/v1' });
  assert.deepEqual(resolvePresetModelRoute('opencode-go', 'go', 'minimax-m3'),
    { protocol: 'messages', baseUrl: 'https://opencode.ai/inference/go/anthropic' });
  assert.equal(resolvePresetModelRoute('custom', undefined, 'anything'), undefined);
});

test('channel identities, real defaults and absent subscription limits are preserved', () => {
  const api = getModelPreset('kimi', 'api')!.models.find(model => model.modelId === 'kimi-k3')!;
  const code = getModelPreset('kimi', 'code')!.models.find(model => model.modelId === 'k3')!;
  assert.equal(api.defaultEffort, 'max');
  assert.equal(code.defaultEffort, 'high');
  assert.equal(code.maxOutputTokens, undefined);
  assert.equal(code.contextWindow, undefined); // account tier, not a universal 1M promise
  const kimiApi = getModelPreset('kimi', 'api')!.models;
  assert.deepEqual(kimiApi.map(model => model.modelId), ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3']);
  for (const model of kimiApi) {
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxOutputTokens, 1048576); // ceiling, not the 131072 default
  }
  const mimoApi = getModelPreset('mimo', 'api')!.models;
  assert.deepEqual(mimoApi.map(model => model.modelId), ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed']);
  for (const model of mimoApi) {
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxOutputTokens, 131072);
  }
  for (const model of getModelPreset('mimo', 'token')!.models) {
    assert.equal(model.contextWindow, undefined);
    assert.equal(model.maxOutputTokens, undefined);
  }
  for (const model of getModelPreset('zhipu', 'coding')!.models) assert.equal(model.maxOutputTokens, undefined);
  for (const variant of modelProviderPresets.find(preset => preset.id === 'mimo')!.variants)
    for (const model of variant.models) {
      assert.equal(model.reasoningKind, 'toggle');
      assert.deepEqual(model.efforts, ['none', 'enabled']);
      assert.equal(model.defaultEffort, 'enabled');
    }
});

test('default selection returns detached models and controls with no capability-verification claims', () => {
  const copy = getModelPreset('deepseek')!;
  copy.models[0]!.efforts!.push('medium');
  copy.baseUrls.messages = 'https://wrong.example';
  assert.equal(getModelPreset('deepseek')!.models[0]!.efforts!.includes('medium'), false);
  assert.equal(getModelPreset('deepseek')!.baseUrls.messages, 'https://api.deepseek.com/anthropic');
  assert.equal(JSON.stringify(modelProviderPresets).includes('verified'), false);
});
