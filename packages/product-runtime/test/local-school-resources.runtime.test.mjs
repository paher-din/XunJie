import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { createFileBackend, openStorage } from '@xunjie/storage';
import { learningMigrations } from '@xunjie/learning-space';
import { componentBundleSchema, componentAlgorithmBundleSchema, componentDependencyContentSchema, componentRuntimeResourceContentSchema } from '@xunjie/contracts/components';
import { courseMaterialContentSchema } from '@xunjie/contracts/courses';
import { canonicalValue, courseExecutionPlanBasis, executionActionSchema } from '@xunjie/contracts/execution';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';
import { preparedAnnotationPackage } from '../../../components/material-annotation/package.mjs';
import { aluPackage } from '../../../components/alu-experiment/package.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(canonicalValue(value)));
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

/** Execute the production restricted WASM algorithm, using downloaded bytes rather than a fake outcome.
 * This runtime test exercises its owner protocol; it does not claim browser/iframe UI acceptance. */
async function aggregationEngine() {
  const compiled = await build({ entryPoints: [fileURLToPath(new URL('../../../apps/web/src/tool-execution/algorithm.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24' });
  return import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
}
function exactResource(actual, expected, originalBase64, label) {
  const bytes = Buffer.from(actual.contentBase64, 'base64');
  assert.equal(actual.contentBase64, originalBase64, label + ' immutable bytes');
  assert.equal(bytes.length, expected.byteLength, label + ' byte length');
  assert.equal(sha(bytes), expected.sha256, label + ' SHA-256');
  if (actual.sha256 !== undefined) {
    assert.equal(actual.sha256, expected.sha256, label + ' declared digest');
    assert.equal(actual.byteLength, expected.byteLength, label + ' declared length');
    assert.equal(actual.mediaType, expected.mediaType, label + ' media type');
  }
  for (const field of ['resourceId', 'materialId', 'dependencyId', 'path', 'role']) {
    if (actual[field] !== undefined) assert.equal(actual[field], expected[field], label + ' ' + field);
  }
  return bytes;
}

for (const acquisition of ['new', 'migration']) test(`${acquisition}: downloaded school resources run offline locally and only selected immutable results reach school, isolated across accounts`, { timeout: 240000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-local-school-resources-'));
  const schoolRoot = join(directory, 'school'), deviceRoot = join(directory, 'device');
  const school = openProductRuntime({ root: schoolRoot, resources }), device = openProductRuntime({ root: deviceRoot, resources });
  let schoolState, deviceState, ledger;
  const request = async (endpoint, route, body, headers = {}, expected = 200) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), {
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, expected, route + ': ' + JSON.stringify(value));
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const schoolApi = (route, body, headers, expected) => request(schoolState.endpoint, route, body, headers, expected);
  const deviceApi = (route, body, headers, expected) => request(deviceState.endpoint, route, body, headers, expected);
  async function openSchoolLedger() {
    const owner = schoolState.environment.services.find(service => service.unit === 'learning-data');
    return openStorage({ binding: JSON.parse(await resolveCredential(schoolRoot, 'storage-' + owner.serviceId)),
      migrations: learningMigrations, backend: createFileBackend({ id: 'learning-data', root: join(schoolRoot, 'learning-resources', 'learning-data') }) });
  }
  async function noSchoolProcess() {
    for (const table of ['work_heads', 'work_contents', 'question_drafts', 'action_intents', 'execution_records',
      'execution_record_facts', 'execution_record_observations', 'execution_commands', 'execution_results', 'native_sessions']) {
      assert.equal((await ledger.read(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table + ' must stay off school');
    }
  }
  try {
    await school.install({ profile: 'school', deployment: { formatVersion: 1,
      modules: ['space-course', 'learning-data'], dependencies: {} } });
    await device.install({ profile: 'local', deployment: { formatVersion: 1,
      modules: ['space-course', 'learning-data', 'teaching-agent', 'model-connection', 'tool-execution'], dependencies: {} } });
    schoolState = await school.start(); deviceState = await device.start();
    const admin = { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') };
    const actors = [];
    for (let index = 0; index < 2; index++) {
      const loginName = `resource-student-${index}-${randomUUID()}`, password = randomUUID();
      const identity = (await schoolApi('manage/members', { requestId: randomUUID(), loginName, password }, admin)).value;
      const login = await schoolApi('login', { loginName, password });
      actors.push({ identity, member: { cookie: login.cookie, 'x-xj-space': 'school' } });
    }
    const first = actors[0], second = actors[1];
    const publications = [await aggregationPackage(), await preparedAnnotationPackage(), await aluPackage()];
    const keys = ['table', 'annotation', 'alu'];
    const components = [];
    for (const [index, publication] of publications.entries()) {
      const definition = (await schoolApi('manage/component-import', { ...publication, requestId: randomUUID() }, admin)).value;
      components.push({ key: keys[index], definition, configuration: { title: definition.manifest.title }, materialIds: [] });
    }
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID();
    const materialBytes = Buffer.from('\ufeff# 学校固定材料\r\n离线仍须逐字保留：中文与🙂。\r\n');
    const material = { materialId, title: '固定材料', path: 'reading.md', mediaType: 'text/markdown', access: 'student',
      sha256: sha(materialBytes), byteLength: materialBytes.length };
    components[1].materialIds = [materialId];
    const plan = { planId: 'offline-resource-course', planVersion: 1,
      components: components.map(({ key, definition, configuration }) => ({ key, definitionDigest: definition.digest,
        configurationDigest: digest(configuration), operations: definition.manifest.formatVersion === 3
          ? definition.manifest.runtime.operations.map(operation => operation.operationId)
          : definition.manifest.operations?.map(operation => operation.operationId) ?? [] })),
      capabilities: ['workspace.read', 'workspace.change', 'execution.submit'],
      resources: { browser: { features: ['worker', 'webassembly', 'sandboxed-frame'] }, native: null },
      locations: ['browser'], remote: null, planDigest: '0'.repeat(64) };
    plan.planDigest = digest(courseExecutionPlanBasis(plan));
    await schoolApi('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '完整资源离线课程' },
      task: { taskId, title: '本机计算并提交选定结果', summary: '' }, release: { releaseId, objectives: ['学校停机后使用固定资源'],
        requirements: '完成聚合并提交原始结果。', materials: [material], starterWorks: [], capabilities: [], components,
        executionPlan: plan, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } },
      resources: [{ path: material.path, contentBase64: materialBytes.toString('base64') }] }, admin);
    // Both accounts may read the course, but this does not grant access to each other's learning data.
    for (const actor of actors) await schoolApi('manage/course-access', { requestId: randomUUID(), courseId,
      principalId: actor.identity.principalId, active: true }, admin);
    async function bind(actor) {
      const connectionId = randomUUID();
      await deviceApi('client/start', { requestId: connectionId, schoolEndpoint: schoolState.endpoint });
      await schoolApi('connections/approve', { requestId: connectionId }, actor.member);
      await deviceApi('client/complete', { requestId: connectionId });
      return { connectionId, headers: { 'x-xj-space': 'school:' + connectionId } };
    }
    const existingActivity = acquisition === 'migration'
      ? (await schoolApi('course-activities', { requestId: randomUUID(), releaseId }, first.member)).value : null;
    const connection = await bind(first), connected = connection.headers;
    const courseRequest = { requestId: randomUUID(), releaseId };
    const activity = existingActivity
      ? (await deviceApi('activities', undefined, connected)).value.find(item => item.activityId === existingActivity.activityId)
      : (await deviceApi('course-activities', courseRequest, connected)).value;
    assert.ok(activity, 'the requested school course must be available on this device');
    assert.equal(activity.identity.principalId, first.identity.principalId);
    assert.equal(activity.target.serviceId, deviceState.environment.services.find(service => service.unit === 'learning-data').serviceId);
    assert.notEqual(activity.target.serviceId, schoolState.environment.services.find(service => service.unit === 'learning-data').serviceId);
    if (acquisition === 'new') assert.deepEqual((await deviceApi('course-activities', courseRequest, connected)).value, activity,
      'retrying acquisition retains one original activity and receipt');
    ledger = await openSchoolLedger(); await noSchoolProcess();
    if (acquisition === 'new') assert.equal((await ledger.read('SELECT count(*)::int AS n FROM school_acquisitions')).rows[0].n, 1);
    assert.equal((await ledger.read('SELECT count(*)::int AS n FROM activities')).rows[0].n, 1);
    await ledger.close(); ledger = undefined;
    await school.stop(); await device.stop(); deviceState = await device.start();
    assert.equal((await school.status()).state, 'stopped');
    await t.test('cold offline reads retain materials, component views, algorithm, dependency and every declared runtime file', async () => {
      const offlineRelease = (await deviceApi('releases/' + releaseId, undefined, connected)).value;
      assert.equal(offlineRelease.contentDigest, activity.course.contentDigest);
      const retainedMaterial = courseMaterialContentSchema.parse((await deviceApi(`releases/${releaseId}/materials/${materialId}`, undefined, connected)).value);
      exactResource(retainedMaterial, material, materialBytes.toString('base64'), 'material');
      for (const [index, component] of components.entries()) {
        const path = `releases/${releaseId}/components/${component.key}`;
        const bundle = componentBundleSchema.parse((await deviceApi(path, undefined, connected)).value);
        assert.deepEqual(bundle.definition, component.definition);
        exactResource(bundle, component.definition.manifest.entry, publications[index].contentBase64, component.key);
      }
      const dependency = publications[1].manifest.dependencies[0];
      exactResource(componentDependencyContentSchema.parse((await deviceApi(`releases/${releaseId}/components/annotation/dependencies/${dependency.dependencyId}`, undefined, connected)).value),
        dependency, publications[1].dependencies[0].contentBase64, 'locked dependency');
      for (const runtime of publications[2].manifest.runtime.resources) {
        exactResource(componentRuntimeResourceContentSchema.parse((await deviceApi(`releases/${releaseId}/components/alu/resources/${runtime.path}`, undefined, connected)).value),
          runtime, publications[2].runtimeResources.find(item => item.resourceId === runtime.resourceId).contentBase64, runtime.path);
      }
    });
    const algorithm = componentAlgorithmBundleSchema.parse((await deviceApi(`releases/${releaseId}/components/table/algorithm`, undefined, connected)).value);
    assert.deepEqual(algorithm.definition, components[0].definition);
    const algorithmBytes = exactResource(algorithm, publications[0].manifest.algorithm.resource, publications[0].algorithmBase64, 'algorithm');
    const manifest = publications[0].manifest;
    const state = { formatVersion: 1, instanceId: activity.activityId + ':table', componentId: manifest.componentId,
      version: manifest.version, definitionDigest: components[0].definition.digest, stateVersion: 1, operationId: randomUUID(),
      content: { table: { columns: ['小组', '得分'], rows: [['A', '2'], ['A', '4'], ['B', '12']] },
        parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } };
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify(state) };
    await deviceApi('workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] }, connected);
    const requestId = randomUUID(), executionRef = randomUUID();
    const action = executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId,
      scope: { environmentId: first.identity.environmentId, spaceId: first.identity.spaceId,
        principalId: first.identity.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' }, execution: {
        instance: { instanceId: state.instanceId, key: 'table', componentId: manifest.componentId, componentVersion: manifest.version,
          definitionDigest: components[0].definition.digest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: 'aggregate', effect: 'execute' }, parameters: state.content.parameters,
        basis: { works: [file], state: { name: file.name, contentId: file.contentId, sha256: digest(state) },
          expected: { stateContentId: file.contentId }, resources: [{ kind: 'entry', ...manifest.entry }, { kind: 'algorithm', ...manifest.algorithm.resource }] },
        limits: { timeMs: 5000, memoryPages: 256, inputBytes: 1048576, outputBytes: 65536, concurrentJobs: 1, queuedJobs: 4 },
        plan: { planId: 'browser-job', planVersion: 1, location: 'browser', kind: 'job',
          planDigest: digest({ planId: 'browser-job', planVersion: 1, componentId: manifest.componentId, componentVersion: manifest.version, operationId: 'aggregate' }) },
        initiator: { kind: 'student', principalId: first.identity.principalId } } });
    const path = 'executions/' + activity.activityId;
    const acceptance = { receipt: { requestId, inputDigest: sha(JSON.stringify(action)), receiver: action.receiver,
      state: 'accepted', receiptId: 'resource-test:' + requestId, detail: '本机固定输入' }, execution: { executionRef, acceptedSeq: 1 } };
    const accepted = (await deviceApi(path, { action, acceptance }, connected)).value;
    assert.equal(accepted.executionRef, executionRef);
    const running = (await deviceApi(`${path}/${requestId}/report`, { ...accepted, state: 'running', confirmedSeq: 2 }, connected)).value;
    const engine = await aggregationEngine();
    const computed = engine.runAggregation({ ...engine.jobFromAction(action, action.execution.limits), bytes: algorithmBytes,
      entry: algorithm.entry, memoryPages: algorithm.memoryPages });
    assert.equal(computed.result.value, 6, 'real WASM must compute (2+4+12)/3');
    assert.deepEqual(computed.result.groups.map(group => [group.key, group.value]), [['A', 3], ['B', 12]]);
    const resultInput = { contentId: randomUUID(), output: computed.result, ...computed.artifact,
      sha256: sha(computed.artifact.text), byteLength: Buffer.byteLength(computed.artifact.text) };
    const saved = (await deviceApi(`${path}/${requestId}/result`, resultInput, connected)).value;
    await deviceApi(`${path}/${requestId}/report`, { ...running, output: saved.output, state: 'succeeded', confirmedSeq: 3 }, connected);
    const historical = (await deviceApi(`${path}/history`, undefined, connected)).value.entries.find(entry => entry.action.requestId === requestId);
    assert.equal(historical.query.state, 'succeeded');
    const artifact = (await deviceApi(`${path}/${requestId}/artifact`, undefined, connected)).value;
    assert.equal(artifact.text, computed.artifact.text); assert.equal(artifact.sha256, resultInput.sha256);
    const submission = { requestId: randomUUID(), works: [], artifacts: [], evidence: [{ requestId, executionRef,
      mediaType: artifact.mediaType, text: artifact.text }] };
    await deviceApi('submissions/' + activity.activityId, submission, connected, 503);
    schoolState = await school.start(); ledger = await openSchoolLedger(); await noSchoolProcess();
    const receipt = (await deviceApi('submissions/' + activity.activityId, submission, connected)).value;
    assert.equal(receipt.state, 'accepted');
    assert.deepEqual((await deviceApi('submissions/' + activity.activityId, submission, connected)).value, receipt);
    const fixed = (await deviceApi(`submissions/${activity.activityId}/${receipt.submissionId}`, undefined, connected)).value;
    assert.deepEqual(fixed.evidence, submission.evidence); assert.deepEqual(fixed.works, []);
    assert.equal(sha(fixed.evidence[0].text), resultInput.sha256);
    await schoolApi('submissions/' + activity.activityId, { ...submission,
      evidence: [{ ...submission.evidence[0], text: 'tampered-after-receipt' }] }, first.member, 409);
    // Subsequent local edits and restarts cannot rewrite the explicit delivery's original bytes.
    const changedState = structuredClone(state); changedState.content.table.rows[0][1] = '999'; changedState.operationId = randomUUID();
    await deviceApi('workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 1,
      files: [{ ...file, contentId: randomUUID(), value: JSON.stringify(changedState) }] }, connected);
    await device.stop(); deviceState = await device.start();
    assert.equal((await deviceApi(`${path}/${requestId}/artifact`, undefined, connected)).value.text, computed.artifact.text);
    assert.deepEqual((await schoolApi(`submissions/${activity.activityId}/${receipt.submissionId}`, undefined, first.member)).value, fixed);
    await noSchoolProcess();
    assert.equal((await ledger.read('SELECT count(*)::int AS n FROM school_submissions')).rows[0].n, 1);
    await deviceApi('connections/revoke', { connectionId: connection.connectionId }, connected);
    const otherConnection = await bind(second);
    assert.equal((await deviceApi('activities', undefined, otherConnection.headers)).value.some(item => item.activityId === activity.activityId), false);
    const inaccessible = ['workspaces/' + activity.activityId, `executions/${activity.activityId}/${requestId}/artifact`,
      `submissions/${activity.activityId}/${receipt.submissionId}`];
    for (const route of inaccessible) await deviceApi(route, undefined, otherConnection.headers, 404);
    await deviceApi('submissions/' + activity.activityId, { ...submission, requestId: randomUUID() }, otherConnection.headers, 404);
    await schoolApi(`submissions/${activity.activityId}/${receipt.submissionId}`, undefined, second.member, 404);
    await schoolApi('submissions/' + activity.activityId, { ...submission, requestId: randomUUID() }, second.member, 404);
    // Even on the same device, the prior connection cannot address its former owner's private copy.
    await deviceApi('workspaces/' + activity.activityId, undefined, connected, 403);
    await noSchoolProcess();
    assert.equal((await ledger.read('SELECT count(*)::int AS n FROM school_submissions')).rows[0].n, 1);
  } finally {
    await ledger?.close();
    await Promise.allSettled([device.stop(), school.stop()]);
    await rm(directory, { recursive: true, force: true });
  }
});
