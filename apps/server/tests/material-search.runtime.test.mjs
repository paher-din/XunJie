import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { provisionStorage, openStorage, createFileBackend } from '@xunjie/storage';
import { spaceMigrations, spaceCourseMigrations, createSpaces, createCourses, createLearningData, learningMigrations } from '@xunjie/learning-space';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to a complete native PostgreSQL 18.6 distribution.');
const sha = value => createHash('sha256').update(value).digest('hex');

test('unified material search returns only authorized fixed-version snippets with real coverage', { timeout: 180000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-wp08-219-search-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin, postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  let spacesStorage;
  try {
    const installed = await runtime.install({ profile: 'local' });
    await runtime.start();
    const { credentialRef, ...connection } = await runtime.database();
    const admin = { ...connection, password: await resolveCredential(root, credentialRef) };
    const provision = (migrations, id) => provisionStorage({ admin, owner: {
      environmentId: installed.environment.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
    const spacesBinding = await provision(spaceMigrations, 'spaces');
    spacesStorage = await openStorage({ binding: spacesBinding, migrations: spaceMigrations,
      backend: createFileBackend({ id: 'spaces', root: join(root, 'spaces') }) });
    const authority = createSpaces(spacesStorage);
    const identity = await authority.personal();
    const learningBinding = await provision(learningMigrations, 'learning');
    const learningStorage = await openStorage({ binding: learningBinding, migrations: learningMigrations,
      backend: createFileBackend({ id: 'learning', root: join(root, 'learning') }) });
    try {
      await authority.bindMember(identity, { ...learningBinding.owner, version: 1 });
      const learning = createLearningData(learningStorage, authority);
      const activity = await learning.create(identity, { requestId: randomUUID(), goal: '检索我的电路笔记', question: '', references: [] });
      const material = async (name, text) => {
        const materialId = randomUUID();
        const saved = await learning.materials.receive(identity, activity.activityId, { requestId: randomUUID(), materialId,
          name, mediaType: 'text/markdown', dataBase64: Buffer.from(text, 'utf8').toString('base64') });
        return { material: saved, reference: { referenceId: randomUUID(), source: { kind: 'personal-material',
          activityId: activity.activityId, materialId, version: 1, sha256: saved.versions[0].sha256 },
          range: { kind: 'text', start: 0, end: text.length }, copy: text, sourceName: name } };
      };
      const first = await material('电路笔记.md', '串联电路电流处处相等，并联电路电压相等。');
      const second = await material('复习.md', '并联电路的支路电流之和等于总电流。\n串联电路只有一条路径。');
      const unrelated = await material('无关.md', '今天练习三角函数。');

      const result = await learning.search.search(identity, activity.activityId,
        { query: '串联', scope: { courseMaterials: true, personalMaterialIds: [first.material.materialId, second.material.materialId, unrelated.material.materialId], skillAttachments: true } },
        { personalReferences: [first.reference, second.reference, unrelated.reference] });
      assert.equal(result.matches.length, 2);
      assert.deepEqual(result.matches.map(item => item.source.label).sort(), ['复习.md', '电路笔记.md'].sort());
      assert.equal(result.coverage.searchedSourceCount, 3);
      assert.equal(result.coverage.sourceCount, 3);
      assert.ok(result.matches.every(item => item.readMethod === 'stored-text' && item.locator.start >= 0));

      // A same-name newer material stays a distinct identity; version 1 snippets never drift.
      const renamed = await learning.materials.update(identity, activity.activityId, first.material.materialId,
        { requestId: randomUUID(), materialId: first.material.materialId, expectedVersion: 1, name: '电路笔记.md',
          dataBase64: Buffer.from('这一版不再包含那个关键词。', 'utf8').toString('base64') });
      assert.equal(renamed.currentVersion, 2);
      const fixed = await learning.search.search(identity, activity.activityId,
        { query: '串联', scope: { courseMaterials: false, personalMaterialIds: [first.material.materialId], skillAttachments: false } },
        { personalReferences: [first.reference] });
      assert.equal(fixed.matches.length, 1, 'fixed reference still returns its original version snippet');
      assert.equal(fixed.matches[0].source.version, '1');

      // Removing the active material stops new search use, while the fixed version remains readable through its own owner.
      await learning.materials.remove(identity, activity.activityId, first.material.materialId,
        { requestId: randomUUID(), materialId: first.material.materialId, expectedVersion: 2 });
      const removedSearch = await learning.search.search(identity, activity.activityId,
        { query: '串联', scope: { courseMaterials: false, personalMaterialIds: [first.material.materialId], skillAttachments: false } },
        { personalReferences: [first.reference] });
      assert.equal(removedSearch.matches.length, 0);
      assert.equal(removedSearch.sources[0].state, 'no-access', 'a removed personal source is not reused in a new search');

      // A forged digest must not name or return that source.
      const forged = { ...first.reference, source: { ...first.reference.source, sha256: sha('not the original') } };
      const denied = await learning.search.search(identity, activity.activityId,
        { query: '串联', scope: { courseMaterials: false, personalMaterialIds: [first.material.materialId], skillAttachments: false } },
        { personalReferences: [forged] });
      assert.equal(denied.matches.length, 0);
      assert.equal(denied.sources[0].state, 'no-access');
      assert.equal(denied.sources[0].source, undefined, 'unauthorized source title is never leaked');

      // Another student's activity is not visible through the same keyword.
      const other = await authority.createMember({ requestId: randomUUID(), loginName: 'student-search-b', password: randomUUID() });
      await authority.bindMember(other, { ...learningBinding.owner, version: 1 });
      const otherActivity = await learning.create(other, { requestId: randomUUID(), goal: '另一个活动', question: '', references: [] });
      const cross = await learning.search.search(other, otherActivity.activityId,
        { query: '串联', scope: { courseMaterials: false, personalMaterialIds: [first.material.materialId], skillAttachments: false } },
        { personalReferences: [first.reference] });
      assert.equal(cross.matches.length, 0);
      assert.equal(cross.sources[0].state, 'no-access');
      assert.equal(cross.sources[0].source, undefined, 'another student cannot even name the source');
    } finally { await learningStorage.close(); }
  } finally { if (spacesStorage) await spacesStorage.close(); await runtime.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('course material search returns only the activity release text and stops after access revocation', { timeout: 180000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-wp08-219-course-search-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin, postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  let spacesStorage;
  try {
    const installed = await runtime.install({ profile: 'local' }); await runtime.start();
    const { credentialRef, ...connection } = await runtime.database();
    const admin = { ...connection, password: await resolveCredential(root, credentialRef) };
    const provision = migrations => provisionStorage({ admin, owner: {
      environmentId: installed.environment.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
    const spacesBinding = await provision(spaceCourseMigrations);
    spacesStorage = await openStorage({ binding: spacesBinding, migrations: spaceCourseMigrations,
      backend: createFileBackend({ id: 'spaces', root: join(root, 'spaces') }) });
    const authority = createSpaces(spacesStorage);
    const courses = createCourses(spacesStorage, authority);
    const learningBinding = await provision(learningMigrations);
    const learningStorage = await openStorage({ binding: learningBinding, migrations: learningMigrations,
      backend: createFileBackend({ id: 'learning', root: join(root, 'learning') }) });
    try {
      const password = randomUUID();
      const member = await authority.createMember({ requestId: randomUUID(), loginName: 'search-course-student', password });
      await authority.bindMember(member, { ...learningBinding.owner, version: 1 });
      const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID();
      const bytes = Buffer.from('# ALU 题目\n先列出真值表，再用仿真验证边界输入。', 'utf8');
      const digest = sha(bytes);
      await courses.registerRelease({ formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '检索课程' },
        task: { taskId, title: 'ALU 检索', summary: '' }, release: { releaseId, objectives: ['理解 ALU'],
          requirements: '列出真值表。', helpPolicy: { version: 1, questions: 'allowed', scope: 'course' }, starterWorks: [],
          capabilities: [], materials: [{ materialId, title: 'ALU 题目', path: 'materials/alu.md', mediaType: 'text/markdown',
            access: 'student', sha256: digest, byteLength: bytes.length }] },
        resources: [{ path: 'materials/alu.md', contentBase64: bytes.toString('base64') }] });
      await courses.setAccess({ requestId: randomUUID(), courseId, principalId: member.principalId, active: true });
      const learning = createLearningData(learningStorage, authority, courses);
      const activity = await learning.createCourse(member, { requestId: randomUUID(), releaseId });
      const searched = await learning.search.search(member, activity.activityId, { query: '真值表', scope: { courseMaterials: true, skillAttachments: false } }, {});
      assert.equal(searched.matches.length, 1);
      assert.equal(searched.matches[0].source.kind, 'course-material');
      assert.equal(searched.matches[0].source.label, 'ALU 题目');
      assert.equal(searched.matches[0].readMethod, 'stored-text');
      assert.deepEqual(searched.coverage.kinds, ['course-material']);
      await courses.setAccess({ requestId: randomUUID(), courseId, principalId: member.principalId, active: false });
      await assert.rejects(learning.search.search(member, activity.activityId,
        { query: '真值表', scope: { courseMaterials: true, skillAttachments: false } }, {}), { code: 'forbidden' });
    } finally { await learningStorage.close(); }
  } finally { if (spacesStorage) await spacesStorage.close(); await runtime.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
