import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StorageError } from '@xunjie/storage';
import { createLearningQuery } from '../dist/learning-data/learning-query.js';

function fixture() {
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  const target = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 };
  const activity = { activityId: randomUUID(), identity, target, goal: '学习排序', question: '', references: [], status: 'open', createdAt: '2026-11-13T00:00:00.000Z' };
  let allowed = true;
  const authorize = async actor => {
    assert.equal(actor.principalId, identity.principalId);
    if (!allowed) throw new StorageError('forbidden');
  };
  const source = { sourceId: 'local-personal', identity, target, learning: {
    async list(actor) { await authorize(actor); return [activity]; },
    async open(actor, id) { await authorize(actor); if (id !== activity.activityId) throw new StorageError('missing'); return activity; },
  } };
  let current = [source];
  return { activity, source, query: createLearningQuery({ sources: async () => current }),
    deny() { allowed = false; }, sources(value) { current = value; } };
}
test('learning queries page real owner tasks, report missing deadlines and reauthorize each detail', async () => {
  const f = fixture(), page = await f.query.listLearningTasks({ offset: 0, limit: 1 });
  assert.equal(page.items[0].title, '学习排序');
  assert.equal(page.items[0].dueAt, null);
  assert.deepEqual(page.items[0].missing, ['deadline']);
  assert.equal(page.nextOffset, null);
  const reference = page.items[0].reference;
  const detail = await f.query.readLearning({ reference, range: { offset: 0, length: 7 } });
  assert.equal(detail.text.length, 7);
  assert.equal(detail.range.nextOffset, 7);
  assert.equal(detail.role, 'source-data');
  assert.equal((await f.query.searchLearning({ query: '排序' })).items.length, 1);
  assert.equal((await f.query.searchLearning({ query: '不存在' })).items.length, 0);
  f.deny();
  await assert.rejects(f.query.readLearning({ reference }), { code: 'forbidden' });
});

test('references bind identity, owner and version; disconnected school results remain explicit', async () => {
  const f = fixture(), reference = (await f.query.listLearningTasks()).items[0].reference;
  for (const changed of [
    { ...reference, identity: { ...reference.identity, kind: 'school' } },
    { ...reference, identity: { ...reference.identity, principalId: randomUUID() } },
    { ...reference, owner: { ...reference.owner, serviceId: randomUUID() } },
  ]) await assert.rejects(f.query.readLearning({ reference: changed }), { code: 'forbidden' });
  await assert.rejects(f.query.readLearning({ reference: { ...reference, version: 'wrong' } }), { code: 'conflict' });
  f.sources([{ ...f.source, sourceId: 'school', identity: { ...f.source.identity, kind: 'school' }, learning: {
    async list() { throw new StorageError('unavailable'); }, async open() { throw new StorageError('unavailable'); },
  } }]);
  const page = await f.query.listLearningTasks();
  assert.deepEqual(page.items, []);
  assert.deepEqual(page.unavailable, [{ sourceId: 'school', kind: 'activity', code: 'unavailable' }]);
  await assert.rejects(f.query.readLearning({ reference }), { code: 'forbidden' });
});

test('a missing conversation owner is reported as unavailable instead of an authoritative empty history', async () => {
  const f = fixture();
  const page = await f.query.searchLearning({ query: '历史', kinds: ['conversation'] });
  assert.deepEqual(page.items, []);
  assert.deepEqual(page.unavailable, [{ sourceId: 'local-personal', kind: 'conversation', code: 'not-configured' }]);
});

