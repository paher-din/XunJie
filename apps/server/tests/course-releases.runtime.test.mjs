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
    const workspacePath = 'workspaces/' + created.value.activityId;
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'course.txt', kind: 'text',
      encoding: 'utf8', mediaType: 'text/plain', value: 'Course work survives release changes.' };
    assert.deepEqual((await api(workspacePath, { requestId: randomUUID(), baseRevision: 0, files: [work] }, { cookie })).value,
      { revision: 1, files: [work] });
    assert.deepEqual((await api('course-activities', { requestId: activityRequest, releaseId: releaseOne }, { cookie })).value,
      created.value);
    assert.deepEqual((await api('course-activity-results/' + activityRequest, undefined, { cookie })).value,
      { requestId: activityRequest, state: 'accepted', activity: created.value, error: null });

    const releaseTwo = randomUUID();
    const v2 = releaseFixture({ courseId, taskId, releaseId: releaseTwo, requirements: '第二版要求：加入减法扩展。' });
    assert.equal((await api('manage/course-import', v2.manifest, admin)).status, 200);
    assert.equal((await api('course-activities', { requestId: activityRequest, releaseId: releaseTwo }, { cookie })).status, 409);
    assert.equal((await api('activities/' + created.value.activityId, undefined, { cookie })).value.course.releaseId, releaseOne);
    assert.equal((await api(workspacePath, undefined, { cookie })).value.files[0].value, work.value);
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
    assert.equal((await api(workspacePath, undefined, { cookie })).status, 403);
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
    let inTransaction = false;
    const guardedData = new Proxy(dataStorage, { get(target, property) {
      if (property === 'request') {
        return (input, effect) => target.request(input, async tx => {
          inTransaction = true;
          try { return await effect(tx); } finally { inTransaction = false; }
        });
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
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
        authorize: (identity, pointer) => {
          if (inTransaction) throw new Error('course authorization must stay outside the activity transaction');
          return courses.authorize(identity, pointer);
        },
      };
      const learning = createLearningData(guardedData, spaces, flaky);
      const requestId = randomUUID();
      await assert.rejects(learning.createCourse(member, { requestId, releaseId }), { code: 'unavailable' });
      assert.equal((await learning.courseResult(member, requestId)).state, 'pending');
      const first = await learning.createCourse(member, { requestId, releaseId });
      assert.equal(first.course.releaseId, releaseId);
      assert.deepEqual(await learning.createCourse(member, { requestId, releaseId }), first);
      assert.equal((await learning.list(member)).length, 1);
      assert.equal((await learning.courseResult(member, requestId)).state, 'accepted');
      const statusRequest = randomUUID();
      const closed = await learning.setStatus(member, { requestId: statusRequest, activityId: first.activityId, status: 'closed' });
      assert.equal(closed.status, 'closed');

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
      await assert.rejects(learning.setStatus(member, { requestId: statusRequest, activityId: first.activityId, status: 'closed' }),
        { code: 'forbidden' });
      await courses.setAccess({ requestId: randomUUID(), courseId, principalId: member.principalId, active: true });
      const replayed = await learning.setStatus(member, { requestId: statusRequest, activityId: first.activityId, status: 'closed' });
      assert.equal(replayed.status, 'closed');
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
    const oldData = await provisionStorage({ admin, owner: dataOwner, password: dataPassword, migrations: learningMigrations.slice(0, 2) });
    const backend = id => createFileBackend({ id, root: join(root, `${id}-files`) });
    let spaceStorage = await openStorage({ binding: oldSpace, migrations: spaceMigrations, backend: backend('space') });
    let dataStorage = await openStorage({ binding: oldData, migrations: learningMigrations.slice(0, 2), backend: backend('data') });
    const memberPassword = randomUUID();
    let member, legacy, legacyWorks;
    try {
      const spaces = createSpaces(spaceStorage);
      member = await spaces.createMember({ requestId: randomUUID(), loginName: 'upgrade-student', password: memberPassword });
      await spaces.bindMember(member, { ...dataOwner, version: 1 });
      const learning = createLearningData(dataStorage, spaces);
      legacy = await learning.create(member, { requestId: randomUUID(), goal: '升级前建立的活动', question: '', references: [] });
      legacyWorks = await learning.works.sync(member, legacy.activityId, { requestId: randomUUID(), baseRevision: 0,
        files: [{ objectId: randomUUID(), contentId: randomUUID(), name: 'before.txt', kind: 'text',
          encoding: 'utf8', mediaType: 'text/plain', value: 'Existing WP02 work.' }] });
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
      assert.deepEqual(await learning.works.read(member, legacy.activityId), legacyWorks);
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

test('installed client forwards course discovery, materials and pinned activities under the school grant', { timeout: 300000 }, async () => {
  const schoolRoot = await mkdtemp(join(tmpdir(), 'xunjie-course-school-'));
  const clientRoot = await mkdtemp(join(tmpdir(), 'xunjie-course-client-'));
  const schoolRuntime = openProductRuntime({ root: schoolRoot, resources: resources() });
  const clientRuntime = openProductRuntime({ root: clientRoot, resources: resources() });
  const call = async (endpoint, path, body, headers = {}) => {
    const response = await fetch(new URL('/api/learning/' + path, endpoint), { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, value: await response.json().catch(() => null) };
  };
  try {
    await schoolRuntime.install({ profile: 'school' });
    const school = await schoolRuntime.start();
    await clientRuntime.install({ profile: 'local' });
    const client = await clientRuntime.start();
    const control = await resolveCredential(schoolRoot, 'control');
    const admin = { authorization: `Bearer ${control}` };
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const fixture = releaseFixture({ courseId, taskId, releaseId });
    assert.equal((await call(school.endpoint, 'manage/course-import', fixture.manifest, admin)).status, 200);
    const password = randomUUID();
    const member = await call(school.endpoint, 'manage/members', { requestId: randomUUID(), loginName: 'client-course', password }, admin);
    assert.equal(member.status, 200);
    assert.equal((await call(school.endpoint, 'manage/course-access', { requestId: randomUUID(), courseId,
      principalId: member.value.principalId, active: true }, admin)).status, 200);
    const logged = await call(school.endpoint, 'login', { loginName: 'client-course', password });
    assert.equal(logged.status, 200);
    const schoolCookie = logged.headers.get('set-cookie').split(';')[0];
    const pending = await call(client.endpoint, 'client/start', { requestId: randomUUID(), schoolEndpoint: school.endpoint });
    assert.equal(pending.status, 200);
    assert.equal((await call(school.endpoint, 'connections/approve', { requestId: pending.value.requestId }, { cookie: schoolCookie })).status, 200);
    const completed = await call(client.endpoint, 'client/complete', { requestId: pending.value.requestId });
    assert.equal(completed.status, 200);
    const connection = completed.value;
    assert.equal(connection.identity.kind, 'school');
    const remote = { 'x-xj-space': 'school:' + connection.connectionId };

    assert.equal((await call(client.endpoint, 'manage/course-import', fixture.manifest, remote)).status, 403);
    const catalog = await call(client.endpoint, 'courses', undefined, remote);
    assert.equal(catalog.status, 200);
    assert.equal(catalog.value.courses[0].tasks[0].releases[0].releaseId, releaseId);
    const release = await call(client.endpoint, 'releases/' + releaseId, undefined, remote);
    assert.equal(release.status, 200);
    assert.equal(release.value.materials.length, 1);
    assert.equal((await call(client.endpoint, `releases/${releaseId}/materials/${fixture.ids.privateMaterialId}`, undefined, remote)).status, 404);
    const material = await call(client.endpoint, `releases/${releaseId}/materials/${fixture.ids.studentMaterialId}`, undefined, remote);
    assert.equal(material.status, 200);
    assert.equal(Buffer.from(material.value.contentBase64, 'base64').toString('utf8'), '# ALU 题目\n完成 4 位加减与逻辑运算。');
    const activityRequest = randomUUID();
    const created = await call(client.endpoint, 'course-activities', { requestId: activityRequest, releaseId }, remote);
    assert.equal(created.status, 200);
    assert.equal(created.value.course.releaseId, releaseId);
    assert.deepEqual(created.value.identity, connection.identity);
    assert.deepEqual((await call(client.endpoint, 'course-activities', { requestId: activityRequest, releaseId }, remote)).value,
      created.value);
    assert.equal((await call(client.endpoint, 'course-activity-results/' + activityRequest, undefined, remote)).value.state, 'accepted');
    const statusRequest = randomUUID();
    assert.equal((await call(client.endpoint, 'activity-status', { requestId: statusRequest,
      activityId: created.value.activityId, status: 'closed' }, remote)).status, 200);

    assert.equal((await call(school.endpoint, 'manage/course-access', { requestId: randomUUID(), courseId,
      principalId: member.value.principalId, active: false }, admin)).status, 200);
    assert.deepEqual((await call(client.endpoint, 'courses', undefined, remote)).value, { courses: [] });
    assert.equal((await call(client.endpoint, 'releases/' + releaseId, undefined, remote)).status, 403);
    assert.equal((await call(client.endpoint, 'activities/' + created.value.activityId, undefined, remote)).status, 403);
    assert.equal((await call(client.endpoint, 'activity-status', { requestId: statusRequest,
      activityId: created.value.activityId, status: 'closed' }, remote)).status, 403);
    assert.equal((await call(client.endpoint, 'course-activity-results/' + activityRequest, undefined, remote)).status, 403);
    assert.equal((await call(client.endpoint, 'connections/revoke', { connectionId: connection.connectionId }, remote)).status, 200);
    assert.equal((await call(client.endpoint, 'courses', undefined, remote)).status, 403);
  } finally {
    await clientRuntime.stop().catch(() => {});
    await schoolRuntime.stop().catch(() => {});
  }
});

test('question drafts fix course and work references across edits, deletion and eligibility', { timeout: 300000 }, async t => {
  await withRuntime(t, async ({ root, endpoint }) => {
    const control = await resolveCredential(root, 'control');
    const admin = { authorization: `Bearer ${control}` };
    const api = async (path, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + path, endpoint), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, value: await response.json().catch(() => null) };
    };
    const studentText = '\uFEFF# ALU 题目\r\n完成 4 位加减与逻辑运算。';
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const fixture = releaseFixture({ courseId, taskId, releaseId, studentText });
    const imported = await api('manage/course-import', fixture.manifest, admin);
    assert.equal(imported.status, 200);
    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'draft-student', password }, admin);
    const principalId = member.value.principalId;
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId, active: true }, admin);
    const logged = await api('login', { loginName: 'draft-student', password });
    const cookie = logged.headers.get('set-cookie').split(';')[0];
    const auth = { cookie };
    const activity = await api('course-activities', { requestId: randomUUID(), releaseId }, auth);
    assert.equal(activity.status, 200);
    const activityId = activity.value.activityId;
    const draftPath = 'drafts/' + activityId;
    const empty = await api(draftPath, undefined, auth);
    assert.equal(empty.status, 200);
    assert.equal(empty.value.revision, 0);
    assert.equal(empty.value.revisionId, null);
    assert.deepEqual(empty.value.references, []);
    const draftId = empty.value.draftId;

    const workValue = '// 初始代码\nmodule demo;\nendmodule\n';
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'demo.sv', kind: 'code',
      encoding: 'utf8', mediaType: 'text/plain', value: workValue };
    assert.equal((await api('workspaces/' + activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] }, auth)).status, 200);
    const importedMaterial = fixture.manifest.release.materials[0];
    const materialCopy = '完成 4 位加减与逻辑运算。';
    const requirementsCopy = fixture.manifest.release.requirements.slice(0, 6);
    const codeCopy = 'module demo;';
    const materialStart = studentText.indexOf(materialCopy);
    const requirementsStart = fixture.manifest.release.requirements.indexOf(requirementsCopy);
    const codeStart = workValue.indexOf(codeCopy);
    const courseBasis = { courseId, taskId, releaseId, contentDigest: imported.value.contentDigest };
    const materialReference = { referenceId: randomUUID(), source: { kind: 'course-material', ...courseBasis,
      materialId: importedMaterial.materialId, materialSha256: importedMaterial.sha256, mediaType: 'text/markdown' },
      range: { kind: 'text', start: materialStart, end: materialStart + materialCopy.length },
      copy: materialCopy, sourceName: 'ALU 题目' };
    const requirementsReference = { referenceId: randomUUID(), source: { kind: 'course-field', ...courseBasis,
      field: 'requirements' }, range: { kind: 'text', start: requirementsStart,
      end: requirementsStart + requirementsCopy.length }, copy: requirementsCopy, sourceName: '任务要求' };
    const workReference = { referenceId: randomUUID(), source: { kind: 'work', objectId: work.objectId,
      contentId: work.contentId }, range: { kind: 'code', start: codeStart, end: codeStart + codeCopy.length },
      copy: codeCopy, sourceName: 'demo.sv' };
    const basisA = { objectId: work.objectId, contentId: work.contentId, name: work.name, kind: 'code',
      encoding: 'utf8', mediaType: work.mediaType, value: workValue };
    const requestId = randomUUID();
    const draftInput = { requestId, draftId, baseRevision: 0, question: '请解释这段逻辑。',
      references: [materialReference, requirementsReference, workReference], bases: [basisA] };
    const first = await api(draftPath, draftInput, auth);
    assert.equal(first.status, 200, JSON.stringify(first.value));
    assert.equal(first.value.revision, 1);
    assert.equal(typeof first.value.revisionId, 'string');
    assert.equal(first.value.references.length, 3);
    assert.equal(first.value.references[0].copy, materialCopy);
    assert.equal(first.value.references[0].copyDigest, sha256(Buffer.from(materialCopy)));
    assert.equal(first.value.references[1].copy, requirementsCopy);
    assert.equal(first.value.references[2].source.contentId, work.contentId);
    assert.ok(!JSON.stringify(first.value).includes('sourceText'));
    assert.ok(!JSON.stringify(first.value).includes('教师私有测试'));
    assert.deepEqual((await api(draftPath, undefined, auth)).value, first.value);
    assert.deepEqual((await api(`drafts/${activityId}/receipts/${requestId}`, undefined, auth)).value, first.value);
    assert.deepEqual((await api(`drafts/${activityId}/revisions/${first.value.revisionId}`, undefined, auth)).value, first.value);
    assert.deepEqual((await api(draftPath, draftInput, auth)).value, first.value);
    assert.equal((await api(draftPath, { ...draftInput, question: '改过的同一请求。' }, auth)).status, 409);
    assert.equal((await api(draftPath, { ...draftInput, requestId: randomUUID() }, auth)).status, 409);
    const forged = { ...workReference, referenceId: randomUUID(), copy: 'module other;' };
    assert.equal((await api(draftPath, { requestId: randomUUID(), draftId, baseRevision: 1, question: '伪造副本。',
      references: [materialReference, requirementsReference, forged], bases: [] }, auth)).status, 400);

    const workValueB = '// 新代码\nmodule demo;\n  wire ready = 1;\nendmodule\n';
    const workB = { ...work, contentId: randomUUID(), value: workValueB };
    assert.equal((await api('workspaces/' + activityId, { requestId: randomUUID(), baseRevision: 1, files: [workB] }, auth)).status, 200);
    assert.deepEqual((await api(draftPath, undefined, auth)).value, first.value);
    const codeB = 'wire ready = 1;';
    const codeBReference = { referenceId: randomUUID(), source: { kind: 'work', objectId: work.objectId,
      contentId: workB.contentId }, range: { kind: 'code', start: workValueB.indexOf(codeB),
      end: workValueB.indexOf(codeB) + codeB.length }, copy: codeB, sourceName: 'demo.sv' };
    const stripped = references => references.map(({ copyDigest: _digest, ...reference }) => reference);
    const second = await api(draftPath, { requestId: randomUUID(), draftId, baseRevision: 1,
      question: '旧片段与当前代码分别是什么？', references: stripped(first.value.references).concat(codeBReference),
      bases: [{ objectId: work.objectId, contentId: workB.contentId, name: workB.name, kind: 'code',
        encoding: 'utf8', mediaType: workB.mediaType, value: workValueB }] }, auth);
    assert.equal(second.status, 200);
    assert.equal(second.value.revision, 2);
    assert.equal(second.value.references.length, 4);
    assert.equal(second.value.references[0].copy, materialCopy);
    assert.equal(second.value.references[2].copy, codeCopy);
    assert.equal(second.value.references[3].copy, codeB);

    assert.equal((await api('workspaces/' + activityId, { requestId: randomUUID(), baseRevision: 2, files: [] }, auth)).status, 200);
    const afterDelete = await api(draftPath, { requestId: randomUUID(), draftId, baseRevision: 2,
      question: second.value.question, references: stripped(second.value.references), bases: [] }, auth);
    assert.equal(afterDelete.status, 200);
    assert.equal(afterDelete.value.revision, 3);
    assert.deepEqual(afterDelete.value.references.map(reference => reference.copy),
      second.value.references.map(reference => reference.copy));
    assert.deepEqual((await api(`drafts/${activityId}/revisions/${first.value.revisionId}`, undefined, auth)).value, first.value);

    const orphan = { objectId: randomUUID(), contentId: randomUUID(), name: 'orphan.sv', kind: 'code',
      encoding: 'utf8', mediaType: 'text/plain', value: '// 未进入 head 的选择\nmodule orphan;\nendmodule\n' };
    const orphanCopy = 'module orphan;';
    const orphanReference = { referenceId: randomUUID(), source: { kind: 'work', objectId: orphan.objectId,
      contentId: orphan.contentId }, range: { kind: 'code', start: orphan.value.indexOf(orphanCopy),
      end: orphan.value.indexOf(orphanCopy) + orphanCopy.length }, copy: orphanCopy, sourceName: orphan.name };
    const withBasis = await api(draftPath, { requestId: randomUUID(), draftId, baseRevision: 3,
      question: afterDelete.value.question, references: stripped(afterDelete.value.references).concat(orphanReference),
      bases: [orphan] }, auth);
    assert.equal(withBasis.status, 200);
    assert.equal(withBasis.value.revision, 4);
    assert.equal(withBasis.value.references[4].copy, orphanCopy);
    assert.deepEqual((await api('workspaces/' + activityId, undefined, auth)).value.revision, 3);
    assert.equal((await api(`workspaces/${activityId}/contents/${orphan.contentId}`, undefined, auth)).value.value, orphan.value);
    assert.equal((await api(draftPath, { requestId: randomUUID(), draftId, baseRevision: 4, question: '',
      references: [{ ...orphanReference, referenceId: randomUUID(), range: { ...orphanReference.range, kind: 'text' } }],
      bases: [] }, auth)).status, 409);

    const secondActivity = await api('course-activities', { requestId: randomUUID(), releaseId }, auth);
    assert.equal(secondActivity.status, 200);
    const isolated = await api('drafts/' + secondActivity.value.activityId, undefined, auth);
    assert.equal(isolated.value.revision, 0);
    assert.equal((await api(`drafts/${secondActivity.value.activityId}/revisions/${first.value.revisionId}`, undefined, auth)).value, null);
    const foreignWork = { ...workReference, referenceId: randomUUID(), copy: codeCopy };
    assert.equal((await api('drafts/' + secondActivity.value.activityId, { requestId: randomUUID(),
      draftId: isolated.value.draftId, baseRevision: 0, question: '', references: [foreignWork], bases: [] }, auth)).status, 404);
    const privateReference = { referenceId: randomUUID(), source: { kind: 'course-material', ...courseBasis,
      materialId: fixture.ids.privateMaterialId, materialSha256: sha256(Buffer.from('# 教师私有测试\n仅教师可见。')),
      mediaType: 'text/markdown' }, range: { kind: 'text', start: 0, end: 2 }, copy: '# ', sourceName: '教师私有测试' };
    assert.equal((await api(draftPath, { requestId: randomUUID(), draftId, baseRevision: 4, question: '',
      references: [privateReference], bases: [] }, auth)).status, 404);

    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId, active: false }, admin);
    assert.equal((await api(draftPath, undefined, auth)).status, 403);
    assert.equal((await api(`drafts/${activityId}/revisions/${first.value.revisionId}`, undefined, auth)).status, 403);
    assert.equal((await api(draftPath, { requestId: randomUUID(), draftId, baseRevision: 4, question: '撤权后写入。',
      references: [], bases: [] }, auth)).status, 403);
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId, active: true }, admin);
    assert.deepEqual((await api(draftPath, undefined, auth)).value, withBasis.value);

    const secondPassword = randomUUID();
    const secondMember = await api('manage/members', { requestId: randomUUID(), loginName: 'draft-other', password: secondPassword }, admin);
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: secondMember.value.principalId, active: true }, admin);
    const secondLogin = await api('login', { loginName: 'draft-other', password: secondPassword });
    const other = { cookie: secondLogin.headers.get('set-cookie').split(';')[0] };
    assert.equal((await api(draftPath, undefined, other)).status, 404);
    assert.equal((await api(draftPath, { requestId: randomUUID(), draftId, baseRevision: 0, question: '他人草稿。',
      references: [], bases: [] }, other)).status, 404);
  });
});
