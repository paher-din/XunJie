import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AccessError, digest, opaque } from '../xj-dev/src/enrollment-protocol.mjs';
import { createGithubLogin, strictGithubFetch } from './github-login.mjs';
import { openAccessStore } from './store.mjs';

const DEVICE = 'https://github.com/login/device/code', TOKEN = 'https://github.com/login/oauth/access_token';
const USER = 'https://api.github.com/user', VERIFY = 'https://github.com/login/device';
const response = (value, init = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
function fixture(t, overrides = {}, beforeMigration) {
  const root = mkdtempSync(join(tmpdir(), 'xj-github-'));
  const keyFile = join(root, 'key'), file = join(root, 'access.sqlite');
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  let clock = 1900000000000, store, github, issued = 0;
  const calls = [], token = 'invalid-fixture-' + opaque(), deviceCode = 'fixture-device-' + opaque();
  const config = { serviceId: 'github-fixture', endpoint: 'https://access.invalid:8443', github: { clientId: 'fixture-client' }, courseIds: ['course'], nodes: { hdl: {} } };
  const plan = { account: { id: 42, login: 'approved-user', type: 'User' }, who: { id: 42, login: 'approved-user', type: 'User' },
    device: () => response({ device_code: deviceCode, user_code: 'ABCD-EFGH', verification_uri: VERIFY, expires_in: 900, interval: 5 }),
    token: () => response({ access_token: token, token_type: 'bearer', scope: '' }), user: null, ...overrides };
  const fetch = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.ok(url.startsWith('https://')); assert.equal(new URLSearchParams(options.body).has('scope'), false);
    calls.push({ url, options });
    if (url === DEVICE) { assert.equal(options.method, 'POST'); return plan.device(); }
    if (url === TOKEN) { assert.equal(new URLSearchParams(options.body).get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code'); return plan.token(); }
    if (url === USER) { assert.equal(options.headers.authorization, 'Bearer ' + token); return plan.user ? plan.user() : response(plan.who); }
    assert.match(url, /^https:\/\/api\.github\.com\/users\/[a-z\d-]+$/i);
    assert.equal(options.headers.authorization, undefined); return response(plan.account);
  };
  const issueInvitation = input => {
    issued++;
    // This is the service's full invitation shape, including both CA chains and SSH pin.
    return { protocol: 'xj-dev/access-v1', serviceId: config.serviceId, endpoint: config.endpoint,
      caPem: 'fixture-access-ca', sshKnownHosts: 'fixture-ssh-pin', cloudCaPem: 'fixture-cloud-ca', ...store.createInvitation(input) };
  };
  function connect() {
    store = openAccessStore(file, keyFile, config.serviceId, () => clock);
    if (beforeMigration) { beforeMigration(store); beforeMigration = undefined; }
    github = createGithubLogin(store, config, { now: () => clock, fetch, issueInvitation });
  }
  connect();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const approved = input => github.admin('github-approve', { githubLogin: plan.account.login, label: 'Member', teamRole: 'developer',
    appRole: 'student', courseId: 'course', capabilities: ['page', 'node:hdl', 'file:read'], ...input });
  const start = (secret = opaque(), peer = 'peer-one') => github.start({ sessionSecret: secret }, { peer }).then(s => ({ ...s, sessionSecret: secret }));
  return { root, file, config, calls, plan, token, deviceCode, approved, start, get issued() { return issued; },
    get store() { return store; }, get github() { return github; }, now: () => clock, advance: ms => { clock += ms; },
    reopen() { store.close(); connect(); },
    async authorized() { await approved(); const s = await start(); clock += s.intervalMs; return { s, result: await github.poll(s) }; },
    dbBytes() { return Buffer.concat(readdirSync(root).filter(name => name.startsWith('access.sqlite')).map(name => readFileSync(join(root, name)))); } };
}

test('additive migration is restart-safe on a populated access DB; start response loss uses one hashed session', async t => {
  let original;
  const f = fixture(t, {}, store => { original = store.createInvitation({ memberId: 'existing', label: 'Existing', teamRole: 'developer', appRole: 'student', courseId: 'course', ttlSeconds: 60, capabilities: ['page'] }); });
  const secret = opaque(), [one, two] = await Promise.all([f.start(secret), f.start(secret)]);
  assert.deepEqual(one, two);
  const publicResult = await f.github.start({ sessionSecret: secret });
  assert.deepEqual(Object.keys(publicResult).sort(), ['expiresAt', 'intervalMs', 'sessionId', 'userCode', 'verificationUri']);
  assert.equal(publicResult.verificationUri, VERIFY);
  assert.equal(f.calls.filter(c => c.url === DEVICE).length, 1);
  const row = f.store.db.prepare('SELECT * FROM github_sessions').get();
  assert.equal(row.secret_hash, digest(secret));
  for (const value of [secret, f.deviceCode]) assert.equal(f.dbBytes().includes(Buffer.from(value)), false);
  f.reopen();
  assert.deepEqual(await f.github.start({ sessionSecret: secret }), publicResult);
  assert.equal(f.store.inspect().invitations[0].id, original.invitationId);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('github_sessions','github_allowlist')").get().n, 2);
});

test('numeric ID alone grants access; unknown user, renamed-name reuse, organizations and bots cannot enroll', async t => {
  const f = fixture(t); await f.approved();
  for (const who of [{ id: 43, login: 'approved-user', type: 'User' }, { id: 44, login: 'someone-else', type: 'User' },
    { id: 42, login: 'approved-user', type: 'Organization' }, { id: 42, login: 'robot', type: 'Bot' }]) {
    f.plan.who = who;
    const s = await f.start(opaque(), 'peer-' + who.id + who.type); f.advance(5000);
    await assert.rejects(f.github.poll(s), { code: who.type === 'User' ? 'GITHUB_NOT_APPROVED' : 'GITHUB_ACCOUNT_INVALID' });
  }
  assert.equal(f.store.inspect().members.length, 0); assert.equal(f.issued, 0);
  f.plan.who = { id: 42, login: 'renamed-user', type: 'User' };
  const s = await f.start(); f.advance(5000); const out = await f.github.poll(s);
  assert.deepEqual(out.github, { id: 42, login: 'renamed-user' });
  assert.equal(out.invitation.memberId, 'github-42');
});

test('approve resolves official user ID; validates grants and active explicit member binding without precreating members', async t => {
  const f = fixture(t);
  for (const [input, code] of [
    [{ courseId: 'unknown' }, 'COURSE_NOT_GRANTED'], [{ capabilities: ['node:hdl'] }, 'CAPABILITY_NOT_GRANTED'],
    [{ capabilities: ['page', 'node:missing'] }, 'CAPABILITY_NOT_GRANTED'], [{ capabilities: ['page', 'node:toString'] }, 'CAPABILITY_NOT_GRANTED'],
    [{ capabilities: ['page', 1] }, 'CAPABILITY_NOT_GRANTED'], [{ teamRole: 'owner' }, 'INVALID_ROLE'], [{ label: '' }, 'INVALID_REQUEST'],
    [{ githubLogin: '../user' }, 'GITHUB_LOGIN_INVALID'], [{ memberId: 'absent' }, 'MEMBER_CONFLICT']]) {
    await assert.rejects(f.approved(input), { code });
  }
  for (const type of ['Organization', 'Bot']) { f.plan.account.type = type; await assert.rejects(f.approved(), { code: 'GITHUB_ACCOUNT_INVALID' }); }
  f.plan.account.type = 'User';
  const a = await f.approved(), b = await f.approved();
  assert.deepEqual(a, b); assert.equal(a.memberId, 'github-42'); assert.equal(a.state, 'active');
  assert.equal(f.store.inspect().members.length, 0);
  assert.equal((await f.github.admin('github-list')).accounts.length, 1);
  const existing = f.store.createInvitation({ memberId: 'explicit', label: 'Existing', teamRole: 'developer', appRole: 'student', courseId: 'course', ttlSeconds: 60, capabilities: ['page'] });
  f.plan.account = { id: 99, login: 'explicit-user', type: 'User' };
  await assert.rejects(f.approved({ memberId: existing.memberId, appRole: 'teacher' }), { code: 'MEMBER_CONFLICT' });
  assert.equal((await f.approved({ memberId: existing.memberId })).memberId, 'explicit');
  f.plan.account = { id: 100, login: 'other-user', type: 'User' };
  await assert.rejects(f.approved({ memberId: existing.memberId }), { code: 'MEMBER_CONFLICT' });
});

test('complete invitation survives lost replies/restarts and concurrent polls; repeat login reuses one member', async t => {
  const f = fixture(t); await f.approved(); const s = await f.start(); f.advance(5000);
  const gate = deferred(), entered = deferred(); f.plan.user = () => { entered.resolve(); return gate.promise; };
  const first = f.github.poll(s); await entered.promise;
  const concurrent = await f.github.poll(s); assert.equal(concurrent.state, 'pending');
  gate.resolve(response(f.plan.who)); const result = await first;
  assert.equal(result.state, 'authorized'); assert.equal(result.invitation.caPem, 'fixture-access-ca');
  assert.equal(result.invitation.sshKnownHosts, 'fixture-ssh-pin'); assert.equal(result.invitation.cloudCaPem, 'fixture-cloud-ca');
  assert.deepEqual(await f.github.poll(s), result); assert.equal(f.issued, 1);
  f.reopen(); assert.deepEqual(await f.github.poll(s), result); assert.equal(f.issued, 1);
  for (const value of [s.sessionSecret, f.token, f.deviceCode, result.invitation.secret]) assert.equal(f.dbBytes().includes(Buffer.from(value)), false);
  const cached = f.store.db.prepare('SELECT * FROM github_sessions WHERE id=?').get(s.sessionId);
  assert.equal(cached.protected, null); assert.equal(f.store.unseal(cached.invitation).secret, result.invitation.secret);
  f.plan.user = null; const next = await f.start(); f.advance(5000);
  const again = await f.github.poll(next);
  assert.equal(again.invitation.memberId, result.invitation.memberId);
  assert.notEqual(again.invitation.invitationId, result.invitation.invitationId);
  assert.equal(f.store.inspect().members.length, 1); assert.equal(f.store.inspect().invitations.length, 2);
  const listed = JSON.stringify(await f.github.admin('github-list'));
  for (const value of [f.token, s.sessionSecret, result.invitation.secret, f.deviceCode]) assert.equal(listed.includes(value), false);
});

test('token is encrypted while GET /user is unavailable; restart retries identity without exchanging the device code twice', async t => {
  const f = fixture(t); await f.approved(); const s = await f.start(); f.advance(5000);
  f.plan.user = () => { throw new Error('must not expose ' + f.token); };
  await assert.rejects(f.github.poll(s), error => error instanceof AccessError && error.code === 'GITHUB_UPSTREAM_UNAVAILABLE' && !error.message.includes(f.token));
  const row = f.store.db.prepare('SELECT * FROM github_sessions WHERE id=?').get(s.sessionId);
  assert.equal(row.state, 'identifying'); assert.equal(f.store.unseal(row.protected).accessToken, f.token);
  assert.equal(f.dbBytes().includes(Buffer.from(f.token)), false);
  f.reopen(); f.plan.user = null; f.advance(5000);
  assert.equal((await f.github.poll(s)).state, 'authorized');
  assert.equal(f.calls.filter(c => c.url === TOKEN).length, 1);
});

test('poll honors initial interval, pending, slow_down and transient failure spacing, including restart', async t => {
  const f = fixture(t), s = await f.start();
  assert.equal((await f.github.poll(s)).retryAfterMs, 5000); assert.equal(f.calls.filter(c => c.url === TOKEN).length, 0);
  f.advance(4999); assert.equal((await f.github.poll(s)).retryAfterMs, 1);
  f.advance(1); f.plan.token = () => response({ error: 'authorization_pending' });
  assert.equal((await f.github.poll(s)).retryAfterMs, 5000);
  f.advance(5000); f.plan.token = () => response({ error: 'slow_down', interval: 12 });
  assert.equal((await f.github.poll(s)).retryAfterMs, 12000);
  f.reopen(); f.advance(11999); assert.equal((await f.github.poll(s)).retryAfterMs, 1);
  f.advance(1); f.plan.token = () => response({ error: 'slow_down', interval: 1 });
  assert.equal((await f.github.poll(s)).retryAfterMs, 17000, 'slow_down cannot decrease the existing interval');
  f.advance(17000); f.plan.token = () => { throw new Error('fixture private upstream details'); };
  await assert.rejects(f.github.poll(s), { code: 'GITHUB_UPSTREAM_UNAVAILABLE' });
  assert.equal((await f.github.poll(s)).retryAfterMs, 17000);
  f.advance(17000); f.plan.token = () => response({ error: 'slow_down', interval: 65 });
  assert.equal((await f.github.poll(s)).retryAfterMs, 65000, 'GitHub may require more than one minute');
  const calls = f.calls.length; f.advance(60000);
  assert.equal((await f.github.poll(s)).retryAfterMs, 5000); assert.equal(f.calls.length, calls);
});

test('expired and denied authorizations are terminal and erase encrypted credentials', async t => {
  const f = fixture(t);
  for (const [upstream, code] of [['access_denied', 'GITHUB_AUTHORIZATION_DENIED'], ['expired_token', 'GITHUB_SESSION_EXPIRED']]) {
    const s = await f.start(); f.advance(5000); f.plan.token = () => response({ error: upstream, error_description: 'untrusted secret text' });
    await assert.rejects(f.github.poll(s), { code });
    await assert.rejects(f.github.poll(s), { code });
    assert.equal(f.store.db.prepare('SELECT protected FROM github_sessions WHERE id=?').get(s.sessionId).protected, null);
  }
  const expired = await f.start(); f.advance(900000);
  await assert.rejects(f.github.poll(expired), { code: 'GITHUB_SESSION_EXPIRED' });
  await assert.rejects(f.github.start({ sessionSecret: expired.sessionSecret }), { code: 'GITHUB_SESSION_EXPIRED' });
  assert.equal(f.store.db.prepare('SELECT protected FROM github_sessions WHERE id=?').get(expired.sessionId).protected, null);
});

test('wrong session secrets/IDs cannot inspect or consume authorization; malformed secrets never start requests', async t => {
  const f = fixture(t), s = await f.start();
  for (const value of ['', 'a'.repeat(31), 'a'.repeat(33), ' '.repeat(32), null, 1]) await assert.rejects(f.github.start({ sessionSecret: value }), { code: 'GITHUB_SESSION_SECRET_INVALID' });
  await assert.rejects(f.github.poll({ ...s, sessionSecret: opaque() }), { code: 'GITHUB_SESSION_INVALID' });
  await assert.rejects(f.github.poll({ ...s, sessionId: 'missing' }), { code: 'GITHUB_SESSION_INVALID' });
  assert.equal(f.calls.length, 1);
});

test('deny commits without waiting on GitHub; in-flight identity and approval cannot restore a denied account', async t => {
  const f = fixture(t); await f.approved(); const s = await f.start(); f.advance(5000);
  const gate = deferred(), entered = deferred(); f.plan.user = () => { entered.resolve(); return gate.promise; };
  const waiting = f.github.poll(s); await entered.promise;
  assert.deepEqual(await f.github.admin('github-deny', { githubId: 42 }), { githubId: 42, denied: true, memberId: 'github-42' });
  assert.deepEqual(await f.github.admin('github-deny', { githubId: 42 }), { githubId: 42, denied: true, memberId: 'github-42' }, 'cleanup failures can retry the same member revocation');
  const inspector = openAccessStore(f.file, join(f.root, 'key'), f.config.serviceId, f.now);
  try { assert.equal(inspector.db.prepare("SELECT state FROM github_allowlist WHERE github_id='42'").get().state, 'denied'); } finally { inspector.close(); }
  // Reapproval still must not validate a flow that began before the deny.
  await f.approved(); gate.resolve(response(f.plan.who));
  await assert.rejects(waiting, { code: 'GITHUB_NOT_APPROVED' }); assert.equal(f.issued, 0);
});

test('deny during an unresolved admin lookup wins; an explicit later approval can start a new flow', async t => {
  const f = fixture(t); await f.approved();
  const gate = deferred(), entered = deferred();
  const slow = createGithubLogin(f.store, f.config, { now: f.now, issueInvitation: () => { throw new Error('unused'); },
    fetch: async () => { entered.resolve(); return gate.promise; } });
  const approving = slow.admin('github-approve', { githubLogin: 'approved-user', label: 'Member', teamRole: 'developer', appRole: 'student', courseId: 'course', capabilities: ['page'] });
  await entered.promise; await f.github.admin('github-deny', { githubId: '42' }); gate.resolve(response(f.plan.account));
  await assert.rejects(approving, { code: 'GITHUB_NOT_APPROVED' });
  await f.approved(); const s = await f.start(); f.advance(5000); assert.equal((await f.github.poll(s)).state, 'authorized');
});

test('cached results recheck live allowlist, member, invitation revocation and config grants', async t => {
  const f = fixture(t), { s, result } = await f.authorized();
  await f.github.admin('github-deny', { githubId: 42 });
  await assert.rejects(f.github.poll(s), { code: 'GITHUB_NOT_APPROVED' });
  await assert.rejects(f.approved(), { code: 'MEMBER_REVOKED' });
  const g = fixture(t), { s: fresh } = await g.authorized();
  g.config.nodes = {};
  await assert.rejects(g.github.poll(fresh), { code: 'CAPABILITY_NOT_GRANTED' });
  g.config.nodes = { hdl: {} };
  g.store.revokeInvitation(g.store.db.prepare('SELECT invitation_id FROM github_sessions WHERE id=?').get(fresh.sessionId).invitation_id);
  await assert.rejects(g.github.poll(fresh), { code: 'INVITATION_INVALID' });
  assert.ok(result.invitation.secret);
});

test('a linked revoked member stays revoked after OAuth, reapprove and explicit rebinding attempts', async t => {
  const f = fixture(t), { s, result } = await f.authorized();
  f.store.denyMember(result.invitation.memberId);
  await assert.rejects(f.github.poll(s), { code: 'MEMBER_REVOKED' });
  await assert.rejects(f.approved(), { code: 'MEMBER_REVOKED' });
  await assert.rejects(f.approved({ memberId: 'replacement' }), { code: 'MEMBER_REVOKED' });
  const fresh = await f.start(); f.advance(5000);
  await assert.rejects(f.github.poll(fresh), { code: 'MEMBER_REVOKED' });
  assert.equal(f.store.inspect().members.length, 1); assert.equal(f.store.member(result.invitation.memberId).state, 'revoked');
});

test('unbound ready invitation expires under store rules; a bound invitation resumes after OAuth/invitation expiry', async t => {
  const f = fixture(t), { s, result } = await f.authorized();
  f.advance(900000);
  await assert.rejects(f.github.poll(s), { code: 'INVITATION_EXPIRED' });
  const fresh = await f.start(); f.advance(5000); const second = await f.github.poll(fresh);
  f.store.db.prepare("INSERT INTO devices(id,member_id,public_key,capabilities,state) VALUES ('bound-device',?,'fixture-key','[\"page\"]','active')").run(result.invitation.memberId);
  f.store.db.prepare("UPDATE invitations SET state='bound',device_id='bound-device' WHERE id=?").run(second.invitation.invitationId);
  f.advance(900001); f.reopen(); assert.deepEqual(await f.github.poll(fresh), second);
});

test('peer and global active-session limits include pending network calls; expiration releases reservations', async t => {
  const f = fixture(t), gate = deferred(), entered = deferred();
  let count = 0;
  f.plan.device = async () => { if (++count === 3) entered.resolve(); await gate.promise; return response({ device_code: f.deviceCode, user_code: 'ABCD-EFGH', verification_uri: VERIFY, expires_in: 900, interval: 5 }); };
  const starts = Array.from({ length: 3 }, () => f.start()); await entered.promise;
  await assert.rejects(f.start(), { code: 'GITHUB_RATE_LIMITED' });
  gate.resolve();
  await Promise.all(starts);
  f.plan.device = () => response({ device_code: f.deviceCode, user_code: 'ABCD-EFGH', verification_uri: VERIFY, expires_in: 900, interval: 5 });
  for (let n = 0; n < 21; n++) await f.start(opaque(), 'independent-' + n);
  await assert.rejects(f.start(opaque(), 'one-more'), { code: 'GITHUB_RATE_LIMITED' });
  f.advance(900000); await f.start();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM github_sessions WHERE state='pending'").get().n, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM github_sessions WHERE state='expired' AND protected IS NOT NULL").get().n, 0);
});