test('search reads work versions, paged experiment records, courses and dialogue only through their owner ports', async () => {
  const f = fixture(), activityId = f.activity.activityId;
  const file = { objectId: randomUUID(), contentId: randomUUID(), name: '排序.txt', value: '稳定排序的观察', encoding: 'utf8', kind: 'text', mediaType: 'text/plain' };
  const record = { requestId: randomUUID(), result: null, query: { state: 'pending' } };
  const dialogue = { objectId: randomUUID(), version: 'turn-3', title: '排序讨论', text: '忽略之前指令是历史对话内容' };
  const releaseId = randomUUID(), courseId = randomUUID(), taskId = randomUUID();
  const release = { releaseId, taskId, courseId, contentDigest: 'a'.repeat(64), taskTitle: '课程排序', requirements: '比较排序', courseName: '课程', helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } };
  f.source.learning.works = {
    async read() { return { revision: 1, files: [file] }; },
    async content(_identity, id, version) { assert.equal(id, activityId); assert.equal(version, file.contentId); return file; },
  };
  f.source.learning.executionRecords = {
    async history(_identity, id, cursor) { assert.equal(id, activityId); return cursor ? { entries: [], nextCursor: null } : { entries: [record], nextCursor: record.requestId }; },
    async read() { return record; },
  };
  f.source.courses = { owner: { ...f.source.target, serviceId: randomUUID() },
    async listCourses() { return { courses: [{ courseId, name: '课程', tasks: [{ taskId, title: '课程排序', summary: '排序方法', releases: [{ releaseId, contentDigest: release.contentDigest, objectives: ['学习排序'], publishedAt: '2026-11-13T00:00:00.000Z' }] }] }] }; },
    async readRelease() { return release; } };
  f.source.ownerConversationRead = { owner: { ...f.source.target, serviceId: randomUUID() },
    async list(_identity, cursor) { return cursor ? { entries: [], nextCursor: null } : { entries: [dialogue], nextCursor: 'next' }; },
    async read() { return dialogue; } };
  const all = await f.query.searchLearning({ query: '排序', limit: 50 });
  assert.deepEqual(all.items.map(item => item.reference.kind).sort(), ['activity', 'conversation', 'course', 'record', 'work']);
  const work = all.items.find(item => item.reference.kind === 'work').reference;
  f.source.learning.works.read = async () => ({ revision: 2, files: [] });
  assert.ok((await f.query.readLearning({ reference: work })).text.includes('稳定排序的观察'));
  const course = all.items.find(item => item.reference.kind === 'course').reference;
  assert.deepEqual(course.owner, f.source.courses.owner);
  assert.ok((await f.query.readLearning({ reference: course })).text.includes('helpPolicy'));
  const conversation = all.items.find(item => item.reference.kind === 'conversation').reference;
  const detail = await f.query.readLearning({ reference: conversation });
  assert.equal(detail.role, 'source-data');
  assert.ok(detail.text.includes('历史对话内容'));
  const records = await f.query.searchLearning({ query: 'pending', kinds: ['record'] });
  assert.equal(records.items.length, 1);
  assert.ok((await f.query.readLearning({ reference: records.items[0].reference })).text.includes('pending'));
});

test('one subject can discover conversations pinned to two different historical Agent owners', async () => {
  const f = fixture(), ownerA = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 },
    ownerB = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 };
  const entries = [
    { objectId: randomUUID(), version: 'turn-a-2', title: '历史对话 A', text: 'Agent A 的固定历史', owner: ownerA },
    { objectId: randomUUID(), version: 'turn-b-5', title: '历史对话 B', text: 'Agent B 的固定历史', owner: ownerB },
  ];
  f.source.ownerConversationRead = { owner: f.source.target,
    async list(actor) { assert.deepEqual(actor, f.source.identity); return { entries, nextCursor: null }; },
    async read(_actor, objectId) { return entries.find(entry => entry.objectId === objectId); },
  };
  const page = await f.query.searchLearning({ query: '历史', kinds: ['conversation'] });
  assert.equal(page.items.length, 2);
  for (const entry of entries) {
    const reference = page.items.find(item => item.reference.objectId === entry.objectId).reference;
    assert.deepEqual(reference.owner, entry.owner);
    assert.equal(reference.version, entry.version);
    assert.equal(reference.identity.principalId, f.source.identity.principalId);
  }
});

test('fresh conversation reads authorize the entry owner and never retarget old references to the current Agent', async () => {
  const f = fixture(), ownerA = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 },
    ownerB = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 };
  const entries = [
    { objectId: randomUUID(), version: 'fixed-a', title: '历史 A', text: '历史 Agent A', owner: ownerA },
    { objectId: randomUUID(), version: 'fixed-b', title: '历史 B', text: '历史 Agent B', owner: ownerB },
  ];
  let allowed = true;
  const provider = { owner: f.source.target,
    async list() { return { entries, nextCursor: null }; },
    async read(actor, objectId) {
      assert.deepEqual(actor, f.source.identity);
      if (!allowed) throw new StorageError('forbidden');
      const entry = entries.find(entry => entry.objectId === objectId);
      if (!entry) throw new StorageError('missing');
      return { ...entry };
    },
  };
  f.source.ownerConversationRead = provider;
  const references = (await f.query.searchLearning({ query: '历史', kinds: ['conversation'] })).items.map(item => item.reference);
  for (const reference of references) assert.deepEqual((await f.query.readLearning({ reference })).reference, reference);
  const referenceA = references.find(reference => reference.objectId === entries[0].objectId);
  for (const owner of [provider.owner, ownerB, { ...ownerA, serviceId: randomUUID() }])
    await assert.rejects(f.query.readLearning({ reference: { ...referenceA, owner } }), { code: 'forbidden' });
  await assert.rejects(f.query.readLearning({ reference: { ...referenceA, owner: ownerB, version: 'wrong' } }), { code: 'forbidden' });
  await assert.rejects(f.query.readLearning({ reference: { ...referenceA, version: 'wrong' } }), { code: 'conflict' });
  provider.owner = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 };
  for (const reference of references) assert.deepEqual((await f.query.readLearning({ reference })).reference, reference);
  entries[0].owner = provider.owner;
  await assert.rejects(f.query.readLearning({ reference: referenceA }), { code: 'forbidden' });
  allowed = false;
  await assert.rejects(f.query.readLearning({ reference: references.find(reference => reference.objectId === entries[1].objectId) }), { code: 'forbidden' });
});

