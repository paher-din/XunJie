import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { once } from 'node:events';
import { createHandler, endToEndHeaders, staticFile } from './local-ui-gateway.mjs';

function cleanup(directory) {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xunjie-ui55-'))
    throw new Error('Unexpected fixture cleanup target.');
  rmSync(directory, { recursive: true });
}

test('end-to-end auth, Origin, CSRF and Cookie headers survive; hop-by-hop headers do not', () => {
  const headers = endToEndHeaders({ origin: 'https://127.0.0.1:3443', cookie: 'synthetic-cookie',
    'x-csrf-token': 'synthetic-csrf', 'idempotency-key': 'synthetic-command', connection: 'keep-alive, x-hop',
    'keep-alive': 'timeout=5', 'x-hop': 'remove', 'set-cookie': ['__Host-synthetic=opaque; HttpOnly; Secure; SameSite=Lax; Path=/'] });
  assert.equal(headers.origin, 'https://127.0.0.1:3443');
  assert.equal(headers.cookie, 'synthetic-cookie');
  assert.equal(headers['x-csrf-token'], 'synthetic-csrf');
  assert.equal(headers['idempotency-key'], 'synthetic-command');
  assert.equal(headers['set-cookie'][0], '__Host-synthetic=opaque; HttpOnly; Secure; SameSite=Lax; Path=/');
  assert.equal(headers.connection, undefined); assert.equal(headers['keep-alive'], undefined); assert.equal(headers['x-hop'], undefined);
});

test('static path boundaries reject traversal, malformed escapes and junction escape', t => {
  const directory = mkdtempSync(join(tmpdir(), 'xunjie-ui55-path-'));
  t.after(() => cleanup(directory));
  const root = join(directory, 'dist'), outside = join(directory, 'outside');
  mkdirSync(root); mkdirSync(outside); writeFileSync(join(root, 'index.html'), 'student'); writeFileSync(join(outside, 'private.txt'), 'not served');
  symlinkSync(outside, join(root, 'escape'), 'junction');
  assert.equal(staticFile(root, '/?ignored=1'), join(root, 'index.html'));
  for (const path of ['/../outside/private.txt', '/%2e%2e/outside/private.txt', '/%5c..%5coutside/private.txt',
    '/C:/private.txt', '//outside/private.txt', '/%00', '/%', '/escape/private.txt', '/__i0prep/context'])
    assert.equal(staticFile(root, path), null, path);
});

function get(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((accept, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { host: '127.0.0.1:3443', ...headers } }, res => {
      const parts = []; res.on('data', part => parts.push(part)); res.on('error', reject);
      res.on('end', () => accept({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('wire forwarding preserves method/body/rejection, never repairs Origin or retries a write', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'xunjie-ui55-wire-'));
  writeFileSync(join(directory, 'index.html'), 'normal student dist');
  const received = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(403, { 'Content-Type': 'application/json', 'Set-Cookie': '__Host-synthetic=opaque; HttpOnly; Secure; SameSite=Lax; Path=/' });
    res.end('{"requestId":"synthetic-only","error":{"code":"FORBIDDEN"}}');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const port = upstream.address().port;
  // Test HTTP transport only; production uses hard-coded HTTPS and the exact PAHER leaf pin.
  const gateway = createServer(createHandler({ staticDirectory: directory, upstreamPort: port, upstreamCA: 'public-test-only' }, (options, callback) => {
    assert.equal(options.rejectUnauthorized, true);
    assert.ok(options.checkServerIdentity('127.0.0.1', { raw: Buffer.from('wrong-cert'), subjectaltname: 'IP Address:127.0.0.1' }) instanceof Error);
    return httpRequest(options, callback);
  }));
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(async () => { gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => upstream.close(r))]); cleanup(directory); });
  const gatewayPort = gateway.address().port;
  const body = '{"expectedRevision":1,"text":"synthetic text"}';
  const response = await get(gatewayPort, '/api/attempts/synthetic/sync?keep=1', { method: 'POST', body,
    headers: { origin: 'https://unapproved.invalid', cookie: 'synthetic-cookie', 'x-csrf-token': 'synthetic-csrf', 'idempotency-key': 'synthetic-key' } });
  assert.equal(response.status, 403); assert.equal(response.body, '{"requestId":"synthetic-only","error":{"code":"FORBIDDEN"}}');
  assert.match(response.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Lax; Path=\//);
  assert.equal(received.length, 1); assert.equal(received[0].method, 'POST'); assert.equal(received[0].url, '/api/attempts/synthetic/sync?keep=1');
  assert.equal(received[0].body, body); assert.equal(received[0].headers.origin, 'https://unapproved.invalid');
  assert.equal(received[0].headers['x-csrf-token'], 'synthetic-csrf'); assert.equal(received[0].headers.cookie, 'synthetic-cookie');
  assert.equal((await get(gatewayPort, '/', { method: 'POST', body: 'not a command' })).status, 405);
  assert.equal((await get(gatewayPort, '/__i0prep/context')).status, 404);
  assert.equal((await get(gatewayPort, '/api/session', { headers: { host: 'other.invalid' } })).status, 421);
  assert.equal(received.length, 1);
});
