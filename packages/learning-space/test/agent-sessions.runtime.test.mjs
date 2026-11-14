import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createLearningData, learningMigrations } from '../dist/learning-data/index.js';
import { agentSessionMigration, createAgentSessions, validateAgentSessions } from '../dist/learning-data/agent-sessions.js';

const identity = () => ({ environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' });
const owner = () => ({ version: 1, connectionId: randomUUID(), installationId: randomUUID(), delivery: 'service',
  grantId: randomUUID(), executionGrantId: randomUUID(), target: { environmentId: randomUUID(), serviceId: randomUUID(),
    unit: 'teaching-agent', endpoint: 'https://agent.example.test', protocolVersion: 1, capabilities: [] } });
const home = (extra = {}) => ({ requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant', ...extra });

async function fixture(t) {
  const pg = await nativeFixture(), handles = [];
  t.after(async () => { try { for (const handle of handles.reverse()) await handle.close(); } finally { await pg.close(); } });
  const migrations = [...learningMigrations.filter(migration => migration.version < 31), agentSessionMigration];
  const options = { admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID() };
  // Exercise an incremental upgrade from the existing data owner, not a session-only test schema.
  const previous = migrations.filter(migration => migration.version < 31);
  const binding = await provisionStorage({ ...options, migrations: previous });
  const backend = createFileBackend({ id: 'files', root: pg.root + '/objects' });
  const old = await openStorage({ binding, backend, migrations: previous }); handles.push(old);
  await old.participant().closeWrites(); await old.participant().closeDispatch();
  await provisionStorage({ ...options, migrations });
  const target = { ...options.owner, version: 1 }, actor = identity();
  let allowed = true, bindingOwner = owner();
  const authorize = async () => { if (!allowed) throw new StorageError('forbidden'); };
  async function open() {
    const storage = await openStorage({ binding, backend, migrations }); handles.push(storage);
    const data = createLearningData(storage, { resolveBinding: async () => { await authorize(); return target; } });
    const sessions = createAgentSessions(storage, { authorize, openActivity: data.open, resolveOwner: async () => bindingOwner });
    return { storage, data, sessions };
  }
  const first = await open(); await first.storage.participant().resume();
  return { ...first, actor, target, open, authorize,
    deny: () => { allowed = false; }, rebind: () => { bindingOwner = owner(); return bindingOwner; } };
}

test('home sessions persist independently without manufacturing activities', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = home();
  const session = await f.sessions.create(f.actor, input);
  assert.equal(session.sessionId, input.sessionId);
  assert.deepEqual(session.identity, f.actor);
  assert.equal(session.workspace, undefined);
  assert.equal(session.state, 'initializing');
  assert.equal(session.readyAt, null);
  assert.deepEqual([session.title, session.pinned, session.archived, session.deleted], [null, false, false, false]);
  assert.deepEqual(await f.data.list(f.actor), []);
  const reopened = await f.open();
  assert.deepEqual(await reopened.sessions.read(f.actor, input.sessionId), session);
  await reopened.sessions.create(f.actor, home());
  assert.equal((await f.sessions.list(f.actor)).length, 2);
  assert.deepEqual(await f.data.list(f.actor), []);
});

test('the first owner survives rebinding and concurrent retries; conflicting creation identities fail', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = home({ title: '初始会话' }), first = await f.sessions.create(f.actor, input);
  const rebound = f.rebind(), peer = await f.open();
  assert.notDeepEqual(first.owner, rebound);
  for (const session of await Promise.all([f.sessions.create(f.actor, input), peer.sessions.create({ ...f.actor, name: '更名' }, input)]))
    assert.deepEqual(session.owner, first.owner);
  assert.deepEqual((await peer.sessions.create(f.actor, home())).owner, rebound);
  for (const changed of [{ ...input, title: '冲突标题' }, { ...input, sessionId: randomUUID() },
    { ...input, requestId: randomUUID() }])
    await assert.rejects(f.sessions.create(f.actor, changed), { code: 'identity-conflict' });
  const brokenResolver = createAgentSessions(peer.storage, { authorize: f.authorize,
    openActivity: peer.data.open, resolveOwner: async () => { throw new Error('new owner unavailable'); } });
  assert.deepEqual((await brokenResolver.create(f.actor, input)).owner, first.owner);
  await assert.rejects(brokenResolver.create(f.actor, { ...input, requestId: randomUUID() }), { code: 'identity-conflict' });
  const simultaneous = home();
  const creations = await Promise.all([f.sessions.create(f.actor, simultaneous), peer.sessions.create(f.actor, simultaneous)]);
  assert.deepEqual(creations[0], creations[1]);
  assert.equal((await f.sessions.list(f.actor)).length, 3);
});

test('workspace sessions use a real authorized activity and exact learning target, with one default per workspace', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const activity = await f.data.create(f.actor, { requestId: randomUUID(), goal: '学习项目', question: '', references: [] });
  const input = { ...home(), scenario: 'workspace-assistant', workspace: { activityId: activity.activityId, target: activity.target } };
  for (const changed of [
    { ...input, workspace: { ...input.workspace, target: { ...activity.target, serviceId: randomUUID() } } },
    { ...input, workspace: { ...input.workspace, target: { ...activity.target, environmentId: randomUUID() } } },
  ]) await assert.rejects(f.sessions.create(f.actor, changed), { code: 'forbidden' });
  await assert.rejects(f.sessions.create(f.actor, { ...input, workspace: { ...input.workspace, activityId: randomUUID() } }), { code: 'missing' });
  const other = { ...f.actor, principalId: randomUUID() };
  await assert.rejects(f.sessions.create(other, input), error => ['forbidden', 'missing'].includes(error.code));
  const created = await f.sessions.create(f.actor, input);
  assert.deepEqual(created.workspace, input.workspace);
  const peer = await f.open();
  const defaults = await Promise.allSettled([f.sessions.create(f.actor, { ...input, ...home(), scenario: 'workspace-assistant' }),
    peer.sessions.create(f.actor, { ...input, ...home(), scenario: 'workspace-assistant' })]);
  assert.ok(defaults.every(result => result.status === 'rejected' && result.reason.code === 'conflict'));
  assert.equal((await peer.sessions.list(f.actor)).length, 1);
  assert.equal((await f.data.list(f.actor)).length, 1);
  const nextActivity = await f.data.create(f.actor, { requestId: randomUUID(), goal: '第二项目', question: '', references: [] });
  const placement = { activityId: nextActivity.activityId, target: nextActivity.target };
  const raced = await Promise.allSettled([f.sessions.create(f.actor, { ...home(), scenario: 'workspace-assistant', workspace: placement }),
    peer.sessions.create(f.actor, { ...home(), scenario: 'workspace-assistant', workspace: placement })]);
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(raced.filter(result => result.status === 'rejected' && result.reason.code === 'conflict').length, 1);
  assert.equal((await peer.sessions.list(f.actor)).length, 2);
});

test('initialization and metadata persist with idempotent receipts and concurrent field updates', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = home(), initial = await f.sessions.create(f.actor, input), peer = await f.open();
  const ready = { requestId: randomUUID(), sessionId: input.sessionId };
  const initialized = await f.sessions.markReady(f.actor, ready);
  assert.equal(initialized.state, 'ready');
  assert.equal(typeof initialized.readyAt, 'string');
  assert.equal(initialized.createdAt, initial.createdAt);
  assert.deepEqual((await peer.sessions.markReady(f.actor, { ...ready, requestId: randomUUID() })).readyAt, initialized.readyAt);
  const title = { requestId: randomUUID(), sessionId: input.sessionId, title: '讨论新标题' };
  const pin = { requestId: randomUUID(), sessionId: input.sessionId, pinned: true };
  await Promise.all([f.sessions.update(f.actor, title), peer.sessions.update(f.actor, pin)]);
  let current = await f.sessions.read(f.actor, input.sessionId);
  assert.equal(current.title, '讨论新标题'); assert.equal(current.pinned, true);
  const archived = { requestId: randomUUID(), sessionId: input.sessionId, archived: true, deleted: true };
  await f.sessions.update(f.actor, archived);
  current = await peer.sessions.update(f.actor, pin);
  assert.deepEqual([current.title, current.pinned, current.archived, current.deleted], ['讨论新标题', true, true, true]);
  assert.deepEqual(await peer.sessions.create(f.actor, input), current);
  assert.deepEqual((await peer.sessions.markReady(f.actor, ready)).readyAt, initialized.readyAt);
  await assert.rejects(f.sessions.update(f.actor, { ...title, title: '同请求不同内容' }), { code: 'identity-conflict' });
  await assert.rejects(f.sessions.update(f.actor, { ...title, sessionId: randomUUID() }), { code: 'identity-conflict' });
  await assert.rejects(f.sessions.markReady(f.actor, { ...ready, sessionId: randomUUID() }), { code: 'identity-conflict' });
  assert.deepEqual((await peer.sessions.read(f.actor, input.sessionId)).owner, initial.owner);
});

