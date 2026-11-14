import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { openStorage, provisionStorage, createFileBackend } from '@xunjie/storage';
import { createSpaces, createCourses, createLearningData, spaceCourseMigrations, learningMigrations } from '@xunjie/learning-space';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { agentServiceMigrations } from '@xunjie/agents/transport/session-storage';
import { createAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createSessionMaterials } from '@xunjie/learning-space/learning-data/session-materials';
import { createProductAgent } from '../../../../packages/product-runtime/dist/product-agent.js';
import { createWorkspaceAgentAuthority } from '../../../../packages/product-runtime/dist/workspace-agent-authority.js';

export async function until(check, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw new Error(description);
}
export function reply(response, { text = '', calls = [] } = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map((call, index) => ({
    index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  })) } : {}) };
  response.end('data: ' + JSON.stringify({ id: 'session-product', choices: [{ index: 0, delta,
    finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\ndata: [DONE]\n\n');
}

/** Controlled supplier response for the real student's fixed semantic-policy operation. */
export function replyStudentPolicy(payload, response) {
  if (!payload.messages?.some(message => message.role === 'system' && typeof message.content === 'string'
    && message.content.startsWith('STUDENT_INPUT_POLICY_V2\n'))) return false;
  const content = payload.messages.at(-1).content;
  const source = JSON.parse(typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''));
  reply(response, { text: JSON.stringify({ inputDigest: source.inputDigest, creationAuthorization: 'ordinary' }) });
  return true;
}

/** Real product HTTP and native owners. Only the model supplier and intentional delayed I/O are controlled. */
export async function fixture(answer = (_payload, response) => reply(response, { text: '已按当前问题完成。' })) {
  if (!process.env.XUNJIE_PRODUCT_POSTGRES_BIN) throw new Error('Requires native PostgreSQL 18.6.');
  const payloads = [], failures = [], agents = [], storages = [], modelServices = [], learningServices = [];
  const upstream = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks)); payloads.push(payload); await answer(payload, response, payloads.length);
    } catch (error) { failures.push(error); response.destroy(error); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-session-behavior-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources }); await runtime.install({ profile: 'local' });
  let state = await runtime.start(), endpoint = state.endpoint;
  const raw = async (route, body, headers = { 'x-xj-space': 'personal' }) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), { headers: {
      'content-type': 'application/json', 'x-xj-agent-contract': '2', ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const api = async (route, body, headers) => { const result = await raw(route, body, headers);
    assert.equal(result.status, 200, route + ': ' + JSON.stringify(result.body)); return result.body; };
  const modelRoute = { protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions' };
  const configure = async (port, identity) => {
    const connectionId = randomUUID(), grantId = randomUUID();
    const input = { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '真实会话行为', ...modelRoute,
      modelId: 'fixture-session', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-session-key' } };
    if (identity) {
      await port.save(identity, input);
      await port.selection.createGrant(identity, identity, { requestId: randomUUID(), connectionId, grantId, owner: 'self' });
      const selected = await port.selection.read(identity);
      await port.selection.save(identity, { requestId: randomUUID(), expectedVersion: selected.version, source: { kind: 'personal', connectionId, grantId } });
    } else {
      await api('models/connections', input); await api('models/grants', { requestId: randomUUID(), connectionId, grantId, owner: 'self' });
      const selected = await api('models/selection'); await api('models/selection', { requestId: randomUUID(), expectedVersion: selected.version,
        source: { kind: 'personal', connectionId, grantId } });
    }
  };
  return { root, resources, runtime, raw, api, payloads, failures, get endpoint() { return endpoint; },
    configure: () => configure(),
    activity: (goal = '真实工作区行为') => api('activities', { requestId: randomUUID(), goal, question: '', references: [] }),
    async send(activity, text, _delivery, works = []) {
      const session = await api('agent-sessions/workspace', { activityId: activity.activityId, target: activity.target });
      const action = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
        receiver: { receiverId: 'teaching-agent:' + session.owner.target.serviceId, location: session.owner.target.environmentId === state.environment.environmentId ? 'local' : 'remote', kind: 'question' },
        draft: { token: randomUUID(), question: text, references: [], bases: [] }, works, evidence: [] };
      const input = { requestId: randomUUID(), sessionId: session.sessionId, text, context: { action } };
      const receipt = await api(`agent-sessions/${session.sessionId}/inputs`, input);
      return { ...receipt, sessionId: session.sessionId, receipt, input };
    },
    async controlled(activity, overrides = {}) {
      const env = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
      async function reopen(unit, migrations) {
        const service = env.services.find(item => item.unit === unit), binding = JSON.parse(await resolveCredential(root, 'storage-' + service.serviceId));
        const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) }) });
        storages.push(storage); return storage;
      }
      const spaceStorage = await reopen('space-course', spaceCourseMigrations), spaces = createSpaces(spaceStorage), courses = createCourses(spaceStorage, spaces);
      const originalData = await reopen('learning-data', learningMigrations);
      const data = overrides.stageResource ? { ...originalData, stageResource: input => overrides.stageResource(input, originalData.stageResource) } : originalData;
      const modelStorage = await reopen('model-connection', modelMigrations);
      let agent, authority;
      const models = await createModelGateway(modelStorage, { holder: 'device', authorize: spaces.authorize,
        authorizePermit: (who, permit) => agent.assertDispatch(who, permit) });
      modelServices.push(models); await configure(models, activity.identity);
      const { credentialRef, ...connection } = await runtime.database();
      const binding = await provisionStorage({ admin: { ...connection, password: await resolveCredential(root, credentialRef) },
        owner: { environmentId: env.environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations: agentServiceMigrations });
      const storage = await openStorage({ binding, migrations: agentServiceMigrations,
        backend: createFileBackend({ id: 'session-agent', root: join(root, 'controlled-agent') }) }); storages.push(storage);
      const learning = createLearningData(data, spaces, courses, {}, undefined, undefined,
        (...args) => authority.assertArtifactAdoption(...args)); learningServices.push(learning);
      const owner = { version: 1, connectionId: storage.owner.serviceId, installationId: env.installationId,
        target: { ...storage.owner, unit: 'teaching-agent', endpoint, protocolVersion: 1, capabilities: ['agent.sessions.v2'] } };
      const directory = createAgentSessions(data, { authorize: spaces.authorize, openActivity: learning.open, resolveOwner: async () => owner });
      const materials = createSessionMaterials(data, { courses, openScope: (who, scope) => scope.kind === 'session'
        ? directory.read(who, scope.sessionId) : learning.open(who, scope.activityId) });
      agent = createProductAgent({ storage, directory, models, authorize: spaces.authorize, materials: async () => materials,
        workspace: async session => ({ workspace: () => learning.open(session.identity, session.workspace.activityId), learning, courses }) });
      agents.push(agent);
      authority = createWorkspaceAgentAuthority({ sessions: directory.list, agent: async () => agent.local, activity: learning.open });
      const session = await agent.sessions.workspace(activity.identity, activity.activityId, activity.target);
      return { agent, learning, spaces, courses, storage, models, directory, session,
        sessionHttp: { sessions: agent.sessions, agent: async () => agent.local, materials: async () => materials },
        authority,
        async send(text) {
          const action = { requestId: randomUUID(), scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
            principalId: activity.identity.principalId, activityId: activity.activityId }, receiver: { receiverId: 'teaching-agent:' + storage.owner.serviceId,
            location: 'local', kind: 'question' }, draft: { token: randomUUID(), question: text, references: [], bases: [] }, works: [], evidence: [] };
          return agent.local.accept(activity.identity, { requestId: randomUUID(), sessionId: session.sessionId, text, context: { action } });
        } };
    },
    async restart() { await runtime.stop(); state = await runtime.start(); endpoint = state.endpoint; },
    async close() {
      await Promise.allSettled(agents.map(agent => agent.close()));
      upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
      for (const models of modelServices) { models.closeWrites(); await models.checks.drain(); }
      await Promise.all(learningServices.map(learning => learning.executions.shutdown()));
      await Promise.allSettled(storages.map(storage => storage.close()));
      await runtime.stop(); await rm(root, { recursive: true, force: true });
    } };
}
