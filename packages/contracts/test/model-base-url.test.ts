import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { modelBaseUrlError, modelConfigurationSchema, saveModelConnectionSchema } from '@xunjie/contracts/model-connections';

test('model base URLs reject known composition errors and accept custom compatible prefixes without probing', () => {
  for (const baseUrl of ['https://custom.example/tenant/v2', 'http://localhost:8080/v1', 'http://127.0.0.1:8181/v1', 'http://[::1]:8181/v1'])
    assert.equal(modelBaseUrlError(baseUrl, 'chat-completions'), undefined, baseUrl);
  for (const baseUrl of ['', 'api.example.com/v1', 'https://api.example.com/v1?key=x', 'https://api.example.com/v1#path',
    'https://user:password@api.example.com/v1', 'http://example.com/v1', 'https://api.example.com/v1/chat/completions'])
    assert.ok(modelBaseUrlError(baseUrl, 'chat-completions'), baseUrl);
  assert.ok(modelBaseUrlError('https://api.example.com/v1/responses/', 'responses'));
  assert.ok(modelBaseUrlError('https://api.example.com/v1/messages', 'messages'));
  assert.ok(modelBaseUrlError('https://api.example.com/v1/', 'messages'));
  assert.equal(modelBaseUrlError('https://api.example.com/custom', 'messages'), undefined);
});

test('invalid saved routes remain readable for repair while new writes reject duplicate protocol suffixes', () => {
  const configuration = { connectionId: randomUUID(), name: 'Fixture', protocol: 'messages', baseUrl: 'https://api.example.com/v1',
    path: '/v1/messages', modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true };
  assert.equal(modelConfigurationSchema.safeParse(configuration).success, true);
  assert.equal(saveModelConnectionSchema.safeParse({ ...configuration, requestId: randomUUID(), expectedVersion: 0,
    credential: { action: 'clear' } }).success, false);
});
