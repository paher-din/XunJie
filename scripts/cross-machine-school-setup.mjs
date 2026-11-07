import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname, release, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
for (const required of ['product', 'root', 'config', 'out']) assert.ok(args[required], `missing --${required}`);
const product = resolve(args.product), root = resolve(args.root), output = resolve(args.out);
const config = JSON.parse(await readFile(resolve(args.config), 'utf8'));
const endpoint = config.endpoint;
const { resolveCredential } = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const token = await resolveCredential(root, 'control');
const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
const distribution = JSON.parse(await readFile(join(product, 'distribution.json'), 'utf8'));

async function request(route, body, headers = { 'x-xj-space': 'school' }) {
  const response = await fetch(new URL('/api/learning/' + route, endpoint), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, 200, route + ': ' + JSON.stringify(value));
  return { value, headers: response.headers };
}
const admin = { authorization: `Bearer ${token}`, 'x-xj-space': 'school' };
const api = async (route, body, headers) => (await request(route, body, headers)).value;

const member = await api('manage/members', { requestId: randomUUID(), loginName: config.loginName, password: config.password }, admin);
const connectionId = randomUUID();
const model = await api('manage/model-default', {
  requestId: randomUUID(), expectedVersion: 0, connectionId, name: '跨机输入控制验收',
  protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${config.modelPort}/v1`, path: '/chat/completions',
  modelId: 'fixture-cross-machine', dialect: 'standard', parameterMode: 'plain', enabled: true,
  contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-cross-machine-key' },
  policy: { checksAllowed: false, maxChecksPerHour: 1, maxOutputTokens: 2048, timeoutMs: 30000 },
}, admin);
const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
  course: { courseId, name: 'WP07 跨机输入控制验收' }, task: { taskId, title: '核对跨机补充、停止与继续', summary: '' },
  release: { releaseId, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
    objectives: ['核对真实跨机输入控制'], requirements: '保留原输入事实，按明确选择继续。', starterWorks: [], capabilities: [],
    components: [], materials: [] }, resources: [] }, admin);
await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);
const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST', redirect: 'error',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ loginName: config.loginName, password: config.password }) });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie, 'member login must return a session cookie');
const memberHeaders = { cookie, 'x-xj-space': 'school' };
const activity = await api('course-activities', { requestId: randomUUID(), releaseId }, memberHeaders);
const services = environment.services.map(service => ({ unit: service.unit, serviceId: service.serviceId }));
const report = {
  measuredAt: new Date().toISOString(),
  schoolHost: { hostname: hostname(), platform: platform(), arch: arch(), os: release() },
  endpoint, identity: { environmentId: environment.environmentId, installationId: environment.installationId,
    profile: environment.profile, principalId: member.principalId, spaceId: activity.identity.spaceId },
  services, member: { loginName: config.loginName, principalId: member.principalId, spaceId: activity.identity.spaceId },
  model: { connectionId, version: model.connection.version },
  course: { courseId, releaseId, activityId: activity.activityId },
  package: { distributionSha256: createHash('sha256').update(await readFile(join(product, 'distribution.json'))).digest('hex'),
    createdAt: distribution.createdAt, platform: distribution.platform },
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
