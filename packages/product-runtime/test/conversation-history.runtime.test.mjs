import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as storage from '@xunjie/storage';
import { activitySchema, conversationHistoryItemSchema, conversationHistoryStateSchema,
  conversationHistoryUpdateSchema } from '@xunjie/contracts/learning-data';
import { createLearningData, learningMigrations, validateLearningData, createSpaces, spaceMigrations } from '@xunjie/learning-space';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';

const update = (activityId, action, fields = {}) => ({ requestId: randomUUID(), activityId, action, ...fields });
const archive = (activityId, archived) => ({ requestId: randomUUID(), activityId, archived });
const legacy = activityIds => ({ requestId: randomUUID(), activityIds });
const subject = identity => [identity.environmentId, identity.spaceId, identity.principalId].join('.');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const exec = promisify(execFile);
async function pgTool(fixture, name, args, connection = fixture.admin) {
  try {
    await exec(fixture.tool(name), ['-h', connection.host, '-p', String(connection.port), '-U', connection.user,
      '-d', connection.database, ...args], { env: { ...process.env, PGPASSWORD: connection.password }, timeout: 30000 });
  } catch { throw new Error(`${name} failed`); }
}

test('history wire is strict, trims titles, and preserves deletion tombstones', () => {
  const id = randomUUID(), item = { activityId: id, title: null, pinned: false, deleted: true, archived: true };
  assert.deepEqual(conversationHistoryItemSchema.parse(item), item);
  assert.deepEqual(conversationHistoryStateSchema.parse({ items: [item] }), { items: [item] });
  assert.equal(conversationHistoryUpdateSchema.parse(update(id, 'rename', { title: '  新标题\n' })).title, '新标题');
  assert.equal(conversationHistoryUpdateSchema.safeParse(update(id, 'rename', { title: '字'.repeat(200) })).success, true);
  for (const value of [null, { items: [], extra: true }, { items: [{ ...item, activityId: 'bad' }] },
    { items: [{ ...item, pinned: 1 }] }, { items: [{ ...item, title: 1 }] },
    { items: [{ ...item, deleted: undefined }] }, { items: [{ ...item, extra: true }] }]) {
    assert.equal(conversationHistoryStateSchema.safeParse(value).success, false);
  }
  for (const value of [update(id, 'rename', { title: ' \n\t' }), update(id, 'rename', { title: '字'.repeat(201) }),
    update(id, 'rename', { title: null }), update(id, 'pin', { pinned: 'true' }), update(id, 'pin'),
    update(id, 'delete', { title: 'extra' }), update(id, 'rename', { title: 'a', principalId: id }),
    update(id, 'archive'), { ...update(id, 'delete'), requestId: 'bad' }]) {
    assert.equal(conversationHistoryUpdateSchema.safeParse(value).success, false);
  }
});

