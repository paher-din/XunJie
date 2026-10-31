import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { RuntimeConnection, RuntimeService } from '@xunjie/contracts/product-runtime';
import {
  createConnectionAuthority, createOutboundConnection, RuntimeConnectionError,
} from '@xunjie/product-runtime/connections';
import type { CapabilityHandler, ConnectionSource } from '@xunjie/product-runtime/connections';

async function listen(server: Server, port = 0): Promise<string> {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  await closed;
}

async function privateRoot(t: TestContext, beforeRemove?: () => Promise<void>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-connections-'));
  t.after(async () => { await beforeRemove?.(); await rm(root, { recursive: true, force: true }); });
  return root;
}

function service(endpoint: string, capabilities = ['echo']): RuntimeService {
  return {
    environmentId: randomUUID(), serviceId: randomUUID(), unit: 'tool-execution',
    protocolVersion: 1, endpoint, capabilities,
  };
}

function source(): ConnectionSource {
  return { sourceEnvironmentId: randomUUID(), sourceServiceId: randomUUID() };
}

function descriptor(target: RuntimeService, identity = source(), requiredCapabilities = ['echo'], optionalCapabilities: string[] = []): RuntimeConnection {
  return {
    connectionId: randomUUID(), ...identity, target: structuredClone(target),
    requiredCapabilities, optionalCapabilities, credentialRef: `test:${randomUUID()}`,
  };
}

function outbound(connection: RuntimeConnection, token: string, timeoutMs = 1_000) {
  return createOutboundConnection({ connection, credential: async () => token, allowInsecureLoopback: true, timeoutMs });
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof RuntimeConnectionError && error.code === code;
}

async function host(t: TestContext, handlers: Record<string, CapabilityHandler> = { echo: (payload) => payload }, root?: string) {
  const requests = new Set<Promise<unknown>>();
  let server: Server | undefined;
  const dispose = async () => {
    if (server) await close(server);
    // A disconnected socket does not mean its admitted handler has finished.
    await Promise.allSettled([...requests]);
  };
  const directory = root ?? await privateRoot(t, dispose);
  let authority: ReturnType<typeof createConnectionAuthority>;
  server = createServer((request, response) => {
    const handling = authority.handle(request, response).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    }).catch(() => response.destroy()).finally(() => { requests.delete(handling); });
    requests.add(handling);
  });
  t.after(dispose);
  const endpoint = await listen(server);
  const target = service(endpoint, Object.keys(handlers));
  authority = createConnectionAuthority({ root: directory, service: target, handlers });
  return {
    target, server, root: directory,
    get authority() { return authority; },
    reopen() { authority = createConnectionAuthority({ root: directory, service: target, handlers }); },
    async restart() {
      await close(server);
      authority = createConnectionAuthority({ root: directory, service: target, handlers });
      await listen(server, Number(new URL(endpoint).port));
    },
  };
}