test('every operation isolates environment, space, principal and kind, while display names may change', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = home(), original = await f.sessions.create(f.actor, input);
  const renamed = { ...f.actor, name: '新显示名称' };
  assert.deepEqual(await f.sessions.create(renamed, input), original);
  assert.deepEqual(await f.sessions.read(renamed, input.sessionId), original);
  for (const field of ['environmentId', 'spaceId', 'principalId', 'kind']) {
    const other = { ...f.actor, [field]: field === 'kind' ? 'school' : randomUUID() };
    assert.deepEqual(await f.sessions.list(other), []);
    await assert.rejects(f.sessions.read(other, input.sessionId), { code: 'forbidden' });
    await assert.rejects(f.sessions.create(other, input), { code: 'forbidden' });
    await assert.rejects(f.sessions.update(other, { requestId: randomUUID(), sessionId: input.sessionId, title: '越权' }), { code: 'forbidden' });
    await assert.rejects(f.sessions.markReady(other, { requestId: randomUUID(), sessionId: input.sessionId }), { code: 'forbidden' });
    // The same request id is independent across full subjects, including kind.
    const separate = await f.sessions.create(other, { ...input, sessionId: randomUUID() });
    assert.deepEqual(separate.identity, other);
    assert.equal((await f.sessions.list(other)).length, 1);
  }
  assert.equal((await f.sessions.list(f.actor)).length, 1);
  f.deny();
  for (const operation of [() => f.sessions.create(f.actor, input), () => f.sessions.read(f.actor, input.sessionId),
    () => f.sessions.list(f.actor), () => f.sessions.update(f.actor, { requestId: randomUUID(), sessionId: input.sessionId, pinned: true }),
    () => f.sessions.markReady(f.actor, { requestId: randomUUID(), sessionId: input.sessionId })])
    await assert.rejects(operation(), { code: 'forbidden' });
});

