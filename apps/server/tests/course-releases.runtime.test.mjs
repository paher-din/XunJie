import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { spaceMigrations, spaceCourseMigrations, createSpaces, createCourses, learningMigrations, createLearningData } from '@xunjie/learning-space';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to a complete native PostgreSQL 18.6 distribution.');

const resources = () => ({
  nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6', postgresBin,
  webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)),
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function releaseFixture({ courseId, taskId, releaseId, requirements = '实现四种运算并用仿真验证边界输入。',
  studentText = '# ALU 题目\n完成 4 位加减与逻辑运算。', privateText = '# 教师私有测试\n仅教师可见。' }) {
  const student = Buffer.from(studentText), hidden = Buffer.from(privateText);
  const studentMaterialId = randomUUID(), privateMaterialId = randomUUID(), workId = randomUUID();
  return {
    ids: { studentMaterialId, privateMaterialId, workId },
    manifest: {
      formatVersion: 1, requestId: randomUUID(),
      course: { courseId, name: '数字逻辑与部件设计' },
      task: { taskId, title: '设计并验证 4 位 ALU', summary: '从题目到仿真验证。' },
      release: {
        releaseId, objectives: ['理解 4 位 ALU 的行为', '用仿真验证边界输入'], requirements,
        materials: [
          { materialId: studentMaterialId, title: 'ALU 题目', path: 'materials/alu.md', mediaType: 'text/markdown',
            access: 'student', sha256: sha256(student), byteLength: student.byteLength },
          { materialId: privateMaterialId, title: '教师私有测试', path: 'materials/tests.md', mediaType: 'text/markdown',
            access: 'private', sha256: sha256(hidden), byteLength: hidden.byteLength },
        ],
        starterWorks: [{ workId, title: 'alu.sv 起始工程', description: '按题目补全模块', materialId: studentMaterialId }],
        capabilities: [{ kind: 'component', objectId: randomUUID(), version: 2 }],
      },
      resources: [
        { path: 'materials/alu.md', contentBase64: student.toString('base64') },
        { path: 'materials/tests.md', contentBase64: hidden.toString('base64') },
      ],
    },
  };
}

async function withRuntime(t, run) {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-course-'));
  const runtime = openProductRuntime({ root, resources: resources() });
  try {
    await runtime.install({ profile: 'local' });
    const started = await runtime.start();
    await run({ root, runtime, endpoint: started.endpoint, environmentId: started.environment.environmentId });
  } finally { await runtime.stop().catch(() => {}); }
}

