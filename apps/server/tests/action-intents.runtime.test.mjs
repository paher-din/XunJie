import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential, createProductRuntimeHost, createProductLearningApplication, restoreProductRecovery } from '@xunjie/product-runtime';
import { createFileBackend, provisionStorage, openStorage } from '@xunjie/storage';
import { createSpaces, createLearningData, spaceMigrations, learningMigrations } from '@xunjie/learning-space';
import { controlledActionReceiver } from './support/action-receiver.mjs';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };

test('an action retains only its fixed inputs without replacing later work or draft heads', { timeout: 180000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-intents-'));
  const runtime = openProductRuntime({ root, resources });
  try {
    await runtime.install({ profile: 'local' });
    const { endpoint } = await runtime.start();
    const api = async (route, body) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), {
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const activity = (await api('activities', { requestId: randomUUID(), goal: '固定当时依据', question: '', references: [] })).value;
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: '原文.txt', kind: 'text',
      encoding: 'utf8', mediaType: 'text/plain', value: '\uFEFF甲\r\n乙😀\r\n' };
    const scope = { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
      principalId: activity.identity.principalId, activityId: activity.activityId };
    const input = { requestId: randomUUID(), scope, receiver: { receiverId: 'future-agent', location: 'remote', kind: 'question' },
      draft: { token: randomUUID(), question: '为什么是甲？', references: [], bases: [] }, works: [file], evidence: [] };
    const path = 'intents/' + activity.activityId;
    const saved = await api(path, input);
    assert.equal(saved.status, 200);
    assert.equal(saved.value.state, 'prepared');
    assert.deepEqual(saved.value.input, input);
    assert.deepEqual(saved.value.dependencies, [{ kind: 'work', objectId: file.objectId, contentId: file.contentId }]);
    const later = { ...file, contentId: randomUUID(), value: '后续作品' };
    assert.equal((await api('workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [later] })).status, 200);
    const draft = (await api('drafts/' + activity.activityId)).value;
    assert.equal((await api('drafts/' + activity.activityId, { requestId: randomUUID(), draftId: draft.draftId,
      baseRevision: 0, question: '后续新问题', references: [], bases: [] })).status, 200);
    assert.deepEqual((await api(path + '/' + input.requestId)).value, saved.value);
    assert.deepEqual((await api(path, input)).value, saved.value);
    assert.equal((await api(path, { ...input, draft: { ...input.draft, question: '不能偷换旧请求' } })).status, 409);
    assert.equal((await api('workspaces/' + activity.activityId)).value.files[0].value, '后续作品');
    assert.equal((await api('drafts/' + activity.activityId)).value.question, '后续新问题');
    assert.equal((await api(path + '/' + input.requestId + '/dispatch', {})).status, 503, 'unregistered business receiver is unavailable');
    assert.equal((await api(path + '/' + input.requestId)).value.state, 'prepared', 'workspace receipt is not business acceptance');
    assert.deepEqual((await api(path + '/capabilities')).value.map(item => item.kind), ['question']);
  } finally { await runtime.stop(); }
});

async function ownedLearning(run, migrations = learningMigrations) {
  const root = await mkdtemp(join(tmpdir(), 'xj-intent-receiver-'));
  const runtime = openProductRuntime({ root, resources });
  let spaceStorage, storage;
  try {
    await runtime.install({ profile: 'local' }); await runtime.start();
    const { credentialRef, ...connection } = await runtime.database();
    const admin = { ...connection, password: await resolveCredential(root, credentialRef) };
    const environmentId = randomUUID(), owner = { environmentId, serviceId: randomUUID() };
    const spaceBinding = await provisionStorage({ admin, owner: { environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: spaceMigrations });
    const dataPassword = randomUUID();
    const binding = await provisionStorage({ admin, owner, password: dataPassword, migrations });
    spaceStorage = await openStorage({ binding: spaceBinding, migrations: spaceMigrations, backend: createFileBackend({ id: 'space', root: join(root, 'space-files') }) });
    const backend = createFileBackend({ id: 'data', root: join(root, 'data-files') });
    storage = await openStorage({ binding, migrations, backend });
    const spaces = createSpaces(spaceStorage);
    const identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'action-student', password: randomUUID() });
    await spaces.bindMember(identity, { ...owner, version: 1 });
    const receiver = controlledActionReceiver();
    const learning = createLearningData(storage, spaces, undefined, { receivers: [receiver] });
    const activity = await learning.create(identity, { requestId: randomUUID(), goal: '真实业务存储与可控接收边界', question: '', references: [] });
    const input = question => ({ requestId: randomUUID(), scope: { environmentId, spaceId: identity.spaceId,
      principalId: identity.principalId, activityId: activity.activityId }, receiver: receiver.identity,
      draft: { token: randomUUID(), question, references: [], bases: [] }, works: [], evidence: [] });
    await run({ learning, identity, activityId: activity.activityId, input, receiver, storage, spaces,
      async upgrade() {
        await storage.participant().closeWrites(); await storage.participant().closeDispatch();
        await storage.participant().drain(); await storage.close();
        await provisionStorage({ admin, owner, password: dataPassword, migrations: learningMigrations });
        storage = await openStorage({ binding, migrations: learningMigrations, backend });
        await storage.participant().resume();
        return createLearningData(storage, spaces, undefined, { receivers: [receiver] });
      } });
  } finally { await Promise.allSettled([storage?.close(), spaceStorage?.close()]); await runtime.stop(); }
}

test('lost receiver replies are queried by the original identity and workspace confirmation never accepts a business action', { timeout: 180000 }, async () => {
  await ownedLearning(async ({ learning, identity, activityId, input, receiver, storage, spaces }) => {
    const action = input('回答固定问题');
    const prepared = await learning.intents.prepare(identity, activityId, action);
    assert.equal(prepared.state, 'prepared');
    receiver.loseNextReply();
    const unknown = await learning.intents.dispatch(identity, activityId, action.requestId);
    assert.equal(unknown.state, 'dispatched');
    assert.equal(unknown.receipt, null);
    const restarted = createLearningData(storage, spaces, undefined, { receivers: [receiver] });
    const accepted = await restarted.intents.dispatch(identity, activityId, action.requestId);
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.receipt.requestId, action.requestId);
    assert.equal(accepted.receipt.inputDigest, prepared.inputDigest);
    assert.deepEqual(receiver.acceptedInput(action.requestId), action);
    assert.deepEqual(receiver.acceptedIds(), [action.requestId]);
    assert.equal((await restarted.intents.dispatch(identity, activityId, action.requestId)).receipt.receiptId, accepted.receipt.receiptId);
  });
});