async function invoke(target: RuntimeService, identity: ConnectionSource, token: string, path: string, payload?: unknown) {
  return fetch(`${target.endpoint}${path}`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(1_000),
    headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-runtime-source-environment-id': identity.sourceEnvironmentId,
      'x-runtime-source-service-id': identity.sourceServiceId,
      'x-runtime-target-environment-id': target.environmentId,
      'x-runtime-target-service-id': target.serviceId,
      'x-runtime-protocol-version': String(target.protocolVersion),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

test('routes between two real services without crossing target or source identities', async (t) => {
  const root = await privateRoot(t);
  const first = await host(t, { echo: (payload, caller) => ({ owner: 'first', payload, caller }) }, root);
  const second = await host(t, { echo: (payload) => ({ owner: 'second', payload }) }, root);
  const identity = source();
  const grantA = await first.authority.authorize({ ...identity, capabilities: ['echo'] });
  const grantB = await second.authority.authorize({ ...identity, capabilities: ['echo'] });
  const connectionA = descriptor(first.target, identity);
  const a = outbound(connectionA, grantA.token);
  const b = outbound(descriptor(second.target, identity), grantB.token);
  assert.equal((await a.check()).state, 'ready');
  assert.equal((await b.check()).state, 'ready');
  assert.deepEqual(await a.request('echo', { value: 7 }), {
    owner: 'first', payload: { value: 7 }, caller: { ...identity, grantId: grantA.grantId },
  });
  assert.deepEqual(await b.request('echo', { value: 8 }), { owner: 'second', payload: { value: 8 } });
  assert.equal((await outbound(descriptor(second.target, identity), grantA.token).check()).reason, 'http_401');
  for (const key of ['sourceEnvironmentId', 'sourceServiceId'] as const) {
    const impostor = { ...identity, [key]: randomUUID() };
    const client = outbound(descriptor(first.target, impostor), grantA.token);
    assert.equal((await client.check()).reason, 'http_401');
    assert.equal((await invoke(first.target, impostor, grantA.token, '/runtime/capabilities/echo')).status, 401);
  }
  for (const key of ['environmentId', 'serviceId'] as const) {
    const wrongTarget = { ...first.target, [key]: randomUUID() };
    assert.equal((await outbound(descriptor(wrongTarget, identity), grantA.token).check()).reason, 'http_409');
  }
  const wrongProtocol = { ...first.target, protocolVersion: 2 } as unknown as RuntimeService;
  assert.equal((await outbound(descriptor(wrongProtocol, identity), grantA.token).check()).reason, 'http_409');
  // Descriptor mutation cannot redirect an existing connection to the second service.
  connectionA.target.endpoint = second.target.endpoint;
  connectionA.sourceServiceId = randomUUID();
  assert.equal((await a.check()).target.endpoint, first.target.endpoint);
  assert.deepEqual(await a.request('echo', 9), {
    owner: 'first', payload: 9, caller: { ...identity, grantId: grantA.grantId },
  });
});

test('capability scope is enforced by the receiver and controls required versus optional readiness', async (t) => {
  let privilegedCalls = 0;
  const receiver = await host(t, { echo: (payload) => payload, restricted: () => { privilegedCalls++; return 'restricted'; } });
  const identity = source();
  const grant = await receiver.authority.authorize({ ...identity, capabilities: ['echo'] });
  const client = outbound(descriptor(receiver.target, identity, ['echo'], ['restricted', 'absent']), grant.token);
  const status = await client.check();
  assert.equal(status.state, 'degraded');
  assert.deepEqual(status.availableCapabilities, ['echo']);
  assert.deepEqual(status.missingOptionalCapabilities, ['restricted', 'absent']);
  assert.equal(await client.request('echo', 'allowed'), 'allowed');
  await assert.rejects(client.request('restricted'), hasCode('capability_unavailable'));
  await assert.rejects(client.request('not-configured'), hasCode('capability_not_configured'));
  const forbidden = await invoke(receiver.target, identity, grant.token, '/runtime/capabilities/restricted', { attack: true });
  assert.equal(forbidden.status, 403);
  assert.equal(privilegedCalls, 0);
  for (const required of ['restricted', 'absent']) {
    const needsMissing = outbound(descriptor(receiver.target, identity, ['echo', required]), grant.token);
    const failed = await needsMissing.check();
    assert.equal(failed.state, 'unavailable');
    assert.equal(failed.reason, 'required_capability_unavailable');
    assert.deepEqual(failed.missingRequiredCapabilities, [required]);
    await assert.rejects(needsMissing.request('echo'), hasCode('required_capability_unavailable'));
  }
});

test('grants survive reopening, persist only hashed credentials, and revocation reaches existing and reopened authorities', async (t) => {
  const receiver = await host(t);
  const identity = source();
  const grant = await receiver.authority.authorize({ ...identity, capabilities: ['echo'] });
  const client = outbound(descriptor(receiver.target, identity), grant.token);
  assert.equal(await client.request('echo', 'before'), 'before');
  const files = await readdir(receiver.root, { recursive: true, withFileTypes: true });
  let fileCount = 0;
  for (const entry of files) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile()) {
      fileCount++;
      assert.equal((await readFile(path, 'utf8')).includes(grant.token), false);
      assert.equal((await readFile(path, 'utf8')).includes(grant.token.split('.')[1]!), false);
      if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    } else if (entry.isDirectory() && process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o700);
    }
  }
  assert.ok(fileCount > 0);
  const originalAuthority = receiver.authority;
  receiver.reopen();
  assert.equal(await client.request('echo', 'after-reopen'), 'after-reopen');
  assert.equal(await originalAuthority.revoke(grant.grantId), true);
  assert.equal((await client.check()).reason, 'http_401');
  assert.equal((await invoke(receiver.target, identity, grant.token, '/runtime/capabilities/echo')).status, 401);
  receiver.reopen();
  assert.equal((await client.check()).reason, 'http_401');
  await assert.rejects(client.request('echo', 'revoked'), hasCode('http_401'));
  assert.equal(await receiver.authority.revoke(grant.grantId), false);
});

