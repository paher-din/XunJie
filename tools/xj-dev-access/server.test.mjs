// Real HTTPS/proofs/store; system/account edges are controlled here. Live ECS
// enrollment and revocation are separate acceptance, never inferred from this.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from '../xj-dev/src/certificates.mjs';
import { environmentPaths } from '../xj-dev/src/paths.mjs';
import { AccessError, digest, signProof, writePrivateJson } from '../xj-dev/src/enrollment-protocol.mjs';
import { createAccessService } from './server.mjs';
import { adminRequest } from './admin.mjs';
import { openAccessStore } from './store.mjs';

test('HTTPS enroll resumes only unfinished stages; device/member revocation and replay checks share one store', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xja-')));
  let service;
  try {
    const ca = ensureCertificateAuthority(root), cert = ensureEnvironmentCertificate(environmentPaths(root, 'cert'), ca);
    const credentialKeyFile = join(root, 'credential.key'); writeFileSync(credentialKeyFile, randomBytes(32), { mode: 0o600 });
    const knownHostsFile = join(root, 'pins'); writeFileSync(knownHostsFile, 'approved.test ssh-ed25519 public-test-pin\n');
    const keys = [join(root, 'one'), join(root, 'two')];
    for (const key of keys) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore' });
    const systemCalls = [], applicationCalls = [];
    let failApplication = true, failClose = true;
    const config = { serviceId: 'https-test-service', endpoint: 'https://localhost:8443', listenHost: '127.0.0.1', port: 0,
      databaseFile: join(root, 'access.sqlite'), credentialKeyFile, adminSocket: join(root, 'a'), backupDirectory: root,
      tls: { keyFile: cert.keyFile, certFile: cert.certFile, caFile: ca.certFile }, knownHostsFile, cloudCaFile: ca.certFile,
      courseIds: ['approved-course'], target: { schema: 'xj-dev/connection-v1', host: 'approved.test', port: 22, applicationPort: 13444, browserOrigin: 'https://localhost:13445' } };
    service = createAccessService(config, {
      system: async input => {
        systemCalls.push(input.operation);
        if (input.operation === 'revoke' && failClose) { failClose = false; throw new AccessError('DEVICE_CLOSE_INCOMPLETE', 503); }
        return { username: 'xjd_' + input.deviceId.replaceAll('-', '').slice(0, 28), connectionsClosed: true };
      },
      application: async (operation, input) => {
        applicationCalls.push(operation);
        if (operation === 'ensure' && failApplication) { failApplication = false; throw new AccessError('APPLICATION_CONTROL_UNAVAILABLE', 503); }
        return { applicationReady: true };
      },
    });
    await service.listen();
    const call = (path, body) => new Promise((accept, reject) => {
      const req = request({ hostname: '127.0.0.1', port: service.publicServer.address().port, path, method: 'POST', ca: readFileSync(ca.certFile), headers: { 'content-type': 'application/json' } }, res => {
        let text = ''; res.on('data', bytes => { text += bytes; }); res.on('end', () => accept({ status: res.statusCode, body: JSON.parse(text) }));
      }); req.on('error', reject); req.end(JSON.stringify(body));
    });
    const inviteInput = { label: 'member', teamRole: 'developer', courseId: 'approved-course', appRole: 'student', capabilities: ['page'], ttlSeconds: 60 };
    const i = await adminRequest(config.adminSocket, 'invite', inviteInput);
    const proof = async (path, body, index = 0, invitationSecret) => {
      const response = await call('/v1/challenges', { publicKey: readFileSync(keys[index] + '.pub', 'utf8'), method: 'POST', path, bodyHash: digest(JSON.stringify(body)), invitationSecret, deviceId: body.deviceId });
      if (response.status !== 200) return response;
      return { challengeId: response.body.data.challengeId, signature: signProof(keys[index], response.body.data), body };
    };
    const first = await call('/v1/enroll', await proof('/v1/enroll', { invitationSecret: i.secret }, 0, i.secret));
    assert.equal(first.status, 503);
    assert.equal(service.store.inspect().devices.length, 1);
    const joined = await call('/v1/enroll', await proof('/v1/enroll', { invitationSecret: i.secret }, 0, i.secret));
    assert.equal(joined.status, 200);
    assert.equal(systemCalls.filter(op => op === 'ensure').length, 1, 'completed SSH stage is not repeated');
    assert.equal(applicationCalls.length, 2, 'unfinished application stage is resumed');
    const id = joined.body.data.identity.deviceId;
    assert.equal(joined.body.data.identity.teamRole, 'developer');
    assert.equal(typeof joined.body.data.account.password, 'string');
    const second = await adminRequest(config.adminSocket, 'invite', { ...inviteInput, memberId: i.memberId });
    const b = await call('/v1/enroll', await proof('/v1/enroll', { invitationSecret: second.secret }, 1, second.secret));
    assert.equal(b.status, 200);
    assert.equal(digest(b.body.data.account.password), digest(joined.body.data.account.password));
    const body = { deviceId: id }, envelope = await proof('/v1/config', body);
    assert.equal((await call('/v1/config', envelope)).status, 200);
    assert.equal((await call('/v1/config', envelope)).status, 401);
    assert.equal((await call('/inspect', {})).status, 404, 'owner management is not a public route');
    await assert.rejects(adminRequest(config.adminSocket, 'revoke-device', { deviceId: id }), { code: 'DEVICE_CLOSE_INCOMPLETE' });
    assert.equal(service.store.device(id).state, 'revoked');
    assert.equal(service.store.device(id).close_ready, 0);
    assert.equal((await proof('/v1/config', body)).status, 403);
    await adminRequest(config.adminSocket, 'revoke-device', { deviceId: id });
    assert.equal(service.store.device(id).close_ready, 1);
    const otherId = b.body.data.identity.deviceId;
    assert.equal((await call('/v1/config', await proof('/v1/config', { deviceId: otherId }, 1))).status, 200);
    await adminRequest(config.adminSocket, 'revoke-member', { memberId: i.memberId });
    assert.equal((await proof('/v1/config', { deviceId: otherId }, 1)).status, 403);
    assert.equal(applicationCalls.at(-1), 'disable');
    // Exercise the actual CLI route against this real HTTPS service, not a
    // separate protocol fixture. Privileged resource edges remain controlled.
    const cliInvite = await adminRequest(config.adminSocket, 'invite', { ...inviteInput, label: 'cli-member' });
    cliInvite.endpoint = `https://127.0.0.1:${service.publicServer.address().port}`;
    // Host pins are valid public key material; use the fixture device's public
    // key as a non-secret pinned-host fixture (no SSH success is inferred).
    writeFileSync(knownHostsFile, 'approved.test ' + readFileSync(keys[0] + '.pub', 'utf8').trim() + '\n');
    cliInvite.sshKnownHosts = readFileSync(knownHostsFile, 'utf8');
    const invitationFile = join(root, 'cli-invite.json'); writePrivateJson(invitationFile, cliInvite);
    const tool = fileURLToPath(new URL('../xj-dev/xj-dev.mjs', import.meta.url));
    const worktree = dirname(dirname(dirname(tool)));
    const cli = args => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tool, ...args, '--worktree', worktree], { env: { ...process.env, XJ_DEV_HOME: join(root, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', error = ''; child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
      child.on('error', reject); child.on('exit', code => {
        assert.equal(out.includes(cliInvite.secret), false); assert.equal(error.includes(cliInvite.secret), false);
        resolve({ code, result: JSON.parse(out) });
      });
    });
    const firstCli = await cli(['join', '--invitation-file', invitationFile, '--no-start']);
    assert.equal(firstCli.code, 0); assert.equal(firstCli.result.ok, true);
    assert.equal(firstCli.result.enrollment.state, 'registered');
    const cliDevice = firstCli.result.enrollment.identity.deviceId;
    const repeatedCli = await cli(['join', '--invitation-file', invitationFile, '--no-start']);
    assert.equal(repeatedCli.code, 0); assert.equal(repeatedCli.result.enrollment.identity.deviceId, cliDevice);
    const refreshedCli = await cli(['refresh']);
    assert.equal(refreshedCli.code, 0); assert.equal(refreshedCli.result.enrollment.identity.deviceId, cliDevice);
    assert.equal(service.store.inspect().devices.filter(d => d.id === cliDevice).length, 1);
    const saved = await adminRequest(config.adminSocket, 'snapshot', { destination: join(root, 'snapshot.sqlite') });
    const restored = openAccessStore(saved.file, saved.keyFile, config.serviceId);
    try {
      assert.equal(restored.inspect().devices.length, service.store.inspect().devices.length);
      assert.equal(digest(restored.credentials(cliInvite.memberId).password), digest(service.store.credentials(cliInvite.memberId).password));
      assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(restored.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { restored.close(); }

  } finally { await service?.close(); rmSync(root, { force: true, recursive: true }); }
});
