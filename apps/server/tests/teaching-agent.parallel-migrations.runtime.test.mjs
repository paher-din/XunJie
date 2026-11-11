import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { createTeachingAgent, teachingAgentMigrations } from '@xunjie/learning-space';
import { createMaintenanceCoordinator, createRecoveryManager, restoreRecoverySet,
  createStorageRecoveryOwner, createStorageRecoveryTarget } from '@xunjie/product-runtime';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { parseTeachingSkillPackage } from '../../../packages/learning-space/dist/teaching-agent/skills-package.js';
import { canonicalDigest, operationId } from '../../../packages/learning-space/dist/teaching-agent/identity.js';

const digest = item => createHash('sha256').update(`${item.version}\n${item.name}\n${item.sql}`).digest('hex');
// Frozen from cb104e33604cbfcb8c5c4f294dd5c745e723834c, not derived from the current implementation.
const baselineChecksums = [
  '8262fe3e0805c0f3ef539efd638da2390ee930d1706c0f80b7108d1ebd5a93c0',
  '50a77a67bc4050a77b78adab560900db823a9950ad68b7ee91c965f39a7b9073',
  'bcf8dfd153a89f8af5862db98cce92b4cf712bc6dc2fc1a0257647b2cf09cbf2',
  '044398cf14237d30e99e05f4352313fa0944d668759394eb1bef46591284f290',
  'e2cf2e2fae51d4329491f6c2124e3f6bf7a0319ce8383101c115770777f1bd5a',
  '916b12a21d0198e9bac3b576dba2dad9e40c80c7e1e7e401be1aa8da759054d5',
  'c96fd0b3c747e90bdc55963530b8566d54ad813e8126de58c20ef73f057806f4',
  '14a0096b77e5e2725828a2b4880314de7229adec2de431cf5840f98090fc8cc7',
  'c291b4e23473761d08eb379c1648ea9b37541b97da23a5d9dc8e6b484579ea0d',
  'ad8d9091507d6626411371679464f171d5d4ab4b6d67a535a7e2a1bcea69cdb2',
];
const legacyChecksums = {
  skills: '4572fa1a2eb9e9a9a54e86212a60f48eb6f8d0f6e83b8c5c2ebc74f02d588baa',
  compaction: '0b26e6ddfdd3e98f31deace49655287c25c4044b62298f7769abb797de0a5a3f',
};
function legacy(kind) {
  const base = teachingAgentMigrations.slice(0, 10).map(({ version, name, sql }) => ({ version, name, sql }));
  assert.deepEqual(base.map(digest), baselineChecksums, 'Published migrations 1-10 must remain byte-for-byte identical.');
  if (kind === 'baseline') return base;
  const name = kind === 'skills' ? 'independent-fixed-skill-packages' : 'bounded-context-compaction';
  const current = teachingAgentMigrations.find(item => item.name === name);
  assert.ok(current, `The final owner must register ${name}.`);
  const old = { version: 11, name, sql: current.sql };
  assert.equal(digest(old), legacyChecksums[kind], 'Legacy v11 SQL/name are pinned to the published branch identity.');
  return [...base, old];
}
const journal = async storage => (await storage.read(
  'SELECT version,name,checksum,applied_at::text AS applied_at FROM _storage_migrations ORDER BY version')).rows;