test('disconnect and reconnect retain the original target, source and revoked grant without fallback', async (t) => {
  const receiver = await host(t, { echo: (payload, caller) => ({ payload, caller }) });
  let otherCalls = 0;
  const other = await host(t, { echo: () => { otherCalls++; return 'wrong'; } });
  const identity = source();
  const grant = await receiver.authority.authorize({ ...identity, capabilities: ['echo'] });
  const configuration = descriptor(receiver.target, identity);
  const client = outbound(configuration, grant.token, 500);
  assert.equal((await client.check()).state, 'ready');
  await close(receiver.server);
  configuration.target = other.target;
  assert.equal((await client.check()).state, 'unavailable');
  await assert.rejects(client.request('echo', 'offline'), hasCode('connection_unavailable'));
  await receiver.restart();
  assert.deepEqual(await client.request('echo', 'reconnected'), {
    payload: 'reconnected', caller: { ...identity, grantId: grant.grantId },
  });
  await receiver.authority.revoke(grant.grantId);
  await receiver.restart();
  assert.equal((await client.check()).reason, 'http_401');
  await assert.rejects(client.request('echo', 'old-grant'), hasCode('http_401'));
  const renewed = await receiver.authority.authorize({ ...identity, capabilities: ['echo'] });
  const explicitlyRenewed = outbound(descriptor(receiver.target, identity), renewed.token);
  assert.equal((await explicitlyRenewed.check()).state, 'ready');
  assert.equal(otherCalls, 0);
});

test('source fencing invalidates every old token across reconnect, authority rebuilding and restored legacy grant files', async (t) => {
  const receiver = await host(t);
  const identity = source();
  const otherIdentity = { ...identity, sourceServiceId: randomUUID() };
  const otherGrant = await receiver.authority.authorize({ ...otherIdentity, capabilities: ['echo'] });
  const grants = await Promise.all([0, 1].map(() => receiver.authority.authorize({ ...identity, capabilities: ['echo'] })));
  const clients = grants.map(grant => outbound(descriptor(receiver.target, identity), grant.token));
  // An installed pre-generation grant is accepted as generation zero.
  const oldPath = join(receiver.root, 'private', 'connections', receiver.target.environmentId,
    receiver.target.serviceId, `${grants[0]!.grantId}.json`);
  const legacy = JSON.parse(await readFile(oldPath, 'utf8'));
  delete legacy.generation;
  const legacyFile = JSON.stringify(legacy);
  await writeFile(oldPath, legacyFile);
  // A pre-generation installation has neither generation nor execution directories.
  await rm(join(receiver.root, 'private', 'connections', receiver.target.environmentId,
    receiver.target.serviceId, 'sources', identity.sourceEnvironmentId), { recursive: true, force: true });
  for (const client of clients) assert.equal(await client.request('echo', 'source-alive'), 'source-alive');
  const before = Date.now();
  const proof = await receiver.authority.fenceSource(identity);
  assert.deepEqual(Object.keys(proof).sort(), ['fencedAt', 'generation', 'sourceEnvironmentId', 'sourceServiceId']);
  assert.equal(proof.generation, 1);
  assert.equal(proof.sourceEnvironmentId, identity.sourceEnvironmentId);
  assert.equal(proof.sourceServiceId, identity.sourceServiceId);
  assert.ok(Date.parse(proof.fencedAt) >= before);
  for (const client of clients) {
    assert.equal((await client.check()).reason, 'http_401');
    await assert.rejects(client.request('echo'), hasCode('http_401'));
  }
  assert.equal(await outbound(descriptor(receiver.target, otherIdentity), otherGrant.token).request('echo', 'other'), 'other');
  await receiver.restart();
  for (const grant of grants) {
    assert.equal((await outbound(descriptor(receiver.target, identity), grant.token).check()).reason, 'http_401');
  }
  await receiver.authority.revoke(grants[0]!.grantId);
  await writeFile(oldPath, legacyFile);
  receiver.reopen();
  assert.equal((await clients[0]!.check()).reason, 'http_401');
  const renewed = await receiver.authority.authorize({ ...identity, capabilities: ['echo'] });
  assert.equal(await outbound(descriptor(receiver.target, identity), renewed.token).request('echo', 'renewed'), 'renewed');
  assert.equal((await clients[0]!.check()).reason, 'http_401');
});

