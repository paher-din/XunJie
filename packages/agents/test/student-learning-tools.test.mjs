import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createLearningTools } from '../src/student-assistant/tools/learning-tools.ts';
import { createToolDiscovery } from '../src/capabilities/tool-discovery/index.ts';
import { createLearningQuery } from '../../learning-space/dist/learning-data/learning-query.js';
import { canonicalDigest } from '@xunjie/storage/identity';

function context() {
  const sessionId = randomUUID(), inputId = randomUUID(), runId = randomUUID();
  return { operationId: randomUUID(), inputIds: [inputId], context: { system: '', facts: {}, sources: [] },
    snapshot: { session: { sessionId, scenario: 'student-assistant' }, run: { runId, sessionId, inputId },
      inputs: [{ inputId, version: 1, sequence: 1, input: { sessionId, text: '创建一个排序实践项目', context: {}, mode: 'steering' } }], waits: [], steps: [] } };
}
async function prepare(tools, call, ctx) {
  const offer = (await tools.list(ctx)).find(o => o.definition.name === call.name);
  return tools.prepare(ctx, offer, { ...call, callId: 'model-call' }, ctx.operationId);
}
async function dispatch(tools, prepared, ctx, assertDispatch = async () => {}) {
  return tools.dispatch(ctx, prepared, { sessionId: ctx.snapshot.session.sessionId, runId: ctx.snapshot.run.runId,
    operationId: prepared.commandId, stepId: randomUUID(), generation: ctx.snapshot.run.generation ?? 1 }, assertDispatch);
}
function fixture() {
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  const target = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 };
  const projects = new Map(), sessions = new Map(), links = new Map();
  let authorization = ctx => ({ kind: 'explicit', inputId: ctx.inputIds[0] }), failSession = false;
  const host = { localPersonalIdentity: identity, localLearningTarget: target,
    query: createLearningQuery({ sources: async () => [] }),
    async authorizeCreation(ctx) { return authorization(ctx); },
    projects: {
      async create(actor, value) {
        assert.deepEqual(actor, identity);
        let project = projects.get(value.operationId);
        if (!project) { project = { ...value, projectId: randomUUID(), activityId: randomUUID(), workspaceSessionId: randomUUID(),
          identity, target, createdAt: '2026-11-13T00:00:00.000Z' }; projects.set(value.operationId, project); }
        return project;
      }, async receipt(_actor, operationId) { return projects.get(operationId) ?? null; },
    },
    workspaceSessions: {
      async ensure(actor, request) {
        assert.deepEqual(actor, identity);
        const session = { sessionId: request.sessionId, activityId: request.activityId, target: request.target, ready: true };
        sessions.set(request.sessionId, session);
        if (failSession) { failSession = false; throw new Error('lost session response'); }
        return session;
      }, async receipt(_actor, sessionId) { return sessions.get(sessionId) ?? null; },
    },
    materials: {
      async adopt(_actor, input) { const value = { requestId: input.requestId, activityId: input.activityId, references: input.references }; links.set(input.requestId, value); return value; },
      async receipt(_actor, requestId) { return links.get(requestId) ?? null; },
    },
  };
  return { host, tools: () => createLearningTools(host), projects, sessions, links,
    authorize(value) { authorization = value; }, failSession() { failSession = true; } };
}
const content = () => ({ title: '排序实践', goal: '理解排序稳定性', stages: [{ title: '观察', goal: '比较结果' }], materialRefs: [] });

