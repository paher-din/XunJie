import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createMaintenanceCoordinator, createRecoveryManager, restoreRecoverySet } from '@xunjie/product-runtime';
import { createConnectionAuthority, createOutboundConnection } from '@xunjie/product-runtime/connections';

// A separately hosted owner exercises the product boundary without exporting its internals.
function owner(serviceId, initial = 'confirmed request / unknown external effect') {
  let value = initial, open = true;
  return {
    read: () => value,
    write(next) { if (!open) throw new Error('closed'); value = next; },
    participant: {
      descriptor: { serviceId, schemaVersion: '1', resourceRoots: [], configurationRefs: [] },
      async closeWrites() { open = false; }, async closeDispatch() { open = false; },
      async drain() {}, async validate() {}, async resume() { open = true; },
    },
    async export({ directory }) {
      await writeFile(join(directory, 'state'), value);
      return { formatVersion: 1, schemaVersion: '1', data: { requestId: 'original', effectState: 'unknown' } };
    },
    async release() {},
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), '循阶 recovery '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'source'); await mkdir(root);
  const serviceId = randomUUID();
  const environmentId = randomUUID();
  const environment = { formatVersion: 1, environmentId, installationId: randomUUID(),
    clientNamespace: 'test', profile: 'local', services: [{ environmentId, serviceId,
      unit: 'learning-data', endpoint: 'http://127.0.0.1:1', protocolVersion: 1, capabilities: [] }] };
  const a = owner(serviceId);
  const maintenance = createMaintenanceCoordinator({ requiredServiceIds: [serviceId], record: async () => {} });
  maintenance.register(a.participant);
  const manager = createRecoveryManager({ root, environment, maintenance, owners: [a], requiredServiceIds: [serviceId] });
  return { directory, root, serviceId, environment, a, maintenance, manager, key: randomBytes(32) };
}

async function pinnedFixture(t, { count = 2, timeoutMs = 1_000 } = {}) {
  const f = await fixture(t);
  const owners = Array.from({ length: count }, () => owner(randomUUID()));
  const pins = owners.map(() => new Set());
  const releases = owners.map(() => []);
  const directory = join(f.directory, 'backups');
  const maintenance = createMaintenanceCoordinator({ requiredServiceIds: owners.map(o => o.participant.descriptor.serviceId), record: async () => {} });
  owners.forEach((o, index) => {
    const resume = o.participant.resume;
    o.participant.resume = async () => { await o.beforeResume?.(); await resume(); };
    maintenance.register(o.participant);
    const original = o.export;
    o.export = async input => { pins[index].add(input.backupId); return original(input); };
    o.release = async id => {
      assert.ok(!(await readdir(directory)).includes(id), 'retire from the usable directory before releasing any pin');
      releases[index].push(id); pins[index].delete(id);
    };
  });
  const reopen = () => createRecoveryManager({ root: f.root, environment: f.environment, maintenance, owners,
    requiredServiceIds: owners.map(o => o.participant.descriptor.serviceId), timeoutMs });
  return { ...f, owners, pins, releases, directory, maintenance, reopen, manager: reopen() };
}

test('failed multi-owner exports and encryption release every attempted owner pin after retirement', async t => {
  for (const failure of ['export', 'ciphertext']) await t.test(failure, async t => {
    const f = await pinnedFixture(t);
    if (failure === 'export') {
      const original = f.owners[1].export;
      f.owners[1].export = async input => { await original(input); throw new Error('copy failed after pin commit'); };
    }
    await assert.rejects(f.manager.backup({ directory: f.directory, key: failure === 'ciphertext' ? new Uint8Array(1) : f.key }));
    assert.deepEqual(f.pins.map(p => [...p]), [[], []]);
    assert.deepEqual(f.releases.map(r => r.length), [1, 1]);
    assert.deepEqual(await readdir(f.directory), []);
    assert.deepEqual((await f.manager.catalog(f.directory, f.key)).backups, []);
  });
});

test('verified backups retain pins when resume fails, and successful backups retain pins', async t => {
  const f = await pinnedFixture(t);
  f.owners[0].beforeResume = async () => { throw new Error('resume failed'); };
  await assert.rejects(f.manager.backup({ directory: f.directory, key: f.key }));
  const [first] = (await f.manager.catalog(f.directory, f.key)).backups;
  assert.ok(first);
  await f.reopen().cleanup();
  assert.ok(f.pins.every(p => p.has(first.backupId)));
  assert.deepEqual(f.releases, [[], []]);
  delete f.owners[0].beforeResume;
  await f.manager.resume();
  const second = await f.manager.backup({ directory: f.directory, key: f.key });
  assert.ok(f.pins.every(p => p.has(first.backupId) && p.has(second.backupId)));
});

