import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { createNativeSessions, nativeSessionMigration } from '../../../packages/learning-space/dist/learning-data/native-sessions.js';
import { sessionRecoveryMigration } from '../../../packages/learning-space/dist/learning-data/session-checkpoints.js';
import { productNativeAdapters } from '../../../packages/learning-space/dist/learning-data/native-process.js';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { courseExecutionPlanBasis } from '@xunjie/contracts/execution';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to native PostgreSQL 18.6.');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]))
    : value;
const sha256Json = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** A real native session against real PostgreSQL: start, input, replay, query, stop and restart recovery. */
test('native sessions keep real child state, ordered inputs and a separate owner reference', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-native173-'));
  const windowsSessionHelper = process.env.XUNJIE_NATIVE_SESSION_HELPER;
  const windowsSessionHelperSha256 = windowsSessionHelper
    ? createHash('sha256').update(await readFile(windowsSessionHelper)).digest('hex') : undefined;
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', windowsSessionHelper, windowsSessionHelperSha256, webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  try {
    await runtime.install({ profile: 'local' });
    const started = await runtime.start(), endpoint = started.endpoint;
    const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
    const api = async (route, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const published = await accumulatorPackage({ version: 1 });
    const imported = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
    assert.equal(imported.status, 200, JSON.stringify(imported.value));
    const { manifest } = published, definition = imported.value;
    const session = manifest.session;
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const binding = { key: 'accumulator', definition, configuration: { title: '四态累加模拟' }, materialIds: [] };
    const course = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '有状态会话验收样例' },
      task: { taskId, title: '观察四态累加', summary: '' },
      release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['连续输入并观察真实内部状态'], requirements: '依次输入 1、2、2，观察 1、3、1。',
        starterWorks: [], capabilities: [], components: [binding], materials: [] }, resources: [] };
    assert.equal((await api('manage/course-import', course, admin)).status, 200);
    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'native-student', password }, admin);
    const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'native-student', password }) });
    assert.equal(login.status, 200);
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true }, admin);
    const created = await api('course-activities', { requestId: randomUUID(), releaseId }, headers);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    const activity = created.value;
    const instanceId = `${activity.activityId}:accumulator`;
    const limits = { timeMs: session.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: session.budgets.inputBytes,
      outputBytes: session.budgets.outputBytes, concurrentJobs: session.budgets.concurrentSessions,
      queuedJobs: session.budgets.queuedSessions };
    const actionOf = requestId => ({
      protocolVersion: 2, kind: 'execution', requestId,
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' },
      execution: {
        instance: { instanceId, key: 'accumulator', componentId: manifest.componentId,
          componentVersion: manifest.version, definitionDigest: definition.digest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: session.operation.operationId, effect: 'input' },
        parameters: {},
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
        limits,
        plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
          planDigest: sha256Json({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId,
            componentVersion: manifest.version, operationId: session.operation.operationId }) },
        session: { adapterId: session.adapterId, adapterVersion: session.adapterVersion,
          limits: { operationTimeoutMs: session.budgets.operationTimeoutMs, idleMs: session.budgets.idleMs,
            maxMs: session.budgets.maxMs, memoryMiB: session.budgets.memoryMiB,
            concurrentSessions: session.budgets.concurrentSessions, queuedSessions: session.budgets.queuedSessions } },
        initiator: { kind: 'student', principalId: activity.identity.principalId } } });

    const path = `executions/${activity.activityId}`;
    const requestId = randomUUID(), action = actionOf(requestId);
    const accepted = await api(path, { action }, headers);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
    assert.equal(accepted.value.state, 'running');
    assert.deepEqual(accepted.value.session.observation, { value: 0, total: 0, applied: 0 });
    assert.deepEqual([accepted.value.session.appliedSeq, accepted.value.session.instanceId], [0, instanceId]);
    // A retried acceptance is the same session, not a second process.
    assert.equal((await api(path, { action }, headers)).value.executionRef, accepted.value.executionRef);
    // Changed creation parameters under one identity are a conflict.
    const changed = actionOf(requestId); changed.execution.parameters = { other: true };
    assert.equal((await api(path, { action: changed }, headers)).status, 409);

    const control = (controlId, seq, value) => ({ controlId, operationId: 'advance', effect: 'input',
      expectedSeq: seq, parameters: { value } });
    const input = async (value, seq) => api(`${path}/${requestId}/control`, control(randomUUID(), seq, value), headers);
    const first = await input(1, 0);
    assert.equal(first.status, 200, JSON.stringify(first.value));
    assert.deepEqual(first.value.session.observation, { value: 1, total: 1, applied: 1 });
    // The same control identity returns its original observation and never advances twice.
    const repeated = await api(`${path}/${requestId}/control`, { controlId: first.value.session.lastControlId,
      operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 1 } }, headers);
    assert.deepEqual(repeated.value.session.observation, { value: 1, total: 1, applied: 1 });
    // An out-of-order expectation is refused before the process sees a new input.
    assert.equal((await input(2, 0)).status, 409);
    const second = await input(2, 1), third = await input(2, 2);
    assert.deepEqual(second.value.session.observation, { value: 3, total: 3, applied: 2 });
    assert.deepEqual(third.value.session.observation, { value: 1, total: 5, applied: 3 });
    assert.equal((await api(`${path}/${requestId}`, undefined, headers)).value.session.appliedSeq, 3);
    assert.equal((await api(`${path}/sessions`, undefined, headers)).value.length, 1);

    const stopId = randomUUID();
    const stopped = await api(`${path}/${requestId}/stop`, { stopId, reason: '用户请求停止。' }, headers);
    assert.equal(stopped.status, 200, JSON.stringify(stopped.value));
    assert.equal(stopped.value.stopRequested, true);
    assert.equal(stopped.value.state, 'cancelled');
    // A stopped session cannot accept a new input, even with a new identity.
    assert.equal((await input(1, 3)).status, 400);

    // A second session starts from its own zero and shares nothing with the first.
    const secondRequest = randomUUID(), secondSession = await api(path, { action: actionOf(secondRequest) }, headers);
    assert.equal(secondSession.value.session.observation.value, 0);
    const secondInput = await api(`${path}/${secondRequest}/control`, control(randomUUID(), 0, 2), headers);
    assert.deepEqual(secondInput.value.session.observation, { value: 2, total: 2, applied: 1 });
    assert.notEqual(secondSession.value.executionRef, accepted.value.executionRef);

    // A restarted product never pretends a pre-restart process is still advancing.
    const staleRequest = randomUUID();
    assert.equal((await api(path, { action: actionOf(staleRequest) }, headers)).value.state, 'running');
    await runtime.stop();
    const restarted = await runtime.start();
    assert.equal(restarted.endpoint, endpoint);
    const stale = await api(`${path}/${staleRequest}`, undefined, headers);
    assert.equal(stale.status, 200, JSON.stringify(stale.value));
    // A maintenance stop may confirm the exit; otherwise the new owner must say unknown. In no
    // case may the old process look like it is still advancing under a new owner.
    assert.ok(stale.value.statusKnowledge === 'unknown'
      || ['cancelled', 'failed'].includes(stale.value.state), JSON.stringify(stale.value));
    assert.equal((await api(`${path}/${staleRequest}/control`, control(randomUUID(), 0, 1), headers)).status, 403);
  } finally { await runtime.stop().catch(() => {}); await rm(root, { recursive: true, force: true }).catch(() => {}); }
});

