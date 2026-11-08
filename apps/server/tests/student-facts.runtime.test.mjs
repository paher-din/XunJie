import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { teachingAgentMigrations } from '../../../packages/learning-space/dist/teaching-agent/index.js';
import { createTeachingStudentFacts, extractStudentFacts, studentFactsGoalMigration, studentFactsMigration,
  validateTeachingStudentFacts } from '../../../packages/learning-space/dist/teaching-agent/student-facts.js';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;

const activitiesMigration = { version: 1, name: 'student-facts-activities-fixture', sql: `
  CREATE TABLE activities(id uuid PRIMARY KEY,space_environment_id uuid NOT NULL,space_id uuid NOT NULL,
    principal_id uuid NOT NULL,body jsonb NOT NULL);
` };

function migrations() {
  return [activitiesMigration, ...teachingAgentMigrations.filter(item => item.name !== studentFactsMigration.name
    && item.name !== studentFactsGoalMigration.name), studentFactsMigration, studentFactsGoalMigration]
    .map((item, index) => ({ version: index + 1, name: item.name, sql: item.sql }));
}

async function fixture(t) {
  assert.ok(postgresBin, 'Requires native PostgreSQL 18.6 through XUNJIE_PRODUCT_POSTGRES_BIN.');
  const pg = await nativeFixture();
  const migrationList = migrations();
  const binding = await provisionStorage({ admin: pg.admin,
    owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations: migrationList });
  const storage = await openStorage({ binding, migrations: migrationList,
    backend: createFileBackend({ id: 'student-facts', root: pg.root + '/objects' }) });
  t.after(async () => { await storage.close().catch(() => {}); await pg.close(); });
  return { pg, storage, migrations: migrationList };
}

const identityOf = () => ({ environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(),
  kind: 'personal', name: '学生事实验收' });

function courseOf(courseId, courseName = '事实课程') {
  return { associationId: randomUUID(), courseId, courseName, taskId: randomUUID(), taskTitle: '事实任务',
    releaseId: randomUUID(), contentDigest: 'a'.repeat(64), objectives: ['明确学习目标'],
    requirements: '按学生明确偏好组织回答', materials: [], starterWorks: [], capabilities: [],
    helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } };
}

async function addActivity(storage, identity, goal, course) {
  const activity = { activityId: randomUUID(), identity, status: 'open', goal, question: '', references: [],
    createdAt: new Date().toISOString(), target: { ...storage.owner, version: 1 }, ...(course ? { course } : {}) };
  await storage.request({ requestId: 'student-facts-activity:' + activity.activityId,
    fingerprint: activity.activityId }, async tx => {
    await tx.query('INSERT INTO activities VALUES($1,$2,$3,$4,$5)', [activity.activityId, identity.environmentId,
      identity.spaceId, identity.principalId, JSON.stringify(activity)]);
    return null;
  });
  return activity;
}

let seq = 0;
async function addInputEvent(storage, activityId, text) {
  seq += 1;
  const eventId = randomUUID(), eventSeq = seq;
  await storage.request({ requestId: 'student-facts-event:' + eventId, fingerprint: eventId }, async tx => {
    await tx.query(`INSERT INTO teaching_events(activity_id,seq,event_id,kind,event_version,body)
      VALUES($1,$2,$3,'input',1,$4)`, [activityId, eventSeq, eventId, JSON.stringify({ question: text })]);
    return null;
  });
  return { eventId, eventSeq };
}

async function record(storage, facts, identity, activity, text) {
  const event = await addInputEvent(storage, activity.activityId, text);
  const saved = await storage.request({ requestId: 'student-facts-record-test:' + event.eventId,
    fingerprint: event.eventId }, async tx => facts.record(tx, { identity, activity, inputId: null,
    eventId: event.eventId, eventSeq: event.eventSeq, contentVersion: 1, text }));
  return saved.result;
}

function factsFor(storage) {
  return createTeachingStudentFacts(storage, { activity: async (identity, activityId) => {
    const { rows: [row] } = await storage.read(`SELECT body FROM activities WHERE id=$1
      AND space_environment_id=$2 AND space_id=$3 AND principal_id=$4`,
    [activityId, identity.environmentId, identity.spaceId, identity.principalId]);
    if (!row) throw new Error('missing activity');
    return row.body;
  } });
}

