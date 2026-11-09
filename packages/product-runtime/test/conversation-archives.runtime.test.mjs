import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import * as storage from '@xunjie/storage';
import { activitySchema, conversationArchiveStateSchema, conversationArchiveSetSchema,
  conversationArchiveImportSchema } from '@xunjie/contracts/learning-data';
import { createLearningData, learningMigrations, validateLearningData, createSpaces, spaceMigrations,
  createLearningEntry, createLearningAuthority } from '@xunjie/learning-space';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createSchoolClient } from '../dist/school-client.js';
import { createConnectionAuthority } from '@xunjie/product-runtime/connections';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const setInput = (activityId, archived) => ({ requestId: randomUUID(), activityId, archived });
const importInput = activityIds => ({ requestId: randomUUID(), activityIds });
const subject = identity => [identity.environmentId, identity.spaceId, identity.principalId].join('.');
const exec = promisify(execFile);
async function pgTool(fixture, name, args, connection = fixture.admin) {
  try {
    await exec(fixture.tool(name), ['-h', connection.host, '-p', String(connection.port), '-U', connection.user,
      '-d', connection.database, ...args], { env: { ...process.env, PGPASSWORD: connection.password }, timeout: 30000 });
  } catch { throw new Error(`${name} failed`); }
}

test('conversation archive contracts reject malformed and extra fields', () => {
  const id = randomUUID();
  assert.deepEqual(conversationArchiveStateSchema.parse({ archivedIds: [id] }), { archivedIds: [id] });
  for (const value of [{ archivedIds: ['bad'] }, { archivedIds: [], revision: 1 }, null]) {
    assert.equal(conversationArchiveStateSchema.safeParse(value).success, false);
  }
  assert.equal(conversationArchiveSetSchema.safeParse({ ...setInput(id, true), principalId: id }).success, false);
  assert.equal(conversationArchiveSetSchema.safeParse(setInput(id, 'true')).success, false);
  assert.equal(conversationArchiveImportSchema.safeParse(importInput(['bad'])).success, false);
  assert.deepEqual(conversationArchiveImportSchema.parse(importInput([])).activityIds, []);
});

test('main and UI migration histories converge without losing archive state', { timeout: 90000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const archive = learningMigrations.at(-1);
    assert.equal(archive.version, 26);
    assert.equal(archive.formerVersion, 25);
    for (const history of ['main', 'ui']) {
      const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, password = randomUUID();
      const before = history === 'main' ? learningMigrations.slice(0, 25)
        : [...learningMigrations.slice(0, 24), { version: 25, name: archive.name, sql: archive.sql }];
      const binding = await storage.provisionStorage({ admin: fixture.admin, owner, password, migrations: before });
      const backend = storage.createFileBackend({ id: history, root: join(fixture.root, history) });
      const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'Migration' };
      const authority = { async resolveBinding() { return { ...owner, version: 1 }; } };
      let opened = await storage.openStorage({ binding, migrations: before, backend });
      try {
        const old = createLearningData(opened, authority);
        const activity = await old.create(identity, { requestId: randomUUID(), goal: '保留既有活动', question: '', references: [] });
        const restored = await old.create(identity, { requestId: randomUUID(), goal: '保留恢复标记', question: '', references: [] });
        if (history === 'ui') {
          await old.conversationArchives.set(identity, setInput(activity.activityId, true));
          await old.conversationArchives.set(identity, setInput(restored.activityId, false));
        }
        await opened.participant().closeWrites(); await opened.participant().closeDispatch();
        await opened.close();
        await storage.provisionStorage({ admin: fixture.admin, owner, password, migrations: learningMigrations });
        opened = await storage.openStorage({ binding, migrations: learningMigrations, backend });
        const current = createLearningData(opened, authority);
        assert.deepEqual(await current.open(identity, activity.activityId), activity);
        assert.deepEqual(await current.conversationArchives.read(identity), { archivedIds: history === 'ui' ? [activity.activityId] : [] });
        assert.deepEqual(await current.artifacts.list(identity, activity.activityId), []);
        if (history === 'ui') assert.equal((await opened.read('SELECT archived FROM conversation_archives WHERE activity_id=$1', [restored.activityId])).rows[0].archived, false);
        assert.deepEqual((await opened.read('SELECT version,name FROM _storage_migrations WHERE version>=25 ORDER BY version')).rows,
          [{ version: 25, name: 'activity-teaching-artifacts' }, { version: 26, name: archive.name }]);
        await validateLearningData(opened);
      } finally { await opened.close(); }
    }
  } finally { await fixture.close(); }
});

