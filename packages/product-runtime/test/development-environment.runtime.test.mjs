import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { prepareProductDevelopment, assertProductDevelopmentServices } from '../dist/development.js';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
  webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
const modules = ['space-course', 'learning-data', 'teaching-agent', 'model-connection', 'tool-execution'];
const configuration = async root => JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'));
const credentialDigest = async root => createHash('sha256').update(await resolveCredential(root, 'control')).digest('hex');
async function api(endpoint, route, body, headers = {}) {
  const response = await fetch(endpoint + '/api/learning/' + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('a default local install creates every declared service and preserves an explicit custom deployment', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-development-default-'));
  const root = join(directory, 'default'), customRoot = join(directory, 'custom');
  const runtime = openProductRuntime({ root, resources }), custom = openProductRuntime({ root: customRoot, resources });
  try {
    await runtime.install({ profile: 'local' });
    assert.deepEqual(new Set((await configuration(root)).deployment.modules), new Set(modules));
    const started = await runtime.start();
    assert.equal(started.state, 'ready');
    assertProductDevelopmentServices(started);
    for (const unit of modules) assert(started.environment.services.some(service => service.unit === unit), unit);

    const deployment = { formatVersion: 1, modules: ['space-course', 'learning-data'], dependencies: {} };
    await custom.install({ profile: 'local', deployment });
    const before = await readFile(join(customRoot, 'installation.json'), 'utf8');
    assert.deepEqual(await prepareProductDevelopment(customRoot), { upgraded: false });
    await custom.install({ profile: 'local' });
    assert.equal(await readFile(join(customRoot, 'installation.json'), 'utf8'), before);
    const customStatus = await custom.start();
    assertProductDevelopmentServices(customStatus);
    assert(!customStatus.environment.services.some(service => service.unit === 'tool-execution'));
  } finally {
    await runtime.stop(); await custom.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('development promotes a stopped legacy environment and completes school pairing while retaining identity and work', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-development-legacy-'));
  const root = join(directory, 'device'), schoolRoot = join(directory, 'school');
  const runtime = openProductRuntime({ root, resources }), school = openProductRuntime({ root: schoolRoot, resources });
  try {
    await runtime.install({ profile: 'local' });
    // This is the metadata written by installations before explicit local deployments.
    const legacy = await configuration(root); delete legacy.deployment;
    await writeFile(join(root, 'installation.json'), JSON.stringify(legacy), { mode: 0o600 });
    const started = await runtime.start();
    assert.equal(started.state, 'ready');
    assert.throws(() => assertProductDevelopmentServices(started), /缺少实际服务：tool-execution/);
    const activity = await api(started.endpoint, 'activities', {
      requestId: randomUUID(), goal: '保留已有个人活动', question: '', references: [],
    }, { 'x-xj-space': 'personal' });
    assert.equal(activity.status, 200);
    const credential = await credentialDigest(root);
    const before = await readFile(join(root, 'installation.json'), 'utf8');
    await assert.rejects(prepareProductDevelopment(root), /Stop the environment/);
    assert.equal(await readFile(join(root, 'installation.json'), 'utf8'), before);

    await runtime.stop();
    assert.deepEqual(await prepareProductDevelopment(root), { upgraded: true });
    const upgraded = await configuration(root);
    assert.deepEqual(upgraded.resources, legacy.resources);
    assert.deepEqual(upgraded.connections, legacy.connections);
    assert.equal(await credentialDigest(root), credential);
    const bytes = await readFile(join(root, 'installation.json'), 'utf8');
    assert.deepEqual(await prepareProductDevelopment(root), { upgraded: false });
    assert.equal(await readFile(join(root, 'installation.json'), 'utf8'), bytes);
    const ready = await runtime.start();
    assertProductDevelopmentServices(ready);
    assert.equal(ready.environment.environmentId, started.environment.environmentId);
    assert.equal(ready.environment.installationId, started.environment.installationId);
    for (const original of started.environment.services) {
      assert.equal(ready.environment.services.find(service => service.unit === original.unit)?.serviceId, original.serviceId);
    }
    const retained = await api(ready.endpoint, 'activities/' + activity.value.activityId, undefined, { 'x-xj-space': 'personal' });
    assert.equal(retained.status, 200); assert.equal(retained.value.goal, activity.value.goal);

    await school.install({ profile: 'school', deployment: { formatVersion: 1, modules: ['space-course', 'learning-data'], dependencies: {} } });
    const schoolStatus = await school.start();
    const loginName = 'development-' + randomUUID(), password = randomUUID();
    assert.equal((await api(schoolStatus.endpoint, 'manage/members', { requestId: randomUUID(), loginName, password },
      { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') })).status, 200);
    const session = await api(schoolStatus.endpoint, 'login', { loginName, password });
    assert.equal(session.status, 200);
    const requestId = randomUUID();
    assert.equal((await api(ready.endpoint, 'client/start', { requestId, schoolEndpoint: schoolStatus.endpoint })).status, 200);
    assert.equal((await api(schoolStatus.endpoint, 'connections/approve', { requestId }, { cookie: session.cookie })).status, 200);
    assert.equal((await api(ready.endpoint, 'client/complete', { requestId })).status, 200);
    const connected = await api(ready.endpoint, 'context');
    assert(connected.value.identities.some(item => item.key === 'school:' + requestId));
  } finally {
    await runtime.stop(); await school.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
