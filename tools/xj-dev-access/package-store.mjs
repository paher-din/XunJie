import { randomUUID } from 'node:crypto';
import { requireAccess } from '../xj-dev/src/enrollment-protocol.mjs';

export const PART_SIZE = 8 * 1024 * 1024;
export const DEFAULT_LIMITS = Object.freeze({ packageBytes: 128 * 1024 * 1024, memberBytes: 256 * 1024 * 1024, teamBytes: 1024 * 1024 * 1024 });
export const packageId = value => typeof value === 'string' && /^xjp_[a-f0-9-]{36}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const crc = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const md5 = value => typeof value === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(value) && Buffer.from(value, 'base64').length === 16 && Buffer.from(value, 'base64').toString('base64') === value;
export const quotedEtag = value => typeof value === 'string' && /^"[A-Za-z0-9-]{1,128}"$/.test(value);

// Uses the access database/transaction, never a second identity or quota store.
export function openPackageStore(access, configuration, now = Date.now) {
  const { db, tx } = access, limits = { ...DEFAULT_LIMITS, ...configuration.limits };
  for (const key of Object.keys(DEFAULT_LIMITS)) requireAccess(Number.isSafeInteger(limits[key]) && limits[key] > 0, 'PACKAGE_CONFIGURATION_INVALID');
  requireAccess(limits.packageBytes <= DEFAULT_LIMITS.packageBytes && limits.memberBytes >= limits.packageBytes && limits.teamBytes >= limits.memberBytes, 'PACKAGE_CONFIGURATION_INVALID');
  db.exec(`CREATE TABLE IF NOT EXISTS packages (
    id TEXT PRIMARY KEY, publisher_id TEXT NOT NULL REFERENCES members(id), idempotency_key TEXT NOT NULL,
    digest TEXT NOT NULL, bytes INTEGER NOT NULL, crc64 TEXT NOT NULL, format_version TEXT NOT NULL, tool_version TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'uploading', created_at INTEGER NOT NULL, published_at INTEGER,
    object_key TEXT UNIQUE NOT NULL, upload_id TEXT, etag TEXT, max_url_expiry INTEGER NOT NULL DEFAULT 0, cleanup_ready INTEGER NOT NULL DEFAULT 0,
    UNIQUE(publisher_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS package_parts (package_id TEXT NOT NULL REFERENCES packages(id), number INTEGER NOT NULL, bytes INTEGER NOT NULL, md5 TEXT NOT NULL, PRIMARY KEY(package_id,number));
    CREATE TABLE IF NOT EXISTS package_grants (id INTEGER PRIMARY KEY, package_id TEXT NOT NULL REFERENCES packages(id), device_id TEXT NOT NULL REFERENCES devices(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS package_baselines (name TEXT NOT NULL, version TEXT NOT NULL, package_id TEXT NOT NULL REFERENCES packages(id), created_at INTEGER NOT NULL, PRIMARY KEY(name,version));`);
  const scope = JSON.stringify([configuration.bucket, configuration.prefix]);
  db.prepare("INSERT OR IGNORE INTO metadata VALUES ('packageStorage',?)").run(scope);
  requireAccess(db.prepare("SELECT value FROM metadata WHERE key='packageStorage'").get().value === scope, 'PACKAGE_STORAGE_CHANGED');
  const row = id => db.prepare('SELECT * FROM packages WHERE id=?').get(id);
  const record = p => ({ reproId: p.id, publisherId: p.publisher_id, digest: p.digest, bytes: p.bytes, crc64: p.crc64,
    formatVersion: p.format_version, toolVersion: p.tool_version, state: p.state, createdAt: p.created_at, publishedAt: p.published_at });
  const get = id => { requireAccess(packageId(id), 'TRANSFER_NOT_FOUND', 404); const p = row(id); requireAccess(p, 'TRANSFER_NOT_FOUND', 404); return p; };
  const own = (id, memberId) => { const p = get(id); requireAccess(p.publisher_id === memberId, 'TRANSFER_NOT_OWNED', 403); return p; };
  const parts = id => db.prepare('SELECT number AS partNumber, bytes, md5 AS contentMD5 FROM package_parts WHERE package_id=? ORDER BY number').all(id);
  const partCount = p => Math.ceil(p.bytes / PART_SIZE);
  const expectedBytes = (p, n) => Math.min(PART_SIZE, p.bytes - (n - 1) * PART_SIZE);
  const usage = memberId => ({ memberBytes: db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM packages WHERE publisher_id=? AND (state IN ('uploading','published') OR cleanup_ready=0)").get(memberId).n,
    teamBytes: db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM packages WHERE state IN ('uploading','published') OR cleanup_ready=0").get().n });
  return {
    limits, row, get, own, record, parts, partCount, expectedBytes,
    reservation(identity, input) {
      requireAccess(uuid(input.idempotencyKey) && /^sha256:[a-f0-9]{64}$/.test(input.digest ?? '') && crc(input.crc64)
        && input.formatVersion === 'xj-repro/1' && input.toolVersion === '0.2.0', 'PACKAGE_METADATA_INVALID');
      requireAccess(Number.isSafeInteger(input.bytes) && input.bytes > 0 && input.bytes <= limits.packageBytes, 'PACKAGE_TOO_LARGE', 413);
      return tx(() => {
        const old = db.prepare('SELECT * FROM packages WHERE publisher_id=? AND idempotency_key=?').get(identity.memberId, input.idempotencyKey);
        if (old) {
          requireAccess(old.digest === input.digest && old.bytes === input.bytes && old.crc64 === input.crc64 && old.format_version === input.formatVersion && old.tool_version === input.toolVersion, 'UPLOAD_CONFLICT', 409);
          requireAccess(old.state !== 'failed', 'TRANSFER_FAILED', 409); return old;
        }
        const used = usage(identity.memberId);
        requireAccess(used.memberBytes + input.bytes <= limits.memberBytes, 'MEMBER_QUOTA_EXCEEDED', 413);
        requireAccess(used.teamBytes + input.bytes <= limits.teamBytes, 'TEAM_QUOTA_EXCEEDED', 413);
        const id = 'xjp_' + randomUUID();
        db.prepare('INSERT INTO packages(id,publisher_id,idempotency_key,digest,bytes,crc64,format_version,tool_version,created_at,object_key) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, identity.memberId, input.idempotencyKey, input.digest, input.bytes, input.crc64, input.formatVersion, input.toolVersion, now(), configuration.prefix + 'packages/' + id + '/repro.zip');
        return get(id);
      });
    },
    setUpload(id, uploadId) { requireAccess(typeof uploadId === 'string' && uploadId.length <= 1024, 'OBJECT_STORAGE_UNAVAILABLE', 503); db.prepare('UPDATE packages SET upload_id=? WHERE id=? AND upload_id IS NULL').run(uploadId, id); return get(id); },
    declareParts(id, claims) {
      const p = get(id); requireAccess(p.state === 'uploading', 'UPLOAD_CONFLICT', 409);
      requireAccess(Array.isArray(claims) && claims.length > 0 && claims.length <= 16 && new Set(claims.map(x => x.partNumber)).size === claims.length, 'PART_INVALID');
      return tx(() => {
        for (const c of claims) {
          requireAccess(Number.isInteger(c.partNumber) && c.partNumber > 0 && c.partNumber <= partCount(p) && c.bytes === expectedBytes(p, c.partNumber) && md5(c.contentMD5), 'PART_INVALID');
          const old = db.prepare('SELECT * FROM package_parts WHERE package_id=? AND number=?').get(id, c.partNumber);
          requireAccess(!old || old.bytes === c.bytes && old.md5 === c.contentMD5, 'PART_CONFLICT', 409);
          db.prepare('INSERT OR IGNORE INTO package_parts VALUES (?,?,?,?)').run(id, c.partNumber, c.bytes, c.contentMD5);
        }
        return parts(id).filter(p => claims.some(c => c.partNumber === p.partNumber));
      });
    },
    publish(id, head) {
      return tx(() => {
        const p = get(id); requireAccess(p.state !== 'failed', 'TRANSFER_FAILED', 409);
        requireAccess(head.bytes === p.bytes && head.crc64 === p.crc64 && quotedEtag(head.etag), 'OBJECT_MISMATCH', 409);
        if (p.state === 'published') requireAccess(p.etag === head.etag, 'OBJECT_MISMATCH', 409);
        else db.prepare("UPDATE packages SET state='published',published_at=?,etag=? WHERE id=?").run(now(), head.etag, id);
        return record(get(id));
      });
    },
    grant(id, deviceId, expiresAt) {
      requireAccess(access.activeDevice(deviceId).state === 'active', 'DEVICE_REVOKED', 403);
      requireAccess(Number.isSafeInteger(expiresAt) && expiresAt > now() && expiresAt <= now() + 300000, 'AUTHORIZATION_INVALID', 503);
      tx(() => { db.prepare('INSERT INTO package_grants(package_id,device_id,expires_at) VALUES (?,?,?)').run(id, deviceId, expiresAt);
        db.prepare('UPDATE packages SET max_url_expiry=MAX(max_url_expiry,?) WHERE id=?').run(expiresAt, id); db.prepare('DELETE FROM package_grants WHERE expires_at<?').run(now() - 86400000); });
    },
    outstanding(deviceIds) {
      const set = new Set(deviceIds), grants = db.prepare('SELECT device_id,MAX(expires_at) AS expiresAt FROM package_grants WHERE expires_at>? GROUP BY device_id').all(now()).filter(g => set.has(g.device_id));
      const expiresAt = Math.max(now(), ...grants.map(g => g.expiresAt)); return { signedUrlsValidUntil: grants.length ? expiresAt : null, remainingUrlValidityMs: Math.max(0, expiresAt - now()) };
    },
    quota(memberId) { return { limits, usage: usage(memberId ?? ''), members: db.prepare("SELECT publisher_id AS memberId,SUM(bytes) AS bytes FROM packages WHERE state IN ('uploading','published') OR cleanup_ready=0 GROUP BY publisher_id").all() }; },
    addBaseline(input) {
      requireAccess(/^[A-Za-z0-9_-]{1,64}$/.test(input.name ?? '') && /^[A-Za-z0-9_.-]{1,64}$/.test(input.version ?? ''), 'BASELINE_INVALID');
      const p = get(input.reproId); requireAccess(p.state === 'published', 'PACKAGE_NOT_READY', 409);
      return tx(() => { const old = db.prepare('SELECT * FROM package_baselines WHERE name=? AND version=?').get(input.name, input.version);
        requireAccess(!old || old.package_id === p.id, 'BASELINE_IMMUTABLE', 409);
        db.prepare('INSERT OR IGNORE INTO package_baselines VALUES (?,?,?,?)').run(input.name, input.version, p.id, now()); return { name: input.name, version: input.version, record: record(p) }; });
    },
    baselines() { return db.prepare('SELECT name,version,package_id AS reproId,created_at AS createdAt FROM package_baselines ORDER BY name,version').all(); },
    cleaned(id) { db.prepare("UPDATE packages SET cleanup_ready=1 WHERE id=? AND state='failed'").run(id); },
    fail(id) { return tx(() => { const p = get(id); requireAccess(p.state !== 'published' && !db.prepare('SELECT 1 FROM package_baselines WHERE package_id=?').get(id), 'PUBLISHED_PACKAGE_RETAINED', 409);
      db.prepare("UPDATE packages SET state='failed' WHERE id=?").run(id); return get(id); }); },
  };
}