async function rows(storage) {
  return (await storage.read('SELECT * FROM teaching_student_facts ORDER BY created_at,fact_id')).rows;
}

test('extraction is conservative: explicit clauses yield facts, placeholders and questions do not', () => {
  assert.deepEqual(extractStudentFacts(''), []);
  assert.deepEqual(extractStudentFacts('   '), []);
  assert.deepEqual(extractStudentFacts('都可以'), []);
  assert.deepEqual(extractStudentFacts('随便'), []);
  assert.deepEqual(extractStudentFacts('演示画像：我喜欢音乐。'), []);
  assert.deepEqual(extractStudentFacts('我喜欢什么？'), []);
  const facts = extractStudentFacts('我喜欢用中文解释，请以后先给例子。');
  assert.deepEqual(facts.map(fact => fact.topic), ['解释语言', '例子']);
  assert.deepEqual(facts.map(fact => fact.statement), ['我喜欢用中文解释', '请以后先给例子。']);
  assert.equal(extractStudentFacts('I prefer short explanations. Please always give an example.').length, 2);
});

test('an explicit preference keeps its source event and an empty placeholder writes nothing', { skip: !postgresBin, timeout: 120000 }, async t => {
  const { storage } = await fixture(t);
  const facts = factsFor(storage);
  const identity = identityOf();
  const activity = await addActivity(storage, identity, '理解分数加减');
  const saved = await record(storage, facts, identity, activity, '我喜欢用中文解释，请以后先给例子。');
  assert.equal(saved.length, 2);
  assert.equal(saved[0].source.eventId, saved[1].source.eventId);
  assert.equal(saved[0].source.seq, saved[1].source.seq);
  assert.equal(saved[0].source.activityId, activity.activityId);
  assert.equal(saved[0].contentVersion, 1);
  assert.equal(saved[0].reviewStatus, 'unreviewed');
  assert.equal(saved[0].scope.kind, 'activity');
  assert.equal(saved[1].scope.kind, 'global');
  assert.equal((await rows(storage)).length, 2);
  const noop = await record(storage, facts, identity, activity, '都可以');
  assert.deepEqual(noop, []);
  assert.equal((await rows(storage)).length, 2);
  // Replaying the same event and topic is idempotent through the unique key.
  const replay = await storage.request({ requestId: 'student-facts-replay:' + saved[0].source.eventId,
    fingerprint: saved[0].source.eventId }, async tx => facts.record(tx, { identity, activity, inputId: null,
    eventId: saved[0].source.eventId, eventSeq: saved[0].source.seq, contentVersion: 1,
    text: '我喜欢用中文解释，请以后先给例子。' }));
  assert.equal(replay.result.length, 2);
  assert.equal((await rows(storage)).length, 2);
});

test('a later correction retracts the old fact and links the corrected replacement', { skip: !postgresBin, timeout: 120000 }, async t => {
  const { storage } = await fixture(t);
  const facts = factsFor(storage);
  const identity = identityOf();
  const activity = await addActivity(storage, identity, '理解光合作用');
  const [original] = await record(storage, facts, identity, activity, '我喜欢用中文解释。');
  const [corrected] = await record(storage, facts, identity, activity, '我不再需要英文解释了，改成中文。');
  assert.equal(corrected.reviewStatus, 'corrected');
  assert.equal(corrected.supersedes, original.factId);
  const before = (await storage.read('SELECT * FROM teaching_student_facts WHERE fact_id=$1', [original.factId])).rows[0];
  assert.equal(before.review_status, 'retracted');
  assert.equal(before.retracted_by, corrected.factId);
  // A plain repeated statement stays unreviewed and never becomes confirmed.
  const [repeated] = await record(storage, facts, identity, activity, '我喜欢用中文解释。');
  assert.equal(repeated.reviewStatus, 'unreviewed');
  assert.equal(repeated.supersedes, null);
  const [third] = await record(storage, facts, identity, activity, '我不再需要英文解释了，改成中文。');
  assert.equal(third.reviewStatus, 'corrected');
  assert.equal(third.supersedes, repeated.factId);
  assert.equal((await rows(storage)).length, 4);
  // A corrected fact can itself be corrected later; validate accepts the retraction chain.
  const [fourth] = await record(storage, facts, identity, activity, '改成英文。');
  assert.equal(fourth.reviewStatus, 'corrected');
  assert.equal(fourth.supersedes, third.factId);
  await validateTeachingStudentFacts(storage);
  assert.equal((await rows(storage)).length, 5);
});

