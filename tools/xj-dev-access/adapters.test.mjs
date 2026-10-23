import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applicationOperation } from './adapters.mjs';
import { createAccessService } from './server.mjs';
import { adminRequest } from './admin.mjs';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from '../xj-dev/src/certificates.mjs';
import { environmentPaths } from '../xj-dev/src/paths.mjs';
import { digest, signProof } from '../xj-dev/src/enrollment-protocol.mjs';

test('real partial Unix HTTP failures settle; a total deadline also bounds trickling responses', { skip: process.platform === 'win32' }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xad-'))), socket = join(root, 's');
  let mode = 'abort', interval;
  const product = createServer((req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ok":');
    if (mode === 'abort') setImmediate(() => res.destroy());
    else { interval = setInterval(() => res.write(' '), 10); res.once('close', () => clearInterval(interval)); }
  });
  product.listen(socket); await once(product, 'listening');
  try {
    for (mode of ['abort', 'trickle']) {
      const started = Date.now();
      await assert.rejects(applicationOperation(socket, 'disable', {}, { timeoutMs: 100 }), { code: 'APPLICATION_CONTROL_UNAVAILABLE' });
      assert.ok(Date.now() - started < 2000);
    }
  } finally { clearInterval(interval); product.closeAllConnections(); await new Promise(done => product.close(done)); rmSync(root, { recursive: true, force: true }); }
});

test('a truncated product reply cannot wedge admin serial work; member deny survives and later inspect/device revoke run', { skip: process.platform === 'win32' }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xaq-'))), socket = join(root, 'p');
  const product = createServer((req, res) => { req.resume(); res.writeHead(200); res.write('{"ok":'); setImmediate(() => res.destroy()); });
  product.listen(socket); await once(product, 'listening');
  let service;
  try {
    const ca = ensureCertificateAuthority(root), cert = ensureEnvironmentCertificate(environmentPaths(root, 'cert'), ca), key = join(root, 'device');
    const credentialKeyFile = join(root, 'credential.key'), knownHostsFile = join(root, 'pins');
    writeFileSync(credentialKeyFile, randomBytes(32), { mode: 0o600 }); writeFileSync(knownHostsFile, 'fixture');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore' });
    const closed = [];
    service = createAccessService({ serviceId: 'partial-response-service', endpoint: 'https://localhost:8443', listenHost: '127.0.0.1', port: 0,
      databaseFile: join(root, 'access.sqlite'), credentialKeyFile, adminSocket: join(root, 'a'), backupDirectory: root,
      tls: { keyFile: cert.keyFile, certFile: cert.certFile, caFile: ca.certFile }, knownHostsFile, cloudCaFile: ca.certFile,
      courseIds: ['course'], target: { schema: 'xj-dev/connection-v1' } }, {
      application: (op, body) => applicationOperation(socket, op, body, { timeoutMs: 100 }),
      system: async input => { closed.push(input.deviceId); return { connectionsClosed: true }; },
    });
    await service.listen();
    const i = service.store.createInvitation({ label: 'fixture', teamRole: 'developer', courseId: 'course', appRole: 'student', capabilities: ['page'], ttlSeconds: 60 });
    const body = { invitationSecret: i.secret };
    const challenge = service.store.issueChallenge({ publicKey: readFileSync(key + '.pub', 'utf8'), invitationSecret: i.secret, method: 'POST', path: '/v1/enroll', bodyHash: digest(JSON.stringify(body)) });
    const device = service.store.authenticateProof({ challengeId: challenge.challengeId, signature: signProof(key, challenge), body }, '/v1/enroll');
    await assert.rejects(adminRequest(service.adminServer.address(), 'revoke-member', { memberId: i.memberId }), { code: 'REVOCATION_INCOMPLETE' });
    const state = await adminRequest(service.adminServer.address(), 'inspect', {});
    assert.equal(state.members[0].state, 'revoked');
    assert.throws(() => service.store.activeDevice(device.id), { code: 'DEVICE_REVOKED' });
    assert.deepEqual(closed, [device.id]);
    assert.equal((await adminRequest(service.adminServer.address(), 'revoke-device', { deviceId: device.id })).connectionsClosed, true);
  } finally { await service?.close(); product.closeAllConnections(); await new Promise(done => product.close(done)); rmSync(root, { recursive: true, force: true }); }
});
