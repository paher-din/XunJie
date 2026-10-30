import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createOutboundConnection, createProductRuntimeHost, createRecoveryManager, openProductRuntime, restoreProductRecovery } from '@xunjie/product-runtime';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };

test('two remote environments own separate identities, processes and data through uninstall', async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 runtime '));
  const a = openProductRuntime({ root: join(directory, '环境 A'), resources });
  const b = openProductRuntime({ root: join(directory, '环境 B'), resources });
  try {
    const installedA = await a.install({ profile: 'remote' });
    const installedB = await b.install({ profile: 'remote' });
    assert.notEqual(installedA.environment.environmentId, installedB.environment.environmentId);
    assert.notEqual(installedA.environment.clientNamespace, installedB.environment.clientNamespace);
    assert.equal(await a.database(), null);
    const startedA = await a.start();
    const startedB = await b.start();
    assert.equal(startedA.state, 'ready');
    assert.equal(startedB.state, 'ready');
    assert.notEqual(startedA.endpoint, startedB.endpoint);
    assert.equal((await a.start()).endpoint, startedA.endpoint);
    assert.match(await (await fetch(startedA.endpoint)).text(), /循阶/);
    const wire = await (await fetch(new URL('/runtime/environment', startedA.endpoint))).json();
    assert.equal(wire.environmentId, installedA.environment.environmentId);
    assert.equal(wire.clientNamespace, installedA.environment.clientNamespace);
    await a.uninstall();
    assert.equal((await a.status()).state, 'uninstalled');
    assert.equal((await b.status()).state, 'ready');
    const environmentFile = join(directory, '环境 A', 'environment.json');
    assert.equal(JSON.parse(await readFile(environmentFile, 'utf8')).environmentId, wire.environmentId);
    await a.install({ profile: 'remote' });
    assert.equal((await a.start()).environment.environmentId, wire.environmentId);
    await assert.rejects(a.deleteEnvironment({ environmentId: installedB.environment.environmentId }), /identity/i);
    assert.equal((await b.status()).state, 'ready');
    await a.deleteEnvironment({ environmentId: wire.environmentId });
    assert.equal((await b.status()).state, 'ready');
  } finally {
    await Promise.allSettled([a.stop(), b.stop()]);
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of ['retired', 'isolated']) {
  test(`deleting a ${scenario} environment clears its state and permits a fresh authorized installation`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `循阶 delete ${scenario} `));
    const root = join(directory, 'environment');
    // A separately owned environment may live below the selected root. Deletion
    // must remove owned entries, not recursively empty the entire root.
    const peerRoot = join(root, 'other-environment');
    const peer = openProductRuntime({ root: peerRoot, resources });
    const sourceRoot = scenario === 'retired' ? root : join(directory, 'source');
    const source = openProductRuntime({ root: sourceRoot, resources });
    const runtime = scenario === 'retired' ? source : openProductRuntime({ root, resources });
    const backupDirectory = join(directory, 'backups');
    const externalDatabase = join(directory, 'external-postgres');
    const key = randomBytes(32);
    try {
      const original = (await source.install({ profile: 'remote' })).environment;
      assert.equal((await source.start()).state, 'ready');
      await source.setCredential('backup-key', key.toString('base64'));
      await source.recovery.configure({ directory: backupDirectory, recoveryKeyRef: 'backup-key',
        intervalMs: 60_000, keep: 1, minimumFreeBytes: 0 });
      const manifest = await source.recovery.backup({ leaveClosed: true });
      const backupRoot = join(backupDirectory, manifest.backupId);
      const backupFiles = (await readdir(backupRoot, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
      const backupBytes = await Promise.all(backupFiles.map(path => readFile(path)));
      if (scenario === 'isolated') {
        await restoreProductRecovery({ root, backupDirectory: backupRoot, key, resources });
        assert.equal((await runtime.start()).state, 'maintenance');
        await runtime.setCredential('backup-key', key.toString('base64'));
        await runtime.recovery.configure({ directory: backupDirectory, recoveryKeyRef: 'backup-key',
          intervalMs: 60_000, keep: 1, minimumFreeBytes: 0 });
        await writeFile(join(root, 'last-backup-settings.json'), JSON.stringify({
          directory: backupDirectory, recoveryKeyRef: 'backup-key' }));
      }
      const oldEnvironment = (await runtime.status()).environment;
      const peerEnvironment = (await peer.install({ profile: 'remote' })).environment;
      assert.equal((await peer.start()).state, 'ready');
      const authorization = { sourceEnvironmentId: peerEnvironment.environmentId,
        sourceServiceId: peerEnvironment.services[0].serviceId, capabilities: ['runtime.status'] };
      const oldGrant = await runtime.authorize(authorization);
      const check = (target, token) => createOutboundConnection({
        connection: { connectionId: randomUUID(), ...authorization, target,
          requiredCapabilities: ['runtime.status'], optionalCapabilities: [], credentialRef: 'deletion-test' },
        credential: async () => token, allowInsecureLoopback: true,
      }).check();
      // The retired source is already held closed. A separate live authority on
      // the peer proves real authorization/transport before testing rejection.
      const peerGrant = await peer.authorize(authorization);
      assert.equal((await check(peerEnvironment.services[0], peerGrant.token)).state, 'ready');
      await runtime.recovery.fenceSource({ sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID() });
      if (scenario === 'retired') {
        await source.recovery.resume();
        assert.equal((await check(oldEnvironment.services[0], oldGrant.token)).state, 'ready');
        const held = await source.recovery.backup({ leaveClosed: true, keep: 2 });
        await source.recovery.retire({ backupId: held.backupId, targetInstallationId: randomUUID() });
        await assert.rejects(source.start(), { code: 'source-retired' });
      }

      // Residue from interrupted initialization, restore and atomic journal writes
      // must not survive explicit deletion or reference newly issued credentials.
      const initialization = `initializing-${randomUUID()}`;
      const restoration = `.restore-${randomUUID()}`;
      const upgrade = `upgrade-${randomUUID()}.json`;
      const decryption = await mkdtemp(join(root, '.xj-recovery-'));
      await writeFile(join(decryption, 'partial'), randomBytes(32));
      for (const name of [initialization, restoration]) {
        await mkdir(join(root, name));
        await writeFile(join(root, name, 'partial'), randomBytes(32));
      }
      for (const name of ['preparing-database.json', 'initdb-password', upgrade,
        `installation.json.${randomUUID()}.tmp`, `recovery-state.json.${randomUUID()}.tmp`, `${upgrade}.${randomUUID()}.tmp`]) {
        await writeFile(join(root, name), JSON.stringify({ directory: initialization, backupDirectory, externalDatabase }));
      }
      await mkdir(externalDatabase);
      await writeFile(join(externalDatabase, 'PG_VERSION'), '18\n');
      await writeFile(join(root, '.locks', 'preserved'), 'permanent lock root');
      const rootMarker = await stat(join(root, '.xunjie-root'));
      const lockDirectory = await stat(join(root, '.locks'));

      await runtime.deleteEnvironment({ environmentId: oldEnvironment.environmentId });
      assert.deepEqual((await readdir(root)).sort(), ['.locks', '.xunjie-root', 'other-environment']);
      assert.equal((await stat(join(root, '.xunjie-root'))).ino, rootMarker.ino);
      assert.equal((await stat(join(root, '.locks'))).ino, lockDirectory.ino);
      assert.equal(await readFile(join(root, '.locks', 'preserved'), 'utf8'), 'permanent lock root');
      assert.equal(await readFile(join(externalDatabase, 'PG_VERSION'), 'utf8'), '18\n');
      assert.deepEqual(await Promise.all(backupFiles.map(path => readFile(path))), backupBytes);
      assert.equal((await peer.status()).state, 'ready');
      assert.equal((await check(peerEnvironment.services[0], peerGrant.token)).state, 'ready');

      const fresh = (await runtime.install({ profile: 'remote' })).environment;
      assert.notEqual(fresh.environmentId, oldEnvironment.environmentId);
      assert.notEqual(fresh.installationId, oldEnvironment.installationId);
      assert.notEqual(fresh.clientNamespace, oldEnvironment.clientNamespace);
      assert.notEqual(fresh.services[0].serviceId, oldEnvironment.services[0].serviceId);
      assert.notEqual(fresh.environmentId, original.environmentId);
      assert.equal((await runtime.start()).state, 'ready');
      const rejected = await check(fresh.services[0], oldGrant.token);
      assert.equal(rejected.state, 'unavailable');
      assert.equal(rejected.reason, 'http_401');
      const freshGrant = await runtime.authorize(authorization);
      assert.equal((await check(fresh.services[0], freshGrant.token)).state, 'ready');
    } finally {
      await Promise.allSettled([runtime.stop(), source === runtime ? Promise.resolve() : source.stop(), peer.stop()]);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('delete preserves pending and retiring cleanup until a late export pin is released', {
  // Windows verifies process creation identities through native PowerShell calls.
  // Keep the export's 40 ms fault deadline while allowing the full OS lifecycle.
  timeout: process.platform === 'win32' ? 120_000 : 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 delete late export '));
  const root = join(directory, 'environment');
  const backups = join(directory, 'backups');
  const pinFile = join(directory, 'external-owner-pin');
  const runtime = openProductRuntime({ root, resources });
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), attemptedRelease = Promise.withResolvers();
  let host, manager, exporting, backup;
  let canRelease = false;
  let backupId;
  try {
    const { environment } = await runtime.install({ profile: 'remote' });
    host = await createProductRuntimeHost({ root });
    assert.equal((await runtime.status()).state, 'ready');
    // A public manager shares the real host's maintenance boundary. Control its
    // owner export so timeout and late pin creation have deterministic ordering.
    const descriptor = host.maintenance.status().participants[0];
    const owner = {
      participant: { descriptor, async closeWrites() {}, async closeDispatch() {}, async drain() {}, async validate() {}, async resume() {} },
      export(input) {
        return exporting = (async () => {
          backupId = input.backupId; entered.resolve(); await finish.promise;
          await writeFile(pinFile, backupId);
          await writeFile(join(input.directory, 'state'), 'late export');
          return { formatVersion: 1, schemaVersion: descriptor.schemaVersion, data: {} };
        })();
      },
      async release(id) {
        assert.equal(id, backupId);
        assert.ok(!(await readdir(backups)).includes(id), 'retire the directory before releasing its pin');
        assert.equal(await readFile(pinFile, 'utf8'), id);
        attemptedRelease.resolve();
        if (!canRelease) throw new Error('owner release temporarily unavailable');
        await rm(pinFile);
      },
    };
    manager = createRecoveryManager({ root, environment, maintenance: host.maintenance, owners: [owner],
      requiredServiceIds: [descriptor.serviceId], timeoutMs: 40 });
    backup = assert.rejects(manager.backup({ directory: backups, key: randomBytes(32) }), { code: 'timeout' });
    await entered.promise; await backup;
    const journalPath = join(root, 'recovery-operations', `${backupId}.json`);
    const identity = await readFile(join(root, 'environment.json'));
    const installation = await readFile(join(root, 'installation.json'));
    await assert.rejects(runtime.deleteEnvironment({ environmentId: environment.environmentId }), { code: 'backup-cleanup-pending' });
    const pending = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(pending.cleanup.disposition, 'pending');
    assert.equal(pending.cleanup.producer.pid, process.pid);
    assert.deepEqual(await readFile(join(root, 'environment.json')), identity);
    assert.deepEqual(await readFile(join(root, 'installation.json')), installation);
    assert.equal((await runtime.status()).state, 'maintenance', 'refused deletion must not stop the owner host');

    finish.resolve(); await attemptedRelease.promise;
    // Deletion must also reject after the producer has settled: a failed release
    // still needs its journal even though the recovery lock is no longer held.
    await assert.rejects(runtime.deleteEnvironment({ environmentId: environment.environmentId }), { code: 'backup-cleanup-pending' });
    const retiring = JSON.parse(await readFile(journalPath, 'utf8'));
    assert.equal(retiring.cleanup.disposition, 'retiring');
    assert.equal(retiring.cleanup.producer, undefined);
    assert.equal(await readFile(pinFile, 'utf8'), backupId);
    assert.deepEqual(await readdir(backups), [`.retired-${backupId}`]);
    assert.deepEqual(await readFile(join(root, 'environment.json')), identity);
    assert.deepEqual(await readFile(join(root, 'installation.json')), installation);

    canRelease = true;
    await manager.cleanup();
    assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).cleanup.disposition, 'released');
    await assert.rejects(readFile(pinFile), { code: 'ENOENT' });
    assert.deepEqual(await readdir(backups), []);
    await runtime.deleteEnvironment({ environmentId: environment.environmentId });
    host = undefined;
    assert.deepEqual((await readdir(root)).sort(), ['.locks', '.xunjie-root']);
    const fresh = (await runtime.install({ profile: 'remote' })).environment;
    assert.notEqual(fresh.environmentId, environment.environmentId);
    assert.notEqual(fresh.installationId, environment.installationId);
    assert.equal((await runtime.start()).state, 'ready');
    assert.deepEqual(await readdir(backups), []);
  } finally {
    canRelease = true; finish.resolve();
    await exporting?.catch(() => {});
    await backup?.catch(() => {});
    await manager?.cleanup().catch(() => {});
    await runtime.stop().catch(() => {});
    await host?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent starts share an instance and a foreign web listener is never stopped', async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 并发 '));
  const runtime = openProductRuntime({ root: join(directory, 'concurrent'), resources });
  const foreign = createServer(socket => socket.destroy());
  const conflicting = openProductRuntime({ root: join(directory, 'conflict'), resources });
  try {
    await runtime.install({ profile: 'remote' });
    const starts = await Promise.all(Array.from({ length: 4 }, () => runtime.start()));
    assert.equal(new Set(starts.map(value => value.endpoint)).size, 1);
    await new Promise(done => foreign.listen(0, '127.0.0.1', done));
    await conflicting.install({ profile: 'remote', port: foreign.address().port });
    await assert.rejects(conflicting.start(), /EADDRINUSE|address.*in use/i);
    await conflicting.stop();
    assert.equal(foreign.listening, true);
    assert.equal((await runtime.status()).state, 'ready');
  } finally {
    await Promise.allSettled([runtime.stop(), conflicting.stop()]);
    await new Promise(done => foreign.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});

test('optional capabilities degrade readiness, and revoked required connections fail without changing ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 连接 '));
  const a = openProductRuntime({ root: join(directory, 'component'), resources });
  const b = openProductRuntime({ root: join(directory, 'school'), resources });
  try {
    const { environment: source } = await a.install({ profile: 'remote' });
    const { environment: target } = await b.install({ profile: 'remote' });
    await b.start();
    const grant = await b.authorize({ sourceEnvironmentId: source.environmentId,
      sourceServiceId: source.services[0].serviceId, capabilities: ['runtime.status'] });
    await a.connect({ connectionId: randomUUID(), sourceEnvironmentId: source.environmentId,
      sourceServiceId: source.services[0].serviceId, target: target.services[0],
      requiredCapabilities: ['runtime.status'], optionalCapabilities: ['model.not-configured'], credentialRef: 'school-test' }, grant.token);
    const started = await a.start();
    assert.equal(started.state, 'degraded');
    assert.equal(started.dependencies.find(value => value.required).state, 'ready');
    assert.equal(started.dependencies.find(value => !value.required).state, 'unavailable');
    await b.revoke(grant.grantId);
    assert.equal((await a.status()).state, 'failed');
    await b.stop();
    await b.start();
    const rejected = await a.status();
    assert.equal(rejected.state, 'failed');
    assert.equal(rejected.environment.environmentId, source.environmentId);
    assert.equal((await b.status()).environment.environmentId, target.environmentId);
  } finally {
    await Promise.allSettled([a.stop(), b.stop()]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('an occupied directory is preserved instead of adopted or reinitialized', async () => {
  const root = await mkdtemp(join(tmpdir(), '循阶 occupied '));
  await writeFile(join(root, 'existing.sqlite'), 'unrelated original data');
  try {
    await assert.rejects(openProductRuntime({ root, resources }).install({ profile: 'remote' }), /Directory is occupied;/);
    assert.equal(await readFile(join(root, 'existing.sqlite'), 'utf8'), 'unrelated original data');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a composed host can stop from an already confirmed backup maintenance boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), '循阶 maintenance stop '));
  const runtime = openProductRuntime({ root, resources });
  let host;
  try {
    await runtime.install({ profile: 'remote' });
    host = await createProductRuntimeHost({ root });
    assert.equal((await host.maintenance.enter('backup')).safeToStop, true);
    await host.stop();
    host = undefined;
    assert.equal((await runtime.status()).state, 'stopped');
  } finally {
    await host?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a target in maintenance makes a required outbound capability unavailable until it reopens', async () => {
  const directory = await mkdtemp(join(tmpdir(), '循阶 maintenance connection '));
  const source = openProductRuntime({ root: join(directory, 'source'), resources });
  const targetRoot = join(directory, 'target');
  const target = openProductRuntime({ root: targetRoot, resources });
  let host;
  try {
    const { environment: a } = await source.install({ profile: 'remote' });
    const { environment: b } = await target.install({ profile: 'remote' });
    host = await createProductRuntimeHost({ root: targetRoot });
    const grant = await target.authorize({ sourceEnvironmentId: a.environmentId,
      sourceServiceId: a.services[0].serviceId, capabilities: ['runtime.status'] });
    await source.connect({ connectionId: randomUUID(), sourceEnvironmentId: a.environmentId,
      sourceServiceId: a.services[0].serviceId, target: b.services[0],
      requiredCapabilities: ['runtime.status'], optionalCapabilities: [], credentialRef: 'target' }, grant.token);
    assert.equal((await source.start()).state, 'ready');
    await host.maintenance.enter('backup');
    assert.equal((await source.status()).state, 'failed');
    await host.maintenance.resume();
    assert.equal((await source.status()).state, 'ready');
  } finally {
    await source.stop();
    await host?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('changing a live host process title cannot release its environment lease', async () => {
  const root = await mkdtemp(join(tmpdir(), '循阶 live owner '));
  const runtime = openProductRuntime({ root, resources });
  const title = process.title;
  const timezone = process.env.TZ;
  let host;
  try {
    await runtime.install({ profile: 'remote' });
    host = await createProductRuntimeHost({ root });
    process.title = `xunjie-consumer-${randomUUID()}`;
    process.env.TZ = 'Pacific/Honolulu';
    await assert.rejects(createProductRuntimeHost({ root }), /daemon.*occupied/i);
  } finally {
    process.title = title;
    if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone;
    await host?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
