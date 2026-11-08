import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealRecovery } from '../dist/recovery-files.js';
import { sealRecoverySet, verifyRecoverySet, restoreRecoverySetBundle,
  recoverySetMemberDirectory, createStorageRecoveryOwner } from '@xunjie/product-runtime';

function metadata(installationId = randomUUID()) {
  const environmentId = randomUUID();
  const serviceId = randomUUID();
  return { formatVersion: 1, backupId: randomUUID(),
    source: { formatVersion: 1, environmentId, installationId, clientNamespace: 'course', profile: 'local',
      services: [{ environmentId, serviceId, unit: 'learning-data', endpoint: 'https://localhost:3445/', protocolVersion: 1, capabilities: ['recovery'] }] },
    boundaryAt: '2026-10-30T00:00:00.000Z', completedAt: '2026-10-30T00:00:01.000Z', durationMs: 1000,
    services: [{ serviceId, schemaVersion: '1', engineVersion: '17.6' }], receiverIds: [`${randomUUID()}/${randomUUID()}`] };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xj-recovery-set-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, key: randomBytes(48) };
}
async function sealedBackup(t, f, name) {
  const directory = join(f.root, name);
  await mkdir(join(directory, 'payload', 'owner'), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'payload', 'owner', 'recovery.json'), JSON.stringify({ formatVersion: 1, data: name }));
  const meta = metadata();
  const manifest = await sealRecovery(directory, f.key, meta);
  return { directory, manifest, installationId: meta.source.installationId, environmentId: meta.source.environmentId };
}
async function linkedSet(t) {
  const f = await fixture(t);
  const a = await sealedBackup(t, f, 'a'), b = await sealedBackup(t, f, 'b');
  const directory = join(f.root, 'set');
  const manifest = await sealRecoverySet({ directory, key: f.key,
    members: [a, b].map(item => ({ installationId: item.installationId, environmentId: item.environmentId, backupDirectory: item.directory })) });
  return { f, a, b, directory, manifest };
}

test('an authenticated recovery set links two independent installations and verifies every original', async t => {
  const { f, a, b, directory, manifest } = await linkedSet(t);
  assert.equal(manifest.members.length, 2);
  const verified = await verifyRecoverySet(directory, f.key);
  assert.deepEqual(verified.manifest, manifest);
  assert.deepEqual(verified.members.map(item => item.member.installationId).sort(),
    [a.installationId, b.installationId].sort());
  for (const { member } of verified.members) {
    assert.equal(member.manifestSha256, createHash('sha256').update(
      await readFile(join(recoverySetMemberDirectory(directory, member.backupId), 'manifest.json'))).digest('hex'));
    assert.ok(member.artifacts.length > 0);
    assert.equal(member.services.length, 1);
  }
});

test('a missing member, corrupt original, wrong key or tampered set fails closed before any restore', async t => {
  const { f, a, b, directory } = await linkedSet(t);
  await assert.rejects(verifyRecoverySet(directory, randomBytes(48)), { code: 'invalid-recovery-key' });

  const removed = await linkedSet(t);
  await rm(join(removed.directory, 'members', removed.manifest.members[0].directory), { recursive: true, force: true });
  await assert.rejects(verifyRecoverySet(removed.directory, removed.f.key), { code: 'recovery-set-member-missing' });

  const corrupt = await linkedSet(t);
  const target = join(corrupt.directory, 'members', corrupt.manifest.members[0].directory,
    'artifacts', corrupt.manifest.members[0].artifacts[0].path);
  await writeFile(target, await readFile(target).then(bytes => Buffer.concat([bytes, Buffer.from([1])])));
  await assert.rejects(verifyRecoverySet(corrupt.directory, corrupt.f.key), { code: 'recovery-set-corrupt' });

  const tampered = await linkedSet(t);
  const setPath = join(tampered.directory, 'recovery-set.json');
  const value = JSON.parse(await readFile(setPath, 'utf8'));
  value.members[0].services.push('forged-service');
  await writeFile(setPath, JSON.stringify(value));
  await assert.rejects(verifyRecoverySet(tampered.directory, tampered.f.key), { code: 'invalid-recovery-key' });

  const duplicate = await linkedSet(t);
  await assert.rejects(sealRecoverySet({ directory: join(duplicate.f.root, 'duplicate'), key: duplicate.f.key,
    members: [{ installationId: duplicate.a.installationId, environmentId: duplicate.a.environmentId,
      backupDirectory: duplicate.a.directory },
    { installationId: duplicate.a.installationId, environmentId: duplicate.a.environmentId,
      backupDirectory: duplicate.a.directory }] }), { code: 'recovery-set-duplicate-member' });
  await assert.rejects(sealRecoverySet({ directory: join(duplicate.f.root, 'wrong-identity'), key: duplicate.f.key,
    members: [{ installationId: randomUUID(), environmentId: duplicate.a.environmentId, backupDirectory: duplicate.a.directory }] }),
  { code: 'recovery-set-identity-conflict' });

  const calls = [];
  const result = await restoreRecoverySetBundle({ setDirectory: directory, key: f.key,
    restores: [a, b].map(item => ({ installationId: item.installationId, restore: async () => {
      calls.push(item.installationId); return { backupId: item.manifest.backupId };
    } })) });
  assert.equal(result.results.length, 2);
  assert.deepEqual(calls.sort(), [a.installationId, b.installationId].sort());
  await assert.rejects(restoreRecoverySetBundle({ setDirectory: directory, key: f.key,
    restores: [{ installationId: a.installationId, restore: async () => null }] }), { code: 'recovery-set-restore-mismatch' });
});

test('a legacy owner without a source collector still emits the published boundary shape', async () => {
  const serviceId = randomUUID();
  const storage = { owner: { environmentId: randomUUID(), serviceId },
    participant: () => ({ descriptor: { serviceId, schemaVersion: '1', resourceRoots: [], configurationRefs: [] },
      closeWrites: async () => {}, closeDispatch: async () => {}, drain: async () => {},
      validate: async () => {}, resume: async () => {} }) };
  const boundaryAt = '2026-10-30T00:00:00.000Z';
  const legacy = createStorageRecoveryOwner({ storage, binding: {}, migrations: [], resources: {},
    installationId: randomUUID(), validateService: async () => {} });
  assert.equal('sources' in (await legacy.material({ backupId: randomUUID(), boundaryAt, signal: new AbortController().signal })), false);
  const closure = { formatVersion: 1, kind: 'xunjie.owner-sources/1', owner: 'xunjie.learning-data', entries: [] };
  const current = createStorageRecoveryOwner({ storage, binding: {}, migrations: [], resources: {},
    installationId: randomUUID(), validateService: async () => {}, sources: async () => closure });
  assert.deepEqual((await current.material({ backupId: randomUUID(), boundaryAt, signal: new AbortController().signal })).sources, closure);
});