const identity = environmentId => ({ environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'migration fixture' });
function agent(storage) {
  return createTeachingAgent(storage, { start: false, authorize: async () => {}, identityFor: async value => value,
    activity: async () => { throw new Error('Migration verification must not request an activity.'); }, models: {} });
}
const skillInput = () => ({ requestId: randomUUID(), source: 'acceptance:parallel-migrations', packageVersion: '1.0.0',
  files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: migration-check\ndescription: 保留迁移前的学习依据\n---\n先记录原观察。' }] });
async function seedLegacySkill(storage, user, input) {
  // Write the published v11 tables and receipt directly: today's owner requires v15.
  assert.equal((await journal(storage)).at(-1).version, 11);
  const { rows: columns } = await storage.read(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='teaching_skills' AND column_name='removed'`);
  assert.deepEqual(columns, [], 'The source really is the pre-removal schema.');
  const ownerKey = [user.environmentId, user.spaceId, user.principalId].join('/');
  const skillId = operationId('teaching-skill:' + user.environmentId + '/' + user.principalId + ':' + input.requestId);
  const fixed = { ...parseTeachingSkillPackage(input), skillId, version: 1 };
  const { files: _files, ...metadata } = fixed;
  const imported = { ...metadata, name: fixed.metadata.name, description: fixed.metadata.description,
    origin: 'personal', selected: true, disabled: false, required: false };
  const receipt = await storage.request({ requestId: 'skills:' + input.requestId,
    fingerprint: canonicalDigest({ owner: ownerKey, input: { operation: 'import', input } }) }, async tx => {
    await tx.query('INSERT INTO teaching_skills(owner_key,skill_id,version) VALUES($1,$2,1)', [ownerKey, skillId]);
    await tx.query('INSERT INTO teaching_skill_versions(owner_key,skill_id,version,body) VALUES($1,$2,1,$3)',
      [ownerKey, skillId, JSON.stringify(fixed)]);
    return imported;
  });
  assert.deepEqual(receipt.result, imported);
  return imported;
}
async function checkImportedSkill(storage, user, imported) {
  const service = agent(storage);
  assert.deepEqual((await service.skills.list(user)).skills, [imported]);
  const { rows: [version] } = await storage.read('SELECT body FROM teaching_skill_versions WHERE skill_id=$1 AND version=$2',
    [imported.skillId, imported.version]);
  assert.deepEqual(await service.skills.document(user, { skillId: imported.skillId, version: imported.version }),
    { skillId: imported.skillId, version: imported.version, content: skillInput().files[0].content });
  assert.equal(version.body.digest, imported.digest);
  assert.deepEqual(version.body.files, skillInput().files);
  assert.deepEqual((await storage.read('SELECT removed FROM teaching_skills WHERE skill_id=$1', [imported.skillId])).rows, [{ removed: false }]);
}
async function closeGates(storage) {
  await storage.participant().closeWrites(); await storage.participant().closeDispatch(); await storage.participant().drain();
}
async function checkFinal(storage, before = []) {
  const rows = await journal(storage);
  assert.deepEqual(rows.map(({ version, name, checksum }) => ({ version, name, checksum })),
    teachingAgentMigrations.map(item => ({ version: item.version, name: item.name, checksum: digest(item) })));
  for (const old of before) {
    const actual = rows.find(item => item.name === old.name);
    assert.equal(actual.applied_at, old.applied_at, 'Already applied migrations must not be rerun or retimestamped.');
    if (old.version <= 10) assert.deepEqual(actual, old, 'Every field of the 1-10 journal is immutable.');
  }
  for (const table of ['teaching_skills', 'teaching_skill_versions', 'teaching_skill_selections', 'teaching_skill_loads', 'teaching_compactions'])
    await storage.read(`SELECT * FROM ${table} LIMIT 1`);
  await storage.read('SELECT capacity_rejected FROM teaching_steps LIMIT 1');
  await storage.read('SELECT compaction_id FROM teaching_segment_transitions LIMIT 1');
}

test('fresh teaching owner installs both independent v11 features exactly once', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let storage;
  try {
    legacy('skills'); legacy('compaction');
    const input = { admin: fixture.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(),
      migrations: teachingAgentMigrations };
    const binding = await provisionStorage(input), backend = createFileBackend({ id: 'files', root: join(fixture.root, 'objects') });
    storage = await openStorage({ binding, backend, migrations: teachingAgentMigrations });
    await checkFinal(storage);
    const user = identity(input.owner.environmentId), service = agent(storage);
    const imported = await service.skills.import(user, skillInput());
    assert.equal((await service.skills.list(user)).skills[0].skillId, imported.skillId);
    const before = await journal(storage);
    await provisionStorage(input); assert.deepEqual(await journal(storage), before);
  } finally { await storage?.close(); await fixture.close(); }
});

for (const kind of ['baseline', 'skills', 'compaction']) {
  test(`${kind} teaching installation and its actual old-owner backup upgrade without losing identities`, { timeout: 120000 }, async () => {
    const source = await nativeFixture(), target = await nativeFixture();
    const handles = [];
    try {
      const migrations = legacy(kind), owner = { environmentId: randomUUID(), serviceId: randomUUID() }, password = randomUUID();
      const binding = await provisionStorage({ admin: source.admin, owner, password, migrations });
      const backend = createFileBackend({ id: 'files', root: join(source.root, 'objects') });
      const original = await openStorage({ binding, backend, migrations }); handles.push(original);
      const user = identity(owner.environmentId);
      let imported;
      if (kind === 'skills') imported = await seedLegacySkill(original, user, skillInput());
      const resource = await original.stageResource({ uploadId: randomUUID(), scope: 'migration-history',
        bytes: Buffer.from('原始教学材料\0'), mediaType: 'application/octet-stream', contentVersion: 1 });
      const receipt = await original.request({ requestId: 'original-evidence', fingerprint: 'fixed-history' }, async tx => {
        await tx.reference('original-evidence', resource.resourceId); return { resourceId: resource.resourceId };
      });
      const before = await journal(original);
      await assert.rejects(provisionStorage({ admin: source.admin, owner, password, migrations: teachingAgentMigrations }), { code: 'maintenance' });
      assert.deepEqual(await journal(original), before, 'An open-gate upgrade must not alter any journal row.');
      await closeGates(original);
      const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
        postgresVersion: '18.6', webRoot: source.root };
      const directory = join(source.root, 'old-backup'); await mkdir(directory);
      const recoveryOwner = createStorageRecoveryOwner({ storage: original, binding, migrations, resources,
        installationId: randomUUID(), validateService: async () => {} });
      const signal = new AbortController().signal;
      const recovery = await recoveryOwner.export({ backupId: 'published-branch-backup', directory, signal });
      assert.equal(recovery.data.manifest.schemaVersion, migrations.length);
      assert.deepEqual(recovery.data.migrations, migrations, 'The backup carries the original branch SQL/version list.');
      if (kind === 'compaction') {
        const rejectingTarget = createStorageRecoveryTarget({ owner, resources, migrations: teachingAgentMigrations,
          admin: async () => { throw new Error('An unrecognized backup must fail before target access.'); },
          backend: createFileBackend({ id: 'files', root: join(target.root, 'rejected-objects') }),
          installationId: randomUUID(), validateService: async () => {} });
        for (const mutation of [
          item => ({ ...item, sql: item.sql + ' ' }),
          item => ({ ...item, name: item.name + '-similar' }),
          item => ({ ...item, version: 12, formerVersion: 11 }),
          item => ({ ...item, sql: item.sql.replace('capacity_rejected', 'capacity_accepted'), formerVersion: 11 }),
        ]) {
          const forged = structuredClone(recovery);
          forged.data.migrations[10] = mutation(forged.data.migrations[10]);
          await assert.rejects(rejectingTarget.restore({ targetRoot: target.root, directory, recovery: forged, signal }),
            error => error.code === 'incompatible-schema');
        }
      }

      // Public target entry exercises its migration-list guard, strict old-schema finalization and subsequent upgrade.
      const destination = createStorageRecoveryTarget({ owner, admin: async () => target.admin, resources,
        backend: createFileBackend({ id: 'files', root: join(target.root, 'objects') }),
        migrations: teachingAgentMigrations, installationId: randomUUID(),
        validateService: checkFinal,
        onRestored: async storage => {
          handles.push(storage); await checkFinal(storage, before);
          assert.deepEqual(await storage.receipt('original-evidence'), receipt);
          assert.deepEqual(Buffer.from(await storage.readResource(resource.resourceId)), Buffer.from('原始教学材料\0'));
          if (imported) await checkImportedSkill(storage, user, imported);
          await assert.rejects(storage.request({ requestId: 'closed-restore', fingerprint: 'closed' }, async () => ({})), { code: 'maintenance' });
        } });
      await destination.restore({ targetRoot: target.root, directory, recovery, signal });
      await destination.validate();

      await provisionStorage({ admin: source.admin, owner, password, migrations: teachingAgentMigrations });
      const current = await openStorage({ binding, backend, migrations: teachingAgentMigrations }); handles.push(current);
      await checkFinal(current, before);
      assert.deepEqual(await current.receipt('original-evidence'), receipt);
      assert.deepEqual(Buffer.from(await current.readResource(resource.resourceId)), Buffer.from('原始教学材料\0'));
      await assert.rejects(openStorage({ binding, backend, migrations }), { code: 'incompatible' });
      await assert.rejects(original.participant().resume(), { code: 'stale-generation' });
      await current.participant().resume();
      const service = agent(current);
      if (imported) await checkImportedSkill(current, user, imported);
      else assert.ok((await service.skills.import(user, skillInput())).skillId);
      const after = await journal(current);
      await provisionStorage({ admin: source.admin, owner, password, migrations: teachingAgentMigrations });
      assert.deepEqual(await journal(current), after, 'Retrying provisioning cannot replay either feature migration.');
    } finally {
      await Promise.all(handles.map(storage => storage.close())); await source.close(); await target.close();
    }
  });
}

for (const kind of ['skills', 'compaction']) {
  test(`${kind} legacy backup takes over through the public recovery workflow and permanently retires its source`, { timeout: 120000 }, async () => {
    const source = await nativeFixture(), target = await nativeFixture(), handles = [];
    try {
      const migrations = legacy(kind), owner = { environmentId: randomUUID(), serviceId: randomUUID() };
      const binding = await provisionStorage({ admin: source.admin, owner, password: randomUUID(), migrations });
      const backend = createFileBackend({ id: 'files', root: join(source.root, 'objects') });
      const original = await openStorage({ binding, backend, migrations }); handles.push(original);
      const peer = await openStorage({ binding, backend, migrations }); handles.push(peer);
      const user = identity(owner.environmentId), oldInput = skillInput();
      const imported = kind === 'skills' ? await seedLegacySkill(original, user, oldInput) : undefined;
      const receipt = await original.request({ requestId: 'takeover-original', fingerprint: 'fixed-identity' }, async () => ({ original: true }));
      const before = await journal(original);
      const root = join(source.root, 'installation'); await mkdir(root);
      const environment = { formatVersion: 1, environmentId: owner.environmentId, installationId: randomUUID(),
        clientNamespace: 'migration-acceptance', profile: 'local', services: [{ ...owner,
          unit: 'teaching-agent', endpoint: 'http://127.0.0.1:1', protocolVersion: 1, capabilities: [] }] };
      const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
        postgresVersion: '18.6', webRoot: source.root };
      const recoveryOwner = createStorageRecoveryOwner({ storage: original, binding, migrations, resources,
        installationId: environment.installationId, validateService: async storage => {
          assert.deepEqual((await journal(storage)).map(item => item.checksum), migrations.map(digest));
        } });
      const maintenance = createMaintenanceCoordinator({ requiredServiceIds: [owner.serviceId], record: async () => {} });
      maintenance.register(recoveryOwner.participant);
      const sourceOptions = { root, environment, maintenance, owners: [recoveryOwner], requiredServiceIds: [owner.serviceId] };
      const manager = createRecoveryManager(sourceOptions), key = randomBytes(32), directory = join(source.root, 'backups');
      const backup = await manager.backup({ directory, key, leaveClosed: true });
      assert.equal(backup.services[0].schemaVersion, 'storage/1;owner/11');
      const targetRoot = join(target.root, 'installation'), targetEnvironment = { ...environment, installationId: randomUUID() };
      let restoredStorage;
      const recoveryTarget = createStorageRecoveryTarget({ owner, resources, migrations: teachingAgentMigrations,
        admin: async () => target.admin, backend: createFileBackend({ id: 'files', root: join(target.root, 'objects') }),
        installationId: targetEnvironment.installationId, validateService: checkFinal,
        onRestored: storage => { restoredStorage = storage; handles.push(storage); } });
      const restored = await restoreRecoverySet({ backupDirectory: join(directory, backup.backupId), targetRoot, key, targets: [recoveryTarget] });
      await checkFinal(restoredStorage, before);
      assert.deepEqual(await restoredStorage.receipt('takeover-original'), receipt);
      const targetMaintenance = createMaintenanceCoordinator({ requiredServiceIds: [owner.serviceId], record: async () => {} });
      targetMaintenance.register(restored.owners[0].participant);
      const successor = createRecoveryManager({ root: targetRoot, environment: targetEnvironment,
        maintenance: targetMaintenance, owners: restored.owners, requiredServiceIds: [owner.serviceId] });
      await assert.rejects(successor.resume(), error => error.code === 'target-isolated');
      await assert.rejects(restoredStorage.request({ requestId: 'too-early', fingerprint: 'isolated' }, async () => ({})), { code: 'maintenance' });
      assert.equal((await successor.takeover({ source: manager, receivers: [] })).phase, 'active');
      assert.equal((await successor.takeover({ source: manager, receivers: [] })).phase, 'active', 'A lost takeover reply is retryable.');
      const retirement = JSON.parse(await readFile(join(root, 'retired.json'), 'utf8'));
      assert.equal(retirement.targetInstallationId, targetEnvironment.installationId);
      assert.equal(retirement.backupId, backup.backupId);
      await assert.rejects(manager.resume(), error => error.code === 'source-retired');
      await assert.rejects(createRecoveryManager(sourceOptions).resume(), error => error.code === 'source-retired',
        'Restarting the source manager cannot reopen a retired installation.');
      await assert.rejects(peer.request({ requestId: 'retired-peer', fingerprint: 'retired' }, async () => ({})), { code: 'stale-generation' });
      const reopened = await openStorage({ binding, backend, migrations }); handles.push(reopened);
      await assert.rejects(reopened.request({ requestId: 'retired-reopened', fingerprint: 'retired' }, async () => ({})), { code: 'maintenance' });
      const service = agent(restoredStorage);
      if (imported) {
        await checkImportedSkill(restoredStorage, user, imported);
        assert.deepEqual(await service.skills.import(user, oldInput), imported, 'An accepted Skills request keeps its original receipt.');
      } else assert.ok((await service.skills.import(user, skillInput())).skillId);
      await restoredStorage.request({ requestId: 'successor-write', fingerprint: 'new-authority' }, async () => ({ active: true }));
      assert.equal(await reopened.receipt('successor-write'), null, 'The retired database receives no successor writes.');
    } finally { await Promise.all(handles.map(storage => storage.close())); await source.close(); await target.close(); }
  });
}

test('unrecognized v11 checksum or name cannot acquire the published compaction identity', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(), admin = new pg.Client(fixture.admin); let storage;
  await admin.connect();
  try {
    const migrations = legacy('compaction'), owner = { environmentId: randomUUID(), serviceId: randomUUID() }, password = randomUUID();
    const binding = await provisionStorage({ admin: fixture.admin, owner, password, migrations });
    const backend = createFileBackend({ id: 'files', root: join(fixture.root, 'objects') });
    storage = await openStorage({ binding, backend, migrations }); await closeGates(storage);
    const before = await journal(storage);
    const almost = before.at(-1).checksum.slice(0, -1) + (before.at(-1).checksum.endsWith('0') ? '1' : '0');
    for (const mutation of ["checksum=repeat('0',64)", `checksum='${almost}'`, "name='unpublished-compaction'", 'version=12']) {
      // Administrator-side corruption is fault injection only; acceptance always goes through public provisioning.
      await admin.query(`UPDATE ${binding.schema}._storage_migrations SET ${mutation} WHERE version=11`);
      const changed = (await admin.query(`SELECT * FROM ${binding.schema}._storage_migrations ORDER BY version`)).rows;
      await assert.rejects(provisionStorage({ admin: fixture.admin, owner, password, migrations: teachingAgentMigrations }), { code: 'incompatible' });
      assert.deepEqual((await admin.query(`SELECT * FROM ${binding.schema}._storage_migrations ORDER BY version`)).rows, changed);
      await admin.query(`UPDATE ${binding.schema}._storage_migrations SET version=11,name=$1,checksum=$2 WHERE version>=11`,
        [before.at(-1).name, before.at(-1).checksum]);
    }
    assert.deepEqual(await journal(storage), before);
  } finally { await storage?.close(); await admin.end(); await fixture.close(); }
});