test('durable cancellation wins before dispatch, and late acceptance is never described as withdrawal', { timeout: 180000 }, async () => {
  await ownedLearning(async ({ learning, identity, activityId, input, receiver }) => {
    const stopped = input('发出之前取消');
    await learning.intents.prepare(identity, activityId, stopped);
    assert.equal((await learning.intents.cancel(identity, activityId, stopped.requestId)).state, 'cancelled');
    assert.equal((await learning.intents.dispatch(identity, activityId, stopped.requestId)).state, 'cancelled');
    assert.equal(receiver.acceptedInput(stopped.requestId), undefined);

    const unknown = input('断网时不能假装撤回');
    await learning.intents.prepare(identity, activityId, unknown);
    receiver.offline(true);
    assert.equal((await learning.intents.dispatch(identity, activityId, unknown.requestId)).state, 'dispatched');
    const requested = await learning.intents.cancel(identity, activityId, unknown.requestId);
    assert.equal(requested.state, 'dispatched'); assert.equal(requested.cancelRequested, true);
    receiver.offline(false);
    assert.equal((await learning.intents.dispatch(identity, activityId, unknown.requestId)).state, 'cancelled');
    assert.equal(receiver.acceptedInput(unknown.requestId), undefined);

    const accepted = input('已经被接受');
    await learning.intents.prepare(identity, activityId, accepted);
    receiver.loseNextReply();
    assert.equal((await learning.intents.dispatch(identity, activityId, accepted.requestId)).state, 'dispatched');
    const settled = await learning.intents.cancel(identity, activityId, accepted.requestId);
    assert.equal(settled.state, 'accepted');
    assert.equal(settled.receipt.state, 'accepted');

    const racing = input('真正与派发竞争');
    await learning.intents.prepare(identity, activityId, racing);
    const release = receiver.holdAccept();
    const delivering = learning.intents.dispatch(identity, activityId, racing.requestId);
    while ((await learning.intents.read(identity, activityId, racing.requestId)).state !== 'dispatched') await new Promise(r => setTimeout(r, 10));
    const cancelled = await learning.intents.cancel(identity, activityId, racing.requestId);
    assert.equal(cancelled.state, 'cancelled');
    release();
    assert.equal((await delivering).state, 'cancelled');
    assert.ok(!receiver.acceptedIds().includes(racing.requestId));
  });
});