test('failed release survives a manager restart and retries without losing later owner cleanup', async t => {
  const f = await pinnedFixture(t);
  const release = f.owners[0].release;
  let denied = true;
  f.owners[0].release = async id => { if (denied) throw new Error('release unavailable'); await release(id); };
  await assert.rejects(f.manager.backup({ directory: f.directory, key: new Uint8Array(1) }));
  const retired = await readdir(f.directory);
  assert.equal(retired.length, 1);
  assert.ok(retired[0].startsWith('.retired-'));
  assert.deepEqual(f.pins.map(p => p.size), [1, 0], 'one failed release must not prevent the other owner from being cleaned');
  await assert.rejects(f.reopen().cleanup());
  denied = false;
  await f.reopen().cleanup();
  assert.deepEqual(f.pins.map(p => [...p]), [[], []]);
  assert.deepEqual(await readdir(f.directory), []);
});

test('retention retries retired releases while preserving the newly verified backup pins', async t => {
  const f = await pinnedFixture(t);
  const first = await f.manager.backup({ directory: f.directory, key: f.key });
  const release = f.owners[0].release;
  f.owners[0].release = async () => { throw new Error('release unavailable'); };
  await assert.rejects(f.manager.backup({ directory: f.directory, key: f.key, keep: 1 }));
  const { backups } = await f.manager.catalog(f.directory, f.key);
  assert.equal(backups.length, 1);
  assert.notEqual(backups[0].backupId, first.backupId);
  assert.ok(f.pins.every(p => p.has(backups[0].backupId)));
  f.owners[0].release = release;
  await f.reopen().cleanup();
  assert.ok(f.pins.every(p => !p.has(first.backupId) && p.has(backups[0].backupId)));
  assert.deepEqual(await readdir(f.directory), [backups[0].backupId]);
});

test('timeout returns before a late export establishes its pin, then cleans it without exporting the next owner', async t => {
  for (const rejects of [false, true]) await t.test(`late export rejects=${rejects}`, async t => {
    const f = await pinnedFixture(t, { timeoutMs: 40 });
    const entered = Promise.withResolvers(), finish = Promise.withResolvers(), released = Promise.withResolvers();
    t.after(() => finish.resolve());
    const original = f.owners[0].export, release = f.owners[0].release;
    let laterExports = 0;
    f.owners[1].export = async () => { laterExports++; throw new Error('must not start'); };
    f.owners[0].export = async input => {
      entered.resolve(); await finish.promise;
      const result = await original(input);
      if (rejects) throw new Error('late copy failure');
      return result;
    };
    f.owners[0].release = async id => { await release(id); released.resolve(); };
    const rejected = assert.rejects(f.manager.backup({ directory: f.directory, key: f.key }), { code: 'timeout' });
    await entered.promise;
    await Promise.race([rejected, delay(2_000).then(() => assert.fail('timeout waited for the unfinished export'))]);
    assert.deepEqual(f.releases, [[], []]);
    await assert.rejects(f.reopen().cleanup(), { code: 'backup-export-pending' });
    finish.resolve();
    await Promise.race([released.promise, delay(2_000).then(() => assert.fail('late export pin was leaked'))]);
    for (let attempt = 0; (await readdir(join(f.root, '.locks', 'recovery'))).length && attempt < 100; attempt++) await delay(10);
    await f.reopen().cleanup();
    assert.deepEqual(f.pins.map(p => [...p]), [[], []]);
    assert.equal(laterExports, 0, 'an aborted export loop must never start the next owner');
    assert.deepEqual(await readdir(f.directory), []);
    assert.equal((await f.manager.catalog(f.directory, f.key)).latest.phase, 'failed');
  });
});

