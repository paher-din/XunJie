import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.ts';
import { registerDeploymentIdentity } from './deployment-identity.ts';

test('the running business host exposes only its immutable release identity on health routes', async () => {
  const app = createApp({ checkReady: () => {} });
  const commit = 'a'.repeat(40);
  registerDeploymentIdentity(app, { format: 'xunjie-runtime-artifact', version: 1, commit, secret: 'invalid-test-secret-placeholder' });
  try {
    for (const url of ['/health/live', '/health/ready']) {
      const response = await app.inject({ url });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['x-xunjie-version'], commit);
      assert.equal(response.headers['x-xunjie-protocol'], 'xunjie/session-v1');
      assert.ok(!JSON.stringify(response.headers).includes('secret'));
    }
    assert.equal((await app.inject({ url: '/missing' })).headers['x-xunjie-version'], undefined);
    assert.throws(() => registerDeploymentIdentity(app, { commit: 'unknown' }));
  } finally { await app.close(); }
});
