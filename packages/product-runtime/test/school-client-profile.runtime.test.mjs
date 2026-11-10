import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };

for (const mode of ['explicit-remote', 'legacy', 'unknown-version', 'unavailable', 'foreign-profile', 'denied-setup'])
  test(`installed client keeps the original owners until the school authorizes local study: ${mode}`, { timeout: 120000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'xj-client-profile-'));
    const runtime = openProductRuntime({ root, resources });
    const connectionId = randomUUID(), identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'School' };
    const target = { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 };
    const profile = { version: 1, localStudy: false, connectionId, identity, target,
      account: { accountName: 'student', schoolName: 'School' } };
    const grant = { token: randomUUID() + randomUUID(), identity, target, connectionId, capabilities: ['activity:read', 'activity:write'],
      // This legacy hint alone must not authorize migration on clients with a local database.
      localStudy: { version: 1 }, ...(mode === 'explicit-remote' || mode === 'denied-setup' ? { profile } : {}),
      ...(mode === 'denied-setup' ? { deviceSetup: { version: 1 } } : {}) };
    const activity = { activityId: randomUUID(), identity, target, goal: 'Original remote owner', question: '', references: [],
      status: 'open', createdAt: new Date().toISOString() };
    let exchanges = 0, profiles = 0, transfers = 0, setups = 0, receivedBearer = false;
    const school = createServer(async (request, response) => {
      for await (const _ of request) { /* Never log credential or member request bodies. */ }
      response.setHeader('content-type', 'application/json');
      const route = request.url.slice('/api/learning/'.length);
      if (route === 'connections/start') response.end(JSON.stringify({ requestId: connectionId }));
      else if (route === 'connections/exchange') {
        exchanges++;
        if (exchanges > 1) { response.writeHead(403); response.end(JSON.stringify({ error: 'forbidden' })); }
        else response.end(JSON.stringify(grant));
      } else if (route === 'connections/profile') {
        profiles++; receivedBearer = request.headers.authorization === 'Bearer ' + grant.token;
        if (mode === 'unavailable') { response.writeHead(404); response.end(JSON.stringify({ error: 'missing' })); }
        else response.end(JSON.stringify({ ...profile, ...(mode === 'unknown-version' ? { version: 2, localStudy: true } : {}),
          ...(mode === 'foreign-profile' ? { identity: { ...identity, principalId: randomUUID() } } : {}) }));
      } else if (route === 'connections/device-setup') {
        setups++; response.writeHead(403); response.end(JSON.stringify({ error: 'forbidden' }));
      } else if (route === 'study-transfer') {
        transfers++; response.writeHead(503); response.end(JSON.stringify({ error: 'unavailable' }));
      } else if (route === 'activities') response.end(JSON.stringify(request.method === 'GET' ? [activity] : activity));
      else if (route === 'account') response.end(JSON.stringify(profile.account));
      else { response.writeHead(404); response.end(JSON.stringify({ error: 'missing' })); }
    });
    await new Promise(resolve => school.listen(0, '127.0.0.1', resolve));
    try {
      await runtime.install({ profile: 'local', deployment: { formatVersion: 1,
        modules: ['space-course', 'learning-data', 'teaching-agent', 'model-connection', 'tool-execution'], dependencies: {} } });
      const state = await runtime.start();
      const api = async (route, body, headers = {}, status = 200) => {
        const response = await fetch(state.endpoint + '/api/learning/' + route, {
          headers: { 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
        const value = await response.json(); assert.equal(response.status, status, route + ': ' + JSON.stringify(value)); return value;
      };
      await api('client/start', { requestId: connectionId, schoolEndpoint: `http://127.0.0.1:${school.address().port}` });
      await api('client/complete', { requestId: connectionId });
      const headers = { 'x-xj-space': 'school:' + connectionId };
      if (mode === 'foreign-profile') await api('activities', undefined, headers, 409);
      else {
        assert.deepEqual(await api('activities', undefined, headers), [activity]);
        assert.deepEqual(await api('activities', { requestId: randomUUID(), goal: 'Continue at the original owner', question: '', references: [] }, headers), activity);
      }
      assert.equal(exchanges, 1, 'profile refresh cannot use an expired exchange challenge');
      assert.equal(transfers, 0, 'no unconfirmed mode may freeze or export school learning data');
      assert.equal(setups, 0, 'a denied or unconfirmed mode must not replace the original Agent owner');
      if (mode === 'explicit-remote' || mode === 'denied-setup') assert.equal(profiles, 0);
      else { assert.ok(profiles >= 1); assert.equal(receivedBearer, true); }
      if (mode === 'legacy') {
        assert.equal(profiles, 1, 'a confirmed decision is durably retained');
        const stored = JSON.parse(await resolveCredential(root, 'school-client-' + connectionId));
        assert.deepEqual(stored.grant.profile, profile);
        assert.equal(stored.localStudy, undefined);
      }
    } finally {
      await runtime.stop(); school.closeAllConnections(); await new Promise(resolve => school.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
