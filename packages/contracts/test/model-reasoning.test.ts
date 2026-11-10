import assert from 'node:assert/strict';
import { test } from 'node:test';
// The package's public re-export is connected separately; exercise emitted JS,
// just as package imports do after the contracts build.
import { isReasoningEffortSupported, modelReasoningEfforts, modelReasoningError,
  modelReasoningParameters, resolveModelProfile } from '../dist/model-reasoning.js';
import type { ReasoningEffort, ReasoningRoute } from '../src/model-reasoning.ts';

const route = (modelId: string, changes: Partial<ReasoningRoute> = {}): ReasoningRoute => ({
  protocol: 'chat-completions', baseUrl: /^(?:deepseek\/)?deepseek-/.test(modelId)
    ? 'https://api.deepseek.com' : 'https://relay.example/tenant/v1', modelId, ...changes,
});
const parameters = (modelId: string, effort: ReasoningEffort, changes: Partial<ReasoningRoute> = {}, output = 8192) =>
  modelReasoningParameters(route(modelId, { reasoningEffort: effort, ...changes }), output);

test('OpenAI effort ladders are model specific, including Pro and Codex restrictions', () => {
  const cases: [string, ReasoningEffort[]][] = [
    ['gpt-5', ['auto', 'minimal', 'low', 'medium', 'high']],
    ['gpt-5-mini', ['auto', 'minimal', 'low', 'medium', 'high']],
    ['gpt-5.1', ['auto', 'none', 'low', 'medium', 'high']],
    ['gpt-5.2', ['auto', 'none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.4', ['auto', 'none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.5', ['auto', 'none', 'low', 'medium', 'high', 'xhigh']],
    ['o3', ['auto', 'low', 'medium', 'high']],
    ['o4-mini', ['auto', 'low', 'medium', 'high']],
    ['gpt-4o', ['auto']],
  ];
  for (const [id, efforts] of cases) {
    const profile = resolveModelProfile(route(id));
    assert.equal(profile.source, 'known', id);
    assert.deepEqual(profile.efforts, efforts, id);
  }
  assert.deepEqual(resolveModelProfile(route('gpt-5-pro', { protocol: 'responses' })).efforts, ['auto', 'high']);
  assert.deepEqual(resolveModelProfile(route('gpt-5.2-pro', { protocol: 'responses' })).efforts,
    ['auto', 'medium', 'high', 'xhigh']);
  assert.deepEqual(resolveModelProfile(route('gpt-5.3-codex', { protocol: 'responses' })).efforts,
    ['auto', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(resolveModelProfile(route('gpt-5.3-codex')).efforts, ['auto']);
});

test('OpenAI uses the selected protocol without DeepSeek-specific thinking fields', () => {
  assert.deepEqual(parameters('openai/gpt-5.2', 'xhigh'), { reasoning_effort: 'xhigh' });
  assert.deepEqual(parameters('openai/gpt-5.2', 'none', { protocol: 'responses' }), { reasoning: { effort: 'none' } });
  assert.deepEqual(parameters('o3', 'high', { protocol: 'responses' }), { reasoning: { effort: 'high' } });
  assert.deepEqual(parameters('gpt-5', 'minimal'), { reasoning_effort: 'minimal' });
  assert.throws(() => parameters('gpt-5', 'none'), RangeError);
  assert.throws(() => parameters('gpt-5.1', 'xhigh'), RangeError);
  assert.throws(() => parameters('gpt-5.2', 'max'), RangeError);
});

test('known relay IDs, snapshots, Bedrock and Vertex identities are looked up without rewriting the wire model', () => {
  for (const id of ['openai/gpt-5.2-2025-12-11', 'tenant/openai/gpt-5.2', 'openai/gpt-5.2:free'])
    assert.equal(resolveModelProfile(route(id)).canonicalModelId, 'gpt-5.2', id);
  for (const id of ['anthropic/claude-opus-4.6', 'us.anthropic.claude-opus-4-6-20260205-v1:0',
    'claude-opus-4-6@20260205', 'claude-opus-4-6-latest']) {
    assert.equal(resolveModelProfile(route(id, { protocol: 'messages' })).canonicalModelId, 'claude-opus-4-6', id);
    assert.deepEqual(parameters(id, 'max', { protocol: 'messages' }),
      { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }, id);
  }
  const input = route('openai/gpt-5.2-2025-12-11', { reasoningEffort: 'high' });
  const before = structuredClone(input);
  assert.deepEqual(modelReasoningParameters(input, 64), { reasoning_effort: 'high' });
  assert.deepEqual(input, before);
});

test('unknown models and unreviewed versions retain auto only, regardless of host or vendor names', () => {
  for (const id of ['custom', 'gpt-50', 'gpt-5.99', 'claude-opus-99', 'qwen3-unknown',
    'deepseek-r1-distill-qwen-32b', 'gpt-5.2-finetuned', 'claude-deepseek-custom', 'gpt-5.2(high)',
    'gpt-5-codex-mini', 'claude-sonnet-4-1', 'deepseek-v4.1-pro']) {
    for (const baseUrl of ['https://api.openai.com/v1', 'https://api.deepseek.com', 'https://relay.example/v1']) {
      const input = route(id, { baseUrl, reasoningEffort: 'auto' });
      assert.equal(resolveModelProfile(input).source, 'unknown', id);
      assert.deepEqual(resolveModelProfile(input).efforts, ['auto'], id);
      assert.deepEqual(modelReasoningParameters(input, 128), {}, id);
      assert.equal(isReasoningEffortSupported(input, 'high'), false, id);
      assert.throws(() => modelReasoningParameters({ ...input, reasoningEffort: 'high' }, 128), RangeError, id);
    }
  }
});

test('dialect detection uses exact authorities and reviewed model IDs, including Command Code', () => {
  assert.equal(resolveModelProfile(route('custom', { baseUrl: 'https://API.COMMANDCODE.AI:443/provider/v1' })).dialect, 'command-code');
  assert.equal(resolveModelProfile(route('deepseek/deepseek-v4.1-flash')).dialect, 'deepseek');
  assert.equal(resolveModelProfile(route('deepseek/deepseek-v4.1-flash', {
    baseUrl: 'https://api.commandcode.ai/provider/v1',
  })).dialect, 'command-code');
  for (const baseUrl of ['https://api.deepseek.com.evil.example', 'https://relay.example/api.commandcode.ai',
    'https://api.commandcode.ai@relay.example', 'https://api.commandcode.ai.evil.example'])
    assert.equal(resolveModelProfile(route('custom', { baseUrl })).dialect, 'standard', baseUrl);
  assert.deepEqual(parameters('custom', 'auto', { dialect: 'deepseek' }), {});
});

test('DeepSeek native chat, Responses and Messages encode only its supported ladder', () => {
  for (const id of ['deepseek-v4-flash', 'deepseek/deepseek-v4.1-flash', 'deepseek-pro', 'deepseek-v4-pro-0813']) {
    assert.deepEqual(resolveModelProfile(route(id)).efforts, ['auto', 'none', 'low', 'high', 'max']);
    for (const effort of ['low', 'high', 'max'] as const) {
      assert.deepEqual(parameters(id, effort), { thinking: { type: 'enabled' }, reasoning_effort: effort });
      assert.deepEqual(parameters(id, effort, { protocol: 'responses' }), { reasoning: { effort } });
      assert.deepEqual(parameters(id, effort, { protocol: 'messages' }, 32),
        { thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort } });
    }
    assert.deepEqual(parameters(id, 'none'), { thinking: { type: 'disabled' } });
    assert.deepEqual(parameters(id, 'none', { protocol: 'messages' }), { thinking: { type: 'disabled' } });
    assert.throws(() => parameters(id, 'medium'), RangeError);
    assert.throws(() => parameters(id, 'xhigh'), RangeError);
  }
  assert.deepEqual(resolveModelProfile(route('deepseek-v3.2')).efforts, ['auto', 'none']);
  assert.deepEqual(resolveModelProfile(route('deepseek-r1')).efforts, ['auto']);
});

test('Claude adaptive effort differs from legacy manual-budget models', () => {
  for (const id of ['claude-opus-4-6', 'claude-sonnet-4-6']) {
    assert.deepEqual(parameters(id, 'high', { protocol: 'messages' }, 128),
      { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    assert.deepEqual(parameters(id, 'none', { protocol: 'messages' }), { thinking: { type: 'disabled' } });
    assert.throws(() => parameters(id, 'minimal', { protocol: 'messages' }), RangeError);
    assert.throws(() => parameters(id, 'xhigh', { protocol: 'messages' }), RangeError);
  }
  assert.deepEqual(parameters('claude-opus-4-5-20251101', 'medium', { protocol: 'messages' }, 1025),
    { thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'medium' } });
  assert.deepEqual(resolveModelProfile(route('claude-sonnet-4-5', { protocol: 'messages' })).efforts, ['auto', 'none']);
  assert.deepEqual(parameters('claude-sonnet-4-5', 'auto', { protocol: 'messages', parameterMode: 'thinking' }),
    { thinking: { type: 'enabled', budget_tokens: 1024 } });
  assert.throws(() => parameters('claude-sonnet-4-5', 'high', { protocol: 'messages' }), RangeError);
});

test('manual Claude budgets fail clearly below the minimum without changing model or output limits', () => {
  for (const output of [1, 128, 1023, 1024]) {
    const input = route('claude-opus-4-5', { protocol: 'messages', reasoningEffort: 'high' });
    const copy = structuredClone(input);
    assert.match(modelReasoningError(input, output) ?? '', /1024/);
    assert.throws(() => modelReasoningParameters(input, output), /1024/);
    assert.deepEqual(input, copy);
    assert.throws(() => parameters('claude-sonnet-4-5', 'auto', {
      protocol: 'messages', parameterMode: 'thinking',
    }, output), /1024/);
  }
  assert.equal(modelReasoningError(route('claude-opus-4-5', { protocol: 'messages', reasoningEffort: 'high' })), undefined);
  assert.deepEqual(parameters('claude-opus-4-5', 'none', { protocol: 'messages' }, 1), { thinking: { type: 'disabled' } });
});

test('binary Qwen, GLM and Kimi controls never pretend to have effort tiers', () => {
  assert.deepEqual(parameters('qwen/qwen3-32b', 'none'), { enable_thinking: false });
  assert.deepEqual(parameters('qwen/qwen3-32b', 'auto', { parameterMode: 'thinking' }), { enable_thinking: true });
  for (const id of ['glm-4.6', 'glm-4.7', 'glm-5', 'glm-5.1', 'moonshotai/kimi-k2.5']) {
    assert.deepEqual(resolveModelProfile(route(id)).efforts, ['auto', 'none']);
    assert.deepEqual(parameters(id, 'none'), { thinking: { type: 'disabled' } });
    assert.deepEqual(parameters(id, 'auto', { parameterMode: 'thinking' }), { thinking: { type: 'enabled' } });
    assert.throws(() => parameters(id, 'high'), RangeError);
  }
  assert.deepEqual(resolveModelProfile(route('kimi-k2-thinking')).efforts, ['auto']);
  assert.deepEqual(parameters('glm-5.2', 'high'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  assert.deepEqual(resolveModelProfile(route('glm-5.3')).efforts, ['auto', 'low', 'high', 'max']);
  assert.throws(() => parameters('glm-5.3', 'none'), RangeError);
  assert.throws(() => parameters('glm-5.3', 'medium'), RangeError);
});

test('protocol mismatches do not invent another provider protocol for known models', () => {
  for (const [id, protocol] of [['claude-opus-4-6', 'chat-completions'], ['gpt-5.2', 'messages'],
    ['qwen3-32b', 'responses'], ['glm-5.2', 'messages'], ['kimi-k2.5', 'responses']] as const) {
    assert.deepEqual(resolveModelProfile(route(id, { protocol })).efforts, ['auto']);
    assert.deepEqual(parameters(id, 'auto', { protocol, parameterMode: 'thinking' }), {});
    assert.throws(() => parameters(id, 'high', { protocol }), RangeError);
  }
});

test('auto never hardcodes an effort, even with the legacy thinking toggle enabled', () => {
  for (const id of ['gpt-5.2', 'deepseek-v4-flash', 'claude-opus-4-6', 'custom']) {
    for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
      const result = parameters(id, 'auto', { protocol, parameterMode: 'thinking' });
      assert.equal(result.reasoning_effort, undefined);
      assert.equal(result.reasoning, undefined);
      assert.equal(result.output_config, undefined);
    }
  }
});

test('missing effort preserves exact legacy DeepSeek behavior on all three protocols', () => {
  for (const id of ['custom-legacy-alias', 'deepseek-chat', 'deepseek-v4.1-flash']) {
    const base = route(id, { dialect: 'deepseek', parameterMode: 'thinking' });
    assert.deepEqual(modelReasoningParameters(base, 128), { thinking: { type: 'enabled' } });
    assert.deepEqual(modelReasoningParameters({ ...base, protocol: 'responses' }, 128), { reasoning: { effort: 'high' } });
    assert.deepEqual(modelReasoningParameters({ ...base, protocol: 'messages' }, 128),
      { thinking: { type: 'enabled', budget_tokens: 1024 } });
    for (const protocol of ['chat-completions', 'responses', 'messages'] as const)
      assert.deepEqual(modelReasoningParameters({ ...base, protocol, parameterMode: 'plain' }, 128),
        protocol === 'responses' ? { reasoning: { effort: 'none' } } : { thinking: { type: 'disabled' } });
  }
  for (const dialect of ['standard', 'command-code'] as const) {
    for (const protocol of ['chat-completions', 'responses', 'messages'] as const)
      assert.deepEqual(modelReasoningParameters(route('deepseek-v4-flash', { dialect, protocol, parameterMode: 'thinking' }), 128), {});
  }
  assert.deepEqual(modelReasoningParameters(route('gpt-5.2', { parameterMode: 'thinking' }), 128), {});
  assert.deepEqual(parameters('deepseek-v4-flash', 'auto', { dialect: 'deepseek', protocol: 'responses', parameterMode: 'thinking' }), {});
});

test('profiles are fresh values and numeric output validation is deterministic', () => {
  const input = route('gpt-5.2');
  resolveModelProfile(input).efforts.push('max');
  assert.equal(isReasoningEffortSupported(input, 'max'), false);
  assert.deepEqual(modelReasoningEfforts, ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  for (const output of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => modelReasoningParameters(input, output), /正整数/);
});

test('declared levels enable arbitrary model IDs without pretending that declarations are verified', () => {
  const input = route('my-gateway/next-generation-model', { reasoningLevels: ['low', 'high', 'max'] });
  const profile = resolveModelProfile(input);
  assert.equal(profile.source, 'manual');
  assert.equal(profile.family, 'unknown');
  assert.equal(profile.dialect, 'standard');
  assert.deepEqual(profile.efforts, ['auto', 'low', 'high', 'max']);
  assert.equal('verified' in profile, false);
  assert.equal(isReasoningEffortSupported(input, 'max'), true);
  assert.equal(isReasoningEffortSupported(input, 'medium'), false);
  assert.deepEqual(modelReasoningParameters({ ...input, reasoningEffort: 'max' }, 128), { reasoning_effort: 'max' });
  assert.deepEqual(parameters('my-alias', 'minimal', { reasoningLevels: ['minimal'] }), { reasoning_effort: 'minimal' });
});

test('unknown declared models use standard Chat and Responses fields even on private dialect hosts', () => {
  for (const changes of [{}, { dialect: 'deepseek' as const }, { dialect: 'command-code' as const },
    { baseUrl: 'https://api.deepseek.com' }, { baseUrl: 'https://api.commandcode.ai/provider/v1' }]) {
    assert.deepEqual(parameters('future-alias', 'high', { ...changes, reasoningLevels: ['none', 'high'] }),
      { reasoning_effort: 'high' });
    assert.deepEqual(parameters('future-alias', 'none', { ...changes, reasoningLevels: ['none', 'high'] }),
      { reasoning_effort: 'none' });
    assert.deepEqual(parameters('future-alias', 'high', { ...changes, protocol: 'responses', reasoningLevels: ['high'] }),
      { reasoning: { effort: 'high' } });
  }
});

test('unknown declared Messages models send effort without guessing private or adaptive thinking', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const)
    assert.deepEqual(parameters('future-message-alias', effort, {
      protocol: 'messages', reasoningLevels: [effort], parameterMode: 'thinking',
    }, 128), { output_config: { effort } });
  const off = route('future-message-alias', { protocol: 'messages', reasoningLevels: ['none'], reasoningEffort: 'none' });
  assert.match(modelReasoningError(off) ?? '', /Messages.*none.*disabled/);
  assert.equal(isReasoningEffortSupported(off, 'none'), false);
  assert.throws(() => modelReasoningParameters(off, 128), /Messages.*none.*disabled/);
  assert.equal(modelReasoningError({ ...off, reasoningEffort: 'auto' }, 128), undefined);
  assert.deepEqual(modelReasoningParameters({ ...off, reasoningEffort: 'auto' }, 128), {});
  const minimal = route('future-message-alias', { protocol: 'messages', reasoningLevels: ['minimal'], reasoningEffort: 'minimal' });
  assert.match(modelReasoningError(minimal) ?? '', /Messages.*minimal/);
  assert.equal(isReasoningEffortSupported(minimal, 'minimal'), false);
  assert.throws(() => modelReasoningParameters(minimal, 2048), /Messages.*minimal/);
});

test('empty declarations override fallback knowledge and auto never injects an explicit declared level', () => {
  for (const id of ['new-alias', 'gpt-5.2', 'deepseek-v4-flash', 'claude-opus-4-6']) {
    const input = route(id, { reasoningLevels: [], reasoningEffort: 'auto', parameterMode: 'thinking' });
    assert.deepEqual(resolveModelProfile(input).efforts, ['auto']);
    assert.equal(resolveModelProfile(input).source, 'manual');
    assert.deepEqual(modelReasoningParameters(input, 128), {});
    assert.equal(isReasoningEffortSupported(input, 'none'), false);
    assert.throws(() => modelReasoningParameters({ ...input, reasoningEffort: 'high' }, 128), RangeError);
  }
  for (const protocol of ['chat-completions', 'responses', 'messages'] as const)
    assert.deepEqual(parameters('future-model', 'auto', { protocol, reasoningLevels: ['high'], parameterMode: 'thinking' }), {});
});

test('declared levels override stale static ladders while known native encodings and budgets remain intact', () => {
  assert.deepEqual(parameters('gpt-5.2', 'max', { reasoningLevels: ['max'] }), { reasoning_effort: 'max' });
  assert.deepEqual(parameters('claude-opus-4-6', 'max', { protocol: 'messages', reasoningLevels: ['high', 'max'] }, 128),
    { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } });
  assert.deepEqual(parameters('deepseek-v4-flash', 'max', { reasoningLevels: ['max'] }),
    { thinking: { type: 'enabled' }, reasoning_effort: 'max' });
  assert.throws(() => parameters('claude-opus-4-5', 'high', { protocol: 'messages', reasoningLevels: ['high'] }, 128), /1024/);
  // A changed catalog may introduce an actual effort ladder for a previously
  // toggle-only model. The new explicit ladder uses the standard effort field.
  assert.deepEqual(parameters('qwen3-32b', 'high', { reasoningLevels: ['high'] }), { reasoning_effort: 'high' });
});

test('invalid manual declarations reject auto and malformed values; returned levels never alias caller arrays', () => {
  for (const reasoningLevels of [['auto'], ['high', 'auto'], ['invented'], [null], 'high', null] as unknown[])
    assert.throws(() => modelReasoningParameters(route('alias', {
      reasoningLevels: reasoningLevels as ReasoningEffort[], reasoningEffort: 'auto',
    }), 128), /声明.*auto/);
  const levels: ReasoningEffort[] = ['high', 'high', 'none'];
  const input = route('alias', { reasoningLevels: levels });
  assert.deepEqual(resolveModelProfile(input).efforts, ['auto', 'high', 'none']);
  resolveModelProfile(input).efforts.push('max');
  assert.deepEqual(levels, ['high', 'high', 'none']);
  assert.equal(isReasoningEffortSupported(input, 'max'), false);
});

test('metadata declarations alone do not change legacy requests with no selected effort', () => {
  assert.deepEqual(modelReasoningParameters(route('alias', { reasoningLevels: ['high'] }), 128), {});
  assert.deepEqual(modelReasoningParameters(route('alias', {
    dialect: 'deepseek', parameterMode: 'thinking', reasoningLevels: ['high'], protocol: 'responses',
  }), 128), { reasoning: { effort: 'high' } });
});

test('OpenRouter uses its documented unified effort object, with levels declared independently of model names', () => {
  for (const modelId of ['deepseek/deepseek-v4.1-flash', 'anthropic/claude-opus-4.6', 'openai/gpt-5.2', 'future/alias']) {
    for (const protocol of ['chat-completions', 'responses'] as const) {
      const input = route(modelId, { protocol, baseUrl: 'https://openrouter.ai/api/v1', reasoningEffort: 'auto' });
      const profile = resolveModelProfile(input);
      assert.equal(profile.source, 'unknown');
      assert.equal(profile.dialect, 'standard');
      assert.deepEqual(profile.efforts, ['auto']);
      assert.deepEqual(modelReasoningParameters(input, 128), {});
      assert.match(modelReasoningError({ ...input, reasoningEffort: 'high' }) ?? '', /不支持/);
      for (const effort of ['none', 'low', 'high', 'max'] as const)
        assert.deepEqual(modelReasoningParameters({ ...input, reasoningEffort: effort, reasoningLevels: [effort] }, 128),
          { reasoning: { effort } });
    }
  }
  assert.equal(resolveModelProfile(route('deepseek-flash', { baseUrl: 'https://OPENROUTER.AI:443/api/v1' })).encoding, 'openrouter');
  assert.equal(resolveModelProfile(route('alias', { baseUrl: 'https://openrouter.ai.evil.example/api/v1', reasoningLevels: ['high'] })).encoding, 'openai');
});

test('an unconfirmed relay never inherits DeepSeek private thinking fields merely from a model ID', () => {
  for (const baseUrl of ['https://relay.example/v1', 'https://api.commandcode.ai/provider/v1', 'https://api.deepseek.com.evil.example/v1']) {
    for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
      const input = route('deepseek/deepseek-v4.1-flash', { baseUrl, protocol });
      assert.equal(resolveModelProfile(input).source, 'unknown');
      assert.deepEqual(resolveModelProfile(input).efforts, ['auto']);
      assert.equal(isReasoningEffortSupported(input, 'high'), false);
      assert.deepEqual(modelReasoningParameters({ ...input, reasoningEffort: 'auto', parameterMode: 'thinking' }, 128), {});
      assert.deepEqual(modelReasoningParameters({ ...input, reasoningEffort: 'high', reasoningLevels: ['high'] }, 128),
        protocol === 'chat-completions' ? { reasoning_effort: 'high' }
          : protocol === 'responses' ? { reasoning: { effort: 'high' } } : { output_config: { effort: 'high' } });
    }
  }
  // Explicit old dialect settings keep their original wire even on a custom URL.
  assert.deepEqual(modelReasoningParameters(route('deepseek-flash', { baseUrl: 'https://relay.example/v1',
    dialect: 'deepseek', parameterMode: 'thinking' }), 128), { thinking: { type: 'enabled' } });
});