test('an in-flight action never leaks through another member or an altered authenticated scope', { timeout: 180000 }, async () => {
  await ownedLearning(async ({ learning, identity, activityId, input, receiver, storage, spaces }) => {
    const other = await spaces.createMember({ requestId: randomUUID(), loginName: 'other-student', password: randomUUID() });
    await spaces.bindMember(other, { ...storage.owner, version: 1 });
    const otherActivity = await learning.create(other, { requestId: randomUUID(), goal: '另一个人的活动', question: '', references: [] });
    const action = input('只能归原来的主体');
    await learning.intents.prepare(identity, activityId, action);
    await assert.rejects(learning.intents.prepare(identity, activityId,
      { ...action, requestId: randomUUID(), scope: { ...action.scope, principalId: other.principalId } }), { code: 'forbidden' });
    const release = receiver.holdAccept();
    const active = learning.intents.dispatch(identity, activityId, action.requestId);
    try {
      while ((await learning.intents.read(identity, activityId, action.requestId)).state !== 'dispatched') await new Promise(r => setTimeout(r, 10));
      await assert.rejects(learning.intents.dispatch(other, otherActivity.activityId, action.requestId), { code: 'missing' });
      await assert.rejects(learning.intents.read(other, activityId, action.requestId), { code: 'missing' });
    } finally { release(); await active; }
    await spaces.setMembership({ requestId: randomUUID(), principalId: identity.principalId, active: false });
    await assert.rejects(learning.intents.dispatch(identity, activityId, action.requestId), { code: 'forbidden' });
  });
});

