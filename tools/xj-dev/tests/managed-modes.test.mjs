import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CONNECTION_SCHEMA, checkBackend, classifySshFailure, loadConnection, sshArguments } from '../src/connection.mjs';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from '../src/certificates.mjs';
import { environmentPaths } from '../src/paths.mjs';
import { resolveContext } from '../src/commands.mjs';
import { loadSelection, selectionFile, useMode } from '../src/modes.mjs';

test('连接材料只接受核准格式、精确主机 pin、有效 HTTPS Origin 和登记节点', () => {
  const root = mkdtempSync(join(tmpdir(), 'xj-connection-'));
  try {
    writeFileSync(join(root, 'identity'), 'invalid-test-private-key-placeholder');
    writeFileSync(join(root, 'known_hosts'), 'example.test ssh-ed25519 AAAA\n');
    writeFileSync(join(root, 'ca.pem'), 'invalid-test-certificate-placeholder');
    const file = join(root, 'connection.json');
    const config = { schema: CONNECTION_SCHEMA, host: 'example.test', port: 22, browserUser: 'browser', identityFile: 'identity', knownHostsFile: 'known_hosts', caFile: 'ca.pem', browserOrigin: 'https://localhost:3445', applicationPort: 3444 };
    writeFileSync(file, JSON.stringify(config));
    const c = loadConnection(file);
    assert.equal(c.identityFile, join(root, 'identity'));
    assert.equal(sshArguments(c, 'page', 30000).at(-2), '127.0.0.1:30000:127.0.0.1:3444');
    assert.ok(sshArguments(c, 'page', 30000).includes('StrictHostKeyChecking=yes'));
    for (const override of [{ registered: false, schema: undefined, version: 1 }, { browserOrigin: 'https://localhost:3445/other' }, { host: '-oProxyCommand=bad' }, { nodeId: 'unknown' }]) {
      writeFileSync(file, JSON.stringify({ ...config, ...override }));
      assert.throws(() => loadConnection(file), { code: 'CONNECTION_INVALID' });
    }
    writeFileSync(file, JSON.stringify({ ...config, host: 'other.test' }));
    assert.throws(() => loadConnection(file), { code: 'HOST_IDENTITY_CHANGED' });
    assert.equal(classifySshFailure('Permission denied (publickey).').retryable, false);
    assert.equal(classifySshFailure('channel 1: open failed: administratively prohibited').code, 'PERMISSION_REVOKED');
    assert.equal(classifySshFailure('REMOTE HOST IDENTIFICATION HAS CHANGED').code, 'HOST_IDENTITY_CHANGED');
    assert.equal(classifySshFailure('Connection timed out').retryable, true);
    assert.equal(classifySshFailure('NUL: line 1: Bad configuration option').code, 'SSH_CONFIGURATION_INVALID');
    assert.equal(classifySshFailure('ssh executable unavailable').retryable, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('切换目标配置失败与未知模式保留原入口、现场和选择文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xj-selection-'));
  const context = resolveContext();
  context.env = environmentPaths(root, context.id);
  context.home = root;
  try {
    assert.equal(loadSelection(context).mode, 'local');
    await assert.rejects(useMode(context, 'cloud-api', { connection: join(root, 'missing.json') }), { code: 'CONNECTION_INVALID' });
    assert.equal(loadSelection(context).mode, 'local');
    await assert.rejects(useMode(context, 'unknown'), { code: 'UNKNOWN_MODE' });
    assert.throws(() => readFileSync(selectionFile(context)), { code: 'ENOENT' });
    // An explicitly reselected config must not inherit a stale identity override.
    const selected = { mode: 'local', targets: { 'cloud-api': { connectionFile: 'old.json', identityFile: join(root, 'removed-key') } } };
    writeFileSync(selectionFile(context), JSON.stringify(selected));
    writeFileSync(join(root, 'identity'), 'invalid-test-private-key-placeholder');
    writeFileSync(join(root, 'known_hosts'), 'other.test ssh-ed25519 AAAA\n');
    writeFileSync(join(root, 'ca.pem'), 'invalid-test-certificate-placeholder');
    const file = join(root, 'rotated.json');
    writeFileSync(file, JSON.stringify({ schema: CONNECTION_SCHEMA, host: 'example.test', port: 22, browserUser: 'browser', identityFile: 'identity', knownHostsFile: 'known_hosts', caFile: 'ca.pem', browserOrigin: 'https://localhost:3445', applicationPort: 3444 }));
    await assert.rejects(useMode(context, 'cloud-api', { connection: file }), { code: 'HOST_IDENTITY_CHANGED' });
    assert.deepEqual(loadSelection(context), selected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// These are controlled HTTPS boundary tests, not evidence of a live cloud login.
test('HTTPS 网关固定页面/API/HMR来源，隔离Cookie，精确Origin，断连拒绝业务且不重放', { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'xj-gateway-'));
  let child, cloud, vite;
  try {
    const ca = ensureCertificateAuthority(root);
    const cert = ensureEnvironmentCertificate(environmentPaths(root, 'cert'), ca);
    const received = [];
    cloud = createServer({ key: readFileSync(cert.keyFile), cert: readFileSync(cert.certFile) }, (req, res) => {
      received.push({ path: req.url, headers: req.headers, method: req.method });
      res.setHeader('set-cookie', '__Host-xunjie=controlled-session; Secure; HttpOnly; SameSite=Lax; Path=/');
      res.end('cloud');
    });
    const { createServer: httpServer } = await import('node:http');
    vite = httpServer((req, res) => res.end('local-vite'));
    cloud.listen(0, '127.0.0.1'); vite.listen(0, '127.0.0.1');
    await Promise.all([once(cloud, 'listening'), once(vite, 'listening')]);
    const statusFile = join(root, 'connection.json');
    const configFile = join(root, 'config.json');
    writeFileSync(statusFile, JSON.stringify({ state: 'ready', checkedAt: new Date().toISOString() }));
    writeFileSync(configFile, JSON.stringify({ mode: 'cloud-api', port: 0, backendPort: cloud.address().port, vitePort: vite.address().port, keyFile: cert.keyFile, certFile: cert.certFile, cloud: { caFile: ca.certFile, browserOrigin: 'https://localhost:3445' }, cookieName: '__Host-xunjie-mode', connectionStatusFile: statusFile }));
    // Let the OS allocate the port, then use the reported actual port in Host and
    // Origin checks. Production always reserves a stable nonzero port.
    const { createServer: netServer } = await import('node:net');
    const reservation = netServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(done => reservation.close(done));
    const config = JSON.parse(readFileSync(configFile)); config.port = port;
    writeFileSync(configFile, JSON.stringify(config));
    child = spawn(process.execPath, [fileURLToPath(new URL('../src/gateway.mjs', import.meta.url)), '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Gateway exited before ready.'); })]);
    const origin = `https://127.0.0.1:${port}`;
    const call = (path, method = 'GET', headers = {}) => new Promise((done, reject) => {
      const req = request(origin + path, { ca: readFileSync(ca.certFile), method, headers }, res => {
        let body = ''; res.on('data', data => { body += data; }); res.on('end', () => done({ status: res.statusCode, body, headers: res.headers }));
      }); req.on('error', reject); req.end();
    });
    assert.equal((await call('/src/main.tsx')).body, 'local-vite');
    assert.equal((await call('/api/session')).body, 'cloud');
    const write = await call('/api/controlled', 'POST', { origin, cookie: '__Host-xunjie=local; __Host-xunjie-other=other; __Host-xunjie-mode=cloud-mode', 'x-csrf-token': 'invalid-test-csrf-placeholder' });
    assert.equal(write.status, 200);
    assert.equal(received.at(-1).headers.origin, 'https://localhost:3445');
    assert.equal(received.at(-1).headers.cookie, '__Host-xunjie=cloud-mode');
    assert.match(write.headers['set-cookie'][0], /^__Host-xunjie-mode=/);
    assert.equal((await call('/api/controlled', 'POST', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('/api/controlled', 'POST')).status, 403);
    assert.equal(received.filter(req => req.method === 'POST').length, 1);
    writeFileSync(statusFile, JSON.stringify({ state: 'recovering', checkedAt: new Date().toISOString() }));
    assert.equal((await call('/api/controlled', 'POST', { origin })).status, 503);
    assert.equal((await call('/src/main.tsx')).body, 'local-vite');
    writeFileSync(statusFile, JSON.stringify({ state: 'ready', checkedAt: new Date().toISOString() }));
    await delay(100);
    assert.equal(received.filter(req => req.method === 'POST').length, 1, '恢复不重放业务写入');
    await assert.rejects(checkBackend({ caFile: ca.certFile, browserOrigin: 'https://localhost:3445' }, cloud.address().port), { code: 'BACKEND_INCOMPATIBLE' });
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    for (const server of [cloud, vite]) if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    rmSync(root, { recursive: true, force: true });
  }
});