test('conversation archives use the learning owner, preserve tombstones and survive recovery', { timeout: 180000 }, async t => {
  const fixture = await nativeFixture();
  const handles = [];
  let server;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, password = randomUUID();
    const oldMigrations = learningMigrations.slice(0, 24);
    assert.equal(oldMigrations.at(-1).version, 24);
    const binding = await storage.provisionStorage({ admin: fixture.admin, owner, password, migrations: oldMigrations });
    const backend = storage.createFileBackend({ id: 'archives', root: join(fixture.root, 'objects') });
    const spaceBinding = await storage.provisionStorage({ admin: fixture.admin,
      owner: { environmentId: owner.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: spaceMigrations });
    const spaceStorage = await storage.openStorage({ binding: spaceBinding, migrations: spaceMigrations,
      backend: storage.createFileBackend({ id: 'spaces', root: join(fixture.root, 'space-objects') }) });
    handles.push(spaceStorage);
    const spaces = createSpaces(spaceStorage), identity = await spaces.personal();
    const target = { ...owner, version: 1 };
    await spaces.bindMember(identity, target);
    const memberPassword = randomUUID();
    const member = await spaces.createMember({ requestId: randomUUID(), loginName: 'archive-member', password: memberPassword });
    await spaces.bindMember(member, target);
    const other = await spaces.createMember({ requestId: randomUUID(), loginName: 'archive-other', password: randomUUID() });
    await spaces.bindMember(other, target);
    let learningStorage = await storage.openStorage({ binding, migrations: oldMigrations, backend });
    const old = createLearningData(learningStorage, spaces);
    const activity = await old.create(identity, { requestId: randomUUID(), goal: '旧自主对话', question: '', references: [] });
    await learningStorage.participant().closeWrites(); await learningStorage.participant().closeDispatch();
    await learningStorage.close();
    await storage.provisionStorage({ admin: fixture.admin, owner, password, migrations: learningMigrations });
    const options = { binding, migrations: learningMigrations, backend };
    learningStorage = await storage.openStorage(options); handles.push(learningStorage);
    await learningStorage.participant().resume();
    const peerStorage = await storage.openStorage(options); handles.push(peerStorage);
    const learning = createLearningData(learningStorage, spaces), peer = createLearningData(peerStorage, spaces);
    const archives = learning.conversationArchives;
    const create = async (who = identity) => (await learning.create(who, {
      requestId: randomUUID(), goal: '自主学习', question: '', references: [],
    })).activityId;

    await t.test('migration keeps old activities and separate handles observe the same durable state', async () => {
      assert.deepEqual(await learning.open(identity, activity.activityId), activity);
      assert.deepEqual(await archives.read(identity), { archivedIds: [] });
      const input = setInput(activity.activityId, true);
      assert.deepEqual(await archives.set(identity, input), { archivedIds: [activity.activityId] });
      assert.deepEqual(await peer.conversationArchives.read(identity), { archivedIds: [activity.activityId] });
      await peer.conversationArchives.set(identity, setInput(activity.activityId, false));
      assert.deepEqual(await archives.set(identity, input), { archivedIds: [] }, 'old receipt returns current state without reapplying');
      await assert.rejects(archives.set(identity, { ...input, archived: false }), { code: 'identity-conflict' });
      await assert.rejects(archives.import(identity, { requestId: input.requestId, activityIds: [activity.activityId] }), { code: 'identity-conflict' });
      const reopened = await storage.openStorage(options); handles.push(reopened);
      assert.deepEqual(await createLearningData(reopened, spaces).conversationArchives.read(identity), { archivedIds: [] });
      assert.equal((await reopened.read('SELECT archived FROM conversation_archives WHERE activity_id=$1', [activity.activityId])).rows[0].archived, false);
    });

    let courseId;
    await t.test('set rejects foreign, missing and course activities; import omits them without changing lifecycle or drafts', async () => {
      const foreignId = await create(other), missingId = randomUUID();
      const courseActivity = activitySchema.parse({ ...activity, activityId: randomUUID(), course: {
        associationId: randomUUID(), courseId: randomUUID(), courseName: '课程', taskId: randomUUID(), taskTitle: '任务',
        releaseId: randomUUID(), contentDigest: 'a'.repeat(64), objectives: ['目标'], requirements: '要求', materials: [],
        starterWorks: [], capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
      } });
      courseId = courseActivity.activityId;
      await learningStorage.request({ requestId: randomUUID(), fingerprint: 'course-fixture' }, async tx => {
        await tx.query('INSERT INTO activities VALUES($1,$2,$3,$4,$5)', [courseId, identity.environmentId,
          identity.spaceId, identity.principalId, JSON.stringify(courseActivity)]); return null;
      });
      for (const activityId of [foreignId, missingId]) await assert.rejects(archives.set(identity, setInput(activityId, true)), { code: 'missing' });
      await assert.rejects(archives.set(identity, setInput(courseId, true)), { code: 'forbidden' });
      await assert.rejects(archives.set(identity, { ...setInput(activity.activityId, true), principalId: other.principalId }));
      await assert.rejects(archives.import(identity, importInput(['invalid'])));
      const id = await create();
      await learning.setStatus(identity, { requestId: randomUUID(), activityId: id, status: 'closed' });
      const draft = await learning.drafts.read(identity, id);
      const before = await learning.open(identity, id);
      const imported = await archives.import(identity, importInput([id, id, activity.activityId, foreignId, missingId, courseId]));
      assert.deepEqual(imported, { archivedIds: [id] });
      assert.deepEqual(await learning.open(identity, id), before);
      assert.deepEqual(await learning.drafts.read(identity, id), draft);
      await archives.set(identity, setInput(id, false));
      assert.deepEqual(await archives.import(identity, importInput([id])), { archivedIds: [] });
      assert.deepEqual(await learning.open(identity, id), before);
    });

    await t.test('each dimension of the full subject isolates reads, writes, imports and request identities', async () => {
      const variants = [identity, { ...identity, environmentId: randomUUID() }, { ...identity, spaceId: randomUUID() },
        { ...identity, principalId: randomUUID() }];
      // An authority can bind several subjects to one learning-data owner. The owner must still separate all three dimensions.
      const authority = { async resolveBinding(who) {
        assert.ok(variants.some(item => subject(item) === subject(who))); return target;
      } };
      const scoped = createLearningData(learningStorage, authority), ids = [];
      for (const who of variants) ids.push((await scoped.create(who, { requestId: randomUUID(), goal: '隔离', question: '', references: [] })).activityId);
      const requestId = randomUUID();
      for (let i = 0; i < variants.length; i++) {
        assert.deepEqual(await scoped.conversationArchives.import(variants[i], { requestId, activityIds: ids }), { archivedIds: [ids[i]] });
        for (let j = 0; j < variants.length; j++) if (i !== j) {
          await assert.rejects(scoped.conversationArchives.set(variants[i], setInput(ids[j], true)), { code: 'missing' });
        }
        await scoped.conversationArchives.set(variants[i], setInput(ids[i], false));
      }
    });

    // Interpose only at the real owner's SQL boundary so races are forced with actual PostgreSQL row locks.
    function gatedOwner({ before, after } = {}) {
      return createLearningData({ ...learningStorage, request(input, effect) {
        return learningStorage.request(input, tx => effect({ ...tx, async query(sql, values) {
          const lock = input.requestId.startsWith('conversation-archives:') && /FROM activities[\s\S]*FOR UPDATE/.test(sql);
          if (lock) await before?.();
          const result = await tx.query(sql, values);
          if (lock) await after?.();
          return result;
        } }));
      } }, spaces);
    }
    await t.test('restore before late import and restore after admitted import both retain false tombstones', async () => {
      for (const firstIsRestore of [true, false]) {
        const id = await create(), locked = deferred(), release = deferred(), waiting = deferred();
        const first = gatedOwner({ after: async () => { locked.resolve(); await release.promise; } }).conversationArchives;
        const second = gatedOwner({ before: async () => { waiting.resolve(); } }).conversationArchives;
        const a = firstIsRestore ? first.set(identity, setInput(id, false)) : first.import(identity, importInput([id]));
        try {
          await locked.promise;
          const b = firstIsRestore ? second.import(identity, importInput([id])) : second.set(identity, setInput(id, false));
          await waiting.promise;
          release.resolve();
          await Promise.all([a, b]);
          assert.equal((await archives.read(identity)).archivedIds.includes(id), false);
          assert.equal((await learningStorage.read('SELECT archived FROM conversation_archives WHERE activity_id=$1', [id])).rows[0].archived, false);
        } finally { release.resolve(); }
      }
    });

    await t.test('concurrent duplicate requests commit once, overlapping reverse-order imports terminate, retries stay current', async () => {
      const id = await create(), another = await create(), input = setInput(id, true);
      await Promise.all([archives.set(identity, input), peer.conversationArchives.set(identity, input)]);
      const oldImport = importInput([id, another]);
      await Promise.all([archives.import(identity, oldImport), peer.conversationArchives.import(identity, importInput([another, id]))]);
      assert.deepEqual(await archives.read(identity), { archivedIds: [id, another].sort() });
      await archives.set(identity, setInput(id, false));
      await archives.set(identity, setInput(another, false));
      assert.deepEqual(await archives.import(identity, oldImport), { archivedIds: [] });
      const conflict = setInput(id, true);
      const outcomes = await Promise.allSettled([archives.set(identity, conflict), peer.conversationArchives.set(identity, { ...conflict, archived: false })]);
      assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'identity-conflict');
      await archives.set(identity, setInput(id, false));
    });

    await t.test('current binding and membership are checked for list, set replay and import replay', async () => {
      const id = await create(member), saved = setInput(id, true), imported = importInput([id]);
      await archives.set(member, saved); await archives.import(member, imported);
      await spaces.setMembership({ requestId: randomUUID(), principalId: member.principalId, active: false });
      try {
        await assert.rejects(archives.read(member), { code: 'forbidden' });
        await assert.rejects(archives.set(member, saved), { code: 'forbidden' });
        await assert.rejects(archives.import(member, imported), { code: 'forbidden' });
      } finally { await spaces.setMembership({ requestId: randomUUID(), principalId: member.principalId, active: true }); }
      const wrong = createLearningData(learningStorage, { async resolveBinding() { return { ...target, serviceId: randomUUID() }; } });
      await assert.rejects(wrong.conversationArchives.read(identity), { code: 'forbidden' });
      await archives.set(member, setInput(id, false));
    });

    await t.test('HTTP uses session identity, expected subject, namespace, space, same-origin and maintenance checks', async () => {
      let entry, readOnly = false;
      server = createServer((request, response) => { entry(request, response).then(handled => {
        if (!handled) { response.writeHead(404); response.end(); }
      }); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${server.address().port}`;
      const namespace = randomUUID();
      entry = createLearningEntry({ environment: { environmentId: owner.environmentId, clientNamespace: namespace,
        profile: 'local', services: [{ endpoint }] }, spaces, learning, target, administratorToken: randomUUID(),
        requiresNamespace: true, readOnly: async () => readOnly });
      const api = (path, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => fetch(`${endpoint}/api/learning/${path}`, {
        method, headers: { 'content-type': 'application/json', 'x-xj-space': 'personal',
          'x-xj-namespace': namespace, 'x-xj-expected-subject': subject(identity), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const id = await create();
      assert.equal((await api('conversation-archives')).status, 200);
      assert.equal((await api('conversation-archives', undefined, {}, 'DELETE')).status, 404);
      assert.equal((await api('conversation-archives/set')).status, 404);
      assert.equal((await api('conversation-archives/set', setInput(id, true), { 'x-xj-expected-subject': subject(other) })).status, 403);
      for (const route of ['conversation-archives', 'conversation-archives/set', 'conversation-archives/import']) {
        const body = route.endsWith('/set') ? setInput(id, true) : route.endsWith('/import') ? importInput([id]) : undefined;
        assert.equal((await api(route, body, { 'x-xj-expected-subject': subject(other) })).status, 403);
        assert.equal((await api(route, body, { 'x-xj-expected-subject': '' })).status, 403);
        assert.equal((await api(route, body, { 'x-xj-namespace': randomUUID() })).status, 403);
        assert.equal((await api(route, body, { 'x-xj-space': 'school' })).status, 403);
      }
      assert.equal((await api('conversation-archives/set', setInput(id, true), { origin: 'https://foreign.invalid' })).status, 403);
      assert.equal((await api('conversation-archives/set', setInput(id, true), { 'x-xj-namespace': '' })).status, 403);
      assert.equal((await api('conversation-archives/set', { ...setInput(id, true), archived: 'true' })).status, 400);
      assert.equal((await api('conversation-archives/set', setInput(randomUUID(), true))).status, 404);
      assert.equal((await api('conversation-archives/set', setInput(courseId, true))).status, 403);
      assert.deepEqual(await (await api('conversation-archives/set', setInput(id, true))).json(), { archivedIds: [id] });
      // A second request has no browser storage or session cookie, but reads the same personal owner state.
      assert.deepEqual(await (await api('conversation-archives')).json(), { archivedIds: [id] });
      readOnly = true;
      assert.equal((await api('conversation-archives/set', setInput(id, false))).status, 503);
      readOnly = false;
      assert.deepEqual(await (await api('conversation-archives/set', setInput(id, false))).json(), { archivedIds: [] });
      assert.deepEqual(await (await api('conversation-archives/import', importInput([id]))).json(), { archivedIds: [] });
      const logged = await api('login', { loginName: 'archive-member', password: memberPassword });
      assert.equal(logged.status, 200);
      const cookie = logged.headers.get('set-cookie').split(';')[0];
      const schoolId = await create(member), schoolHeaders = { cookie, 'x-xj-space': 'school', 'x-xj-expected-subject': subject(member) };
      assert.deepEqual(await (await api('conversation-archives/set', setInput(schoolId, true), schoolHeaders)).json(), { archivedIds: [schoolId] });
      assert.equal((await api('conversation-archives/set', setInput(id, true), schoolHeaders)).status, 404);
      assert.deepEqual(await (await api('conversation-archives')).json(), { archivedIds: [] });
      await archives.set(member, setInput(schoolId, false));
      await new Promise(resolve => server.close(resolve)); server = undefined;
    });

    await t.test('school-client forwards all routes to the actual remote or local owner and rechecks authority', async () => {
      let entry, transport, malformed;
      let remoteArchiveCalls = 0;
      const schoolServer = createServer((request, response) => {
        if (request.url.startsWith('/api/learning/conversation-archives')) {
          remoteArchiveCalls++;
          if (malformed !== undefined) {
            response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(malformed)); return;
          }
        }
        void transport.handle(request, response).then(async handled => {
          if (!handled && !await entry(request, response)) { response.writeHead(404); response.end(); }
        }).catch(() => response.destroy());
      });
      await new Promise(resolve => schoolServer.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${schoolServer.address().port}`;
      const service = { environmentId: owner.environmentId, serviceId: spaceBinding.owner.serviceId,
        unit: 'space-course', endpoint, protocolVersion: 1, capabilities: ['learning.authority'] };
      entry = createLearningEntry({ environment: { environmentId: owner.environmentId, clientNamespace: randomUUID(),
        profile: 'school', services: [service] }, spaces, learning, target, administratorToken: randomUUID() });
      transport = createConnectionAuthority({ root: join(fixture.root, 'school-transport'), service,
        handlers: { 'learning.authority': createLearningAuthority(spaces) } });
      const localRoot = join(fixture.root, 'school-client');
      await mkdir(join(localRoot, 'credentials'), { recursive: true });
      const environment = { formatVersion: 1, environmentId: owner.environmentId, installationId: randomUUID(),
        clientNamespace: randomUUID(), profile: 'local', services: [] };
      const remoteClient = createSchoolClient(localRoot, environment);
      const connectionId = randomUUID();
      const login = await spaces.login('archive-member', memberPassword);
      let proxy;
      try {
        await remoteClient.start({ requestId: connectionId, schoolEndpoint: endpoint });
        await spaces.approveConnection(login.token, connectionId);
        await remoteClient.complete(connectionId);
        const id = await create(member), expected = subject(member);
        assert.deepEqual(await remoteClient.forward(connectionId, 'conversation-archives', undefined, expected), { archivedIds: [] });
        assert.deepEqual(await remoteClient.forward(connectionId, 'conversation-archives/set', setInput(id, true), expected), { archivedIds: [id] });
        assert.deepEqual(await remoteClient.forward(connectionId, 'conversation-archives/import', importInput([id]), expected), { archivedIds: [id] });
        await assert.rejects(remoteClient.forward(connectionId, 'conversation-archives', undefined, subject(other)), { code: 'forbidden' });
        await assert.rejects(remoteClient.forward(connectionId, 'conversation-archives', undefined, ''), { code: 'forbidden' });
        await assert.rejects(remoteClient.forward(connectionId, 'conversation-archives/set'), { code: 'invalid' });
        await assert.rejects(remoteClient.forward(connectionId, 'conversation-archives', {}), { code: 'invalid' });
        await assert.rejects(remoteClient.forward(connectionId, 'conversation-archives/set', setInput('invalid', true)));
        await assert.rejects(remoteClient.forward(connectionId, 'conversation-archives/unknown'), { code: 'forbidden' });
        for (const bad of [null, { archivedIds: ['bad'] }, { archivedIds: [], extra: true }]) {
          malformed = bad;
          await assert.rejects(remoteClient.forward(connectionId, 'conversation-archives', undefined, expected), { code: 'unavailable' });
        }
        malformed = undefined;
        // Exercise the installed-client HTTP routing branch with the same frontend subject/namespace headers.
        let proxyEntry;
        proxy = createServer((request, response) => { void proxyEntry(request, response); });
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
        const proxyEndpoint = `http://127.0.0.1:${proxy.address().port}`;
        proxyEntry = createLearningEntry({ environment: { ...environment, profile: 'remote', services: [{ ...service, endpoint: proxyEndpoint }] },
          administratorToken: randomUUID(), client: remoteClient, requiresNamespace: true });
        const api = (route, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => fetch(`${proxyEndpoint}/api/learning/${route}`, {
          method, headers: { 'content-type': 'application/json', 'x-xj-space': `school:${connectionId}`,
            'x-xj-namespace': environment.clientNamespace, 'x-xj-expected-subject': expected, ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        assert.deepEqual(await (await api('conversation-archives')).json(), { archivedIds: [id] });
        assert.equal((await api('conversation-archives', undefined, {}, 'DELETE')).status, 404);
        assert.equal((await api('conversation-archives', undefined, { 'x-xj-namespace': randomUUID() })).status, 403);
        assert.equal((await api('conversation-archives/set', setInput(id, false), { 'x-xj-expected-subject': subject(other) })).status, 403);
        assert.deepEqual(await (await api('conversation-archives/set', setInput(id, false))).json(), { archivedIds: [] });
        assert.deepEqual(await (await api('conversation-archives/import', importInput([id]))).json(), { archivedIds: [] });
        const runtimeConnectionId = randomUUID();
        const grant = await transport.authorize({ sourceEnvironmentId: owner.environmentId, sourceServiceId: owner.serviceId,
          sourceInstallationId: environment.installationId, capabilities: ['learning.authority'] });
        await writeFile(join(localRoot, 'credentials', 'archive-authority'), grant.token, { mode: 0o600 });
        await writeFile(join(localRoot, 'installation.json'), JSON.stringify({ connections: [{ connectionId: runtimeConnectionId,
          sourceEnvironmentId: owner.environmentId, sourceServiceId: owner.serviceId, target: service,
          requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'archive-authority' }] }), { mode: 0o600 });
        const localClient = createSchoolClient(localRoot, environment, { target,
          create(authority, courses) { return createLearningData(learningStorage, authority, courses); } });
        await localClient.configureLocal({ connectionId, runtimeConnectionId, target });
        const before = remoteArchiveCalls;
        assert.deepEqual(await localClient.forward(connectionId, 'conversation-archives/set', setInput(id, true), expected), { archivedIds: [id] });
        assert.deepEqual(await localClient.forward(connectionId, 'conversation-archives', undefined, expected), { archivedIds: [id] });
        assert.deepEqual(await localClient.forward(connectionId, 'conversation-archives/import', importInput([id]), expected), { archivedIds: [id] });
        assert.equal(remoteArchiveCalls, before, 'locally owned archives never go to the remote learning owner');
        await assert.rejects(localClient.forward(connectionId, 'conversation-archives/set', setInput(activity.activityId, true), expected), { code: 'missing' });
        await spaces.revokeConnection(member, connectionId);
        await assert.rejects(localClient.forward(connectionId, 'conversation-archives', undefined, expected), { code: 'forbidden' });
        await assert.rejects(remoteClient.forward(connectionId, 'conversation-archives', undefined, expected), { code: 'unavailable' });
        await archives.set(member, setInput(id, false));
      } finally {
        if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
        schoolServer.closeAllConnections(); await new Promise(resolve => schoolServer.close(resolve));
      }
    });

    await t.test('owner validation detects a foreign tombstone as well as invalid course archives', async () => {
      await validateLearningData(learningStorage);
      const id = activity.activityId;
      await learningStorage.request({ requestId: randomUUID(), fingerprint: 'tamper-scope' }, async tx => {
        await tx.query('UPDATE conversation_archives SET principal_id=$2 WHERE activity_id=$1', [id, other.principalId]); return null;
      });
      await assert.rejects(validateLearningData(learningStorage), { code: 'corrupt' });
      await learningStorage.request({ requestId: randomUUID(), fingerprint: 'repair-scope' }, async tx => {
        await tx.query('UPDATE conversation_archives SET principal_id=$2 WHERE activity_id=$1', [id, identity.principalId]);
        await tx.query('INSERT INTO conversation_archives VALUES($1,$2,$3,$4,false)', [courseId, identity.environmentId, identity.spaceId, identity.principalId]); return null;
      });
      await assert.rejects(validateLearningData(learningStorage), { code: 'corrupt' });
      await learningStorage.request({ requestId: randomUUID(), fingerprint: 'repair-course' }, async tx => {
        await tx.query('DELETE FROM conversation_archives WHERE activity_id=$1', [courseId]); return null;
      });
      await validateLearningData(learningStorage);
    });

    await t.test('native backup/restore retains both true state and false tombstones, request retries and closed gates', async () => {
      const destination = await nativeFixture();
      let restored;
      try {
        const yes = await create(), no = await create();
        const oldSet = setInput(yes, true), oldImport = importInput([no]);
        await archives.set(identity, oldSet);
        await archives.import(identity, oldImport);
        await archives.set(identity, setInput(no, false));
        await learningStorage.participant().closeWrites(); await learningStorage.participant().closeDispatch();
        const dump = join(fixture.root, 'archive.dump'); let manifest;
        await learningStorage.snapshot('conversation-archive-backup', async snapshot => {
          manifest = snapshot.manifest;
          await pgTool(fixture, 'pg_dump', ['-Fc', '-n', binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump], binding.connection);
        });
        const recoveredBinding = await storage.prepareStorageRestore({ admin: destination.admin, owner, password });
        await pgTool(destination, 'pg_restore', ['--exit-on-error', '--role', recoveredBinding.migratorRole, '--no-owner', '--no-acl', dump]);
        restored = await storage.finalizeStorageRestore({ admin: destination.admin, binding: recoveredBinding,
          migrations: learningMigrations, manifest, backend: storage.createFileBackend({ id: 'archives', root: join(destination.root, 'objects') }) });
        await validateLearningData(restored);
        const recovered = createLearningData(restored, spaces).conversationArchives;
        assert.deepEqual(await recovered.read(identity), { archivedIds: [yes] });
        assert.deepEqual(await recovered.set(identity, oldSet), { archivedIds: [yes] }, 'confirmed retry is allowed behind closed gates');
        await assert.rejects(recovered.set(identity, setInput(yes, false)), { code: 'maintenance' });
        await restored.participant().resume();
        await recovered.set(identity, setInput(yes, false));
        assert.deepEqual(await recovered.set(identity, oldSet), { archivedIds: [] });
        assert.deepEqual(await recovered.import(identity, oldImport), { archivedIds: [] });
        assert.deepEqual(await recovered.import(identity, importInput([yes, no])), { archivedIds: [] });
        assert.equal((await restored.read('SELECT archived FROM conversation_archives WHERE activity_id=ANY($1::uuid[])', [[yes, no]])).rows.every(row => row.archived === false), true);
        await validateLearningData(restored);
      } finally { await restored?.close(); await destination.close(); }
    });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const handle of handles.reverse()) await handle.close();
    await fixture.close();
  }
});