test('a killed backup producer leaves durable cleanup that a fresh public manager can finish', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const directory = join(f.directory, 'backups'), pinFile = join(f.root, 'durable-pin');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { createMaintenanceCoordinator, createRecoveryManager } from '@xunjie/product-runtime';
    const { root, environment, serviceId, directory, pinFile } = JSON.parse(process.env.RECOVERY_CRASH_FIXTURE);
    const participant = { descriptor: { serviceId, schemaVersion: '1', resourceRoots: [], configurationRefs: [] },
      async closeWrites() {}, async closeDispatch() {}, async drain() {}, async validate() {}, async resume() {} };
    const maintenance = createMaintenanceCoordinator({ requiredServiceIds: [serviceId], record: async () => {} });
    maintenance.register(participant);
    const manager = createRecoveryManager({ root, environment, maintenance, requiredServiceIds: [serviceId], owners: [{
      participant, async release() {}, async export({ backupId, directory }) {
        await writeFile(pinFile, backupId);
        await writeFile(join(directory, 'partial'), 'unfinished copy');
        process.send({ backupId });
        await new Promise(() => { setInterval(() => {}, 1_000); });
      },
    }] });
    await manager.backup({ directory, key: new Uint8Array(32) });
  `], { env: { ...process.env, RECOVERY_CRASH_FIXTURE: JSON.stringify({ root: f.root, environment: f.environment,
    serviceId: f.serviceId, directory, pinFile }) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const [message] = await once(child, 'message');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  let releases = 0;
  f.a.release = async backupId => {
    assert.equal(backupId, message.backupId);
    assert.ok(!(await readdir(directory)).includes(backupId));
    assert.equal(await readFile(pinFile, 'utf8'), backupId);
    releases++; await rm(pinFile);
  };
  await f.manager.cleanup();
  assert.equal(releases, 1);
  assert.deepEqual(await readdir(directory), []);
  const { latest, backups } = await f.manager.catalog(directory, f.key);
  assert.equal(latest.phase, 'failed');
  assert.equal(latest.error, 'interrupted-backup');
  assert.deepEqual(backups, []);
});

test('a complete recovery set restores owner state and original effect identity while remaining isolated', async t => {
  const f = await fixture(t);
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key });
  f.a.write('after the recoverable boundary');
  let restored;
  const targetRoot = join(f.directory, 'target');
  const result = await restoreRecoverySet({ backupDirectory: join(f.directory, 'backups', manifest.backupId),
    targetRoot, key: f.key, targets: [{ serviceId: f.serviceId,
      async restore({ directory, recovery }) {
        assert.deepEqual(recovery.data, { requestId: 'original', effectState: 'unknown' });
        restored = owner(f.serviceId, await readFile(join(directory, 'state'), 'utf8'));
        await restored.participant.closeWrites(); return restored;
      }, async validate() { assert.equal(restored.read(), 'confirmed request / unknown external effect'); },
    }] });
  assert.equal(result.manifest.backupId, manifest.backupId);
  assert.throws(() => restored.write('unexpected'), /closed/);
  assert.equal(f.a.read(), 'after the recoverable boundary');
  assert.equal(JSON.parse(await readFile(join(targetRoot, 'recovery-state.json'), 'utf8')).phase, 'isolated');
  const publicManifest = await readFile(join(f.directory, 'backups', manifest.backupId, 'manifest.json'), 'utf8');
  assert.ok(!publicManifest.includes('unknown external effect'));
  const withoutKey = await f.manager.catalog(join(f.directory, 'backups'));
  assert.deepEqual(withoutKey.backups, []);
  assert.deepEqual(withoutKey.unavailable, [{ backupId: manifest.backupId, reason: 'recovery-key-required' }]);
  assert.equal((await f.manager.catalog(join(f.directory, 'backups'), f.key)).backups.length, 1);
  await rm(join(f.directory, 'backups', manifest.backupId, 'artifacts', manifest.artifacts[0].path));
  const incomplete = await f.manager.catalog(join(f.directory, 'backups'), f.key);
  assert.deepEqual(incomplete.backups, []);
  assert.equal(incomplete.unavailable[0].backupId, manifest.backupId);
});

test('missing participants fail before any complete catalog entry and leave source writes closed', async t => {
  const f = await fixture(t);
  const manager = createRecoveryManager({ root: f.root, environment: f.environment,
    maintenance: f.maintenance, owners: [], requiredServiceIds: [f.serviceId] });
  await assert.rejects(manager.backup({ directory: join(f.directory, 'backups'), key: f.key }), /participant/);
  assert.throws(() => f.a.write('lost'), /closed/);
  assert.deepEqual((await manager.catalog(join(f.directory, 'backups'))).backups, []);
});

test('editing a returned manifest cannot change the source identity used for retirement', async t => {
  const f = await fixture(t);
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key, leaveClosed: true });
  manifest.source.installationId = randomUUID();
  const proof = await f.manager.retire({ backupId: manifest.backupId, targetInstallationId: randomUUID() });
  assert.equal(proof.sourceInstallationId, f.environment.installationId);
});

test('occupied targets and wrong keys preserve both source and original backup', async t => {
  const f = await fixture(t);
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key });
  const backupDirectory = join(f.directory, 'backups', manifest.backupId);
  const targetRoot = join(f.directory, 'occupied'); await mkdir(targetRoot);
  await writeFile(join(targetRoot, 'original'), 'B is still usable');
  await assert.rejects(restoreRecoverySet({ backupDirectory, targetRoot, key: f.key, targets: [] }), /target/);
  await assert.rejects(restoreRecoverySet({ backupDirectory, targetRoot: join(f.directory, 'wrong-key'),
    key: randomBytes(32), targets: [] }));
  assert.equal(await readFile(join(targetRoot, 'original'), 'utf8'), 'B is still usable');
  assert.equal(JSON.parse(await readFile(join(backupDirectory, 'manifest.json'), 'utf8')).backupId, manifest.backupId);
  f.a.write('source is usable');
});

async function takeoverFixture(t, { receiverCount = 1, handler = value => value } = {}) {
  const f = await fixture(t);
  f.a.write('B: confirmed state at the held boundary');
  const receivers = [];
  for (let index = 0; index < receiverCount; index++) {
    let authority;
    const server = createServer((request, response) => {
      void authority.handle(request, response).then(handled => {
        if (!handled) { response.writeHead(404); response.end(); }
      }).catch(() => response.destroy());
    });
    t.after(async () => {
      if (!server.listening) return;
      const closed = once(server, 'close');
      server.close(); server.closeAllConnections(); await closed;
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const service = { environmentId: randomUUID(), serviceId: randomUUID(), unit: 'tool-execution',
      endpoint: `http://127.0.0.1:${server.address().port}`, protocolVersion: 1, capabilities: ['echo'] };
    const authorityOptions = { root: join(f.directory, `receiver-${index}`), service, handlers: { echo: handler } };
    authority = createConnectionAuthority(authorityOptions);
    const source = { sourceEnvironmentId: f.environment.environmentId, sourceServiceId: f.serviceId };
    const grant = await authority.authorize({ ...source, capabilities: ['echo'] });
    const connection = { connectionId: randomUUID(), ...source, target: service,
      requiredCapabilities: ['echo'], optionalCapabilities: [], credentialRef: `test:${randomUUID()}` };
    const client = () => createOutboundConnection({ connection, credential: async () => grant.token,
      allowInsecureLoopback: true, timeoutMs: 3_000 });
    receivers.push({ id: `${service.environmentId}/${service.serviceId}`, client,
      reopen() { authority = createConnectionAuthority(authorityOptions); },
      async fence(environment) {
        assert.equal(environment.environmentId, f.environment.environmentId);
        assert.deepEqual(environment.services.map(item => item.serviceId), [f.serviceId]);
        return authority.fenceSource(source);
      },
    });
  }
  const manager = createRecoveryManager({ root: f.root, environment: f.environment, maintenance: f.maintenance,
    owners: [f.a], requiredServiceIds: [f.serviceId], receiverIds: receivers.map(item => item.id) });
  return { ...f, manager, receivers };
}

