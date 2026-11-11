import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseModelTokenCount, modelTokenCountError, formatModelTokenCount, resolveModelCapacity,
  modelConfigurationSchema, providerModelInputSchema, modelCheckPolicySchema } from '@xunjie/contracts/model-connections';

test('token counts accept literal integers and binary K/M suffixes without case sensitivity', () => {
  for (const [input, expected] of [
    ['262144', 262144], ['256K', 262144], ['256k', 262144], ['64K', 65536], ['64k', 65536],
    ['1M', 1048576], ['1m', 1048576], ['1.5M', 1572864], ['0.25m', 262144], ['0.5k', 512], [' 256 K ', 262144],
  ] as const) assert.equal(parseModelTokenCount(input), expected, input);
  for (const value of [262144, 65536, 1048576, 393216, 100000])
    assert.equal(parseModelTokenCount(formatModelTokenCount(value)), value);
});

test('empty fields are absent; malformed, fractional-token and oversized counts cannot silently become defaults', () => {
  for (const input of ['', '   ', undefined]) assert.equal(parseModelTokenCount(input), undefined);
  for (const input of ['0', '-64K', '1e6', '256KB', '1,024', 'NaN', 'Infinity', '1.1', '0.1K', '1.0000000000000001', '9007199254740993']) {
    assert.equal(parseModelTokenCount(input), null, input);
    assert.ok(modelTokenCountError(input), input);
  }
  assert.equal(modelTokenCountError('1M'), undefined);
  assert.ok(modelTokenCountError('10M'));
});

test('capacities choose user input first, then model metadata, then 256K/64K per missing field', () => {
  assert.deepEqual(resolveModelCapacity({}), { contextWindow: 262144, maxOutputTokens: 65536 });
  assert.deepEqual(resolveModelCapacity({}, { contextWindow: 1048576, maxOutputTokens: 393216 }),
    { contextWindow: 1048576, maxOutputTokens: 393216 });
  assert.deepEqual(resolveModelCapacity({ contextWindow: 524288 }, { contextWindow: 1048576 }),
    { contextWindow: 524288, maxOutputTokens: 65536 });
  assert.deepEqual(resolveModelCapacity({ maxOutputTokens: 16384 }, { contextWindow: 1048576, maxOutputTokens: 393216 }),
    { contextWindow: 1048576, maxOutputTokens: 16384 });
});

test('saved model contracts accept 1M output while keeping the wire strictly numeric', () => {
  const model = { connectionId: randomUUID(), expectedVersion: 0, modelId: 'custom-model', enabled: true,
    contextWindow: 2097152, maxOutputTokens: 1048576 };
  assert.equal(providerModelInputSchema.safeParse(model).success, true);
  assert.equal(modelConfigurationSchema.safeParse({ ...model, expectedVersion: undefined,
    name: 'Fixture', protocol: 'chat-completions', baseUrl: 'https://example.invalid/v1', path: '/chat/completions',
    dialect: 'standard', parameterMode: 'plain' }).success, false, 'unknown wire fields are still rejected');
  const { expectedVersion: _version, ...configuration } = model;
  assert.equal(modelConfigurationSchema.safeParse({ ...configuration,
    name: 'Fixture', protocol: 'chat-completions', baseUrl: 'https://example.invalid/v1', path: '/chat/completions',
    dialect: 'standard', parameterMode: 'plain' }).success, true);
  assert.equal(providerModelInputSchema.safeParse({ ...model, maxOutputTokens: '1M' }).success, false);
});

test('test policies can authorize actual configured output and 120 seconds while retaining explicit smaller policies', () => {
  const policy = { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 1048576, timeoutMs: 120000 };
  assert.deepEqual(modelCheckPolicySchema.parse(policy), policy);
  assert.equal(modelCheckPolicySchema.parse({ ...policy, maxOutputTokens: 128, timeoutMs: 20000 }).maxOutputTokens, 128);
  assert.equal(modelCheckPolicySchema.safeParse({ ...policy, maxOutputTokens: 10000001 }).success, false);
  assert.equal(modelCheckPolicySchema.safeParse({ ...policy, timeoutMs: 120001 }).success, false);
});
