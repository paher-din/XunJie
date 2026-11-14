import './model-cleanup-source-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
const { createModelGateway, modelMigrations } = await import('../../../packages/model-gateway/dist/index.js');
const { createSchoolClient } = await import('../../../packages/product-runtime/dist/school-client.js');
import { createConnectionAuthority } from '../../../packages/product-runtime/dist/connections.js';
import { defaultLearningAdmissionPolicy } from '../../../packages/model-gateway/dist/learning-admission.js';

for (const independent of [true]) test(`paired learning tasks receive, claim, query and stop through V3 session modelBinding`, { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let storage; let models; let authority; let pair;
  let opened; const sdkStarted = new Promise(resolve => { opened = resolve; }); let calls = 0;
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* SDK input */ }
    calls++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"index":0,"delta":{"content":"held"},"finish_reason":null}]}\n\n'); opened();
  });
  const actor = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: '学校' };
  const localTarget = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 };
  const installationId = randomUUID();
  const learningTarget = independent ? { environmentId: actor.environmentId, serviceId: randomUUID(), version: 1 } : localTarget;
  let selectionCalls = 0, defaultCalls = 0;
  let defaultValue = null;
  let memberConnectionId;
  let accessTarget = localTarget; let permittedLease; let beforeDispatch;
  let verifyAgent = false, activityAllowed = true;
  let grantPermitError;
  const school = createServer(async (request, response) => {
    if (request.url === '/api/learning/access') {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ identity: actor, target: learningTarget }));
    } else if (request.url === '/api/learning/models/school-default') {
      defaultCalls++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(defaultValue));
    } else if (request.url === '/api/learning/models/selection') {
      selectionCalls++; response.writeHead(500); response.end();
    } else if (!await authority.handle(request, response)) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => school.listen(0, '127.0.0.1', resolve));
  const root = join(fixture.root, 'device');
  try {
    const binding = await provisionStorage({ admin: fixture.admin, owner: { environmentId: localTarget.environmentId, serviceId: localTarget.serviceId }, password: randomUUID(), migrations: modelMigrations });
    storage = await openStorage({ binding, migrations: modelMigrations, backend: createFileBackend({ id: 'files', root: fixture.root + '/objects' }) });
    const endpoint = `http://127.0.0.1:${school.address().port}`;
    const service = { environmentId: actor.environmentId, serviceId: randomUUID(), endpoint, protocolVersion: 1, capabilities: ['learning.authority'] };
    authority = createConnectionAuthority({ root: fixture.root + '/school', service, handlers: {
      'learning.authority': async (payload, source) => {
        const target = { grantId: source.grantId, installationId: source.sourceInstallationId };
        assert.equal(payload.connectionId, memberConnectionId);
        if (payload.operation === 'modelTaskPermit') {
          assert.match(payload.input.taskId, /^[a-f0-9-]{36}$/);
          const record = await models.deviceTasks.read(actor, target, payload.input.taskId);
          if (verifyAgent) {
            const origin = record.task.origin;
            try { await authority.assertSourceAuthorized({ grantId: origin.grantId, sourceEnvironmentId: origin.service.environmentId,
              sourceServiceId: origin.service.serviceId, sourceInstallationId: origin.installationId }, 'learning.authority'); }
            catch { return { error: 'forbidden' }; }
            if (!activityAllowed) return { error: 'forbidden' };
          }
          const lease = record.task.origin?.authority;
          if (lease && permittedLease && (lease.generation !== permittedLease.generation || lease.sessionId !== permittedLease.sessionId))
            return { error: 'stale-generation' };
          return { authorized: true };
        }
        if (payload.operation === 'modelAccess') return { identity: actor, target: accessTarget };
        if (payload.operation === 'modelChoices') {
          assert.ok(independent);
          assert.ok(Array.isArray(payload.input.projection.options));
          return { published: true };
        }
        if (payload.operation === 'modelGrantTaskPermit') return grantPermitError
          ? { error: grantPermitError } : { authorized: true };
        if (payload.operation === 'access') return { identity: actor, target: localTarget };
        if (payload.operation === 'pollModelTasks') return models.deviceTasks.pending(actor, target);
        if (payload.operation === 'completeModelTask') return models.deviceTasks.complete(actor, target, payload.input.taskId, payload.input.receipt);
        throw new Error('Unexpected authority operation');
      },
    } });
    const authorized = await authority.authorize({ sourceEnvironmentId: localTarget.environmentId, sourceServiceId: localTarget.serviceId, sourceInstallationId: installationId, capabilities: ['learning.authority'] });
    pair = { grantId: authorized.grantId, installationId };
    const connectionId = randomUUID(), runtimeConnectionId = randomUUID(); memberConnectionId = connectionId;
    await mkdir(join(root, 'credentials'), { recursive: true });
    await writeFile(join(root, 'credentials', 'transport'), authorized.token);
    await writeFile(join(root, 'credentials', 'school-client-' + connectionId), JSON.stringify({ requestId: connectionId, schoolEndpoint: endpoint,
      verifier: 'fixture-verifier', clientId: randomUUID(), clientNamespace: 'fixture', grant: { token: 'x'.repeat(80), identity: actor, target: learningTarget,
        connectionId, capabilities: ['activity:read', 'activity:write'] }, localBinding: independent ? { runtimeConnectionId: randomUUID(), target: learningTarget } : { runtimeConnectionId, target: localTarget } }));
    await writeFile(join(root, 'installation.json'), JSON.stringify({ connections: [{ connectionId: runtimeConnectionId,
      sourceEnvironmentId: localTarget.environmentId, sourceServiceId: localTarget.serviceId, target: service,
      requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'transport' }] }));
    const local = { target: learningTarget, modelTarget: localTarget };
    const client = createSchoolClient(root, { formatVersion: 1, environmentId: localTarget.environmentId, installationId, clientNamespace: 'fixture', profile: 'local', services: [] }, local);
    models = await createModelGateway(storage, { holder: 'device', authorize: client.authorizeModel,
      authorizePermit: (who, permit, context) => client.authorizePermit(who, permit, context.attemptId, context.phase),
      authorizeDispatch: async identity => { await beforeDispatch?.(); await client.authorizeModelDispatch(identity); },
      // One initial cancellation plus three distinct live-revocation scenarios
      // retain four unknown upstream slots. This finite fixture policy leaves the
      // production default of one slot per principal unchanged.
      learningAdmissionPolicy: { ...defaultLearningAdmissionPolicy, version: 'school-task-revocations-fixture-v1', maxPrincipalPhysical: 4 },
      schoolDefault: client.schoolModel, authorizationPollMs: 20 }); local.models = models;
    if (independent) {
      assert.deepEqual(await client.configureModel({ connectionId, runtimeConnectionId, target: localTarget }), { identity: actor, target: localTarget, configured: true });
      const saved = JSON.parse(await readFile(join(root, 'credentials', 'school-client-' + connectionId), 'utf8'));
      assert.deepEqual(saved.grant.target, learningTarget);
      assert.deepEqual(saved.localBinding.target, learningTarget);
      assert.deepEqual(saved.modelBinding, { runtimeConnectionId, target: localTarget });
      assert.equal(await client.schoolModel(actor), null);
      assert.ok(defaultCalls >= 1); assert.equal(selectionCalls, 0);
      accessTarget = { ...localTarget, serviceId: randomUUID() };
      await assert.rejects(client.configureModel({ connectionId, runtimeConnectionId, target: localTarget }), { code: 'forbidden' });
      accessTarget = localTarget;
    }
    const modelId = randomUUID();
    const savedConnection = await models.save(actor, { requestId: randomUUID(), connectionId: modelId, expectedVersion: 0, name: '配对模型', protocol: 'chat-completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      credential: { action: 'replace', value: 'private-fixture-key' } });
    if (independent) {
      defaultValue = { kind: 'school', connection: savedConnection, policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 2048, timeoutMs: 30000 } };
      assert.deepEqual(await client.schoolModel(actor), defaultValue);
      assert.deepEqual(await models.school.read(actor), defaultValue);
      defaultValue = { kind: 'school', connection: {} };
      await assert.rejects(client.schoolModel(actor), { name: 'ZodError' });
      defaultValue = null;
      assert.equal(selectionCalls, 0);
    }
    if (independent) {
      const input = { requestId: randomUUID(), grantId: randomUUID(), connectionId: modelId, owner: 'self' };
      const createTask = { taskId: randomUUID(), operation: 'grant-create', ownerKind: 'self', input };
      await models.deviceTasks.enqueue(actor, pair, createTask);
      for (const code of ['unavailable', 'commit-unknown', 'maintenance', 'resource-busy']) {
        grantPermitError = code;
        await client.pollModelTasks(() => true);
        assert.equal((await models.deviceTasks.read(actor, pair, createTask.taskId)).receipt, null,
          code+' must keep the original grant task pending');
      }
      grantPermitError = undefined;
      const createGrant = models.selection.createGrant;
      let actualCreates = 0;
      models.selection.createGrant = async (...args) => {
        actualCreates++;
        await createGrant(...args);
        throw new StorageError('commit-unknown');
      };
      try {
        await client.pollModelTasks(() => true);
        assert.equal((await models.deviceTasks.read(actor, pair, createTask.taskId)).receipt, null);
        assert.equal((await models.selection.readGrant(actor, input.grantId)).version, 1);
      } finally { models.selection.createGrant = createGrant; }
      await client.pollModelTasks(() => true);
      const created = (await models.deviceTasks.read(actor, pair, createTask.taskId)).receipt;
      assert.equal(created.ok, true); assert.equal(created.value.grantId, input.grantId);
      assert.equal(created.value.version, 1); assert.equal(actualCreates, 1);
      const revokeTask = { taskId: randomUUID(), operation: 'grant-revoke', modelGrantId: input.grantId,
        input: { requestId: randomUUID(), expectedVersion: 1 } };
      await models.deviceTasks.enqueue(actor, pair, revokeTask);
      const revokeGrant = models.selection.revoke;
      let actualRevocations = 0;
      models.selection.revoke = async (...args) => {
        actualRevocations++;
        await revokeGrant(...args);
        throw new StorageError('resource-busy');
      };
      try {
        await client.pollModelTasks(() => true);
        assert.equal((await models.deviceTasks.read(actor, pair, revokeTask.taskId)).receipt, null);
        assert.equal((await models.selection.readGrant(actor, input.grantId)).active, false);
      } finally { models.selection.revoke = revokeGrant; }
      await client.pollModelTasks(() => true);
      const revoked = (await models.deviceTasks.read(actor, pair, revokeTask.taskId)).receipt;
      assert.equal(revoked.ok, true); assert.equal(revoked.value.active, false);
      assert.equal(revoked.value.version, 2); assert.equal(actualRevocations, 1);
      assert.equal(calls, 0, 'grant reconciliation never dispatches the model');
    }
    const segmentId = randomUUID(), attemptId = randomUUID();
    const serviceOrigin = { sessionId: randomUUID(), service: { environmentId: actor.environmentId, serviceId: randomUUID() }, identity: actor, recoveryGeneration: installationId };
    const origin = { ...serviceOrigin, installationId: randomUUID(), grantId: randomUUID() };
    if (independent) {
      const agentGrant = await authority.authorize({ sourceEnvironmentId: origin.service.environmentId,
        sourceServiceId: origin.service.serviceId, sourceInstallationId: origin.installationId, capabilities: ['learning.authority'] });
      origin.grantId = agentGrant.grantId;
      // Same-installation grant renewal is legal only after the host verifies the
      // current WP01 grant; random credentials are not a renewal permit.
      verifyAgent = true;
    }
    const runAuthority = { sessionId: origin.sessionId, runId: randomUUID(), stepId: randomUUID(), operationId: attemptId, generation: 1 };
    let retiredLease;
    permittedLease = runAuthority;
    const preparationIds = [];
    async function task(operation, args, overriddenOrigin = origin, lease = runAuthority) {
      const taskId = randomUUID();
      const associated = operation.startsWith('checks.');
      const associatedAttempt = associated ? operation === 'checks.receive' ? args[0].attemptId : args[0] : undefined;
      if (!associated) preparationIds.push(taskId);
      if (operation === 'segments.create') args = [{ ...args[0], sessionId: origin.sessionId }];
      const permit = lease ? { ...lease, operationId: associatedAttempt ?? lease.operationId } : undefined;
      if (operation === 'checks.receive') args = [{ ...args[0], authority: { formatVersion: 1, permit } }];
      if (operation === 'checks.dispatch') args = [args[0], { formatVersion: 1, permit }];
      await models.deviceTasks.enqueue(actor, pair, { taskId, ...(associated ? { attemptId: associatedAttempt } : {}), operation: 'learning', formatVersion: 3,
        origin: { ...overriddenOrigin, ...(permit && associated ? { authority: permit } : {}) }, request: { identity: actor, operation, args } });
      await client.pollModelTasks(() => true);
      return (await models.deviceTasks.read(actor, pair, taskId)).receipt;
    }
    if (independent) {
      assert.equal((await task('selection.read', [])).value.version, 0);
      await models.origins.assert(actor, preparationIds[0], { ...origin, formatVersion: 3 });
      await assert.rejects(readFile(join(root, 'native-channel', connectionId, 'model-learning', preparationIds[0] + '.json')), { code: 'ENOENT' });
    }
    assert.equal((await task('segments.create', [{ requestId: randomUUID(), segmentId, purpose: 'learning', source: { connectionId: modelId, version: 1 }, prefix: { system: '', tools: [] }, portable: [] }])).ok, true);
    const receive = await task('checks.receive', [{ attemptId, segmentId, purpose: 'learning', expectedSequence: 0, input: { text: '解释', images: [], toolResults: [] }, limits: { maxOutputTokens: 256, timeoutMs: 30000 } }]);
    assert.equal(receive.value.state, 'accepted');
    if (independent) {
      const oldLease = structuredClone(runAuthority); retiredLease = oldLease;
      const journalPath = join(root, 'native-channel', connectionId, 'model-learning', attemptId + '.json');
      await models.origins.assert(actor, attemptId, { ...origin, formatVersion: 3, attemptId, authority: oldLease });
      await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
      const nextLease = { ...runAuthority, generation: runAuthority.generation + 1 };
      permittedLease = nextLease;
      const queried = await task('checks.read', [attemptId], origin, nextLease);
      assert.equal(queried.value.attemptId, attemptId); assert.equal(queried.value.state, 'accepted');
      assert.equal((await task('checks.read', [attemptId], origin, null)).value.state, 'accepted');
      await models.origins.assert(actor, attemptId, { ...origin, formatVersion: 3, attemptId, authority: nextLease });
      await assert.rejects(readFile(journalPath), { code: 'ENOENT' });
      assert.deepEqual(await task('checks.read', [attemptId], origin, { ...nextLease, runId: randomUUID() }), { ok: false, code: 'identity-conflict' });
      assert.deepEqual(await task('checks.read', [attemptId], origin, { ...nextLease, stepId: randomUUID() }), { ok: false, code: 'identity-conflict' });
      assert.deepEqual(await task('checks.dispatch', [attemptId], origin, oldLease), { ok: false, code: 'stale-generation' });
      assert.equal(calls, 0); assert.equal((await models.checks.read(actor, attemptId)).state, 'accepted');
      Object.assign(runAuthority, nextLease);
    }
    const dispatched = await task('checks.dispatch', [attemptId]);
    assert.equal(dispatched.ok, true); assert.notEqual(dispatched.value.state, 'accepted');
    assert.equal(dispatched.value.attemptId, attemptId);
    assert.deepEqual(dispatched.value.source, receive.value.source);
    assert.deepEqual(dispatched.value.segment, receive.value.segment);
    assert.equal(dispatched.value.physicalRequestEnded, false);
    await sdkStarted;
    if (independent) {
      assert.deepEqual(await task('checks.dispatch', [attemptId], origin, retiredLease), { ok: false, code: 'stale-generation' });
      assert.equal(calls, 1);
    }
    let blockedGrant;
    if (independent) {
      blockedGrant = { taskId: randomUUID(), operation: 'grant-create', ownerKind: 'self',
        input: { requestId: randomUUID(), grantId: randomUUID(), connectionId: modelId, owner: 'self' } };
      await models.deviceTasks.enqueue(actor, pair, blockedGrant);
      assert.equal((await models.deviceTasks.pending(actor, pair))[0].taskId, blockedGrant.taskId);
      grantPermitError = 'resource-busy';
    }
    // A retained transient at the queue head must not prevent a later query or
    // cancellation from reaching this already dispatched, real SDK request.
    assert.equal((await task('checks.read', [attemptId])).value.dispatched, true);
    assert.equal((await task('checks.cancel', [attemptId])).value.cancelRequested, true);
    for (let n = 0; n < 100 && !(await models.checks.read(actor, attemptId)).physicalRequestEnded; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await models.checks.read(actor, attemptId)).physicalRequestEnded, true);
    const { rows: [unknown] } = await storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [attemptId]);
    assert.equal(unknown.physical_held, true); assert.equal(unknown.upstream_ended, false);
    assert.equal(unknown.settled_units, null); assert.equal(unknown.settlement, 'unknown');
    assert.equal(calls, 1);
    if (blockedGrant) {
      assert.equal((await models.deviceTasks.read(actor, pair, blockedGrant.taskId)).receipt, null);
      grantPermitError = undefined;
      await client.pollModelTasks(() => true);
      assert.equal((await models.deviceTasks.read(actor, pair, blockedGrant.taskId)).receipt.ok, true);
    }
    assert.deepEqual(await task('checks.read', [attemptId], { ...origin, service: { ...origin.service, serviceId: randomUUID() } }),
      { ok: false, code: independent ? 'forbidden' : 'identity-conflict' });
    if (independent) {
      for (const changed of [{ ...origin, installationId: randomUUID() }, { ...origin, grantId: randomUUID() },
        { ...origin, service: { ...origin.service, environmentId: randomUUID() } }])
        assert.deepEqual(await task('checks.read', [attemptId], changed), { ok: false, code: 'forbidden' });
      const fixed = await models.origins.read(actor, attemptId);
      assert.equal(fixed.grantId, origin.grantId); assert.equal(fixed.installationId, origin.installationId);
      const { rows: authorizedOrigins } = await storage.read('SELECT grant_id FROM model_origin_authorizations WHERE association_id=$1', [attemptId]);
      assert.deepEqual(authorizedOrigins.map(row => row.grant_id), [origin.grantId], 'forged credentials never enter the origin authorization ledger');
      accessTarget = { ...localTarget, serviceId: randomUUID() };
      assert.deepEqual(await task('checks.read', [attemptId]), { ok: false, code: 'forbidden' });
      accessTarget = localTarget;
    }
    await assert.rejects(models.deviceTasks.enqueue(actor, pair, { taskId: randomUUID(), attemptId, operation: 'learning', formatVersion: 3,
      origin: { ...origin, authority: runAuthority, recoveryGeneration: randomUUID() }, request: { identity: actor, operation: 'checks.dispatch', args: [attemptId, { formatVersion: 1, permit: runAuthority }] } }), { code: 'stale-generation' });
    assert.equal(calls, 1);
    if (independent) {
      // The task has passed admission and returned its dispatch receipt. Revocation while
      // background deliver is preparing must still prevent the actual SDK request.
      const nextSegment = randomUUID(), nextAttempt = randomUUID();
      await task('segments.create', [{ requestId: randomUUID(), segmentId: nextSegment, purpose: 'learning',
        source: { connectionId: modelId, version: 1 }, prefix: { system: '', tools: [] }, portable: [] }]);
      await task('checks.receive', [{ attemptId: nextAttempt, segmentId: nextSegment, purpose: 'learning', expectedSequence: 0,
        input: { text: '外发前撤权', images: [], toolResults: [] }, limits: { maxOutputTokens: 256, timeoutMs: 30000 } }]);
      let entered, release;
      const enteredSend = new Promise(resolve => { entered = resolve; });
      const releaseSend = new Promise(resolve => { release = resolve; });
      beforeDispatch = async () => {
        const { rows: [row] } = await storage.read('SELECT state FROM model_attempts WHERE id=$1', [nextAttempt]);
        // Hold background delivery after its durable claim, not the synchronous
        // preflight that must finish before the dispatch receipt can return.
        if (row.state !== 'dispatched') return;
        entered(); await releaseSend;
      };
      try {
        assert.equal((await task('checks.dispatch', [nextAttempt])).ok, true);
        await enteredSend;
        permittedLease = { ...runAuthority, generation: runAuthority.generation + 1 };
      } finally { release(); }
      let refused;
      for (let n = 0; n < 100; n++) {
        refused = await models.checks.read(actor, nextAttempt);
        if (refused.physicalRequestEnded) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(refused.state, 'unknown'); assert.equal(refused.reason, 'result-unconfirmed');
      assert.equal(refused.physicalRequestEnded, true);
      assert.equal(calls, 1, 'cached task admission never replaces the live send permit');
      beforeDispatch = undefined;
      permittedLease = runAuthority;
      // Actual HTTP/SSE sends retain the dispatch task's ALS after its receipt.
      // Fresh checks must still reach the original source grant / device transport / activity.
      for (const revoked of ['agentGrant', 'activityAccess', 'deviceConnection']) {
        const agentGrant = await authority.authorize({ sourceEnvironmentId: origin.service.environmentId,
          sourceServiceId: origin.service.serviceId, sourceInstallationId: origin.installationId, capabilities: ['learning.authority'] });
        const source = { ...origin, grantId: agentGrant.grantId };
        verifyAgent = true; activityAllowed = true;
        const segmentId = randomUUID(), attemptId = randomUUID();
        await task('segments.create', [{ requestId: randomUUID(), segmentId, purpose: 'learning',
          source: { connectionId: modelId, version: 1 }, prefix: { system: '', tools: [] }, portable: [] }], source);
        assert.equal((await task('checks.receive', [{ attemptId, segmentId, purpose: 'learning', expectedSequence: 0,
          input: { text: '在途撤权', images: [], toolResults: [] }, limits: { maxOutputTokens: 256, timeoutMs: 30000 } }], source)).ok, true);
        const previous = calls;
        assert.equal((await task('checks.dispatch', [attemptId], source)).ok, true);
        const sentBy = Date.now() + 5000;
        while (calls === previous) {
          assert.ok(Date.now() < sentBy, 'SDK must actually send before revocation');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (revoked === 'agentGrant') await authority.revoke(agentGrant.grantId);
        else if (revoked === 'deviceConnection') await authority.revoke(authorized.grantId);
        else activityAllowed = false;
        const scope = { environmentId: actor.environmentId, spaceId: actor.spaceId, principalId: actor.principalId };
        const stoppedBy = Date.now() + 5000; let stopped;
        do {
          stopped = await models.checks.cleanup.status(scope, attemptId);
          assert.ok(Date.now() < stoppedBy, `${revoked} must stop the original SDK without another member task`);
          if (stopped.physicalRequestEnded) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        } while (true);
        assert.equal(stopped.cancelRequested, true); assert.equal(stopped.state, 'cancelled');
        const { rows: [unconfirmed] } = await storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [attemptId]);
        assert.equal(unconfirmed.physical_held, true); assert.equal(unconfirmed.upstream_ended, false);
        assert.equal(unconfirmed.settled_units, null); assert.equal(unconfirmed.settlement, 'unknown');
        assert.equal(calls, previous + 1);
      }
      const { rows: [held] } = await storage.read('SELECT count(*)::int AS n FROM model_learning_admissions WHERE physical_held');
      assert.equal(held.n, 4, 'all four aborted upstream calls retain their physical reservations');
    }
  } finally {
    models?.closeWrites(); await models?.checks.drain(); await storage?.close();
    upstream.closeAllConnections(); school.closeAllConnections();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => school.close(resolve))]); await fixture.close();
  }
});
