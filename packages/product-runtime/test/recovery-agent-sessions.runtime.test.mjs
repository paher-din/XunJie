import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { createChunkChannel, createChunkClient } from '@xunjie/storage/chunk-channel';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentRuntime } from '@xunjie/agent-runtime';
import { collectAgentRuntimeBoundary, collectAgentRuntimeReceiverBoundary, validateAgentRuntimeBoundary } from '@xunjie/agent-runtime/maintenance';
import { agentServiceMigrations, collectAgentServiceSources, validateAgentServiceSources, validateAgentServiceStorage } from '@xunjie/agents/transport/session-storage';
import { createMaintenanceCoordinator } from '../dist/maintenance.js';
import { createRecoveryManager, restoreRecoverySet } from '../dist/recovery.js';
import { createStorageRecoveryOwner, createStorageRecoveryTarget } from '../dist/storage-recovery.js';

test('a disabled Agent owner backs up and restores a home session and full service sources without an activity', { timeout: 120000 }, async t => {
  const sourcePg = await nativeFixture(), targets = [], handles = [], runtimes = [];
  const directory = await mkdtemp(join(tmpdir(), 'xunjie-session-recovery-'));
  t.after(async () => {
    try {
      for (const runtime of runtimes) await runtime.close();
      for (const storage of handles.reverse()) await storage.close();
    } finally {
      for (const pg of targets.reverse()) await pg.close();
      await sourcePg.close(); await rm(directory, { recursive: true, force: true });
    }
  });
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() }, installationId = randomUUID();
  const resources = { postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN };
  const binding = await provisionStorage({ admin: sourcePg.admin, owner, password: randomUUID(), migrations: agentServiceMigrations });
  const storage = await openStorage({ binding, migrations: agentServiceMigrations,
    backend: createFileBackend({ id: 'agent', root: join(sourcePg.root, 'objects') }) }); handles.push(storage);
  const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
  const runtime = createAgentRuntime(storage, { authorize: async () => {} }); runtimes.push(runtime);
  const sessionId = randomUUID();
  await runtime.initialize({ sessionId, identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
  const caller = { grantId: randomUUID(), sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID() };
  const channel = createChunkChannel(storage).wrap(call => runtime.accept(identity, call.args.input));
  const send = createChunkClient(value => channel(value, caller));
  const input = { requestId: randomUUID(), sessionId, text: '原始主页输入'.repeat(30000), mode: 'steering', context: {} };
  const receipt = await send({ version: 2, operation: 'accept', identity, sessionId, args: { input } },
    { transferId: randomUUID(), durable: true, acknowledge: false });
  // The service is disabled: recovery must use its durable owner APIs, with no live model/data dependency.
  await runtime.close();
  let omitTransport = false;
  const recoveryOwner = createStorageRecoveryOwner({ storage, binding, migrations: agentServiceMigrations, resources,
    installationId, boundary: collectAgentRuntimeBoundary, receiverBoundary: collectAgentRuntimeReceiverBoundary,
    validateService: validateAgentServiceStorage, sources: async current => {
      const sources = await collectAgentServiceSources(current);
      return omitTransport ? { ...sources, entries: sources.entries.filter(entry => !entry.kind.startsWith('agent_chunk_')) } : sources;
    } });
  const environment = { formatVersion: 1, environmentId: owner.environmentId, installationId, clientNamespace: 'session-recovery', profile: 'agent',
    services: [{ ...owner, unit: 'teaching-agent', endpoint: 'http://127.0.0.1:1', protocolVersion: 1, capabilities: [] }] };
  const maintenance = createMaintenanceCoordinator({ requiredServiceIds: [owner.serviceId], record: async () => {} });
  maintenance.register(recoveryOwner.participant);
  const manager = createRecoveryManager({ root: join(directory, 'source'), environment, maintenance,
    owners: [recoveryOwner], requiredServiceIds: [owner.serviceId] });
  const key = randomBytes(32), backups = join(directory, 'backups');
  const manifest = await manager.backup({ directory: backups, key, leaveClosed: true });
  assert.deepEqual(manifest.boundary.services, [{ serviceId: owner.serviceId, kind: 'xunjie.agent-runtime.boundary/2',
    unresolved: 1, settled: 0, blocking: 0 }]);
  assert.ok(!JSON.stringify(manifest).includes(sessionId), 'the public manifest contains aggregates only');
  const captured = [];
  async function restore(backup, targetRoot) {
    const pg = await nativeFixture(); targets.push(pg);
    const target = createStorageRecoveryTarget({ owner, admin: async () => pg.admin, resources,
      installationId: randomUUID(), migrations: agentServiceMigrations,
      backend: createFileBackend({ id: 'agent', root: join(pg.root, 'objects') }),
      onRestored(current) { handles.push(current); },
      boundary: collectAgentRuntimeBoundary, receiverBoundary: collectAgentRuntimeReceiverBoundary,
      validateService: validateAgentServiceStorage, validateMaterial: validateAgentRuntimeBoundary,
      sources: collectAgentServiceSources, validateSources: async (current, sources) => {
        captured.push(sources); await validateAgentServiceSources(current, sources);
      } });
    return restoreRecoverySet({ backupDirectory: join(backups, backup.backupId), targetRoot, key, targets: [target] });
  }
  const targetRoot = join(directory, 'restored');
  const result = await restore(manifest, targetRoot);
  assert.equal(result.manifest.backupId, manifest.backupId);
  assert.equal(captured[0].owner, 'xunjie.agent-service');
  assert.ok(captured[0].entries.some(entry => entry.kind === 'agent_chunk_parts' && entry.resources.length));
  const restored = handles.at(-1), recovered = createAgentRuntime(restored, { authorize: async () => {}, readOnly: true }); runtimes.push(recovered);
  assert.deepEqual(await recovered.request(identity, sessionId, input.requestId), { receipt, input });
  const boundary = await collectAgentRuntimeBoundary(restored);
  assert.equal(boundary.unresolved[0].sessionId, sessionId);
  assert.equal(boundary.unresolved[0].activityId, undefined);
  assert.equal(JSON.parse(await readFile(join(targetRoot, 'recovery-state.json'), 'utf8')).phase, 'isolated');
  await assert.rejects(recovered.accept(identity, { ...input, requestId: randomUUID() }), { code: 'maintenance' });

  await manager.resume(); omitTransport = true;
  const incomplete = await manager.backup({ directory: backups, key, leaveClosed: true });
  const failedRoot = join(directory, 'incomplete-closure');
  await assert.rejects(restore(incomplete, failedRoot), { code: 'corrupt' });
  assert.equal(captured.length, 2, 'the target actually invokes the full service closure validator');
  assert.ok(!captured[1].entries.some(entry => entry.kind === 'agent_chunk_parts'));
  assert.equal(JSON.parse(await readFile(join(failedRoot, 'recovery-state.json'), 'utf8')).phase, 'failed');
});
