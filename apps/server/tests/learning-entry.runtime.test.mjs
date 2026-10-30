import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { provisionStorage, openStorage, createFileBackend } from '@xunjie/storage';
import { spaceMigrations, createSpaces } from '../server/spaces/index.ts';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to a complete native PostgreSQL 18.6 distribution.');

test('space identity persists and authorization follows current membership', { timeout: 300000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-spaces-'));
  const runtime = openProductRuntime({ root, resources: {
    nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
    postgresBin,
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)),
  } });
  let storage;
  let installedSuccessfully = false;
  try {
    const installed = await runtime.install({ profile: 'local' });
    installedSuccessfully = true;
    await runtime.start();
    const { credentialRef, ...connection } = await runtime.database();
    const binding = await provisionStorage({ admin: { ...connection, password: await resolveCredential(root, credentialRef) },
      owner: { environmentId: installed.environment.environmentId, serviceId: randomUUID() },
      password: randomUUID(), migrations: spaceMigrations });
    const options = { binding, migrations: spaceMigrations, backend: createFileBackend({ id: 'spaces', root: join(root, 'files') }) };
    storage = await openStorage(options);
    const spaces = createSpaces(storage);
    const identity = await spaces.personal();
    assert.equal(identity.kind, 'personal');
    await t.test('device profiles cannot expose an anonymous personal identity on a shared listener', async () => {
      const sharedRoot = await mkdtemp(join(tmpdir(), 'xunjie-device-listener-'));
      const shared = openProductRuntime({ root: sharedRoot, resources: {
        nodePath: process.execPath, nodeVersion: '24.21.0',
        webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
      } });
      await assert.rejects(shared.install({ profile: 'local', database: { mode: 'none' }, host: '0.0.0.0',
        publicEndpoint: 'https://school.invalid:443', tls: { certificateFile: 'unused.pem', keyFile: 'unused.key' } }), /loopback/);
    });
    await storage.close();
    storage = await openStorage(options);
    assert.deepEqual(await createSpaces(storage).personal(), identity);
    await t.test('school login is real and membership revocation invalidates existing sessions', async () => {
      const school = createSpaces(storage);
      const password = randomUUID();
      const member = await school.createMember({ requestId: randomUUID(), loginName: 'student-a', password });
      await assert.rejects(school.login('student-a', randomUUID()), { code: 'forbidden' });
      const session = await school.login('student-a', password);
      assert.deepEqual(await school.authenticate(session.token), member);
      await school.setMembership({ requestId: randomUUID(), principalId: member.principalId, active: false });
      await assert.rejects(school.authenticate(session.token), { code: 'forbidden' });
      await school.setMembership({ requestId: randomUUID(), principalId: member.principalId, active: true });
      await assert.rejects(school.authenticate(session.token), { code: 'forbidden' });
      assert.deepEqual((await school.login('student-a', password)).identity, member);
    });
    await t.test('independent learning owner creates one course-free activity and rejects other members', async () => {
      const { learningMigrations, createLearningData } = await import('../server/learning-data/index.ts');
      const learningBinding = await provisionStorage({ admin: { ...connection, password: await resolveCredential(root, credentialRef) },
        owner: { environmentId: installed.environment.environmentId, serviceId: randomUUID() },
        password: randomUUID(), migrations: learningMigrations });
      const learningOptions = { binding: learningBinding, migrations: learningMigrations,
        backend: createFileBackend({ id: 'learning', root: join(root, 'learning-files') }) };
      let learningStorage = await openStorage(learningOptions);
      try {
        const authority = createSpaces(storage);
        const target = { ...learningBinding.owner, version: 1 };
        await authority.bindMember(identity, target);
        const learning = createLearningData(learningStorage, authority);
        const request = { requestId: randomUUID(), goal: '理解函数与递归', question: '', references: [] };
        const activity = await learning.create(identity, request);
        assert.equal(activity.goal, '理解函数与递归');
        assert.equal('courseId' in activity, false);
        assert.deepEqual(await learning.create(identity, request), activity);
        await assert.rejects(learning.create(identity, { ...request, goal: '改变输入' }), { code: 'identity-conflict' });
        assert.deepEqual(await learning.receipt(identity, request.requestId), activity);
        const other = await authority.createMember({ requestId: randomUUID(), loginName: 'student-b', password: randomUUID() });
        await authority.bindMember(other, target);
        await assert.rejects(learning.open(other, activity.activityId), { code: 'missing' });
        assert.deepEqual(await learning.list(other), []);
        await learning.setStatus(identity, { requestId: randomUUID(), activityId: activity.activityId, status: 'closed' });
        await learningStorage.close();
        learningStorage = await openStorage(learningOptions);
        const reopened = createLearningData(learningStorage, authority);
        assert.equal((await reopened.open(identity, activity.activityId)).status, 'closed');
        await reopened.setStatus(identity, { requestId: randomUUID(), activityId: activity.activityId, status: 'open' });
        assert.equal((await reopened.list(identity)).length, 1);
      } finally { await learningStorage.close(); }
    });
    await t.test('client proof grants are bound to the school member and independently revocable', async () => {
      const school = createSpaces(storage);
      const password = randomUUID();
      const member = await school.createMember({ requestId: randomUUID(), loginName: 'client-member', password });
      const session = await school.login('client-member', password);
      const requestId = randomUUID();
      const verifier = randomUUID() + randomUUID();
      await school.beginConnection({ requestId, clientId: randomUUID(), challenge: createHash('sha256').update(verifier).digest('base64url') });
      await assert.rejects(school.exchangeConnection(requestId, verifier), { code: 'forbidden' });
      await school.approveConnection(session.token, requestId);
      await assert.rejects(school.exchangeConnection(requestId, randomUUID() + randomUUID()), { code: 'forbidden' });
      const grant = await school.exchangeConnection(requestId, verifier);
      assert.deepEqual(grant.identity, member);
      assert.deepEqual(grant.capabilities, ['activity:read', 'activity:write']);
      await school.logout(session.token);
      await assert.rejects(school.authenticate(session.token), { code: 'forbidden' });
      assert.deepEqual(await school.authenticate(grant.token), member);
      await school.revokeConnection(member, grant.connectionId);
      await assert.rejects(school.authenticate(grant.token), { code: 'forbidden' });
      await assert.rejects(school.exchangeConnection(requestId, verifier), { code: 'forbidden' });
      const short = createSpaces(storage, { sessionLifetimeMs: 1000 });
      const expiring = await short.login('client-member', password);
      await delay(1100);
      await assert.rejects(short.authenticate(expiring.token), { code: 'forbidden' });
    });
    await t.test('production daemon exposes real learning APIs and reopens activities after restart', async t => {
      await storage.close(); storage = undefined;
      await runtime.stop();
      const started = await runtime.start();
      const endpoint = started.endpoint;
      const api = async (path, body, headers = {}) => fetch(new URL('/api/learning/' + path, endpoint), {
        method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const context = await api('context');
      assert.equal(context.status, 200);
      assert.equal((await context.json()).profile, 'local');
      const input = { requestId: randomUUID(), goal: '从正式入口开始学习', question: '', references: [] };
      const created = await api('activities', input, { 'x-xj-space': 'personal' });
      assert.equal(created.status, 200);
      const activity = await created.json();
      const password = randomUUID();
      const control = await resolveCredential(root, 'control');
      const memberResponse = await api('manage/members', { requestId: randomUUID(), loginName: 'http-student', password },
        { authorization: `Bearer ${control}` });
      assert.equal(memberResponse.status, 200);
      const logged = await api('login', { loginName: 'http-student', password });
      assert.equal(logged.status, 200);
      const cookie = logged.headers.get('set-cookie').split(';')[0];
      const unauthorized = await api('activities/' + activity.activityId, undefined, { cookie, 'x-xj-space': 'school' });
      assert.equal(unauthorized.status, 404);
      const forged = await api('activities/' + activity.activityId, undefined, { 'x-xj-space': 'school', 'x-user-id': activity.identity.principalId });
      assert.equal(forged.status, 403);
      await runtime.stop(); await runtime.start();
      const reopened = await api('activities/' + activity.activityId, undefined, { 'x-xj-space': 'personal' });
      assert.equal(reopened.status, 200);
      assert.deepEqual(await reopened.json(), activity);
      await t.test('one installed client switches personal and school using actual school-page approval', { timeout: 120000 }, async () => {
        const schoolRoot = await mkdtemp(join(tmpdir(), 'xunjie-school-'));
        const schoolRuntime = openProductRuntime({ root: schoolRoot, resources: {
          nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6', postgresBin,
          webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
          windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)),
        } });
        let schoolInstalled = false;
        let proxy;
        try {
          await schoolRuntime.install({ profile: 'school' }); schoolInstalled = true;
          const schoolEndpoint = (await schoolRuntime.start()).endpoint;
          const schoolApi = (path, body, headers = {}) => fetch(new URL('/api/learning/' + path, schoolEndpoint), {
            method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          let loseActivityReply = true;
          proxy = createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            const upstream = await fetch(new URL(request.url, schoolEndpoint), { method: request.method,
              headers: { 'content-type': 'application/json', ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) },
              ...(body.length ? { body } : {}) });
            const text = await upstream.text();
            if (loseActivityReply && request.method === 'POST' && request.url === '/api/learning/activities' && upstream.ok) {
              loseActivityReply = false;
              response.writeHead(409, { 'content-type': 'application/json' });
              response.end(JSON.stringify({ error: 'commit-unknown' }));
            } else { response.writeHead(upstream.status, { 'content-type': 'application/json' }); response.end(text); }
          });
          await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
          const proxyEndpoint = `http://127.0.0.1:${proxy.address().port}`;
          const schoolPassword = randomUUID();
          assert.equal((await schoolApi('client/start', { requestId: randomUUID(), schoolEndpoint: endpoint })).status, 403);
          assert.equal((await schoolApi('manage/members', { requestId: randomUUID(), loginName: 'school-member', password: schoolPassword },
            { authorization: `Bearer ${await resolveCredential(schoolRoot, 'control')}` })).status, 200);
          const initiated = await api('client/start', { requestId: randomUUID(), schoolEndpoint: proxyEndpoint });
          assert.equal(initiated.status, 200);
          const pending = await initiated.json();
          const schoolLogin = await schoolApi('login', { loginName: 'school-member', password: schoolPassword });
          const schoolCookie = schoolLogin.headers.get('set-cookie').split(';')[0];
          assert.equal((await schoolApi('connections/approve', { requestId: pending.requestId }, { cookie: schoolCookie })).status, 200);
          const completed = await api('client/complete', { requestId: pending.requestId });
          assert.equal(completed.status, 200);
          const connection = await completed.json();
          assert.notEqual(connection.identity.environmentId, activity.identity.environmentId);
          const schoolHeaders = { 'x-xj-space': 'school:' + connection.connectionId };
          const schoolInput = { ...input, requestId: randomUUID(), goal: '学校里的活动' };
          const schoolActivityResponse = await api('activities', schoolInput, schoolHeaders);
          assert.equal(schoolActivityResponse.status, 409);
          assert.equal((await schoolActivityResponse.json()).error, 'commit-unknown');
          const schoolActivity = await (await api('receipts/' + schoolInput.requestId, undefined, schoolHeaders)).json();
          assert.deepEqual(await (await api('activities', schoolInput, schoolHeaders)).json(), schoolActivity);
          assert.deepEqual(schoolActivity.identity, connection.identity);
          assert.equal((await api('activities/' + schoolActivity.activityId, undefined, { 'x-xj-space': 'personal' })).status, 404);
          // Revoke through the installed client: the school revokes the grant and the client drops its local copy.
          assert.equal((await api('connections/revoke', { connectionId: connection.connectionId }, schoolHeaders)).status, 200);
          assert.equal((await api('activities', undefined, schoolHeaders)).status, 403);
          assert.equal((await api('activities/' + activity.activityId, undefined, { 'x-xj-space': 'personal' })).status, 200);
          const granted = await (await api('context')).json();
          assert.equal(granted.identities.some(item => item.key.startsWith('school:')), false);
        } finally {
          if (proxy) await new Promise(resolve => proxy.close(resolve));
          if (schoolInstalled) await schoolRuntime.stop();
        }
      });
      await t.test('both production owners restore the original activity and fence old school sessions', { timeout: 180000 }, async () => {
        const { createLearningRecoveryTargets, restoreProductRecovery, recoveryDatabase } = await import('@xunjie/product-runtime');
        const targetRoot = await mkdtemp(join(tmpdir(), 'xunjie-restored-learning-'));
        const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6', postgresBin,
          webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
          windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
        const sourceEnvironment = (await runtime.status()).environment;
        const targets = createLearningRecoveryTargets({ root: targetRoot, environment: sourceEnvironment, resources,
          admin: () => recoveryDatabase(targetRoot) });
        const recoveryKey = randomBytes(32);
        await runtime.setCredential('wp02-recovery-key', recoveryKey.toString('base64'));
        const backupDirectory = await mkdtemp(join(tmpdir(), 'xunjie-learning-backups-'));
        const manifest = await runtime.recovery.backup({ directory: backupDirectory, recoveryKeyRef: 'wp02-recovery-key', leaveClosed: true });
        assert.equal(manifest.services.length, 3);
        const targetRuntime = openProductRuntime({ root: targetRoot, resources });
        try {
          const restored = await restoreProductRecovery({ root: targetRoot, resources,
            backupDirectory: join(backupDirectory, manifest.backupId), key: recoveryKey, targets });
          for (const owner of restored.owners) await owner.close?.();
          const isolated = await targetRuntime.start();
          assert.equal(isolated.state, 'maintenance');
          await targetRuntime.recovery.takeover({ sourceRoot: root, receivers: [] });
          const response = await fetch(new URL('/api/learning/activities/' + activity.activityId, isolated.endpoint), { headers: { 'x-xj-space': 'personal' } });
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), activity);
          assert.equal((await fetch(new URL('/api/learning/activities', isolated.endpoint), { headers: { cookie, 'x-xj-space': 'school' } })).status, 403);
          assert.equal((await api('activities', undefined, { 'x-xj-space': 'personal' })).status, 503);
        } finally { await targetRuntime.stop(); }
      });
    });
  } finally { await storage?.close(); if (installedSuccessfully) await runtime.stop(); }
});
