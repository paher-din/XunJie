import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createLearningData, learningMigrations } from '../dist/learning-data/index.js';
import { createPersonalProjects, personalProjectMigration, validatePersonalProjects, collectPersonalProjectSources,
  validatePersonalProjectSources } from '../dist/learning-data/personal-projects.js';
import { agentSessionMigration } from '../dist/learning-data/agent-sessions.js';
import { sessionMaterialMigration } from '../dist/learning-data/session-materials.js';
import { createLearningQuery } from '../dist/learning-data/learning-query.js';

async function fixture(t) {
  const pg = await nativeFixture(); let storage;
  t.after(async () => { try { await storage?.close(); } finally { await pg.close(); } });
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const migrations = [...learningMigrations.filter(m => m.version < 31), agentSessionMigration, sessionMaterialMigration, personalProjectMigration];
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations });
  storage = await openStorage({ binding, backend: createFileBackend({ id: 'files', root: pg.root + '/objects' }), migrations });
  const target = { ...owner, version: 1 };
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  let allowed = true;
  const authorize = async () => { if (!allowed) throw new StorageError('forbidden'); };
  const learning = createLearningData(storage, { resolveBinding: async () => { await authorize(); return target; } });
  const projects = () => createPersonalProjects(storage, { authorize, learning });
  return { identity, target, learning, storage, authorize, projects, deny() { allowed = false; } };
}
const request = () => ({ operationId: randomUUID(), sourceSessionId: randomUUID(), inputId: randomUUID(),
  content: { title: '学习排序', goal: '理解稳定排序', stages: [{ title: '比较两种算法', goal: '解释稳定性' }], materialRefs: [] } });

test('a personal project retains initial content and recovers one real workspace by its original operation', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = request(), owner = f.projects();
  const created = await owner.create(f.identity, input);
  assert.equal(created.content.title, '学习排序');
  assert.equal(created.content.stages[0].goal, '解释稳定性');
  assert.equal((await f.learning.open(f.identity, created.activityId)).goal, '理解稳定排序');
  assert.deepEqual(await f.projects().create(f.identity, input), created);
  assert.deepEqual(await f.projects().receipt(f.identity, input.operationId), created);
  assert.equal((await f.learning.list(f.identity)).length, 1);
  assert.deepEqual(await owner.list(f.identity), [created]);
  await assert.rejects(owner.create(f.identity, { ...input, content: { ...input.content, title: '另一个项目' } }), { code: 'identity-conflict' });
  await assert.rejects(owner.read({ ...f.identity, kind: 'school' }, created.projectId), { code: 'forbidden' });
  f.deny();
  await assert.rejects(owner.create(f.identity, input), { code: 'forbidden' });
  await assert.rejects(owner.receipt(f.identity, input.operationId), { code: 'forbidden' });
});

test('an interrupted operation retains its content and survives display-name changes and concurrent resumes', { timeout: 60000 }, async t => {
  const f = await fixture(t), input = request();
  const interrupted = createPersonalProjects(f.storage, { authorize: f.authorize, learning: {
    ...f.learning, async create(actor, request) { await f.learning.create(actor, request); throw new Error('lost activity response'); },
  } });
  await assert.rejects(interrupted.create(f.identity, input), /lost activity response/);
  assert.equal((await f.learning.list(f.identity)).length, 1);
  assert.equal(await f.projects().receipt(f.identity, input.operationId), null);
  await assert.rejects(f.projects().create(f.identity, { ...input, content: { ...input.content, title: '换内容' } }), { code: 'identity-conflict' });
  const renamed = { ...f.identity, name: '新名字' };
  const [a, b] = await Promise.all([f.projects().create(renamed, input), f.projects().create(renamed, input)]);
  assert.deepEqual(a, b);
  assert.equal((await f.learning.list(renamed)).length, 1);
  assert.equal((await f.projects().list(renamed)).length, 1);
  for (const key of ['environmentId', 'spaceId', 'principalId'])
    await assert.rejects(f.projects().read({ ...renamed, [key]: randomUUID() }, a.projectId), { code: 'forbidden' });
});

test('the homepage exposes one personal project task and can read real immutable work content', { timeout: 60000 }, async t => {
  const f = await fixture(t), projects = f.projects(), project = await projects.create(f.identity, request());
  const query = createLearningQuery({ sources: async () => [{ sourceId: 'local-personal', identity: f.identity,
    target: f.target, learning: f.learning, personalProjects: projects }] });
  const tasks = await query.listLearningTasks();
  assert.equal(tasks.items.length, 1);
  assert.equal(tasks.items[0].reference.kind, 'personal-project');
  const file = { objectId: randomUUID(), contentId: randomUUID(), name: '观察.md', kind: 'text', encoding: 'utf8', mediaType: 'text/markdown', value: '稳定排序的观察结果' };
  await f.learning.works.sync(f.identity, project.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] });
  const page = await query.searchLearning({ query: '观察结果', kinds: ['work'] });
  assert.equal(page.items.length, 1);
  const ref = page.items[0].reference;
  await f.learning.works.sync(f.identity, project.activityId, { requestId: randomUUID(), baseRevision: 1, files: [] });
  assert.ok((await query.readLearning({ reference: ref })).text.includes('稳定排序的观察结果'));
  f.deny();
  await assert.rejects(query.readLearning({ reference: ref }), { code: 'forbidden' });
});

test('workspace consumers read the real initial project by activity and maintenance validates it without live authorization', { timeout: 60000 }, async t => {
  const f = await fixture(t), owner = f.projects(), project = await owner.create(f.identity, request());
  assert.deepEqual(await owner.readForActivity(f.identity, project.activityId), project);
  const ordinary = await f.learning.create(f.identity, { requestId: randomUUID(), goal: '独立问答', question: '', references: [] });
  assert.equal(await owner.readForActivity(f.identity, ordinary.activityId), null);
  const school = { ...f.identity, kind: 'school', principalId: randomUUID() };
  const schoolActivity = await f.learning.create(school, { requestId: randomUUID(), goal: '学校活动', question: '', references: [] });
  assert.equal(await owner.readForActivity(school, schoolActivity.activityId), null);
  await assert.rejects(owner.readForActivity(school, project.activityId), error => ['missing', 'forbidden'].includes(error.code));
  const closure = await collectPersonalProjectSources(f.storage);
  assert.equal(closure.entries.length, 1);
  assert.equal(closure.entries[0].activityId, project.activityId);
  await validatePersonalProjectSources(f.storage, closure);
  await owner.validate();
  f.deny();
  await assert.rejects(owner.readForActivity(f.identity, project.activityId), { code: 'forbidden' });
  await validatePersonalProjects(f.storage);
  await f.storage.request({ requestId: randomUUID(), fingerprint: 'corrupt-project-test' }, async tx => {
    await tx.query("UPDATE personal_learning_projects SET body=jsonb_set(body,'{activityId}',to_jsonb($1::text)) WHERE project_id=$2", [randomUUID(), project.projectId]);
    return null;
  });
  await assert.rejects(owner.validate(), { code: 'corrupt' });
  await assert.rejects(validatePersonalProjectSources(f.storage, closure), { code: 'corrupt' });
});