async function restoredTarget(f, manifest, { name = 'takeover-target', failResume = false, timeoutMs = 1_000,
  expectedState = 'B: confirmed state at the held boundary' } = {}) {
  const root = join(f.directory, name);
  const restored = await restoreRecoverySet({ backupDirectory: join(f.directory, 'backups', manifest.backupId),
    targetRoot: root, key: f.key, targets: [{ serviceId: f.serviceId,
      async restore({ directory }) {
        const restoredOwner = owner(f.serviceId, await readFile(join(directory, 'state'), 'utf8'));
        if (failResume) {
          const resume = restoredOwner.participant.resume;
          let fail = true;
          restoredOwner.participant.resume = async () => { await resume(); if (fail) { fail = false; throw new Error('activation rejected'); } };
        }
        return restoredOwner;
      },
      async validate(restoredOwner) { assert.equal(restoredOwner.read(), expectedState); },
    }] });
  const environment = { ...structuredClone(manifest.source), installationId: randomUUID() };
  const maintenance = createMaintenanceCoordinator({ requiredServiceIds: [f.serviceId], record: async () => {} });
  for (const restoredOwner of restored.owners) maintenance.register(restoredOwner.participant);
  const manager = createRecoveryManager({ root, environment, maintenance,
    owners: restored.owners, requiredServiceIds: [f.serviceId], timeoutMs });
  return { root, environment, maintenance, manager, a: restored.owners[0] };
}