test('discovery keeps the frozen delegate envelope across read-only project recovery', async () => {
  const f = fixture(), ctx = context();
  ctx.snapshot.session.identity = f.host.localPersonalIdentity;
  ctx.snapshot.sessionState = {};
  const tools = createToolDiscovery({ modules: [f.tools()], initiallyVisible: () => true });
  const prepared = await prepare(tools, { name: 'create_personal_project', arguments: content() }, ctx);
  f.failSession();
  await assert.rejects(dispatch(tools, prepared, ctx), /lost session response/);
  const pending = await tools.reconcile(ctx, prepared);
  assert.ok(pending.nextCommand);
  const next = pending.nextCommand;
  assert.equal(next.input.kind, 'delegate');
  assert.deepEqual(next.input.binding, prepared.input.binding);
  assert.equal(next.input.moduleVersion, prepared.input.moduleVersion);
  assert.equal(next.input.command.commandId, next.commandId);
  assert.equal(next.input.command.input.request.operationId, prepared.commandId);
  assert.deepEqual(await tools.reconcile(ctx, prepared), pending, 'read-only proposals are stable');
  assert.equal(f.links.size, 0);
  await assert.rejects(tools.dispatch(ctx, next, { sessionId: ctx.snapshot.session.sessionId, runId: ctx.snapshot.run.runId,
    operationId: prepared.commandId, stepId: randomUUID(), generation: 1 }, async () => {}), { code: 'forbidden' });
  await assert.rejects(dispatch(tools, next, ctx, async () => { throw new Error('permit revoked'); }), /permit revoked/);
  assert.equal(f.links.size, 0);
  const adopt = f.host.materials.adopt;
  let revoked = false;
  f.host.materials.adopt = async (...args) => { const receipt = await adopt(...args); revoked = true; return receipt; };
  await assert.rejects(dispatch(tools, next, ctx, async () => { if (revoked) throw new Error('permit revoked after adopt'); }), /permit revoked after adopt/);
  assert.equal((await tools.reconcile(ctx, next)).state, 'completed', 'a committed receipt remains readable after dispatch revocation');
  assert.equal((await dispatch(tools, next, ctx)).state, 'completed');
  assert.equal(f.projects.size, 1); assert.equal(f.links.size, 1);
});

test('public tools accept creation content only, require current input authorization and preserve one card across recovery', async () => {
  const f = fixture(), tools = f.tools(), ctx = context();
  const call = { name: 'create_personal_project', arguments: content() };
  for (const extra of [{ owner: 'school' }, { identity: f.host.localPersonalIdentity }, { operationId: randomUUID() }])
    await assert.rejects(prepare(tools, { ...call, arguments: { ...call.arguments, ...extra } }, ctx));
  f.authorize(() => null);
  await assert.rejects(prepare(tools, call, ctx), { code: 'forbidden' });
  f.authorize(() => ({ kind: 'explicit', inputId: randomUUID() }));
  await assert.rejects(prepare(tools, call, ctx), { code: 'forbidden' });
  f.authorize(c => ({ kind: 'explicit', inputId: c.inputIds[0] }));
  const prepared = await prepare(tools, call, ctx);
  assert.equal(f.projects.size, 0);
  f.failSession();
  await assert.rejects(dispatch(tools, prepared, ctx), /lost session response/);
  assert.equal(f.projects.size, 1);
  const pending = await f.tools().reconcile(ctx, prepared);
  assert.equal(pending.state, 'unknown');
  assert.ok(pending.nextCommand);
  assert.notEqual(pending.nextCommand.commandId, prepared.commandId);
  assert.equal(f.links.size, 0, 'reconcile only reads original receipts');
  const result = await dispatch(f.tools(), pending.nextCommand, ctx);
  assert.equal(result.state, 'completed');
  assert.equal(result.result.workspace.title, '排序实践');
  assert.equal(result.result.workspace.activityId, [...f.projects.values()][0].activityId);
  assert.deepEqual(await f.tools().reconcile(ctx, prepared), result);
  assert.deepEqual(await dispatch(tools, prepared, ctx), result);
  assert.equal(f.projects.size, 1); assert.equal(f.sessions.size, 1); assert.equal(f.links.size, 1);
  await assert.rejects(dispatch(tools, prepared, { ...ctx, inputIds: [randomUUID()] }), { code: 'forbidden' });
});

