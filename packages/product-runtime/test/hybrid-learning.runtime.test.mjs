import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, resolveCredential, restoreProductRecovery, createOutboundConnection } from '@xunjie/product-runtime';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };

async function exercisePairedDevice(profile) {
  const root = await mkdtemp(join(tmpdir(), 'xj-hybrid-'));
  const schoolRoot = join(root, 'school'), deviceRoot = join(root, 'device');
  const school = openProductRuntime({ root: schoolRoot, resources });
  const device = openProductRuntime({ root: deviceRoot, resources });
  const requests = [];
  let streamClosed = false;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 3) {
      response.once('close', () => { streamClosed = true; });
      response.write('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
      return;
    }
    const first = requests.length === 1, sensitive = requests.length === 4;
    const encodedKey = [...'synthetic-device-chat'].map(character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    const delta = sensitive ? { tool_calls: [{ index: 0, id: 'paired-sensitive', type: 'function', function: { name: 'read_marker', arguments: '{"nonce":"' + encodedKey + '"}' } }] }
      : first ? { tool_calls: [{ index: 0, id: 'paired-marker', type: 'function', function: { name: 'read_marker', arguments: '{}' } }] }
      : { content: 'paired OK' };
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first || sensitive ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await school.install({ profile: 'local' }); await device.install({ profile });
    const schoolStatus = await school.start(), deviceStatus = await device.start();
    const call = (endpoint, path, body, headers = {}) => fetch(new URL('/api/learning/' + path, endpoint), {
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const api = async (endpoint, path, body, headers) => {
      const response = await call(endpoint, path, body, headers);
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    const targetService = deviceStatus.environment.services.find(s => s.unit === (profile === 'model' ? 'model-connection' : 'learning-data'));
    const target = { environmentId: targetService.environmentId, serviceId: targetService.serviceId, version: 1 };
    const password = randomUUID(), loginName = 'hybrid-' + randomUUID();
    const admin = { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') };
    const member = await api(schoolStatus.endpoint, 'manage/members', { requestId: randomUUID(), loginName, password, target }, admin);
    const login = await call(schoolStatus.endpoint, 'login', { loginName, password });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const requestId = randomUUID();
    await api(deviceStatus.endpoint, 'client/start', { requestId, schoolEndpoint: schoolStatus.endpoint });
    await api(schoolStatus.endpoint, 'connections/approve', { requestId }, { cookie });
    await api(deviceStatus.endpoint, 'client/complete', { requestId });
    const runtimeGrant = await school.authorize({ sourceEnvironmentId: target.environmentId,
      sourceServiceId: target.serviceId, sourceInstallationId: deviceStatus.environment.installationId,
      capabilities: ['learning.authority'] });
    const runtimeConnectionId = randomUUID();
    await device.connect({ connectionId: runtimeConnectionId, sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId,
      target: (await school.status()).environment.services[0], requiredCapabilities: ['learning.authority'],
      optionalCapabilities: [], credentialRef: 'hybrid-school-runtime' }, runtimeGrant.token);
    const deviceAdmin = { authorization: 'Bearer ' + await resolveCredential(deviceRoot, 'control') };
    const optionalConnectionId = randomUUID();
    await device.connect({ connectionId: optionalConnectionId, sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId,
      target: schoolStatus.environment.services[0], requiredCapabilities: [], optionalCapabilities: ['learning.authority'],
      credentialRef: 'optional-school-transport' }, runtimeGrant.token);
    assert.equal((await call(deviceStatus.endpoint, 'manage/local-binding', { connectionId: requestId,
      runtimeConnectionId: optionalConnectionId, target }, deviceAdmin)).status, 403, 'required authority must not be downgraded to optional readiness');
    await api(deviceStatus.endpoint, 'manage/local-binding', { connectionId: requestId, runtimeConnectionId, target }, deviceAdmin);
    const binding = { grantId: runtimeGrant.grantId, installationId: deviceStatus.environment.installationId };
    const modelTask = { taskId: randomUUID(), attemptId: randomUUID(), operation: 'read' };
    const enqueue = { operation: 'enqueue', identity: member, binding, task: modelTask };
    assert.deepEqual(await school.modelTask(enqueue), modelTask);
    assert.deepEqual(await school.modelTask(enqueue), modelTask);
    const query = { operation: 'read', identity: member, binding, taskId: modelTask.taskId };
    const deadline = Date.now() + 30_000;
    let receipt;
    do {
      receipt = (await school.modelTask(query)).receipt;
      if (!receipt) await new Promise(resolve => setTimeout(resolve, 250));
    } while (!receipt && Date.now() < deadline);
    assert.deepEqual(receipt, { ok: false, code: 'missing' });
    assert.deepEqual((await school.modelTask(query)).receipt, receipt);
    await assert.rejects(school.modelTask({ ...query, binding: { ...binding, installationId: randomUUID() } }));
    const selected = { 'x-xj-space': 'school:' + requestId };
    const connectionId = randomUUID(), grantId = randomUUID(), segmentId = randomUUID(), imageId = randomUUID();
    await api(deviceStatus.endpoint, 'models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: 'Paired Chat', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      path: '/chat/completions', modelId: 'paired-chat', dialect: 'standard', parameterMode: 'plain', enabled: true,
      credential: { action: 'replace', value: 'synthetic-device-chat' } }, { 'x-xj-space': 'personal' });
    await api(deviceStatus.endpoint, 'models/grants', { requestId: randomUUID(), connectionId, grantId, owner: 'device' }, selected);
    await api(deviceStatus.endpoint, 'models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId, grantId } }, selected);
    await api(deviceStatus.endpoint, 'models/images', { requestId: randomUUID(), imageId, mediaType: 'image/png',
      dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=' }, selected);
    await api(deviceStatus.endpoint, 'models/segments', { requestId: randomUUID(), segmentId,
      source: { selected: true, selectionVersion: 1 }, prefix: { system: 'Paired Chat', options: { capabilityProbe: true }, tools: [
        { name: 'read_marker', description: '', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ] }, portable: [] }, selected);
    let attemptId = randomUUID();
    async function submit(operation, input) {
      const taskId = randomUUID();
      await school.modelTask({ ...enqueue, task: { taskId, attemptId, operation, ...(input ? { input } : {}) } });
      const limit = Date.now() + 35_000;
      do {
        const fact = (await school.modelTask({ ...query, taskId })).receipt;
        if (fact) { assert.equal(fact.ok, true, JSON.stringify(fact)); return fact.value; }
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < limit);
      assert.fail(`Missing paired ${operation} receipt`);
    }
    assert.equal((await submit('receive', { attemptId, purpose: 'chat-probe', segmentId, expectedSequence: 0,
      input: { text: 'Inspect the fixed image', images: [{ imageId, version: 1 }], toolResults: [] },
      limits: { maxOutputTokens: 64, timeoutMs: 15000 } })).state, 'accepted');
    await submit('dispatch');
    const toolCall = await submit('read');
    assert.equal(toolCall.state, 'completed');
    assert.deepEqual(toolCall.toolIntents, [{ callId: 'paired-marker', name: 'read_marker', arguments: {} }]);
    attemptId = randomUUID();
    assert.equal((await submit('receive', { attemptId, purpose: 'chat-probe', segmentId, expectedSequence: 1,
      input: { text: 'Use the marker', images: [], toolResults: [{ callId: 'paired-marker', outcome: 'success', text: 'fixed marker', images: [] }] },
      limits: { maxOutputTokens: 64, timeoutMs: 15000 } })).state, 'accepted');
    await submit('dispatch');
    const generated = await submit('read');
    assert.equal(generated.state, 'completed');
    assert.equal(generated.text, 'paired OK');
    assert.ok(generated.resultRef);
    assert.equal((await submit('cancel')).resultRef, generated.resultRef);
    assert.equal(requests.length, 2);
    assert.ok(JSON.stringify(requests[0]).includes('data:image/png;base64,'));
    assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.tool_call_id === 'paired-marker'));
    attemptId = randomUUID();
    await submit('receive', { attemptId, purpose: 'chat-probe', segmentId, expectedSequence: 2,
      input: { text: 'Hold this stream', images: [], toolResults: [] }, limits: { maxOutputTokens: 64, timeoutMs: 30000 } });
    await submit('dispatch');
    const streamingDeadline = Date.now() + 5000;
    while (requests.length < 3 && Date.now() < streamingDeadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(requests.length, 3);
    assert.equal(streamClosed, false);
    assert.equal((await submit('cancel')).cancelRequested, true);
    const cancelled = await submit('read');
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.reason, 'client-abort');
    assert.equal(cancelled.physicalRequestEnded, true);
    assert.equal(cancelled.upstreamStopped, 'unknown');
    assert.equal(streamClosed, true);
    assert.equal((await submit('dispatch')).state, 'cancelled');
    assert.equal(requests.length, 3);
    const sensitiveSegmentId = randomUUID();
    await api(deviceStatus.endpoint, 'models/segments', { requestId: randomUUID(), segmentId: sensitiveSegmentId,
      source: { selected: true, selectionVersion: 1 }, prefix: { system: 'Credential boundary over authenticated device tasks', tools: [
        { name: 'read_marker', description: '', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } },
      ] }, portable: [] }, selected);
    attemptId = randomUUID();
    await submit('receive', { attemptId, purpose: 'chat-probe', segmentId: sensitiveSegmentId, expectedSequence: 0,
      input: { text: 'Synthetic escaped credential fixture', images: [], toolResults: [] }, limits: { maxOutputTokens: 64, timeoutMs: 15000 } });
    await submit('dispatch');
    const sensitiveResult = await submit('read');
    assert.equal(sensitiveResult.state, 'failed'); assert.equal(sensitiveResult.reason, 'credential-in-tool-output');
    assert.deepEqual(sensitiveResult.toolIntents, []); assert.equal(JSON.stringify(sensitiveResult).includes('synthetic-device-chat'), false);
    const modelOwner = deviceStatus.environment.services.find(service => service.unit === 'model-connection');
    const storedBytes = await readFile(join(deviceRoot, 'learning-resources/model-connection', deviceStatus.environment.environmentId, modelOwner.serviceId, sensitiveResult.resultRef));
    const storedNative = JSON.parse(storedBytes.subarray(storedBytes.indexOf(10) + 1).toString());
    assert.equal(storedNative.redacted, true); assert.deepEqual(storedNative.chunks, []);
    await device.stop(); await device.start();
    assert.equal((await submit('read')).resultRef, sensitiveResult.resultRef);
    assert.equal((await submit('dispatch')).state, 'failed'); assert.equal(requests.length, 4);
    if (profile === 'model') {
      assert.equal(deviceStatus.environment.services.some(service => service.unit === 'learning-data'), false);
      assert.equal((await call(deviceStatus.endpoint, 'activities', undefined, selected)).status, 503);
      return;
    }
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID();
    const materialText = '# 混合部署课程\n' + 'x'.repeat(1_100_000) + '\r\n选中😀尾部\r\n';
    const material = Buffer.from(materialText);
    const manifest = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '混合部署课程' },
      task: { taskId, title: '学校身份，本机作品', summary: '' },
      release: { releaseId, objectives: ['保持原版本'], requirements: '保存中文作品', materials: [{ materialId, title: '原材料',
        path: 'original.md', mediaType: 'text/markdown', access: 'student', sha256: createHash('sha256').update(material).digest('hex'), byteLength: material.length }],
      starterWorks: [], capabilities: [] }, resources: [{ path: 'original.md', contentBase64: material.toString('base64') }] };
    await api(schoolStatus.endpoint, 'manage/course-import', manifest, admin);
    await api(schoolStatus.endpoint, 'manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);
    assert.equal((await api(deviceStatus.endpoint, 'courses', undefined, selected)).courses[0].courseId, courseId);
    const courseRequest = { requestId: randomUUID(), releaseId };
    const activity = await api(deviceStatus.endpoint, 'course-activities', courseRequest, selected);
    assert.deepEqual(activity.identity, member); assert.deepEqual(activity.target, target);
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: '混合.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: '学校身份的中文作品\n' };
    const sync = { requestId: randomUUID(), baseRevision: 0, files: [file] };
    assert.deepEqual(await api(deviceStatus.endpoint, 'workspaces/' + activity.activityId, sync, selected), { revision: 1, files: [file] });
    const draftPath = 'drafts/' + activity.activityId;
    const draftHead = await api(deviceStatus.endpoint, draftPath, undefined, selected);
    const draftInput = { requestId: randomUUID(), draftId: draftHead.draftId, baseRevision: 0,
      question: 'Keep school sources with local learning data', bases: [], references: [
        { referenceId: randomUUID(), source: { kind: 'work', objectId: file.objectId, contentId: file.contentId },
          range: { kind: 'text', start: 0, end: file.value.length }, copy: file.value, sourceName: file.name },
        { referenceId: randomUUID(), source: { kind: 'course-field', courseId, taskId, releaseId,
          contentDigest: activity.course.contentDigest, field: 'requirements' },
          range: { kind: 'text', start: 0, end: manifest.release.requirements.length },
          copy: manifest.release.requirements, sourceName: 'Task requirements' },
        { referenceId: randomUUID(), source: { kind: 'course-material', courseId, taskId, releaseId,
          contentDigest: activity.course.contentDigest, materialId, mediaType: 'text/markdown',
          materialSha256: createHash('sha256').update(material).digest('hex') },
          range: { kind: 'text', start: materialText.indexOf('选中'), end: materialText.indexOf('选中') + '选中😀'.length },
          copy: '选中😀', sourceName: 'Large school material' },
      ] };
    const savedDraft = await api(deviceStatus.endpoint, draftPath, draftInput, selected);
    assert.equal(savedDraft.references.length, 3);
    const actionPath = 'intents/' + activity.activityId;
    const actionInput = { requestId: randomUUID(), scope: { environmentId: member.environmentId, spaceId: member.spaceId,
      principalId: member.principalId, activityId: activity.activityId },
      receiver: { receiverId: 'future-agent', location: 'remote', kind: 'question' },
      draft: { token: randomUUID(), question: draftInput.question, references: draftInput.references, bases: [] }, works: [file], evidence: [] };
    const preparedAction = await api(deviceStatus.endpoint, actionPath, actionInput, selected);
    assert.equal(preparedAction.state, 'prepared');
    assert.equal((await call(schoolStatus.endpoint, actionPath, undefined, { cookie })).status, 403);
    assert.equal((await call(deviceStatus.endpoint, actionPath + '/' + actionInput.requestId, undefined,
      { ...selected, 'x-xj-expected-subject': randomUUID() })).status, 403);
    const changedCopy = structuredClone(draftInput);
    changedCopy.requestId = randomUUID(); changedCopy.baseRevision = 1;
    changedCopy.references[2].copy = '伪造副本';
    assert.equal((await call(deviceStatus.endpoint, draftPath, changedCopy, selected)).status, 400);
    const splitEmoji = structuredClone(draftInput);
    splitEmoji.requestId = randomUUID(); splitEmoji.baseRevision = 1;
    splitEmoji.references[2].range.end--;
    splitEmoji.references[2].copy = splitEmoji.references[2].copy.slice(0, -1);
    assert.equal((await call(deviceStatus.endpoint, draftPath, splitEmoji, selected)).status, 400);
    const splitNewline = structuredClone(draftInput);
    splitNewline.requestId = randomUUID(); splitNewline.baseRevision = 1;
    splitNewline.references[2].range.start--;
    splitNewline.references[2].copy = '\n' + splitNewline.references[2].copy;
    assert.equal((await call(deviceStatus.endpoint, draftPath, splitNewline, selected)).status, 400);
    assert.deepEqual(await api(deviceStatus.endpoint, draftPath + '/receipts/' + draftInput.requestId, undefined, selected), savedDraft);
    assert.equal((await call(schoolStatus.endpoint, draftPath, undefined, { cookie })).status, 403);
    assert.equal((await call(deviceStatus.endpoint, 'workspaces/' + activity.activityId, undefined,
      { ...selected, 'x-xj-expected-subject': randomUUID() })).status, 403, 'old subject requests must not dispatch using a new connection identity');
    assert.equal((await call(schoolStatus.endpoint, 'activities/' + activity.activityId, undefined, { cookie })).status, 403,
      'the school cannot silently create a second authority for a locally bound member');
    assert.deepEqual(await api(deviceStatus.endpoint, 'activities/' + activity.activityId, undefined, selected), activity);
    assert.equal((await api(deviceStatus.endpoint, 'course-activity-results/' + courseRequest.requestId, undefined, selected)).state, 'accepted');
    const changed = structuredClone(manifest); changed.requestId = randomUUID(); changed.release.releaseId = randomUUID(); changed.release.requirements = '新版本';
    await api(schoolStatus.endpoint, 'manage/course-import', changed, admin);
    assert.equal((await api(deviceStatus.endpoint, 'activities/' + activity.activityId, undefined, selected)).course.releaseId, releaseId);
    await device.stop(); await device.start();
    assert.deepEqual(await api(deviceStatus.endpoint, 'workspaces/' + activity.activityId, undefined, selected), { revision: 1, files: [file] });
    assert.deepEqual(await api(deviceStatus.endpoint, draftPath, undefined, selected), savedDraft);
    await school.stop();
    assert.equal((await call(deviceStatus.endpoint, 'workspaces/' + activity.activityId, sync, selected)).status, 503);
    assert.equal((await call(deviceStatus.endpoint, draftPath, undefined, selected)).status, 503);
    await school.start();
    assert.deepEqual((await school.modelTask(query)).receipt, receipt);
    assert.deepEqual(await api(deviceStatus.endpoint, 'workspaces/' + activity.activityId + '/receipts/' + sync.requestId, undefined, selected), { revision: 1, files: [file] });
    await api(schoolStatus.endpoint, 'manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: false }, admin);
    assert.equal((await call(deviceStatus.endpoint, 'workspaces/' + activity.activityId, sync, selected)).status, 403);
    assert.equal((await call(deviceStatus.endpoint, draftPath, draftInput, selected)).status, 403);
    assert.equal((await call(deviceStatus.endpoint, actionPath + '/' + actionInput.requestId, undefined, selected)).status, 403);
    await api(schoolStatus.endpoint, 'manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);
    const key = randomBytes(32), directory = join(root, 'backups');
    await device.setCredential('hybrid-recovery-key', key.toString('base64'));
    const backup = await device.recovery.backup({ directory, recoveryKeyRef: 'hybrid-recovery-key', leaveClosed: true });
    assert.deepEqual(backup.services.map(service => service.serviceId).sort(),
      deviceStatus.environment.services.map(service => service.serviceId).sort());
    const receiver = { id: schoolStatus.environment.environmentId + '/' + schoolStatus.environment.services[0].serviceId, root: schoolRoot };
    assert.deepEqual(backup.receiverIds, [receiver.id]);
    const restoredRoot = join(root, 'restored');
    const targetRuntime = openProductRuntime({ root: restoredRoot, resources });
    try {
      const restored = await restoreProductRecovery({ root: restoredRoot, resources, backupDirectory: join(directory, backup.backupId), key });
      for (const owner of restored.owners) await owner.close?.();
      const isolated = await targetRuntime.start();
      assert.equal(isolated.state, 'maintenance');
      await assert.rejects(targetRuntime.recovery.takeover({ sourceRoot: deviceRoot, receivers: [] }), /missing-receiver/);
      await targetRuntime.recovery.takeover({ sourceRoot: deviceRoot, receivers: [receiver] });
      assert.equal((await call(deviceStatus.endpoint, 'workspaces/' + activity.activityId, undefined, selected)).status, 503);
      assert.notEqual(isolated.environment.clientNamespace, deviceStatus.environment.clientNamespace);
      const connection = { connectionId: randomUUID(), sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId,
        target: schoolStatus.environment.services[0], requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'old-source' };
      await assert.rejects(createOutboundConnection({ connection, credential: async () => runtimeGrant.token, allowInsecureLoopback: true }).request('learning.authority', {}), /http_401/);
      const renewed = await school.authorize({ sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId,
        sourceInstallationId: isolated.environment.installationId, capabilities: ['learning.authority'] });
      // The grants of the retired installation are void, so the takeover drops the runtime connection
      // that carried them. The successor re-authorizes for its own installation and registers the
      // connection again; readiness must not keep a dependency that can never recover.
      const restoredRuntimeConnectionId = randomUUID();
      await targetRuntime.connect({ connectionId: restoredRuntimeConnectionId, sourceEnvironmentId: target.environmentId,
        sourceServiceId: target.serviceId, target: schoolStatus.environment.services[0],
        requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'hybrid-school-runtime' }, renewed.token);
      const reconnect = randomUUID();
      // A recovered installation only accepts member writes that carry the current handshake's
      // namespace, so the pairing that opens this space must send it like the browser does.
      const namespace = { 'x-xj-namespace': isolated.environment.clientNamespace };
      await assert.rejects(api(isolated.endpoint, 'client/start', { requestId: reconnect, schoolEndpoint: schoolStatus.endpoint }),
        /forbidden/, 'a recovered installation must not accept a pairing without the current namespace');
      await api(isolated.endpoint, 'client/start', { requestId: reconnect, schoolEndpoint: schoolStatus.endpoint }, namespace);
      await api(schoolStatus.endpoint, 'connections/approve', { requestId: reconnect }, { cookie });
      await api(isolated.endpoint, 'client/complete', { requestId: reconnect }, namespace);
      const restoredAdmin = { authorization: 'Bearer ' + await resolveCredential(restoredRoot, 'control') };
      await api(isolated.endpoint, 'manage/local-binding', { connectionId: reconnect, runtimeConnectionId: restoredRuntimeConnectionId, target }, restoredAdmin);
      const restoredSpace = { 'x-xj-space': 'school:' + reconnect };
      assert.deepEqual(await api(isolated.endpoint, 'activities/' + activity.activityId, undefined, restoredSpace), activity);
      assert.deepEqual(await api(isolated.endpoint, draftPath, undefined, restoredSpace), savedDraft);
      assert.deepEqual(await api(isolated.endpoint, draftPath + '/revisions/' + savedDraft.revisionId, undefined, restoredSpace), savedDraft);
      assert.deepEqual(await api(isolated.endpoint, draftPath + '/receipts/' + draftInput.requestId, undefined, restoredSpace), savedDraft);
      assert.deepEqual(await api(isolated.endpoint, actionPath + '/' + actionInput.requestId, undefined, restoredSpace), preparedAction);
      assert.equal((await call(isolated.endpoint, actionPath + '/' + actionInput.requestId + '/dispatch', {},
        { ...restoredSpace, 'x-xj-namespace': deviceStatus.environment.clientNamespace })).status, 403);
      assert.equal((await call(isolated.endpoint, draftPath, undefined,
        { ...restoredSpace, 'x-xj-namespace': deviceStatus.environment.clientNamespace })).status, 403);
      assert.deepEqual(await api(isolated.endpoint, 'workspaces/' + activity.activityId, undefined, restoredSpace), { revision: 1, files: [file] });
      assert.deepEqual(await api(isolated.endpoint, 'workspaces/' + activity.activityId + '/receipts/' + sync.requestId, undefined, restoredSpace), { revision: 1, files: [file] });
      assert.equal((await call(isolated.endpoint, 'workspaces/' + activity.activityId, sync,
        { ...restoredSpace, 'x-xj-namespace': deviceStatus.environment.clientNamespace })).status, 403);
      await api(schoolStatus.endpoint, 'manage/connection', { connectionId: reconnect }, admin);
      assert.equal((await call(isolated.endpoint, 'workspaces/' + activity.activityId, undefined, restoredSpace)).status, 403);
    } finally { await targetRuntime.stop().catch(() => {}); }
  } finally {
    await device.stop().catch(() => {});
    await school.stop().catch(() => {});
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
}

test('a managed school binding stores school activity works only in its installed client owner', { timeout: 480000 }, () => exercisePairedDevice('local'));
test('a paired independent model owner serves Chat and cancellation without a learning-data owner', { timeout: 360000 }, () => exercisePairedDevice('model'));
