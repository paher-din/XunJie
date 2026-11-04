import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { courseExecutionPlanBasis } from '@xunjie/contracts/execution';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import { legacyAnnotationPackage, preparedAnnotationPackage } from '../../../components/material-annotation/package.mjs';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to native PostgreSQL 18.6.');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]))
    : value;
const sha256Json = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/**
 * A published course plan is part of the immutable release: new releases never rewrite an activity
 * that was already opened, and a plan that disagrees with its bound component is refused at import.
 */
test('a course execution plan is published with the release, bound to the activity and never rewritten', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-plan175-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
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
    const published = await aggregationPackage();
    const imported = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
    assert.equal(imported.status, 200, JSON.stringify(imported.value));
    const { manifest } = published, definition = imported.value;
    const binding = { key: 'table', definition, configuration: { title: '表格聚合' }, materialIds: [] };
    const planOf = (overrides = {}) => {
      const content = { planId: 'table-statistics', planVersion: 1,
        components: [{ key: 'table', definitionDigest: definition.digest, configurationDigest: sha256Json(binding.configuration),
          operations: ['aggregate'] }],
        capabilities: ['execution.submit'], resources: { browser: { features: ['worker', 'webassembly'] }, native: null },
        locations: ['browser'], remote: null, ...overrides };
      return { ...content, planDigest: sha256Json(courseExecutionPlanBasis({ ...content, planDigest: '0'.repeat(64) })) };
    };
    const courseOf = (releaseId, plan) => ({ formatVersion: 1, requestId: randomUUID(),
      course: { courseId, name: '聚合验收样例' }, task: { taskId, title: '按小组统计得分', summary: '' },
      release: { releaseId, objectives: ['用受限算法算出一组统计'], requirements: '编辑表格并运行计算。', starterWorks: [],
        capabilities: [], components: [binding], materials: [], ...(plan ? { executionPlan: plan } : {}) }, resources: [] });
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const publishedPlan = planOf();
    const publish = await api('manage/course-import', courseOf(releaseId, publishedPlan), admin);
    assert.equal(publish.status, 200, JSON.stringify(publish.value));
    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'plan-student', password }, admin);
    const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'plan-student', password }) });
    assert.equal(login.status, 200);
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true }, admin);

    // The release carries the plan the teacher reviewed.
    const release = await api(`releases/${releaseId}`, undefined, headers);
    assert.equal(release.status, 200, JSON.stringify(release.value));
    assert.deepEqual(release.value.executionPlan, publishedPlan);
    const created = await api('course-activities', { requestId: randomUUID(), releaseId }, headers);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    const activity = created.value;
    assert.deepEqual(activity.course.executionPlan, publishedPlan);
    assert.equal(activity.course.contentDigest, release.value.contentDigest);

    // A later release on the same task states a different plan; the opened activity keeps its own.
    const changedPlan = planOf({ planVersion: 2, resources: { browser: { features: ['worker'] }, native: null } });
    const nextRelease = await api('manage/course-import', courseOf(randomUUID(), changedPlan), admin);
    assert.equal(nextRelease.status, 200, JSON.stringify(nextRelease.value));
    const afterPublish = await api(`activities/${activity.activityId}`, undefined, headers);
    assert.deepEqual(afterPublish.value.course.executionPlan, publishedPlan);
    assert.equal(afterPublish.value.course.releaseId, releaseId);
    assert.deepEqual((await api(`releases/${releaseId}`, undefined, headers)).value.executionPlan, publishedPlan);

    // An old-format release keeps its exact wire: no defaulted plan appears on it.
    const legacyRelease = randomUUID();
    assert.equal((await api('manage/course-import', courseOf(legacyRelease, undefined), admin)).status, 200);
    const legacy = await api(`releases/${legacyRelease}`, undefined, headers);
    assert.equal(legacy.status, 200);
    assert.equal('executionPlan' in legacy.value, false);

    // The published plan describes the component it was reviewed with; every disagreement is refused.
    const refused = [
      planOf({ components: [{ key: 'table', definitionDigest: 'a'.repeat(64),
        configurationDigest: sha256Json(binding.configuration), operations: ['aggregate'] }] }),
      planOf({ components: [{ key: 'table', definitionDigest: definition.digest,
        configurationDigest: 'b'.repeat(64), operations: ['aggregate'] }] }),
      planOf({ components: [{ key: 'table', definitionDigest: definition.digest,
        configurationDigest: sha256Json(binding.configuration), operations: ['unknown-operation'] }] }),
      planOf({ components: [{ key: 'other', definitionDigest: definition.digest,
        configurationDigest: sha256Json(binding.configuration), operations: ['aggregate'] }] }),
      { ...planOf(), planDigest: 'c'.repeat(64) },
      planOf({ resources: { browser: { features: ['worker'], native: null }, native: { memoryMiB: 64,
        operationTimeoutMs: 5000, maxMs: 600000 } } }),
    ];
    for (const plan of refused) {
      const attempt = await api('manage/course-import', courseOf(randomUUID(), plan), admin);
      assert.equal(attempt.status, 400, `plan should be refused: ${JSON.stringify(plan).slice(0, 120)}`);
    }
  } finally { await runtime.stop().catch(() => {}); await rm(root, { recursive: true, force: true }).catch(() => {}); }
});

