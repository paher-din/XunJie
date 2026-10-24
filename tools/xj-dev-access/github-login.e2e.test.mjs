import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from '../xj-dev/src/certificates.mjs';
import { environmentPaths } from '../xj-dev/src/paths.mjs';
import { opaque, privateJson } from '../xj-dev/src/enrollment-protocol.mjs';
import { githubLogin, readTeamService } from '../xj-dev/src/github-login.mjs';
import { authenticatedRequest, prepareEnrollment, joinEnrollment } from '../xj-dev/src/enrollment-client.mjs';
import { loginRoute } from '../xj-dev/src/enrollment-routes.mjs';
import { adminRequest } from './admin.mjs';
import { createAccessService } from './server.mjs';
import { openAccessStore } from './store.mjs';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xjgh-')));
  const ca = ensureCertificateAuthority(root), certificate = ensureEnvironmentCertificate(environmentPaths(root, 'tls'), ca);
  const key = join(root, 'credentials.key'), hostKey = join(root, 'host-key'), pins = join(root, 'pins');
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey], { stdio: 'ignore' });
  writeFileSync(pins, 'approved.test ' + readFileSync(hostKey + '.pub', 'utf8'));
  const state = { authorized: false, loseStart: false, failStart: false, starts: 0, interval: 1, slowDown: false, requests: 0,
    tokenPolls: 0, socket: undefined, system: [], application: [], applicationHook: undefined };
  const token = opaque(), deviceCode = opaque();
  const config = { serviceId: 'github-e2e', endpoint: 'https://127.0.0.1:8443', port: 0, listenHost: '127.0.0.1',
    github: { clientId: 'fixtureclientidentifier' }, databaseFile: join(root, 'access.sqlite'), credentialKeyFile: key,
    adminSocket: join(root, 'a'), backupDirectory: root,
    tls: { keyFile: certificate.keyFile, certFile: certificate.certFile, caFile: ca.certFile },
    knownHostsFile: pins, cloudCaFile: ca.certFile, courseIds: ['course'],
    target: { schema: 'xj-dev/connection-v1', host: 'approved.test', port: 22, applicationPort: 13444, browserOrigin: 'https://localhost:13445' } };
  // GitHub is the only simulated remote peer. TLS, SQLite, CLI publication,
  // SSHSIG, device proofs, account files and owner socket are real.
  const githubFetch = async (url, options) => {
    url = String(url);
    let data;
    if (url === 'https://github.com/login/device/code') {
      state.starts++;
      if (state.failStart) { state.failStart = false; throw new Error('Controlled upstream outage'); }
      assert.ok(!new URLSearchParams(options.body).get('scope'));
      if (state.loseStart) { state.loseStart = false; state.socket.destroy(); }
      data = { device_code: deviceCode, user_code: 'TEST-CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: state.interval };
    } else if (url === 'https://github.com/login/oauth/access_token') {
      state.tokenPolls++;
      data = state.slowDown ? { error: 'slow_down', interval: 65 }
        : state.authorized ? { access_token: token, token_type: 'bearer', scope: '' } : { error: 'authorization_pending' };
    } else if (url === 'https://api.github.com/user' || url === 'https://api.github.com/users/fixture-user') {
      if (url.endsWith('/user')) assert.equal(options.headers.Authorization ?? options.headers.authorization, 'Bearer ' + token);
      data = { id: 12345, login: 'fixture-user', type: 'User' };
    } else throw new Error('Unexpected GitHub URL');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const service = createAccessService(config, { githubFetch,
    system: async input => { state.system.push(input.operation); return { username: 'xjd_' + input.deviceId.replaceAll('-', '').slice(0, 28) }; },
    application: async (operation, input) => { state.application.push(operation); await state.applicationHook?.(operation, input); return {}; } });
  service.publicServer.on('request', req => { state.socket = req.socket; state.requests++; });
  await service.listen(); config.endpoint = 'https://127.0.0.1:' + service.publicServer.address().port;
  const serviceFile = join(root, 'team.json'), home = join(root, 'home');
  const descriptor = { schema: 'xj-dev/team-service-v1', protocol: 'xj-dev/access-v1', serviceId: config.serviceId, endpoint: config.endpoint,
    caPem: readFileSync(ca.certFile, 'utf8'), cloudCaPem: readFileSync(ca.certFile, 'utf8'), sshKnownHosts: readFileSync(pins, 'utf8'),
    githubClientId: 'fixtureclientidentifier', applicationName: 'Fixture Development Access' };
  writeFileSync(serviceFile, JSON.stringify(descriptor));
  return { root, state, token, deviceCode, service, serviceFile, home, descriptor, config,
    owner: (operation, input = {}) => adminRequest(config.adminSocket, operation, input),
    async close() { await service.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('GitHub login resumes a lost start, creates the approved personal device/account, and honors owner revocation', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const approved = await f.owner('github-approve', { githubLogin: 'fixture-user', label: 'Fixture', teamRole: 'developer', appRole: 'student', courseId: 'course', capabilities: ['page', 'file:read'] });
    assert.ok(approved);
    f.state.loseStart = true;
    await assert.rejects(githubLogin({ home: f.home, serviceFile: f.serviceFile }), { code: 'ACCESS_UNREACHABLE' });
    const pending = await githubLogin({ home: f.home, serviceFile: f.serviceFile });
    assert.equal(pending.state, 'authorization-required'); assert.equal(f.state.starts, 1);
    const visible = JSON.stringify(pending);
    assert.ok(!visible.includes(f.deviceCode) && !visible.includes(f.token) && !visible.includes('sessionSecret'));
    const beforePoll = await githubLogin({ home: f.home, serviceFile: f.serviceFile });
    assert.equal(beforePoll.state, 'authorization-required'); assert.equal(f.state.tokenPolls, 0);
    f.state.authorized = true;
    const context = { home: f.home, worktree: f.root, env: environmentPaths(f.home, 'test') };
    const registered = await loginRoute(context, { extraArgs: ['--service', f.serviceFile, '--wait-seconds', '3', '--no-start'] });
    assert.equal(registered.state, 'registered'); assert.equal(registered.started, false);
    const enrollment = registered.enrollment;
    const account = privateJson(enrollment.accountFile);
    assert.ok(account.password.length >= 32);
    assert.ok(!JSON.stringify(registered).includes(account.password));
    assert.ok(!existsSync(context.env.database));
    assert.deepEqual(f.state.system, ['ensure']); assert.deepEqual(f.state.application, ['ensure']);
    assert.equal((await authenticatedRequest(enrollment.deviceFile, '/v1/identity')).deviceId, enrollment.identity.deviceId);
    const reused = await githubLogin({ home: f.home, serviceFile: f.serviceFile });
    assert.equal(reused.reused, true); assert.equal(reused.enrollment.identity.deviceId, enrollment.identity.deviceId); assert.equal(f.state.starts, 1);
    const requests = f.state.requests, changed = join(f.root, 'changed-registered.json');
    for (const change of [{ endpoint: 'https://localhost:44111' }, { githubClientId: 'changedclientidentifier' }]) {
      writeFileSync(changed, JSON.stringify({ ...f.descriptor, ...change }));
      await assert.rejects(githubLogin({ home: f.home, serviceFile: changed }), { code: 'GITHUB_SERVICE_CHANGED' });
      assert.equal(f.state.requests, requests, 'changed trust must fail before contacting the old endpoint');
    }
    const denied = await f.owner('github-deny', { githubId: '12345' });
    assert.equal(denied.denied, true);
    assert.deepEqual(f.state.system, ['ensure', 'revoke']); assert.deepEqual(f.state.application, ['ensure', 'disable']);
    await assert.rejects(authenticatedRequest(enrollment.deviceFile, '/v1/identity'), { code: 'DEVICE_REVOKED' });
    assert.equal(f.service.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { await f.close(); }
});

test('a temporary first GitHub outage retries the same private session instead of trapping login for a day', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    f.state.failStart = true;
    await assert.rejects(githubLogin({ home: f.home, serviceFile: f.serviceFile }), { code: 'GITHUB_UPSTREAM_UNAVAILABLE' });
    const retry = await githubLogin({ home: f.home, serviceFile: f.serviceFile });
    assert.equal(retry.state, 'authorization-required'); assert.equal(f.state.starts, 2);
    assert.equal(f.service.store.db.prepare('SELECT COUNT(*) n FROM github_sessions').get().n, 1);
  } finally { await f.close(); }
});

test('GitHub denial atomically rejects existing devices before queued OS cleanup and survives a database restore', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  let release = () => {}, blocking, denial;
  try {
    await f.owner('github-approve', { githubLogin: 'fixture-user', label: 'Fixture', teamRole: 'developer', appRole: 'student', courseId: 'course', capabilities: ['page'] });
    f.state.authorized = true;
    const registered = await githubLogin({ home: f.home, serviceFile: f.serviceFile, waitSeconds: 3 });
    const invitation = await f.owner('invite', { label: 'Other member', teamRole: 'developer', appRole: 'student', courseId: 'course', capabilities: ['page'], ttlSeconds: 60 });
    const prepared = prepareEnrollment({ home: join(f.root, 'blocking-home'), invitationBytes: Buffer.from(JSON.stringify(invitation)) });
    let enter;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
    f.state.applicationHook = async operation => { if (operation === 'ensure') { enter(); await held; } };
    blocking = joinEnrollment({ deviceFile: prepared.deviceFile });
    await entered;
    denial = f.owner('github-deny', { githubId: '12345' });
    for (let n = 0; n < 200 && f.service.store.db.prepare('SELECT state FROM github_allowlist').get().state !== 'denied'; n++) await delay(10);
    const deviceId = registered.enrollment.identity.deviceId;
    assert.equal(f.service.store.member(registered.enrollment.identity.memberId).state, 'revoked');
    assert.equal(f.service.store.device(deviceId).state, 'revoked');
    await assert.rejects(authenticatedRequest(registered.enrollment.deviceFile, '/v1/identity'), { code: 'DEVICE_REVOKED' });
    const snapshot = join(f.root, 'denied.sqlite'); await f.service.store.snapshot(snapshot);
    const restored = openAccessStore(snapshot, f.config.credentialKeyFile, f.config.serviceId);
    try { assert.throws(() => restored.activeDevice(deviceId), { code: 'DEVICE_REVOKED' }); }
    finally { restored.close(); }
    release(); await blocking; assert.equal((await denial).denied, true);
  } finally {
    release(); await Promise.allSettled([blocking, denial].filter(Boolean)); await f.close();
  }
});

test('long GitHub intervals remain resumable without blocking a bounded CLI call', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    f.state.interval = 65;
    const began = Date.now();
    const pending = await githubLogin({ home: f.home, serviceFile: f.serviceFile });
    assert.ok(pending.retryAfterMs > 60000);
    await githubLogin({ home: f.home, serviceFile: f.serviceFile, waitSeconds: 60 });
    assert.equal(f.state.tokenPolls, 0); assert.ok(Date.now() - began < 5000);
    f.state.interval = 1; f.state.slowDown = true;
    const slowHome = join(f.root, 'slow-home');
    await githubLogin({ home: slowHome, serviceFile: f.serviceFile });
    const slow = await githubLogin({ home: slowHome, serviceFile: f.serviceFile, waitSeconds: 3 });
    assert.equal(slow.state, 'authorization-required'); assert.ok(slow.retryAfterMs > 60000);
    assert.equal(f.state.tokenPolls, 1);
  } finally { await f.close(); }
});

