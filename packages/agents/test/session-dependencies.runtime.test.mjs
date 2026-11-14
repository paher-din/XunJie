import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createLearningData, learningMigrations, createSpaces, createCourses, spaceCourseMigrations } from '@xunjie/learning-space';
import { createAgentSessions, agentSessionMigration } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createSessionMaterials, sessionMaterialMigration } from '@xunjie/learning-space/learning-data/session-materials';
import { createAgentRuntime, agentRuntimeMigrations } from '@xunjie/agent-runtime';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentDependencyService, createAgentDependencyClient } from '../dist/transport/session-dependencies.js';
import * as dependencies from '../dist/transport/session-dependencies.js';
import { createChunkClient } from '@xunjie/storage/chunk-channel';
import { fixedPdf } from '../../../apps/server/tests/fixtures/pdf-material.mjs';

async function fixture(t) {
  const pg = await nativeFixture(), storages = [], frames = [];
  let runtime, allowed = true;
  t.after(async () => { await runtime?.close(); for (const storage of storages.reverse()) await storage.close(); await pg.close(); });
  async function open(name, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() },
      password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: pg.root + '/' + name }) });
    storages.push(storage); return storage;
  }
  const spaceStorage = await open('school', spaceCourseMigrations), spaces = createSpaces(spaceStorage);
  const identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'dependency-student', password: randomUUID() });
  const courses = createCourses(spaceStorage, spaces);
  const dataStorage = await open('data', [...learningMigrations.filter(migration => migration.version < 31), agentSessionMigration, sessionMaterialMigration]);
  await spaces.bindMember(identity, { ...dataStorage.owner, version: 1 });
  const learning = createLearningData(dataStorage, spaces, courses);
  const agentStorage = await open('agent', agentRuntimeMigrations), installationId = randomUUID();
  runtime = createAgentRuntime(agentStorage, { authorize: spaces.authorize });
  const owner = { version: 1, installationId, connectionId: randomUUID(), target: { ...agentStorage.owner,
    unit: 'teaching-agent', endpoint: 'https://agent.example.test', protocolVersion: 1, capabilities: ['agent.sessions.v2'] } };
  const sessions = createAgentSessions(dataStorage, { authorize: spaces.authorize, openActivity: learning.open, resolveOwner: async () => owner });
  const materials = createSessionMaterials(dataStorage, { openScope: (actor, scope) => scope.kind === 'session'
    ? sessions.read(actor, scope.sessionId) : learning.open(actor, scope.activityId) });
  const source = { grantId: randomUUID(), sourceEnvironmentId: owner.target.environmentId, sourceServiceId: owner.target.serviceId,
    sourceInstallationId: installationId, async assertAuthorized() { if (!allowed) throw new StorageError('forbidden'); } };
  const options = { sessions, learning, courses, materials, resolveOwner: async () => owner,
    source: async actor => ({ sourceId: 'school', identity: actor, target: { ...dataStorage.owner, version: 1 }, learning,
      courses: { owner: { ...spaceStorage.owner, version: 1 }, listCourses: courses.listCourses, readRelease: courses.readRelease } }),
    authorize: async (actor, peer) => { await peer.assertAuthorized(); await spaces.authorize(actor); },
    assertDispatch: (actor, permit) => runtime.assertDispatch(actor, permit) };
  const service = createAgentDependencyService(options);
  const send = async value => { const wire = JSON.parse(JSON.stringify(value)); frames.push(wire); return JSON.parse(JSON.stringify(await service(wire, source))); };
  const client = createAgentDependencyClient(send);
  return { identity, spaces, learning, dataStorage, spaceStorage, courses, sessions, materials, runtime, owner, source, options, service, client, frames,
    deny() { allowed = false; } };
}