test('course releases pin versions, project only open material and follow current eligibility', { timeout: 300000 }, async t => {
  await withRuntime(t, async ({ root, runtime, endpoint }) => {
    const control = await resolveCredential(root, 'control');
    const admin = { authorization: `Bearer ${control}` };
    const api = async (path, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + path, endpoint), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, value: await response.json().catch(() => null) };
    };
    const courseId = randomUUID(), taskId = randomUUID(), releaseOne = randomUUID();
    const v1 = releaseFixture({ courseId, taskId, releaseId: releaseOne });
    const imported = await api('manage/course-import', v1.manifest, admin);
    assert.equal(imported.status, 200);
    assert.equal(imported.value.releaseId, releaseOne);
    assert.equal(imported.value.materials.length, 2);
    assert.equal(imported.value.materials.find(item => item.access === 'private').title, '教师私有测试');
    assert.deepEqual((await api('manage/course-import', v1.manifest, admin)).value, imported.value);
    const retryWithoutFiles = structuredClone(v1.manifest);
    retryWithoutFiles.resources = [];
    assert.deepEqual((await api('manage/course-import', retryWithoutFiles, admin)).value, imported.value);
    assert.equal((await api('manage/course-result', { requestId: v1.manifest.requestId }, admin)).value.contentDigest,
      imported.value.contentDigest);
    const changed = structuredClone(v1.manifest);
    changed.release.requirements += ' 追加要求。';
    assert.equal((await api('manage/course-import', changed, admin)).status, 409);
    const duplicateRelease = structuredClone(v1.manifest);
    duplicateRelease.requestId = randomUUID();
    duplicateRelease.release.requirements += ' 另一个用途。';
    assert.equal((await api('manage/course-import', duplicateRelease, admin)).status, 409);

    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'course-student', password }, admin);
    assert.equal(member.status, 200);
    const login = async (loginName, pass) => {
      const logged = await api('login', { loginName, password: pass });
      assert.equal(logged.status, 200);
      return { cookie: logged.headers.get('set-cookie').split(';')[0], identity: logged.value.identity };
    };
    const first = await login('course-student', password);
    const cookie = first.cookie, principalId = first.identity.principalId;
    assert.deepEqual((await api('courses', undefined, { cookie })).value, { courses: [] });
    assert.equal((await api('releases/' + releaseOne, undefined, { cookie })).status, 403);
    assert.equal((await api('releases/' + releaseOne + '/materials/' + v1.ids.studentMaterialId, undefined, { cookie })).status, 403);

    assert.equal((await api('manage/course-access', { requestId: randomUUID(), courseId, principalId, active: true }, admin)).status, 200);
    const catalog = await api('courses', undefined, { cookie });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.value.courses.length, 1);
    assert.equal(catalog.value.courses[0].tasks[0].releases[0].releaseId, releaseOne);
    const release = await api('releases/' + releaseOne, undefined, { cookie });
    assert.equal(release.status, 200);
    assert.equal(release.value.materials.length, 1);
    assert.equal(release.value.materials[0].materialId, v1.ids.studentMaterialId);
    assert.ok(!JSON.stringify(release.value).includes('教师私有测试'));
    assert.ok(!JSON.stringify(catalog.value).includes('教师私有测试'));
    assert.equal((await api('releases/' + releaseOne + '/materials/' + v1.ids.privateMaterialId, undefined, { cookie })).status, 404);
    assert.equal((await api('releases/' + releaseOne + '/materials/' + randomUUID(), undefined, { cookie })).status, 404);
    assert.equal((await api('releases/' + randomUUID(), undefined, { cookie })).status, 404);
    const material = await api('releases/' + releaseOne + '/materials/' + v1.ids.studentMaterialId, undefined, { cookie });
    assert.equal(material.status, 200);
    assert.equal(Buffer.from(material.value.contentBase64, 'base64').toString('utf8'), '# ALU 题目\n完成 4 位加减与逻辑运算。');
    assert.ok(!JSON.stringify(material.value).includes('教师私有测试'));

    const activityRequest = randomUUID();
    const created = await api('course-activities', { requestId: activityRequest, releaseId: releaseOne }, { cookie });
    assert.equal(created.status, 200);
    assert.equal(created.value.course.releaseId, releaseOne);
    assert.equal(created.value.course.contentDigest, imported.value.contentDigest);
    assert.equal(created.value.course.materials.length, 1);
    assert.ok(!JSON.stringify(created.value).includes('教师私有测试'));
    assert.deepEqual((await api('course-activities', { requestId: activityRequest, releaseId: releaseOne }, { cookie })).value,
      created.value);
    assert.deepEqual((await api('course-activity-results/' + activityRequest, undefined, { cookie })).value,
      { requestId: activityRequest, state: 'accepted', activity: created.value, error: null });

    const releaseTwo = randomUUID();
    const v2 = releaseFixture({ courseId, taskId, releaseId: releaseTwo, requirements: '第二版要求：加入减法扩展。' });
    assert.equal((await api('manage/course-import', v2.manifest, admin)).status, 200);
    assert.equal((await api('course-activities', { requestId: activityRequest, releaseId: releaseTwo }, { cookie })).status, 409);
    assert.equal((await api('activities/' + created.value.activityId, undefined, { cookie })).value.course.releaseId, releaseOne);
    assert.equal((await api('course-activities', { requestId: randomUUID(), releaseId: releaseTwo }, { cookie })).status, 200);
    assert.equal((await api('releases/' + releaseTwo, undefined, { cookie })).value.requirements, '第二版要求：加入减法扩展。');
    assert.equal((await api(`releases/${releaseOne}/materials/${v2.ids.studentMaterialId}`, undefined, { cookie })).status, 404);

    await runtime.stop(); await runtime.start();
    const reopened = await api('activities/' + created.value.activityId, undefined, { cookie });
    assert.equal(reopened.status, 200);
    assert.deepEqual(reopened.value, created.value);
    assert.equal((await api('courses', undefined, { cookie })).status, 200);

    const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
    const courseService = environment.services.find(service => service.unit === 'space-course');
    const materialPath = join(root, 'learning-resources', 'space-course', environment.environmentId,
      courseService.serviceId, v1.ids.studentMaterialId);
    const originalMaterial = await readFile(materialPath);
    await unlink(materialPath);
    assert.equal((await api(`releases/${releaseOne}/materials/${v1.ids.studentMaterialId}`, undefined, { cookie })).status, 404);
    assert.equal((await api('activities/' + created.value.activityId, undefined, { cookie })).status, 404);
    assert.equal((await api('courses', undefined, { cookie })).status, 200);
    const missingList = await api('activities', undefined, { cookie });
    assert.equal(missingList.value.length, 2);
    assert.deepEqual(new Set(missingList.value.map(activity => activity.course.releaseId)), new Set([releaseOne, releaseTwo]));
    const missingRequest = randomUUID();
    assert.equal((await api('course-activities', { requestId: missingRequest, releaseId: releaseOne }, { cookie })).status, 404);
    assert.deepEqual((await api('course-activity-results/' + missingRequest, undefined, { cookie })).value,
      { requestId: missingRequest, state: 'rejected', activity: null, error: 'missing' });
    await writeFile(materialPath, originalMaterial);
    assert.equal((await api(`releases/${releaseOne}/materials/${v1.ids.studentMaterialId}`, undefined, { cookie })).status, 200);
    assert.equal((await api('activities/' + created.value.activityId, undefined, { cookie })).status, 200);
    const corrupt = Buffer.from(originalMaterial);
    corrupt[corrupt.length - 1] ^= 0xff;
    await writeFile(materialPath, corrupt);
    const corruptMaterial = await api(`releases/${releaseOne}/materials/${v1.ids.studentMaterialId}`, undefined, { cookie });
    assert.equal(corruptMaterial.status, 503);
    assert.equal(corruptMaterial.value.error, 'corrupt');
    const corruptOpen = await api('activities/' + created.value.activityId, undefined, { cookie });
    assert.equal(corruptOpen.status, 503);
    assert.equal(corruptOpen.value.error, 'corrupt');
    const corruptRequest = randomUUID();
    const corruptCreate = await api('course-activities', { requestId: corruptRequest, releaseId: releaseOne }, { cookie });
    assert.equal(corruptCreate.status, 503);
    assert.equal(corruptCreate.value.error, 'corrupt');
    assert.equal((await api('course-activity-results/' + corruptRequest, undefined, { cookie })).value.state, 'rejected');
    assert.equal((await api('activities', undefined, { cookie })).value.length, 2);
    await writeFile(materialPath, originalMaterial);
    assert.equal((await api('activities/' + created.value.activityId, undefined, { cookie })).status, 200);
    assert.equal((await api('activities', undefined, { cookie })).value.length, 2);

    const revoked = await api('manage/course-access', { requestId: randomUUID(), courseId, principalId, active: false }, admin);
    assert.equal(revoked.status, 200);
    assert.equal((await api('activities/' + created.value.activityId, undefined, { cookie })).status, 403);
    assert.deepEqual((await api('courses', undefined, { cookie })).value, { courses: [] });
    assert.equal((await api('releases/' + releaseOne, undefined, { cookie })).status, 403);
    assert.equal((await api('releases/' + releaseOne + '/materials/' + v1.ids.studentMaterialId, undefined, { cookie })).status, 403);
    assert.equal((await api('course-activities', { requestId: activityRequest, releaseId: releaseOne }, { cookie })).status, 403);
    assert.equal((await api('course-activity-results/' + activityRequest, undefined, { cookie })).status, 403);
    const blockedRequest = randomUUID();
    assert.equal((await api('course-activities', { requestId: blockedRequest, releaseId: releaseOne }, { cookie })).status, 403);
    assert.deepEqual((await api('course-activity-results/' + blockedRequest, undefined, { cookie })).value,
      { requestId: blockedRequest, state: 'rejected', activity: null, error: 'forbidden' });
    const autonomous = await api('activities', { requestId: randomUUID(), goal: '撤销课程后仍可自主学习', question: '', references: [] },
      { cookie });
    assert.equal(autonomous.status, 200);
    assert.equal((await api('activities', undefined, { cookie })).value.length, 1);

    assert.equal((await api('manage/course-access', { requestId: randomUUID(), courseId, principalId, active: true }, admin)).status, 200);
    assert.equal((await api('activities/' + created.value.activityId, undefined, { cookie })).status, 200);
    assert.equal((await api('activities', undefined, { cookie })).value.length, 3);

    assert.equal((await api('manage/membership', { requestId: randomUUID(), principalId, active: false }, admin)).status, 200);
    assert.equal((await api('activities/' + created.value.activityId, undefined, { cookie })).status, 403);
    assert.equal((await api('manage/membership', { requestId: randomUUID(), principalId, active: true }, admin)).status, 200);
    assert.equal((await api('activities/' + created.value.activityId, undefined, { cookie })).status, 403);
    const second = await login('course-student', password);
    assert.equal((await api('activities/' + created.value.activityId, undefined, { cookie: second.cookie })).status, 200);
    assert.deepEqual((await api('activities/' + created.value.activityId, undefined, { cookie: second.cookie })).value, created.value);

    const otherPassword = randomUUID();
    assert.equal((await api('manage/members', { requestId: randomUUID(), loginName: 'other-student', password: otherPassword }, admin)).status, 200);
    const other = await login('other-student', otherPassword);
    assert.equal((await api('activities/' + created.value.activityId, undefined, { cookie: other.cookie })).status, 404);
    assert.equal((await api('course-activity-results/' + activityRequest, undefined, { cookie: other.cookie })).value, null);
    assert.equal((await api('releases/' + releaseOne, undefined, { cookie: other.cookie })).status, 403);

    const reusedReleaseId = randomUUID();
    const reuse = structuredClone(v1.manifest);
    reuse.requestId = randomUUID();
    reuse.release.releaseId = reusedReleaseId;
    reuse.release.objectives = ['复用已发布材料并保留固定任务'];
    reuse.release.requirements = '新版本复用同一材料，不改变旧活动。';
    const reused = await api('manage/course-import', reuse, admin);
    assert.equal(reused.status, 200);
    const reusedRelease = await api('releases/' + reusedReleaseId, undefined, { cookie: second.cookie });
    assert.equal(reusedRelease.status, 200);
    assert.equal(reusedRelease.value.materials[0].materialId, v1.ids.studentMaterialId);
    const reusedActivity = await api('course-activities', { requestId: randomUUID(), releaseId: reusedReleaseId }, { cookie: second.cookie });
    assert.equal(reusedActivity.status, 200);
    assert.equal(reusedActivity.value.course.releaseId, reusedReleaseId);
    assert.equal((await api(`releases/${reusedReleaseId}/materials/${v1.ids.studentMaterialId}`, undefined, { cookie: second.cookie })).status, 200);
    assert.equal((await api('activities', undefined, { cookie: second.cookie })).value.length, 4);
  });
});

