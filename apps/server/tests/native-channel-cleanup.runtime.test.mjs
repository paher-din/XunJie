import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { createNativeChannel, createSpaces, learningMigrations, spaceMigrations, SupervisedSession } from '@xunjie/learning-space';
import { createNativeChannelWorker, nativeChannelNode } from '@xunjie/product-runtime';
import { canonicalValue, executionActionSchema, executionQuerySchema } from '@xunjie/contracts/execution';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { createSchoolClient } from '../../../packages/product-runtime/dist/school-client.js';
import { createNativeChannelClients } from '../../../packages/product-runtime/dist/native-channel-clients.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalHash = value => hash(canonicalValue(value));

test('school client cleans up at its fixed destination after the ordinary connection file is removed', async () => {
  const connectionId = randomUUID(), commandId = randomUUID(), root = await mkdtemp(join(tmpdir(), 'xj-cleanup-destination-'));
  const grant = { connectionId, token: randomUUID() + randomUUID(),
    identity: { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校空间' },
    target: { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 }, capabilities: ['activity:read', 'activity:write'] };
  let cleanupRequests = 0;
  const school = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/native-channel/cleanup')) {
      cleanupRequests++;
      assert.equal(request.headers.authorization === undefined, true, 'cleanup must not send current credentials');
      response.end(JSON.stringify({ commandId, state: 'cleaned' }));
    } else if (request.url.endsWith('/connections/exchange')) response.end(JSON.stringify(grant));
    else response.end(JSON.stringify({ revoked: true }));
  });
  await new Promise(resolve => school.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(join(root, 'credentials'));
    const client = createSchoolClient(root, { clientNamespace: randomUUID() });
    await client.start({ requestId: connectionId, schoolEndpoint: `http://127.0.0.1:${school.address().port}` });
    await client.complete(connectionId);
    const proof = { commandId };
    assert.equal((await client.nativeChannelCall(connectionId, 'cleanup', proof)).state, 'cleaned');
    await client.forward(connectionId, 'connections/revoke', { connectionId });
    await rm(join(root, 'credentials', `school-client-${connectionId}`), { force: true });
    assert.deepEqual(await client.list(), []);
    await assert.rejects(client.complete(connectionId), { code: 'forbidden' });
    await assert.rejects(client.nativeChannelCall(connectionId, 'claim', {}), { code: 'forbidden' });
    assert.equal((await client.nativeChannelCall(connectionId, 'cleanup', proof)).state, 'cleaned');
    assert.equal(cleanupRequests, 2);
    const destination = JSON.parse(await readFile(join(root, 'native-channel', connectionId, 'endpoint.json'), 'utf8'));
    assert.equal(destination.schoolEndpoint, `http://127.0.0.1:${school.address().port}`);
    assert.equal(destination.grant, undefined);
    assert.equal(destination.verifier, undefined);
  } finally {
    school.closeAllConnections();
    await new Promise(resolve => school.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

// An on-disk journal is a fixture from the previous installation process. Startup must
// replay only its cleanup, even though no current connection or native adapter is available.
test('client startup retries an old cleanup outbox without restoring a connection or executing a command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-cleanup-restart-')), connectionId = randomUUID(), commandId = randomUUID();
  const node = { connectionId, nodeId: 'original-device', installationId: randomUUID(), supervisorEpoch: randomUUID(),
    platform: 'macos-arm64', adapters: [] };
  const command = { commandId, activityId: randomUUID(), sessionId: randomUUID(), operation: 'submit', payload: {},
    claimId: randomUUID(), node, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, generation: 'original-generation' };
  const terminal = { requestId: commandId, inputDigest: 'a'.repeat(64), scope: { environmentId: randomUUID(),
    spaceId: randomUUID(), principalId: randomUUID(), activityId: command.activityId }, executionRef: command.sessionId,
    state: 'cancelled', statusKnowledge: 'confirmed', stopRequested: true, confirmedSeq: 2, reason: null, output: null };
  let confirmations = 0, otherRequests = 0, clients;
  const school = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url !== '/api/learning/native-channel/cleanup') {
      otherRequests++; response.writeHead(403); response.end(JSON.stringify({ error: 'forbidden' })); return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    const input = JSON.parse(text);
    assert.equal(request.headers.authorization === undefined, true);
    assert.ok(input.claimId === command.claimId);
    assert.ok(input.node.supervisorEpoch === command.node.supervisorEpoch);
    assert.ok(input.owner.serviceId === command.owner.serviceId);
    assert.ok(input.generation === command.generation);
    assert.equal(input.query.executionRef, command.sessionId);
    confirmations++;
    response.end(JSON.stringify({ commandId, state: 'cleaned' }));
  });
  await new Promise(resolve => school.listen(0, '127.0.0.1', resolve));
  try {
    const cleanupEndpoint = `http://127.0.0.1:${school.address().port}`, directory = join(root, 'native-channel', connectionId);
    await mkdir(join(root, 'credentials'));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'endpoint.json'), JSON.stringify({ connectionId, schoolEndpoint: cleanupEndpoint }));
    const path = join(directory, `${commandId}.json`);
    await writeFile(path, JSON.stringify({ command, state: 'reported', cleanupEndpoint, result: { ...terminal, state: 'running' }, pendingCleanup: terminal }));
    const client = createSchoolClient(root, { clientNamespace: randomUUID() });
    assert.deepEqual(await client.list(), []);
    clients = await createNativeChannelClients({ root, environment: { installationId: randomUUID() },
      resources: { nodePath: process.execPath }, client });
    await clients.resume();
    const deadline = Date.now() + 2500;
    while (!confirmations && Date.now() < deadline) await delay(25);
    assert.equal(confirmations, 1, 'startup must discover the durable cleanup even without a current school space');
    await clients.pause();
    assert.equal(otherRequests, 0, 'cleanup recovery must not register, claim or recreate normal access');
    const acknowledged = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(acknowledged.pendingCleanup, undefined);
    assert.equal(acknowledged.cleaned, true);
    assert.deepEqual(await client.list(), []);
  } finally {
    await clients?.close();
    school.closeAllConnections();
    await new Promise(resolve => school.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

// A real authenticated claim owns the process. Only its transport is disconnected; the
// PostgreSQL ledger, sandboxed process, disk journal, restart and school drain remain real.
test('offline cleanup survives a new worker epoch and retries the original claim without executing again', { timeout: 120000 }, async t => {
  const fixture = await nativeFixture(), opened = [], children = [], workers = [];
  let offline = false, loseAck = false, cleanupCalls = 0, originalProof;
  try {
    async function owner(migrations) {
      const descriptor = { environmentId: randomUUID(), serviceId: randomUUID() };
      const binding = await provisionStorage({ admin: fixture.admin, owner: descriptor, password: randomBytes(32).toString('base64url'), migrations });
      const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: descriptor.serviceId, root: join(fixture.root, descriptor.serviceId) }) });
      opened.push(storage);
      return storage;
    }
    const school = await owner(spaceMigrations), data = await owner(learningMigrations), spaces = createSpaces(school);
    const password = randomUUID();
    const identity = await spaces.createMember({ requestId: randomUUID(), loginName: 'cleanup-student', password });
    const login = await spaces.login('cleanup-student', password);
    const connectionId = randomUUID(), verifier = randomBytes(48).toString('base64url');
    await spaces.beginConnection({ requestId: connectionId, clientId: randomUUID(), challenge: createHash('sha256').update(verifier).digest('base64url') });
    await spaces.approveConnection(login.token, connectionId);
    const grant = await spaces.exchangeConnection(connectionId, verifier);
    const activityId = randomUUID();
    const channel = createNativeChannel(data, { authenticate: spaces.authenticateConnection, authorizeConnection: spaces.authorizeConnection,
      async authorize(who, id) {
        await spaces.authorize(who);
        if (id !== activityId || who.principalId !== identity.principalId) throw new StorageError('forbidden');
      } });
    const native = { nodePath: process.execPath, sessionRoot: join(fixture.root, 'sessions'),
      ...(process.env.XUNJIE_NATIVE_SESSION_HELPER ? { windowsHelper: process.env.XUNJIE_NATIVE_SESSION_HELPER } : {}) };
    const node = await nativeChannelNode({ ...native, connectionId, installationId: randomUUID() });
    assert.ok(node.adapters.some(item => item.adapterId === 'four-state-accumulator'), 'real native isolation is required');
    const create = SupervisedSession.create;
    t.mock.method(SupervisedSession, 'create', async function (...args) {
      const child = await create.apply(this, args);
      children.push(child);
      return child;
    });
    const { manifest } = await accumulatorPackage({ version: 1 }), declared = manifest.session, definitionDigest = 'a'.repeat(64);
    const activity = activitySchema.parse({ activityId, identity, target: { ...data.owner, version: 1 },
      goal: '确认原实例已退出', question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
      course: { associationId: randomUUID(), courseId: randomUUID(), courseName: '清理恢复', taskId: randomUUID(), taskTitle: '原生会话',
        releaseId: randomUUID(), contentDigest: 'b'.repeat(64), objectives: ['确认退出'], requirements: '观察',
        helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
        materials: [], starterWorks: [], capabilities: [], components: [{ key: 'accumulator',
          definition: { digest: definitionDigest, manifest }, configuration: { title: '原实例退出确认' }, materialIds: [] }] } });
    const requestId = randomUUID(), executionRef = randomUUID();
    const action = executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId,
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId },
      receiver: { receiverId: 'approved-local', location: 'local', kind: 'execution' }, execution: {
        instance: { instanceId: `${activityId}:accumulator`, key: 'accumulator', componentId: manifest.componentId,
          componentVersion: manifest.version, definitionDigest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: 'advance', effect: 'input' }, parameters: {},
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
        limits: { timeMs: declared.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: declared.budgets.inputBytes,
          outputBytes: declared.budgets.outputBytes, concurrentJobs: declared.budgets.concurrentSessions, queuedJobs: declared.budgets.queuedSessions },
        plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session', planDigest: canonicalHash({
          planId: 'native-session', planVersion: 1, componentId: manifest.componentId, componentVersion: manifest.version, operationId: 'advance' }) },
        session: { adapterId: declared.adapterId, adapterVersion: declared.adapterVersion,
          limits: Object.fromEntries(['operationTimeoutMs', 'idleMs', 'maxMs', 'memoryMiB', 'concurrentSessions', 'queuedSessions']
            .map(key => [key, declared.budgets[key]])) },
        initiator: { kind: 'student', principalId: identity.principalId } } });
    const execution = executionQuerySchema.parse({ requestId, inputDigest: hash(action), scope: action.scope,
      executionRef, state: 'queued', statusKnowledge: 'confirmed', stopRequested: false, confirmedSeq: 1,
      reason: null, output: null, session: { adapterId: declared.adapterId, adapterVersion: declared.adapterVersion,
        instanceId: action.execution.instance.instanceId, instanceKey: 'accumulator', nodeId: node.nodeId,
        installGeneration: node.installationId, supervisorEpoch: node.supervisorEpoch, executorInstanceId: randomUUID(),
        appliedSeq: 0, lastControlId: null, observation: null, observations: [] } });
    const call = async (operation, input) => {
      if (offline) throw new StorageError('unavailable');
      if (operation === 'cleanup') {
        cleanupCalls++;
        originalProof ??= structuredClone(input);
        const reply = await channel.cleanup(input);
        if (loseAck) { loseAck = false; throw new StorageError('unavailable'); }
        return reply;
      }
      return channel[operation](grant.token, input);
    };
    const root = join(fixture.root, 'device');
    const makeWorker = current => {
      const worker = createNativeChannelWorker({ root, node: current, native, call });
      workers.push(worker); return worker;
    };
    const first = makeWorker(node);
    await first.tick();
    await channel.enqueue(identity, connectionId, { commandId: requestId, activityId, sessionId: executionRef,
      operation: 'submit', payload: { action, activity, execution } });
    await first.tick();
    assert.equal(children.length, 1);
    assert.ok(children[0].pid > 0);
    assert.equal(children[0].exitFact, null);
    assert.equal((await channel.query(identity, requestId)).result.state, 'running');

    offline = true;
    await first.stop();
    assert.equal(children[0].exitFact?.confirmed, true);
    const journalPath = join(root, 'native-channel', connectionId, `${requestId}.json`);
    const stopped = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(stopped.state, 'reported');
    assert.equal(stopped.pendingCleanup?.state, 'cancelled', 'stop must persist the original terminal snapshot before reporting success');
    assert.equal(stopped.pendingCleanup.statusKnowledge, 'confirmed');
    assert.equal(stopped.pendingCleanup.session.executorInstanceId, execution.session.executorInstanceId);

    const replacement = makeWorker({ ...node, supervisorEpoch: randomUUID() });
    await assert.rejects(replacement.tick(), { code: 'unavailable' });
    assert.equal(children.length, 1);
    await spaces.adminRevokeConnection(connectionId);
    await spaces.setMembership({ requestId: randomUUID(), principalId: identity.principalId, active: false });
    channel.closeDispatch();
    offline = false; loseAck = true;
    await assert.rejects(replacement.tick(), { code: 'forbidden' });
    assert.equal(cleanupCalls, 1, 'old cleanup must be sent before new-epoch registration or current eligibility checks');
    assert.ok(originalProof.node.supervisorEpoch === node.supervisorEpoch);
    assert.ok(originalProof.claimId === stopped.command.claimId);
    assert.ok(originalProof.owner.serviceId === stopped.command.owner.serviceId);
    assert.ok(originalProof.generation === stopped.command.generation);
    assert.ok((JSON.parse(await readFile(journalPath, 'utf8'))).pendingCleanup, 'a lost acknowledgement must retain the outbox');
    await assert.rejects(replacement.tick(), { code: 'forbidden' });
    assert.equal(cleanupCalls, 2);
    assert.equal((JSON.parse(await readFile(journalPath, 'utf8'))).pendingCleanup, undefined);
    await channel.drain();
    assert.equal(children.length, 1, 'cleanup recovery must never dispatch a replacement execution');
    assert.equal(children[0].exitFact.confirmed, true);
  } finally {
    offline = false;
    for (const worker of workers) await worker.stop();
    for (const child of children) await child.dispose();
    for (const storage of opened.reverse()) await storage.close();
    await fixture.close();
  }
});
