import { randomUUID } from 'node:crypto';
import { Agent, request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { AccessError, digest, requireAccess } from '../xj-dev/src/enrollment-protocol.mjs';

const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const VERIFY_URL = 'https://github.com/login/device';
const DEADLINE_MS = 15000, MAX_BYTES = 65536, MAX_ACTIVE = 24, MAX_PEER = 3;
const INVITATION_SECONDS = 900;
const loginValid = value => typeof value === 'string' && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value);
const secretValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value);
const safeString = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x20\x7f]/.test(value);
const idString = value => {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  requireAccess(typeof id === 'string' && /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)), 'GITHUB_ID_INVALID');
  return id;
};
function permittedUrl(url) {
  return url === DEVICE_URL || url === TOKEN_URL || url === USER_URL ||
    typeof url === 'string' && url.startsWith('https://api.github.com/users/') && loginValid(url.slice('https://api.github.com/users/'.length));
}

// Deliberately avoid the ambient fetch dispatcher and NODE_TLS_REJECT_UNAUTHORIZED.
// A fresh agent also prevents a process-wide https.globalAgent override weakening TLS.
export function strictGithubFetch(url, options = {}) {
  requireAccess(permittedUrl(url) && options.redirect === 'error', 'GITHUB_REQUEST_INVALID', 503);
  return new Promise((resolve, reject) => {
    const agent = new Agent({ rejectUnauthorized: true, checkServerIdentity });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); agent.destroy();
      if (error) reject(new AccessError('GITHUB_UPSTREAM_UNAVAILABLE', 503)); else resolve(value);
    };
    const timer = setTimeout(() => { finish(true); req.destroy(); }, DEADLINE_MS);
    const req = request(url, { method: options.method, headers: options.headers, signal: options.signal,
      agent, rejectUnauthorized: true, checkServerIdentity }, res => {
      // Do not read, follow, or expose an upstream error/redirect body.
      if (res.statusCode !== 200) {
        finish(false, new Response(null, { status: res.statusCode })); res.destroy(); return;
      }
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { finish(true); res.destroy(); req.destroy(); } else chunks.push(chunk);
      });
      res.on('error', () => finish(true));
      res.on('end', () => finish(false, new Response(Buffer.concat(chunks), { status: 200,
        headers: { 'content-type': res.headers['content-type'] ?? '' } })));
    });
    req.on('error', () => finish(true));
    req.end(options.body);
  });
}

