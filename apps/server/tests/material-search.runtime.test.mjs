import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createLearningQuery } from '@xunjie/learning-space/learning-data/learning-query';
import { learningOwner } from './support/learning-owner.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

test('unified material search returns only authorized fixed-version snippets with real coverage', { timeout: 180000 }, async t => {
  const f = await learningOwner(t), { spaces: authority, identity } = f, learning = f.data;
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
  await authority.bindMember(other, f.target);
  const otherActivity = await learning.create(other, { requestId: randomUUID(), goal: '另一个活动', question: '', references: [] });
  const cross = await learning.search.search(other, otherActivity.activityId,
    { query: '串联', scope: { courseMaterials: false, personalMaterialIds: [first.material.materialId], skillAttachments: false } },
    { personalReferences: [first.reference] });
  assert.equal(cross.matches.length, 0);
  assert.equal(cross.sources[0].state, 'no-access');
  assert.equal(cross.sources[0].source, undefined, 'another student cannot even name the source');
});

test('course material search returns only the activity release text and stops after access revocation', { timeout: 180000 }, async t => {
  const f = await learningOwner(t), { spaces: authority, courses } = f, learning = f.data;
  const password = randomUUID();
  const member = await authority.createMember({ requestId: randomUUID(), loginName: 'search-course-student', password });
  await authority.bindMember(member, f.target);
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
  const activity = await learning.createCourse(member, { requestId: randomUUID(), releaseId });
  const searched = await learning.search.search(member, activity.activityId, { query: '真值表', scope: { courseMaterials: true, skillAttachments: false } }, {});
  assert.equal(searched.matches.length, 1);
  assert.equal(searched.matches[0].source.kind, 'course-material');
  assert.equal(searched.matches[0].source.label, 'ALU 题目');
  assert.equal(searched.matches[0].readMethod, 'stored-text');
  assert.deepEqual(searched.coverage.kinds, ['course-material']);
  const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'ALU观察.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: '原观察真值表' };
  await learning.works.sync(member, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] });
  const query = createLearningQuery({ sources: async () => [{ sourceId: 'school', identity: member, target: f.target, learning,
    courses: { owner: f.courseTarget, listCourses: courses.listCourses, readRelease: courses.readRelease } }] });
  const references = [];
  for (const kind of ['activity', 'course', 'work']) {
    const page = await query.searchLearning({ query: kind === 'work' ? '原观察' : 'ALU', kinds: [kind] });
    assert.equal(page.items.length, 1);
    const reference = page.items[0].reference; references.push(reference);
    assert.equal(page.items[0].provenance.course.releaseId, releaseId);
    const detail = await query.readLearning({ reference, range: { offset: 1, length: 1 } });
    assert.deepEqual(detail.provenance.course.helpPolicy, { version: 1, questions: 'allowed', scope: 'course' });
    assert.equal(detail.provenance.course.contentDigest, activity.course.contentDigest);
    assert.equal(detail.text.length, 1);
    assert.equal(detail.role, 'source-data');
  }
  await courses.setAccess({ requestId: randomUUID(), courseId, principalId: member.principalId, active: false });
  for (const reference of references) await assert.rejects(query.readLearning({ reference }), { code: 'forbidden' });
  await assert.rejects(learning.search.search(member, activity.activityId,
    { query: '真值表', scope: { courseMaterials: true, skillAttachments: false } }, {}), { code: 'forbidden' });
});
