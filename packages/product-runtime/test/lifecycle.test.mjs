import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createProductRuntimeHost, openProductRuntime } from '@xunjie/product-runtime';

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
    await assert.rejects(openProductRuntime({ root, resources }).install({ profile: 'remote' }), /occupied/i);
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
