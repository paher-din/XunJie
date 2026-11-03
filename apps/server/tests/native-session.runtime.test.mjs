import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';

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
    const published = await accumulatorPackage();
    const imported = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
    assert.equal(imported.status, 200, JSON.stringify(imported.value));
    const { manifest } = published, definition = imported.value;
    const session = manifest.session;
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const binding = { key: 'accumulator', definition, configuration: { title: '四态累加模拟' }, materialIds: [] };
    const course = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '有状态会话验收样例' },
      task: { taskId, title: '观察四态累加', summary: '' },
      release: { releaseId, objectives: ['连续输入并观察真实内部状态'], requirements: '依次输入 1、2、2，观察 1、3、1。',
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
    assert.equal((await api(`${path}/${staleRequest}/control`, control(randomUUID(), 0, 1), headers)).status, 400);
  } finally { await runtime.stop().catch(() => {}); await rm(root, { recursive: true, force: true }).catch(() => {}); }
});
