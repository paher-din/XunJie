import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createConnectionAuthority } from '@xunjie/product-runtime/connections';
import { test } from 'node:test';
import { openProductRuntime, createProductRuntimeHost, createOutboundConnection } from '@xunjie/product-runtime';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };

test('agent requires PostgreSQL before creating installation state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-agent-invalid-'));
  try {
    const runtime = openProductRuntime({ root, resources });
    await assert.rejects(runtime.install({ profile: 'agent', database: { mode: 'none' } }), /requires PostgreSQL/);
    await assert.rejects(runtime.prepare({ profile: 'agent', database: { mode: 'none' } }), /requires PostgreSQL/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('host publishes and authorizes capabilities per real service; revoke and fence cover the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-service-routing-'));
  const runtime = openProductRuntime({ root, resources });
  let host;
  try {
    await runtime.install({ profile: 'remote' });
    const source = { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID() };
    await assert.rejects(runtime.authorize({ ...source, capabilities: ['probe.echo'] }));
    host = await createProductRuntimeHost({ root, createApplication: async ({ environment }) => {
      const secondary = { ...environment.services[0], serviceId: randomUUID(), unit: 'teaching-agent', capabilities: [] };
      environment.services.push(secondary);
      return { owners: [], capabilities: { 'probe.legacy': () => 'legacy' },
        serviceCapabilities: { [secondary.serviceId]: { 'probe.echo': input => input } },
        async handle() { return false; } };
    } });
    const environment = (await runtime.status()).environment;
    const [first, second] = environment.services;
    const published = await (await fetch(new URL('/runtime/environment', host.endpoint))).json();
    assert.deepEqual(published.services, environment.services);
    assert.deepEqual(first.capabilities, ['runtime.status', 'probe.legacy']);
    assert.deepEqual(second.capabilities, ['runtime.status', 'probe.echo']);
    const outbound = (target, grant, capability) => createOutboundConnection({
      connection: { connectionId: randomUUID(), ...source, target, requiredCapabilities: [capability], optionalCapabilities: [], credentialRef: 'unused' },
      credential: async () => grant.token, allowInsecureLoopback: true,
    });
    const grant = await runtime.authorize({ ...source, capabilities: ['probe.echo'] }, second.serviceId);
    const caller = outbound(second, grant, 'probe.echo');
    assert.equal((await caller.check()).state, 'ready');
    assert.deepEqual(await caller.request('probe.echo', { hello: 'agent' }), { hello: 'agent' });
    assert.equal((await outbound(first, grant, 'probe.echo').check()).state, 'unavailable');
    await assert.rejects(runtime.authorize({ ...source, capabilities: ['probe.echo'] }, first.serviceId));
    await assert.rejects(runtime.authorize({ ...source, capabilities: ['runtime.status'] }, randomUUID()));
    assert.equal(await runtime.revoke(grant.grantId), true);
    assert.equal((await caller.check()).state, 'unavailable');
    const legacy = await runtime.authorize({ ...source, capabilities: ['probe.legacy'] });
    assert.equal(await outbound(first, legacy, 'probe.legacy').request('probe.legacy'), 'legacy');
    const inputFile = join(root, 'authorization.json');
    const outputFile = join(root, 'grant.json');
    await writeFile(inputFile, JSON.stringify({ ...source, capabilities: ['probe.echo'] }));
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../../apps/local-runtime/dist/cli.js', import.meta.url)),
      'authorize', '--root', root, '--file', inputFile, '--out', outputFile, '--service-id', second.serviceId, '--json']);
    const cliGrant = JSON.parse(await readFile(outputFile, 'utf8'));
    assert.equal((await outbound(second, cliGrant, 'probe.echo').check()).state, 'ready');
    assert.equal(await runtime.revoke(cliGrant.grantId), true);
    await host.maintenance.enter('test');
    await assert.rejects(runtime.authorize({ ...source, capabilities: ['probe.echo'] }, second.serviceId), { code: 'maintenance' });
    await host.maintenance.resume();
    const grants = await Promise.all([first, second].map(target => runtime.authorize({ ...source, capabilities: ['runtime.status'] }, target.serviceId)));
    await runtime.recovery.fenceSource(source);
    assert.equal((await outbound(first, legacy, 'probe.legacy').check()).state, 'unavailable');
    for (const [index, target] of [first, second].entries()) {
      assert.equal((await outbound(target, grants[index], 'runtime.status').check()).state, 'unavailable');
    }
  } finally { await host?.stop(); await rm(root, { recursive: true, force: true }); }
});


