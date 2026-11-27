import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openStorage, provisionStorage, createFileBackend } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createSpaces } from '../dist/spaces/index.js';
import { spaceCourseMigrations } from '../dist/courses/index.js';

const migrations = spaceCourseMigrations;
const challengeFor = verifier => createHash('sha256').update(verifier).digest('base64url');

test('connection status and approval distinguish missing, pending, approved, expired and foreign requests', { timeout: 60000 }, async t => {
  const pg = await nativeFixture();
  let storage;
  t.after(async () => {
    await storage?.close();
    await pg.close();
  });
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations });
  storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: 'connections', root: pg.root + '/objects' }) });
  const spaces = createSpaces(storage);
  const password = randomUUID();
  const member = await spaces.createMember({ requestId: randomUUID(), loginName: 'connection-member', password });
  const login = await spaces.login('connection-member', password);
  const otherPassword = randomUUID();
  const other = await spaces.createMember({ requestId: randomUUID(), loginName: 'other-member', password: otherPassword });
  const otherLogin = await spaces.login('other-member', otherPassword);

  assert.deepEqual(await spaces.connectionStatus(randomUUID()), { state: 'missing' });

  const requestId = randomUUID(), verifier = randomUUID() + randomUUID();
  await spaces.beginConnection({ requestId, clientId: randomUUID(), challenge: challengeFor(verifier) });
  const pending = await spaces.connectionStatus(requestId);
  assert.equal(pending.state, 'pending');
  assert.equal(Number.isNaN(Date.parse(pending.expiresAt)), false);
  await spaces.approveConnection(login.token, requestId);
  assert.equal((await spaces.connectionStatus(requestId)).state, 'approved');
  const grant = await spaces.exchangeConnection(requestId, verifier);
  assert.deepEqual(grant.identity, member);

  const foreignRequest = randomUUID(), foreignVerifier = randomUUID() + randomUUID();
  await spaces.beginConnection({ requestId: foreignRequest, clientId: randomUUID(), challenge: challengeFor(foreignVerifier) });
  await spaces.approveConnection(otherLogin.token, foreignRequest);
  await assert.rejects(spaces.approveConnection(login.token, foreignRequest), { code: 'forbidden' });
  await assert.rejects(spaces.approveConnection(login.token, randomUUID()), { code: 'missing' });
  await assert.rejects(spaces.exchangeConnection(foreignRequest, randomUUID() + randomUUID()), { code: 'forbidden' });
  await assert.rejects(spaces.exchangeConnection(randomUUID(), foreignVerifier), { code: 'missing' });

  const expiredRequest = randomUUID(), expiredVerifier = randomUUID() + randomUUID();
  await spaces.beginConnection({ requestId: expiredRequest, clientId: randomUUID(), challenge: challengeFor(expiredVerifier) });
  await storage.request({ requestId: randomUUID(), fingerprint: randomUUID() }, async tx => {
    await tx.query("UPDATE authorizations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiredRequest]);
    return null;
  });
  assert.equal((await spaces.connectionStatus(expiredRequest)).state, 'expired');
  await assert.rejects(spaces.approveConnection(login.token, expiredRequest), { code: 'expired' });
  await assert.rejects(spaces.exchangeConnection(expiredRequest, expiredVerifier), { code: 'expired' });
});