test('production maintenance drains dispatch and full recovery preserves accepted facts, cancelled requests and fixed resources', { timeout: 300000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-action-maintenance-'));
  const sourceRoot = join(directory, 'source'), targetRoot = join(directory, 'restored');
  const source = openProductRuntime({ root: sourceRoot, resources });
  const target = openProductRuntime({ root: targetRoot, resources });
  const receiver = controlledActionReceiver('maintenance-receiver');
  let sourceHost, targetHost, release = () => {};
  try {
    await source.install({ profile: 'local' });
    const application = context => createProductLearningApplication(context, { receivers: [receiver] });
    sourceHost = await createProductRuntimeHost({ root: sourceRoot, createApplication: application });
    const api = async (endpoint, path, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + path, endpoint), { headers: {
        'content-type': 'application/json', 'x-xj-space': 'personal', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const activity = (await api(sourceHost.endpoint, 'activities', { requestId: randomUUID(), goal: '维护与真实接收记录', question: '', references: [] })).value;
    const scope = { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
      principalId: activity.identity.principalId, activityId: activity.activityId };
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: '固定资源', kind: 'resource', encoding: 'base64',
      mediaType: 'application/octet-stream', value: 'AAECAwQF' };
    const first = { requestId: randomUUID(), scope, receiver: receiver.identity,
      draft: { token: randomUUID(), question: '关闸前接收的原动作', references: [], bases: [] }, works: [file], evidence: [] };
    const pending = { ...first, requestId: randomUUID() };
    const path = 'intents/' + activity.activityId;
    assert.equal((await api(sourceHost.endpoint, path, first)).status, 200);
    assert.equal((await api(sourceHost.endpoint, path, pending)).status, 200);
    release = receiver.holdAccept();
    const dispatched = api(sourceHost.endpoint, path + '/' + first.requestId + '/dispatch', {});
    while ((await api(sourceHost.endpoint, path + '/' + first.requestId)).value.state !== 'dispatched') await new Promise(r => setTimeout(r, 10));
    const entering = sourceHost.maintenance.enter('action-test');
    while (!['draining', 'maintenance'].includes(sourceHost.maintenance.status().phase)) await new Promise(r => setTimeout(r, 10));
    assert.equal((await api(sourceHost.endpoint, path + '/' + pending.requestId + '/dispatch', {})).status, 503);
    assert.deepEqual(receiver.acceptedIds(), []);
    release(); await dispatched;
    const closed = await entering;
    assert.equal(closed.safeToStop, true);
    await sourceHost.maintenance.resume();
    const accepted = await api(sourceHost.endpoint, path + '/' + first.requestId + '/dispatch', {});
    assert.equal(accepted.status, 200); assert.equal(accepted.value.state, 'accepted');
    assert.deepEqual(receiver.acceptedIds(), [first.requestId]);
    const cancelled = await api(sourceHost.endpoint, path + '/' + pending.requestId + '/cancel', {});
    assert.equal(cancelled.value.state, 'cancelled');
    const originalNamespace = sourceHost.environment.clientNamespace;
    const key = randomBytes(32), backupDirectory = join(directory, 'backups');
    await source.setCredential('action-recovery-key', key.toString('base64'));
    const backup = await source.recovery.backup({ directory: backupDirectory, recoveryKeyRef: 'action-recovery-key', leaveClosed: true });
    assert.equal(backup.services.length, 5);
    const restored = await restoreProductRecovery({ root: targetRoot, resources, backupDirectory: join(backupDirectory, backup.backupId), key });
    for (const owner of restored.owners) await owner.close?.();
    targetHost = await createProductRuntimeHost({ root: targetRoot, createApplication: application });
    assert.equal((await targetHost.status()).state, 'maintenance');
    await target.recovery.takeover({ sourceRoot, receivers: [] });
    assert.notEqual(targetHost.environment.clientNamespace, originalNamespace);
    for (const expected of [accepted.value, cancelled.value]) {
      const found = await api(targetHost.endpoint, path + '/' + expected.input.requestId);
      assert.equal(found.status, 200); assert.deepEqual(found.value, expected);
    }
    assert.equal((await api(targetHost.endpoint, path + '/' + first.requestId + '/dispatch', {},
      { 'x-xj-namespace': originalNamespace })).status, 403);
    const redispatched = await api(targetHost.endpoint, path + '/' + first.requestId + '/dispatch', {},
      { 'x-xj-namespace': targetHost.environment.clientNamespace }); assert.equal(redispatched.value.receipt?.receiptId, accepted.value.receipt.receiptId, JSON.stringify(redispatched.value));
    assert.deepEqual(receiver.acceptedIds(), [first.requestId]);
  } finally {
    release(); await targetHost?.stop().catch(() => {}); await sourceHost?.stop().catch(() => {});
  }
});

test('explicit owner migration preserves an actual v4 question draft and work bytes before admitting v5 actions', { timeout: 180000 }, async () => {
  await ownedLearning(async ({ learning, identity, activityId, input, upgrade }) => {
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: '迁移前.c', kind: 'code',
      encoding: 'utf8', mediaType: 'text/plain', value: '\uFEFF// 原有 v4 内容\r\nint main() { return 0; }\r\n' };
    const work = await learning.works.sync(identity, activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] });
    const empty = await learning.drafts.read(identity, activityId);
    const reference = { referenceId: randomUUID(), source: { kind: 'work', objectId: file.objectId, contentId: file.contentId },
      range: { kind: 'code', start: 0, end: file.value.length }, copy: file.value, sourceName: file.name };
    const draft = await learning.drafts.sync(identity, activityId, { requestId: randomUUID(), draftId: empty.draftId,
      baseRevision: 0, question: '迁移前的真实草稿', references: [reference], bases: [] });
    const migrated = await upgrade();
    assert.deepEqual(await migrated.works.read(identity, activityId), work);
    assert.deepEqual(await migrated.drafts.read(identity, activityId), draft);
    assert.deepEqual(await migrated.drafts.revision(identity, activityId, draft.revisionId), draft);
    const action = input(draft.question); action.draft.references = [reference]; action.works = [file];
    const prepared = await migrated.intents.prepare(identity, activityId, action);
    assert.equal(prepared.state, 'prepared');
    await migrated.validate();
  }, learningMigrations.filter(migration => migration.version <= 4));
});