async function assertIsolatedB(target) {
  assert.equal(target.a.read(), 'B: confirmed state at the held boundary');
  assert.throws(() => target.a.write('must not become a new writer'), /closed/);
  await assert.rejects(target.manager.resume(), /target-isolated/);
  assert.equal(JSON.parse(await readFile(join(target.root, 'recovery-state.json'), 'utf8')).phase, 'isolated');
}

test('takeover drains real receiver handlers before opening a new installation and permanently retires the live source', async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  const f = await takeoverFixture(t, { handler: async value => {
    started.resolve(); await finish.promise; return value;
  } });
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key, leaveClosed: true });
  const target = await restoredTarget(f, manifest);
  assert.notEqual(target.environment.installationId, f.environment.installationId);
  await assertIsolatedB(target);
  const receiver = f.receivers[0];
  const oldClient = receiver.client();
  const request = oldClient.request('echo', 'accepted before fencing');
  await started.promise;
  const fencing = Promise.withResolvers();
  let activated = false;
  const takeover = target.manager.takeover({ source: f.manager,
    receivers: [{ id: receiver.id, async fence(environment) {
      fencing.resolve(); return receiver.fence(environment);
    } }] }).then(result => { activated = true; return result; });
  await fencing.promise;
  // The source process is still alive; its manager must reject reopening it.
  await assert.rejects(f.manager.resume(), /source-retired/);
  assert.throws(() => f.a.write('old source must stay closed'), /closed/);
  assert.equal(activated, false);
  assert.throws(() => target.a.write('before accepted handlers finish'), /closed/);
  finish.resolve();
  assert.equal(await request, 'accepted before fencing');
  const result = await takeover;
  assert.equal(result.phase, 'active');
  assert.equal(result.backupId, manifest.backupId);
  assert.equal(result.installationId, target.environment.installationId);
  assert.equal(target.maintenance.status().phase, 'open');
  target.a.write('new installation owns subsequent writes');
  assert.equal(target.a.read(), 'new installation owns subsequent writes');
  assert.equal(f.a.read(), 'B: confirmed state at the held boundary');
  assert.equal((await oldClient.check()).reason, 'http_401');
  receiver.reopen();
  assert.equal((await receiver.client().check()).reason, 'http_401');
  await assert.rejects(f.manager.resume(), /source-retired/);
});

test('a default backup that resumed source writes cannot retire the source or activate its restored snapshot', async t => {
  const f = await takeoverFixture(t);
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key });
  f.a.write('C: a new confirmed write after the default backup');
  const target = await restoredTarget(f, manifest);
  await assert.rejects(f.manager.retire({ backupId: manifest.backupId,
    targetInstallationId: target.environment.installationId }), /fresh-held-backup-required/);
  await assert.rejects(target.manager.takeover({ source: f.manager, receivers: f.receivers }), /fresh-held-backup-required/);
  await assertIsolatedB(target);
  assert.equal(f.a.read(), 'C: a new confirmed write after the default backup');
  f.a.write('D: source continues serving after rejected takeover');
  assert.equal((await f.receivers[0].client().check()).state, 'ready');
});

test('only the latest held backup can take over after the source resumes and creates a newer boundary', async t => {
  const f = await takeoverFixture(t);
  const directory = join(f.directory, 'backups');
  const old = await f.manager.backup({ directory, key: f.key, leaveClosed: true });
  const staleTarget = await restoredTarget(f, old, { name: 'stale-target' });
  await f.manager.resume();
  f.a.write('C: newest confirmed state');
  const latest = await f.manager.backup({ directory, key: f.key, leaveClosed: true });
  await assert.rejects(staleTarget.manager.takeover({ source: f.manager, receivers: f.receivers }), /fresh-held-backup-required/);
  await assertIsolatedB(staleTarget);
  assert.equal((await f.receivers[0].client().check()).state, 'ready');
  assert.equal(f.a.read(), 'C: newest confirmed state');
  const currentTarget = await restoredTarget(f, latest, { name: 'current-target', expectedState: 'C: newest confirmed state' });
  assert.equal((await currentTarget.manager.takeover({ source: f.manager, receivers: f.receivers })).phase, 'active');
  assert.equal(currentTarget.a.read(), 'C: newest confirmed state');
  currentTarget.a.write('D: accepted by the current target');
  assert.throws(() => f.a.write('old source reopening'), /closed/);
  await assert.rejects(f.manager.resume(), /source-retired/);
  // Retiring for the current target must not retroactively activate the stale one.
  await assert.rejects(staleTarget.manager.takeover({ source: f.manager, receivers: f.receivers }), /retirement-conflict/);
  await assertIsolatedB(staleTarget);
});

