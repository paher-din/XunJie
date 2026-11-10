import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { createSpaces, createLearningData, createLearningEntry, spaceCourseMigrations, learningMigrations } from '@xunjie/learning-space';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

test('connection profile refresh uses only the live bearer, and transfer refusal never freezes an explicit topology', { timeout: 120000 }, async () => {
  const pg = await nativeFixture();
  let space, data, server;
  try {
    const environmentId = randomUUID(), storages = [];
    for (const [unit, migrations] of [['space-course', spaceCourseMigrations], ['learning-data', learningMigrations]]) {
      const owner = { environmentId, serviceId: randomUUID() };
      const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations });
      storages.push(await openStorage({ binding, migrations,
        backend: createFileBackend({ id: unit, root: join(pg.root, unit) }) }));
    }
    [space, data] = storages;
    const spaces = createSpaces(space), learning = createLearningData(data, spaces), target = { ...data.owner, version: 1 };
    const password = randomUUID(), identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'profile-member', password });
    await spaces.bindMember(identity, target);
    const session = await spaces.login('profile-member', password);
    const requestId = randomUUID(), verifier = randomBytes(48).toString('base64url');
    await spaces.beginConnection({ requestId, clientId: randomUUID(), challenge: createHash('sha256').update(verifier).digest('base64url') });
    await spaces.approveConnection(session.token, requestId);
    const grant = await spaces.exchangeConnection(requestId, verifier), bearer = { authorization: 'Bearer ' + grant.token };
    let allowed = false;
    const environment = { environmentId, profile: 'school', services: [{ endpoint: 'http://127.0.0.1' }] };
    const entry = createLearningEntry({ environment, target, spaces, learning, administratorToken: 'unused-test-control',
      localStudyAllowed: async actor => { await spaces.authorize(actor); return allowed; } });
    server = createServer((req, res) => { void entry(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const api = async (route, body, headers = bearer, status = 200) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/learning/` + route, {
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const result = await response.json();
      assert.equal(response.status, status, route + ': ' + JSON.stringify(result)); return result;
    };
    // Advance only the initial authorization's clock. The already-approved connection has its own lifetime.
    await space.request({ requestId: randomUUID(), fingerprint: 'expire-initial-authorization' }, async tx => {
      await tx.query("UPDATE authorizations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [requestId]); return null;
    });
    await api('connections/exchange', { requestId, verifier }, {}, 403);
    await space.participant().closeWrites(); await space.participant().closeDispatch();
    await data.participant().closeWrites(); await data.participant().closeDispatch();
    const profile = await api('connections/profile');
    assert.equal(profile.version, 1); assert.equal(profile.localStudy, false);
    assert.equal(profile.connectionId, requestId); assert.deepEqual(profile.target, target);
    assert.equal(JSON.stringify(profile).includes(grant.token), false);
    assert.deepEqual(await api('connections/profile'), profile, 'refresh is read-only even with every write gate closed');
    await api('connections/profile', undefined, {}, 403);
    await api('connections/profile', undefined, { authorization: 'Bearer ' + session.token }, 403);
    await space.participant().resume(); await data.participant().resume();
    await api('study-transfer', undefined, bearer, 403);
    const activity = await learning.create(identity, { requestId: randomUUID(), goal: 'Not frozen by refused transfer', question: '', references: [] });
    assert.equal(activity.status, 'open');
    // Once an authorized transfer has frozen this scope, ACK remains bound to the original digest,
    // independent of a subsequent profile change. It cannot select or widen a cleanup scope.
    allowed = true;
    const transfer = await api('study-transfer');
    allowed = false;
    await api('study-transfer/ack', { digest: 'f'.repeat(64) }, bearer, 409);
    const ack = await api('study-transfer/ack', { digest: transfer.digest });
    assert.equal(ack.state, 'acknowledged');
    assert.deepEqual(await api('study-transfer/ack', { digest: transfer.digest }), ack);
    await spaces.revokeConnection(identity, requestId);
    await api('connections/profile', undefined, bearer, 403);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await data?.close(); await space?.close(); await pg.close();
  }
});
