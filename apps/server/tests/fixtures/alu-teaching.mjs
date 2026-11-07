import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { createFileBackend, openStorage } from '@xunjie/storage';
import { createSpaces, createCourses, createLearningData, createTeachingTools,
  spaceCourseMigrations, learningMigrations } from '@xunjie/learning-space';
import { aluPackage, aluCoursePackage } from '../../../../components/alu-experiment/package.mjs';

/** Production imports, eligibility and native PG owners; no simulation or model is substituted. */
export async function aluTeachingFixture(t, { priorCourse } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xj-alu-teaching-'));
  const storages = [];
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  let learning;
  t.after(async () => {
    await learning?.executions.shutdown();
    await Promise.allSettled(storages.map(storage => storage.close()));
    await runtime.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await runtime.install({ profile: 'local' });
  const endpoint = (await runtime.start()).endpoint;
  const adminHeaders = { authorization: 'Bearer ' + await resolveCredential(root, 'control') };
  const api = async (route, body, headers = adminHeaders) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), {
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, 200, route + ': ' + JSON.stringify(value));
    return value;
  };
  const definition = await api('manage/component-import', await aluPackage());
  if (priorCourse) {
    priorCourse.release.components[0].definition = definition;
    await api('manage/course-import', priorCourse);
  }
  const published = await aluCoursePackage();
  published.release.components[0].definition = definition;
  await api('manage/course-import', published);
  const password = randomUUID();
  const member = await api('manage/members', { requestId: randomUUID(), loginName: 'alu-teaching-student', password });
  await api('manage/course-access', { requestId: randomUUID(), courseId: published.course.courseId, principalId: member.principalId, active: true });
  const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'alu-teaching-student', password }) });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
  const activity = await api('course-activities', { requestId: randomUUID(), releaseId: published.release.releaseId }, headers);
  const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
  async function reopen(unit, migrations) {
    const service = environment.services.find(item => item.unit === unit);
    const storage = await openStorage({ binding: JSON.parse(await resolveCredential(root, 'storage-' + service.serviceId)), migrations,
      backend: createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) }) });
    storages.push(storage);
    return storage;
  }
  const spaces = createSpaces(await reopen('space-course', spaceCourseMigrations));
  const courses = createCourses(storages[0], spaces);
  learning = createLearningData(await reopen('learning-data', learningMigrations), spaces, courses);
  const host = createTeachingTools({ learning: () => learning, courses });
  const identity = activity.identity;
  const input = { requestId: randomUUID(), scope: { environmentId: identity.environmentId, spaceId: identity.spaceId,
    principalId: identity.principalId, activityId: activity.activityId },
    receiver: { receiverId: 'student-agent', location: 'local', kind: 'question' },
    draft: { token: randomUUID(), question: '解释这个输入的进位', references: [], bases: [] }, works: [], evidence: [] };
  const scope = { identity, activity, input, runId: randomUUID(), stepId: randomUUID(), snapshotId: randomUUID(), assertDispatch: async () => {} };
  return { host, scope, learning, courses, api: (route, body) => api(route, body, headers), activity, runtime, root, endpoint, headers };
}

/** Only model output/timing is controlled; requests, model owner and Agent owner remain production. */
export async function aluTeachingModel(t, f, answer) {
  const payloads = [], errors = [];
  const upstream = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      payloads.push(payload);
      await answer(payload, response, payloads.length);
    } catch (error) { errors.push(String(error)); response.destroy(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const connectionId = randomUUID(), grantId = randomUUID();
  await f.api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
    name: 'ALU public-boundary timing', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    path: '/chat/completions', modelId: 'alu-timing', dialect: 'standard', parameterMode: 'plain', enabled: true,
    contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-alu-test-key' } });
  await f.api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
  await f.api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
  return { payloads, errors,
    async send(question, works = [], references = [], bases = []) {
      const input = structuredClone(f.scope.input);
      input.requestId = randomUUID(); input.works = works;
      input.draft = { token: randomUUID(), question, references, bases };
      input.receiver = (await f.api(`agent/${f.activity.activityId}/capabilities`)).receiver;
      await f.api(`intents/${f.activity.activityId}`, input);
      const receipt = await f.api(`intents/${f.activity.activityId}/${input.requestId}/dispatch`, {});
      assert.equal(receipt.state, 'accepted');
      return JSON.parse(receipt.receipt.detail).runId;
    },
    async conversation() { return f.api(`agent/${f.activity.activityId}/conversation`); },
  };
}

export async function untilAlu(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error('ALU public boundary did not reach the expected state');
}

export async function aluChat(response, { text = '', call, delay = 0 }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = delta => response.write('data: ' + JSON.stringify({ id: 'alu-timing', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  if (call) send({ role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
  else {
    send({ role: 'assistant', content: text });
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  }
  response.write('data: ' + JSON.stringify({ id: 'alu-timing', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\n');
  response.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n');
  response.end('data: [DONE]\n\n');
}