test('missing receivers, unreachable or rejecting sources, and receiver failure leave the restored B isolated', async t => {
  for (const scenario of ['missing-receiver', 'source-unreachable', 'source-rejects', 'receiver-rejects']) {
    await t.test(scenario, async t => {
      const f = await takeoverFixture(t, { receiverCount: 2 });
      const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key, leaveClosed: true });
      const target = await restoredTarget(f, manifest, { timeoutMs: scenario === 'source-unreachable' ? 100 : 1_000 });
      let retirementCalls = 0;
      const fenceCalls = [0, 0];
      const source = { async retire(input) {
        retirementCalls++;
        assert.equal(input.backupId, manifest.backupId);
        assert.equal(input.targetInstallationId, target.environment.installationId);
        if (scenario === 'source-unreachable') return new Promise(() => {});
        if (scenario === 'source-rejects') throw Object.assign(new Error('retirement rejected'), { code: 'retirement-conflict' });
        return f.manager.retire(input);
      } };
      const receivers = f.receivers.map((receiver, index) => ({ id: receiver.id, async fence(environment) {
        fenceCalls[index]++;
        if (scenario === 'receiver-rejects' && index === 1) {
          throw Object.assign(new Error('receiver unavailable'), { code: 'receiver-unavailable' });
        }
        return receiver.fence(environment);
      } }));
      if (scenario === 'missing-receiver') receivers.pop();
      const code = { 'missing-receiver': 'missing-receiver', 'source-unreachable': 'timeout',
        'source-rejects': 'retirement-conflict', 'receiver-rejects': 'receiver-unavailable' }[scenario];
      await assert.rejects(target.manager.takeover({ source, receivers }), error => error.code === code);
      await assertIsolatedB(target);
      assert.equal(f.a.read(), 'B: confirmed state at the held boundary');
      assert.throws(() => f.a.write('must not reopen on target failure'), /closed/);
      assert.equal(retirementCalls, scenario === 'missing-receiver' ? 0 : 1);
      assert.deepEqual(fenceCalls, scenario === 'receiver-rejects' ? [1, 1] : [0, 0]);
      assert.equal((await f.receivers[0].client().check()).reason,
        scenario === 'receiver-rejects' ? 'http_401' : undefined);
    });
  }
});

test('failed activation reseals the target and preserves B after real source retirement and receiver fencing', async t => {
  const f = await takeoverFixture(t);
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key, leaveClosed: true });
  const target = await restoredTarget(f, manifest, { failResume: true });
  await assert.rejects(target.manager.takeover({ source: f.manager, receivers: f.receivers }), /operation-failed/);
  await assertIsolatedB(target);
  assert.equal(target.maintenance.status().gatesClosed, true);
  assert.throws(() => f.a.write('source reopening after failed activation'), /closed/);
  await assert.rejects(f.manager.resume(), /source-retired/);
  f.receivers[0].reopen();
  assert.equal((await f.receivers[0].client().check()).reason, 'http_401');
  const { operations } = await target.manager.catalog(join(f.directory, 'backups'));
  assert.ok(operations.some(operation => operation.kind === 'takeover' && operation.phase === 'failed'));
  const request = { backupId: manifest.backupId, targetInstallationId: target.environment.installationId };
  const proof = await f.manager.retire(request);
  assert.deepEqual(JSON.parse(await readFile(join(target.root, 'recovery-state.json'), 'utf8')).proof, proof);
  let contactedOfflineSource = false;
  assert.equal((await target.manager.takeover({ source: { async retire() {
    contactedOfflineSource = true; throw new Error('retired source is now offline');
  } }, receivers: f.receivers })).phase, 'active');
  assert.equal(contactedOfflineSource, false, 'a previously confirmed durable retirement proof survives source exit');
  assert.deepEqual(await f.manager.retire(request), proof);
});