// 直接覆盖执行所有者：真实数据库和进程不依赖 HTTP 宿主重建来触发代际变化。
test('owner fences changed generations, recovers once per generation and reclaims after revocation', { timeout: 120000 }, async () => {
  const fixture = await nativeFixture();
  let storage, owner, school;
  try {
    const migrations = [{ version: 1, name: 'activity-fixture', sql: 'CREATE TABLE activities(id uuid PRIMARY KEY, body jsonb NOT NULL);' },
      { ...nativeSessionMigration, version: 2 },
      { version: 3, name: 'fixed-native-action-text-fixture', sql: 'ALTER TABLE native_sessions ADD COLUMN action_text text;' },
      { ...sessionRecoveryMigration, version: 4 }];
    const binding = await provisionStorage({ admin: fixture.admin,
      owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations });
    storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: 'files', root: fixture.root + '/objects' }) });
    let generation = String(storage.generation), authorized = true, loseOnObservation = false;
    const facade = new Proxy(storage, { get(target, key) {
      if (key === 'generation') return generation;
      if (key === 'request') return async (request, effect) => {
        if (loseOnObservation && request.requestId.startsWith('native-observe:')) {
          loseOnObservation = false; generation = randomUUID();
        }
        return target.request(request, effect);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const { manifest: original } = await accumulatorPackage({ version: 1 });
    const manifest = structuredClone(original), declared = manifest.session;
    const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
    const activityId = randomUUID();
    const activity = { activityId, identity, status: 'open', course: { components: [{ key: 'accumulator',
      definition: { digest: 'a'.repeat(64), manifest }, configuration: {}, materialIds: [] }] } };
    await storage.request({ requestId: 'activity', fingerprint: activityId }, async tx => {
      await tx.query('INSERT INTO activities VALUES($1,$2)', [activityId, JSON.stringify(activity)]); return true;
    });
    owner = createNativeSessions(facade, { activity: async () => {
      if (!authorized) throw new StorageError('forbidden');
      return activity;
    }, works: {}, nodePath: process.execPath, sessionRoot: fixture.root + '/sessions',
      ...(process.env.XUNJIE_NATIVE_SESSION_HELPER ? { windowsHelper: process.env.XUNJIE_NATIVE_SESSION_HELPER } : {}) });
    const actionOf = () => ({ protocolVersion: 2, kind: 'execution', requestId: randomUUID(),
      scope: { ...identity, activityId }, receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' },
      execution: { instance: { instanceId: `${activityId}:accumulator`, key: 'accumulator', componentId: manifest.componentId,
        componentVersion: manifest.version, definitionDigest: 'a'.repeat(64), hostApiVersion: 1, stateVersion: 1 },
      operation: { operationId: 'advance', effect: 'input' }, parameters: {},
      basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
      limits: { timeMs: declared.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: declared.budgets.inputBytes,
        outputBytes: declared.budgets.outputBytes, concurrentJobs: declared.budgets.concurrentSessions, queuedJobs: declared.budgets.queuedSessions },
      plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
        planDigest: sha256Json({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId,
          componentVersion: manifest.version, operationId: 'advance' }) },
      session: { adapterId: declared.adapterId, adapterVersion: declared.adapterVersion,
        limits: Object.fromEntries(['operationTimeoutMs', 'idleMs', 'maxMs', 'memoryMiB', 'concurrentSessions', 'queuedSessions']
          .map(key => [key, declared.budgets[key]])) }, initiator: { kind: 'student', principalId: identity.principalId } } });
    const action = actionOf();
    const started = await owner.accept(identity, activityId, { action });
    assert.equal(started.state, 'running');
    const input = { controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 1 } };
    const applied = await owner.control(identity, activityId, action.requestId, input);
    assert.equal(applied.session.appliedSeq, 1);
    generation = randomUUID();
    const recovered = await owner.read(identity, activityId, action.requestId);
    assert.equal(recovered.statusKnowledge, 'unknown');
    assert.equal(recovered.session.appliedSeq, 1);
    await assert.rejects(owner.control(identity, activityId, action.requestId,
      { ...input, controlId: randomUUID(), expectedSeq: 1 }), { code: 'forbidden' });
    await assert.rejects(owner.control(identity, activityId, action.requestId, input), { code: 'forbidden' });
    // 撤权后学生不能读取或推进；执行所有者仍能按原实例回收真实进程。
    authorized = false;
    await assert.rejects(owner.read(identity, activityId, action.requestId), { code: 'forbidden' });
    const reclaimed = await owner.reclaim(started.executionRef);
    assert.equal(reclaimed.state, 'cancelled');
    assert.equal(reclaimed.statusKnowledge, 'confirmed');
    assert.equal(reclaimed.stopRequested, true);
    assert.equal(reclaimed.session.appliedSeq, 1);
    authorized = true;
    const freshAction = actionOf();
    const fresh = await owner.accept(identity, activityId, { action: freshAction });
    assert.equal(fresh.state, 'running');
    assert.equal(fresh.session.installGeneration, generation);
    assert.equal((await owner.control(identity, activityId, freshAction.requestId, { ...input, controlId: randomUUID() })).session.appliedSeq, 1);
    // 原进程已经应用输入，但确认落库前代际失权：迟到结果只归档，不恢复运行权。
    loseOnObservation = true;
    const late = await owner.control(identity, activityId, freshAction.requestId,
      { ...input, controlId: randomUUID(), expectedSeq: 1 });
    assert.equal(late.statusKnowledge, 'unknown');
    assert.equal(late.session.appliedSeq, 1);
    assert.equal(late.session.observation.applied, 1);
    await assert.rejects(owner.control(identity, activityId, freshAction.requestId,
      { ...input, controlId: randomUUID(), expectedSeq: 1 }), { code: 'forbidden' });
    await owner.validate();
    await owner.reclaim(fresh.executionRef);
    const fourState = productNativeAdapters.find(adapter => adapter.adapterId === 'four-state-accumulator');
    assert.ok(fourState);
    const linuxOnly = { ...fourState, adapterId: 'fixture-linux', platforms: ['linux-x64'] };
    const placement = { nodeClass: 'school-execution-node', secureTransport: true };
    school = createNativeSessions(facade, { activity: async () => activity, works: {}, adapters: [fourState, linuxOnly],
      nodeId: 'school-' + randomUUID(), placement, nodePath: process.execPath, sessionRoot: fixture.root + '/school-sessions',
      ...(process.env.XUNJIE_NATIVE_SESSION_HELPER ? { windowsHelper: process.env.XUNJIE_NATIVE_SESSION_HELPER } : {}) });
    const deviceOf = (platform = 'macos-arm64', native = { supported: false, installed: false, authorized: false, prepared: 'none' }) => ({
      platform, browser: { worker: true, webassembly: true, sandboxedFrame: true }, native,
    });
    const remoteActionOf = device => {
      const action = actionOf(); action.receiver.location = 'remote';
      if (device !== undefined) action.execution.device = device;
      return action;
    };
    const refuse = device => assert.rejects(school.accept(identity, activityId, { action: remoteActionOf(device) }), { code: 'forbidden' });
    // 旧发布不获得远端资格；报告 unsupported 也不能推翻产品注册表的平台支持事实。
    await refuse(deviceOf());
    const plan = { planId: 'remote-accumulator', planVersion: 1, planDigest: '0'.repeat(64),
      components: [{ key: 'accumulator', definitionDigest: 'a'.repeat(64), configurationDigest: sha256Json({}), operations: ['advance'] }],
      capabilities: ['native-session'], resources: { browser: null, native: { memoryMiB: 32, operationTimeoutMs: 4000, maxMs: 600000 } },
      locations: ['native'], remote: { nodeClass: 'school-execution-node', secureTransport: true,
        adapter: { adapterId: declared.adapterId, adapterVersion: declared.adapterVersion }, clientPlatforms: ['macos-arm64', 'windows-x64', 'linux-x64'] } };
    const updatePlan = () => { plan.planDigest = sha256Json(courseExecutionPlanBasis(plan)); activity.course.executionPlan = plan; };
    updatePlan();
    for (const platform of ['macos-arm64', 'windows-x64']) await refuse(deviceOf(platform));
    declared.adapterId = linuxOnly.adapterId;
    plan.remote.adapter.adapterId = linuxOnly.adapterId; updatePlan();
    await refuse(undefined);
    await refuse(deviceOf(null));
    await refuse(deviceOf('macos-arm64', null));
    for (const native of [
      { supported: true, installed: false, authorized: false, prepared: 'none' },
      { supported: true, installed: true, authorized: false, prepared: 'ready' },
      { supported: true, installed: true, authorized: true, prepared: 'failed' },
      { supported: true, installed: true, authorized: true, prepared: 'preparing' },
      { supported: true, installed: true, authorized: true, prepared: 'ready' },
    ]) await refuse(deviceOf('macos-arm64', native));
    await refuse(deviceOf('linux-x64'));
    plan.remote.clientPlatforms = ['macos-arm64']; updatePlan();
    await refuse(deviceOf('windows-x64'));
    plan.remote.clientPlatforms = ['macos-arm64', 'windows-x64', 'linux-x64']; updatePlan();
    plan.remote.adapter.adapterVersion += 1; updatePlan();
    await refuse(deviceOf());
    plan.remote.adapter.adapterVersion = declared.adapterVersion; updatePlan();
    placement.secureTransport = false;
    await refuse(deviceOf());
    placement.secureTransport = true;
    activity.course.components[0].configuration = { changed: true };
    await assert.rejects(school.accept(identity, activityId, { action: remoteActionOf(deviceOf()) }), { code: 'corrupt' });
    activity.course.components[0].configuration = {};
    assert.equal((await storage.read('SELECT count(*)::int AS count FROM native_sessions')).rows[0].count, 2);
    for (const platform of ['macos-arm64', 'windows-x64']) {
      const remoteAction = remoteActionOf(deviceOf(platform));
      const remote = await school.accept(identity, activityId, { action: remoteAction });
      assert.equal(remote.session.adapterId, linuxOnly.adapterId);
      const { rows: [saved] } = await storage.read('SELECT action FROM native_sessions WHERE request_id=$1', [remoteAction.requestId]);
      assert.equal(saved.action.execution.device.platform, platform);
      // 非 Linux 宿主可验证调度放行和落库，但不能冒充运行过 Linux 专属进程。
      if (process.platform !== 'linux' || process.arch !== 'x64') {
        assert.equal(remote.state, 'failed');
        assert.equal(remote.reason.code, 'resource-unavailable');
      }
      if (remote.state === 'running') await school.reclaim(remote.executionRef);
    }
    await school.validate();
  } finally { await school?.shutdown(); await owner?.shutdown(); await storage?.close(); await fixture.close(); }
});
