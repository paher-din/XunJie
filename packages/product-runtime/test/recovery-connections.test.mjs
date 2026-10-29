import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createProductRuntimeHost, openProductRuntime } from '@xunjie/product-runtime';

test('a receiver connected after host startup enters the same held boundary and cannot be added after freeze', async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 live receivers '));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };
  const a = openProductRuntime({ root: join(directory, 'source'), resources });
  const b = openProductRuntime({ root: join(directory, 'receiver'), resources });
  let hostA, hostB;
  try {
    const source = (await a.install({ profile: 'remote' })).environment;
    const receiver = (await b.install({ profile: 'remote' })).environment;
    hostA = await createProductRuntimeHost({ root: join(directory, 'source') });
    hostB = await createProductRuntimeHost({ root: join(directory, 'receiver') });
    const grant = await b.authorize({ sourceEnvironmentId: source.environmentId,
      sourceServiceId: source.services[0].serviceId, capabilities: ['runtime.status'] });
    const connection = { connectionId: randomUUID(), sourceEnvironmentId: source.environmentId,
      sourceServiceId: source.services[0].serviceId, target: receiver.services[0],
      requiredCapabilities: ['runtime.status'], optionalCapabilities: [], credentialRef: 'receiver' };
    await a.connect(connection, grant.token);
    const manifest = await hostA.recovery.backup({ directory: join(directory, 'backups'), key: randomBytes(32), leaveClosed: true });
    assert.deepEqual(manifest.receiverIds, [`${receiver.environmentId}/${receiver.services[0].serviceId}`]);
    await assert.rejects(a.connect({ ...connection, connectionId: randomUUID(), credentialRef: 'late-receiver' }, grant.token),
      error => error.code === 'configuration-in-maintenance');
  } finally {
    await hostA?.stop(); await hostB?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a confirmed source retirement can be read after process exit when the first reply was lost', async () => {
  const root = await mkdtemp(join(tmpdir(), '循阶 retired receipt '));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };
  const runtime = openProductRuntime({ root: join(root, 'source'), resources });
  let host;
  try {
    await runtime.install({ profile: 'remote' });
    host = await createProductRuntimeHost({ root: join(root, 'source') });
    const manifest = await host.recovery.backup({ directory: join(root, 'backups'), key: randomBytes(32), leaveClosed: true });
    const input = { backupId: manifest.backupId, targetInstallationId: randomUUID() };
    const proof = await host.recovery.retire(input);
    await host.stop(); host = undefined;
    assert.deepEqual(await runtime.recovery.retire(input), proof);
    await assert.rejects(runtime.recovery.retire({ ...input, targetInstallationId: randomUUID() }), error => error.code === 'retirement-conflict');
    await assert.rejects(runtime.start(), error => error.code === 'source-retired');
  } finally { await host?.stop(); await rm(root, { recursive: true, force: true }); }
});