test('course activities resume across prepared, confirmed and committed stages with one stable activity', { timeout: 300000 }, async t => {
  await withRuntime(t, async ({ root, runtime, environmentId: environment }) => {
    const database = await runtime.database();
    const { credentialRef, ...connection } = database;
    const admin = { ...connection, password: await resolveCredential(root, credentialRef) };
    const spaceBinding = await provisionStorage({ admin, owner: { environmentId: environment, serviceId: randomUUID() },
      password: randomUUID(), migrations: spaceCourseMigrations });
    const dataBinding = await provisionStorage({ admin, owner: { environmentId: environment, serviceId: randomUUID() },
      password: randomUUID(), migrations: learningMigrations });
    const spaceStorage = await openStorage({ binding: spaceBinding, migrations: spaceCourseMigrations,
      backend: createFileBackend({ id: 'space', root: join(root, 'space-files') }) });
    const dataStorage = await openStorage({ binding: dataBinding, migrations: learningMigrations,
      backend: createFileBackend({ id: 'data', root: join(root, 'data-files') }) });
    try {
      const spaces = createSpaces(spaceStorage);
      const courses = createCourses(spaceStorage, spaces);
      const password = randomUUID();
      const member = await spaces.createMember({ requestId: randomUUID(), loginName: 'resume-student', password });
      const target = { ...dataBinding.owner, version: 1 };
      await spaces.bindMember(member, target);
      const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
      const fixture = releaseFixture({ courseId, taskId, releaseId });
      await courses.registerRelease(fixture.manifest);
      await courses.setAccess({ requestId: randomUUID(), courseId, principalId: member.principalId, active: true });

      let failure = 'confirm';
      const flaky = {
        prepare: input => courses.prepare(input),
        confirm: async input => {
          if (failure === 'confirm') { failure = ''; throw new StorageError('unavailable'); }
          if (failure === 'confirmed') { failure = ''; await courses.confirm(input); throw new StorageError('unavailable'); }
          return courses.confirm(input);
        },
        authorize: (identity, pointer) => courses.authorize(identity, pointer),
      };
      const learning = createLearningData(dataStorage, spaces, flaky);
      const requestId = randomUUID();
      await assert.rejects(learning.createCourse(member, { requestId, releaseId }), { code: 'unavailable' });
      assert.equal((await learning.courseResult(member, requestId)).state, 'pending');
      const first = await learning.createCourse(member, { requestId, releaseId });
      assert.equal(first.course.releaseId, releaseId);
      assert.deepEqual(await learning.createCourse(member, { requestId, releaseId }), first);
      assert.equal((await learning.list(member)).length, 1);
      assert.equal((await learning.courseResult(member, requestId)).state, 'accepted');

      failure = 'confirmed';
      const secondRequest = randomUUID();
      await assert.rejects(learning.createCourse(member, { requestId: secondRequest, releaseId }), { code: 'unavailable' });
      assert.equal((await learning.courseResult(member, secondRequest)).state, 'pending');
      const second = await learning.createCourse(member, { requestId: secondRequest, releaseId });
      assert.notEqual(second.activityId, first.activityId);
      assert.equal((await learning.list(member)).length, 2);
      assert.equal((await courses.bindingResult(
        (await learning.courseResult(member, secondRequest)).activity.course.associationId)).state, 'accepted');

      const revoked = randomUUID();
      await courses.setAccess({ requestId: randomUUID(), courseId, principalId: member.principalId, active: false });
      await assert.rejects(learning.createCourse(member, { requestId: revoked, releaseId }), { code: 'forbidden' });
      assert.equal((await learning.courseResult(member, revoked)).state, 'rejected');
      await courses.setAccess({ requestId: randomUUID(), courseId, principalId: member.principalId, active: true });
      assert.equal((await learning.open(member, first.activityId)).course.releaseId, releaseId);

      const otherRelease = randomUUID();
      await courses.registerRelease(releaseFixture({ courseId, taskId, releaseId: otherRelease }).manifest);
      const otherRequest = randomUUID();
      const changed = await learning.createCourse(member, { requestId: otherRequest, releaseId });
      assert.ok(changed.activityId);
      await assert.rejects(learning.createCourse(member, { requestId: otherRequest, releaseId: otherRelease }),
        { code: 'identity-conflict' });
    } finally {
      await Promise.allSettled([spaceStorage.close(), dataStorage.close()]);
    }
  });
});

