import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { createFileBackend, openStorage } from '@xunjie/storage';
import { createSpaces, createMemberAgentBindings, createActivityAgentRoutes, spaceCourseMigrations, learningMigrations, createLearningData } from '@xunjie/learning-space';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

async function schoolFixture(t, modules = ['space-course', 'learning-data']) {
  const root = await mkdtemp(join(tmpdir(), 'xj-school-profile-'));
  const runtime = openProductRuntime({ root, resources });
  t.after(async () => { await runtime.stop().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await runtime.install({ profile: 'school', deployment: { formatVersion: 1, modules, dependencies: {} } });
  const state = await runtime.start();
  const api = async (route, body, headers = {}, status = 200) => {
    const response = await fetch(state.endpoint + '/api/learning/' + route, {
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, status, route + ': ' + JSON.stringify(value));
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const admin = { authorization: 'Bearer ' + await resolveCredential(root, 'control') };
  const loginName = 'profile-' + randomUUID(), password = randomUUID();
  const identity = (await api('manage/members', { requestId: randomUUID(), loginName, password }, admin)).value;
  const login = await api('login', { loginName, password }), member = { cookie: login.cookie, 'x-xj-space': 'school' };
  const requestId = randomUUID(), verifier = randomBytes(48).toString('base64url');
  await api('connections/start', { requestId, clientId: randomUUID(), challenge: createHash('sha256').update(verifier).digest('base64url') });
  await api('connections/approve', { requestId }, member);
  const grant = (await api('connections/exchange', { requestId, verifier })).value;
  return { root, runtime, state, api, admin, identity, member, grant, verifier,
    bearer: { authorization: 'Bearer ' + grant.token } };
}

test('two-module schools advertise and refresh a versioned local study decision without returning credentials', { timeout: 120000 }, async t => {
  const f = await schoolFixture(t);
  assert.equal(f.grant.profile?.version, 1);
  assert.equal(f.grant.profile.localStudy, true);
  assert.deepEqual(f.grant.localStudy, { version: 1 });
  const profile = (await f.api('connections/profile', undefined, f.bearer)).value;
  assert.deepEqual(profile, f.grant.profile);
  assert.equal(profile.connectionId, f.grant.connectionId);
  assert.deepEqual(profile.identity, f.grant.identity);
  assert.deepEqual(profile.target, f.grant.target);
  assert.equal(profile.account.accountName.startsWith('profile-'), true);
  assert.equal(JSON.stringify(profile).includes(f.grant.token), false);
  assert.equal(Object.hasOwn(profile, 'token'), false);
  await f.api('connections/profile', undefined, {}, 403);
  await f.api('connections/profile', undefined, f.member, 403);
});

async function openOwner(t, f, unit, migrations) {
  const service = f.state.environment.services.find(item => item.unit === unit);
  const binding = JSON.parse(await resolveCredential(f.root, 'storage-' + service.serviceId));
  const storage = await openStorage({ binding, migrations,
    backend: createFileBackend({ id: unit, root: join(f.root, 'learning-resources', unit) }) });
  t.after(() => storage.close());
  return storage;
}

test('explicit school Agent and model deployments never advertise local study or allow a forged transfer', { timeout: 120000 }, async t => {
  for (const modules of [
    ['space-course', 'learning-data', 'teaching-agent', 'model-connection'],
    ['space-course', 'learning-data', 'model-connection'],
  ]) await t.test(modules.join('+'), async t => {
    const f = await schoolFixture(t, modules);
    assert.equal(f.grant.profile.localStudy, false);
    assert.equal(Object.hasOwn(f.grant, 'localStudy'), false);
    assert.equal((await f.api('connections/profile', undefined, f.bearer)).value.localStudy, false);
    const activity = (await f.api('activities', { requestId: randomUUID(), goal: 'School process stays writable', question: '', references: [] }, f.member)).value;
    await f.api('study-transfer', undefined, f.bearer, 403);
    // Reject before freeze: the same school activity can still be changed afterwards.
    await f.api('activity-status', { requestId: randomUUID(), activityId: activity.activityId, status: 'closed' }, f.member);
  });
});

test('client delivery stays eligible but explicit member and pinned independent Agent owners prevent transfer', { timeout: 120000 }, async t => {
  const f = await schoolFixture(t);
  const space = await openOwner(t, f, 'space-course', spaceCourseMigrations);
  const spaces = createSpaces(space, { credentialNamespace: f.state.environment.installationId });
  const bindings = createMemberAgentBindings(space, spaces.authorize);
  const target = { ...f.state.environment.services.find(item => item.unit === 'learning-data'),
    unit: 'teaching-agent', environmentId: randomUUID(), serviceId: randomUUID(), capabilities: ['agent.sessions.v2'] };
  const original = { connectionId: f.grant.connectionId, installationId: randomUUID(), target, delivery: 'client' };
  await bindings.bind({ ...original, requestId: randomUUID(), identity: f.identity });
  assert.equal((await f.api('connections/profile', undefined, f.bearer)).value.localStudy, true);
  const activity = (await f.api('activities', { requestId: randomUUID(), goal: 'Pinned independent owner', question: '', references: [] }, f.member)).value;
  const data = await openOwner(t, f, 'learning-data', learningMigrations);
  const learning = createLearningData(data, spaces);
  const routes = createActivityAgentRoutes(data, learning.open);
  await routes.resolve(f.identity, activity.activityId, async () => ({ version: 1, ...original }));
  assert.equal((await f.api('connections/profile', undefined, f.bearer)).value.localStudy, true);
  await bindings.bind({ ...original, delivery: 'service', requestId: randomUUID(), identity: f.identity });
  assert.equal((await f.api('connections/profile', undefined, f.bearer)).value.localStudy, false);
  const renewed = (await f.api('connections/exchange', { requestId: f.grant.connectionId, verifier: f.verifier })).value;
  assert.equal(renewed.profile.localStudy, false);
  assert.equal(Object.hasOwn(renewed, 'localStudy'), false);
  assert.equal(Object.hasOwn(renewed, 'deviceSetup'), false, 'an explicit independent owner must not trigger automatic client setup');
  await f.api('study-transfer', undefined, f.bearer, 403);
  await bindings.bind({ ...original, requestId: randomUUID(), identity: f.identity });
  // A prior activity remains pinned to its independent service even after the member returns to client delivery.
  const independentActivity = (await f.api('activities', { requestId: randomUUID(), goal: 'Independent original', question: '', references: [] }, f.member)).value;
  await routes.resolve(f.identity, independentActivity.activityId, async () => ({ version: 1, ...original, delivery: 'service' }));
  assert.equal((await f.api('connections/profile', undefined, f.bearer)).value.localStudy, false);
  await f.api('study-transfer', undefined, f.bearer, 403);
  await f.api('activity-status', { requestId: randomUUID(), activityId: independentActivity.activityId, status: 'closed' }, f.member);
});

test('retained disabled modules do not masquerade as enabled school capabilities', { timeout: 120000 }, async t => {
  const f = await schoolFixture(t, ['space-course', 'learning-data', 'teaching-agent', 'model-connection']);
  assert.equal(f.grant.profile.localStudy, false);
  await f.runtime.stop();
  await f.runtime.configureDeployment({ formatVersion: 1, modules: ['space-course', 'learning-data'], dependencies: {} });
  const next = await f.runtime.start();
  assert.equal(next.environment.services.some(service => service.unit === 'teaching-agent'), true);
  const response = await fetch(next.endpoint + '/api/learning/connections/profile', { headers: f.bearer });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).localStudy, true);
});