test('a timed-out restore cannot publish a late owner or replace its durable failed phase', async t => {
  const f = await fixture(t);
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key });
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), observed = Promise.withResolvers();
  t.after(() => finish.resolve());
  let late;
  const targetRoot = join(f.directory, 'late-target');
  const restoring = restoreRecoverySet({ backupDirectory: join(f.directory, 'backups', manifest.backupId), targetRoot,
    key: f.key, timeoutMs: 40, targets: [{ serviceId: f.serviceId, async restore() {
      entered.resolve(); await finish.promise;
      late = owner(f.serviceId); return late;
    }, async validate() { observed.resolve(); } }] });
  const rejected = assert.rejects(restoring, { code: 'timeout' });
  await entered.promise; await rejected;
  finish.resolve();
  // Allow the actual abandoned callback to finish; its own validate must never run.
  await Promise.race([observed.promise, delay(50)]);
  assert.throws(() => late.write('late activation'), /closed/);
  const state = JSON.parse(await readFile(join(targetRoot, 'recovery-state.json'), 'utf8'));
  assert.equal(state.phase, 'failed');
  const manager = createRecoveryManager({ root: targetRoot, environment: f.environment, owners: [], requiredServiceIds: [],
    maintenance: createMaintenanceCoordinator({ requiredServiceIds: [], record: async () => {} }) });
  assert.equal((await manager.catalog(join(f.directory, 'backups'), f.key)).latest.phase, 'failed');
});

test('concurrent restores reserve one empty target exactly once', async t => {
  const f = await fixture(t);
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key });
  const backupDirectory = join(f.directory, 'backups', manifest.backupId);
  for (let attempt = 0; attempt < 3; attempt++) {
    let restores = 0;
    const targetRoot = join(f.directory, `competing-${attempt}`);
    await mkdir(targetRoot);
    const run = () => restoreRecoverySet({ backupDirectory, targetRoot, key: f.key,
      targets: [{ serviceId: f.serviceId, async restore() { restores++; return owner(f.serviceId); }, async validate() {} }] });
    const results = await Promise.allSettled(Array.from({ length: 8 }, run));
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1, results.map(item => item.reason?.message).join('; '));
    assert.equal(restores, 1);
    assert.equal(JSON.parse(await readFile(join(targetRoot, 'recovery-state.json'), 'utf8')).phase, 'isolated');
  }
});

test('an interrupted activating target stays isolated and can retry the same durable retirement proof', async t => {
  const f = await takeoverFixture(t);
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key, leaveClosed: true });
  const target = await restoredTarget(f, manifest);
  const proof = await f.manager.retire({ backupId: manifest.backupId, targetInstallationId: target.environment.installationId });
  for (const receiver of f.receivers) await receiver.fence(manifest.source);
  await writeFile(join(target.root, 'recovery-state.json'), JSON.stringify({ phase: 'restoring', manifest }));
  await assert.rejects(target.manager.resume(), { code: 'target-isolated' });
  await assert.rejects(target.manager.takeover({ source: f.manager, receivers: f.receivers }), { code: 'validated-isolated-target-required' });
  // Simulate restart after the durable activating record, before resume finishes.
  await writeFile(join(target.root, 'recovery-state.json'), JSON.stringify({ phase: 'activating', manifest, proof }));
  await assert.rejects(target.manager.resume(), { code: 'target-isolated' });
  assert.equal((await target.manager.takeover({ source: f.manager, receivers: f.receivers })).phase, 'active');
  assert.deepEqual(await f.manager.retire({ backupId: manifest.backupId, targetInstallationId: target.environment.installationId }), proof);
  target.a.write('recovered activation');
  await assert.rejects(f.manager.resume(), { code: 'source-retired' });
});

test('source retirement cannot reuse a proof belonging to a different source installation', async t => {
  const f = await takeoverFixture(t, { receiverCount: 0 });
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key, leaveClosed: true });
  const targetInstallationId = randomUUID();
  const request = { backupId: manifest.backupId, targetInstallationId };
  const proof = await f.manager.retire(request);
  assert.deepEqual(await f.manager.retire(request), proof);
  const replaced = createRecoveryManager({ root: f.root, environment: { ...f.environment, installationId: randomUUID() },
    maintenance: f.maintenance, owners: [f.a], requiredServiceIds: [f.serviceId] });
  await assert.rejects(replaced.retire(request), { code: 'retirement-conflict' });
});

