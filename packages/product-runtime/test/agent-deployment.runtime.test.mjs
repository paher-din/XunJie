import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { openProductRuntime, resolveCredential, createOutboundConnection } from '@xunjie/product-runtime';
import { createFileBackend, openStorage } from '@xunjie/storage';
import { learningMigrations, modelMigrations, createModelGateway } from '@xunjie/learning-space';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');

test('an independently installed Agent answers the original activity and survives an Agent restart', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-agent-deployment-'));
  const school = openProductRuntime({ root: join(directory, 'school'), resources });
  const agent = openProductRuntime({ root: join(directory, 'agent'), resources });
  const dependencyConnectionId = randomUUID(), agentConnectionId = randomUUID();
  const waitForStart = async promise => {
    let timer;
    try { await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The original model request did not start')), 30000);
    })]); } finally { clearTimeout(timer); }
  };
  const requests = [];
  let holdNext = false, heldResponseClosed = false, holding, releaseHeld;
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (holdNext) {
      holdNext = false;
      heldResponseClosed = false;
      response.once('close', () => { heldResponseClosed = true; });
      response.write('data: '+JSON.stringify({ choices: [{ index: 0, delta: { content: '' }, finish_reason: null }] })+'\n\n');
      holding();
      await new Promise(resolve => { releaseHeld = resolve; });
    }
    response.end('data: '+JSON.stringify({ choices: [{ index: 0, delta: { content: '原活动的独立服务回答' }, finish_reason: 'stop' }] })
      +'\n\ndata: '+JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await school.install({ profile: 'local' });
    const schoolState = await school.start();
    await agent.install({ profile: 'agent', agent: { dependencyConnectionId } });
    const agentState = await agent.start();
    const agentService = agentState.environment.services.find(service => service.unit === 'teaching-agent');
    assert.ok(agentService);
    assert.deepEqual(agentState.environment.services.map(service => service.unit).sort(), ['client', 'teaching-agent']);
    const dataService = schoolState.environment.services.find(service => service.unit === 'learning-data');
    const schoolControl = { authorization: 'Bearer '+await resolveCredential(join(directory, 'school'), 'control') };
    const api = async (route, body, headers = {}) => {
      const response = await fetch(schoolState.endpoint+'/api/learning/'+route, {
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, 200, route+': '+JSON.stringify(value)); return value;
    };
    const activity = await api('activities', { requestId: randomUUID(), goal: '独立 Agent', question: '', references: [] });
    const legacy = await api('activities', { requestId: randomUUID(), goal: '升级前的本地对话', question: '', references: [] });
    const legacyReceiver = (await api(`agent/${legacy.activityId}/capabilities`)).receiver;
    const legacyRequest = randomUUID();
    await api(`intents/${legacy.activityId}`, { requestId: legacyRequest, receiver: legacyReceiver,
      scope: { environmentId: legacy.identity.environmentId, spaceId: legacy.identity.spaceId,
        principalId: legacy.identity.principalId, activityId: legacy.activityId },
      draft: { token: randomUUID(), question: '原本地记录', references: [], bases: [] }, works: [], evidence: [] });
    await api(`intents/${legacy.activityId}/${legacyRequest}/dispatch`, {});
    let legacyConversation; const legacyDeadline = Date.now() + 10000;
    do {
      legacyConversation = await api(`agent/${legacy.activityId}/conversation`);
      if (legacyConversation.runs[0]?.state === 'paused') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    } while (Date.now() < legacyDeadline);
    assert.equal(legacyConversation.runs[0]?.state, 'paused');
    // Reproduce an upgraded pre-deployment activity: Agent facts exist before a route row.
    // Only fixture setup touches storage; the assertions below use the production HTTP API.
    const legacyBinding = JSON.parse(await resolveCredential(join(directory, 'school'), 'storage-' + dataService.serviceId));
    const fixtureStorage = await openStorage({ binding: legacyBinding, migrations: learningMigrations,
      backend: createFileBackend({ id: 'learning-data', root: join(directory, 'school/learning-resources/learning-data') }) });
    try { await fixtureStorage.request({ requestId: randomUUID(), fingerprint: 'pre-deployment-activity-fixture' }, async tx => {
      await tx.query('DELETE FROM activity_agent_routes WHERE activity_id=$1', [legacy.activityId]); return null;
    }); } finally { await fixtureStorage.close(); }
    const grant = await agent.authorize({ sourceEnvironmentId: dataService.environmentId, sourceServiceId: dataService.serviceId,
      sourceInstallationId: schoolState.environment.installationId, capabilities: ['teaching.agent'] }, agentService.serviceId);
    await school.connect({ connectionId: agentConnectionId, sourceEnvironmentId: dataService.environmentId, sourceServiceId: dataService.serviceId,
      target: agentService, requiredCapabilities: ['teaching.agent'], optionalCapabilities: [], credentialRef: 'remote-agent' }, grant.token);
    await api('manage/agent-binding', { requestId: randomUUID(), identity: activity.identity,
      connectionId: agentConnectionId, target: agentService, installationId: agentState.environment.installationId }, schoolControl);
    assert.deepEqual(await api(`agent/${legacy.activityId}/conversation`), legacyConversation,
      'A new remote binding cannot hide local facts that predate the deployment route table.');
    const dependencyGrant = await school.authorize({ sourceEnvironmentId: agentService.environmentId, sourceServiceId: agentService.serviceId,
      sourceInstallationId: agentState.environment.installationId, capabilities: ['teaching.dependencies'] }, dataService.serviceId);
    await agent.connect({ connectionId: dependencyConnectionId, sourceEnvironmentId: agentService.environmentId, sourceServiceId: agentService.serviceId,
      target: { ...dataService, capabilities: ['teaching.dependencies'] }, requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [], credentialRef: 'agent-dependencies' }, dependencyGrant.token);
    const connectionId = randomUUID(), grantId = randomUUID();
    await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '独立部署回归',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions',
      modelId: 'deployment-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 262144, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-deployment-key' } });
    await api('models/grants', { requestId: randomUUID(), connectionId, grantId, owner: 'self' });
    await api('models/selection', { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } });
    const receiver = (await api(`agent/${activity.activityId}/capabilities`)).receiver;
    assert.equal(receiver.receiverId, 'teaching-agent:'+agentService.serviceId);
    const requestId = randomUUID();
    const prepared = await api(`intents/${activity.activityId}`, { requestId, receiver,
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
      draft: { token: randomUUID(), question: '解释独立运行的 Agent', references: [], bases: [] }, works: [], evidence: [] });
    const remote = createOutboundConnection({ connection: { connectionId: agentConnectionId,
      sourceEnvironmentId: dataService.environmentId, sourceServiceId: dataService.serviceId, target: agentService,
      requiredCapabilities: ['teaching.agent'], optionalCapabilities: [], credentialRef: 'remote-agent' },
      credential: async () => grant.token, allowInsecureLoopback: true });
    assert.deepEqual(await remote.request('teaching.agent', { version: 1, operation: 'accept', identity: activity.identity,
      activityId: activity.activityId, args: [prepared.input, '0'.repeat(64)] }), { error: 'invalid' });
    assert.equal(await api(`agent/${activity.activityId}/requests/${requestId}`), null);
    const accepted = await api(`intents/${activity.activityId}/${requestId}/dispatch`, {});
    if (accepted.state !== 'accepted') {
      const connection = createOutboundConnection({ connection: { connectionId: agentConnectionId,
        sourceEnvironmentId: dataService.environmentId, sourceServiceId: dataService.serviceId, target: agentService,
        requiredCapabilities: ['teaching.agent'], optionalCapabilities: [], credentialRef: 'remote-agent' },
        credential: async () => grant.token, allowInsecureLoopback: true });
      const diagnostic = await connection.request('teaching.agent', { version: 1, operation: 'accept', identity: activity.identity,
        activityId: activity.activityId, args: [prepared.input, prepared.inputDigest] });
      assert.fail('Original acceptance was not confirmed: '+JSON.stringify(diagnostic));
    }
    const deadline = Date.now()+60000; let conversation;
    do {
      conversation = await api(`agent/${activity.activityId}/conversation`);
      if (conversation.runs.some(run => run.state === 'completed')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now()<deadline);
    let diagnostic;
    if (conversation.runs[0]?.state !== 'completed') {
      const transport = createOutboundConnection({ connection: { connectionId: dependencyConnectionId,
        sourceEnvironmentId: agentService.environmentId, sourceServiceId: agentService.serviceId, target: dataService,
        requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [], credentialRef: 'agent-dependencies' },
        credential: async () => dependencyGrant.token, allowInsecureLoopback: true });
      diagnostic = await transport.request('teaching.dependencies', { version: 1, operation: 'model', identity: activity.identity,
        args: [{ operation: 'checks.read', identity: activity.identity, args: [conversation.runs[0].attemptId] }] });
    }
    assert.equal(conversation.runs[0]?.state, 'completed', JSON.stringify({ conversation, diagnostic, upstreamRequests: requests.length }));
    assert.equal(conversation.messages.at(-1).text, '原活动的独立服务回答');
    await agent.stop(); await agent.start();
    assert.deepEqual(await api(`agent/${activity.activityId}/conversation`), conversation);
    assert.equal(requests.length, 1);
    // Kill the real Agent process while the separate model owner is handling the original
    // request. The successor must reconcile that attempt, including a late result.
    holdNext = true;
    const physicallyStarted = new Promise(resolve => { holding = resolve; });
    const interruptedRequest = randomUUID();
    await api(`intents/${activity.activityId}`, { requestId: interruptedRequest, receiver,
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
      draft: { token: randomUUID(), question: '重启后查询同一个请求', references: [], bases: [] }, works: [], evidence: [] });
    const interruptedReceipt = await api(`intents/${activity.activityId}/${interruptedRequest}/dispatch`, {});
    assert.equal(interruptedReceipt.state, 'accepted');
    await waitForStart(physicallyStarted);
    const interruptedRunId = JSON.parse(interruptedReceipt.receipt.detail).runId;
    const beforeCrash = await api(`agent/${activity.activityId}/runs/${interruptedRunId}`);
    const processOwner = JSON.parse(await readFile(join(directory, 'agent', 'instance.json'), 'utf8'));
    process.kill(processOwner.pid, 'SIGKILL');
    releaseHeld();
    await new Promise(resolve => setTimeout(resolve, 100));
    await agent.start();
    let recovered;
    const recoveryDeadline = Date.now() + 60000;
    do {
      recovered = await api(`agent/${activity.activityId}/runs/${interruptedRunId}`);
      if (['completed', 'paused', 'stopped', 'failed'].includes(recovered.state)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < recoveryDeadline);
    assert.ok(['completed', 'paused', 'stopped'].includes(recovered.state), JSON.stringify(recovered));
    if (recovered.state === 'stopped') assert.ok(['authorization-lost', 'authorization-unconfirmed'].includes(recovered.reason));
    assert.equal(recovered.attemptId, beforeCrash.attemptId);
    assert.deepEqual(await api(`agent/${activity.activityId}/requests/${interruptedRequest}`), interruptedReceipt.receipt);
    assert.equal(requests.length, 2, 'a successor never generates a replacement for the original accepted attempt');
    conversation = await api(`agent/${activity.activityId}/conversation`);
    assert.equal((await api(`agent/${activity.activityId}/requests/${requestId}`)).state, 'accepted');
    await api('manage/agent-binding', { requestId: randomUUID(), identity: activity.identity,
      connectionId: agentConnectionId, target: agentService, installationId: randomUUID() }, schoolControl);
    assert.deepEqual(await api(`agent/${activity.activityId}/conversation`), conversation,
      'New member configuration must preserve original activity owner reads.');
    assert.equal(requests.length, 2);
    holdNext = true;
    const revokedStarted = new Promise(resolve => { holding = resolve; });
    const revokedRequest = randomUUID();
    await api(`intents/${activity.activityId}`, { requestId: revokedRequest, receiver,
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
        principalId: activity.identity.principalId, activityId: activity.activityId },
      draft: { token: randomUUID(), question: '撤权时保留原输入', references: [], bases: [] }, works: [], evidence: [] });
    const revokedReceipt = await api(`intents/${activity.activityId}/${revokedRequest}/dispatch`, {});
    await waitForStart(revokedStarted);
    const revokedRun = await api(`agent/${activity.activityId}/runs/${JSON.parse(revokedReceipt.receipt.detail).runId}`);
    assert.equal(await school.revoke(dependencyGrant.grantId), true);
    const modelService = schoolState.environment.services.find(item => item.unit === 'model-connection');
    const modelBinding = JSON.parse(await resolveCredential(join(directory, 'school'), 'storage-' + modelService.serviceId));
    const modelStorage = await openStorage({ binding: modelBinding, migrations: modelMigrations,
      backend: createFileBackend({ id: 'model-connection', root: join(directory, 'school/learning-resources/model-connection') }) });
    try {
      const actualOwner = await createModelGateway(modelStorage, { authorize: async () => { throw new Error('No ordinary access through cleanup'); } });
      let cancelled; const cleanupDeadline = Date.now() + 15000;
      do {
        cancelled = await actualOwner.checks.cleanup.status({ environmentId: activity.identity.environmentId,
          spaceId: activity.identity.spaceId, principalId: activity.identity.principalId }, revokedRun.attemptId);
        if (cancelled.physicalRequestEnded && heldResponseClosed) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < cleanupDeadline);
      assert.equal(cancelled.cancelRequested, true, 'the actual model owner stops a request after its Agent grant is revoked');
      assert.equal(cancelled.physicalRequestEnded, true); assert.equal(heldResponseClosed, true);
    } finally { await modelStorage.close(); }
    assert.equal((await api(`intents/${activity.activityId}/${revokedRequest}`)).input.draft.question, '撤权时保留原输入');
    releaseHeld();
    assert.equal(requests.length, 3);
    const key = randomBytes(32);
    await school.setCredential('deployment-recovery', key.toString('base64'));
    await agent.setCredential('deployment-recovery', key.toString('base64'));
    const schoolBackup = await school.recovery.backup({ directory: join(directory, 'school-backups'), recoveryKeyRef: 'deployment-recovery' }).catch(async error => {
      const state = await readFile(join(directory, 'school/maintenance.json'), 'utf8').catch(() => 'not-entered');
      throw new Error('School backup failed: ' + state, { cause: error });
    });
    const agentBackup = await agent.recovery.backup({ directory: join(directory, 'agent-backups'), recoveryKeyRef: 'deployment-recovery' });
    assert.ok(schoolBackup.services.some(owner => owner.serviceId === dataService.serviceId));
    assert.ok(agentBackup.services.some(owner => owner.serviceId === agentService.serviceId));
    assert.equal(requests.length, 3, 'maintenance validates routing facts without dispatching another model request');
  } finally {
    releaseHeld?.();
    await Promise.allSettled([agent.stop(), school.stop()]);
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
