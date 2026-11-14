import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { aggregationPackage } from '../../../../components/table-aggregation/package.mjs';
import { resolveCredential } from '@xunjie/product-runtime';

/** A published course and a real member session, without the retired Agent fixture. */
export async function recoveryCourse(f) {
  const admin = { authorization: 'Bearer ' + await resolveCredential(f.root, 'control') };
  const definition = await f.api('manage/component-import', { requestId: randomUUID(), ...await aggregationPackage() }, admin);
  const courseId = randomUUID(), releaseId = randomUUID(), password = randomUUID();
  await f.api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '独立 Agent 恢复真实计算' }, task: { taskId: randomUUID(), title: '解释真实分组均值', summary: '' },
    release: { releaseId, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
      objectives: ['恢复同一原命令'], requirements: '保留原计算与实际结果。', starterWorks: [], capabilities: [],
      components: [{ key: 'table', definition, configuration: { title: '真实分组计算' }, materialIds: [] }], materials: [] }, resources: [] }, admin);
  const member = await f.api('manage/members', { requestId: randomUUID(), loginName: 'independent-recovery-student', password }, admin);
  await f.api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);
  const login = await fetch(new URL('/api/learning/login', f.endpoint), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'independent-recovery-student', password }) });
  if (login.status !== 200) throw new Error('Recovery member login failed: ' + login.status);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
  const activity = await f.api('course-activities', { requestId: randomUUID(), releaseId }, headers);
  // Share only the controlled upstream route, not the personal owner's credential or selection.
  const [original] = await f.api('models/connections');
  const connectionId = randomUUID(), grantId = randomUUID();
  await f.api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '恢复会话上游',
    protocol: original.protocol, baseUrl: original.baseUrl, path: original.path, modelId: original.modelId,
    dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 2048,
    credential: { action: 'replace', value: 'synthetic-recovery-key' } }, headers);
  await f.api('models/grants', { requestId: randomUUID(), connectionId, grantId, owner: 'self' }, headers);
  const selection = await f.api('models/selection', undefined, headers);
  await f.api('models/selection', { requestId: randomUUID(), expectedVersion: selection.version,
    source: { kind: 'personal', connectionId, grantId } }, headers);
  const manifest = definition.manifest;
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
    mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
      instanceId: activity.activityId + ':table', componentId: manifest.componentId, version: manifest.version,
      definitionDigest: definition.digest, stateVersion: 1, operationId: randomUUID(), content: manifest.initialState }) };
  await f.api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 0, files: [work] }, headers);
  return { activity, headers, manifest, work };
}

/** Execute the production browser algorithm and published Wasm; callers control only result delivery. */
export async function runPublishedAggregation(action, manifest) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../../web/src/tool-execution/algorithm.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false });
  const js = bundled.outputFiles[0].text;
  const algorithm = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const published = await aggregationPackage();
  const computed = algorithm.runAggregation({ ...algorithm.jobFromAction(action, action.execution.limits),
    bytes: Buffer.from(published.algorithmBase64, 'base64'), memoryPages: manifest.algorithm.memoryPages, entry: manifest.algorithm.entry });
  const bytes = Buffer.from(computed.artifact.text);
  return { computed, resultInput: { contentId: randomUUID(), output: computed.result, text: computed.artifact.text,
    name: computed.artifact.name, mediaType: computed.artifact.mediaType,
    sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length } };
}

