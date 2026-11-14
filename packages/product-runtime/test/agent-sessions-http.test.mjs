import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createLearningEntry } from '../dist/learning-http/index.js';

test('the product HTTP boundary rejects old Agent contracts and authenticates a connected subject before session routing', async t => {
  let entry, forwarded = 0, selected = 0;
  const server = createServer((request, response) => void entry(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`, connectionId = randomUUID();
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '当前学校学生' };
  const environment = { environmentId: randomUUID(), installationId: randomUUID(), clientNamespace: randomUUID(), profile: 'local',
    services: [{ endpoint }] };
  const client = { async list() { return [{ key: 'school:' + connectionId, identity }]; }, async account() { return null; },
    async start() {}, async complete() {}, async forward() { forwarded++; return { wrongOwner: true }; } };
  const headers = { 'x-xj-space': 'school:' + connectionId, 'x-xj-expected-subject': [identity.environmentId, identity.spaceId, identity.principalId].join('.') };
  entry = createLearningEntry({ environment, administratorToken: 'synthetic-control', client });
  const old = await fetch(endpoint + '/api/learning/agent-sessions', { headers: { ...headers, 'x-xj-agent-contract': '1' } });
  assert.deepEqual(await old.json(), { error: 'incompatible' });
  assert.equal(forwarded, 0);
  entry = createLearningEntry({ environment, administratorToken: 'synthetic-control', client, async agentSessions(who) {
    assert.deepEqual(who, identity); selected++;
    return { sessions: { async list() { return []; } } };
  } });
  const wrong = await fetch(endpoint + '/api/learning/agent-sessions', { headers: { ...headers,
    'x-xj-agent-contract': '2', 'x-xj-expected-subject': randomUUID() } });
  assert.equal(wrong.status, 403);
  assert.equal(selected, 0);
  const current = await fetch(endpoint + '/api/learning/agent-sessions', { headers: { ...headers, 'x-xj-agent-contract': '2' } });
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), { items: [] });
  assert.equal(selected, 1);
  assert.equal(forwarded, 0);
});
