import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSchoolClient } from '../dist/school-client.js';

test('school model directory uses the authenticated local owner and never sends provider credentials to the school', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-model-directory-route-'));
  const connectionId = randomUUID(), namespace = randomUUID();
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校' };
  const target = { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 };
  const upstreamPaths = [], directoryCalls = [];
  const upstream = createServer((request, response) => {
    upstreamPaths.push(request.url);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ identity, target }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(join(root, 'credentials'));
    await writeFile(join(root, 'credentials', 'school-client-' + connectionId), JSON.stringify({
      requestId: connectionId, clientId: randomUUID(), clientNamespace: namespace, verifier: randomUUID(),
      schoolEndpoint: `http://127.0.0.1:${upstream.address().port}`, grant: {
        connectionId, token: randomUUID() + randomUUID(), identity, target, capabilities: ['activity:read', 'activity:write'],
      },
    }));
    const result = { models: [], catalogue: { status: 'idle' } };
    const client = createSchoolClient(root, { clientNamespace: namespace }, { target,
      models: { directory: { async read(who, input) { directoryCalls.push({ who, input }); return result; } } },
    });
    const query = { presetId: 'deepseek', refresh: true, credential: { action: 'replace', value: 'synthetic-provider-key' } };
    assert.deepEqual(await client.forward(connectionId, 'models/directory', query), result);
    assert.deepEqual(directoryCalls, [{ who: identity, input: query }]);
    assert.deepEqual(upstreamPaths, ['/api/learning/access']);
    await assert.rejects(client.forward(connectionId, 'models/directory', query, 'foreign-subject'), { code: 'forbidden' });
    await assert.rejects(client.forward(connectionId, 'models/directory/admin', query), { code: 'forbidden' });
    assert.equal(directoryCalls.length, 1);
  } finally {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