test('creation confirmation is tied to the current input and the actual consumed wait response', async () => {
  const f = fixture(), tools = f.tools(), ctx = context(), inputId = ctx.inputIds[0];
  const wait = { waitId: randomUUID(), runId: ctx.snapshot.run.runId, state: 'consumed', version: 2,
    presentation: { sourceInputId: inputId, question: '创建排序项目吗？' }, response: { kind: 'choice', optionId: 'create' } };
  ctx.snapshot.waits = [wait];
  const evidence = { kind: 'confirmed', inputId, waitId: wait.waitId, responseDigest: canonicalDigest(wait.response) };
  f.authorize(() => evidence);
  const call = { name: 'create_personal_project', arguments: content() };
  const prepared = await prepare(tools, call, ctx);
  wait.response = { kind: 'choice', optionId: 'cancel' };
  await assert.rejects(dispatch(tools, prepared, ctx), { code: 'forbidden' });
  assert.equal(f.projects.size, 0);
  wait.response = { kind: 'choice', optionId: 'create' };
  wait.presentation.sourceInputId = randomUUID();
  await assert.rejects(prepare(tools, call, ctx), { code: 'forbidden' });
  wait.presentation.sourceInputId = inputId;
  wait.state = 'pending';
  await assert.rejects(prepare(tools, call, ctx), { code: 'forbidden' });
  wait.state = 'consumed';
  const result = await dispatch(tools, prepared, ctx);
  assert.equal(result.state, 'completed');
  assert.equal([...f.projects.values()][0].responseId, wait.waitId);
});

test('a confirmation-only turn validates the original input of the current run without inventing a new CoreInput', async () => {
  const f = fixture(), tools = f.tools(), ctx = context(), inputId = ctx.snapshot.run.inputId;
  ctx.inputIds = [];
  const wait = { waitId: randomUUID(), runId: ctx.snapshot.run.runId, state: 'consumed', version: 2,
    presentation: { sourceInputId: inputId, question: '创建排序项目吗？' }, response: { kind: 'choice', optionId: 'create' } };
  ctx.snapshot.waits = [wait];
  f.authorize(() => ({ kind: 'confirmed', inputId, waitId: wait.waitId, responseDigest: canonicalDigest(wait.response) }));
  const prepared = await prepare(tools, { name: 'create_personal_project', arguments: content() }, ctx);
  assert.equal((await dispatch(tools, prepared, ctx)).state, 'completed');
});

test('revoked dispatch stops each remaining side effect and a school session still creates only in local personal scope', async () => {
  const f = fixture(), tools = f.tools(), ctx = context();
  ctx.snapshot.session.identity = { ...f.host.localPersonalIdentity, kind: 'school', principalId: randomUUID() };
  const prepared = await prepare(tools, { name: 'create_personal_project', arguments: content() }, ctx);
  let checkpoints = 0;
  await assert.rejects(dispatch(tools, prepared, ctx, async () => {
    if (++checkpoints === 2) throw new Error('permit revoked');
  }), /permit revoked/);
  assert.equal(f.projects.size, 1); assert.equal(f.sessions.size, 0); assert.equal(f.links.size, 0);
  const completed = await dispatch(tools, prepared, ctx);
  assert.deepEqual(completed.result.workspace.identity, f.host.localPersonalIdentity);
  assert.deepEqual(completed.result.workspace.target, f.host.localLearningTarget);
  const changedOwner = f.tools();
  f.host.localLearningTarget = { ...f.host.localLearningTarget, serviceId: randomUUID() };
  await assert.rejects(f.tools().reconcile(ctx, prepared), { code: 'forbidden' });
  assert.equal((await changedOwner.reconcile(ctx, prepared)).state, 'completed');
});

test('query tool definitions and feedback use the public module and preserve complete versioned references', async () => {
  const f = fixture(), ctx = context(), reference = { sourceId: 'local', identity: { ...f.host.localPersonalIdentity },
    owner: f.host.localLearningTarget, kind: 'activity', objectId: randomUUID(), version: 'original' };
  delete reference.identity.name;
  f.host.query = { ...f.host.query, async listLearningTasks(input) {
    return { items: Array.from({ length: input.limit }, (_, index) => ({ title: '任务' + index, excerpt: 'x'.repeat(2000), reference,
      dueAt: null, missing: ['deadline'] })), offset: input.offset, limit: input.limit, nextOffset: input.offset + input.limit, unavailable: [] };
  } };
  const tools = f.tools(), offers = await tools.list(ctx);
  assert.deepEqual(offers.map(o => [o.definition.name, o.effect]), [
    ['list_learning_tasks', 'read'], ['search_learning', 'read'], ['read_learning', 'read'], ['create_personal_project', 'write'],
  ]);
  const prepared = await prepare(tools, { name: 'list_learning_tasks', arguments: { limit: 50 } }, ctx);
  const result = await dispatch(tools, prepared, ctx);
  assert.ok(result.feedback.text.length <= 8192);
  assert.deepEqual(JSON.parse(result.feedback.text), result.result);
  assert.deepEqual(result.result.items[0].reference, reference);
  assert.equal(result.result.nextOffset, result.result.items.length);
});