test('a rejected unregistered browser session can start again after owner approval without replacing a device', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    f.state.authorized = true;
    await githubLogin({ home: f.home, serviceFile: f.serviceFile });
    await assert.rejects(githubLogin({ home: f.home, serviceFile: f.serviceFile, waitSeconds: 3 }), { code: 'GITHUB_NOT_APPROVED' });
    assert.equal(f.service.store.db.prepare('SELECT COUNT(*) n FROM devices').get().n, 0);
    await f.owner('github-approve', { githubLogin: 'fixture-user', label: 'Fixture', teamRole: 'developer', appRole: 'student', courseId: 'course', capabilities: ['file:read'] });
    const ready = await githubLogin({ home: f.home, serviceFile: f.serviceFile, waitSeconds: 3 });
    assert.equal(ready.state, 'registered'); assert.equal(f.state.starts, 2);
    assert.equal(f.service.store.db.prepare('SELECT COUNT(*) n FROM devices').get().n, 1);
  } finally { await f.close(); }
});

test('public service trust and application ID are checked before enrollment, and private pending state rejects changed trust', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await githubLogin({ home: f.home, serviceFile: f.serviceFile });
    const changed = join(f.root, 'changed.json');
    writeFileSync(changed, JSON.stringify({ ...f.descriptor, githubClientId: 'differentclientidentifier' }));
    await assert.rejects(githubLogin({ home: f.home, serviceFile: changed }), { code: 'GITHUB_SERVICE_CHANGED' });
    writeFileSync(changed, JSON.stringify({ ...f.descriptor, endpoint: f.descriptor.endpoint.replace('https:', 'http:') }));
    assert.throws(() => readTeamService(changed), { code: 'TEAM_SERVICE_INVALID' });
    const otherHome = join(f.root, 'other-home');
    writeFileSync(changed, JSON.stringify({ ...f.descriptor, githubClientId: 'differentclientidentifier' }));
    await assert.rejects(githubLogin({ home: otherHome, serviceFile: changed }), { code: 'GITHUB_APPLICATION_CHANGED' });
    const wrongCa = ensureCertificateAuthority(join(f.root, 'wrong-ca'));
    writeFileSync(changed, JSON.stringify({ ...f.descriptor, caPem: readFileSync(wrongCa.certFile, 'utf8') }));
    await assert.rejects(githubLogin({ home: join(f.root, 'bad-ca-home'), serviceFile: changed }), { code: 'TLS_IDENTITY_CHANGED' });
  } finally { await f.close(); }
});
