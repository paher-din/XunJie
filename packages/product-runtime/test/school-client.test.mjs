import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime';

test('revoking a school connection wins over an already exchanged but delayed confirmation', { timeout: 30000 }, async () => {
  const requestId = randomUUID();
  const grant = { connectionId: requestId, token: randomUUID() + randomUUID(),
    identity: { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校空间' },
    target: { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 }, capabilities: ['activity:read', 'activity:write'] };
  let exchangeCount = 0;
  let release;
  let admitted;
  const held = new Promise(resolve => { release = resolve; });
  const exchanging = new Promise(resolve => { admitted = resolve; });
  // Only the remote school boundary is controlled: exercise the real installed client HTTP surface.
  const school = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/connections/exchange')) {
      if (++exchangeCount === 2) { admitted(); await held; }
      response.end(JSON.stringify(grant));
    } else response.end(JSON.stringify({ revoked: true }));
  });
  await new Promise(resolve => school.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-client-revocation-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) } });
  let host;
  try {
    await runtime.install({ profile: 'remote' });
    host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
    const api = (path, body) => fetch(new URL('/api/learning/' + path, host.endpoint), {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'content-type': 'application/json' },
    });
    assert.equal((await api('client/start', { requestId, schoolEndpoint: `http://127.0.0.1:${school.address().port}` })).status, 200);
    assert.equal((await api('client/complete', { requestId })).status, 200);
    const completing = api('client/complete', { requestId });
    await exchanging;
    const revoked = await fetch(new URL('/api/learning/connections/revoke', host.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xj-space': 'school:' + requestId }, body: JSON.stringify({ connectionId: requestId }) });
    assert.equal(revoked.status, 200);
    release();
    await completing;
    const context = await (await api('context')).json();
    assert.deepEqual(context.identities, [], 'a delayed grant must not reappear after successful revocation');
    assert.equal((await api('client/complete', { requestId })).status, 403);
  } finally {
    release();
    await host?.stop();
    school.closeAllConnections();
    await new Promise(resolve => school.close(resolve));
  }
});
