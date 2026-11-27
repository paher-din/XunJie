import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createSpaces, createCourses, createLearningData, learningMigrations, spaceCourseMigrations } from '@xunjie/learning-space';
import { aluPackage, aluCoursePackage } from '../../../components/alu-experiment/package.mjs';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';

test('ALU 发布 306 可在已有 v4 的环境导入，旧活动仍绑定原发布', { timeout: 60_000 }, async t => {
  const pg = await nativeFixture(), storages = [], environmentId = randomUUID();
  t.after(async () => {
    for (const storage of storages.reverse()) await storage.close();
    await pg.close();
  });
  async function open(name, migrations) {
    const owner = { environmentId, serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(pg.root, name) }) });
    storages.push(storage);
    return storage;
  }
  const space = await open('space', spaceCourseMigrations), data = await open('data', learningMigrations);
  const spaces = createSpaces(space), courses = createCourses(space, spaces);
  const student = await spaces.createMember({ requestId: randomUUID(), loginName: 'alu-publication', password: randomUUID() });
  await spaces.bindMember(student, { ...data.owner, version: 1 });
  const learning = createLearningData(data, spaces, courses);
  const component = await aluPackage(), publication = await aluCoursePackage();
  const definition = await courses.components.register(component);
  assert.equal(definition.digest, '6f9c2da7c7deffa13904692866a23f071948b8d900533ccfa6a9fdbfb102169e');
  publication.release.components[0].definition = definition;
  const old = structuredClone(publication);
  old.requestId = '19200000-0000-4000-8000-000000000204';
  old.release.releaseId = '19200000-0000-4000-8000-000000000205';
  old.release.helpPolicy = { version: 1, questions: 'allowed', scope: 'course',
    note: '只解释，不修改学生 SystemVerilog，不自写测试代码，不应用补丁或提供整份可提交答案。Agent 验证与学生预测分开保留，不据验证推断掌握或教师接收。' };
  await courses.registerRelease(old);
  await courses.setAccess({ requestId: randomUUID(), courseId: old.course.courseId, principalId: student.principalId, active: true });
  const start = releaseId => learning.createCourse(student, { requestId: randomUUID(), releaseId });
  const oldActivity = await start(old.release.releaseId);
  assert.deepEqual(await courses.components.register(component), definition);
  await courses.registerRelease(publication);
  const newActivity = await start(publication.release.releaseId);
  const reopened = await learning.open(student, oldActivity.activityId);
  assert.equal(reopened.course.releaseId, old.release.releaseId);
  assert.equal(reopened.course.helpPolicy.predictionGate, undefined);
  assert.equal(newActivity.course.helpPolicy.predictionGate.hideResultsBeforePrediction, true);
  for (const activity of [reopened, newActivity])
    assert.equal((await courses.readComponent(student, activity.course.releaseId, 'alu')).definition.digest, definition.digest);

  const teacher = await spaces.createMember({ requestId: randomUUID(), loginName: 'alu-publication-teacher', password: randomUUID() });
  let allowed = true;
  const authorize = async () => { if (!allowed) throw new StorageError('forbidden'); };
  const published = courses.teacherPublished(teacher, publication.course.courseId, authorize);
  assert.equal((await published.find(publication.task.title)).length, 2);
  await assert.rejects(courses.readRelease(teacher, publication.release.releaseId), { code: 'forbidden' });
  const teacherRelease = await published.release(publication.release.releaseId);
  assert.equal(teacherRelease.releaseId, publication.release.releaseId);
  const entry = teacherRelease.materials[0];
  assert.equal((await published.material(teacherRelease.releaseId, entry.materialId)).sha256, entry.sha256);
  const wrongCourse = courses.teacherPublished(teacher, randomUUID(), authorize);
  await assert.rejects(wrongCourse.release(teacherRelease.releaseId), { code: 'forbidden' });
  allowed = false;
  await assert.rejects(published.material(teacherRelease.releaseId, entry.materialId), { code: 'forbidden' });
});
