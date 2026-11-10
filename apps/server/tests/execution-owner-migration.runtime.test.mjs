import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createFileBackend, openStorage, provisionStorage, prepareStorageRestore, finalizeStorageRestore } from '@xunjie/storage';
import { createExecutionOwner, executionOwnerMigrations } from '@xunjie/learning-space';
import { courseExecutionPlanBasis, executionActionSchema, canonicalValue } from '@xunjie/contracts/execution';
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => sha(JSON.stringify(canonicalValue(value)));

test('an authenticated local study move retains old execution identities and results across restart and isolated restore', { timeout: 120000 }, async () => {
  const fixture = await nativeFixture();
  let storage, recovery, restored;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: executionOwnerMigrations });
    const options = { binding, migrations: executionOwnerMigrations, backend: createFileBackend({ id: 'execution', root: join(fixture.root, 'originals') }) };
    storage = await openStorage(options);
    const identity = { kind: 'school', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), name: 'student' };
    const { manifest } = await aggregationPackage();
    const component = { key: 'table', definition: { manifest, digest: hash(manifest) }, configuration: { title: 'original component' }, materialIds: [] };
    const plan = { planId: 'retained-browser', planVersion: 1, planDigest: '0'.repeat(64),
      components: [{ key: 'table', definitionDigest: component.definition.digest, configurationDigest: hash(component.configuration), operations: ['aggregate'] }],
      capabilities: ['execution.submit'], resources: { browser: { features: ['worker', 'webassembly'] }, native: null }, locations: ['browser'], remote: null };
    plan.planDigest = hash(courseExecutionPlanBasis(plan));
    const source = { activityId: randomUUID(), identity, target: { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 },
      goal: 'retain original result', question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
      course: { associationId: randomUUID(), courseId: randomUUID(), taskId: randomUUID(), releaseId: randomUUID(), contentDigest: 'a'.repeat(64),
        courseName: 'original', taskTitle: 'original', objectives: ['retain original results'], requirements: 'retain exact originals', materials: [], starterWorks: [], capabilities: [],
        components: [component], executionPlan: plan, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } } };
    let current = source, migrationAllowed = false;
    const assemble = (owned = storage) => createExecutionOwner(owned, { activity: async (actor, id) => {
      for (const key of ['kind', 'environmentId', 'spaceId', 'principalId']) assert.equal(actor[key], identity[key]);
      assert.equal(id, source.activityId); return current;
    }, sourceFile: async () => { throw new Error('No source files in this command'); },
      migratedActivity: async () => migrationAllowed ? source : null });
    let execution = assemble();
    const command = () => {
      const requestId = randomUUID(), action = executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId,
        scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId: source.activityId },
        receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' }, execution: {
          instance: { instanceId: source.activityId + ':table', key: 'table', componentId: manifest.componentId,
            componentVersion: manifest.version, definitionDigest: component.definition.digest, hostApiVersion: 1, stateVersion: manifest.stateVersion },
          operation: { operationId: 'aggregate', effect: 'execute' }, parameters: {},
          basis: { works: [], state: null, expected: { stateContentId: null }, resources: [{ kind: 'entry', ...manifest.entry }, { kind: 'algorithm', ...manifest.algorithm.resource }] },
          limits: { timeMs: 5000, memoryPages: 256, inputBytes: 1048576, outputBytes: 65536, concurrentJobs: 1, queuedJobs: 4 },
          plan: { planId: 'browser-job', planVersion: 1, location: 'browser', kind: 'job', planDigest: hash({ planId: 'browser-job', planVersion: 1,
            componentId: manifest.componentId, componentVersion: manifest.version, operationId: 'aggregate' }) },
          initiator: { kind: 'student', principalId: identity.principalId } } });
      return { action, acceptance: { receipt: { requestId, inputDigest: sha(JSON.stringify(action)), receiver: action.receiver,
        state: 'accepted', receiptId: 'original:' + requestId, detail: '' }, execution: { executionRef: randomUUID(), acceptedSeq: 1 } } };
    };
    const input = command(), accepted = await execution.executions.accept(identity, source.activityId, input);
    const running = await execution.executions.report(identity, source.activityId, input.action.requestId, { ...accepted, state: 'running', confirmedSeq: 2 });
    const text = '\ufefforiginal result\r\n中文🙂';
    const saved = await execution.executions.result(identity, source.activityId, input.action.requestId,
      { contentId: randomUUID(), name: 'result.txt', mediaType: 'text/plain', text, output: { mean: 3 }, sha256: sha(text), byteLength: Buffer.byteLength(text) });
    const terminal = await execution.executions.report(identity, source.activityId, input.action.requestId,
      { ...running, output: saved.output, state: 'succeeded', confirmedSeq: 3 });
    const originalRows = (await storage.read('SELECT * FROM execution_commands')).rows;
    current = { ...source, target: { environmentId: owner.environmentId, serviceId: randomUUID(), version: 1 } };
    await assert.rejects(execution.open(identity, source.activityId), { code: 'identity-conflict' }, 'an arbitrary target replacement still fails');
    migrationAllowed = true;
    assert.deepEqual(await execution.executions.read(identity, source.activityId, input.action.requestId), terminal);
    assert.equal((await execution.executions.artifact(identity, source.activityId, input.action.requestId)).text, text);
    assert.deepEqual((await storage.read('SELECT * FROM execution_commands')).rows, originalRows, 'original commands must never be rewritten or replayed');
    assert.deepEqual(await storage.pendingIntents(), []);
    await execution.validate();
    await storage.close(); storage = await openStorage(options); execution = assemble();
    assert.deepEqual(await execution.executions.read(identity, source.activityId, input.action.requestId), terminal);
    assert.deepEqual(await execution.executions.read({ ...identity, name: 'renamed school' }, source.activityId, input.action.requestId), terminal);
    await execution.validate();
    const next = command();
    assert.equal((await execution.executions.accept(identity, source.activityId, next)).requestId, next.action.requestId);
    await storage.participant().closeWrites(); await storage.participant().closeDispatch();
    recovery = await nativeFixture();
    const backend = createFileBackend({ id: 'execution', root: join(recovery.root, 'originals') });
    const run = promisify(execFile), dump = join(fixture.root, 'execution.dump');
    async function pgTool(server, name, args) {
      const c = server.admin;
      try { await run(server.tool(name), ['-h', c.host, '-p', String(c.port), '-U', c.user, '-d', c.database, ...args],
        { env: { ...process.env, PGPASSWORD: c.password }, timeout: 30000 }); }
      catch { throw new Error(name + ' failed'); }
    }
    let backup;
    await storage.snapshot('execution-target-move', async snapshot => {
      backup = snapshot.manifest;
      await pgTool(fixture, 'pg_dump', ['-Fc', '-n', binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
      for (const ref of backup.resources) await backend.put(ref.locator.key, await storage.readResourceObject(ref.resourceId));
    });
    const recoveredBinding = await prepareStorageRestore({ admin: recovery.admin, owner, password: randomUUID() });
    await pgTool(recovery, 'pg_restore', ['--exit-on-error', '--role', recoveredBinding.migratorRole, '--no-owner', '--no-acl', dump]);
    restored = await finalizeStorageRestore({ admin: recovery.admin, binding: recoveredBinding, migrations: executionOwnerMigrations, manifest: backup, backend });
    await restored.participant().resume();
    const recovered = assemble(restored);
    await recovered.validate();
    assert.deepEqual(await recovered.executions.read(identity, source.activityId, input.action.requestId), terminal);
    assert.equal((await recovered.executions.artifact(identity, source.activityId, input.action.requestId)).text, text);
    assert.equal((await restored.read('SELECT count(*)::int AS n FROM execution_activity_target_migrations')).rows[0].n, 1);
    assert.deepEqual(await restored.pendingIntents(), []);
    await storage.participant().resume();
    current = { ...current, target: { ...current.target, serviceId: randomUUID() } };
    await assert.rejects(execution.open(identity, source.activityId), { code: 'identity-conflict' }, 'the same source proof cannot authorize another target');
  } finally { await restored?.close(); await storage?.close(); await recovery?.close(); await fixture.close(); }
});
