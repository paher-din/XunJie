import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { createProductRuntimeHost, openProductRuntime, recoveryDatabase, createStorageRecoveryOwner,
  createStorageRecoveryTarget, restoreProductRecovery } from '@xunjie/product-runtime';
import { createStorageSample, sampleMigrations } from '../../../apps/server/dist/server/storage-sample/index.js';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to the pinned native PostgreSQL distribution.');
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };

test('native owner API, receipts, outbox identity and resource bytes survive an independent product restore', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 complete recovery '));
  const root = join(directory, 'source'), targetRoot = join(directory, 'target');
  const runtime = openProductRuntime({ root, resources });
  const serviceId = randomUUID(), key = randomBytes(32);
  const password = randomBytes(32).toString('base64url');
  let host, restoredStorage, recovered;
  try {
    const installed = await runtime.install({ profile: 'local', requiredServiceIds: [serviceId] });
    const owner = { environmentId: installed.environment.environmentId, serviceId };
    let service;
    host = await createProductRuntimeHost({ root, async createRecoveryOwners() {
      const binding = await provisionStorage({ admin: await recoveryDatabase(root), owner, password, migrations: sampleMigrations });
      const storage = await openStorage({ binding, migrations: sampleMigrations,
        backend: createFileBackend({ id: 'files', root: join(root, 'resources') }) });
      service = createStorageSample(storage);
      return [createStorageRecoveryOwner({ storage, binding, migrations: sampleMigrations, resources,
        resourceRoots: [join(root, 'resources')], validateService: async () => { assert.ok(await service.read('kept')); } })];
    } });
    const bytes = Buffer.from('原始工具字节\0\xff');
    const receipt = await service.save({ requestId: 'original-request', id: 'kept', expectedVersion: 0,
      body: { effect: 'unknown', externalRequestId: 'same-effect' }, uploadId: randomUUID(), bytes });
    const manifest = await host.recovery.backup({ directory: join(directory, 'backups'), key, leaveClosed: true });
    const result = await restoreProductRecovery({ root: targetRoot, backupDirectory: join(directory, 'backups', manifest.backupId),
      resources, key, targets: [createStorageRecoveryTarget({ owner, admin: async () => await recoveryDatabase(targetRoot),
        resources, backend: createFileBackend({ id: 'files', root: join(targetRoot, 'resources') }), migrations: sampleMigrations,
        onRestored(storage) { restoredStorage = storage; recovered = createStorageSample(storage); },
        async validateService() {
          assert.equal((await recovered.read('kept')).body.externalRequestId, 'same-effect');
          assert.deepEqual(await recovered.receipt('original-request'), receipt);
          assert.deepEqual(Buffer.from((await recovered.resource(receipt.result.resource.resourceId, 'kept')).bytes), bytes);
        },
      })] });
    assert.equal(result.manifest.backupId, manifest.backupId);
    await assert.rejects(restoredStorage.pendingIntents(), error => error.code === 'maintenance');
    await assert.rejects(recovered.save({ requestId: 'new', id: 'new', expectedVersion: 0, body: {} }), error => error.code === 'maintenance');
    assert.notEqual((await openProductRuntime({ root: targetRoot }).status()).environment.installationId, installed.environment.installationId);
  } finally {
    await restoredStorage?.close();
    await host?.stop();
    await openProductRuntime({ root: targetRoot }).stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
