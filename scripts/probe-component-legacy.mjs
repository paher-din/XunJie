import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { annotationPackage } from '../components/material-annotation/package.mjs';

const legacy = process.env.XUNJIE_COMPONENT_LEGACY_PACKAGE;
if (!legacy || !process.env.XUNJIE_PRODUCT_POSTGRES_BIN) throw new Error('Set legacy product package and native PostgreSQL paths.');
const root = await mkdtemp(join(tmpdir(), 'xj-component-legacy-'));
const run = promisify(execFile), cli = join(resolve(legacy), 'app', 'cli.js');
const node = join(resolve(legacy), 'resources', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const command = async (...args) => JSON.parse((await run(node, [cli, ...args, '--root', root], { windowsHide: true, maxBuffer: 8000000 })).stdout);
const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6', webRoot: resolve('apps/web/dist-runtime'),
  windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') } });
const report = { status: 'running', root, cases: [], legacyPackage: resolve(legacy) };
try {
  await command('install', '--profile', 'local');
  const { endpoint } = await command('start');
  const authorization = `Bearer ${await resolveCredential(root, 'control')}`;
  const input = { requestId: randomUUID(), ...await annotationPackage() };
  input.manifest.componentId = input.manifest.componentId.toUpperCase();
  const response = await fetch(endpoint + '/api/learning/manage/component-import', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 200, 'the unchanged legacy product must accept the counterexample');
  const original = await response.json();
  const call = async (base, route, body, headers = { authorization }) => {
    const response = await fetch(base + '/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, route); return { value: await response.json(), headers: response.headers };
  };
  const courseId = randomUUID(), releaseId = randomUUID(), password = randomUUID(), loginName = 'legacy-component-member';
  const member = await call(endpoint, 'manage/members', { requestId: randomUUID(), loginName, password });
  await call(endpoint, 'manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '原大写组件课程' },
    task: { taskId: randomUUID(), title: '原固定活动', summary: '' }, release: { releaseId, objectives: ['保留原活动状态'], requirements: '保留旧活动', materials: [],
      starterWorks: [], capabilities: [], components: [{ key: 'annotation', definition: original, configuration: { title: '标注' }, materialIds: [] }] }, resources: [] });
  await call(endpoint, 'manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true });
  const login = await call(endpoint, 'login', { loginName, password }, {});
  const student = { cookie: login.headers.get('set-cookie').split(';')[0] };
  const activity = (await call(endpoint, 'course-activities', { requestId: randomUUID(), releaseId }, student)).value;
  const stateFile = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/annotation.json', kind: 'state', encoding: 'json',
    mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1, instanceId: activity.activityId + ':annotation',
      componentId: input.manifest.componentId, version: input.manifest.version, definitionDigest: original.digest, stateVersion: 1,
      operationId: randomUUID(), content: { annotations: [{ id: randomUUID(), quote: '旧依据', note: '旧活动必须保留' }] } }) };
  await call(endpoint, 'workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [stateFile] }, student);
  const query = async (endpoint, componentId) => {
    const result = await fetch(endpoint + '/api/learning/manage/component-read', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ componentId, version: input.manifest.version }) });
    return { status: result.status, value: await result.json() };
  };
  assert.equal((await query(endpoint, input.manifest.componentId.toLowerCase())).status, 503, 'old artifact reproduces R5');
  report.cases.push('unchanged legacy product accepts uppercase UUID and fails lowercase read');
  await command('stop');
  const started = await runtime.start();
  assert.ok(['ready', 'degraded'].includes(started.state));
  for (const identity of [input.manifest.componentId, input.manifest.componentId.toLowerCase()]) {
    const result = await query(started.endpoint, identity); assert.equal(result.status, 200); assert.deepEqual(result.value, original);
  }
  report.cases.push('fixed owner starts the original environment and preserves original manifest/digest for either query spelling');
  assert.deepEqual((await call(started.endpoint, 'activities/' + activity.activityId, undefined, student)).value, activity);
  assert.equal((await call(started.endpoint, 'workspaces/' + activity.activityId, undefined, student)).value.files[0].value, stateFile.value);
  report.cases.push('the original fixed activity, uppercase binding and saved student state remain readable byte-for-byte');
  await runtime.stop();
  await runtime.start(); await runtime.stop();
  report.cases.push('second normal stop/start passes resource retention and recovery validation without rewriting legacy bytes');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
finally {
  try { await runtime.stop(); report.cleanup = 'stopped'; } catch { try { await command('stop'); report.cleanup = 'legacy stopped'; } catch { report.cleanup = 'stop failed'; } }
  await mkdir('.verification/wp03-169', { recursive: true });
  await writeFile('.verification/wp03-169/legacy-remediation.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, cases: report.cases, cleanup: report.cleanup }));
}