test('existing owners upgrade to course schema without losing autonomous state', { timeout: 300000 }, async t => {
  await withRuntime(t, async ({ root, runtime, environmentId: environment }) => {
    const database = await runtime.database();
    const { credentialRef, ...connection } = database;
    const admin = { ...connection, password: await resolveCredential(root, credentialRef) };
    const spaceOwner = { environmentId: environment, serviceId: randomUUID() };
    const dataOwner = { environmentId: environment, serviceId: randomUUID() };
    const spacePassword = randomUUID(), dataPassword = randomUUID();
    const oldSpace = await provisionStorage({ admin, owner: spaceOwner, password: spacePassword, migrations: spaceMigrations });
    const oldData = await provisionStorage({ admin, owner: dataOwner, password: dataPassword, migrations: learningMigrations.slice(0, 1) });
    const backend = id => createFileBackend({ id, root: join(root, `${id}-files`) });
    let spaceStorage = await openStorage({ binding: oldSpace, migrations: spaceMigrations, backend: backend('space') });
    let dataStorage = await openStorage({ binding: oldData, migrations: learningMigrations.slice(0, 1), backend: backend('data') });
    const memberPassword = randomUUID();
    let member, legacy;
    try {
      const spaces = createSpaces(spaceStorage);
      member = await spaces.createMember({ requestId: randomUUID(), loginName: 'upgrade-student', password: memberPassword });
      await spaces.bindMember(member, { ...dataOwner, version: 1 });
      const learning = createLearningData(dataStorage, spaces);
      legacy = await learning.create(member, { requestId: randomUUID(), goal: '升级前建立的活动', question: '', references: [] });
      for (const storage of [spaceStorage, dataStorage]) {
        const participant = storage.participant();
        await participant.closeWrites(); await participant.closeDispatch();
      }
    } finally {
      await Promise.allSettled([spaceStorage.close(), dataStorage.close()]);
    }
    await provisionStorage({ admin, owner: spaceOwner, password: spacePassword, migrations: spaceCourseMigrations });
    await provisionStorage({ admin, owner: dataOwner, password: dataPassword, migrations: learningMigrations });
    spaceStorage = await openStorage({ binding: oldSpace, migrations: spaceCourseMigrations, backend: backend('space') });
    dataStorage = await openStorage({ binding: oldData, migrations: learningMigrations, backend: backend('data') });
    await spaceStorage.participant().resume();
    await dataStorage.participant().resume();
    try {
      const spaces = createSpaces(spaceStorage);
      const courses = createCourses(spaceStorage, spaces);
      const learning = createLearningData(dataStorage, spaces, courses);
      assert.deepEqual(await learning.open(member, legacy.activityId), legacy);
      assert.equal((await learning.list(member)).length, 1);
      const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
      await courses.registerRelease(releaseFixture({ courseId, taskId, releaseId }).manifest);
      await courses.setAccess({ requestId: randomUUID(), courseId, principalId: member.principalId, active: true });
      const pinned = await learning.createCourse(member, { requestId: randomUUID(), releaseId });
      assert.equal(pinned.course.releaseId, releaseId);
      assert.equal((await learning.list(member)).length, 2);
      await spaces.validate(); await courses.validate(); await learning.validate();
    } finally {
      await Promise.allSettled([spaceStorage.close(), dataStorage.close()]);
    }
  });
});