test('a maintenance drain timeout never advertises a completed backup, even after the drain later returns', async t => {
  const f = await fixture(t);
  const finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  f.a.participant.drain = async () => finish.promise;
  const maintenance = createMaintenanceCoordinator({ requiredServiceIds: [f.serviceId], timeoutMs: 20, record: async () => {} });
  maintenance.register(f.a.participant);
  const manager = createRecoveryManager({ root: f.root, environment: f.environment, maintenance, owners: [f.a], requiredServiceIds: [f.serviceId] });
  const directory = join(f.directory, 'backups');
  await assert.rejects(manager.backup({ directory, key: f.key }));
  finish.resolve();
  const status = await manager.catalog(directory, f.key);
  assert.equal(status.latest.phase, 'failed');
  assert.deepEqual(status.backups, []);
  assert.throws(() => f.a.write('after timeout'), /closed/);
});

test('an explicitly upgraded restore records actual versions and refuses a mismatched owner before retiring the source', async t => {
  const f = await takeoverFixture(t, { receiverCount: 0 });
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key, leaveClosed: true });
  const root = join(f.directory, 'upgraded');
  const result = await restoreRecoverySet({ backupDirectory: join(f.directory, 'backups', manifest.backupId), targetRoot: root, key: f.key,
    targets: [{ serviceId: f.serviceId, async restore() {
      const upgraded = owner(f.serviceId); upgraded.participant.descriptor.schemaVersion = '2'; return upgraded;
    }, async validate() {} }] });
  assert.equal(result.manifest.services[0].schemaVersion, '1');
  const environment = { ...f.environment, installationId: randomUUID() };
  const maintenance = createMaintenanceCoordinator({ requiredServiceIds: [f.serviceId], record: async () => {} });
  result.owners[0].participant.descriptor.schemaVersion = '3';
  maintenance.register(result.owners[0].participant);
  const manager = createRecoveryManager({ root, environment, maintenance, owners: result.owners, requiredServiceIds: [f.serviceId] });
  let retirementCalls = 0;
  await assert.rejects(manager.takeover({ source: { async retire(input) { retirementCalls++; return f.manager.retire(input); } }, receivers: [] }),
    { code: 'incompatible-owner-format' });
  assert.equal(retirementCalls, 0);
  assert.deepEqual(result.versions, [{ serviceId: f.serviceId, schemaVersion: '2' }]);
  await f.manager.resume(); f.a.write('source remains authoritative');
});

test('backup cannot implicitly resume an isolated or interrupted restore target', async t => {
  const f = await takeoverFixture(t, { receiverCount: 0 });
  const manifest = await f.manager.backup({ directory: join(f.directory, 'backups'), key: f.key, leaveClosed: true });
  for (const phase of ['isolated', 'restoring', 'activating']) {
    const target = await restoredTarget(f, manifest, { name: `blocked-${phase}` });
    await writeFile(join(target.root, 'recovery-state.json'), JSON.stringify({ phase, manifest }));
    await assert.rejects(target.manager.backup({ directory: join(f.directory, `target-backups-${phase}`), key: f.key }), { code: 'target-isolated' });
    assert.throws(() => target.a.write('implicit enable'), /closed/);
    await assert.rejects(target.manager.resume(), { code: 'target-isolated' });
  }
});

test('backup path and space preflight failures are the latest recorded result while source gates remain open', async t => {
  const f = await fixture(t);
  const directory = join(f.directory, 'backups');
  for (const input of [
    { directory: join(f.root, 'backups') },
    { directory, minimumFreeBytes: Number.MAX_SAFE_INTEGER },
    { directory: join(f.directory, 'not-a-directory') },
  ]) {
    if (input.directory.endsWith('not-a-directory')) await writeFile(input.directory, 'occupied');
    await assert.rejects(f.manager.backup({ ...input, key: f.key }));
    const catalog = await f.manager.catalog(directory, f.key);
    assert.equal(catalog.latest?.kind, 'backup');
    assert.equal(catalog.latest?.phase, 'failed');
    assert.ok(catalog.latest.error);
    assert.deepEqual(catalog.backups, []);
    assert.equal(f.maintenance.status().phase, 'open');
    assert.equal(f.maintenance.status().gatesClosed, false);
    f.a.write('source remains usable after preflight failure');
  }
});