test('a mixed course pins execution and no-execution components without inventing or hiding operations', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-plan-mixed175-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  try {
    await runtime.install({ profile: 'local' });
    const { endpoint } = await runtime.start();
    const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
    const api = async (route, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const definitions = [];
    for (const component of [await aggregationPackage(), await legacyAnnotationPackage(), await preparedAnnotationPackage()]) {
      const imported = await api('manage/component-import', { requestId: randomUUID(), ...component }, admin);
      assert.equal(imported.status, 200, JSON.stringify(imported.value));
      definitions.push(imported.value);
    }
    const table = { key: 'table', definition: definitions[0], configuration: { title: '统计' }, materialIds: [] };
    const notes = { key: 'notes', definition: definitions[1], configuration: { title: '标注' }, materialIds: [] };
    const planOf = (bindings, planVersion = 1) => {
      const plan = { planId: 'mixed-course', planVersion, planDigest: '0'.repeat(64),
        components: bindings.map(binding => ({ key: binding.key, definitionDigest: binding.definition.digest,
          configurationDigest: sha256Json(binding.configuration), operations: binding.key === 'table' ? ['aggregate'] : [] })),
        capabilities: ['execution.submit', 'workspace.read', 'workspace.change'],
        resources: { browser: { features: ['worker', 'webassembly'] }, native: null }, locations: ['browser'], remote: null };
      plan.planDigest = sha256Json(courseExecutionPlanBasis(plan));
      return plan;
    };
    const courseId = randomUUID(), taskId = randomUUID();
    const courseOf = (bindings, plan) => ({ formatVersion: 1, requestId: randomUUID(),
      course: { courseId, name: '统计与标注' }, task: { taskId, title: '统计并标注观察', summary: '' },
      release: { releaseId: randomUUID(), objectives: ['计算并记录观察'], requirements: '统计数据，标注观察。',
        starterWorks: [], capabilities: [], components: bindings, materials: [], executionPlan: plan }, resources: [] });
    const bindings = [table, notes], plan = planOf(bindings), first = courseOf(bindings, plan);
    const published = await api('manage/course-import', first, admin);
    assert.equal(published.status, 200, 'execution and no-execution components must coexist: ' + JSON.stringify(published.value));

    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'plan-mixed', password }, admin);
    assert.equal(member.status, 200);
    const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'plan-mixed', password }) });
    assert.equal(login.status, 200);
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    assert.equal((await api('manage/course-access', { requestId: randomUUID(), courseId,
      principalId: member.value.principalId, active: true }, admin)).status, 200);
    const opened = await api('course-activities', { requestId: randomUUID(), releaseId: first.release.releaseId }, headers);
    assert.equal(opened.status, 200, JSON.stringify(opened.value));
    assert.deepEqual(opened.value.course.components, bindings);
    assert.deepEqual(opened.value.course.executionPlan, plan);

    // A preparation-only component remains non-executable; its new version cannot drift an old activity.
    const nextBindings = [table, { ...notes, definition: definitions[2], configuration: { title: '标注新版' } }];
    const nextPlan = planOf(nextBindings, 2), next = courseOf(nextBindings, nextPlan);
    const updated = await api('manage/course-import', next, admin);
    assert.equal(updated.status, 200, JSON.stringify(updated.value));
    const nextOpened = await api('course-activities', { requestId: randomUUID(), releaseId: next.release.releaseId }, headers);
    assert.equal(nextOpened.status, 200, JSON.stringify(nextOpened.value));
    assert.deepEqual(nextOpened.value.course.components, nextBindings);
    assert.deepEqual(nextOpened.value.course.executionPlan, nextPlan);
    const reopened = await api(`activities/${opened.value.activityId}`, undefined, headers);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.value.course.releaseId, first.release.releaseId);
    assert.equal(reopened.value.course.contentDigest, opened.value.course.contentDigest);
    assert.deepEqual(reopened.value.course.components, bindings);
    assert.deepEqual(reopened.value.course.executionPlan, plan);
    const original = await api(`releases/${first.release.releaseId}`, undefined, headers);
    assert.equal(original.status, 200);
    assert.deepEqual(original.value.components, bindings);
    assert.deepEqual(original.value.executionPlan, plan);

    // Empty operations are permitted only for genuinely non-executable components, with fixed identities.
    for (const [label, mutate] of [
      ['missing executable binding', value => { value.components.shift(); }],
      ['hidden real operation', value => { value.components[0].operations = []; }],
      ['invented executable operation', value => { value.components[0].operations = ['unknown-operation']; }],
      ['invented annotation operation', value => { value.components[1].operations = ['annotate']; }],
      ['changed annotation definition', value => { value.components[1].definitionDigest = 'a'.repeat(64); }],
      ['changed annotation configuration', value => { value.components[1].configurationDigest = 'b'.repeat(64); }],
    ]) {
      const invalid = structuredClone(plan);
      mutate(invalid);
      invalid.planDigest = sha256Json(courseExecutionPlanBasis(invalid));
      const refused = await api('manage/course-import', courseOf(bindings, invalid), admin);
      assert.equal(refused.status, 400, label);
    }
  } finally { await runtime.stop().catch(() => {}); await rm(root, { recursive: true, force: true }).catch(() => {}); }
});