async function schoolCourse(f) {
  const courseId = randomUUID(), releaseId = randomUUID();
  await f.courses.registerRelease({ formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '真实学校课程' },
    task: { taskId: randomUUID(), title: 'owner 隔离任务', summary: '' }, release: { releaseId, objectives: ['区分来源'], requirements: '阅读公开材料',
      materials: [], starterWorks: [], capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course', note: '' } }, resources: [] });
  await f.courses.setAccess({ requestId: randomUUID(), courseId, principalId: f.identity.principalId, active: true });
  return { courseId, releaseId };
}

test('v2 JSON calls create and initialize the directory on the real school workspace owner and preserve its fixed Agent owner', async t => {
  const f = await fixture(t);
  const activity = await f.learning.create(f.identity, { requestId: randomUUID(), goal: '学校真实工作区', question: '', references: [] });
  const input = { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'workspace-assistant',
    workspace: { activityId: activity.activityId, target: activity.target } };
  const created = await f.client.sessions.create(f.identity, input);
  assert.equal(created.workspace.target.serviceId, f.dataStorage.owner.serviceId);
  assert.deepEqual(created.owner, f.owner);
  assert.deepEqual(await f.client.sessions.create(f.identity, input), created);
  assert.deepEqual(await f.client.sessions.read(f.identity, input.sessionId), created);
  await f.runtime.initialize({ sessionId: created.sessionId, identity: f.identity, scenario: created.scenario,
    restartPolicy: 'explicit', createdAt: created.createdAt });
  const ready = await f.client.sessions.markReady(f.identity, { requestId: randomUUID(), sessionId: created.sessionId });
  assert.equal(ready.state, 'ready');
  const updated = await f.client.sessions.update(f.identity, { requestId: randomUUID(), sessionId: created.sessionId, title: '原学校工作区', pinned: true });
  assert.equal(updated.title, '原学校工作区'); assert.deepEqual(updated.owner, created.owner);
  assert.equal((await f.client.sessions.list(f.identity)).length, 1);
  assert.deepEqual(await f.client.forSession(f.identity, created.sessionId).workspace(), activity);
  assert.ok(f.frames.every(frame => frame.version === 2));
  await assert.rejects(f.client.sessions.create(f.identity, { ...input, requestId: randomUUID(), sessionId: randomUUID(),
    workspace: { ...input.workspace, target: { environmentId: f.owner.target.environmentId, serviceId: f.owner.target.serviceId, version: 1 } } }), { code: 'forbidden' });
});

test('trusted describe separates learning and course owners; home query returns owner references and revalidates them', async t => {
  const f = await fixture(t);
  const activity = await f.learning.create(f.identity, { requestId: randomUUID(), goal: '来自学校数据 owner 的任务', question: '', references: [] });
  const description = await f.client.source.describe(f.identity);
  assert.deepEqual(description, { learningTarget: { ...f.dataStorage.owner, version: 1 }, courseTarget: { ...f.spaceStorage.owner, version: 1 }, identity: f.identity });
  assert.notDeepEqual(description.learningTarget, description.courseTarget);
  const { releaseId } = await schoolCourse(f);
  const session = await f.client.sessions.create(f.identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const query = f.client.forSession(f.identity, session.sessionId).query;
  const page = await query.listLearningTasks({});
  const courseItem = page.items.find(item => item.reference.objectId === releaseId), course = courseItem.reference;
  assert.deepEqual(course.owner, description.courseTarget);
  assert.ok((await query.readLearning({ reference: course })).text.includes(releaseId));
  const detail = await query.readLearning({ reference: course, range: { offset: 0, length: 7 } });
  assert.deepEqual(detail.provenance, courseItem.provenance);
  assert.deepEqual(detail.provenance.course.helpPolicy, (await f.courses.readRelease(f.identity, releaseId)).helpPolicy);
  await assert.rejects(query.readLearning({ reference: { ...course, owner: description.learningTarget } }), { code: 'forbidden' });
  const ref = page.items.find(item => item.reference.objectId === activity.activityId).reference;
  assert.deepEqual(ref.owner, description.learningTarget);
  assert.equal(ref.sourceId, 'school');
  assert.ok((await query.readLearning({ reference: ref })).text.includes(activity.goal));
  assert.equal((await query.searchLearning({ query: '学校数据', kinds: ['activity'] })).items.length, 1);
  await assert.rejects(query.readLearning({ reference: { ...ref, owner: description.courseTarget } }), { code: 'forbidden' });
  await assert.rejects(query.readLearning({ reference: { ...ref, version: 'changed' } }), { code: 'conflict' });
  const workspace = await f.client.sessions.create(f.identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'workspace-assistant',
    workspace: { activityId: activity.activityId, target: activity.target } });
  await assert.rejects(f.client.forSession(f.identity, workspace.sessionId).query.listLearningTasks({}), { code: 'forbidden' });
  f.deny();
  await assert.rejects(f.client.source.describe(f.identity), { code: 'forbidden' });
  await assert.rejects(query.readLearning({ reference: ref }), { code: 'forbidden' });
});

test('workspace domain ports cross only v2 JSON and cannot use another activity or actor', async t => {
  const f = await fixture(t);
  const activity = await f.learning.create(f.identity, { requestId: randomUUID(), goal: '固定作用域', question: '', references: [] });
  const other = await f.learning.create(f.identity, { requestId: randomUUID(), goal: '另一个活动', question: '', references: [] });
  const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'source.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: '跨 owner 原文：31 V。' };
  await f.learning.works.sync(f.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] });
  const session = await f.client.sessions.create(f.identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'workspace-assistant',
    workspace: { activityId: activity.activityId, target: activity.target } });
  const remote = f.client.forSession(f.identity, session.sessionId);
  const original = await remote.learning.works.content(f.identity, activity.activityId, file.contentId);
  assert.equal(original.value, file.value); assert.equal(original.contentId, file.contentId);
  await assert.rejects(remote.learning.open(f.identity, other.activityId), { code: 'forbidden' });
  await assert.rejects(remote.learning.open({ ...f.identity, principalId: randomUUID() }, activity.activityId), { code: 'forbidden' });
  assert.ok(f.frames.every(frame => frame.version === 2));
  assert.ok(f.frames.some(frame => frame.operation === 'workspace.data'));
});

