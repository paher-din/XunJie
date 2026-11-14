import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createLearningData, learningMigrations, createSpaces, createCourses, spaceCourseMigrations } from '@xunjie/learning-space';
import { createAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createAgentRuntime, agentRuntimeMigrations } from '@xunjie/agent-runtime';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createStudentFacts } from '../src/capabilities/student-facts/index.ts';

async function fixture(t) {
  const pg = await nativeFixture(), stores = [], runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); for (const store of stores.reverse()) await store.close(); await pg.close(); });
  const environmentId = randomUUID();
  async function open(name, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(pg.root, name) }) });
    stores.push(storage); return storage;
  }
  const spaces = createSpaces(await open('spaces', spaceCourseMigrations));
  const identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'facts-' + randomUUID(), password: randomUUID() });
  const courses = createCourses(stores[0], spaces), data = await open('learning', learningMigrations);
  await spaces.bindMember(identity, { ...data.owner, version: 1 });
  const learning = createLearningData(data, spaces, courses), agentStore = await open('agent', agentRuntimeMigrations);
  const runtime = createAgentRuntime(agentStore, { authorize: spaces.authorize }); runtimes.push(runtime);
  const owner = { version: 1, installationId: randomUUID(), connectionId: randomUUID(), target: { ...agentStore.owner,
    unit: 'teaching-agent', endpoint: 'https://facts-agent.invalid', protocolVersion: 1, capabilities: ['agent.sessions.v2'] } };
  const sessions = createAgentSessions(data, { authorize: spaces.authorize, openActivity: learning.open, resolveOwner: async () => owner });
  const source = { sourceId: 'real-owner', identity, target: { ...data.owner, version: 1 }, learning, sessions, core: async () => runtime };
  const options = { activity: learning.open, sources: async () => [source] };
  const facts = createStudentFacts(options);
  async function activity(goal, courseId) {
    if (!courseId) return learning.create(identity, { requestId: randomUUID(), goal, question: '', references: [] });
    const releaseId = randomUUID();
    await courses.registerRelease({ formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '真实课程' },
      task: { taskId: randomUUID(), title: goal, summary: '' }, release: { releaseId, objectives: [goal], requirements: '学生独立完成',
        materials: [], starterWorks: [], capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } }, resources: [] });
    await courses.setAccess({ requestId: randomUUID(), courseId, principalId: identity.principalId, active: true });
    return learning.createCourse(identity, { requestId: randomUUID(), releaseId });
  }
  const sessionIds = new Map();
  async function input(activity, text, context = {}) {
    let sessionId = sessionIds.get(activity.activityId);
    if (!sessionId) {
      sessionId = randomUUID(); sessionIds.set(activity.activityId, sessionId);
      await sessions.create(identity, { requestId: randomUUID(), sessionId, scenario: 'workspace-assistant', workspace: { activityId: activity.activityId, target: activity.target } });
      await runtime.initialize({ sessionId, identity, scenario: 'workspace-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
      await sessions.markReady(identity, { requestId: randomUUID(), sessionId });
    }
    const receipt = await runtime.accept(identity, { requestId: randomUUID(), sessionId, text, context });
    return { ...receipt, event: (await runtime.events(identity, sessionId)).find(event => event.kind === 'input-received' && event.body.inputId === receipt.inputId) };
  }
  return { facts, source, options, identity, learning, courses, sessions, runtime, agentStore, owner, activity, input, sessionIds };
}

test('public core inputs retain same-course preferences, global scope and exact source without exposing unrelated activity facts', { timeout: 60000 }, async t => {
  const f = await fixture(t), courseA = randomUUID(), courseB = randomUUID();
  const a1 = await f.activity('课程 A 活动一', courseA), a2 = await f.activity('课程 A 活动二', courseA), b = await f.activity('课程 B', courseB);
  const own = await f.input(a1, '我喜欢用中文解释。');
  const related = await f.input(a2, '这门课我希望多给例子。');
  await f.input(b, '我喜欢详细解释。');
  await f.input(b, '以后所有课程都要先给例子。');
  const current = await f.facts.read(f.identity, a1.activityId, { scope: 'current-activity' });
  assert.deepEqual(current.facts.map(fact => fact.statement), ['我喜欢用中文解释。']);
  const result = await f.facts.read(f.identity, a1.activityId, { scope: 'same-course' });
  assert.deepEqual(new Set(result.facts.map(fact => fact.statement)), new Set(['我喜欢用中文解释。', '这门课我希望多给例子。', '以后所有课程都要先给例子。']));
  assert.equal(result.continuation.state, 'same-course');
  const fact = result.facts.find(fact => fact.source.eventId === related.event.eventId);
  assert.equal(fact.source.sessionId, related.sessionId); assert.equal(fact.source.runId, related.runId);
  assert.equal(fact.source.seq, related.event.seq); assert.equal(fact.source.inputId, related.inputId);
  assert.deepEqual(fact.source.owner, { ...f.agentStore.owner, version: 1 });
  assert.equal(fact.reviewStatus, 'unreviewed'); assert.equal(fact.contentVersion, 1);
  assert.equal(current.facts[0].source.eventId, own.event.eventId);
  const other = await f.facts.read(f.identity, b.activityId, { scope: 'same-course' });
  assert.ok(!other.facts.some(fact => fact.source.activityId === a1.activityId || fact.source.activityId === a2.activityId));
  assert.deepEqual(await f.facts.read(f.identity, a1.activityId, { scope: 'same-course' }), result, 'reading never confirms or re-extracts a new fact identity');
});

test('corrections across actual sessions keep the replacement chain and never turn repeated reads into confirmation', { timeout: 60000 }, async t => {
  const f = await fixture(t), courseId = randomUUID();
  const a = await f.activity('同课第一次', courseId), b = await f.activity('同课第二次', courseId);
  await f.input(a, '这门课我喜欢先给例子。');
  const original = (await f.facts.read(f.identity, a.activityId, { scope: 'same-course' })).facts[0];
  await f.input(b, '这门课以后不要再先给例子，改成先讲原理。');
  const result = await f.facts.read(f.identity, a.activityId, { scope: 'same-course' });
  assert.equal(result.facts.length, 1); assert.equal(result.facts[0].supersedes, original.factId);
  assert.equal(result.facts[0].reviewStatus, 'corrected');
  assert.deepEqual(await f.facts.read(f.identity, a.activityId, { scope: 'same-course' }), result);
  const correction = result.facts[0];
  await f.input(b, '这门课改成先给例子。');
  const next = await f.facts.read(f.identity, a.activityId, { scope: 'same-course' });
  assert.equal(next.facts.length, 1); assert.equal(next.facts[0].supersedes, correction.factId);
  assert.equal(next.facts[0].reviewStatus, 'corrected');
  assert.equal((await f.facts.read(f.identity, a.activityId, { query: '不存在的偏好', scope: 'same-course' })).unknown.length, 1);
});

test('only current explicit user bytes become facts; edited and removed inputs follow their real public versions', { timeout: 60000 }, async t => {
  const f = await fixture(t), activity = await f.activity('明确输入与来源');
  for (const text of ['', '都可以', '演示画像：我喜欢音乐。', '我喜欢什么？'].filter(Boolean)) await f.input(activity, text);
  await f.input(activity, '解释分数', { retrieved: '我喜欢教师私有答案', action: { draft: { question: '我喜欢伪造画像' } } });
  assert.deepEqual((await f.facts.read(f.identity, activity.activityId)).facts, []);
  const accepted = await f.input(activity, '我喜欢用中文解释。');
  await f.runtime.inputControl(f.identity, accepted.sessionId, accepted.inputId, { requestId: randomUUID(), expectedVersion: 1, operation: 'edit', text: '我喜欢用英文解释。' });
  const edited = await f.facts.read(f.identity, activity.activityId);
  assert.equal(edited.facts.length, 1); assert.equal(edited.facts[0].statement, '我喜欢用英文解释。'); assert.equal(edited.facts[0].contentVersion, 2);
  const event = (await f.runtime.events(f.identity, accepted.sessionId)).find(event => event.kind === 'input-edited');
  assert.equal(edited.facts[0].source.eventId, event.eventId); assert.notEqual(event.eventId, accepted.event.eventId);
  await f.runtime.inputControl(f.identity, accepted.sessionId, accepted.inputId, { requestId: randomUUID(), expectedVersion: 2, operation: 'remove' });
  assert.deepEqual((await f.facts.read(f.identity, activity.activityId)).facts, []);
});

test('personal continuation remains ambiguous until the real activity explicitly continues the same goal', { timeout: 60000 }, async t => {
  const f = await fixture(t), original = await f.activity('整理分数笔记');
  await f.input(original, '我喜欢先给例子。');
  const unrelated = await f.activity('另一件无关的事');
  assert.equal((await f.facts.read(f.identity, unrelated.activityId)).continuation.state, 'ambiguous');
  assert.deepEqual((await f.facts.read(f.identity, unrelated.activityId)).facts, []);
  const continued = await f.activity('继续这个目标：整理分数笔记');
  const result = await f.facts.read(f.identity, continued.activityId);
  assert.equal(result.continuation.state, 'same-activity'); assert.equal(result.facts.length, 1);
  assert.deepEqual((await f.facts.read(f.identity, continued.activityId, { scope: 'current-activity' })).facts, []);
});

test('fresh source authorization, fixed session identity and missing evidence cannot leak another course or student', { timeout: 60000 }, async t => {
  const f = await fixture(t), activity = await f.activity('可撤销来源', randomUUID());
  const accepted = await f.input(activity, '这门课我喜欢用中文解释。');
  const realCore = f.source.core;
  f.source.core = async () => ({ sessionSnapshot: async (identity, id) => {
    const snapshot = await f.runtime.sessionSnapshot(identity, id);
    return { ...snapshot, session: { ...snapshot.session, identity: { ...snapshot.session.identity, principalId: randomUUID() } } };
  }, events: f.runtime.events });
  await assert.rejects(f.facts.read(f.identity, activity.activityId), { code: 'forbidden' });
  f.source.core = async () => ({ sessionSnapshot: f.runtime.sessionSnapshot, events: async () => [] });
  await assert.rejects(f.facts.read(f.identity, activity.activityId), { code: 'corrupt' });
  f.source.core = realCore;
  const read = f.source.sessions.read;
  f.source.sessions = { ...f.source.sessions, async read() { throw new StorageError('forbidden'); } };
  await assert.rejects(f.facts.read(f.identity, activity.activityId), { code: 'forbidden' });
  f.source.sessions = { ...f.source.sessions, read };
  await assert.rejects(f.facts.read({ ...f.identity, principalId: randomUUID() }, activity.activityId));
  assert.equal((await f.runtime.sessionSnapshot(f.identity, accepted.sessionId)).inputs.length, 1);
});

import { createAgentSessionService, createAgentSessionClient } from '../src/transport/session-service.ts';
import { createAgentConversationProjection } from '../../product-runtime/src/agent-conversation.ts';
test('the original remote Agent v2 snapshot/event ports produce the same facts and versions as the native core', { timeout: 60000 }, async t => {
  const f = await fixture(t), activity = await f.activity('远端原 owner', randomUUID());
  const input = await f.input(activity, '这门课我喜欢用中文解释。');
  const native = await f.facts.read(f.identity, activity.activityId);
  const calls = [];
  const service = createAgentSessionService({ ...f.runtime, ...createAgentConversationProjection(f.runtime) }, {
    audience: 'service', authorize: async (identity, sessionId) => { await f.sessions.read(identity, sessionId); },
  });
  const client = createAgentSessionClient(async call => { calls.push(call.operation); return JSON.parse(JSON.stringify(await service(JSON.parse(JSON.stringify(call))))); });
  f.source.core = async () => client;
  assert.deepEqual(await f.facts.read(f.identity, activity.activityId), native);
  assert.ok(calls.includes('events') && calls.includes('snapshot') && calls.includes('conversation'));
  assert.ok(calls.every(operation => ['events', 'snapshot', 'conversation'].includes(operation)));
  await client.inputControl(f.identity, input.sessionId, input.inputId, { requestId: randomUUID(), expectedVersion: 1, operation: 'edit', text: '这门课我喜欢用英文解释。' });
  assert.equal((await f.facts.read(f.identity, activity.activityId)).facts[0].contentVersion, 2);
  await client.inputControl(f.identity, input.sessionId, input.inputId, { requestId: randomUUID(), expectedVersion: 2, operation: 'remove' });
  assert.deepEqual((await f.facts.read(f.identity, activity.activityId)).facts, []);
});

test('source reads page every original event and reject concurrent versions or an owner redirect', { timeout: 60000 }, async t => {
  const f = await fixture(t), activity = await f.activity('分页与固定来源');
  const first = await f.input(activity, 'I prefer short explanations. Please always give an example.');
  await f.input(activity, '我喜欢用中文解释。');
  let pages = 0;
  const native = f.source.core;
  f.source.core = async () => ({ sessionSnapshot: f.runtime.sessionSnapshot, async events(...args) { pages++; return (await f.runtime.events(...args)).slice(0, 1); } });
  const result = await f.facts.read(f.identity, activity.activityId);
  assert.equal(result.facts.length, 3); assert.ok(pages >= 3);
  let snapshots = 0;
  f.source.core = async () => ({ events: f.runtime.events, async sessionSnapshot(...args) {
    if (++snapshots === 2) await f.runtime.inputControl(f.identity, first.sessionId, first.inputId,
      { requestId: randomUUID(), operation: 'edit', expectedVersion: 1, text: '我喜欢英文解释。' });
    return f.runtime.sessionSnapshot(...args);
  } });
  await assert.rejects(f.facts.read(f.identity, activity.activityId), { code: 'conflict' });
  f.source.core = native;
  const original = f.source.sessions;
  f.source.sessions = { ...original, async read(...args) {
    const session = await original.read(...args);
    return { ...session, owner: { ...session.owner, target: { ...session.owner.target, serviceId: randomUUID() } } };
  } };
  let resolutions = 0; f.source.core = async () => { resolutions++; return f.runtime; };
  await assert.rejects(f.facts.read(f.identity, activity.activityId), { code: 'conflict' }); assert.equal(resolutions, 0);
});
