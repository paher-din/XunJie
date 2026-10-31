import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential, restoreProductRecovery, createOutboundConnection } from '@xunjie/product-runtime';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };

test('a managed school binding stores school activity works only in its installed client owner', { timeout: 360000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-hybrid-'));
  const schoolRoot = join(root, 'school'), deviceRoot = join(root, 'device');
  const school = openProductRuntime({ root: schoolRoot, resources });
  const device = openProductRuntime({ root: deviceRoot, resources });
  try {
    await school.install({ profile: 'local' }); await device.install({ profile: 'local' });
    const schoolStatus = await school.start(), deviceStatus = await device.start();
    const call = (endpoint, path, body, headers = {}) => fetch(new URL('/api/learning/' + path, endpoint), {
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const api = async (endpoint, path, body, headers) => {
      const response = await call(endpoint, path, body, headers);
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    const targetService = deviceStatus.environment.services.find(s => s.unit === 'learning-data');
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
      sourceServiceId: target.serviceId, capabilities: ['learning.authority'] });
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
    const selected = { 'x-xj-space': 'school:' + requestId };
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
    assert.deepEqual(await api(deviceStatus.endpoint, 'workspaces/' + activity.activityId + '/receipts/' + sync.requestId, undefined, selected), { revision: 1, files: [file] });
    await api(schoolStatus.endpoint, 'manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: false }, admin);
    assert.equal((await call(deviceStatus.endpoint, 'workspaces/' + activity.activityId, sync, selected)).status, 403);
    assert.equal((await call(deviceStatus.endpoint, draftPath, draftInput, selected)).status, 403);
    await api(schoolStatus.endpoint, 'manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);
    const key = randomBytes(32), directory = join(root, 'backups');
    await device.setCredential('hybrid-recovery-key', key.toString('base64'));
    const backup = await device.recovery.backup({ directory, recoveryKeyRef: 'hybrid-recovery-key', leaveClosed: true });
    assert.equal(backup.services.length, 3);
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
      const renewed = await school.authorize({ sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId, capabilities: ['learning.authority'] });
      await targetRuntime.setCredential('hybrid-school-runtime', renewed.token);
      const reconnect = randomUUID();
      await api(isolated.endpoint, 'client/start', { requestId: reconnect, schoolEndpoint: schoolStatus.endpoint });
      await api(schoolStatus.endpoint, 'connections/approve', { requestId: reconnect }, { cookie });
      await api(isolated.endpoint, 'client/complete', { requestId: reconnect });
      const restoredAdmin = { authorization: 'Bearer ' + await resolveCredential(restoredRoot, 'control') };
      await api(isolated.endpoint, 'manage/local-binding', { connectionId: reconnect, runtimeConnectionId, target }, restoredAdmin);
      const restoredSpace = { 'x-xj-space': 'school:' + reconnect };
      assert.deepEqual(await api(isolated.endpoint, 'activities/' + activity.activityId, undefined, restoredSpace), activity);
      assert.deepEqual(await api(isolated.endpoint, draftPath, undefined, restoredSpace), savedDraft);
      assert.deepEqual(await api(isolated.endpoint, draftPath + '/revisions/' + savedDraft.revisionId, undefined, restoredSpace), savedDraft);
      assert.deepEqual(await api(isolated.endpoint, draftPath + '/receipts/' + draftInput.requestId, undefined, restoredSpace), savedDraft);
      assert.equal((await call(isolated.endpoint, draftPath, undefined,
        { ...restoredSpace, 'x-xj-namespace': deviceStatus.environment.clientNamespace })).status, 403);
      assert.deepEqual(await api(isolated.endpoint, 'workspaces/' + activity.activityId, undefined, restoredSpace), { revision: 1, files: [file] });
      assert.deepEqual(await api(isolated.endpoint, 'workspaces/' + activity.activityId + '/receipts/' + sync.requestId, undefined, restoredSpace), { revision: 1, files: [file] });
      assert.equal((await call(isolated.endpoint, 'workspaces/' + activity.activityId, sync,
        { ...restoredSpace, 'x-xj-namespace': deviceStatus.environment.clientNamespace })).status, 403);
      await api(schoolStatus.endpoint, 'manage/connection', { connectionId: reconnect }, admin);
      assert.equal((await call(isolated.endpoint, 'workspaces/' + activity.activityId, undefined, restoredSpace)).status, 403);
    } finally { await targetRuntime.stop().catch(() => {}); }
  } finally { await device.stop().catch(() => {}); await school.stop().catch(() => {}); }
});