test('initial attachment references keep their source identity and version, and a failed adoption resumes only the original project', async () => {
  const f = fixture(), ctx = context(), sourceIdentity = { ...f.host.localPersonalIdentity };
  delete sourceIdentity.name;
  const material = { sourceId: 'local-personal', identity: sourceIdentity, owner: f.host.localLearningTarget,
    kind: 'personal-material', objectId: randomUUID(), version: '3', sha256: 'b'.repeat(64),
    scope: { kind: 'session', sessionId: ctx.snapshot.session.sessionId } };
  const call = { name: 'create_personal_project', arguments: { ...content(), materialRefs: [material] } };
  const adopt = f.host.materials.adopt;
  f.host.materials.adopt = async () => { throw new Error('source owner disconnected'); };
  const prepared = await prepare(f.tools(), call, ctx);
  await assert.rejects(dispatch(f.tools(), prepared, ctx), /source owner disconnected/);
  assert.deepEqual([...f.projects.values()][0].content.materialRefs, [material]);
  const pending = await f.tools().reconcile(ctx, prepared);
  assert.equal(pending.state, 'unknown');
  assert.ok(pending.nextCommand);
  assert.equal(pending.result.workspace, undefined);
  f.host.materials.adopt = adopt;
  const completed = await dispatch(f.tools(), pending.nextCommand, ctx);
  assert.equal(completed.state, 'completed');
  assert.equal(f.projects.size, 1);
  assert.deepEqual([...f.links.values()][0].references, [material]);
});

test('home queries retain task provenance while withholding help content from a course with questions disabled', async () => {
  const f = fixture(), ctx = context(), identity = { ...f.host.localPersonalIdentity }; delete identity.name;
  const reference = { sourceId: 'school-owner', identity, owner: f.host.localLearningTarget,
    kind: 'work', objectId: randomUUID(), activityId: randomUUID(), version: randomUUID() };
  const provenance = { activity: { activityId: reference.activityId, target: reference.owner }, course: {
    courseId: randomUUID(), courseName: '受限课程', taskId: randomUUID(), taskTitle: '独立完成的任务', releaseId: randomUUID(),
    contentDigest: 'a'.repeat(64), helpPolicy: { version: 1, questions: 'disabled', scope: 'course' } } };
  const detail = { reference, provenance, text: 'COURSE_HELP_CONTENT_MUST_NOT_REACH_MODEL',
    range: { offset: 0, length: 44, total: 44, nextOffset: null }, missing: [], role: 'source-data' };
  const item = { reference, provenance, title: '任务目录项', excerpt: detail.text, dueAt: null, missing: ['deadline'] };
  f.host.query = {
    async readLearning() { return detail; },
    async listLearningTasks() { return { items: [item], offset: 0, limit: 1, nextOffset: null, unavailable: [] }; },
    async searchLearning() { return { items: [item], offset: 0, limit: 1, nextOffset: null, unavailable: [] }; },
  };
  const tools = f.tools();
  for (const call of [{ name: 'read_learning', arguments: { reference } }, { name: 'list_learning_tasks', arguments: {} },
    { name: 'search_learning', arguments: { query: '任务' } }]) {
    const result = await dispatch(tools, await prepare(tools, call, ctx), ctx);
    assert.doesNotMatch(JSON.stringify(result), /COURSE_HELP_CONTENT_MUST_NOT_REACH_MODEL/);
    const source = result.result.items?.[0] ?? result.result;
    assert.deepEqual(source.reference, reference);
    assert.deepEqual(source.provenance, provenance);
    assert.ok(source.missing.includes('course-agent-help-disabled'));
  }
  assert.equal(detail.text, 'COURSE_HELP_CONTENT_MUST_NOT_REACH_MODEL', 'projection cannot mutate the owner source');
  assert.equal(f.projects.size, 0);
});