for (const change of ['none', 'revoke', 'fence-scope', 'fence-installation']) {
  test(`capability source rechecks authorization before effects: ${change}`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'xj-grant-recheck-'));
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const source = { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID() };
    const service = { environmentId: randomUUID(), serviceId: randomUUID(), unit: 'teaching-agent',
      endpoint: 'http://127.0.0.1', protocolVersion: 1, capabilities: ['probe.dispatch'] };
    const effects = [];
    let authority, pending, fencing;
    const server = createServer((request, response) => { void authority.handle(request, response); });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      service.endpoint = `http://127.0.0.1:${server.address().port}`;
      authority = createConnectionAuthority({ root, service, handlers: { 'probe.dispatch': async (_payload, received) => {
        entered.resolve(received);
        await resume.promise;
        await received.assertAuthorized();
        await received.assertAuthorized();
        effects.push('sdk-dispatch');
        return received;
      } } });
      const grant = await authority.authorize({ ...source, capabilities: ['probe.dispatch'] });
      pending = fetch(new URL('/runtime/capabilities/probe.dispatch', service.endpoint), { method: 'POST',
        headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json',
          'x-runtime-source-environment-id': source.sourceEnvironmentId, 'x-runtime-source-service-id': source.sourceServiceId,
          'x-runtime-target-environment-id': service.environmentId, 'x-runtime-target-service-id': service.serviceId,
          'x-runtime-protocol-version': '1' }, body: '{}' });
      const received = await entered.promise;
      assert.equal(typeof received.assertAuthorized, 'function');
      assert.equal(Object.getOwnPropertyDescriptor(received, 'assertAuthorized').enumerable, false);
      const serialized = { grantId: grant.grantId, ...source };
      assert.deepEqual(JSON.parse(JSON.stringify(received)), serialized);
      assert.deepEqual(structuredClone(received), serialized);
      await received.assertAuthorized();
      await received.assertAuthorized();
      if (change === 'revoke') await authority.revoke(grant.grantId);
      else if (change.startsWith('fence')) {
        fencing = authority.fenceSource(change === 'fence-scope'
          ? { sourceEnvironmentId: source.sourceEnvironmentId, sourceServiceId: source.sourceServiceId } : source);
        // Observe invalidation through the same public check; the fence cannot finish until this handler exits.
        const deadline = Date.now() + 5000;
        while (true) {
          try { await received.assertAuthorized(); }
          catch (error) { assert.equal(error.code, 'unauthorized'); break; }
          assert.ok(Date.now() < deadline, 'fence must close admission before draining');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      if (change !== 'none') await assert.rejects(received.assertAuthorized(), { code: 'unauthorized' });
      resume.resolve();
      const response = await pending;
      const result = await response.json();
      if (change === 'none') {
        assert.equal(response.status, 200);
        assert.deepEqual(result.result, serialized);
        assert.deepEqual(effects, ['sdk-dispatch']);
      } else {
        assert.equal(response.status, 401);
        assert.deepEqual(result, { error: 'unauthorized' });
        assert.deepEqual(effects, []);
      }
      await fencing;
    } finally {
      resume.resolve();
      await pending?.catch(() => {});
      await fencing?.catch(() => {});
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const change of ['revoke', 'fence-scope', 'fence-installation']) {
  test(`saved source grant is rechecked by Node after HTTP completion: ${change}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'xj-saved-grant-'));
    const source = { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID(), sourceInstallationId: randomUUID() };
    const service = { environmentId: randomUUID(), serviceId: randomUUID(), unit: 'learning-data',
      endpoint: 'http://127.0.0.1', protocolVersion: 1, capabilities: ['probe.capture', 'probe.other'] };
    let authority;
    const server = createServer((request, response) => {
      void authority.handle(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } });
    });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      service.endpoint = `http://127.0.0.1:${server.address().port}`;
      authority = createConnectionAuthority({ root, service, handlers: { 'probe.capture': (_input, received) => received, 'probe.other': () => null } });
      const grant = await authority.authorize({ ...source, capabilities: ['probe.capture'] });
      const caller = createOutboundConnection({ connection: { connectionId: randomUUID(), ...source, target: service,
        requiredCapabilities: ['probe.capture'], optionalCapabilities: [], credentialRef: 'unused' },
        credential: async () => grant.token, allowInsecureLoopback: true });
      const saved = await caller.request('probe.capture');
      assert.deepEqual(saved, { ...source, grantId: grant.grantId });
      // A later trusted Node owner reconstructs an authority from its real published descriptor.
      const reopened = createConnectionAuthority({ root, service });
      await reopened.assertSourceAuthorized(saved, 'probe.capture');
      await reopened.assertSourceAuthorized(saved, 'probe.capture');
      for (const field of ['sourceEnvironmentId', 'sourceServiceId', 'sourceInstallationId', 'grantId']) {
        await assert.rejects(reopened.assertSourceAuthorized({ ...saved, [field]: randomUUID() }, 'probe.capture'), { code: 'unauthorized' });
      }
      await assert.rejects(reopened.assertSourceAuthorized(saved, 'probe.other'), { code: 'unauthorized' });
      for (const target of [{ ...service, serviceId: randomUUID() }, { ...service, environmentId: randomUUID() }, { ...service, protocolVersion: 2 }]) {
        await assert.rejects(createConnectionAuthority({ root, service: target }).assertSourceAuthorized(saved, 'probe.capture'), { code: 'unauthorized' });
      }
      const noToken = await fetch(new URL('/runtime/capabilities/probe.capture', service.endpoint), { method: 'POST', body: JSON.stringify(saved) });
      assert.equal(noToken.status, 401, 'Node-only source facts never replace HTTP bearer authentication');
      if (change === 'revoke') await authority.revoke(grant.grantId);
      else await authority.fenceSource(change === 'fence-scope'
        ? { sourceEnvironmentId: source.sourceEnvironmentId, sourceServiceId: source.sourceServiceId } : source);
      await assert.rejects(reopened.assertSourceAuthorized(saved, 'probe.capture'), { code: 'unauthorized' });
    } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('uninstall preserves model origin journals; explicit environment deletion removes owned native-channel data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-origin-delete-'));
  try {
    const runtime = openProductRuntime({ root, resources });
    const installed = await runtime.install({ profile: 'remote' });
    const { mkdir, access } = await import('node:fs/promises');
    const directory = join(root, 'native-channel', randomUUID(), 'model-learning');
    const journal = join(directory, randomUUID() + '.json');
    const unrelated = join(root, 'operator-notes.txt');
    await mkdir(directory, { recursive: true });
    await writeFile(journal, JSON.stringify({ origin: 'original-operation' }));
    await writeFile(unrelated, 'operator data');
    await runtime.uninstall();
    assert.deepEqual(JSON.parse(await readFile(journal, 'utf8')), { origin: 'original-operation' });
    await runtime.deleteEnvironment({ environmentId: installed.environment.environmentId });
    await assert.rejects(access(join(root, 'native-channel')), { code: 'ENOENT' });
    assert.equal(await readFile(unrelated, 'utf8'), 'operator data');
  } finally { await rm(root, { recursive: true, force: true }); }
});