test('workspace access is reauthorized for cached creates, reads, lists, updates and initialization', { timeout: 60000 }, async t => {
  const f = await fixture(t), activity = await f.data.create(f.actor, { requestId: randomUUID(), goal: '真实项目', question: '', references: [] });
  const input = { ...home(), scenario: 'workspace-assistant', workspace: { activityId: activity.activityId, target: activity.target } };
  let workspaceAllowed = true;
  const directory = createAgentSessions(f.storage, { authorize: f.authorize,
    openActivity: async (actor, id) => { if (!workspaceAllowed) throw new StorageError('forbidden'); return f.data.open(actor, id); },
    resolveOwner: async (actor, scenario, workspace) => {
      assert.deepEqual(actor, f.actor); assert.equal(scenario, 'workspace-assistant'); assert.deepEqual(workspace, input.workspace);
      return owner();
    } });
  await directory.create(f.actor, input);
  const ready = { requestId: randomUUID(), sessionId: input.sessionId };
  const patch = { requestId: randomUUID(), sessionId: input.sessionId, title: '可见' };
  await directory.markReady(f.actor, ready); await directory.update(f.actor, patch);
  for (const field of ['environmentId', 'spaceId', 'principalId', 'kind']) {
    const wrongActivity = { ...activity, identity: { ...activity.identity, [field]: field === 'kind' ? 'school' : randomUUID() } };
    const malformedHost = createAgentSessions(f.storage, { authorize: f.authorize, openActivity: async () => wrongActivity, resolveOwner: async () => owner() });
    await assert.rejects(malformedHost.read(f.actor, input.sessionId), { code: 'forbidden' });
    await assert.rejects(malformedHost.create(f.actor, { ...input, ...home(), scenario: 'workspace-assistant' }), { code: 'forbidden' });
  }
  const homeSession = await f.sessions.create(f.actor, home());
  workspaceAllowed = false;
  for (const operation of [() => directory.create(f.actor, input), () => directory.read(f.actor, input.sessionId),
    () => directory.update(f.actor, patch), () => directory.markReady(f.actor, ready)])
    await assert.rejects(operation(), { code: 'forbidden' });
  assert.deepEqual(await directory.list(f.actor), [homeSession]);
});

test('restore validates every session, its real workspace parent and creation receipt without live host calls', { timeout: 60000 }, async t => {
  const f = await fixture(t), home = await f.sessions.create(f.actor, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' });
  const activity = await f.data.create(f.actor, { requestId: randomUUID(), goal: '恢复校验', question: '', references: [] });
  const workspace = await f.sessions.create(f.actor, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'workspace-assistant',
    workspace: { activityId: activity.activityId, target: activity.target } });
  f.deny();
  await validateAgentSessions(f.storage);
  const replace = async (session, body) => f.storage.request({ requestId: randomUUID(), fingerprint: 'restore fault fixture' }, async tx => {
    await tx.query('UPDATE agent_session_directory SET body=$2 WHERE session_id=$1', [session.sessionId, body]); return null;
  });
  for (const corrupted of [
    { ...home, identity: { ...home.identity, kind: 'school' } },
    { ...home, owner: { ...home.owner, installationId: 'lost' } },
    { ...home, requestId: randomUUID() },
  ]) {
    await replace(home, corrupted);
    await assert.rejects(validateAgentSessions(f.storage), { code: 'corrupt' });
    await replace(home, home);
  }
  await replace(workspace, { ...workspace, workspace: { ...workspace.workspace, target: { ...activity.target, serviceId: randomUUID() } } });
  await assert.rejects(validateAgentSessions(f.storage), { code: 'corrupt' });
  await replace(workspace, workspace);
  await validateAgentSessions(f.storage);
});