test('session attachment reads retain the real school scope and immutable version across v2 JSON', async t => {
  const f = await fixture(t), session = await f.client.sessions.create(f.identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const scope = { kind: 'session', sessionId: session.sessionId }, materialId = randomUUID();
  await f.materials.personal.receive(f.identity, scope, { requestId: randomUUID(), materialId,
    name: 'school-note.txt', mediaType: 'text/plain', dataBase64: Buffer.from('学校 owner 保留的原版本 31 V').toString('base64') });
  await f.materials.personal.update(f.identity, scope, materialId, { requestId: randomUUID(), materialId, expectedVersion: 1,
    dataBase64: Buffer.from('后来改为 42 V').toString('base64') });
  const remote = f.client.forSession(f.identity, session.sessionId).materials;
  const original = await remote.personal.versionContent(f.identity, scope, materialId, 1);
  assert.equal(original.text, '学校 owner 保留的原版本 31 V');
  assert.deepEqual(original.material.scope, scope);
  assert.equal(original.material.activityId, undefined);
  assert.equal((await remote.personal.list(f.identity, scope))[0].currentVersion, 2);
  assert.equal((await remote.personal.readRange(f.identity, scope, materialId, 1, { start: 0, length: 2 })).text, '学校');
  await assert.rejects(remote.personal.original(f.identity, { kind: 'session', sessionId: randomUUID() }, materialId, 1), { code: 'forbidden' });
  await assert.rejects(remote.personal.original(f.identity, { kind: 'workspace', activityId: session.sessionId }, materialId, 1), { code: 'forbidden' });
  f.deny();
  await assert.rejects(remote.personal.original(f.identity, scope, materialId, 1), { code: 'forbidden' });
});

test('v2 receiving chunk channel retains large original reads and denies disclosure after current authorization is revoked', async t => {
  const f = await fixture(t), session = await f.client.sessions.create(f.identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const scope = { kind: 'session', sessionId: session.sessionId }, materialId = randomUUID(), text = '原始资料。'.repeat(100000);
  await f.materials.personal.receive(f.identity, scope, { requestId: randomUUID(), materialId, name: 'large.txt', mediaType: 'text/plain', dataBase64: Buffer.from(text).toString('base64') });
  const channel = dependencies.createAgentDependencyChannel(f.dataStorage, f.options), transferId = randomUUID();
  const raw = value => channel.handle(JSON.parse(JSON.stringify(value)), f.source);
  const call = { version: 2, operation: 'materials.read', identity: f.identity, sessionId: session.sessionId,
    args: { method: 'personal.original', scope, args: [materialId, 1] } };
  const first = await createChunkClient(raw)(call, { transferId });
  assert.equal(first.text, text);
  const reopened = dependencies.createAgentDependencyChannel(f.dataStorage, f.options);
  assert.deepEqual(await createChunkClient(value => reopened.handle(value, f.source))(call, { transferId }), first);
  await reopened.validate();
  const permit = { sessionId: session.sessionId, runId: randomUUID(), stepId: randomUUID(), operationId: randomUUID(), generation: 1 };
  const projection = dependencies.agentDependencyAuthorityProjection;
  const effect = { version: 2, operation: 'workspace.data', identity: f.identity, sessionId: session.sessionId, permit,
    args: { method: 'artifacts.publish', args: [] } };
  assert.equal(projection.project(effect, { ...permit, generation: 2 }).permit.generation, 2);
  assert.throws(() => projection.project(effect, { ...permit, operationId: randomUUID(), generation: 2 }), { code: 'identity-conflict' });
  assert.throws(() => projection.project(effect, { ...permit, generation: 0 }), { code: 'invalid' });
  let stages = 0;
  const interrupted = dependencies.createAgentDependencyChannel({ ...f.dataStorage, async stageResource(input) {
    if (++stages === 2) throw new StorageError('unavailable');
    return f.dataStorage.stageResource(input);
  } }, f.options), unknownId = randomUUID();
  await assert.rejects(createChunkClient(value => interrupted.handle(value, f.source))(call, { transferId: unknownId }), { code: 'commit-unknown' });
  await reopened.validate();
  await assert.rejects(createChunkClient(raw)(call, { transferId: unknownId }), { code: 'commit-unknown' });
  const discarded = await raw({ chunkChannel: 1, operation: 'discard-query', transferId: unknownId });
  assert.equal(discarded.state, 'acknowledged');
  assert.equal((await createChunkClient(raw)(call)).text, text);
  f.deny();
  await assert.rejects(raw({ chunkChannel: 1, operation: 'get', transferId, index: 0 }), { code: 'forbidden' });
});

test('a supported large school PDF original crosses the bounded v2 channel without changing its bytes', async t => {
  const f = await fixture(t), session = await f.client.sessions.create(f.identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const scope = { kind: 'session', sessionId: session.sessionId }, documentId = randomUUID(), bytes = fixedPdf('A'.repeat(13 * 1024 * 1024));
  await f.materials.pdf.upload(f.identity, scope, { requestId: randomUUID(), documentId, name: 'large.pdf', dataBase64: bytes.toString('base64') });
  const channel = dependencies.createAgentDependencyChannel(f.dataStorage, f.options);
  const send = createChunkClient(value => channel.handle(JSON.parse(JSON.stringify(value)), f.source));
  const client = createAgentDependencyClient(call => send(call, { acknowledge: true }));
  const original = await client.forSession(f.identity, session.sessionId).materials.pdf.original(f.identity, scope, documentId);
  assert.deepEqual(Buffer.from(original.bytes), bytes);
  assert.deepEqual(original.document.scope, scope);
  assert.equal(original.document.activityId, undefined);
});

test('a current service grant cannot download retained workspace or course detail after real course access is revoked', async t => {
  const f = await fixture(t), { courseId, releaseId } = await schoolCourse(f);
  const activity = await f.learning.createCourse(f.identity, { requestId: randomUUID(), releaseId });
  const session = await f.client.sessions.create(f.identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'workspace-assistant',
    workspace: { activityId: activity.activityId, target: activity.target } });
  const home = await f.client.sessions.create(f.identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const reference = (await f.client.forSession(f.identity, home.sessionId).query.listLearningTasks({})).items.find(item => item.reference.kind === 'course').reference;
  const channel = dependencies.createAgentDependencyChannel(f.dataStorage, f.options), raw = value => channel.handle(value, f.source);
  const workspaceTransfer = randomUUID(), courseTransfer = randomUUID();
  await createChunkClient(raw)({ version: 2, operation: 'workspace.activity', identity: f.identity, sessionId: session.sessionId, args: {} }, { transferId: workspaceTransfer });
  await createChunkClient(raw)({ version: 2, operation: 'query.read', identity: f.identity, sessionId: home.sessionId, args: { reference } }, { transferId: courseTransfer });
  await f.courses.setAccess({ requestId: randomUUID(), courseId, principalId: f.identity.principalId, active: false });
  await f.source.assertAuthorized();
  for (const transferId of [workspaceTransfer, courseTransfer])
    await assert.rejects(raw({ chunkChannel: 1, operation: 'get', transferId, index: 0 }), { code: 'forbidden' });
});

test('mixed versions, changed fixed owners and revoked current actors fail before directory side effects', async t => {
  const f = await fixture(t), input = { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' };
  let authorized = 0;
  const service = createAgentDependencyService({ ...f.options, async authorize(...args) { authorized++; return f.options.authorize(...args); } });
  assert.deepEqual(await service({ version: 1, operation: 'sessions.create', identity: f.identity, sessionId: input.sessionId, args: input }, f.source), { error: 'incompatible' });
  assert.equal(authorized, 0); assert.deepEqual(await f.sessions.list(f.identity), []);
  const session = await f.client.sessions.create(f.identity, input);
  const metadata = { version: 2, operation: 'sessions.update', identity: f.identity, sessionId: session.sessionId,
    args: { requestId: randomUUID(), sessionId: session.sessionId, title: '不应写入' } };
  assert.deepEqual(await service(metadata, { ...f.source, sourceServiceId: randomUUID() }), { error: 'forbidden' });
  assert.equal((await f.sessions.read(f.identity, session.sessionId)).title, null);
  f.deny();
  await assert.rejects(f.client.sessions.update(f.identity, metadata.args), { code: 'forbidden' });
  assert.equal((await f.sessions.read(f.identity, session.sessionId)).title, null);
});

test('an authorized successor installation keeps the original session owner while unrelated or revoked sources remain denied', async t => {
  const f = await fixture(t), input = { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' };
  const session = await f.client.sessions.create(f.identity, input), nextInstallation = randomUUID();
  let proven = true;
  const service = createAgentDependencyService({ ...f.options,
    async isOwnerSuccessor(owner, source) { return proven && owner.installationId === f.owner.installationId
      && source.sourceInstallationId === nextInstallation; } });
  const source = { ...f.source, grantId: randomUUID(), sourceInstallationId: nextInstallation };
  const read = { version: 2, operation: 'sessions.read', identity: f.identity, sessionId: session.sessionId, args: {} };
  assert.deepEqual(await service(read, source), session);
  assert.deepEqual(await service({ version: 2, operation: 'sessions.list', identity: f.identity, args: {} }, source), [session]);
  assert.equal((await f.sessions.read(f.identity, session.sessionId)).owner.installationId, f.owner.installationId,
    'recovery never rewrites the fixed original owner');
  assert.deepEqual(await service(read, { ...source, sourceServiceId: randomUUID() }), { error: 'forbidden' });
  proven = false;
  assert.deepEqual(await service(read, source), { error: 'forbidden' });
  proven = true; f.deny();
  assert.deepEqual(await service(read, source), { error: 'forbidden' });
});
