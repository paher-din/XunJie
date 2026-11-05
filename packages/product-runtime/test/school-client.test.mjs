import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime';
import { preparedAnnotationPackage } from '../../../components/material-annotation/package.mjs';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';

test('revoking a school connection wins over an already exchanged but delayed confirmation', { timeout: 30000 }, async () => {
  const requestId = randomUUID();
  const grant = { connectionId: requestId, token: randomUUID() + randomUUID(),
    identity: { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校空间' },
    target: { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 }, capabilities: ['activity:read', 'activity:write'] };
  let exchangeCount = 0;
  let release;
  let admitted;
  const held = new Promise(resolve => { release = resolve; });
  const exchanging = new Promise(resolve => { admitted = resolve; });
  // Only the remote school boundary is controlled: exercise the real installed client HTTP surface.
  const school = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/connections/exchange')) {
      if (++exchangeCount === 2) { admitted(); await held; }
      response.end(JSON.stringify(grant));
    } else response.end(JSON.stringify({ revoked: true }));
  });
  await new Promise(resolve => school.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-client-revocation-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) } });
  let host;
  try {
    await runtime.install({ profile: 'remote' });
    host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
    const api = (path, body) => fetch(new URL('/api/learning/' + path, host.endpoint), {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'content-type': 'application/json' },
    });
    assert.equal((await api('client/start', { requestId, schoolEndpoint: `http://127.0.0.1:${school.address().port}` })).status, 200);
    assert.equal((await api('client/complete', { requestId })).status, 200);
    const completing = api('client/complete', { requestId });
    await exchanging;
    const revoked = await fetch(new URL('/api/learning/connections/revoke', host.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xj-space': 'school:' + requestId }, body: JSON.stringify({ connectionId: requestId }) });
    assert.equal(revoked.status, 200);
    release();
    await completing;
    const context = await (await api('context')).json();
    assert.deepEqual(context.identities, [], 'a delayed grant must not reappear after successful revocation');
    assert.equal((await api('client/complete', { requestId })).status, 403);
  } finally {
    release();
    await host?.stop();
    school.closeAllConnections();
    await new Promise(resolve => school.close(resolve));
  }
});