/** Real current scene pipeline, Gateway and native owners; only supplier I/O is controlled. */
export async function recoveryOwners(t, answer, { native = false, decorate = module => module } = {}) {
  const { createServer } = await import('node:http');
  const { nativeFixture } = await import('../../../../packages/storage/test/native-fixture.mjs');
  const { provisionStorage, openStorage, createFileBackend } = await import('@xunjie/storage');
  const { createSpaces, createCourses, createLearningData, spaceCourseMigrations, learningMigrations } = await import('@xunjie/learning-space');
  const { createModelGateway, modelMigrations } = await import('@xunjie/model-gateway');
  const { createAgentRuntime, agentRuntimeMigrations } = await import('@xunjie/agent-runtime');
  const { createWorkspaceAssistant, createWorkspaceToolModule } = await import('@xunjie/agents/workspace-assistant/index');
  const { accumulatorPackage } = await import('../../../../components/state-accumulator/package.mjs');
  const { question } = await import('../../../../packages/product-runtime/test/support/installed-agent-v2.mjs');
  const pg = await nativeFixture(), stores = [], payloads = [];
  let runtime, models, learning;
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks)); payloads.push(payload); await answer(payload, response, payloads.length);
    } catch (error) { response.destroy(error); }
  });
  t.after(async () => {
    try { await runtime?.close(); models?.closeWrites(); await models?.checks.drain(); await learning?.executions.shutdown(); }
    finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      for (const storage of stores.reverse()) await storage.close(); await pg.close();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function open(name, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: pg.root + '/' + name }) });
    stores.push(storage); return storage;
  }
  const space = await open('spaces', spaceCourseMigrations), spaces = createSpaces(space), courses = createCourses(space, spaces);
  const identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'recovery-owner', password: randomUUID() });
  const data = await open('data', learningMigrations); await spaces.bindMember(identity, { ...data.owner, version: 1 });
  learning = createLearningData(data, spaces, courses, {}, native ? { nodePath: process.execPath, sessionRoot: pg.root + '/native-sessions' } : undefined);
  const definition = await courses.components.register({ requestId: randomUUID(), ...await (native ? accumulatorPackage({ version: 1 }) : aggregationPackage()) });
  const courseId = randomUUID(), releaseId = randomUUID();
  await courses.registerRelease({ formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '真实工具恢复' },
    task: { taskId: randomUUID(), title: '原执行与迟到结果', summary: '' }, release: { releaseId, objectives: ['保留原执行'], requirements: '不得重发原效果。',
      starterWorks: [], materials: [], capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
      components: [{ key: native ? 'counter' : 'table', definition, configuration: { title: '原工具' }, materialIds: [] }] }, resources: [] });
  await courses.setAccess({ requestId: randomUUID(), courseId, principalId: identity.principalId, active: true });
  const activity = await learning.createCourse(identity, { requestId: randomUUID(), releaseId });
  models = await createModelGateway(await open('models', modelMigrations), { authorize: spaces.authorize, holder: 'device',
    authorizePermit: (who, permit) => runtime.assertDispatch(who, permit) });
  const connectionId = randomUUID(), grantId = randomUUID();
  await models.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '原工具恢复模型', protocol: 'chat-completions',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, path: '/chat/completions', modelId: 'real-tool-recovery',
    dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 2048,
    credential: { action: 'replace', value: 'synthetic-recovery-owner-key' } });
  await models.selection.createGrant(identity, identity, { requestId: randomUUID(), connectionId, grantId, owner: 'self' });
  await models.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
  const storage = await open('agent', agentRuntimeMigrations), options = { models, learning, courses, workspace: () => learning.open(identity, activity.activityId) };
  runtime = createAgentRuntime(storage, { authorize: spaces.authorize,
    pipeline: createWorkspaceAssistant({ ...options, tools: [decorate(createWorkspaceToolModule(options))] }) });
  const sessionId = randomUUID();
  await runtime.initialize({ sessionId, identity, scenario: 'workspace-assistant', restartPolicy: 'automatic', createdAt: new Date().toISOString() });
  return { pg, runtime, storage, data, models, learning, identity, activity, sessionId, manifest: definition.manifest, payloads,
    async send(text = '保留原执行', works = []) {
      return runtime.accept(identity, question(activity, { sessionId }, text, randomUUID(), { works }));
    },
    snapshot: runId => runtime.snapshot(identity, sessionId, runId),
    async guard(association) {
      const snapshot = await runtime.snapshot(identity, sessionId, association.runId);
      const step = snapshot.steps.find(step => step.operation.operationId === association.commandId);
      if (!step) throw new Error('The original command must exist in its own Run.');
      await runtime.assertDispatch(identity, { sessionId, runId: association.runId, stepId: step.stepId,
        operationId: step.operation.operationId, generation: snapshot.run.generation });
    } };
}
