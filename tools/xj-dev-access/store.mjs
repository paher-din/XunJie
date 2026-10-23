import { DatabaseSync, backup } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { digest, opaque, publicKey, requireAccess, verifyProof } from '../xj-dev/src/enrollment-protocol.mjs';

export function openAccessStore(file, credentialKeyFile, serviceId, now = Date.now) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = readFileSync(credentialKeyFile); requireAccess(key.length === 32, 'CREDENTIAL_KEY_INVALID');
  const db = new DatabaseSync(file); chmodSync(file, 0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, label TEXT NOT NULL, team_role TEXT NOT NULL, course_id TEXT NOT NULL, app_role TEXT NOT NULL, credential TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, secret_hash TEXT UNIQUE NOT NULL, member_id TEXT NOT NULL REFERENCES members(id), expires_at INTEGER NOT NULL, capabilities TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'available', device_id TEXT);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), public_key TEXT UNIQUE NOT NULL, capabilities TEXT NOT NULL, ssh_ready INTEGER NOT NULL DEFAULT 0, app_ready INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', close_ready INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, subject TEXT NOT NULL, public_key TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, body_hash TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, operation TEXT NOT NULL, resource_id TEXT NOT NULL, result TEXT NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO metadata VALUES ('serviceId',?)").run(serviceId);
  requireAccess(db.prepare("SELECT value FROM metadata WHERE key='serviceId'").get().value === serviceId, 'SERVICE_ID_CHANGED');
  const tx = work => { db.exec('BEGIN IMMEDIATE'); try { const out = work(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const audit = (operation, id, result) => db.prepare('INSERT INTO audit(at,operation,resource_id,result) VALUES (?,?,?,?)').run(now(), operation, id, result);
  const seal = value => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  };
  const unseal = value => {
    const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28)); return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  };
  const member = id => db.prepare('SELECT * FROM members WHERE id=?').get(id);
  const device = id => db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  const activeDevice = id => {
    const d = device(id), m = d && member(d.member_id);
    requireAccess(d && m?.state === 'active' && ['pending', 'active'].includes(d.state), 'DEVICE_REVOKED', 403); return d;
  };
  function createInvitation(input) {
    requireAccess(input && ['developer', 'maintainer'].includes(input.teamRole) && ['student', 'teacher'].includes(input.appRole), 'INVALID_ROLE');
    requireAccess(typeof input.label === 'string' && input.label.length > 0 && input.label.length <= 128 && typeof input.courseId === 'string', 'INVALID_REQUEST');
    requireAccess(Number.isInteger(input.ttlSeconds) && input.ttlSeconds >= 1 && input.ttlSeconds <= 86400, 'INVALID_EXPIRY');
    requireAccess(Array.isArray(input.capabilities) && input.capabilities.every(c => c === 'page' || /^node:[A-Za-z0-9_-]{1,64}$/.test(c)), 'INVALID_CAPABILITY');
    const secret = opaque(), id = randomUUID(), memberId = input.memberId ?? randomUUID();
    return tx(() => {
      const existing = member(memberId);
      if (existing) requireAccess(existing.state === 'active' && existing.team_role === input.teamRole && existing.course_id === input.courseId && existing.app_role === input.appRole, 'MEMBER_CONFLICT');
      else db.prepare('INSERT INTO members(id,label,team_role,course_id,app_role,credential) VALUES (?,?,?,?,?,?)').run(memberId, input.label, input.teamRole, input.courseId, input.appRole, seal({ loginName: `synthetic-dev-${memberId}`, password: opaque() + opaque() }));
      const expiresAt = now() + input.ttlSeconds * 1000;
      db.prepare('INSERT INTO invitations(id,secret_hash,member_id,expires_at,capabilities) VALUES (?,?,?,?,?)').run(id, digest(secret), memberId, expiresAt, JSON.stringify([...new Set(input.capabilities)]));
      audit('invite', id, 'created'); return { invitationId: id, memberId, secret, expiresAt };
    });
  }
  function invitation(secret) {
    requireAccess(typeof secret === 'string' && secret.length <= 128, 'INVITATION_INVALID', 401);
    const i = db.prepare('SELECT * FROM invitations WHERE secret_hash=?').get(digest(secret));
    requireAccess(i && i.state !== 'revoked' && member(i.member_id)?.state === 'active', 'INVITATION_INVALID', 401);
    requireAccess(i.device_id || i.expires_at > now(), 'INVITATION_EXPIRED', 403); return i;
  }
  function issueChallenge(input) {
    const key = publicKey(input.publicKey), isEnrollment = input.path === '/v1/enroll';
    requireAccess(input.method === 'POST' && ['/v1/enroll', '/v1/config', '/v1/identity'].includes(input.path) && /^[a-f0-9]{64}$/.test(input.bodyHash), 'INVALID_PROOF_TARGET');
    let subject;
    if (isEnrollment) {
      const i = invitation(input.invitationSecret); subject = `invite:${i.id}`;
      if (i.device_id) requireAccess(activeDevice(i.device_id).public_key === key, 'INVITATION_KEY_MISMATCH', 403);
    } else {
      const d = activeDevice(input.deviceId); requireAccess(d.public_key === key, 'DEVICE_KEY_MISMATCH', 403); subject = `device:${d.id}`;
    }
    const count = db.prepare('SELECT count(*) AS n FROM challenges WHERE expires_at>? AND consumed=0').get(now()).n;
    requireAccess(count < 200, 'RATE_LIMITED', 429);
    const c = { serviceId, challengeId: randomUUID(), nonce: opaque(), expiresAt: now() + 60000, method: input.method, path: input.path, bodyHash: input.bodyHash };
    db.prepare('DELETE FROM challenges WHERE expires_at<?').run(now() - 60000);
    db.prepare('INSERT INTO challenges(id,subject,public_key,nonce,expires_at,method,path,body_hash) VALUES (?,?,?,?,?,?,?,?)').run(c.challengeId, subject, key, c.nonce, c.expiresAt, c.method, c.path, c.bodyHash);
    return c;
  }
  function authenticateProof(envelope, path) {
    const c = db.prepare('SELECT * FROM challenges WHERE id=?').get(envelope.challengeId);
    requireAccess(c && !c.consumed && c.expires_at > now() && c.path === path && c.method === 'POST' && c.body_hash === digest(JSON.stringify(envelope.body)), 'PROOF_EXPIRED_OR_REPLAYED', 401);
    const challenge = { serviceId, challengeId: c.id, nonce: c.nonce, expiresAt: c.expires_at, method: c.method, path: c.path, bodyHash: c.body_hash };
    verifyProof(c.public_key, challenge, envelope.signature);
    return tx(() => {
      requireAccess(db.prepare('UPDATE challenges SET consumed=1 WHERE id=? AND consumed=0 AND expires_at>?').run(c.id, now()).changes === 1, 'PROOF_EXPIRED_OR_REPLAYED', 401);
      let d;
      if (c.subject.startsWith('invite:')) {
        const i = invitation(envelope.body.invitationSecret); requireAccess(c.subject === `invite:${i.id}`, 'PROOF_INVALID', 401);
        if (i.device_id) { d = activeDevice(i.device_id); requireAccess(d.public_key === c.public_key, 'INVITATION_KEY_MISMATCH', 403); }
        else {
          requireAccess(!db.prepare('SELECT id FROM devices WHERE public_key=?').get(c.public_key), 'DEVICE_ALREADY_REGISTERED', 409);
          const id = randomUUID();
          db.prepare('INSERT INTO devices(id,member_id,public_key,capabilities) VALUES (?,?,?,?)').run(id, i.member_id, c.public_key, i.capabilities);
          db.prepare("UPDATE invitations SET device_id=?,state='bound' WHERE id=?").run(id, i.id); d = device(id); audit('enroll', id, 'bound');
        }
      } else { d = activeDevice(c.subject.slice(7)); requireAccess(d.public_key === c.public_key && envelope.body.deviceId === d.id, 'PROOF_INVALID', 401); }
      return d;
    });
  }
  return {
    db, tx, member, device, activeDevice, createInvitation, issueChallenge, authenticateProof,
    credentials: id => unseal(member(id).credential),
    identity(id) { const d = activeDevice(id), m = member(d.member_id); return { memberId: m.id, deviceId: d.id, teamRole: m.team_role, capabilities: JSON.parse(d.capabilities) }; },
    stage(id, stage) { requireAccess(['ssh_ready', 'app_ready'].includes(stage)); activeDevice(id); db.prepare(`UPDATE devices SET ${stage}=1 WHERE id=?`).run(id); },
    activate(id) { activeDevice(id); db.prepare("UPDATE devices SET state='active' WHERE id=? AND ssh_ready=1 AND app_ready=1").run(id); },
    denyDevice(id) { requireAccess(device(id), 'DEVICE_NOT_FOUND', 404); tx(() => { db.prepare("UPDATE devices SET state='revoked' WHERE id=?").run(id); db.prepare("UPDATE invitations SET state='revoked' WHERE device_id=?").run(id); audit('revoke-device', id, 'denied'); }); },
    closed(id) { db.prepare('UPDATE devices SET close_ready=1 WHERE id=?').run(id); audit('revoke-device', id, 'closed'); },
    denyMember(id) { requireAccess(member(id), 'MEMBER_NOT_FOUND', 404); tx(() => { db.prepare("UPDATE members SET state='revoked' WHERE id=?").run(id); db.prepare("UPDATE invitations SET state='revoked' WHERE member_id=?").run(id); db.prepare("UPDATE devices SET state='revoked' WHERE member_id=?").run(id); audit('revoke-member', id, 'denied'); }); return db.prepare('SELECT * FROM devices WHERE member_id=?').all(id); },
    revokeInvitation(id) { requireAccess(db.prepare('SELECT id FROM invitations WHERE id=? AND device_id IS NULL').get(id), 'INVITATION_ALREADY_BOUND', 409); db.prepare("UPDATE invitations SET state='revoked' WHERE id=?").run(id); },
    inspect() { return { members: db.prepare('SELECT id,label,team_role,course_id,app_role,state FROM members').all(), devices: db.prepare('SELECT id,member_id,capabilities,ssh_ready,app_ready,state,close_ready FROM devices').all(), invitations: db.prepare('SELECT id,member_id,expires_at,state,device_id FROM invitations').all() }; },
    async snapshot(destination) { await backup(db, destination); chmodSync(destination, 0o600); },
    close() { db.close(); },
  };
}