export function createGithubLogin(store, config, { now = Date.now, fetch = globalThis.fetch, issueInvitation } = {}) {
  requireAccess(safeString(config.github?.clientId, 128) && Array.isArray(config.courseIds) && config.courseIds.length &&
    typeof store.seal === 'function' && typeof store.unseal === 'function' && typeof issueInvitation === 'function', 'GITHUB_CONFIGURATION_INVALID', 503);
  const { db, tx } = store;
  const transport = fetch === globalThis.fetch ? strictGithubFetch : fetch;
  requireAccess(typeof transport === 'function', 'GITHUB_CONFIGURATION_INVALID', 503);
  // Additive, restart-safe migration of the real access database. member_id cannot
  // be a foreign key: approval reserves an identity before its first enrollment.
  tx(() => db.exec(`CREATE TABLE IF NOT EXISTS github_allowlist (
    github_id TEXT PRIMARY KEY, login TEXT NOT NULL, label TEXT NOT NULL,
    team_role TEXT NOT NULL, app_role TEXT NOT NULL, course_id TEXT NOT NULL,
    capabilities TEXT NOT NULL, member_id TEXT UNIQUE NOT NULL, state TEXT NOT NULL,
    revision INTEGER NOT NULL, deny_epoch INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS github_sessions (
    id TEXT PRIMARY KEY, secret_hash TEXT UNIQUE NOT NULL, peer_hash TEXT NOT NULL,
    state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    interval_ms INTEGER NOT NULL, next_poll_at INTEGER NOT NULL, policy_epoch INTEGER NOT NULL,
    user_code TEXT, protected TEXT, github_id TEXT, github_login TEXT,
    policy_revision INTEGER, invitation_id TEXT, invitation TEXT, error_code TEXT);
    CREATE INDEX IF NOT EXISTS github_sessions_active ON github_sessions(state,expires_at);
    CREATE INDEX IF NOT EXISTS github_sessions_peer ON github_sessions(peer_hash,state);
    INSERT OR IGNORE INTO metadata(key,value) VALUES ('githubPolicyEpoch','0');`));
  const starts = new Map(), polls = new Map();
  const session = id => db.prepare('SELECT * FROM github_sessions WHERE id=?').get(id);
  const account = id => db.prepare('SELECT * FROM github_allowlist WHERE github_id=?').get(id);
  const epoch = () => Number(db.prepare("SELECT value FROM metadata WHERE key='githubPolicyEpoch'").get().value);
  const tick = () => { const n = epoch() + 1; db.prepare("UPDATE metadata SET value=? WHERE key='githubPolicyEpoch'").run(String(n)); return n; };
  const terminate = (id, state, code) => db.prepare('UPDATE github_sessions SET state=?,error_code=?,protected=NULL,invitation=NULL WHERE id=?').run(state, code, id);
  const cleanup = () => {
    db.prepare("UPDATE github_sessions SET state='expired',error_code='GITHUB_SESSION_EXPIRED',protected=NULL,invitation=NULL WHERE state IN ('starting','pending','identifying') AND expires_at<=?").run(now());
    db.prepare(`UPDATE github_sessions SET state='expired',error_code='INVITATION_EXPIRED',protected=NULL,invitation=NULL
      WHERE state='ready' AND EXISTS (SELECT 1 FROM invitations i WHERE i.id=invitation_id AND i.device_id IS NULL AND i.expires_at<=?)`).run(now());
    db.prepare("DELETE FROM github_sessions WHERE state IN ('expired','denied','failed') AND created_at<?").run(now() - 86400000);
  };
  const stateCheck = s => {
    requireAccess(s, 'GITHUB_SESSION_INVALID', 401);
    if (['denied', 'expired', 'failed'].includes(s.state)) throw new AccessError(s.error_code, s.state === 'failed' ? 503 : 403);
    requireAccess(s.state === 'ready' || s.expires_at > now(), 'GITHUB_SESSION_EXPIRED', 403);
    return s;
  };
  const policy = input => {
    requireAccess(input && ['developer', 'maintainer'].includes(input.teamRole) && ['student', 'teacher'].includes(input.appRole), 'INVALID_ROLE');
    requireAccess(typeof input.label === 'string' && input.label.trim().length > 0 && input.label.length <= 128, 'INVALID_REQUEST');
    requireAccess(config.courseIds.includes(input.courseId), 'COURSE_NOT_GRANTED', 403);
    const caps = input.capabilities;
    requireAccess(Array.isArray(caps) && caps.length > 0 && caps.length <= 32 && caps.every(cap => typeof cap === 'string' &&
      (['page', 'file:read', 'file:publish'].includes(cap) || /^node:[A-Za-z0-9_-]{1,64}$/.test(cap) &&
        caps.includes('page') && Object.hasOwn(config.nodes ?? {}, cap.slice(5)) && config.nodes[cap.slice(5)])) &&
      new Set(caps.filter(cap => cap.startsWith('node:'))).size <= 1, 'CAPABILITY_NOT_GRANTED', 403);
    return { label: input.label, teamRole: input.teamRole, appRole: input.appRole, courseId: input.courseId, capabilities: [...new Set(caps)].sort() };
  };
  const memberCheck = (a, required = false) => {
    const m = store.member(a.member_id);
    requireAccess(m || !required, 'MEMBER_CONFLICT', 403);
    if (m) {
      requireAccess(m.state === 'active', 'MEMBER_REVOKED', 403);
      requireAccess(m.team_role === a.team_role && m.app_role === a.app_role && m.course_id === a.course_id, 'MEMBER_CONFLICT', 403);
    }
  };
  const allowed = (s, id, required = false) => {
    const a = account(id);
    requireAccess(a?.state === 'active' && a.deny_epoch <= s.policy_epoch, 'GITHUB_NOT_APPROVED', 403);
    if (s.policy_revision != null) requireAccess(a.revision === s.policy_revision, 'GITHUB_POLICY_CHANGED', 403);
    policy({ label: a.label, teamRole: a.team_role, appRole: a.app_role, courseId: a.course_id, capabilities: JSON.parse(a.capabilities) });
    memberCheck(a, required); return a;
  };
  const listing = a => ({ githubId: Number(a.github_id), githubLogin: a.login, label: a.label, teamRole: a.team_role,
    appRole: a.app_role, courseId: a.course_id, capabilities: JSON.parse(a.capabilities), memberId: a.member_id,
    state: a.state, memberState: store.member(a.member_id)?.state ?? 'not-enrolled' });

  async function json(url, { token, body, missingAccount = false } = {}) {
    requireAccess(permittedUrl(url), 'GITHUB_REQUEST_INVALID', 503);
    const controller = new AbortController(); let timer, response;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new AccessError('GITHUB_UPSTREAM_UNAVAILABLE', 503));
    }, DEADLINE_MS); });
    try {
      return await Promise.race([timeout, (async () => {
        response = await transport(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
          headers: { accept: 'application/json', 'user-agent': 'XunJie-Dev-Access', 'accept-encoding': 'identity',
            ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : { 'x-github-api-version': '2022-11-28' }),
            ...(token ? { authorization: `Bearer ${token}` } : {}) },
          ...(body ? { body: new URLSearchParams(body).toString() } : {}) });
        if (response.status === 404 && missingAccount) throw new AccessError('GITHUB_ACCOUNT_NOT_FOUND', 404);
        requireAccess(response.status === 200 && !response.redirected, 'GITHUB_UPSTREAM_UNAVAILABLE', 503);
        requireAccess(/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? ''), 'GITHUB_UPSTREAM_INVALID', 502);
        const declared = response.headers.get('content-length');
        requireAccess(declared == null || /^\d+$/.test(declared) && Number(declared) <= MAX_BYTES, 'GITHUB_UPSTREAM_INVALID', 502);
        requireAccess(response.body?.getReader, 'GITHUB_UPSTREAM_INVALID', 502);
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength; requireAccess(size <= MAX_BYTES, 'GITHUB_UPSTREAM_INVALID', 502); chunks.push(Buffer.from(value));
          }
        } finally { void reader.cancel().catch(() => {}); }
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AccessError('GITHUB_UPSTREAM_INVALID', 502); }
        requireAccess(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'GITHUB_UPSTREAM_INVALID', 502);
        return parsed;
      })()]);
    } catch (error) { throw error instanceof AccessError ? error : new AccessError('GITHUB_UPSTREAM_UNAVAILABLE', 503); }
    finally { clearTimeout(timer); controller.abort(); void response?.body?.cancel().catch(() => {}); }
  }
  function identity(value) {
    requireAccess(value?.type === 'User' && loginValid(value.login) && Number.isSafeInteger(value.id) && value.id > 0, 'GITHUB_ACCOUNT_INVALID', 403);
    return { id: idString(value.id), login: value.login };
  }
  function startResult(s) {
    stateCheck(s);
    requireAccess(s.user_code, 'GITHUB_UPSTREAM_UNAVAILABLE', 503);
    return { sessionId: s.id, userCode: s.user_code, verificationUri: VERIFY_URL, expiresAt: s.expires_at, intervalMs: s.interval_ms };
  }
  async function start(input, { peer } = {}) {
    requireAccess(secretValid(input?.sessionSecret), 'GITHUB_SESSION_SECRET_INVALID');
    const hash = digest(input.sessionSecret); cleanup();
    let s = db.prepare('SELECT * FROM github_sessions WHERE secret_hash=?').get(hash);
    if (s?.state === 'failed' && !s.user_code && ['GITHUB_UPSTREAM_UNAVAILABLE', 'GITHUB_UPSTREAM_INVALID'].includes(s.error_code)) {
      s = tx(() => {
        requireAccess(db.prepare("SELECT count(*) AS n FROM github_sessions WHERE state IN ('starting','pending','identifying')").get().n < MAX_ACTIVE &&
          db.prepare("SELECT count(*) AS n FROM github_sessions WHERE peer_hash=? AND state IN ('starting','pending','identifying')").get(s.peer_hash).n < MAX_PEER, 'GITHUB_RATE_LIMITED', 429);
        db.prepare("UPDATE github_sessions SET state='starting',error_code=NULL,expires_at=?,next_poll_at=? WHERE id=?").run(now() + 900000, now() + 5000, s.id);
        return session(s.id);
      });
    }
    if (s && s.state !== 'starting') return startResult(s);
    if (s && starts.has(s.id)) return starts.get(s.id);
    if (!s) s = tx(() => {
      const peerHash = digest(typeof peer === 'string' && peer.length <= 256 ? peer : 'unknown');
      requireAccess(db.prepare("SELECT count(*) AS n FROM github_sessions WHERE state IN ('starting','pending','identifying')").get().n < MAX_ACTIVE &&
        db.prepare("SELECT count(*) AS n FROM github_sessions WHERE peer_hash=? AND state IN ('starting','pending','identifying')").get(peerHash).n < MAX_PEER, 'GITHUB_RATE_LIMITED', 429);
      const id = randomUUID();
      db.prepare("INSERT INTO github_sessions(id,secret_hash,peer_hash,state,created_at,expires_at,interval_ms,next_poll_at,policy_epoch) VALUES (?,?,?,'starting',?,?,5000,?,?)")
        .run(id, hash, peerHash, now(), now() + 900000, now() + 5000, epoch());
      return session(id);
    });
    const id = s.id;
    const work = (async () => {
      try {
        const began = now(), value = await json(DEVICE_URL, { body: { client_id: config.github.clientId } });
        stateCheck(session(id));
        requireAccess(safeString(value.device_code, 4096) && typeof value.user_code === 'string' && /^[A-Z\d-]{4,32}$/.test(value.user_code) &&
          value.verification_uri === VERIFY_URL && Number.isInteger(value.expires_in) && value.expires_in >= 1 && value.expires_in <= 900 &&
          Number.isInteger(value.interval) && value.interval >= 1 && value.interval <= 900, 'GITHUB_UPSTREAM_INVALID', 502);
        requireAccess(began + value.expires_in * 1000 > now(), 'GITHUB_SESSION_EXPIRED', 403);
        db.prepare("UPDATE github_sessions SET state='pending',user_code=?,protected=?,expires_at=?,interval_ms=?,next_poll_at=? WHERE id=?")
          .run(value.user_code, store.seal({ deviceCode: value.device_code }), began + value.expires_in * 1000,
            value.interval * 1000, now() + value.interval * 1000, id);
        return startResult(session(id));
      } catch (error) {
        terminate(id, error?.code === 'GITHUB_SESSION_EXPIRED' ? 'expired' : 'failed', error instanceof AccessError ? error.code : 'GITHUB_UPSTREAM_UNAVAILABLE');
        throw error instanceof AccessError ? error : new AccessError('GITHUB_UPSTREAM_UNAVAILABLE', 503);
      }
    })();
    starts.set(id, work);
    try { return await work; } finally { starts.delete(id); }
  }
  const pending = s => ({ state: 'pending', retryAfterMs: Math.max(1, s.next_poll_at - now()), expiresAt: s.expires_at });
  function ready(s) {
    allowed(s, s.github_id, true);
    const i = db.prepare('SELECT * FROM invitations WHERE id=?').get(s.invitation_id);
    requireAccess(i && i.member_id === account(s.github_id).member_id && i.state !== 'revoked', 'INVITATION_INVALID', 403);
    requireAccess(i.device_id || i.expires_at > now(), 'INVITATION_EXPIRED', 403);
    return { state: 'authorized', invitation: store.unseal(s.invitation), github: { id: Number(s.github_id), login: s.github_login } };
  }
  async function poll(input) {
    requireAccess(secretValid(input?.sessionSecret) && typeof input.sessionId === 'string' && input.sessionId.length <= 64, 'GITHUB_SESSION_INVALID', 401);
    cleanup();
    const s = session(input.sessionId);
    requireAccess(s && s.secret_hash === digest(input.sessionSecret), 'GITHUB_SESSION_INVALID', 401);
    stateCheck(s);
    if (s.state === 'ready') return ready(s);
    if (s.state === 'starting' || polls.has(s.id) || s.next_poll_at > now()) return pending(s);
    const work = (async () => {
      try {
        db.prepare('UPDATE github_sessions SET next_poll_at=? WHERE id=?').run(now() + s.interval_ms, s.id);
        let secret = store.unseal(s.protected);
        if (s.state === 'pending') {
          const value = await json(TOKEN_URL, { body: { client_id: config.github.clientId, device_code: secret.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
          stateCheck(session(s.id));
          if (value.error === 'authorization_pending' || value.error === 'slow_down') {
            const interval = value.error === 'slow_down' ? Math.max(s.interval_ms + 5000,
              Number.isInteger(value.interval) && value.interval > 0 && value.interval <= 3600 ? value.interval * 1000 : 0) : s.interval_ms;
            db.prepare('UPDATE github_sessions SET interval_ms=?,next_poll_at=? WHERE id=?').run(interval, now() + interval, s.id);
            return pending(session(s.id));
          }
          if (value.error === 'access_denied') { terminate(s.id, 'denied', 'GITHUB_AUTHORIZATION_DENIED'); throw new AccessError('GITHUB_AUTHORIZATION_DENIED', 403); }
          if (['expired_token', 'token_expired', 'incorrect_device_code'].includes(value.error)) {
            terminate(s.id, 'expired', 'GITHUB_SESSION_EXPIRED'); throw new AccessError('GITHUB_SESSION_EXPIRED', 403);
          }
          requireAccess(!value.error && safeString(value.access_token, 4096) && /^[A-Za-z0-9_.-]+$/.test(value.access_token) &&
            typeof value.token_type === 'string' && value.token_type.toLowerCase() === 'bearer', 'GITHUB_UPSTREAM_INVALID', 502);
          secret = { accessToken: value.access_token };
          db.prepare("UPDATE github_sessions SET state='identifying',protected=? WHERE id=?").run(store.seal(secret), s.id);
        }
        const who = identity(await json(USER_URL, { token: secret.accessToken }));
        // No network or await from this point to receipt commit. store.tx must
        // support nested SAVEPOINTs because issueInvitation uses the original tx.
        return tx(() => {
          const current = stateCheck(session(s.id)), a = allowed(current, who.id);
          if (current.state === 'ready') return ready(current);
          const invitation = issueInvitation({ label: a.label, teamRole: a.team_role, appRole: a.app_role, courseId: a.course_id,
            capabilities: JSON.parse(a.capabilities), memberId: a.member_id, ttlSeconds: INVITATION_SECONDS });
          requireAccess(invitation && !invitation.then && invitation.memberId === a.member_id && typeof invitation.secret === 'string' &&
            typeof invitation.invitationId === 'string', 'GITHUB_INVITATION_INVALID', 503);
          memberCheck(a, true);
          db.prepare("UPDATE github_allowlist SET login=? WHERE github_id=?").run(who.login, who.id);
          db.prepare("UPDATE github_sessions SET state='ready',protected=NULL,github_id=?,github_login=?,policy_revision=?,invitation_id=?,invitation=? WHERE id=?")
            .run(who.id, who.login, a.revision, invitation.invitationId, store.seal(invitation), s.id);
          return ready(session(s.id));
        });
      } catch (error) {
        if (error instanceof AccessError && error.status === 403) terminate(s.id,
          ['GITHUB_SESSION_EXPIRED', 'INVITATION_EXPIRED'].includes(error.code) ? 'expired' : 'denied', error.code);
        throw error instanceof AccessError ? error : new AccessError('GITHUB_UPSTREAM_UNAVAILABLE', 503);
      }
    })();
    polls.set(s.id, work);
    try { return await work; } finally { polls.delete(s.id); }
  }
  async function admin(operation, input) {
    cleanup();
    if (operation === 'github-list') return { accounts: db.prepare('SELECT * FROM github_allowlist ORDER BY github_id').all().map(listing) };
    if (operation === 'github-deny') {
      const id = idString(input?.githubId);
      return tx(() => {
        const a = account(id); requireAccess(a, 'GITHUB_ACCOUNT_NOT_FOUND', 404);
        const revision = tick();
        db.prepare("UPDATE github_allowlist SET state='denied',revision=?,deny_epoch=? WHERE github_id=?").run(revision, revision, id);
        db.prepare("UPDATE github_sessions SET state='denied',error_code='GITHUB_NOT_APPROVED',protected=NULL,invitation=NULL WHERE github_id=?").run(id);
        if (store.member(a.member_id)) store.denyMember(a.member_id);
        // The database denial is atomic; integration closes OS/application
        // resources afterwards and can retry that cleanup after interruption.
        return { githubId: Number(id), denied: true, memberId: a.member_id };
      });
    }
    requireAccess(operation === 'github-approve', 'ADMIN_OPERATION_INVALID');
    requireAccess(loginValid(input?.githubLogin), 'GITHUB_LOGIN_INVALID');
    const grant = policy(input);
    if (input.memberId !== undefined) requireAccess(typeof input.memberId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.memberId), 'MEMBER_CONFLICT');
    const beganEpoch = epoch(), who = identity(await json('https://api.github.com/users/' + input.githubLogin, { missingAccount: true }));
    return tx(() => {
      const old = account(who.id);
      // An approval which started before a deny cannot undo that deny on return.
      requireAccess(!old || old.deny_epoch <= beganEpoch, 'GITHUB_NOT_APPROVED', 403);
      if (old) memberCheck(old);
      requireAccess(!old || !input.memberId || input.memberId === old.member_id, 'MEMBER_CONFLICT', 409);
      const memberId = old?.member_id ?? input.memberId ?? `github-${who.id}`;
      const a = { github_id: who.id, login: who.login, label: grant.label, team_role: grant.teamRole, app_role: grant.appRole,
        course_id: grant.courseId, capabilities: JSON.stringify(grant.capabilities), member_id: memberId, state: 'active', deny_epoch: old?.deny_epoch ?? 0 };
      memberCheck(a, input.memberId !== undefined);
      requireAccess(!db.prepare('SELECT github_id FROM github_allowlist WHERE member_id=? AND github_id<>?').get(memberId, who.id), 'MEMBER_CONFLICT', 409);
      const same = old?.state === 'active' && ['login', 'label', 'team_role', 'app_role', 'course_id', 'capabilities', 'member_id'].every(key => old[key] === a[key]);
      const revision = same ? old.revision : tick();
      db.prepare(`INSERT INTO github_allowlist(github_id,login,label,team_role,app_role,course_id,capabilities,member_id,state,revision,deny_epoch)
        VALUES (?,?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login,label=excluded.label,
        team_role=excluded.team_role,app_role=excluded.app_role,course_id=excluded.course_id,capabilities=excluded.capabilities,
        state='active',revision=excluded.revision`).run(who.id, who.login, a.label, a.team_role, a.app_role, a.course_id, a.capabilities, memberId, revision, a.deny_epoch);
      return listing(account(who.id));
    });
  }
  cleanup();
  return { start, poll, admin };
}
