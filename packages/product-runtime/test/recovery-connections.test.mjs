import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createProductRuntimeHost, createOutboundConnection, openProductRuntime, restoreProductRecovery } from '@xunjie/product-runtime';

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

test('fencing a retired installation cuts the old instance off without voiding its successor', async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 installation fence '));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };
  const source = openProductRuntime({ root: join(directory, 'source'), resources });
  const receiver = openProductRuntime({ root: join(directory, 'receiver'), resources });
  let target;
  try {
    const sourceEnvironment = (await source.install({ profile: 'remote' })).environment;
    const receiverEnvironment = (await receiver.install({ profile: 'remote' })).environment;
    await receiver.start();
    const grant = await receiver.authorize({ sourceEnvironmentId: sourceEnvironment.environmentId,
      sourceServiceId: sourceEnvironment.services[0].serviceId,
      sourceInstallationId: sourceEnvironment.installationId, capabilities: ['runtime.status'] });
    assert.equal(grant.sourceInstallationId, sourceEnvironment.installationId);
    const connection = { connectionId: randomUUID(), sourceEnvironmentId: sourceEnvironment.environmentId,
      sourceServiceId: sourceEnvironment.services[0].serviceId, target: receiverEnvironment.services[0],
      requiredCapabilities: ['runtime.status'], optionalCapabilities: [], credentialRef: 'peer' };
    await source.connect(connection, grant.token);
    await source.start();
    assert.equal((await source.status()).state, 'ready');

    const key = randomBytes(32);
    await source.setCredential('recovery-key', key.toString('base64'));
    const manifest = await source.recovery.backup({ directory: join(directory, 'backups'),
      recoveryKeyRef: 'recovery-key', leaveClosed: true });
    assert.deepEqual(manifest.receiverIds, [`${receiverEnvironment.environmentId}/${receiverEnvironment.services[0].serviceId}`]);

    const restored = await restoreProductRecovery({ root: join(directory, 'target'),
      backupDirectory: join(directory, 'backups', manifest.backupId), key, resources,
      database: { mode: 'none' }, installation: { profile: 'remote' } });
    for (const owner of restored.owners) await owner.close?.();

    target = openProductRuntime({ root: join(directory, 'target'), resources });
    await target.start();
    const takeover = await target.recovery.takeover({ sourceRoot: join(directory, 'source'),
      receivers: [{ id: manifest.receiverIds[0], root: join(directory, 'receiver') }] });
    assert.equal(takeover.phase, 'active');

    // The retired installation is genuinely cut off at the receiving authority.
    const retired = await createOutboundConnection({ connection, credential: async () => grant.token,
      allowInsecureLoopback: true }).check();
    assert.equal(retired.state, 'unavailable');
    assert.equal(retired.reason, 'http_401');

    // The successor installation inherits no void dependency and stays serviceable.
    const inherited = await target.status();
    assert.equal(inherited.state, 'ready');
    assert.deepEqual(inherited.dependencies.map(item => item.name), []);

    // A fresh authorization for the successor installation restores the peer connection.
    const successor = (await target.status()).environment;
    const renewed = await receiver.authorize({ sourceEnvironmentId: successor.environmentId,
      sourceServiceId: successor.services[0].serviceId,
      sourceInstallationId: successor.installationId, capabilities: ['runtime.status'] });
    await target.connect({ ...connection, connectionId: randomUUID(), credentialRef: 'peer-renewed' }, renewed.token);
    const recovered = await target.status();
    assert.equal(recovered.state, 'ready');
    assert.deepEqual(recovered.dependencies.map(item => [item.name, item.state]),
      [[`client:${receiverEnvironment.services[0].serviceId}`, 'ready']]);
    // Fencing one installation does not release the retired one.
    assert.equal((await createOutboundConnection({ connection, credential: async () => grant.token,
      allowInsecureLoopback: true }).check()).reason, 'http_401');
  } finally {
    await target?.stop(); await source.stop(); await receiver.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