test('untrusted upstream HTTP/errors/JSON/size/redirects never expose bodies or follow URLs', async t => {
  const f = fixture(t);
  for (const bad of [
    () => response({ message: f.token }, { status: 500 }),
    () => response({ message: f.token }, { status: 302, headers: { location: 'http://untrusted.invalid' } }),
    () => new Response('not-json:' + f.token, { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () => response({ junk: 'x'.repeat(65536) }),
    () => response({}, { headers: { 'content-type': 'application/json', 'content-length': '65537' } }),
    () => response({ device_code: f.deviceCode, user_code: 'ABCD-EFGH', verification_uri: 'http://github.com/login/device', expires_in: 900, interval: 5 }),
    () => { throw new Error('untrusted:' + f.token); },
  ]) {
    f.plan.device = bad;
    await assert.rejects(f.start(), error => error instanceof AccessError && /^GITHUB_UPSTREAM_/.test(error.code) && !error.message.includes(f.token));
  }
  assert.throws(() => strictGithubFetch('https://github.com.evil.invalid/login/device/code', { redirect: 'error' }), { code: 'GITHUB_REQUEST_INVALID' });
});

test('default production transport forces TLS certificate/hostname checks even under ambient TLS disable', () => {
  const moduleUrl = new URL('./github-login.mjs', import.meta.url).href;
  // Intercept only node:https in a child: no request leaves this machine.
  const script = `
    import assert from 'node:assert/strict'; import https from 'node:https';
    import { syncBuiltinESMExports } from 'node:module'; import { EventEmitter } from 'node:events';
    import { Readable } from 'node:stream'; import { checkServerIdentity } from 'node:tls';
    https.request = (url, options, callback) => {
      assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent.options.rejectUnauthorized, true);
      assert.equal(options.checkServerIdentity, checkServerIdentity); assert.equal(options.agent.options.checkServerIdentity, checkServerIdentity);
      const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {
        const res = Readable.from([Buffer.from('{}')]); res.statusCode = 200; res.headers = { 'content-type': 'application/json' }; callback(res);
      }; return req;
    }; syncBuiltinESMExports();
    const { strictGithubFetch } = await import(${JSON.stringify(moduleUrl)});
    assert.equal((await strictGithubFetch('${USER}', { redirect: 'error' })).status, 200);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: 'pipe', timeout: 5000 });
});

test('invitation persistence failure rolls back member/invitation and permits a single retry', async t => {
  const f = fixture(t); await f.approved(); const s = await f.start(); f.advance(5000);
  const original = f.store.seal; let broken = true;
  f.store.seal = value => { if (value?.invitationId && broken) throw new Error('fixture receipt write failure'); return original(value); };
  await assert.rejects(f.github.poll(s), { code: 'GITHUB_UPSTREAM_UNAVAILABLE' });
  assert.equal(f.store.inspect().members.length, 0); assert.equal(f.store.inspect().invitations.length, 0);
  broken = false; f.advance(5000); const result = await f.github.poll(s);
  assert.equal(result.state, 'authorized'); assert.equal(f.store.inspect().members.length, 1); assert.equal(f.store.inspect().invitations.length, 1);
});

test('network deadline aborts a hung fetch and safely releases the active reservation', async t => {
  const f = fixture(t), entered = deferred(); let signal;
  const github = createGithubLogin(f.store, f.config, { now: f.now, issueInvitation: () => { throw new Error('unused'); },
    fetch: async (_url, options) => { signal = options.signal; entered.resolve(); return new Promise(() => {}); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = github.start({ sessionSecret: opaque() }, { peer: 'deadline-peer' }); await entered.promise;
  const rejected = assert.rejects(waiting, { code: 'GITHUB_UPSTREAM_UNAVAILABLE' });
  t.mock.timers.tick(15000); await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM github_sessions WHERE state IN ('starting','pending','identifying')").get().n, 0);
});

test('expiry or deny while the token exchange is in flight cannot issue an invitation', async t => {
  const f = fixture(t); await f.approved();
  for (const action of ['deny', 'expire']) {
    if (action === 'expire') await f.approved();
    const s = await f.start(), gate = deferred(), entered = deferred(); f.advance(5000);
    f.plan.token = async () => { entered.resolve(); await gate.promise; return response({ access_token: f.token, token_type: 'bearer' }); };
    const waiting = f.github.poll(s); await entered.promise;
    if (action === 'deny') await f.github.admin('github-deny', { githubId: 42 }); else f.advance(900000);
    gate.resolve();
    await assert.rejects(waiting, { code: action === 'deny' ? 'GITHUB_NOT_APPROVED' : 'GITHUB_SESSION_EXPIRED' });
    assert.equal(f.issued, 0);
  }
});