test('source fencing waits for all parallel handlers, including those admitted by a previous authority', async (t) => {
  const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const finishes = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  t.after(() => finishes.forEach(finish => finish.resolve()));
  const receiver = await host(t, { echo: async (payload) => {
    const index = payload as number;
    starts[index]!.resolve();
    await finishes[index]!.promise;
    return index;
  } });
  const identity = source();
  const grant = await receiver.authority.authorize({ ...identity, capabilities: ['echo'] });
  const client = outbound(descriptor(receiver.target, identity), grant.token, 3_000);
  const requests = [client.request('echo', 0), client.request('echo', 1)];
  await Promise.all(starts.map(start => start.promise));
  receiver.reopen();
  const fencing = receiver.authority.fenceSource({ ...identity, timeoutMs: 2_000 });
  assert.equal(await Promise.race([fencing.then(() => true), delay(40, false)]), false);
  assert.equal((await client.check()).reason, 'http_401');
  finishes[0]!.resolve();
  assert.equal(await requests[0], 0);
  assert.equal(await Promise.race([fencing.then(() => true), delay(40, false)]), false);
  finishes[1]!.resolve();
  assert.equal(await requests[1], 1);
  assert.equal((await fencing).generation, 1);
});

test('source fencing fails explicitly when an in-flight caller disconnects without stopping its handler', async (t) => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  const receiver = await host(t, { echo: async () => {
    started.resolve();
    await finish.promise;
  } });
  const identity = source();
  const grant = await receiver.authority.authorize({ ...identity, capabilities: ['echo'] });
  const client = outbound(descriptor(receiver.target, identity), grant.token, 2_000);
  const requestFailure = assert.rejects(client.request('echo'), hasCode('connection_unavailable'));
  await started.promise;
  await close(receiver.server);
  await requestFailure;
  await assert.rejects(receiver.authority.fenceSource({ ...identity, timeoutMs: 300 }), hasCode('fence_source_disconnected'));
  finish.resolve();
});

test('source fencing timeout never returns a proof or reopens an old authorization', async (t) => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  const receiver = await host(t, { echo: async () => {
    started.resolve();
    await finish.promise;
    return 'finished';
  } });
  const identity = source();
  const grant = await receiver.authority.authorize({ ...identity, capabilities: ['echo'] });
  const client = outbound(descriptor(receiver.target, identity), grant.token, 2_000);
  const request = client.request('echo');
  await started.promise;
  const before = Date.now();
  await assert.rejects(receiver.authority.fenceSource({ ...identity, timeoutMs: 80 }), hasCode('timeout'));
  assert.ok(Date.now() - before < 1_000);
  receiver.reopen();
  assert.equal((await client.check()).reason, 'http_401');
  finish.resolve();
  assert.equal(await request, 'finished');
  assert.equal((await receiver.authority.fenceSource(identity)).generation, 2);
  assert.equal((await client.check()).reason, 'http_401');
});

