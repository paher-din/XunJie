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
      sourceServiceId: source.services[0].serviceId, sourceInstallationId: source.installationId,
      capabilities: ['runtime.status'] });
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
    const sourceStatus = await source.status();
    assert.equal(sourceStatus.state, 'ready', JSON.stringify(sourceStatus.dependencies));

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

for (const boundTakeover of [false, true]) test(`product receiver waits for owner effects and ${boundTakeover ? 'resumes a verified takeover retry' : 'keeps a failed manual fence closed'}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xunjie-176-receiver-effects-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };
  const runtime = openProductRuntime({ root: join(directory, 'receiver'), resources });
  const environment = (await runtime.install({ profile: 'remote' })).environment;
  const serviceId = randomUUID();
  let releaseDrain, enterDrain;
  const drained = new Promise(resolve => { releaseDrain = resolve; });
  const entered = new Promise(resolve => { enterDrain = resolve; });
  let blocking = true, closed = false, host;
  const owner = {
    participant: {
      descriptor: { serviceId, schemaVersion: '1', resourceRoots: [], configurationRefs: [] },
      async closeWrites() { closed = true; }, async closeDispatch() { closed = true; },
      async drain() { enterDrain(); await drained; }, async validate() {}, async resume() { closed = false; },
    },
    async material({ boundaryAt }) {
      assert.equal(closed, true);
      return { formatVersion: 1, kind: 'test.effects', serviceId, schemaVersion: '1', boundaryAt,
        source: { environmentId: environment.environmentId, installationId: environment.installationId },
        coverage: 'service-received', unresolved: [], settled: 1, retained: { resources: 0, checkpoints: 0 },
        blocking: blocking ? [{ code: 'exit-unconfirmed', detail: 'The owned effect has not confirmed exit.' }] : [] };
    },
    async export() { throw new Error('Fencing must not export or run a new experiment.'); }, async release() {},
  };
  try {
    host = await createProductRuntimeHost({ root: join(directory, 'receiver'), recoveryOwners: [owner] });
    const source = { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID(),
      ...(boundTakeover ? { backupId: randomUUID(), targetInstallationId: randomUUID() } : {}) };
    await runtime.authorize({ ...source, capabilities: ['runtime.status'] });
    let finished = false;
    const attempt = runtime.recovery.fenceSource(source).finally(() => { finished = true; });
    // The HTTP capability already finished. The maintenance protocol still waits for its owner.
    await entered;
    assert.equal(finished, false);
    releaseDrain();
    await assert.rejects(attempt, { code: 'unconfirmed-receiver-boundary' });
    assert.equal(closed, true, 'failed evidence collection must not reopen the receiver');
    await assert.rejects(runtime.authorize({ ...source, capabilities: ['runtime.status'] }),
      { code: 'source_installation_retired' });
    blocking = false;
    const proof = await runtime.recovery.fenceSource(source);
    assert.equal(proof.execution.blocking, 0);
    assert.deepEqual(proof.execution.services.find(item => item.serviceId === serviceId),
      { serviceId, unresolved: 0, settled: 1, blocking: 0 });
    assert.equal(closed, !boundTakeover, 'only a fully bound takeover retry may resume its receiver');
    if (!boundTakeover) await host.maintenance.resume();
    assert.equal(closed, false);
  } finally {
    releaseDrain();
    await host?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('receiver backup and independent recovery preserve permanent installation rejections', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xunjie-176-retirement-restore-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };
  const receiverRoot = join(directory, 'receiver'), targetRoot = join(directory, 'recovered-receiver');
  const receiver = openProductRuntime({ root: receiverRoot, resources });
  const target = openProductRuntime({ root: targetRoot, resources });
  const source = { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID() };
  const key = randomBytes(32);
  let restored;
  try {
    await receiver.install({ profile: 'remote' });
    await receiver.start();
    await receiver.authorize({ ...source, capabilities: ['runtime.status'] });
    await receiver.recovery.fenceSource(source);
    await receiver.setCredential('test-backup-key', key.toString('base64'));
    const manifest = await receiver.recovery.backup({ directory: join(directory, 'backups'),
      recoveryKeyRef: 'test-backup-key', leaveClosed: true });
    restored = await restoreProductRecovery({ root: targetRoot, resources,
      backupDirectory: join(directory, 'backups', manifest.backupId), key });
    for (const owner of restored.owners) await owner.close?.();
    restored = undefined;
    await target.start();
    await target.recovery.takeover({ sourceRoot: receiverRoot, receivers: [] });
    await assert.rejects(target.authorize({ ...source, capabilities: ['runtime.status'] }), { code: 'source_installation_retired' });
    await target.authorize({ ...source, sourceInstallationId: randomUUID(), capabilities: ['runtime.status'] });
    await assert.rejects(target.authorize({ ...source, capabilities: ['runtime.status'] }), { code: 'source_installation_retired' });
    await target.stop(); await target.start();
    await assert.rejects(target.authorize({ ...source, capabilities: ['runtime.status'] }), { code: 'source_installation_retired' });
  } finally {
    for (const owner of restored?.owners ?? []) await owner.close?.();
    await Promise.allSettled([receiver.stop(), target.stop()]);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
