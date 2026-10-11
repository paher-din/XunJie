import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';

test('liveness responds without claiming that teaching dependencies are ready', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.data, { status: 'alive' });
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(response.headers['x-request-id'], body.requestId);
});

test('readiness stays unavailable while database, model and runner are not implemented', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(response.statusCode, 503);
  const body = response.json();
  assert.equal(body.error.code, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(body.error.retryable, false);
  assert.equal(typeof body.error.recovery, 'string');
  assert.equal(response.headers['x-request-id'], body.requestId);
});

test('each response uses a new server request ID even when the client supplies one', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const first = await app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': 'SYNTHETIC_SECRET' } });
  const second = await app.inject({ method: 'GET', url: '/missing', headers: { 'x-request-id': first.json().requestId } });
  assert.notEqual(first.json().requestId, 'SYNTHETIC_SECRET');
  assert.notEqual(second.json().requestId, first.json().requestId);
  assert.equal(second.headers['x-request-id'], second.json().requestId);
  assert.equal(first.body.includes('SYNTHETIC_SECRET'), false);
});