test('parallel fencing and authorization across authorities never lose a generation or upgrade an existing token', async (t) => {
  const receiver = await host(t);
  const identity = source();
  const first = receiver.authority;
  receiver.reopen();
  const second = receiver.authority;
  const [proofs, grants] = await Promise.all([
    Promise.all([first.fenceSource(identity), second.fenceSource(identity), first.fenceSource(identity)]),
    Promise.all([first.authorize({ ...identity, capabilities: ['echo'] }), second.authorize({ ...identity, capabilities: ['echo'] })]),
  ]);
  assert.deepEqual(proofs.map(proof => proof.generation).sort(), [1, 2, 3]);
  assert.equal((await second.fenceSource(identity)).generation, 4);
  for (const grant of grants) {
    assert.equal((await outbound(descriptor(receiver.target, identity), grant.token).check()).reason, 'http_401');
  }
  const renewed = await first.authorize({ ...identity, capabilities: ['echo'] });
  assert.equal(await outbound(descriptor(receiver.target, identity), renewed.token).request('echo', 'latest'), 'latest');
});

test('fencing from independent receiver processes persists after those processes exit', async (t) => {
  const receiver = await host(t);
  const identity = source();
  const grant = await receiver.authority.authorize({ ...identity, capabilities: ['echo'] });
  // Windows queries immutable OS process identities through cold PowerShell
  // processes. This case checks durable fencing, not the separate timeout contract.
  const fenceTimeoutMs = process.platform === 'win32' ? 30_000 : 3_000;
  const child = `
    import { createConnectionAuthority } from '@xunjie/product-runtime/connections';
    const [root, target, source] = process.argv.slice(1);
    const authority = createConnectionAuthority({ root, service: JSON.parse(target), handlers: { echo: value => value } });
    console.log(JSON.stringify(await authority.fenceSource({ ...JSON.parse(source), timeoutMs: ${fenceTimeoutMs} })));
  `;
  const results = await Promise.all([0, 1].map(() => promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', child, receiver.root, JSON.stringify(receiver.target), JSON.stringify(identity)], { timeout: fenceTimeoutMs + 5_000 })));
  assert.deepEqual(results.map(result => JSON.parse(result.stdout).generation).sort(), [1, 2]);
  receiver.reopen();
  assert.equal((await outbound(descriptor(receiver.target, identity), grant.token).check()).reason, 'http_401');
  assert.equal((await receiver.authority.fenceSource(identity)).generation, 3);
});

test('a slow capability body is authenticated again against the fenced generation before dispatch', async (t) => {
  let calls = 0;
  const receiver = await host(t, { echo: () => { calls++; return 'unexpected'; } });
  const identity = source();
  const grant = await receiver.authority.authorize({ ...identity, capabilities: ['echo'] });
  const request = httpRequest(`${receiver.target.endpoint}/runtime/capabilities/echo`, {
    method: 'POST', headers: {
      authorization: `Bearer ${grant.token}`, 'content-type': 'application/json',
      'x-runtime-source-environment-id': identity.sourceEnvironmentId,
      'x-runtime-source-service-id': identity.sourceServiceId,
      'x-runtime-target-environment-id': receiver.target.environmentId,
      'x-runtime-target-service-id': receiver.target.serviceId,
      'x-runtime-protocol-version': String(receiver.target.protocolVersion),
    },
  });
  t.after(() => request.destroy());
  const response = once(request, 'response');
  request.write('{"value":');
  await delay(40);
  await receiver.authority.fenceSource(identity);
  request.end('1}');
  const [received] = await response as [IncomingMessage];
  received.resume();
  assert.equal(received.statusCode, 401);
  assert.equal(calls, 0);
});

async function wireHost(t: TestContext, responder: (request: IncomingMessage, response: ServerResponse, target: RuntimeService) => void) {
  let target: RuntimeService;
  const server = createServer((request, response) => responder(request, response, target));
  t.after(() => close(server));
  target = service(await listen(server));
  return target;
}

test('outbound checks independently reject wrong environment, service, protocol and malformed capability responses', async (t) => {
  for (const field of ['environmentId', 'serviceId', 'protocolVersion', 'capabilities'] as const) {
    await t.test(field, async (t) => {
      const target = await wireHost(t, (_request, response, own) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ service: { ...own, [field]: field === 'protocolVersion' ? 2
          : field === 'capabilities' ? [null] : randomUUID() } }));
      });
      const client = outbound(descriptor(target), randomUUID());
      const status = await client.check();
      assert.equal(status.state, 'unavailable');
      assert.equal(status.reason, field === 'protocolVersion' ? 'protocol_mismatch'
        : field === 'capabilities' ? 'invalid_response' : 'target_identity_mismatch');
      await assert.rejects(client.request('echo'), hasCode(status.reason!));
    });
  }
});