test('history owner serializes labels, isolates subjects, and recovers terminal visibility', { timeout: 180000 }, async t => {
  const fixture = await nativeFixture(), handles = [];
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, password = randomUUID();
    const binding = await storage.provisionStorage({ admin: fixture.admin, owner, password, migrations: learningMigrations });
    const backend = storage.createFileBackend({ id: 'history', root: join(fixture.root, 'objects') });
    const options = { binding, migrations: learningMigrations, backend };
    const learningStorage = await storage.openStorage(options); handles.push(learningStorage);
    const peerStorage = await storage.openStorage(options); handles.push(peerStorage);
    const spaceBinding = await storage.provisionStorage({ admin: fixture.admin,
      owner: { environmentId: owner.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: spaceMigrations });
    const spaceStorage = await storage.openStorage({ binding: spaceBinding, migrations: spaceMigrations,
      backend: storage.createFileBackend({ id: 'spaces', root: join(fixture.root, 'spaces') }) }); handles.push(spaceStorage);
    const spaces = createSpaces(spaceStorage), identity = await spaces.personal(), target = { ...owner, version: 1 };
    await spaces.bindMember(identity, target);
    const member = await spaces.createMember({ requestId: randomUUID(), loginName: 'history-member', password: randomUUID() });
    await spaces.bindMember(member, target);
    const learning = createLearningData(learningStorage, spaces), peer = createLearningData(peerStorage, spaces);
    const history = learning.conversationHistory, archives = learning.conversationArchives;
    const create = async (who = identity, data = learning) => data.create(who, {
      requestId: randomUUID(), goal: '保留原始目标', question: '保留原始问题', references: [],
    });
    const item = async (id, api = history, who = identity) => (await api.read(who)).items.find(value => value.activityId === id);
    const mutate = async (sql, values) => learningStorage.request({ requestId: randomUUID(), fingerprint: 'fixture' }, async tx => {
      const result = await tx.query(sql, values); return { count: result.rowCount };
    });
    let courseId;

    await t.test('labels preserve activity, drafts and works; sparse reads merge legacy archives', async () => {
      const activity = await create(), id = activity.activityId;
      assert.equal(await item(id), undefined);
      await archives.set(identity, archive(id, true));
      assert.deepEqual(await item(id), { activityId: id, title: null, pinned: false, deleted: false, archived: true });
      await learning.setStatus(identity, { requestId: randomUUID(), activityId: id, status: 'closed' });
      const original = await learning.open(identity, id), works = await learning.works.read(identity, id), draft = await learning.drafts.read(identity, id);
      await history.update(identity, update(id, 'rename', { title: '  用户标题  ' }));
      await peer.conversationHistory.update(identity, update(id, 'pin', { pinned: true }));
      await archives.set(identity, archive(id, false));
      assert.deepEqual(await item(id), { activityId: id, title: '用户标题', pinned: true, deleted: false, archived: false });
      await history.update(identity, update(id, 'delete'));
      assert.equal((await item(id, peer.conversationHistory)).deleted, true);
      assert.deepEqual(await learning.open(identity, id), original);
      assert.ok((await learning.list(identity)).some(value => value.activityId === id));
      assert.deepEqual(await learning.works.read(identity, id), works);
      assert.deepEqual(await learning.drafts.read(identity, id), draft);
    });

    await t.test('each scope dimension separates rows and request IDs; foreign and course updates are refused', async () => {
      const variants = [identity, { ...identity, environmentId: randomUUID() }, { ...identity, spaceId: randomUUID() },
        { ...identity, principalId: randomUUID() }];
      const authority = { async resolveBinding(who) { assert.ok(variants.some(value => subject(value) === subject(who))); return target; } };
      const scoped = createLearningData(learningStorage, authority), ids = [];
      for (const who of variants) ids.push((await create(who, scoped)).activityId);
      const requestId = randomUUID();
      for (let i = 0; i < variants.length; i++) {
        await scoped.conversationHistory.update(variants[i], { ...update(ids[i], 'rename', { title: `标题${i}` }), requestId });
        assert.equal((await scoped.conversationHistory.read(variants[i])).items.filter(value => ids.includes(value.activityId)).length, 1);
        for (let j = 0; j < variants.length; j++) if (i !== j) {
          for (const action of ['rename', 'pin', 'delete']) {
            await assert.rejects(scoped.conversationHistory.update(variants[i], update(ids[j], action,
              action === 'rename' ? { title: '越界' } : action === 'pin' ? { pinned: true } : {})), { code: 'missing' });
          }
        }
      }
      const base = await create();
      const course = activitySchema.parse({ ...base, activityId: randomUUID(), course: {
        associationId: randomUUID(), courseId: randomUUID(), courseName: '课程', taskId: randomUUID(), taskTitle: '任务',
        releaseId: randomUUID(), contentDigest: 'a'.repeat(64), objectives: ['目标'], requirements: '要求', materials: [],
        starterWorks: [], capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
      } });
      courseId = course.activityId;
      await mutate('INSERT INTO activities VALUES($1,$2,$3,$4,$5)', [courseId, identity.environmentId, identity.spaceId,
        identity.principalId, JSON.stringify(course)]);
      for (const action of ['rename', 'pin', 'delete']) {
        const fields = action === 'rename' ? { title: '课程' } : action === 'pin' ? { pinned: true } : {};
        await assert.rejects(history.update(identity, update(courseId, action, fields)), { code: 'forbidden' });
        await assert.rejects(history.update(identity, update(randomUUID(), action, fields)), { code: 'missing' });
      }
      assert.equal(await item(courseId), undefined);
      await assert.rejects(mutate(`INSERT INTO conversation_labels(activity_id,space_environment_id,space_id,principal_id)
        VALUES($1,$2,$3,$4)`, [base.activityId, identity.environmentId, identity.spaceId, member.principalId]));
    });

    await t.test('retries return current state, conflict on changed input, and concurrent duplicate effects commit once', async () => {
      const id = (await create()).activityId, first = update(id, 'rename', { title: '第一版' });
      await Promise.all([history.update(identity, first), peer.conversationHistory.update(identity, first)]);
      const count = await learningStorage.read(`SELECT count(*)::int AS n FROM _storage_requests WHERE request_id LIKE $1`, [`conversation-history:%:${first.requestId}`]);
      assert.equal(count.rows[0].n, 1);
      await history.update(identity, update(id, 'rename', { title: '第二版' }));
      assert.equal((await history.update(identity, first)).items.find(value => value.activityId === id).title, '第二版');
      await assert.rejects(history.update(identity, { ...first, title: '冲突' }), { code: 'identity-conflict' });
      await assert.rejects(history.update(identity, { requestId: first.requestId, activityId: id, action: 'delete' }), { code: 'identity-conflict' });
      const conflict = update(id, 'pin', { pinned: true });
      const outcomes = await Promise.allSettled([history.update(identity, conflict),
        peer.conversationHistory.update(identity, { ...conflict, pinned: false })]);
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find(value => value.status === 'rejected').reason.code, 'identity-conflict');
      const reopened = await storage.openStorage(options); handles.push(reopened);
      assert.deepEqual(await createLearningData(reopened, spaces).conversationHistory.read(identity), await history.read(identity));
    });

    // Gate only SQL execution. Admission, receipts, blocking and commit all use real PostgreSQL transactions.
    function gated({ before, after } = {}) {
      return createLearningData({ ...learningStorage, request(input, effect) {
        return learningStorage.request(input, tx => effect({ ...tx, async query(sql, values) {
          const lock = /FROM activities[\s\S]*FOR UPDATE/.test(sql);
          if (lock) await before?.();
          const result = await tx.query(sql, values);
          if (lock) await after?.();
          return result;
        } }));
      } }, spaces);
    }
    async function race(first, second) {
      const locked = deferred(), release = deferred(), waiting = deferred();
      const a = Promise.resolve().then(() => first(gated({ after: async () => { locked.resolve(); await release.promise; } })));
      let b;
      try {
        await locked.promise;
        b = Promise.resolve().then(() => second(gated({ before: async () => { waiting.resolve(); } })));
        // Attach a rejection handler before either request can complete.
        const results = Promise.allSettled([a, b]);
        await waiting.promise; release.resolve();
        return await results;
      } finally { release.resolve(); await Promise.allSettled([a, ...(b ? [b] : [])]); }
    }
    await t.test('overlapping rename/pin updates preserve both fields in either lock order', async () => {
      for (const renameFirst of [true, false]) {
        const id = (await create()).activityId;
        const rename = api => api.conversationHistory.update(identity, update(id, 'rename', { title: '并发标题' }));
        const pin = api => api.conversationHistory.update(identity, update(id, 'pin', { pinned: true }));
        const results = await race(renameFirst ? rename : pin, renameFirst ? pin : rename);
        assert.ok(results.every(value => value.status === 'fulfilled'));
        assert.deepEqual(await item(id), { activityId: id, title: '并发标题', pinned: true, deleted: false, archived: false });
      }
    });

    await t.test('delete wins over late rename/pin/import/restore; successful old retries cannot revive it', async () => {
      for (const action of ['rename', 'pin', 'import', 'restore']) {
        for (const deleteFirst of [true, false]) {
          const activity = await create(), id = activity.activityId;
          const earlier = update(id, 'rename', { title: '既有标签' }); await history.update(identity, earlier);
          const remove = api => api.conversationHistory.update(identity, update(id, 'delete'));
          const late = api => action === 'import' ? api.conversationArchives.import(identity, legacy([id]))
            : action === 'restore' ? api.conversationArchives.set(identity, archive(id, false))
            : api.conversationHistory.update(identity, update(id, action, action === 'rename' ? { title: '迟到标题' } : { pinned: true }));
          const results = await race(deleteFirst ? remove : late, deleteFirst ? late : remove);
          assert.equal(results[0].status, 'fulfilled');
          if (deleteFirst && ['rename', 'pin'].includes(action)) {
            assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.code, 'missing');
          } else assert.equal(results[1].status, 'fulfilled');
          assert.equal((await item(id)).deleted, true);
          assert.equal((await history.update(identity, earlier)).items.find(value => value.activityId === id).deleted, true);
          await history.update(identity, update(id, 'delete'));
          for (const next of [update(id, 'rename', { title: '禁止复活' }), update(id, 'pin', { pinned: false })]) {
            await assert.rejects(history.update(identity, next), { code: 'missing' });
          }
          await archives.set(identity, archive(id, true)); await archives.set(identity, archive(id, false));
          await archives.import(identity, legacy([id]));
          assert.equal((await item(id, peer.conversationHistory)).deleted, true);
          assert.deepEqual(await learning.open(identity, id), activity);
        }
      }
    });

    await t.test('current membership and target binding apply to reads, new writes and confirmed retries', async () => {
      const id = (await create(member)).activityId, saved = update(id, 'pin', { pinned: true });
      await history.update(member, saved);
      await spaces.setMembership({ requestId: randomUUID(), principalId: member.principalId, active: false });
      try {
        await assert.rejects(history.read(member), { code: 'forbidden' });
        await assert.rejects(history.update(member, saved), { code: 'forbidden' });
        await assert.rejects(history.update(member, update(id, 'delete')), { code: 'forbidden' });
      } finally { await spaces.setMembership({ requestId: randomUUID(), principalId: member.principalId, active: true }); }
      for (const changed of [{ ...target, serviceId: randomUUID() }, { ...target, environmentId: randomUUID() }]) {
        const wrong = createLearningData(learningStorage, { async resolveBinding() { return changed; } }).conversationHistory;
        await assert.rejects(wrong.read(identity), { code: 'forbidden' });
        await assert.rejects(wrong.update(member, saved), { code: 'forbidden' });
      }
      // A cached receipt also rechecks current object ownership.
      await mutate('UPDATE activities SET principal_id=$2 WHERE id=$1', [id, identity.principalId]).then(
        () => assert.fail('full scope FK must reject ownership changes'), () => {});
    });

    await t.test('validation includes labels and rejects course labels and noncanonical titles', async () => {
      await validateLearningData(learningStorage);
      const id = (await create()).activityId;
      await mutate(`INSERT INTO conversation_labels(activity_id,space_environment_id,space_id,principal_id,title)
        VALUES($1,$2,$3,$4,$5)`, [id, identity.environmentId, identity.spaceId, identity.principalId, ' 不规范 ']);
      await assert.rejects(validateLearningData(learningStorage), { code: 'corrupt' });
      await mutate('UPDATE conversation_labels SET title=$2 WHERE activity_id=$1', [id, '已修复']);
      await mutate(`INSERT INTO conversation_labels(activity_id,space_environment_id,space_id,principal_id,deleted)
        VALUES($1,$2,$3,$4,true)`, [courseId, identity.environmentId, identity.spaceId, identity.principalId]);
      await assert.rejects(validateLearningData(learningStorage), { code: 'corrupt' });
      await mutate('DELETE FROM conversation_labels WHERE activity_id=$1', [courseId]);
      await validateLearningData(learningStorage);
    });

    await t.test('native snapshot/restore retains title/pin/delete and receipts behind closed gates', async () => {
      const destination = await nativeFixture(); let restored;
      try {
        const id = (await create()).activityId, alive = (await create()).activityId;
        const rename = update(id, 'rename', { title: '备份标题' }), pin = update(id, 'pin', { pinned: true });
        const remove = update(id, 'delete');
        await history.update(identity, rename); await history.update(identity, pin); await history.update(identity, remove);
        await history.update(identity, update(alive, 'rename', { title: '可见标题' }));
        await archives.set(identity, archive(id, true));
        const expected = await history.read(identity);
        await learningStorage.participant().closeWrites(); await learningStorage.participant().closeDispatch();
        const dump = join(fixture.root, 'history.dump'); let manifest;
        await learningStorage.snapshot('conversation-history-backup', async snapshot => {
          manifest = snapshot.manifest;
          await pgTool(fixture, 'pg_dump', ['-Fc', '-n', binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump], binding.connection);
        });
        const recoveredBinding = await storage.prepareStorageRestore({ admin: destination.admin, owner, password });
        await pgTool(destination, 'pg_restore', ['--exit-on-error', '--role', recoveredBinding.migratorRole, '--no-owner', '--no-acl', dump]);
        restored = await storage.finalizeStorageRestore({ admin: destination.admin, binding: recoveredBinding,
          migrations: learningMigrations, manifest,
          backend: storage.createFileBackend({ id: 'history', root: join(destination.root, 'objects') }) });
        await validateLearningData(restored);
        const recovered = createLearningData(restored, spaces);
        assert.deepEqual(await recovered.conversationHistory.read(identity), expected);
        for (const saved of [rename, pin, remove]) assert.deepEqual(await recovered.conversationHistory.update(identity, saved), expected);
        await assert.rejects(recovered.conversationHistory.update(identity, update(alive, 'pin', { pinned: true })), { code: 'maintenance' });
        await restored.participant().resume();
        await recovered.conversationArchives.set(identity, archive(id, false));
        await recovered.conversationArchives.import(identity, legacy([id]));
        assert.deepEqual((await recovered.conversationHistory.read(identity)).items.find(value => value.activityId === id),
          { activityId: id, title: '备份标题', pinned: true, deleted: true, archived: false });
        await assert.rejects(recovered.conversationHistory.update(identity, update(id, 'rename', { title: '迟到' })), { code: 'missing' });
        await recovered.conversationHistory.update(identity, update(alive, 'pin', { pinned: true }));
        await validateLearningData(restored);
      } finally { await restored?.close(); await destination.close(); }
    });
  } finally {
    for (const handle of handles.reverse()) await handle.close();
    await fixture.close();
  }
});
