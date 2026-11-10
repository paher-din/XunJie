import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { createFileBackend, openStorage } from '@xunjie/storage';
import { createExecutionOwner, executionOwnerMigrations, learningMigrations, validateLearningData } from '@xunjie/learning-space';
import { canonicalValue, courseExecutionPlanBasis, executionActionSchema } from '@xunjie/contracts/execution';
import { semanticReferenceCopy } from '@xunjie/contracts/question-drafts';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => sha(JSON.stringify(canonicalValue(value)));
const fixedId = value => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };

test('local study API merges original execution owners with read-only school history and never replays archived requests', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-school-execution-history-'));
  const schoolRoot = join(directory, 'school'), deviceRoot = join(directory, 'device'), handles = [];
  const school = openProductRuntime({ root: schoolRoot, resources }), device = openProductRuntime({ root: deviceRoot, resources });
  let schoolState, deviceState;
  const request = async (endpoint, route, body, headers = {}, expected = 200) => {
    const response = await fetch(endpoint + '/api/learning/' + route, {
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, expected, route + ': ' + JSON.stringify(value));
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const schoolApi = (...args) => request(schoolState.endpoint, ...args);
  const deviceApi = (...args) => request(deviceState.endpoint, ...args);
  async function ledger(root, state, unit, migrations) {
    const owner = state.environment.services.find(service => service.unit === unit);
    const storage = await openStorage({ binding: JSON.parse(await resolveCredential(root, 'storage-' + owner.serviceId)), migrations,
      backend: createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) }) });
    handles.push(storage); return storage;
  }
  try {
    await school.install({ profile: 'school', deployment: { formatVersion: 1, modules: ['space-course', 'learning-data'], dependencies: {} } });
    await device.install({ profile: 'local', deployment: { formatVersion: 1,
      modules: ['space-course', 'learning-data', 'teaching-agent', 'model-connection', 'tool-execution'], dependencies: {} } });
    schoolState = await school.start(); deviceState = await device.start();
    const admin = { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') };
    const loginName = 'execution-history-' + randomUUID(), password = randomUUID();
    const actor = (await schoolApi('manage/members', { requestId: randomUUID(), loginName, password }, admin)).value;
    const login = await schoolApi('login', { loginName, password });
    const member = { cookie: login.cookie, 'x-xj-space': 'school' };
    const definition = (await schoolApi('manage/component-import', { ...await aggregationPackage(), requestId: randomUUID() }, admin)).value;
    const component = { key: 'table', definition, configuration: { title: '历史原件' }, materialIds: [] };
    const plan = { planId: 'history-browser', planVersion: 1, planDigest: '0'.repeat(64),
      components: [{ key: component.key, definitionDigest: definition.digest, configurationDigest: hash(component.configuration), operations: ['aggregate'] }],
      capabilities: ['execution.submit'], resources: { browser: { features: ['worker', 'webassembly'] }, native: null }, locations: ['browser'], remote: null };
    plan.planDigest = hash(courseExecutionPlanBasis(plan));
    const courseId = randomUUID(), releaseId = randomUUID();
    await schoolApi('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '历史学习课程' },
      task: { taskId: randomUUID(), title: '回读原实验', summary: '' }, release: { releaseId, objectives: ['保留实验原件'],
        requirements: '读取历史结果。', materials: [], starterWorks: [], capabilities: [], components: [component], executionPlan: plan,
        helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } }, resources: [] }, admin);
    await schoolApi('manage/course-access', { requestId: randomUUID(), courseId, principalId: actor.principalId, active: true }, admin);
    const activity = (await schoolApi('course-activities', { requestId: randomUUID(), releaseId }, member)).value;
    const scope = { environmentId: actor.environmentId, spaceId: actor.spaceId, principalId: actor.principalId, activityId: activity.activityId };
    const manifest = definition.manifest;
    function input(id) {
      const action = executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId: fixedId(id), scope,
        receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' }, execution: {
          instance: { instanceId: activity.activityId + ':table', key: component.key, componentId: manifest.componentId,
            componentVersion: manifest.version, definitionDigest: definition.digest, hostApiVersion: 1, stateVersion: manifest.stateVersion },
          operation: { operationId: 'aggregate', effect: 'execute' }, parameters: {},
          basis: { works: [], state: null, expected: { stateContentId: null },
            resources: [{ kind: 'entry', ...manifest.entry }, { kind: 'algorithm', ...manifest.algorithm.resource }] },
          limits: { timeMs: 5000, memoryPages: 256, inputBytes: 1048576, outputBytes: 65536, concurrentJobs: 1, queuedJobs: 4 },
          plan: { planId: 'browser-job', planVersion: 1, location: 'browser', kind: 'job', planDigest: hash({ planId: 'browser-job', planVersion: 1,
            componentId: manifest.componentId, componentVersion: manifest.version, operationId: 'aggregate' }) },
          initiator: { kind: 'student', principalId: actor.principalId } } });
      return { action, acceptance: { receipt: { requestId: action.requestId, inputDigest: sha(JSON.stringify(action)), receiver: action.receiver,
        state: 'accepted', receiptId: 'original:' + action.requestId, detail: '' }, execution: { executionRef: randomUUID(), acceptedSeq: 1 } } };
    }
    const archived = Array.from({ length: 35 }, (_, index) => input(index * 2));
    let archivedQuery;
    const output = { rows: 2, value: 3, groups: [{ key: 'A', count: 2, sum: 6, mean: 3, min: 2, max: 4, value: 3 }], rejected: [] };
    const text = '\ufeff组,均值\r\nA,3\r\n', contentId = randomUUID();
    for (const [index, command] of archived.entries()) {
      let query = (await schoolApi(`executions/${activity.activityId}`, command, member)).value;
      if (index === 0) {
        query = (await schoolApi(`executions/${activity.activityId}/${command.action.requestId}/result`, {
          contentId, text, name: 'original.csv', mediaType: 'text/csv', output, sha256: sha(text), byteLength: Buffer.byteLength(text) }, member)).value;
      }
      // One duplicate remains uncertain in the school copy; the original local owner will be authoritative.
      if (index !== 1) query = (await schoolApi(`executions/${activity.activityId}/${command.action.requestId}/report`, {
        ...query, state: 'succeeded', confirmedSeq: 2 }, member)).value;
      if (index === 0) archivedQuery = query;
    }
    const range = { kind: 'semantic', formatVersion: 1, typeId: 'aggregation-groups', version: 1,
      target: { groupKeys: ['A'], fields: ['mean'] }, start: 0, end: 1 };
    const copy = semanticReferenceCopy(range, output); range.end = copy.length;
    const reference = { referenceId: randomUUID(), sourceName: 'original.csv', copy, range, source: {
      kind: 'component', formatVersion: 1, ...scope, instanceId: activity.activityId + ':table', componentId: manifest.componentId,
      componentVersion: manifest.version, definitionDigest: definition.digest, bindingKey: component.key,
      objectId: archived[0].action.requestId, contentId, origin: 'execution-result', requestId: archived[0].action.requestId,
      executionRef: archived[0].acceptance.execution.executionRef } };
    const draft = (await schoolApi('drafts/' + activity.activityId, undefined, member)).value;
    const savedDraft = (await schoolApi('drafts/' + activity.activityId, { requestId: randomUUID(), draftId: draft.draftId,
      baseRevision: 0, question: '为什么平均是 3？', references: [reference], bases: [] }, member)).value;
    const schoolData = await ledger(schoolRoot, schoolState, 'learning-data', learningMigrations);
    assert.equal((await schoolData.read('SELECT count(*)::int AS n FROM execution_records')).rows[0].n, 0);
    const nativeDefinition = (await schoolApi('manage/component-import', { ...await accumulatorPackage(), requestId: randomUUID() }, admin)).value;
    const nativeCourseId = randomUUID(), nativeReleaseId = randomUUID(), nativeSession = nativeDefinition.manifest.session;
    await schoolApi('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId: nativeCourseId, name: '旧会话' },
      task: { taskId: randomUUID(), title: '保留原请求', summary: '' }, release: { releaseId: nativeReleaseId, objectives: ['保留身份'],
        requirements: '不得重放。', materials: [], starterWorks: [], capabilities: [],
        components: [{ key: 'counter', definition: nativeDefinition, configuration: { title: '旧会话' }, materialIds: [] }],
        helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } }, resources: [] }, admin);
    await schoolApi('manage/course-access', { requestId: randomUUID(), courseId: nativeCourseId, principalId: actor.principalId, active: true }, admin);
    const nativeActivity = (await schoolApi('course-activities', { requestId: randomUUID(), releaseId: nativeReleaseId }, member)).value;
    const nativeAction = executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId: randomUUID(),
      scope: { ...scope, activityId: nativeActivity.activityId }, receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' },
      execution: { instance: { instanceId: nativeActivity.activityId + ':counter', key: 'counter',
        componentId: nativeDefinition.manifest.componentId, componentVersion: nativeDefinition.manifest.version,
        definitionDigest: nativeDefinition.digest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: nativeSession.operation.operationId, effect: 'input' }, parameters: {},
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
        limits: { timeMs: nativeSession.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: nativeSession.budgets.inputBytes,
          outputBytes: nativeSession.budgets.outputBytes, concurrentJobs: nativeSession.budgets.concurrentSessions, queuedJobs: nativeSession.budgets.queuedSessions },
        plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session', planDigest: hash({ planId: 'native-session', planVersion: 1,
          componentId: nativeDefinition.manifest.componentId, componentVersion: nativeDefinition.manifest.version, operationId: nativeSession.operation.operationId }) },
        session: { adapterId: nativeSession.adapterId, adapterVersion: nativeSession.adapterVersion,
          limits: { operationTimeoutMs: nativeSession.budgets.operationTimeoutMs, idleMs: nativeSession.budgets.idleMs,
            maxMs: nativeSession.budgets.maxMs, memoryMiB: nativeSession.budgets.memoryMiB,
            concurrentSessions: nativeSession.budgets.concurrentSessions, queuedSessions: nativeSession.budgets.queuedSessions } },
        initiator: { kind: 'student', principalId: actor.principalId } } });
    // A valid pre-migration native receipt without synchronized execution_records. No process is launched by this fixture.
    await schoolData.request({ requestId: randomUUID(), fingerprint: 'legacy-native-receipt' }, async tx => {
      await tx.query(`INSERT INTO native_sessions(session_ref,activity_id,request_id,input_digest,action,action_text,
        adapter_id,adapter_version,node_id,install_generation,supervisor_epoch,executor_instance_id,state,status_knowledge,confirmed_seq)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'old-node','1',$9,$10,'cancelled','confirmed',1)`,
      [randomUUID(), nativeActivity.activityId, nativeAction.requestId, sha(JSON.stringify(nativeAction)), JSON.stringify(nativeAction),
        JSON.stringify(nativeAction), nativeSession.adapterId, nativeSession.adapterVersion, randomUUID(), randomUUID()]); return null;
    });
    await validateLearningData(schoolData);

    // Existing local owner facts predate the move, as on upgraded student installations.
    const executionStorage = await ledger(deviceRoot, deviceState, 'tool-execution', executionOwnerMigrations);
    const execution = createExecutionOwner(executionStorage, { activity: async () => activity,
      sourceFile: async () => { throw new Error('These commands have no works'); } });
    const originals = [...Array.from({ length: 35 }, (_, index) => input(index * 2 + 1)), archived[1]];
    for (const command of originals) {
      const query = await execution.executions.accept(actor, activity.activityId, command);
      await execution.executions.report(actor, activity.activityId, command.action.requestId, { ...query, state: 'succeeded', confirmedSeq: 3 });
    }
    const originalRows = (await executionStorage.read('SELECT * FROM execution_commands ORDER BY request_id')).rows;
    const connectionId = randomUUID();
    await deviceApi('client/start', { requestId: connectionId, schoolEndpoint: schoolState.endpoint });
    await schoolApi('connections/approve', { requestId: connectionId }, member);
    await deviceApi('client/complete', { requestId: connectionId });
    const connected = { 'x-xj-space': 'school:' + connectionId };
    await deviceApi('activities', undefined, connected);
    const base = `executions/${activity.activityId}`;
    assert.deepEqual((await deviceApi(`${base}/${archived[0].action.requestId}`, undefined, connected)).value, archivedQuery);
    const artifact = (await deviceApi(`${base}/${archived[0].action.requestId}/artifact`, undefined, connected)).value;
    assert.equal(artifact.text, text); assert.equal(artifact.sha256, sha(text)); assert.deepEqual(artifact.output, output);
    assert.deepEqual((await deviceApi('drafts/' + activity.activityId, undefined, connected)).value, savedDraft);
    assert.equal((await deviceApi(`${base}/${archived[1].action.requestId}`, undefined, connected)).value.confirmedSeq, 3);
    async function historyIds() {
      const entries = []; let cursor;
      do {
        const page = (await deviceApi(base + '/history' + (cursor ? '/' + cursor : ''), undefined, connected)).value;
        assert.ok(page.entries.length <= 32);
        assert.ok(!cursor || !page.nextCursor || page.nextCursor > cursor, 'cursor must advance');
        entries.push(...page.entries); cursor = page.nextCursor;
      } while (cursor);
      assert.equal(entries.find(entry => entry.action.requestId === archived[1].action.requestId).query.confirmedSeq, 3);
      return entries.map(entry => entry.action.requestId);
    }
    assert.deepEqual(await historyIds(), Array.from({ length: 70 }, (_, index) => fixedId(index)));
    await deviceApi(base, archived[0], connected, 403);
    await deviceApi(base, { ...archived[0], action: { ...archived[0].action, execution: { ...archived[0].action.execution, parameters: { changed: true } } } }, connected, 403);
    for (const operation of ['report', 'control', 'stop', 'result'])
      await deviceApi(`${base}/${archived[0].action.requestId}/${operation}`, {}, connected, 403);
    await deviceApi(`executions/${nativeActivity.activityId}`, { action: nativeAction }, connected, 403);
    for (const operation of ['report', 'control', 'stop', 'result'])
      await deviceApi(`executions/${nativeActivity.activityId}/${nativeAction.requestId}/${operation}`, {}, connected, 403);
    assert.deepEqual((await executionStorage.read('SELECT * FROM execution_commands ORDER BY request_id')).rows, originalRows);
    assert.deepEqual(await executionStorage.pendingIntents(), []);
    assert.deepEqual((await deviceApi(`${base}/${archived[0].action.requestId}`, undefined, connected)).value, archivedQuery);
    const next = input(70), newQuery = (await deviceApi(base, next, connected)).value;
    await deviceApi(`${base}/${next.action.requestId}/report`, { ...newQuery, state: 'succeeded', confirmedSeq: 2 }, connected);
    await deviceApi(`${base}/${archived[0].action.requestId}`, undefined,
      { ...connected, 'x-xj-expected-subject': [actor.environmentId, actor.spaceId, randomUUID()].join('.') }, 403);
    const localData = await ledger(deviceRoot, deviceState, 'learning-data', learningMigrations);
    await validateLearningData(localData);
    assert.equal((await localData.read('SELECT count(*)::int AS n FROM execution_commands')).rows[0].n, 0);
    assert.equal((await localData.read('SELECT count(*)::int AS n FROM native_sessions')).rows[0].n, 0);
    assert.equal((await executionStorage.read('SELECT count(*)::int AS n FROM native_sessions')).rows[0].n, 0);
    assert.equal((await schoolData.read('SELECT count(*)::int AS n FROM execution_commands')).rows[0].n, 0);
    const oldConnection = JSON.parse(await resolveCredential(deviceRoot, 'school-client-' + connectionId));
    delete oldConnection.grant.profile;
    assert.equal(oldConnection.localStudy.imported, true);
    for (const handle of handles.splice(0)) await handle.close();
    await school.stop(); await device.stop();
    await writeFile(join(deviceRoot, 'credentials', 'school-client-' + connectionId), JSON.stringify(oldConnection), { mode: 0o600 });
    deviceState = await device.start();
    assert.deepEqual((await deviceApi(`${base}/${archived[0].action.requestId}/artifact`, undefined, connected)).value, artifact);
    assert.deepEqual(await historyIds(), Array.from({ length: 71 }, (_, index) => fixedId(index)));
  } finally {
    await Promise.allSettled(handles.map(storage => storage.close()));
    await Promise.allSettled([device.stop(), school.stop()]);
    await rm(directory, { recursive: true, force: true });
  }
});