test('missing re-read leaves review status unchanged instead of confirming facts', { skip: !postgresBin, timeout: 120000 }, async t => {
  const { storage } = await fixture(t);
  const facts = factsFor(storage);
  const identity = identityOf();
  const activity = await addActivity(storage, identity, '复习分数');
  await record(storage, facts, identity, activity, '我希望先给例子。');
  const first = await facts.read(identity, activity.activityId, { scope: 'eligible' });
  assert.equal(first.facts.length, 1);
  assert.equal(first.facts[0].reviewStatus, 'unreviewed');
  const second = await facts.read(identity, activity.activityId, { scope: 'eligible' });
  assert.deepEqual(second, first);
  assert.equal((await rows(storage))[0].review_status, 'unreviewed');
});

test('same-course reads see other activities of that course while cross-course reads only share global facts', { skip: !postgresBin, timeout: 120000 }, async t => {
  const { storage } = await fixture(t);
  const facts = factsFor(storage);
  const identity = identityOf();
  const courseA = randomUUID(), courseB = randomUUID();
  const a1 = await addActivity(storage, identity, '课程 A 活动 1', courseOf(courseA, '课程 A'));
  const a2 = await addActivity(storage, identity, '课程 A 活动 2', courseOf(courseA, '课程 A'));
  const b = await addActivity(storage, identity, '课程 B 活动', courseOf(courseB, '课程 B'));
  const personal = await addActivity(storage, identity, '自主学习分数');
  const own = await record(storage, facts, identity, a1, '我喜欢用中文解释。');
  const courseFact = await record(storage, facts, identity, a2, '这门课我希望多给例子。');
  const globalFact = await record(storage, facts, identity, b, '以后所有课程都要先给例子。');
  await record(storage, facts, identity, personal, '我喜欢详细解释。');
  assert.equal(courseFact[0].scope.kind, 'course');
  assert.equal(courseFact[0].scope.courseId, courseA);
  assert.equal(globalFact[0].scope.kind, 'global');

  const onlyCurrent = await facts.read(identity, a1.activityId, { scope: 'current-activity' });
  assert.deepEqual(onlyCurrent.facts.map(fact => fact.factId), [own[0].factId]);
  assert.equal(onlyCurrent.continuation.state, 'same-activity');

  const sameCourse = await facts.read(identity, a1.activityId, { scope: 'same-course' });
  assert.deepEqual(new Set(sameCourse.facts.map(fact => fact.factId)), new Set([own[0].factId, courseFact[0].factId, globalFact[0].factId]));
  assert.equal(sameCourse.continuation.state, 'same-course');

  const otherCourse = await facts.read(identity, b.activityId, { scope: 'eligible' });
  assert.deepEqual(new Set(otherCourse.facts.map(fact => fact.factId)), new Set([globalFact[0].factId]));
  assert.ok(!otherCourse.facts.some(fact => fact.factId === courseFact[0].factId), 'course A fact never leaks into course B');

  const personalRead = await facts.read(identity, personal.activityId, { scope: 'eligible' });
  assert.ok(personalRead.facts.some(fact => fact.factId === globalFact[0].factId));
  assert.equal(personalRead.continuation.state, 'ambiguous');
  const queried = await facts.read(identity, a1.activityId, { scope: 'same-course', query: '例子' });
  assert.deepEqual(new Set(queried.facts.map(fact => fact.factId)), new Set([courseFact[0].factId, globalFact[0].factId]));
  assert.deepEqual(await facts.read(identity, a1.activityId, { scope: 'same-course', query: '不存在的偏好' }),
    { facts: [], activity: { activityId: a1.activityId, goal: a1.goal, courseId: courseA },
      continuation: { state: 'same-course', detail: '读取当前活动、同课程其他活动的课程级偏好以及全局偏好。' },
      unknown: ['没有找到与「不存在的偏好」相关的明确偏好记录'] });
});