test('installed client forwards the course surface and rejects malformed or foreign responses', { timeout: 30000 }, async () => {
  const requestId = randomUUID();
  const grant = { connectionId: requestId, token: randomUUID() + randomUUID(),
    identity: { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校空间' },
    target: { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 }, capabilities: ['activity:read', 'activity:write'] };
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID();
  const malformedReleaseId = randomUUID();
  const digest = 'a'.repeat(64);
  const material = { materialId, title: '材料', mediaType: 'text/markdown', byteLength: 1, sha256: 'b'.repeat(64) };
  const publishedAt = new Date().toISOString();
  const draftId = randomUUID(), draftRevisionId = randomUUID();
  const draft = { draftId, revision: 1, revisionId: draftRevisionId, question: '固定引用问题', references: [{
    referenceId: randomUUID(), source: { kind: 'work', objectId: randomUUID(), contentId: randomUUID() },
    range: { kind: 'code', start: 0, end: 1 }, copy: 'x', sourceName: 'demo.sv', copyDigest: digest }] };
  const malformedDraftActivityId = randomUUID();
  const catalog = { courses: [{ courseId, name: '课程', tasks: [{ taskId, title: '任务', summary: '',
    releases: [{ releaseId, contentDigest: digest, objectives: ['目标'], publishedAt }] }] }] };
  const helpPolicy = { version: 1, questions: 'allowed', scope: 'course' };
  const release = { formatVersion: 1, courseId, taskId, releaseId, contentDigest: digest, objectives: ['目标'],
    requirements: '要求', materials: [material], starterWorks: [], capabilities: [], helpPolicy, publishedAt, courseName: '课程', taskTitle: '任务' };
  const activity = { activityId: randomUUID(), identity: grant.identity, target: grant.target, goal: '任务', question: '',
    references: [], status: 'open', createdAt: publishedAt, course: { associationId: randomUUID(), courseId,
      courseName: '课程', taskId, taskTitle: '任务', releaseId, contentDigest: digest, objectives: ['目标'],
      requirements: '要求', materials: [material], starterWorks: [], capabilities: [], helpPolicy } };
  const actionId = randomUUID(), malformedIntentActivity = randomUUID(), foreignIntentActivity = randomUUID();
  const executionId = randomUUID(), malformedExecutionActivity = randomUUID(), foreignExecutionActivity = randomUUID();
  const controlId = randomUUID(), mismatchedControlId = randomUUID();
  const checkpointId = randomUUID();
  const foreignPrincipalExecution = randomUUID();
  const executionQuery = { requestId: executionId, inputDigest: digest, executionRef: randomUUID(),
    scope: { environmentId: grant.identity.environmentId, spaceId: grant.identity.spaceId,
      principalId: grant.identity.principalId, activityId: activity.activityId },
    state: 'queued', statusKnowledge: 'confirmed', stopRequested: false, confirmedSeq: 1, reason: null, output: null };
  const checkpointPage = { items: [{ checkpointId, sessionRef: executionQuery.executionRef, sha256: digest,
    contentId: checkpointId, appliedSeq: 1, byteLength: 200, createdAt: publishedAt, requestId: executionId,
    instanceId: activity.activityId + ':accumulator', scope: executionQuery.scope }], nextCursor: null };
  // The algorithm is served through the authorised release, never from the component view.
  const published = await aggregationPackage();
  const algorithmBundle = { definition: { manifest: published.manifest,
    digest: createHash('sha256').update(JSON.stringify(published.manifest)).digest('hex') }, mediaType: 'application/wasm',
    entry: 'aggregate', memoryPages: 256, sha256: published.manifest.algorithm.resource.sha256,
    byteLength: published.manifest.algorithm.resource.byteLength, contentBase64: published.algorithmBase64 };
  const prepared = await preparedAnnotationPackage();
  const dependency = { ...prepared.manifest.dependencies[0], contentBase64: prepared.dependencies[0].contentBase64 };
  // The wire dependency response has only public content fields, not its declaration metadata.
  const dependencyContent = Object.fromEntries(['dependencyId', 'resourceId', 'sha256', 'byteLength', 'mediaType', 'contentBase64'].map(key => [key, dependency[key]]));
  const report = { formatVersion: 1, componentId: prepared.manifest.componentId, version: prepared.manifest.version,
    definitionDigest: digest, preparationProtocolVersion: 1, selfTestVersion: 1, hostVersion: 'test-host',
    device: { platform: 'test-platform', browser: 'Chrome', browserVersion: '156', features: [], preparationImplementationVersion: 1 },
    status: 'ready', reason: 'none', stage: 'activate', capabilities: [], durationMs: 1, resourceBytes: 100, cacheHit: false, preview: false };
  const reportReceipt = { reportId: randomUUID(), report };
  const receiver = { receiverId: 'school-question-receiver', location: 'remote', kind: 'question' };
  const actionInput = { requestId: actionId, scope: { environmentId: grant.identity.environmentId,
    spaceId: grant.identity.spaceId, principalId: grant.identity.principalId, activityId: activity.activityId }, receiver,
    draft: { token: randomUUID(), question: '转发原意图', references: [], bases: [] }, works: [], evidence: [] };
  const action = { input: actionInput, inputDigest: createHash('sha256').update(JSON.stringify(actionInput)).digest('hex'),
    dependencies: [], state: 'prepared', cancelRequested: false, receipt: null };
  const school = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    const url = request.url;
    if (url.endsWith('/connections/start')) response.end(JSON.stringify({ requestId }));
    else if (url.endsWith('/connections/exchange')) response.end(JSON.stringify(grant));
    else if (url.endsWith('/api/learning/courses')) response.end(JSON.stringify(catalog));
    else if (url.endsWith('/api/learning/releases/' + releaseId)) response.end(JSON.stringify(release));
    else if (url.endsWith('/api/learning/releases/' + releaseId + '/components/table/algorithm')) {
      response.end(JSON.stringify(algorithmBundle));
    } else if (url.endsWith('/components/annotation/dependencies/mark-js')) response.end(JSON.stringify(dependencyContent));
    else if (url.endsWith('/components/annotation/dependencies/broken')) response.end(JSON.stringify({ dependencyId: 'broken' }));
    else if (url.endsWith('/components/annotation/preparation-reports')) response.end(JSON.stringify([report]));
    else if (url.endsWith('/components/annotation/preparation-report')) response.end(JSON.stringify(reportReceipt));
    else if (url.includes('/api/learning/executions/')) {
      if (url.includes('/checkpoints') && url.includes('/executions/' + foreignPrincipalExecution)) response.end(JSON.stringify({ ...checkpointPage,
        items: [{ ...checkpointPage.items[0], scope: { ...executionQuery.scope, principalId: randomUUID() } }] }));
      else if (url.includes('/executions/' + malformedExecutionActivity)) response.end(JSON.stringify({ state: 'queued' }));
      else if (url.includes('/checkpoints')) response.end(JSON.stringify(checkpointPage));
      // The run that comes back belongs to another activity than the one the caller asked under.
      else if (url.includes('/executions/' + foreignExecutionActivity)) response.end(JSON.stringify({ ...executionQuery,
        scope: { ...executionQuery.scope, activityId: activity.activityId } }));
      else if (url.includes('/executions/' + foreignPrincipalExecution)) response.end(JSON.stringify({ ...executionQuery,
        scope: { ...executionQuery.scope, principalId: randomUUID() } }));
      else if (url.includes('/controls/')) response.end(JSON.stringify({ controlId, requestId: executionId,
        executionRef: executionQuery.executionRef, inputDigest: digest, effect: 'step', status: 'applied', seq: 1, query: executionQuery }));
      else if (url.endsWith('/sessions')) response.end(JSON.stringify([executionQuery]));
      else response.end(JSON.stringify(executionQuery));
    }
    else if (url.endsWith('/api/learning/releases/' + releaseId + '/materials/' + materialId)) {
      response.end(JSON.stringify({ ...material, contentBase64: 'eA==' }));
    } else if (url.endsWith('/api/learning/course-activity-results/' + activity.activityId)) response.end('null');
    else if (url.endsWith('/api/learning/activities')) response.end(JSON.stringify(request.method === 'POST' ? activity : [activity]));
    else if (url.endsWith('/api/learning/course-activities')) response.end(JSON.stringify(activity));
    else if (url.includes('/api/learning/intents/')) {
      if (url.includes('/intents/' + malformedIntentActivity)) response.end(JSON.stringify({ ...action, state: 'accepted' }));
      else if (url.includes('/intents/' + foreignIntentActivity)) response.end(JSON.stringify({ ...action,
        input: { ...actionInput, scope: { ...actionInput.scope, activityId: foreignIntentActivity, principalId: randomUUID() } } }));
      else if (url.endsWith('/capabilities')) response.end(JSON.stringify([receiver]));
      else if (url.endsWith('/intents/' + activity.activityId) && request.method === 'GET') response.end(JSON.stringify([action]));
      else response.end(JSON.stringify(action));
    }
    else if (url.includes('/api/learning/drafts/')) {
      if (url.endsWith('/drafts/' + malformedDraftActivityId)) response.end(JSON.stringify({ draftId }));
      else response.end(JSON.stringify(draft));
    }
    else if (url.endsWith('/api/learning/activities/' + activity.activityId)) {
      response.end(JSON.stringify({ ...activity, identity: { ...grant.identity, principalId: randomUUID() } }));
    } else if (url.endsWith('/api/learning/releases/' + malformedReleaseId)) response.end(JSON.stringify({ formatVersion: 1 }));
    else { response.writeHead(404); response.end(JSON.stringify({ error: 'missing' })); }
  });
  await new Promise(resolve => school.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'xj-client-courses-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) } });
  let host;
  try {
    await runtime.install({ profile: 'remote' });
    host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
    const api = async (path, body, headers = {}) => {
      const response = await fetch(new URL('/api/learning/' + path, host.endpoint), {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: { 'content-type': 'application/json', ...headers } });
      return { status: response.status, value: await response.json().catch(() => null) };
    };
    const schoolEndpoint = `http://127.0.0.1:${school.address().port}`;
    assert.equal((await api('client/start', { requestId, schoolEndpoint })).status, 200);
    assert.equal((await api('client/complete', { requestId })).status, 200);
    const remote = { 'x-xj-space': 'school:' + requestId };
    assert.equal((await api('courses', undefined, remote)).value.courses[0].courseId, courseId);
    assert.equal((await api('releases/' + releaseId, undefined, remote)).value.materials[0].materialId, materialId);
    assert.equal((await api(`releases/${releaseId}/materials/${materialId}`, undefined, remote)).value.contentBase64, 'eA==');
    assert.deepEqual((await api('course-activity-results/' + activity.activityId, undefined, remote)).value, null);
    assert.equal((await api('course-activities', { requestId: randomUUID(), releaseId }, remote)).status, 200);
    assert.equal((await api('activities', { requestId: randomUUID(), goal: '学校活动', question: '', references: [] }, remote)).status, 200);
    assert.equal((await api('activities/' + activity.activityId, undefined, remote)).status, 403);
    assert.equal((await api('releases/' + malformedReleaseId, undefined, remote)).status, 503);
    assert.equal((await api('drafts/' + activity.activityId, undefined, remote)).value.question, '固定引用问题');
    assert.equal((await api('drafts/' + activity.activityId, { requestId: randomUUID() }, remote)).value.revisionId, draftRevisionId);
    assert.equal((await api('drafts/' + activity.activityId, { requestId: randomUUID(), content: 'x'.repeat(100000) }, remote)).status, 200);
    assert.equal((await api(`drafts/${activity.activityId}/revisions/${draftRevisionId}`, undefined, remote)).status, 200);
    assert.equal((await api(`drafts/${activity.activityId}/receipts/${randomUUID()}`, undefined, remote)).status, 200);
    assert.equal((await api('drafts/' + malformedDraftActivityId, undefined, remote)).status, 503);
    assert.equal((await api('drafts/not-a-uuid', undefined, remote)).status, 403);
    assert.deepEqual((await api('intents/' + activity.activityId, undefined, remote)).value, [action]);
    assert.deepEqual((await api('intents/' + activity.activityId, actionInput, remote)).value, action);
    assert.deepEqual((await api(`intents/${activity.activityId}/${actionId}`, undefined, remote)).value, action);
    assert.deepEqual((await api(`intents/${activity.activityId}/capabilities`, undefined, remote)).value, [receiver]);
    assert.equal((await api(`intents/${malformedIntentActivity}/${actionId}`, undefined, remote)).status, 503);
    assert.equal((await api(`intents/${foreignIntentActivity}/${actionId}`, undefined, remote)).status, 403);
    assert.equal((await api('intents/not-a-uuid', undefined, remote)).status, 403);
    // A browser run is forwarded under the same grant and the same activity it was accepted for.
    assert.equal((await api('executions/' + activity.activityId, { action: {}, acceptance: {} }, remote)).value.executionRef,
      executionQuery.executionRef);
    assert.equal((await api(`executions/${activity.activityId}/${executionId}`, undefined, remote)).value.state, 'queued');
    assert.equal((await api(`executions/${activity.activityId}/${executionId}/report`, {}, remote)).value.state, 'queued');
    assert.equal((await api(`executions/${activity.activityId}/${executionId}/stop`, {}, remote)).value.state, 'queued');
    assert.equal((await api(`executions/${activity.activityId}/${executionId}/result`, {}, remote)).value.state, 'queued');
    assert.equal((await api(`executions/${activity.activityId}/${executionId}/control`, {}, remote)).value.state, 'queued');
    assert.equal((await api(`executions/${activity.activityId}/sessions`, undefined, remote)).value[0].requestId, executionId);
    assert.equal((await api(`executions/${activity.activityId}/checkpoints`, undefined, remote)).value.items[0].checkpointId, checkpointId);
    assert.equal((await api(`executions/${activity.activityId}/checkpoints/${checkpointId}`, undefined, remote)).value.items[0].checkpointId, checkpointId);
    assert.equal((await api(`executions/${malformedExecutionActivity}/checkpoints`, undefined, remote)).status, 503);
    assert.equal((await api(`executions/${foreignPrincipalExecution}/checkpoints`, undefined, remote)).status, 403);
    assert.equal((await api(`executions/${activity.activityId}/checkpoints/not-a-cursor`, undefined, remote)).status, 403);
    assert.equal((await api(`executions/${activity.activityId}/${executionId}/controls/${controlId}`, undefined, remote)).value.controlId, controlId);
    assert.equal((await api(`executions/${activity.activityId}/${executionId}/controls/${mismatchedControlId}`, undefined, remote)).status, 403);
    assert.equal((await api(`executions/${malformedExecutionActivity}/${executionId}/controls/${controlId}`, undefined, remote)).status, 503);
    assert.equal((await api(`executions/${activity.activityId}/${executionId}/controls/${controlId}/extra`, undefined, remote)).status, 403);
    assert.equal((await api(`executions/${malformedExecutionActivity}/${executionId}`, undefined, remote)).status, 503);
    assert.equal((await api(`executions/${foreignExecutionActivity}/${executionId}`, undefined, remote)).status, 403);
    assert.equal((await api(`executions/${foreignPrincipalExecution}/${executionId}`, undefined, remote)).status, 403);
    assert.equal((await api('executions/not-a-uuid/' + executionId, undefined, remote)).status, 403);
    assert.equal((await api('executions/' + activity.activityId + '/' + executionId + '/dispatch', {}, remote)).status, 403);
    assert.equal((await api(`releases/${releaseId}/components/table/algorithm`, undefined, remote)).value.contentBase64,
      published.algorithmBase64);
    assert.equal((await api(`releases/${releaseId}/components/table/algorithm/extra`, undefined, remote)).status, 403);
    assert.deepEqual((await api(`releases/${releaseId}/components/annotation/dependencies/mark-js`, undefined, remote)).value, dependencyContent);
    assert.equal((await api(`releases/${releaseId}/components/annotation/dependencies/broken`, undefined, remote)).status, 503);
    assert.deepEqual((await api(`releases/${releaseId}/components/annotation/preparation-reports`, undefined, remote)).value, [report]);
    assert.deepEqual((await api(`releases/${releaseId}/components/annotation/preparation-report`, { reportId: reportReceipt.reportId, report }, remote)).value, reportReceipt);
    assert.equal((await api('manage/course-import', { requestId: randomUUID() }, remote)).status, 403);
  } finally {
    await host?.stop();
    school.closeAllConnections();
    await new Promise(resolve => school.close(resolve));
  }
});
