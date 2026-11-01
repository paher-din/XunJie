import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConnectionAuthority, RuntimeConnectionError } from '@xunjie/product-runtime/connections';

// A real receiver process over a real filesystem: no PostgreSQL, no transport stubs.
async function host(t, handler) {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-installation-grant-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  const authority = createConnectionAuthority({ root, service, handlers: { echo: handler } });
  return { root, service, authority };
}

async function invoke(service, identity, token, payload) {
  return fetch(`${service.endpoint}/runtime/capabilities/echo`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(3_000),
    headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-runtime-source-environment-id': identity.sourceEnvironmentId,
      'x-runtime-source-service-id': identity.sourceServiceId,
      'x-runtime-target-environment-id': service.environmentId,
      'x-runtime-target-service-id': service.serviceId,
      'x-runtime-protocol-version': String(service.protocolVersion),
    },
    body: JSON.stringify(payload),
  });
}

/** Distinguishes "rejected" from "handler never ran": status plus the echoed payload. */
async function call(service, identity, token, payload) {
  const response = await invoke(service, identity, token, payload);
  const body = await response.json().catch(() => null);
  return { status: response.status, result: body?.result ?? null };
}

/**
 * A grant written before installation identity was mandatory: same environment and service,
 * but no installation, so no later installation fence could attribute or retire it.
 */
async function forgeUnscopedGrant(root, service, identity) {
  const grantId = randomUUID();
  const token = `${grantId}.${randomBytes(32).toString('hex')}`;
  const directory = join(root, 'private', 'connections', service.environmentId, service.serviceId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = join(directory, `${grantId}.json`);
  await writeFile(file, JSON.stringify({
    formatVersion: 1, grantId, tokenHash: createHash('sha256').update(token).digest('hex'),
    sourceEnvironmentId: identity.sourceEnvironmentId, sourceServiceId: identity.sourceServiceId,
    capabilities: ['echo'], targetEnvironmentId: service.environmentId, targetServiceId: service.serviceId,
    protocolVersion: service.protocolVersion, generation: 0,
  }), { mode: 0o600 });
  await chmod(file, 0o600);
  return { token, file };
}

test('fencing one installation retires its grants and unattributable grants without voiding its successor', async t => {
  let writes = 0;
  const receiver = await host(t, payload => { writes++; return { accepted: payload }; });
  const identity = { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID() };
  const retired = { ...identity, sourceInstallationId: randomUUID() };
  const successor = { ...identity, sourceInstallationId: randomUUID() };
  const scoped = await receiver.authority.authorize({ ...retired, capabilities: ['echo'] });
  const legacy = await forgeUnscopedGrant(receiver.root, receiver.service, identity);
  if (process.platform !== 'win32') assert.equal((await stat(legacy.file)).mode & 0o777, 0o600);
  // Both credentials are accepted first, so every later rejection is caused by the fence alone.
  assert.deepEqual(await call(receiver.service, identity, scoped.token, 'before-fence'),
    { status: 200, result: { accepted: 'before-fence' } });
  assert.deepEqual(await call(receiver.service, identity, legacy.token, 'before-fence'),
    { status: 200, result: { accepted: 'before-fence' } });
  assert.equal(writes, 2);

  const proof = await receiver.authority.fenceSource(retired);
  assert.equal(proof.generation, 1);
  assert.equal(proof.sourceInstallationId, retired.sourceInstallationId);

  // The retired instance's own grant is rejected by its installation generation.
  assert.equal((await call(receiver.service, identity, scoped.token, 'retired')).status, 401);
  // The grant that names no installation belongs to no successor, so it is revoked outright
  // rather than left behind for a generation check that can never reach it.
  await assert.rejects(stat(legacy.file), error => error.code === 'ENOENT');
  assert.equal((await call(receiver.service, identity, legacy.token, 'unattributable')).status, 401);
  assert.equal(writes, 2, 'no handler may run for a retired or unattributable credential');

  const renewed = await receiver.authority.authorize({ ...successor, capabilities: ['echo'] });
  assert.deepEqual(await call(receiver.service, identity, renewed.token, 'successor'),
    { status: 200, result: { accepted: 'successor' } });
  assert.equal(writes, 3);
  // Fencing the retired instance never releases it, and the successor is untouched.
  assert.equal((await call(receiver.service, identity, scoped.token, 'retired-again')).status, 401);
  assert.equal((await call(receiver.service, identity, legacy.token, 'unattributable-again')).status, 401);
  assert.deepEqual(await call(receiver.service, identity, renewed.token, 'successor-again'),
    { status: 200, result: { accepted: 'successor-again' } });
  assert.equal(writes, 4);
});

test('an authorization is refused unless it binds the installation that will hold the grant', async t => {
  let writes = 0;
  const receiver = await host(t, payload => { writes++; return { accepted: payload }; });
  const identity = { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID() };
  for (const input of [{ ...identity, capabilities: ['echo'] },
    { ...identity, sourceInstallationId: undefined, capabilities: ['echo'] },
    { ...identity, sourceInstallationId: 'not-an-installation', capabilities: ['echo'] }]) {
    await assert.rejects(receiver.authority.authorize(input),
      error => error instanceof RuntimeConnectionError && error.code === 'invalid_authorization');
  }
  assert.equal(writes, 0);
  const grant = await receiver.authority.authorize({ ...identity, sourceInstallationId: randomUUID(),
    capabilities: ['echo'] });
  assert.equal(grant.sourceInstallationId.length, 36);
  assert.deepEqual(await call(receiver.service, identity, grant.token, 'bound'),
    { status: 200, result: { accepted: 'bound' } });
  assert.equal(writes, 1);
  const stored = JSON.parse(await readFile(join(receiver.root, 'private', 'connections',
    receiver.service.environmentId, receiver.service.serviceId, `${grant.grantId}.json`), 'utf8'));
  assert.equal(stored.sourceInstallationId, grant.sourceInstallationId);
  assert.equal(stored.installationGeneration, 0);
});
