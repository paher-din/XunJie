import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { executionActionSchema } from '@xunjie/contracts/execution';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to native PostgreSQL 18.6.');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]))
    : value;
const sha256Json = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** A real browser command against real PostgreSQL: accept, query, report, stop and result. */
test('the execution owner keeps the original acceptance, the durable stop and one result per run', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-execution170-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  let preserveRoot = false;
  try {
    await runtime.install({ profile: 'local' });
    const started = await runtime.start();
    let endpoint = started.endpoint;
    const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
    const api = async (route, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const published = await aggregationPackage();
    const imported = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
    assert.equal(imported.status, 200, JSON.stringify(imported.value));
    const { manifest } = published, definition = imported.value;
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const binding = { key: 'table', definition, configuration: { title: '表格聚合' }, materialIds: [] };
    const course = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '聚合验收样例' },
      task: { taskId, title: '按小组统计得分', summary: '' },
      release: { releaseId, objectives: ['用受限算法算出一组统计'], requirements: '编辑表格并运行计算。', starterWorks: [],
        capabilities: [], components: [binding], materials: [] }, resources: [] };
    assert.equal((await api('manage/course-import', course, admin)).status, 200);
    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'aggregate-student', password }, admin);
    const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'aggregate-student', password }) });
    assert.equal(login.status, 200);
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true }, admin);
    const created = await api('course-activities', { requestId: randomUUID(), releaseId }, headers);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    const activity = created.value;
    // The published algorithm is served only through the authorised release, with its own bytes.
    const algorithmRoute = await api(`releases/${releaseId}/components/table/algorithm`, undefined, headers);
    assert.equal(algorithmRoute.status, 200, JSON.stringify(algorithmRoute.value));
    assert.equal(algorithmRoute.value.contentBase64, published.algorithmBase64);
    assert.equal(algorithmRoute.value.memoryPages, 256);

    const content = { table: manifest.initialState.table, parameters: manifest.initialState.parameters };
    const state = { formatVersion: 1, instanceId: `${activity.activityId}:table`, componentId: manifest.componentId, version: manifest.version,
      definitionDigest: definition.digest, stateVersion: 1, operationId: randomUUID(),
      content: { table: content.table, parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } };
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify(state) };
    assert.equal((await api('workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] }, headers)).status, 200);

    const actionOf = (requestId, parameters) => ({
      protocolVersion: 2, kind: 'execution', requestId,
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' },
      execution: {
        instance: { instanceId: `${activity.activityId}:table`, key: 'table', componentId: manifest.componentId,
          componentVersion: manifest.version, definitionDigest: definition.digest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: 'aggregate', effect: 'execute' },
        parameters,
        basis: { works: [file], state: { name: file.name, contentId: file.contentId, sha256: sha256Json(state) },
          expected: { stateContentId: file.contentId },
          resources: [{ kind: 'entry', resourceId: manifest.entry.resourceId, sha256: manifest.entry.sha256,
            byteLength: manifest.entry.byteLength, mediaType: 'text/html' },
          { kind: 'algorithm', resourceId: manifest.algorithm.resource.resourceId, sha256: manifest.algorithm.resource.sha256,
            byteLength: manifest.algorithm.resource.byteLength, mediaType: 'application/wasm' }] },
        limits: { timeMs: 5000, memoryPages: 256, inputBytes: 1048576, outputBytes: 65536, concurrentJobs: 1, queuedJobs: 4 },
        plan: { planId: 'browser-job', planVersion: 1, location: 'browser', kind: 'job',
          planDigest: sha256Json({ planId: 'browser-job', planVersion: 1, componentId: manifest.componentId,
            componentVersion: manifest.version, operationId: 'aggregate' }) },
        initiator: { kind: 'student', principalId: activity.identity.principalId } } });
    const requestId = randomUUID(), executionRef = randomUUID();
    const action = actionOf(requestId, { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' });
    // Both sides digest the schema-parsed command, so the fixed input identity is byte-stable.
    const acceptFor = (value, ref = executionRef, seq = 1) => ({ receipt: {
      requestId: value.requestId, inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(value))).digest('hex'),
      receiver: value.receiver, state: 'accepted', receiptId: 'browser:' + value.requestId, detail: '已在本机可靠保存命令与待处理事实。' },
      execution: { executionRef: ref, acceptedSeq: seq } });
    const acceptance = acceptFor(action);
    const path = `executions/${activity.activityId}`;
    const accepted = await api(path, { action, acceptance }, headers);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
    assert.deepEqual([accepted.value.state, accepted.value.executionRef, accepted.value.confirmedSeq], ['queued', executionRef, 1]);
    // A repeated acceptance is the same command; changed input under one identity is refused.
    assert.deepEqual((await api(path, { action, acceptance }, headers)).value, accepted.value);
    const changedAction = actionOf(requestId, { groupColumn: '小组', valueColumn: '得分', aggregate: 'sum' });
    assert.equal((await api(path, { action: changedAction, acceptance: acceptFor(changedAction) }, headers)).status, 409);
    assert.equal((await api(path, { action, acceptance: { ...acceptance, receipt: { ...acceptance.receipt, inputDigest: 'a'.repeat(64) } } },
      headers)).status, 400);
    assert.equal((await api(`${path}/${randomUUID()}`, undefined, headers)).value, null);
    assert.deepEqual((await api(`${path}/${requestId}`, undefined, headers)).value, accepted.value);
    // A state reference the command does not actually carry cannot be verified, so it is refused.
    const uncited = actionOf(randomUUID(), action.execution.parameters);
    uncited.execution.basis.works = [];
    assert.equal((await api(path, { action: uncited, acceptance: acceptFor(uncited) }, headers)).status, 400);

    const running = { ...accepted.value, state: 'running', confirmedSeq: 2 };
    assert.deepEqual((await api(`${path}/${requestId}/report`, running, headers)).value, running);
    assert.equal((await api(`${path}/${requestId}/report`, { ...running, confirmedSeq: 1 }, headers)).value.state, 'running');
    // A real artifact is stored once under the run's identity; a lost reply re-reads the same result.
    const text = '小组,计数,求和,平均,最小,最大\nA,4,332,83,73,92\nB,4,334,83.5,75,90\nC,4,334,83.5,67,95\n';
    const bytes = Buffer.from(text, 'utf8');
    const resultBody = { contentId: randomUUID(), output: { rows: 12, groups: [], value: 83.33333333333333 },
      text, name: '聚合结果-mean.csv', mediaType: 'text/csv;charset=utf-8',
      sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
    const stored = await api(`${path}/${requestId}/result`, resultBody, headers);
    assert.equal(stored.status, 200, JSON.stringify(stored.value));
    assert.equal(stored.value.output.artifact.sha256, resultBody.sha256);
    assert.deepEqual((await api(`${path}/${requestId}/result`, resultBody, headers)).value, stored.value);
    assert.equal((await api(`${path}/${requestId}/result`, { ...resultBody, contentId: randomUUID() }, headers)).status, 409);
    assert.equal((await api(`${path}/${requestId}/result`, { ...resultBody, sha256: 'b'.repeat(64) }, headers)).status, 400);

    const stopId = randomUUID();
    const stopped = await api(`${path}/${requestId}/stop`, { stopId, reason: '用户请求停止。' }, headers);
    assert.equal(stopped.value.stopRequested, true);
    assert.equal((await api(`${path}/${requestId}/stop`, { stopId, reason: '用户请求停止。' }, headers)).value.stopRequested, true);
    const cancelled = { ...stopped.value, state: 'cancelled', confirmedSeq: 4,
      reason: { code: 'worker-terminated', detail: '用户请求停止。' } };
    assert.deepEqual((await api(`${path}/${requestId}/report`, cancelled, headers)).value, cancelled);
    // A confirmed terminal fact is never overwritten by a late or contradictory reply.
    assert.deepEqual((await api(`${path}/${requestId}/report`, { ...cancelled, state: 'succeeded', confirmedSeq: 9 }, headers)).value, cancelled);

    // Stopping an already completed job records an audit without invalidating recovery validation.
    const completedAction = actionOf(randomUUID(), action.execution.parameters);
    const completed = (await api(path, { action: completedAction, acceptance: acceptFor(completedAction, randomUUID()) }, headers)).value;
    const succeeded = { ...completed, state: 'succeeded', confirmedSeq: 2 };
    assert.equal((await api(`${path}/${completedAction.requestId}/report`, succeeded, headers)).value.state, 'succeeded');
    const terminalStop = await api(`${path}/${completedAction.requestId}/stop`, { stopId: randomUUID(), reason: '完成后核对停止。' }, headers);
    assert.equal(terminalStop.value.state, 'succeeded');
    assert.equal(terminalStop.value.stopRequested, false);
    await runtime.stop();
    const restarted = await runtime.start().catch(async error => {
      preserveRoot = true;
      throw new Error(`${root}\n${await readFile(join(root, 'logs', 'runtime.log'), 'utf8')}`, { cause: error });
    });
    assert.equal(restarted.state, 'ready');
    endpoint = restarted.endpoint;
    assert.deepEqual((await api(`${path}/${requestId}`, undefined, headers)).value, cancelled);
    assert.deepEqual((await api(`${path}/${completedAction.requestId}`, undefined, headers)).value, terminalStop.value);

    // A run names its own activity: an unknown activity or no session never becomes a command.
    const elsewhere = randomUUID();
    const elsewhereAction = actionOf(elsewhere, action.execution.parameters);
    assert.equal((await api(`executions/${elsewhere}`, { action: elsewhereAction, acceptance: acceptFor(elsewhereAction) }, headers)).status, 404);
    assert.equal((await api(path, { action, acceptance: { ...acceptance, receipt: { ...acceptance.receipt, state: 'rejected' } } })).status, 403);
  } finally { await runtime.stop().catch(() => {}); if (!preserveRoot) await rm(root, { recursive: true, force: true }); }
});