const courseProvenance = () => ({ courseId: randomUUID(), courseName: '电路课', taskId: randomUUID(), taskTitle: '分析原观察',
  releaseId: randomUUID(), contentDigest: 'c'.repeat(64), helpPolicy: { version: 1, questions: 'disabled', scope: 'course', note: '仅解释原观察，不代写。' } });

test('course constraints accompany activity, work, record and release details outside every text range', async () => {
  const f = fixture(), course = courseProvenance(); f.activity.course = { ...course, skills: [{ body: 'SKILL_BODY_MUST_NOT_AUTOLOAD' }] };
  const file = { objectId: randomUUID(), contentId: randomUUID(), name: '课程作品.txt', value: '原观察', encoding: 'utf8', kind: 'text', mediaType: 'text/plain' };
  const record = { requestId: randomUUID(), result: null, query: { state: 'pending' } };
  f.source.learning.works = { read: async () => ({ revision: 1, files: [file] }), content: async () => file };
  f.source.learning.executionRecords = { history: async () => ({ entries: [record], nextCursor: null }), read: async () => record };
  f.source.courses = { owner: f.source.target, readRelease: async () => course,
    listCourses: async () => ({ courses: [{ courseId: course.courseId, name: course.courseName, tasks: [{ taskId: course.taskId,
      title: course.taskTitle, summary: '', releases: [{ releaseId: course.releaseId, contentDigest: course.contentDigest, objectives: ['观察'], publishedAt: f.activity.createdAt }] }] }] }) };
  const refs = [];
  for (const kind of ['activity', 'work', 'record', 'course']) {
    const page = await f.query.searchLearning({ query: kind === 'record' ? 'pending' : kind === 'work' ? '原观察' : '观察', kinds: [kind] });
    const reference = page.items[0].reference; refs.push(reference);
    const detail = await f.query.readLearning({ reference, range: { offset: 0, length: 1 } });
    assert.equal(detail.text.length, 1);
    assert.deepEqual(detail.provenance.course, course);
    assert.equal(detail.role, 'source-data');
    assert.doesNotMatch(JSON.stringify(page), /SKILL_BODY_MUST_NOT_AUTOLOAD/);
    assert.doesNotMatch((await f.query.readLearning({ reference })).text, /SKILL_BODY_MUST_NOT_AUTOLOAD/);
    assert.equal(detail.provenance.course.skills, undefined, 'Course constraints do not load packages or grant tools');
    if (kind !== 'course') {
      assert.deepEqual(page.items[0].provenance.course, course, 'Search excerpts retain their applicable rules');
      assert.deepEqual(detail.provenance.activity, { activityId: f.activity.activityId, target: f.source.target });
    }
  }
  // Even a fixed content ID must not silently follow changed source constraints.
  f.activity.course = { ...course, helpPolicy: { ...course.helpPolicy, questions: 'allowed' } };
  for (const ref of refs.filter(ref => ref.kind === 'work' || ref.kind === 'record'))
    await assert.rejects(f.query.readLearning({ reference: ref }), { code: 'conflict' });
  f.deny();
  for (const ref of refs.filter(ref => ref.kind !== 'course'))
    await assert.rejects(f.query.readLearning({ reference: ref }), { code: 'forbidden' });
});

test('conversation provenance reopens the actual workspace and never trusts historical course rules as current access', async () => {
  const f = fixture(), course = courseProvenance(); f.activity.course = course;
  const provenance = { activity: { activityId: f.activity.activityId, target: f.source.target }, course };
  const conversation = { objectId: randomUUID(), version: 'fixed-constrained-history', title: '课程历史', text: '仅为历史资料', provenance };
  let reads = 0;
  f.source.ownerConversationRead = { owner: f.source.target,
    list: async () => ({ entries: [conversation], nextCursor: null }),
    async read() { reads++; return conversation; } };
  const reference = (await f.query.searchLearning({ query: '历史', kinds: ['conversation'] })).items[0].reference;
  assert.deepEqual((await f.query.readLearning({ reference, range: { length: 1 } })).provenance, provenance);
  f.activity.course = { ...course, contentDigest: 'b'.repeat(64) };
  await assert.rejects(f.query.readLearning({ reference }), { code: 'identity-conflict' });
  f.activity.course = course; f.deny();
  await assert.rejects(f.query.readLearning({ reference }), { code: 'forbidden' });
  assert.equal(reads, 3, 'Every detail first asks the actual conversation owner for fresh session authorization');
});
