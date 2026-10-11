import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { ApiError } from '../server/app/errors.ts';

test('malformed JSON returns a safe format error rather than an internal failure', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  app.post('/test-json', async () => ({ ok: true }));
  const response = await app.inject({
    method: 'POST', url: '/test-json',
    headers: { 'content-type': 'application/json', cookie: 'session=SYNTHETIC_SECRET' },
    payload: '{"question":"SYNTHETIC_PRIVATE_TEXT",',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'INVALID_REQUEST');
  assert.equal(response.body.includes('SYNTHETIC_PRIVATE_TEXT'), false);
  assert.equal(response.body.includes('SYNTHETIC_SECRET'), false);
  assert.equal(response.headers['x-request-id'], response.json().requestId);
});

test('oversized input is rejected with CONTENT_LIMIT without exposing content', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  app.post('/test-limit', { bodyLimit: 32 }, async () => ({ ok: true }));
  const response = await app.inject({
    method: 'POST', url: '/test-limit',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ question: 'SYNTHETIC_PRIVATE_TEXT'.repeat(5) }),
  });
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, 'CONTENT_LIMIT');
  assert.equal(response.body.includes('SYNTHETIC_PRIVATE_TEXT'), false);
});

test('unknown routes return the common error envelope without reflecting the URL', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/SYNTHETIC_PRIVATE_PATH?token=SYNTHETIC_SECRET' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'INVALID_REQUEST');
  assert.equal(response.body.includes('SYNTHETIC_PRIVATE_PATH'), false);
  assert.equal(response.body.includes('SYNTHETIC_SECRET'), false);
});

test('unexpected failures produce only sanitized diagnostics and do not expose exception or request data', async (t) => {
  const lines: string[] = [];
  const app = createApp({ logDestination: { write(line: string) { lines.push(line); } } });
  t.after(() => app.close());
  app.post('/SYNTHETIC_PRIVATE_PATH', async () => {
    throw Object.assign(new Error('SYNTHETIC_SECRET at C:/private/teacher-answer.txt'), { statusCode: 401 });
  });
  const response = await app.inject({
    method: 'POST', url: '/SYNTHETIC_PRIVATE_PATH?token=SYNTHETIC_SECRET',
    headers: { cookie: 'session=SYNTHETIC_SECRET', authorization: 'Bearer SYNTHETIC_SECRET' },
    payload: { question: 'SYNTHETIC_PRIVATE_TEXT' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(response.json().error.retryable, false);
  assert.equal(lines.length, 1);
  const diagnostic = JSON.parse(lines[0]!);
  assert.equal(diagnostic.requestId, response.json().requestId);
  assert.equal(diagnostic.errorCode, 'DEPENDENCY_UNAVAILABLE');
  for (const canary of ['SYNTHETIC_SECRET', 'SYNTHETIC_PRIVATE_PATH', 'SYNTHETIC_PRIVATE_TEXT', 'teacher-answer.txt']) {
    assert.equal(response.body.includes(canary), false);
    assert.equal(lines.join('').includes(canary), false);
  }
});

test('unsupported media types and trusted schema validation use safe INVALID_REQUEST errors', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  app.post('/test-schema', {
    schema: { body: { type: 'object', required: ['question'], properties: { question: { type: 'string' } }, additionalProperties: false } },
  }, async (request) => ({ requestId: request.id, data: request.body }));
  const media = await app.inject({
    method: 'POST', url: '/test-schema',
    headers: { 'content-type': 'application/octet-stream' }, payload: 'SYNTHETIC_PRIVATE_TEXT',
  });
  assert.equal(media.statusCode, 400);
  assert.equal(media.json().error.code, 'INVALID_REQUEST');
  const invalid = await app.inject({ method: 'POST', url: '/test-schema', payload: { question: 'hello', role: 'teacher' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'INVALID_REQUEST');
});

test('domain conflicts retain their status and require explicit authorized re-reading', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  app.post('/test-conflict', async () => { throw new ApiError('VERSION_CONFLICT'); });
  const response = await app.inject({ method: 'POST', url: '/test-conflict' });
  const body = response.json();
  assert.equal(response.statusCode, 409);
  assert.equal(body.error.code, 'VERSION_CONFLICT');
  assert.equal(body.error.retryable, false);
  assert.match(body.error.recovery, /current authorized version/);
  assert.equal(response.headers['x-request-id'], body.requestId);
});
