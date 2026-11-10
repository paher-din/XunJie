import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { createSpaces, createCourses, createLearningEntry, spaceCourseMigrations } from '@xunjie/learning-space';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

test('member permissions persist, constrain HTTP authority and revoke existing credentials', { timeout: 120000 }, async () => {
  const pg = await nativeFixture();
  let storage, server;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const old = spaceCourseMigrations.slice(0, -1);
    const config = { admin: pg.admin, owner, password: randomUUID() };
    const binding = await provisionStorage({ ...config, migrations: old });
    const backend = createFileBackend({ id: 'space', root: pg.root + '/files' });
    storage = await openStorage({ binding, migrations: old, backend });
    await storage.participant().closeWrites();
    await storage.participant().closeDispatch();
    await storage.close();
    storage = undefined;
    await provisionStorage({ ...config, migrations: spaceCourseMigrations });
    const storageOptions = { binding, migrations: spaceCourseMigrations, backend };
    storage = await openStorage(storageOptions);
    await storage.participant().resume();
    let spaces = createSpaces(storage);
    const password = randomUUID();
    const actor = await spaces.createMember({ requestId: randomUUID(), loginName: 'teacher', password });
    const other = await spaces.createMember({ requestId: randomUUID(), loginName: 'student', password });
    const session = await spaces.login('teacher', password);
    const studentSession = await spaces.login('student', password);
    const target = { ...owner, version: 1 };
    await spaces.bindMember(actor, target);
    const connectionId = randomUUID(), verifier = randomUUID() + randomUUID();
    await spaces.beginConnection({ requestId: connectionId, clientId: randomUUID(), challenge: createHash('sha256').update(verifier).digest('base64url') });
    await spaces.approveConnection(session.token, connectionId);
    const connection = await spaces.exchangeConnection(connectionId, verifier);
    const permission = enabled => ({ requestId: randomUUID(), principalId: actor.principalId, permission: 'course.manage', enabled });
    assert.equal(await spaces.hasMemberPermission(actor, 'course.manage'), false);
    await spaces.setMemberPermission(permission(true));
    await storage.close();
    storage = await openStorage(storageOptions);
    spaces = createSpaces(storage);
    assert.equal(await spaces.hasMemberPermission(actor, 'course.manage'), true);
    assert.equal(await spaces.hasMemberPermission(other, 'course.manage'), false);
    let designInput, setupIdentity;
    const environment = { environmentId: owner.environmentId, profile: 'school', services: [{ endpoint: 'http://127.0.0.1' }] };
    const entry = createLearningEntry({ environment, target, spaces, courses: createCourses(storage, spaces), administratorToken: 'admin',
      courseExecutionDesign: async (_operation, body) => { designInput = body; return { ok: true }; },
      deviceSetup: async (identity, body) => { setupIdentity = identity; return { connectionId: body.connectionId }; } });
    server = createServer((req, res) => { void entry(req, res); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/learning/`;
    const cookie = token => ({ cookie: `xj_${owner.environmentId.replaceAll('-', '')}=${token}` });
    const bearer = token => ({ authorization: `Bearer ${token}` });
    const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    for (const headers of [cookie(session.token), bearer(connection.token)]) {
      assert.equal((await post('manage/course-execution-compile', { input: {} }, headers)).status, 200);
      assert.deepEqual(designInput.identity, actor);
      assert.equal((await post('manage/course-execution-compile', { identity: other, input: {} }, headers)).status, 403);
      assert.equal((await post('manage/course-catalog', {}, headers)).status, 200);
      for (const path of ['members', 'membership', 'member-permissions', 'connection', 'model-default', 'agent-binding']) {
        assert.equal((await post('manage/' + path, {}, headers)).status, 403, path);
      }
    }
    assert.equal((await post('manage/course-catalog', {}, cookie(studentSession.token))).status, 403);
    assert.equal((await post('manage/member-permissions', permission(true), bearer('admin'))).status, 200);
    const adminDesign = { identity: other, input: {} };
    assert.equal((await post('manage/course-execution-compile', adminDesign, bearer('admin'))).status, 200);
    assert.deepEqual(designInput, adminDesign);
    assert.equal((await post('connections/device-setup', { connectionId }, bearer(connection.token))).status, 200);
    assert.deepEqual(setupIdentity, actor);
    assert.equal((await post('connections/device-setup', { connectionId: randomUUID() }, bearer(connection.token))).status, 403);
    assert.equal((await post('connections/device-setup', { connectionId }, cookie(session.token))).status, 403);
    async function exchange(memberSession) {
      const requestId = randomUUID(), proof = randomUUID() + randomUUID();
      await spaces.beginConnection({ requestId, clientId: randomUUID(), challenge: createHash('sha256').update(proof).digest('base64url') });
      await spaces.approveConnection(memberSession.token, requestId);
      const response = await post('connections/exchange', { requestId, verifier: proof });
      assert.equal(response.status, 200);
      return response.json();
    }
    assert.deepEqual((await exchange(session)).deviceSetup, { version: 1 });
    await spaces.bindMember(other, { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 });
    assert.equal((await exchange(studentSession)).deviceSetup, undefined);
    assert.equal((await post('manage/member-permissions', permission(false), bearer('admin'))).status, 200);
    assert.equal(await spaces.hasMemberPermission(actor, 'course.manage'), false);
    for (const headers of [cookie(session.token), bearer(connection.token)]) {
      assert.equal((await post('manage/course-execution-compile', { input: {} }, headers)).status, 403);
    }
    await storage.close();
    storage = await openStorage(storageOptions);
    assert.equal(await createSpaces(storage).hasMemberPermission(actor, 'course.manage'), false);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (storage) await storage.close();
    await pg.close();
  }
});