test('capability responses are identity checked even after a successful handshake', async (t) => {
  const target = await wireHost(t, (request, response, own) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ service: request.url === '/runtime/connect' ? own
      : { ...own, serviceId: randomUUID() }, result: 'wrong-owner' }));
  });
  const client = outbound(descriptor(target), randomUUID());
  assert.equal((await client.check()).state, 'ready');
  await assert.rejects(client.request('echo'), hasCode('target_identity_mismatch'));
});

test('handshake and capability redirects are refused without sending credentials to the destination', async (t) => {
  let destinationRequests = 0;
  const destination = await wireHost(t, (_request, response) => {
    destinationRequests++;
    response.end('{}');
  });
  for (const status of [301, 302, 303, 307, 308]) {
    for (const phase of ['handshake', 'capability']) {
      await t.test(`${status} ${phase}`, async (t) => {
        const target = await wireHost(t, (request, response, own) => {
          if (phase === 'capability' && request.url === '/runtime/connect') {
            response.end(JSON.stringify({ service: own }));
          } else {
            response.writeHead(status, { location: `${destination.endpoint}/credential-sink` });
            response.end();
          }
        });
        const client = outbound(descriptor(target), randomUUID());
        if (phase === 'handshake') assert.equal((await client.check()).reason, 'redirect_refused');
        await assert.rejects(client.request('echo'), hasCode('redirect_refused'));
      });
    }
  }
  assert.equal(destinationRequests, 0);
});

test('timeouts bound stalled response bodies and credential resolution', async (t) => {
  const target = await wireHost(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
  });
  const stalled = outbound(descriptor(target), randomUUID(), 80);
  const started = Date.now();
  assert.equal((await stalled.check()).reason, 'timeout');
  assert.ok(Date.now() - started < 2_000);
  await assert.rejects(stalled.request('echo'), hasCode('timeout'));
  const noCredential = createOutboundConnection({
    connection: descriptor(target), allowInsecureLoopback: true, timeoutMs: 30,
    credential: () => new Promise<string>(() => {}),
  });
  assert.equal((await noCredential.check()).reason, 'timeout');
});

test('HTTPS is mandatory by default and insecure transport is restricted to explicit loopback testing', async () => {
  for (const endpoint of ['http://127.0.0.1:1', 'http://localhost:1', 'http://[::1]:1', 'http://school.example']) {
    assert.throws(() => createOutboundConnection({ connection: descriptor(service(endpoint)), credential: async () => randomUUID() }),
      hasCode('secure_endpoint_required'));
  }
  for (const endpoint of ['http://school.example', 'http://127.0.0.1.school.example', 'ftp://127.0.0.1', 'https://user:secret@school.example']) {
    assert.throws(() => outbound(descriptor(service(endpoint)), randomUUID()), hasCode('secure_endpoint_required'));
  }
  assert.doesNotThrow(() => createOutboundConnection({
    connection: descriptor(service('https://school.example')), credential: async () => randomUUID(),
  }));
});

test('unrelated HTTP routes remain with the host and undeclared handlers cannot be exposed', async (t) => {
  const receiver = await host(t);
  assert.equal((await fetch(`${receiver.target.endpoint}/unrelated`)).status, 404);
  assert.equal((await fetch(`${receiver.target.endpoint}/runtime/connect`)).status, 405);
  assert.throws(() => createConnectionAuthority({
    root: receiver.root, service: receiver.target, handlers: { hidden: () => 'hidden' },
  }), hasCode('undeclared_capability'));
});