/**
 * The same import boundary names a native session: the plan is what allows the session, and a plan
 * that only allows a browser job cannot smuggle the session in.
 */
test('a plan declares the native session it allows and the owner refuses an unplanned location', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-plan-native175-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
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
    const { manifest } = published, definition = imported.value, session = manifest.session;
    const binding = { key: 'accumulator', definition, configuration: { title: '四态累加模拟' }, materialIds: [] };
    const planOf = (overrides = {}) => {
      const content = { planId: 'accumulator-session', planVersion: 1,
        components: [{ key: 'accumulator', definitionDigest: definition.digest, configurationDigest: sha256Json(binding.configuration),
          operations: ['advance'] }],
        capabilities: ['execution.submit', 'native-session'],
        resources: { browser: null, native: { memoryMiB: 32, operationTimeoutMs: 4000, maxMs: 600000 } },
        locations: ['native'], remote: null, ...overrides };
      return { ...content, planDigest: sha256Json(courseExecutionPlanBasis({ ...content, planDigest: '0'.repeat(64) })) };
    };
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    const courseOf = (plan) => ({ formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '有状态会话验收样例' },
      task: { taskId, title: '观察四态累加', summary: '' },
      release: { releaseId, objectives: ['连续输入并观察真实内部状态'], requirements: '依次输入 1、2、2，观察 1、3、1。',
        starterWorks: [], capabilities: [], components: [binding], materials: [], executionPlan: plan }, resources: [] });
    // A plan cannot claim a budget larger than the adapter enforces, nor hide the operations it declares.
    for (const plan of [planOf({ resources: { browser: null, native: { memoryMiB: session.budgets.memoryMiB + 1,
      operationTimeoutMs: 4000, maxMs: 600000 } } }), planOf({ capabilities: ['execution.submit'] })]) {
      assert.equal((await api('manage/course-import', courseOf(plan), admin)).status, 400);
    }
    assert.equal((await api('manage/course-import', courseOf(planOf()), admin)).status, 200);
    const password = randomUUID();
    const member = await api('manage/members', { requestId: randomUUID(), loginName: 'plan-native', password }, admin);
    const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'plan-native', password }) });
    const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true }, admin);
    const created = await api('course-activities', { requestId: randomUUID(), releaseId }, headers);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    const activity = created.value;
    assert.equal(activity.course.executionPlan.locations[0], 'native');
    const actionOf = (requestId, overrides = {}) => ({ protocolVersion: 2, kind: 'execution', requestId,
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' },
      execution: {
        instance: { instanceId: `${activity.activityId}:accumulator`, key: 'accumulator', componentId: manifest.componentId,
          componentVersion: manifest.version, definitionDigest: definition.digest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: session.operation.operationId, effect: 'input' }, parameters: {},
        device: { platform: process.platform === 'darwin' && process.arch === 'arm64' ? 'macos-arm64'
          : process.platform === 'win32' && process.arch === 'x64' ? 'windows-x64'
            : process.platform === 'linux' && process.arch === 'x64' ? 'linux-x64' : null,
          browser: { worker: typeof Worker === 'function', webassembly: typeof WebAssembly === 'object', sandboxedFrame: false },
          native: { supported: true, installed: true, authorized: true, prepared: 'ready' } },
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
        limits: { timeMs: session.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: session.budgets.inputBytes,
          outputBytes: session.budgets.outputBytes, concurrentJobs: session.budgets.concurrentSessions,
          queuedJobs: session.budgets.queuedSessions },
        plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
          planDigest: sha256Json({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId,
            componentVersion: manifest.version, operationId: session.operation.operationId }) },
        session: { adapterId: session.adapterId, adapterVersion: session.adapterVersion,
          limits: { operationTimeoutMs: session.budgets.operationTimeoutMs, idleMs: session.budgets.idleMs,
            maxMs: session.budgets.maxMs, memoryMiB: session.budgets.memoryMiB,
            concurrentSessions: session.budgets.concurrentSessions, queuedSessions: session.budgets.queuedSessions } },
        initiator: { kind: 'student', principalId: activity.identity.principalId }, ...overrides } });
    const accepted = await api(`executions/${activity.activityId}`, { action: actionOf(randomUUID()) }, headers);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
    assert.equal(accepted.value.state, 'running');
    // A session for a component this activity does not bind is refused; the plan is the last guard,
    // so a run never reaches a location the activity's own plan did not declare.
    const foreign = actionOf(randomUUID(), { instance: { instanceId: `${activity.activityId}:other`, key: 'other',
      componentId: manifest.componentId, componentVersion: manifest.version, definitionDigest: definition.digest,
      hostApiVersion: 1, stateVersion: 1 } });
    assert.equal((await api(`executions/${activity.activityId}`, { action: foreign }, headers)).status, 403);
  } finally { await runtime.stop().catch(() => {}); await rm(root, { recursive: true, force: true }).catch(() => {}); }
});
