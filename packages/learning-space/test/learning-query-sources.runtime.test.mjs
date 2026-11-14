import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createLearningData, learningMigrations } from '../dist/learning-data/index.js';
import { createPersonalProjects } from '../dist/learning-data/personal-projects.js';
import { createLearningQuery } from '../dist/learning-data/learning-query.js';

test('one failed school source construction preserves real local projects and another school owner', { timeout: 60000 }, async t => {
  const pg = await nativeFixture(), handles = [];
  t.after(async () => { try { for (const storage of handles.reverse()) await storage.close(); } finally { await pg.close(); } });
  async function source(sourceId, kind) {
    const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind, name: sourceId };
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, target = { ...owner, version: 1 };
    const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: learningMigrations });
    const storage = await openStorage({ binding, migrations: learningMigrations,
      backend: createFileBackend({ id: sourceId, root: pg.root + '/' + sourceId }) });
    handles.push(storage);
    async function authorize(actor) {
      if (actor.environmentId !== identity.environmentId || actor.spaceId !== identity.spaceId
        || actor.principalId !== identity.principalId || actor.kind !== identity.kind) throw new StorageError('forbidden');
    }
    const learning = createLearningData(storage, { resolveBinding: async actor => { await authorize(actor); return target; } });
    const personalProjects = createPersonalProjects(storage, { authorize, learning });
    return { sourceId, identity, target, learning, ...(kind === 'personal' ? { personalProjects } : {}) };
  }
  const local = await source('local-personal', 'personal'), schoolA = await source('school-a', 'school'), schoolB = await source('school-b', 'school');
  const project = await local.personalProjects.create(local.identity, { operationId: randomUUID(), sourceSessionId: randomUUID(), inputId: randomUUID(),
    content: { title: '本机排序项目', goal: '理解排序', stages: [{ title: '练习', goal: '比较结果' }], materialRefs: [] } });
  const activityA = await schoolA.learning.create(schoolA.identity, { requestId: randomUUID(), goal: '学校 A 排序', question: '', references: [] });
  const activityB = await schoolB.learning.create(schoolB.identity, { requestId: randomUUID(), goal: '学校 B 排序', question: '', references: [] });
  let current = [local, schoolA, schoolB];
  const query = createLearningQuery({ sources: async () => current });
  const original = await query.listLearningTasks();
  assert.equal(original.items.length, 3, 'the legacy source array still reads all three real owners');
  const oldReference = original.items.find(item => item.reference.sourceId === schoolA.sourceId).reference;
  await schoolA.learning.works.sync(schoolA.identity, activityA.activityId, { requestId: randomUUID(), baseRevision: 0, files: [{
    objectId: randomUUID(), contentId: randomUUID(), name: '学校作品.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: '学校 A 固定排序作品',
  }] });
  const oldWorkReference = (await query.searchLearning({ query: '固定排序作品', kinds: ['work'] })).items[0].reference;
  const failure = { sourceId: schoolA.sourceId, kind: 'activity', code: 'unavailable' };
  current = { sources: [local, schoolB], unavailable: [failure] };
  const page = await query.listLearningTasks();
  assert.deepEqual(new Set(page.items.map(item => item.reference.objectId)), new Set([project.projectId, activityB.activityId]));
  assert.deepEqual(page.unavailable, [failure]);
  const found = await query.searchLearning({ query: '排序', kinds: ['personal-project', 'activity'] });
  assert.deepEqual(new Set(found.items.map(item => item.reference.objectId)), new Set([project.projectId, activityB.activityId]));
  assert.deepEqual(found.unavailable, [failure]);
  const localDetail = await query.readLearning({ reference: page.items.find(item => item.reference.sourceId === local.sourceId).reference });
  assert.ok(localDetail.text.includes('本机排序项目'));
  const schoolDetail = await query.readLearning({ reference: page.items.find(item => item.reference.sourceId === schoolB.sourceId).reference });
  assert.ok(schoolDetail.text.includes('学校 B 排序'));
  await assert.rejects(query.readLearning({ reference: oldReference }), { code: 'unavailable' });
  // Construction failed for the entire source: its work reference keeps the same error as its task reference.
  await assert.rejects(query.readLearning({ reference: oldWorkReference }), { code: 'unavailable' });
  current = { sources: [local, schoolB], unavailable: [{ ...failure, code: 'forbidden' }] };
  await assert.rejects(query.readLearning({ reference: oldReference }), { code: 'forbidden' });
  assert.equal((await query.listLearningTasks()).items.length, 2);
  assert.ok((await schoolA.learning.open(schoolA.identity, activityA.activityId)).goal.includes('学校 A'));
});