test('a correction in another activity of the same course retracts the earlier course-scoped fact', { skip: !postgresBin, timeout: 120000 }, async t => {
  const { storage } = await fixture(t);
  const facts = factsFor(storage);
  const identity = identityOf();
  const course = courseOf(randomUUID());
  const first = await addActivity(storage, identity, '第一次课', course);
  const second = await addActivity(storage, identity, '第二次课', course);
  const [original] = await record(storage, facts, identity, first, '这门课我喜欢先给例子。');
  assert.equal(original.scope.kind, 'course');
  const [corrected] = await record(storage, facts, identity, second, '这门课以后不要再先给例子，改成先讲原理。');
  assert.equal(corrected.reviewStatus, 'corrected');
  assert.equal(corrected.supersedes, original.factId);
  const archived = (await storage.read('SELECT review_status,retracted_by FROM teaching_student_facts WHERE fact_id=$1',
    [original.factId])).rows[0];
  assert.equal(archived.review_status, 'retracted');
  assert.equal(archived.retracted_by, corrected.factId);
  const read = await facts.read(identity, second.activityId, { scope: 'same-course' });
  assert.ok(read.facts.some(fact => fact.factId === corrected.factId));
  assert.ok(!read.facts.some(fact => fact.factId === original.factId));
  await facts.validate();
});

test('a personal activity is ambiguous unless the text explicitly continues the same goal', { skip: !postgresBin, timeout: 120000 }, async t => {
  const { storage } = await fixture(t);
  const facts = factsFor(storage);
  const identity = identityOf();
  const activity = await addActivity(storage, identity, '继续这个目标：练完这一组分数题');
  await record(storage, facts, identity, activity, '我喜欢先给例子。');
  const result = await facts.read(identity, activity.activityId, { scope: 'eligible' });
  assert.equal(result.continuation.state, 'same-activity');
});

test('explicit personal continuation reads facts from another personal activity', { skip: !postgresBin, timeout: 120000 }, async t => {
  const { storage } = await fixture(t);
  const facts = factsFor(storage);
  const identity = identityOf();
  const first = await addActivity(storage, identity, '整理分数笔记');
  await record(storage, facts, identity, first, '我喜欢先给例子。');
  const second = await addActivity(storage, identity, '继续这个目标：整理分数笔记');
  const result = await facts.read(identity, second.activityId, { scope: 'eligible' });
  assert.equal(result.continuation.state, 'same-activity');
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].statement, '我喜欢先给例子。');
  const currentOnly = await facts.read(identity, second.activityId, { scope: 'current-activity' });
  assert.equal(currentOnly.facts.length, 0, 'current-activity never borrows another personal activity fact');
  const ambiguous = await addActivity(storage, identity, '另一件无关的事');
  const none = await facts.read(identity, ambiguous.activityId, { scope: 'eligible' });
  assert.equal(none.continuation.state, 'ambiguous');
  assert.equal(none.facts.length, 0);
});

test('validate accepts every row and rejects a retraction without its replacement', { skip: !postgresBin, timeout: 120000 }, async t => {
  const { storage } = await fixture(t);
  const facts = factsFor(storage);
  const identity = identityOf();
  const activity = await addActivity(storage, identity, '验证事实来源');
  await record(storage, facts, identity, activity, '我喜欢用中文解释。');
  await record(storage, facts, identity, activity, '我不再需要英文解释了，改成中文。');
  await validateTeachingStudentFacts(storage);
  const [row] = (await storage.read("SELECT * FROM teaching_student_facts WHERE review_status='corrected'")).rows;
  await storage.request({ requestId: 'student-facts-corrupt:' + row.fact_id, fingerprint: String(row.fact_id) }, async tx => {
    await tx.query("UPDATE teaching_student_facts SET review_status='retracted' WHERE fact_id=$1", [row.fact_id]);
    return null;
  });
  await assert.rejects(validateTeachingStudentFacts(storage), { code: 'corrupt' });
});
