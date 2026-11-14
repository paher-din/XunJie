import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createFileBackend, provisionStorage, openStorage, StorageError } from '@xunjie/storage';
import { createSpaces, createCourses, createLearningData, learningMigrations, spaceCourseMigrations } from '@xunjie/learning-space';
import { createAgentSessions } from '@xunjie/learning-space/learning-data/agent-sessions';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { agentServiceMigrations } from '@xunjie/agents/transport/session-storage';
import { createAgentDependencyChannel } from '@xunjie/agents/transport/session-dependencies';
import { createWorkspaceToolModule } from '@xunjie/agents/workspace-assistant/index';
import { createUserQuestions } from '@xunjie/agents/capabilities/user-questions/index';
import { createConnectionAuthority } from '../dist/connections.js';
import { createStandaloneAgentApplication } from '../dist/agent-application.js';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';

// Two real owners communicate through authenticated v2 JSON; only the native model upstream is a fixture.
test('standalone uses the shared ProductAgent with v2 owner ports and defers recovery until storage reopens', { timeout: 90000 }, async t => {
  const pg = await nativeFixture(), handles = [], frames = [], requests = [];
  let app, models, dependencyAuthority, sendAgent;
  const permits = [];
  async function bounded(work, label) {
    let timer;
    try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 20000); })]); }
    finally { clearTimeout(timer); }
  }
  let rejectedOwnerRequests = 0;
  let holdRequest = false, signalHeld = () => {}, releaseHeld = () => {};
  const dependencyServer = createServer((request, response) => {
    response.on('finish', () => { if ([401, 403].includes(response.statusCode)) rejectedOwnerRequests++; });
    void dependencyAuthority.handle(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }).catch(() => response.destroy());
  });
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (holdRequest) {
      holdRequest = false;
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }) + '\n\n');
      signalHeld(); await new Promise(resolve => { releaseHeld = resolve; });
    }
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '真实独立 Agent 回答。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await Promise.all([new Promise(resolve => dependencyServer.listen(0, '127.0.0.1', resolve)), new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))]);
  t.after(async () => {
    releaseHeld();
    await app?.owners[0].participant.closeDispatch(); await app?.lifecycle?.close(); models?.closeWrites(); await models?.checks.drain();
    for (const server of [dependencyServer, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const handle of handles.reverse()) await handle.close(); await pg.close();
  });
  async function open(name, migrations) {
    const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations });
    const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: name, root: join(pg.root, name) }) });
    handles.push(storage); return { storage, binding };
  }
  const space = await open('space', spaceCourseMigrations), spaces = createSpaces(space.storage), identity = await spaces.personal(), courses = createCourses(space.storage, spaces);
  const data = await open('data', learningMigrations), agent = await open('agent', agentServiceMigrations);
  await spaces.bindMember(identity, { ...data.storage.owner, version: 1 });
  const learning = createLearningData(data.storage, spaces, courses), installationId = randomUUID();
  const target = { ...data.storage.owner, unit: 'learning-data', protocolVersion: 1, endpoint: `http://127.0.0.1:${dependencyServer.address().port}`, capabilities: ['agent.dependencies.v2'] };
  const agentTarget = { ...agent.storage.owner, unit: 'teaching-agent', protocolVersion: 1, endpoint: 'http://127.0.0.1:1', capabilities: ['agent.sessions.v2'] };
  const fixedOwner = { version: 1, installationId, connectionId: randomUUID(), target: agentTarget };
  const sessions = createAgentSessions(data.storage, { authorize: spaces.authorize, openActivity: learning.open, resolveOwner: async () => fixedOwner });
  models = await createModelGateway((await open('models', modelMigrations)).storage, { holder: 'device', authorize: spaces.authorize,
    async authorizePermit(actor, permit) {
      const result = await sendAgent({ version: 2, operation: 'assertDispatch', identity: actor, sessionId: permit.sessionId, args: { permit, attemptId: permit.operationId } });
      if (result.error) throw new StorageError(result.error);
      permits.push(permit);
    } });
  const connectionId = randomUUID(), modelGrantId = randomUUID();
  await models.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'standalone native', protocol: 'chat-completions',
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'fixture', dialect: 'standard', parameterMode: 'plain',
    enabled: true, contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-standalone-key' } });
  await models.selection.createGrant(identity, identity, { requestId: randomUUID(), grantId: modelGrantId, connectionId, owner: 'self' });
  await models.selection.save(identity, { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId: modelGrantId } });
  const channel = createAgentDependencyChannel(data.storage, { sessions, learning, courses, models, authorize: spaces.authorize, resolveOwner: async () => fixedOwner,
    async assertDispatch(actor, permit) { const result = await sendAgent({ version: 2, operation: 'assertDispatch', identity: actor, sessionId: permit.sessionId, args: { permit, attemptId: permit.operationId } }); if (result.error) throw new StorageError(result.error); },
    source: async actor => ({ sourceId: 'school', identity: actor, target: { ...data.storage.owner, version: 1 }, learning,
      courses: { owner: { ...space.storage.owner, version: 1 }, listCourses: courses.listCourses, readRelease: courses.readRelease } }),
    tools: async (actor, session, source) => [createWorkspaceToolModule({ learning, courses, workspace: () => learning.open(actor, session.workspace.activityId),
      executionOrigin: () => ({ grantId: source.grantId, sourceEnvironmentId: source.sourceEnvironmentId, sourceServiceId: source.sourceServiceId,
        sourceInstallationId: source.sourceInstallationId }) }), createUserQuestions()],
  });
  dependencyAuthority = createConnectionAuthority({ root: join(pg.root, 'data-authority'), service: target, handlers: { 'agent.dependencies.v2': async (value, source) => {
    frames.push(value.chunkChannel === 1 && value.operation === 'invoke' ? value.value : value); return channel.handle(value, source);
  } } });
  const grant = await dependencyAuthority.authorize({ sourceEnvironmentId: agent.storage.owner.environmentId, sourceServiceId: agent.storage.owner.serviceId,
    sourceInstallationId: installationId, capabilities: ['agent.dependencies.v2'] });
  const root = join(pg.root, 'standalone'), dependencyConnectionId = randomUUID();
  const configuration = { connections: [{ connectionId: dependencyConnectionId, sourceEnvironmentId: agent.storage.owner.environmentId,
    sourceServiceId: agent.storage.owner.serviceId, target, requiredCapabilities: ['agent.dependencies.v2'], optionalCapabilities: [], credentialRef: 'dependencies' }],
    agent: { dependencyConnectionId }, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6' } };
  const environment = { installationId };
  await mkdir(join(root, 'credentials'), { recursive: true }); await writeFile(join(root, 'credentials/dependencies'), grant.token);
  await writeFile(join(root, 'installation.json'), JSON.stringify(configuration)); await writeFile(join(root, 'environment.json'), JSON.stringify(environment));
  const activity = await learning.create(identity, { requestId: randomUUID(), goal: '真实远端工作区', question: '', references: [] });
  const session = await sessions.create(identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'workspace-assistant', workspace: { activityId: activity.activityId, target: activity.target } });
  const source = { grantId: randomUUID(), sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId,
    sourceInstallationId: randomUUID(), assertAuthorized: async () => {} };
  const construct = () => createStandaloneAgentApplication({ root, environment, configuration, storage: agent.storage, binding: agent.binding });
  await agent.storage.participant().closeWrites(); await agent.storage.participant().closeDispatch();
  app = construct();
  assert.deepEqual(Object.keys(app.serviceCapabilities[agent.storage.owner.serviceId]), ['agent.sessions.v2']);
  sendAgent = async value => JSON.parse(JSON.stringify(await app.serviceCapabilities[agent.storage.owner.serviceId]['agent.sessions.v2'](JSON.parse(JSON.stringify(value)), source)));
  await app.start();
  const initialize = { version: 2, operation: 'initialize', identity, sessionId: session.sessionId,
    args: { session: { sessionId: session.sessionId, identity, scenario: session.scenario, restartPolicy: 'automatic', createdAt: session.createdAt } } };
  assert.deepEqual(await sendAgent(initialize), { error: 'maintenance' });
  await agent.storage.participant().resume(); await app.lifecycle.resume();
  assert.equal((await sendAgent(initialize)).sessionId, session.sessionId);
  await sessions.markReady(identity, { requestId: randomUUID(), sessionId: session.sessionId });
  const action = { requestId: randomUUID(), scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId: activity.activityId },
    receiver: { receiverId: 'workspace-assistant', location: 'remote', kind: 'question' }, draft: { token: randomUUID(), question: '解释当前目标', references: [], bases: [] }, works: [], evidence: [] };
  const accepted = await sendAgent({ version: 2, operation: 'accept', identity, sessionId: session.sessionId,
    args: { input: { requestId: randomUUID(), sessionId: session.sessionId, text: '解释当前目标', context: { action } } } });
  assert.ok(accepted.runId, JSON.stringify(accepted));
  await app.owners[0].participant.drain();
  const run = await sendAgent({ version: 2, operation: 'run', identity, sessionId: session.sessionId, args: { runId: accepted.runId } });
  assert.equal(run.state, 'completed', JSON.stringify(run));
  const eventsCall = { version: 2, operation: 'events', identity, sessionId: session.sessionId, args: { after: 0 } };
  const events = await sendAgent(eventsCall);
  assert.equal(events.find(event => event.kind === 'assistant').body.text, '真实独立 Agent 回答。');
  assert.ok(frames.some(frame => frame.version === 2 && frame.operation === 'model' && frame.permit));
  assert.equal(requests.length, 1);
  await app.owners[0].participant.closeWrites(); await app.owners[0].participant.closeDispatch(); await app.owners[0].participant.drain();
  const boundaryInput = { backupId: randomUUID(), boundaryAt: new Date().toISOString(), signal: new AbortController().signal };
  assert.equal((await app.owners[0].material(boundaryInput)).kind, 'xunjie.agent-runtime.boundary/2',
    'the standalone owner exports the same boundary its actual restore target accepts');
  assert.equal((await app.owners[0].receiverMaterial(boundaryInput)).kind, 'xunjie.agent-runtime.receiver-boundary/2');
  await app.owners[0].participant.validate(); await app.lifecycle.close();
  handles.splice(handles.indexOf(agent.storage), 1); await agent.storage.close();
  agent.storage = await openStorage({ binding: agent.binding, migrations: agentServiceMigrations,
    backend: createFileBackend({ id: 'agent', root: join(pg.root, 'agent') }) }); handles.push(agent.storage);
  app = construct(); await app.start();
  assert.deepEqual(await sendAgent(eventsCall), events);
  await app.owners[0].participant.resume();
  assert.deepEqual(await sendAgent(eventsCall), events);
  assert.deepEqual(await sendAgent({ ...initialize, version: 1 }), { error: 'incompatible' });
  const handler = app.serviceCapabilities[agent.storage.owner.serviceId]['agent.sessions.v2'];
  assert.deepEqual(await handler(eventsCall, { ...source, sourceServiceId: randomUUID() }), { error: 'forbidden' });
  assert.deepEqual(await handler(eventsCall, { ...source, assertAuthorized: async () => { throw new StorageError('forbidden'); } }), { error: 'forbidden' });
  assert.equal(requests.length, 1);
  await t.test('each read request admits once at the real owner without retaining admission for the next request', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = frames.length;
      assert.deepEqual(await sendAgent(eventsCall), events);
      assert.deepEqual(frames.slice(before).map(frame => frame.operation), ['sessions.read']);
    }
  });
  // Run before stop: an unconfirmed stopped upstream can retain its principal reservation.
  await t.test('a prior admitted request cannot authorize a new dispatch or background continuation after owner revocation', async () => {
    const activity = await learning.create(identity, { requestId: randomUUID(), goal: '独立撤权工作区', question: '', references: [] });
    const session = await sessions.create(identity, { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'workspace-assistant',
      workspace: { activityId: activity.activityId, target: activity.target } });
    const initialize = { version: 2, operation: 'initialize', identity, sessionId: session.sessionId,
      args: { session: { sessionId: session.sessionId, identity, scenario: session.scenario, restartPolicy: 'automatic', createdAt: session.createdAt } } };
    assert.equal((await sendAgent(initialize)).sessionId, session.sessionId);
    await sessions.markReady(identity, { requestId: randomUUID(), sessionId: session.sessionId });
    const held = new Promise(resolve => { signalHeld = resolve; }); holdRequest = true;
    const nextAction = { ...action, requestId: randomUUID(), scope: { ...action.scope, activityId: activity.activityId },
      draft: { ...action.draft, token: randomUUID() } };
    const next = await sendAgent({ version: 2, operation: 'accept', identity, sessionId: session.sessionId,
      args: { input: { requestId: randomUUID(), sessionId: session.sessionId, text: '验证撤权后的后台推进', context: { action: nextAction } } } });
    assert.ok(next.runId, JSON.stringify(next));
    try { await bounded(held, 'native request not reached'); }
    catch (error) {
      const snapshot = await sendAgent({ version: 2, operation: 'snapshot', identity, sessionId: session.sessionId, args: { runId: next.runId } });
      assert.fail(String(error) + ': ' + JSON.stringify({ run: snapshot.run, steps: snapshot.steps?.map(step => ({ kind: step.operation.kind, state: step.state, reason: step.result?.value?.attempt?.reason })) }));
    }
    const permit = permits.findLast(permit => permit.runId === next.runId);
    assert.ok(permit, 'the original permit was authorized before revocation');
    const dispatchCall = { version: 2, operation: 'assertDispatch', identity, sessionId: session.sessionId,
      args: { permit, attemptId: permit.operationId } };
    assert.deepEqual(await sendAgent(dispatchCall), permit);
    const rejectedBeforeRevocation = rejectedOwnerRequests;
    assert.equal(await dependencyAuthority.revoke(grant.grantId), true);
    for (const call of [initialize, dispatchCall, { version: 2, operation: 'resolveWait', identity, sessionId: session.sessionId,
      args: { resolution: { requestId: randomUUID(), waitId: randomUUID(), expectedVersion: 1, result: { state: 'succeeded' } } } }])
      assert.deepEqual(await sendAgent(call), { error: 'forbidden' });
    releaseHeld();
    // Drain may surface the refused owner read; it must never hide unrelated failures.
    const forbidden = error => error instanceof AggregateError ? error.errors.length > 0 && error.errors.every(forbidden)
      : error instanceof StorageError && error.code === 'forbidden';
    try { await bounded(app.owners[0].participant.drain(), 'background did not drain after revocation'); } catch (error) { assert.ok(forbidden(error), String(error)); }
    await models.checks.drain();
    assert.ok(rejectedOwnerRequests > rejectedBeforeRevocation + 3, 'background continuation rechecks the real owner in addition to the three new privileged requests');
    assert.equal(requests.length, 2, 'revoked background continuation cannot start another native request');
    const replacement = await dependencyAuthority.authorize({ sourceEnvironmentId: agent.storage.owner.environmentId,
      sourceServiceId: agent.storage.owner.serviceId, sourceInstallationId: installationId, capabilities: ['agent.dependencies.v2'] });
    await writeFile(join(root, 'credentials/dependencies'), replacement.token);
    const run = await sendAgent({ version: 2, operation: 'run', identity, sessionId: session.sessionId, args: { runId: next.runId } });
    assert.ok(['paused', 'failed'].includes(run.state), JSON.stringify(run));
    const after = await sendAgent({ ...eventsCall, sessionId: session.sessionId });
    assert.equal(after.filter(event => event.kind === 'assistant').length, 0, 'the revoked result is not published as an answer');
  });
  await t.test('a stopped original permit remains forbidden after request admission', async () => {
    const held = new Promise(resolve => { signalHeld = resolve; }); holdRequest = true;
    const nextAction = { ...action, requestId: randomUUID(), draft: { ...action.draft, token: randomUUID() } };
    const next = await sendAgent({ version: 2, operation: 'accept', identity, sessionId: session.sessionId,
      args: { input: { requestId: randomUUID(), sessionId: session.sessionId, text: '继续验证当前工作区', context: { action: nextAction } } } });
    assert.ok(next.runId, JSON.stringify(next));
    await held;
    const permit = permits.findLast(permit => permit.runId === next.runId);
    assert.ok(permit, 'the real model owner checked this live original permit');
    const dispatchCall = { version: 2, operation: 'assertDispatch', identity, sessionId: session.sessionId,
      args: { permit, attemptId: permit.operationId } };
    assert.deepEqual(await sendAgent(dispatchCall), permit);
    const stopped = await sendAgent({ version: 2, operation: 'stop', identity, sessionId: session.sessionId,
      args: { runId: next.runId, requestId: randomUUID() } });
    assert.equal(stopped.state, 'stopped');
    const denied = await sendAgent(dispatchCall);
    assert.ok(['forbidden', 'conflict', 'stale-generation'].includes(denied.error), JSON.stringify(denied));
    releaseHeld(); await app.owners[0].participant.drain(); await models.checks.drain();
  });
});
