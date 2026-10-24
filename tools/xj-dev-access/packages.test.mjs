import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openAccessStore } from './store.mjs';
import { createPackages } from './packages.mjs';
import { PART_SIZE, openPackageStore } from './package-store.mjs';
import { AccessError } from '../xj-dev/src/enrollment-protocol.mjs';

function fixture(limits) {
  const root = mkdtempSync(join(tmpdir(), 'xjp-')), key = join(root, 'key'); writeFileSync(key, randomBytes(32), { mode: 0o600 });
  const access = openAccessStore(join(root, 'access.sqlite'), key, 'packages-test');
  const member = () => access.createInvitation({ label: 'fixture', teamRole: 'developer', appRole: 'student', courseId: 'course', ttlSeconds: 60, capabilities: ['file:read','file:publish'] }).memberId;
  const a = { memberId: member(), deviceId: randomUUID() }, b = { memberId: member(), deviceId: randomUUID() };
  // These isolated tests control OSS only; actual storage is a separate gate.
  const remote = new Map(), heads = new Map(); let completed = 0, failComplete = false, failAbort = false;
  const storage = {
    async initiate(key) { remote.set(key, []); return 'upload-' + randomUUID(); },
    async list(key) { return remote.get(key) ?? []; },
    async head(key) { return heads.get(key) ?? null; },
    async complete(key) { completed++; const p = access.db.prepare('SELECT * FROM packages WHERE object_key=?').get(key); heads.set(key, { bytes: p.bytes, crc64: p.crc64, etag: '"multipart-fixed"' }); if (failComplete) throw new AccessError('OBJECT_STORAGE_UNAVAILABLE', 503); },
    async abort() { if (failAbort) throw new AccessError('OBJECT_STORAGE_UNAVAILABLE', 503); },
  };
  const packages = createPackages(access, { bucket: 'fixture-bucket', prefix: 'team/', limits }, { storage });
  const input = (bytes = PART_SIZE + 7) => ({ idempotencyKey: randomUUID(), digest: 'sha256:' + 'a'.repeat(64), bytes, crc64: '11051210869376104954', formatVersion: 'xj-repro/1', toolVersion: '0.2.0' });
  const claim = (partNumber, bytes) => ({ partNumber, bytes, contentMD5: createHash('md5').update('fixture-' + partNumber).digest('base64') });
  const fill = id => {
    const p = packages.catalog.get(id), claims = Array.from({ length: packages.catalog.partCount(p) }, (_, n) => claim(n + 1, packages.catalog.expectedBytes(p, n + 1)));
    packages.catalog.declareParts(id, claims); remote.set(p.object_key, claims.map(c => ({ partNumber: c.partNumber, bytes: c.bytes, etag: '"' + Buffer.from(c.contentMD5, 'base64').toString('hex').toUpperCase() + '"' }))); return p;
  };
  return { access, packages, a, b, input, fill, remote, heads, claim, get completed() { return completed; }, failComplete: () => { failComplete = true; }, failAbort: value => { failAbort = value; }, close() { access.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('quota reserves pending bytes transactionally and stable publisher/idempotency cannot change content or transfer ownership', async () => {
  const f = fixture({ packageBytes: PART_SIZE, memberBytes: PART_SIZE, teamBytes: PART_SIZE * 2 });
  try {
    const input = f.input(PART_SIZE), first = await f.packages.handle('upload', f.a, input);
    assert.equal((await f.packages.handle('upload', f.a, input)).transferId, first.transferId);
    await assert.rejects(f.packages.handle('upload', f.a, { ...input, crc64: '0' }), { code: 'UPLOAD_CONFLICT' });
    await assert.rejects(f.packages.handle('upload', f.a, f.input(1)), { code: 'MEMBER_QUOTA_EXCEEDED' });
    await f.packages.handle('upload', f.b, f.input(PART_SIZE));
    const other = { memberId: f.access.createInvitation({ label:'third',teamRole:'developer',appRole:'student',courseId:'course',ttlSeconds:60,capabilities:['file:read'] }).memberId };
    await assert.rejects(f.packages.handle('upload', other, f.input(1)), { code: 'TEAM_QUOTA_EXCEEDED' });
    await assert.rejects(f.packages.handle('upload-status', f.b, { transferId: first.transferId }), { code: 'TRANSFER_NOT_OWNED' });
    await assert.rejects(f.packages.handle('upload', f.a, f.input(PART_SIZE + 1)), { code: 'PACKAGE_TOO_LARGE' });
    assert.equal(f.access.db.prepare('SELECT COUNT(*) AS n FROM packages').get().n, 2);
  } finally { f.close(); }
});

test('only exact frozen part sizes/MD5 and HEAD size/CRC publish; Complete lost reply is recovered without duplicate object or directory', async () => {
  const f = fixture();
  try {
    const { transferId } = await f.packages.handle('upload', f.a, f.input()), p = f.packages.catalog.get(transferId);
    await assert.rejects(f.packages.handle('complete', f.a, { transferId }), { code: 'UPLOAD_INCOMPLETE' });
    assert.equal(f.packages.catalog.get(transferId).state, 'uploading');
    assert.throws(() => f.packages.catalog.declareParts(transferId, [f.claim(1, 7)]), { code: 'PART_INVALID' });
    const claim = f.claim(1, PART_SIZE); f.packages.catalog.declareParts(transferId, [claim]);
    assert.throws(() => f.packages.catalog.declareParts(transferId, [{ ...claim, contentMD5: randomBytes(16).toString('base64') }]), { code: 'PART_CONFLICT' });
    f.fill(transferId); const parts = f.remote.get(p.object_key); parts[1].bytes++;
    await assert.rejects(f.packages.handle('complete', f.a, { transferId }), { code: 'OBJECT_MISMATCH' });
    f.fill(transferId); f.failComplete();
    await assert.rejects(f.packages.handle('complete', f.a, { transferId }), { code: 'OBJECT_STORAGE_UNAVAILABLE' });
    assert.equal(f.packages.catalog.get(transferId).state, 'uploading');
    const done = await f.packages.handle('complete', f.a, { transferId });
    assert.equal(done.record.state, 'published'); assert.equal(done.record.digest, 'sha256:' + 'a'.repeat(64), 'SHA remains the publisher claim');
    assert.equal(f.completed, 1);
    await f.packages.handle('complete', f.a, { transferId }); assert.equal(f.completed, 1);
    f.heads.set(p.object_key, { bytes: p.bytes, crc64: '0', etag: '"multipart-fixed"' });
    await assert.rejects(f.packages.handle('complete', f.a, { transferId }), { code: 'OBJECT_MISMATCH' });
  } finally { f.close(); }
});

test('cleanup deny survives storage failure, holds quota until abort succeeds, and cannot delete published baseline references', async () => {
  const f = fixture();
  try {
    const { transferId } = await f.packages.handle('upload', f.a, f.input());
    f.failAbort(true); await assert.rejects(f.packages.admin('package-cleanup', { transferId }), { code: 'OBJECT_STORAGE_UNAVAILABLE' });
    assert.equal(f.packages.catalog.get(transferId).state, 'failed');
    assert(f.packages.catalog.quota(f.a.memberId).usage.memberBytes > 0);
    await assert.rejects(f.packages.handle('upload-status', f.a, { transferId }), { code: 'TRANSFER_FAILED' });
    f.failAbort(false); await f.packages.admin('package-cleanup', { transferId });
    assert.equal(f.packages.catalog.quota(f.a.memberId).usage.memberBytes, 0);
    const good = await f.packages.handle('upload', f.a, f.input()); f.fill(good.transferId);
    await f.packages.handle('complete', f.a, { transferId: good.transferId });
    await f.packages.admin('package-baseline', { name: 'course', version: 'v1', reproId: good.transferId });
    await f.packages.admin('package-baseline', { name: 'course', version: 'v1', reproId: good.transferId });
    await assert.rejects(f.packages.admin('package-cleanup', { transferId: good.transferId }), { code: 'PUBLISHED_PACKAGE_RETAINED' });
    assert.equal(f.packages.catalog.baselines().length, 1);
  } finally { f.close(); }
});

test('download requires the published immutable HEAD and matching resume ETag; no URL can be issued for half uploads', async () => {
  const f = fixture();
  try {
    const { transferId } = await f.packages.handle('upload', f.a, f.input());
    await assert.rejects(f.packages.handle('resolve', f.b, { reproId: transferId, offset: 0 }), { code: 'PACKAGE_NOT_READY' });
    f.fill(transferId); await f.packages.handle('complete', f.a, { transferId });
    await assert.rejects(f.packages.handle('resolve', f.b, { reproId: transferId, offset: 1, etag: '"other"' }), { code: 'ETAG_CHANGED' });
    const result = await f.packages.handle('resolve', f.b, { reproId: transferId, offset: PART_SIZE + 7, etag: '"multipart-fixed"' });
    assert.equal(result.authorization, null);
  } finally { f.close(); }
});

test('retiring a baseline hides the member catalog but preserves its immutable reference, package and audit', async () => {
  const f = fixture();
  try {
    const { transferId } = await f.packages.handle('upload', f.a, f.input());
    f.fill(transferId); await f.packages.handle('complete', f.a, { transferId });
    const baseline = { name: 'acceptance', version: 'v1', reproId: transferId };
    await f.packages.admin('package-baseline', baseline);
    await f.packages.admin('package-baseline', { ...baseline, name: 'team' });
    const before = await f.packages.handle('resolve', f.b, { catalog: 'baselines' });
    assert.equal(before.baselines.length, 2);
    await assert.rejects(f.packages.admin('package-baseline-retire', { ...baseline, reason: ' ' }), { code: 'BASELINE_INVALID' });
    await assert.rejects(f.packages.admin('package-baseline-retire', { ...baseline, name: 'missing', reason: 'superseded' }), { code: 'BASELINE_NOT_FOUND' });
    await assert.rejects(f.packages.admin('package-baseline-retire', { ...baseline, reproId: 'xjp_' + randomUUID(), reason: 'superseded' }), { code: 'BASELINE_IMMUTABLE' });
    const retired = await f.packages.admin('package-baseline-retire', { ...baseline, reason: 'superseded by team' });
    assert.ok(retired.retiredAt > 0);
    assert.deepEqual(await f.packages.admin('package-baseline-retire', { ...baseline, reason: 'retry' }), retired);
    assert.deepEqual((await f.packages.handle('resolve', f.b, { catalog: 'baselines', includeRetired: true })).baselines, [before.baselines[1]]);
    const audit = (await f.packages.admin('package-baselines', {})).baselines;
    assert.equal(audit.find(b => b.name === 'acceptance').reason, 'superseded by team');
    await assert.rejects(f.packages.admin('package-baseline', baseline), { code: 'BASELINE_RETIRED' });
    await assert.rejects(f.packages.admin('package-cleanup', { transferId }), { code: 'PUBLISHED_PACKAGE_RETAINED' });
    assert.equal(f.packages.catalog.get(transferId).state, 'published');
    const result = await f.packages.handle('resolve', f.b, { reproId: transferId, offset: f.packages.catalog.get(transferId).bytes, etag: '"multipart-fixed"' });
    assert.equal(result.record.reproId, transferId);
    const reopened = openPackageStore(f.access, { bucket: 'fixture-bucket', prefix: 'team/' });
    assert.equal(reopened.baselines().length, 1);
    assert.equal(reopened.baselines({ includeRetired: true }).find(b => b.name === 'acceptance').retiredAt, retired.retiredAt);
    assert.equal(f.access.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { f.close(); }
});

test('opening an existing catalog adds retirement support without changing its published baseline', async () => {
  const f = fixture();
  try {
    const { transferId } = await f.packages.handle('upload', f.a, f.input());
    f.fill(transferId); await f.packages.handle('complete', f.a, { transferId });
    await f.packages.admin('package-baseline', { name: 'legacy', version: 'v1', reproId: transferId });
    const before = f.packages.catalog.baselines();
    f.access.db.exec('DROP TABLE package_baseline_retirements');
    const upgraded = openPackageStore(f.access, { bucket: 'fixture-bucket', prefix: 'team/' });
    assert.deepEqual(upgraded.baselines(), before);
    assert.equal(upgraded.get(transferId).state, 'published');
  } finally { f.close(); }
});
