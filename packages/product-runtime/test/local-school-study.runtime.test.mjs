import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, resolveCredential, restoreProductRecovery } from '@xunjie/product-runtime';
import { openStorage, createFileBackend } from '@xunjie/storage';
import { learningMigrations, validateLearningData } from '@xunjie/learning-space';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

test('school delivery leaves drafts, Agent inputs and unfinished works on the device, including offline and rebind', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-local-school-study-'));
  const schoolRoot = join(directory, 'school'), deviceRoot = join(directory, 'device');
  const school = openProductRuntime({ root: schoolRoot, resources }), device = openProductRuntime({ root: deviceRoot, resources });
  let generations = 0, ledger;
  const provider = createServer(async (request, response) => {
    for await (const _ of request) { /* Synthetic local provider, no student input logs. */ }
    generations++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '仅保留在本机的回答' }, finish_reason: 'stop' }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const request = async (endpoint, route, body, headers = {}, expected = 200) => {
    const response = await fetch(endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, expected, route + ': ' + JSON.stringify(value));
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    await school.install({ profile: 'school', deployment: { formatVersion: 1, modules: ['space-course', 'learning-data'], dependencies: {} } });
    await device.install({ profile: 'local', deployment: { formatVersion: 1,
      modules: ['space-course', 'learning-data', 'teaching-agent', 'model-connection', 'tool-execution'], dependencies: {} } });
    const schoolState = await school.start(), deviceState = await device.start();
    const schoolApi = (route, body, headers, expected) => request(schoolState.endpoint, route, body, headers, expected);
    const deviceApi = (route, body, headers, expected) => request(deviceState.endpoint, route, body, headers, expected);
    const admin = { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') };
    const loginName = 'local-study-' + randomUUID(), password = randomUUID();
    const identity = (await schoolApi('manage/members', { requestId: randomUUID(), loginName, password }, admin)).value;
    const login = await schoolApi('login', { loginName, password }), member = { cookie: login.cookie, 'x-xj-space': 'school' };
    const otherName = 'other-' + randomUUID(), otherPassword = randomUUID();
    const secondIdentity = (await schoolApi('manage/members', { requestId: randomUUID(), loginName: otherName, password: otherPassword }, admin)).value;
    const otherLogin = await schoolApi('login', { loginName: otherName, password: otherPassword });
    const otherMember = { cookie: otherLogin.cookie, 'x-xj-space': 'school' };
    const otherActivity = (await schoolApi('activities', { requestId: randomUUID(), goal: '另一成员的活动', question: '', references: [] }, otherMember)).value;
    const otherDraft = (await schoolApi('drafts/' + otherActivity.activityId, undefined, otherMember)).value;
    await schoolApi('drafts/' + otherActivity.activityId, { requestId: randomUUID(), draftId: otherDraft.draftId, baseRevision: 0,
      question: '另一成员的草稿必须保持原样', references: [], bases: [] }, otherMember);
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    await schoolApi('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '本地学习课程' },
      task: { taskId, title: '本地编辑，明确提交', summary: '' }, release: { releaseId, objectives: ['保持学习过程在本机'],
        requirements: '提交最终作品。', materials: [], starterWorks: [], capabilities: [],
        helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } }, resources: [] }, admin);
    await schoolApi('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: true }, admin);
    const original = (await schoolApi('course-activities', { requestId: randomUUID(), releaseId }, member)).value;
    const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'solution.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '\ufeff原学校过程作品\r\n中文🙂' };
    await schoolApi('workspaces/' + original.activityId, { requestId: randomUUID(), baseRevision: 0, files: [file] }, member);
    const oldDraft = (await schoolApi('drafts/' + original.activityId, undefined, member)).value;
    await schoolApi('drafts/' + original.activityId, { requestId: randomUUID(), draftId: oldDraft.draftId, baseRevision: 0,
      question: '原学校未发送草稿', references: [], bases: [] }, member);
    const connectionId = randomUUID();
    await deviceApi('client/start', { requestId: connectionId, schoolEndpoint: schoolState.endpoint });
    await schoolApi('connections/approve', { requestId: connectionId }, member);
    await deviceApi('client/complete', { requestId: connectionId });
    let connected = { 'x-xj-space': 'school:' + connectionId };
    assert.equal((await deviceApi('context')).value.account.accountName, loginName);
    const activities = (await deviceApi('activities', undefined, connected)).value;
    const copied = activities.find(activity => activity.activityId === original.activityId);
    assert.ok(copied);
    assert.equal(activities.some(activity => activity.activityId === otherActivity.activityId), false);
    assert.equal(copied.identity.principalId, identity.principalId);
    assert.notEqual(copied.target.environmentId, original.target.environmentId);
    assert.deepEqual((await deviceApi('workspaces/' + copied.activityId, undefined, connected)).value.files, [file]);
    assert.equal((await deviceApi('drafts/' + copied.activityId, undefined, connected)).value.question, '原学校未发送草稿');
    const data = schoolState.environment.services.find(item => item.unit === 'learning-data');
    const binding = JSON.parse(await resolveCredential(schoolRoot, 'storage-' + data.serviceId));
    ledger = await openStorage({ binding, migrations: learningMigrations,
      backend: createFileBackend({ id: 'learning-data', root: join(schoolRoot, 'learning-resources', 'learning-data') }) });
    assert.equal((await ledger.read('SELECT * FROM question_drafts WHERE principal_id=$1', [identity.principalId])).rows.length, 0);
    assert.equal((await schoolApi('drafts/' + otherActivity.activityId, undefined, otherMember)).value.question, '另一成员的草稿必须保持原样');
    assert.equal((await ledger.read('SELECT * FROM work_heads')).rows.length, 0);
    assert.equal((await ledger.read('SELECT * FROM action_intents')).rows.length, 0);
    await schoolApi('drafts/' + copied.activityId, undefined, member, 403);
    const current = { ...file, contentId: randomUUID(), value: '仍未提交的本机作品' };
    await deviceApi('workspaces/' + copied.activityId, { requestId: randomUUID(), baseRevision: 1, files: [current] }, connected);
    const draft = (await deviceApi('drafts/' + copied.activityId, undefined, connected)).value;
    await deviceApi('drafts/' + copied.activityId, { requestId: randomUUID(), draftId: draft.draftId, baseRevision: draft.revision,
      question: '绝不上传学校的提问正文', references: [], bases: [] }, connected);
    const modelId = randomUUID();
    await deviceApi('models/connections', { requestId: randomUUID(), connectionId: modelId, expectedVersion: 0, name: '本机测试模型',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${provider.address().port}`, path: '/chat/completions',
      modelId: 'device-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144,
      maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-device-key' } }, { 'x-xj-space': 'personal' });
    await deviceApi('models/selection', { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId: modelId, owner: 'device' } }, connected);
    const caps = (await deviceApi(`agent/${copied.activityId}/capabilities`, undefined, connected)).value;
    const question = randomUUID(), scope = { environmentId: identity.environmentId, spaceId: identity.spaceId,
      principalId: identity.principalId, activityId: copied.activityId };
    await deviceApi(`intents/${copied.activityId}`, { requestId: question, receiver: caps.receiver, scope,
      draft: { token: randomUUID(), question: '绝不上传学校的提问正文', references: [], bases: [] }, works: [current], evidence: [] }, connected);
    await deviceApi(`intents/${copied.activityId}/${question}/dispatch`, {}, connected);
    let conversation;
    for (let attempt = 0; attempt < 300; attempt++) {
      conversation = (await deviceApi(`agent/${copied.activityId}/conversation`, undefined, connected)).value;
      if (conversation.runs.some(run => ['completed', 'failed', 'paused'].includes(run.state))) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(conversation.runs[0]?.state, 'completed', JSON.stringify(conversation));
    assert.equal(generations, 1);
    assert.equal((await ledger.read('SELECT * FROM action_intents')).rows.length, 0);
    assert.equal((await ledger.read('SELECT * FROM question_drafts WHERE principal_id=$1', [identity.principalId])).rows.length, 0);
    const submission = { requestId: randomUUID(), works: [current], artifacts: [], evidence: [] };
    const received = (await deviceApi(`submissions/${copied.activityId}`, submission, connected)).value;
    assert.equal(received.state, 'accepted');
    assert.deepEqual((await deviceApi(`submissions/${copied.activityId}`, submission, connected)).value, received);
    const fixed = (await deviceApi(`submissions/${copied.activityId}/${received.submissionId}`, undefined, connected)).value;
    assert.deepEqual(fixed.works, [current]);
    assert.equal((await ledger.read('SELECT * FROM school_submissions')).rows.length, 1);
    const later = { ...current, contentId: randomUUID(), value: '提交后仍在本机继续编辑' };
    await school.stop();
    await deviceApi('workspaces/' + copied.activityId, { requestId: randomUUID(), baseRevision: 2, files: [later] }, connected);
    await device.stop(); await device.start();
    assert.equal((await deviceApi('context')).value.account.accountName, loginName);
    assert.equal((await deviceApi(`agent/${copied.activityId}/conversation`, undefined, connected)).value.messages.at(-1).text, '仅保留在本机的回答');
    const offlineQuestion = randomUUID();
    await deviceApi(`intents/${copied.activityId}`, { requestId: offlineQuestion, receiver: caps.receiver, scope,
      draft: { token: randomUUID(), question: '学校断连后继续本机学习', references: [], bases: [] }, works: [later], evidence: [] }, connected);
    await deviceApi(`intents/${copied.activityId}/${offlineQuestion}/dispatch`, {}, connected);
    for (let attempt = 0; attempt < 300; attempt++) {
      conversation = (await deviceApi(`agent/${copied.activityId}/conversation`, undefined, connected)).value;
      if (conversation.runs.some(run => run.requestId === offlineQuestion && ['completed', 'failed', 'paused'].includes(run.state))) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(conversation.runs.find(run => run.requestId === offlineQuestion)?.state, 'completed', JSON.stringify(conversation));
    assert.equal(generations, 2);
    const deferred = { requestId: randomUUID(), works: [later], artifacts: [], evidence: [] };
    await deviceApi(`submissions/${copied.activityId}`, deferred, connected, 503);
    await school.start();
    const delivered = (await deviceApi(`submissions/${copied.activityId}`, deferred, connected)).value;
    assert.notEqual(delivered.submissionId, received.submissionId);
    assert.deepEqual((await deviceApi(`submissions/${copied.activityId}/${received.submissionId}`, undefined, connected)).value.works, [current]);
    await deviceApi('connections/revoke', { connectionId }, connected);
    assert.equal((await deviceApi('context')).value.account, null);
    await deviceApi(`workspaces/${copied.activityId}`, undefined, connected, 403);
    const rebound = randomUUID();
    await deviceApi('client/start', { requestId: rebound, schoolEndpoint: schoolState.endpoint });
    await schoolApi('connections/approve', { requestId: rebound }, member);
    await deviceApi('client/complete', { requestId: rebound });
    connected = { 'x-xj-space': 'school:' + rebound };
    assert.deepEqual((await deviceApi(`workspaces/${copied.activityId}`, undefined, connected)).value.files, [later]);
    assert.equal((await deviceApi('context')).value.account.accountName, loginName);
    assert.equal(generations, 2, 'Migration, recovery, submission and rebind must not generate again');
    assert.ok(secondIdentity.principalId !== identity.principalId);
    // Exercise the real encrypted backup/restore boundary, including the new copy manifest,
    // original WorkFile bytes, submission resources and their receipt identities.
    for (const [name, runtime, state, originalFile] of [['device', device, deviceState, later], ['school', school, schoolState, current]]) {
      const key = randomBytes(32), backupRoot = join(directory, name + '-backups'), restoredRoot = join(directory, name + '-restored');
      await runtime.setCredential('local-study-recovery', key.toString('base64'));
      const backup = await runtime.recovery.backup({ directory: backupRoot, recoveryKeyRef: 'local-study-recovery', leaveClosed: false });
      let restored, storage;
      try {
        restored = await restoreProductRecovery({ root: restoredRoot, resources, key,
          backupDirectory: join(backupRoot, backup.backupId) });
        const owner = state.environment.services.find(service => service.unit === 'learning-data');
        storage = await openStorage({ binding: JSON.parse(await resolveCredential(restoredRoot, 'storage-' + owner.serviceId)),
          migrations: learningMigrations, backend: createFileBackend({ id: 'learning-data', root: join(restoredRoot, 'learning-resources/learning-data') }) });
        await validateLearningData(storage);
        if (name === 'device') {
          assert.equal((await storage.read('SELECT * FROM study_copy_imports')).rows.length, 1);
          assert.equal(Buffer.from(await storage.readResource(originalFile.contentId)).toString('utf8'), originalFile.value);
          const retained = (await storage.read('SELECT value FROM study_copy_cache WHERE cache_key=$1',
            [`outbox/submission/${copied.activityId}/${deferred.requestId}`])).rows[0]?.value;
          assert.equal(retained.receipt.submissionId, delivered.submissionId);
        } else {
          const retained = (await storage.read('SELECT body FROM school_submissions WHERE request_id=$1', [submission.requestId])).rows[0]?.body;
          assert.deepEqual(retained.works, [originalFile]);
          assert.equal(retained.submissionId, received.submissionId);
          assert.equal((await storage.read('SELECT * FROM action_intents')).rows.length, 0);
        }
      } finally {
        await storage?.close();
        for (const owner of restored?.owners ?? []) await owner.close?.();
        await openProductRuntime({ root: restoredRoot }).stop().catch(() => {});
      }
    }
  } finally {
    if (ledger) await ledger.close();
    await Promise.allSettled([device.stop(), school.stop()]);
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
