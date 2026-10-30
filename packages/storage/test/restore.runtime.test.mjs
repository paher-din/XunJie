import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import pg from 'pg';
import * as storage from '@xunjie/storage';
import { nativeFixture } from './native-fixture.mjs';

const migrations = [{ version: 1, name: 'restore-records', sql: `
  CREATE TABLE records(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL UNIQUE);
` }];
const spec = () => ({ owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID() });
const exec = promisify(execFile);
async function pgTool(fixture, name, args, connection = fixture.admin) {
  try {
    return await exec(fixture.tool(name), ['-h', connection.host, '-p', String(connection.port), '-U', connection.user, '-d', connection.database, ...args],
      { env: { ...process.env, PGPASSWORD: connection.password }, timeout: 30_000 });
  } catch { throw new Error(`${name} failed`); }
}

test('a confirmed upload can still be published by its original identity after independent recovery', async () => {
  const source = await nativeFixture(), target = await nativeFixture();
  let original, restored;
  try {
    const input = spec();
    const binding = await storage.provisionStorage({ admin: source.admin, ...input, migrations });
    const backend = storage.createFileBackend({ id: 'files', root: source.root + '/objects' });
    const targetBackend = storage.createFileBackend({ id: 'files', root: target.root + '/objects' });
    original = await storage.openStorage({ binding, migrations, backend });
    const bytes = Buffer.from('confirmed bytes before domain reference');
    const uploaded = await original.stageResource({ uploadId: randomUUID(), scope: 'pending-publication',
      bytes, mediaType: 'text/plain', contentVersion: 1 });
    await original.participant().closeWrites(); await original.participant().closeDispatch();
    const dump = source.root + '/schema.dump'; let manifest;
    await original.snapshot('before-publication', async snapshot => {
      manifest = snapshot.manifest;
      await pgTool(source, 'pg_dump', ['-Fc', '-n', binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
      for (const item of manifest.resources) await targetBackend.put(item.locator.key, await original.readResourceObject(item.resourceId));
    });
    const destination = await storage.prepareStorageRestore({ admin: target.admin, ...input });
    await pgTool(target, 'pg_restore', ['--exit-on-error', '--role', destination.migratorRole, '--no-owner', '--no-acl', dump]);
    restored = await storage.finalizeStorageRestore({ admin: target.admin, binding: destination, migrations, manifest, backend: targetBackend });
    assert.deepEqual(Buffer.from(await restored.readResource(uploaded.resourceId)), bytes);
    await restored.participant().resume();
    const receipt = await restored.request({ requestId: 'original-publish', fingerprint: 'publish' }, async tx => {
      const reference = await tx.reference('original-reference', uploaded.resourceId);
      return { resourceId: reference.resourceId };
    });
    assert.deepEqual(receipt.result, { resourceId: uploaded.resourceId });
    assert.deepEqual(Buffer.from(await restored.readResource(uploaded.resourceId)), bytes);
  } finally { await original?.close(); await restored?.close(); await source.close(); await target.close(); }
});

test('old maintenance peers cannot close, drain or reopen a newer persistent generation', async () => {
  const fixture = await nativeFixture();
  const handles = [];
  try {
    const binding = await storage.provisionStorage({ admin: fixture.admin, ...spec(), migrations });
    const backend = storage.createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    const leader = await storage.openStorage({ binding, backend, migrations }); handles.push(leader);
    const stale = await storage.openStorage({ binding, backend, migrations }); handles.push(stale);
    await Promise.all([leader.participant().closeWrites(), leader.participant().closeDispatch()]);
    for (const operation of ['closeWrites', 'closeDispatch', 'drain', 'validate', 'resume']) {
      await assert.rejects(stale.participant()[operation](), { code: 'stale-generation' });
    }
    const closed = await storage.openStorage({ binding, backend, migrations }); handles.push(closed);
    await assert.rejects(closed.request({ requestId: 'still-closed', fingerprint: 'closed' }, async () => ({})), { code: 'maintenance' });
    await leader.participant().resume();
    await assert.rejects(closed.participant().resume(), { code: 'stale-generation' });
    await leader.request({ requestId: 'live', fingerprint: 'live' }, async tx => {
      await tx.query("INSERT INTO records(body) VALUES ('one')"); return {};
    });
    await assert.rejects(stale.participant().closeWrites(), { code: 'stale-generation' });
    assert.deepEqual((await leader.read('SELECT body FROM records')).rows, [{ body: 'one' }]);
  } finally { await Promise.all(handles.map(handle => handle.close())); await fixture.close(); }
});

test('finalization rejects a missing domain constraint and keeps the target fenced for diagnosis and retry', async () => {
  const source = await nativeFixture(), target = await nativeFixture();
  let original, restored;
  const admin = new pg.Client(target.admin); await admin.connect();
  try {
    const input = spec();
    const binding = await storage.provisionStorage({ admin: source.admin, ...input, migrations });
    const backend = storage.createFileBackend({ id: 'files', root: source.root + '/objects' });
    original = await storage.openStorage({ binding, migrations, backend });
    await original.participant().closeWrites(); await original.participant().closeDispatch();
    const dump = source.root + '/schema.dump'; let manifest;
    await original.snapshot('damaged', async snapshot => {
      manifest = snapshot.manifest;
      await pgTool(source, 'pg_dump', ['-Fc', '-n', binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
    });
    const destination = await storage.prepareStorageRestore({ admin: target.admin, ...input });
    await pgTool(target, 'pg_restore', ['--exit-on-error', '--role', destination.migratorRole, '--no-owner', '--no-acl', dump]);
    // Administrator-side damage is the fault injection, assertions use public interfaces.
    await admin.query(`ALTER TABLE ${destination.schema}.records DROP CONSTRAINT records_body_key`);
    const finalize = () => storage.finalizeStorageRestore({ admin: target.admin, binding: destination, migrations, manifest, backend });
    await assert.rejects(finalize(), { code: 'incompatible' });
    await assert.rejects(storage.openStorage({ binding: destination, migrations, backend }), { code: 'maintenance' });
    await admin.query(`ALTER TABLE ${destination.schema}.records ADD CONSTRAINT records_body_key UNIQUE(body)`);
    restored = await finalize();
    await restored.participant().resume();
    await restored.request({ requestId: 'repaired', fingerprint: 'repaired' }, async tx => {
      await tx.query("INSERT INTO records(body) VALUES ('repaired')"); return {};
    });
    assert.equal((await restored.read('SELECT * FROM records')).rowCount, 1);
  } finally { await admin.end(); await original?.close(); await restored?.close(); await source.close(); await target.close(); }
});

test('a complete native schema dump restores receipts, resources, constraints and sequence state behind closed gates', async () => {
  const source = await nativeFixture(), target = await nativeFixture();
  let original, restored;
  try {
    const input = spec();
    const binding = await storage.provisionStorage({ admin: source.admin, ...input, migrations });
    const backend = storage.createFileBackend({ id: 'files', root: source.root + '/objects' });
    const targetBackend = storage.createFileBackend({ id: 'files', root: target.root + '/objects' });
    original = await storage.openStorage({ binding, migrations, backend });
    const resource = await original.stageResource({ uploadId: randomUUID(), scope: 'test', bytes: Buffer.from('原字节\0'), mediaType: 'text/plain', contentVersion: 1 });
    const receipt = await original.request({ requestId: 'before', fingerprint: 'stable' }, async tx => {
      await tx.query("INSERT INTO records(body) VALUES ('saved')");
      await tx.reference('record', resource.resourceId); await tx.enqueue('send-once', { original: true }); return { saved: true };
    });
    await original.participant().closeWrites(); await original.participant().closeDispatch();
    let manifest;
    const dump = source.root + '/schema.dump';
    await original.snapshot('backup', async snapshot => {
      assert.equal(snapshot.migratorRole, binding.migratorRole);
      manifest = snapshot.manifest;
      await pgTool(source, 'pg_dump', ['--format=custom', '--schema', binding.schema, '--snapshot', snapshot.databaseSnapshot, '--file', dump], binding.connection);
      await targetBackend.put(resource.locator.key, await original.readResourceObject(resource.resourceId));
    });
    const destination = await storage.prepareStorageRestore({ admin: target.admin, ...input });
    assert.equal(typeof destination.migratorRole, 'string');
    await assert.rejects(storage.prepareStorageRestore({ admin: target.admin, ...input }), { code: 'conflict' });
    await pgTool(target, 'pg_restore', ['--exit-on-error', '--role', destination.migratorRole, '--no-owner', '--no-acl', dump]);
    restored = await storage.finalizeStorageRestore({ admin: target.admin, binding: destination, migrations, manifest, backend: targetBackend });
    assert.ok(BigInt(restored.generation) > BigInt(manifest.generation));
    assert.deepEqual(await restored.receipt('before'), receipt);
    assert.deepEqual(Buffer.from(await restored.readResource(resource.resourceId)), Buffer.from('原字节\0'));
    assert.deepEqual((await restored.read('SELECT id,body FROM records')).rows, [{ id: '1', body: 'saved' }]);
    await assert.rejects(restored.request({ requestId: 'disabled', fingerprint: 'disabled' }, async () => ({})), { code: 'maintenance' });
    await assert.rejects(restored.pendingIntents(), { code: 'maintenance' });
    await assert.rejects(storage.finalizeStorageRestore({ admin: target.admin, binding: destination, migrations, manifest, backend: targetBackend }), { code: 'conflict' });
    await restored.participant().resume();
    assert.deepEqual(await restored.pendingIntents(), [{ intentId: 'send-once', payload: { original: true } }]);
    await restored.request({ requestId: 'next', fingerprint: 'next' }, async tx => {
      assert.deepEqual((await tx.query("INSERT INTO records(body) VALUES ('next') RETURNING id")).rows, [{ id: '2' }]); return {};
    });
    await assert.rejects(restored.request({ requestId: 'duplicate', fingerprint: 'duplicate' }, async tx => {
      await tx.query("INSERT INTO records(body) VALUES ('saved')"); return {};
    }), { code: 'conflict' });
    assert.equal(await restored.receipt('duplicate'), null);
    assert.equal(await restored.receipt('disabled'), null);
    assert.deepEqual((await restored.read(`SELECT has_database_privilege($1,current_database(),'CREATE') AS ddl,
      has_schema_privilege(current_user,current_schema(),'CREATE') AS owner_ddl`, [destination.migratorRole])).rows, [{ ddl: false, owner_ddl: false }]);
    // Restoring and enabling the target never opens the source.
    await assert.rejects(original.request({ requestId: 'source-disabled', fingerprint: 'disabled' }, async () => ({})), { code: 'maintenance' });
  } finally { await original?.close(); await restored?.close(); await source.close(); await target.close(); }
});

test('missing referenced bytes and a rewound sequence fail closed; repairing them retains the original identities', async () => {
  const source = await nativeFixture(), target = await nativeFixture();
  let original, restored;
  const admin = new pg.Client(target.admin); await admin.connect();
  try {
    const input = spec();
    const binding = await storage.provisionStorage({ admin: source.admin, ...input, migrations });
    const backend = storage.createFileBackend({ id: 'files', root: source.root + '/objects' });
    const targetBackend = storage.createFileBackend({ id: 'files', root: target.root + '/objects' });
    original = await storage.openStorage({ binding, migrations, backend });
    const resource = await original.stageResource({ uploadId: randomUUID(), scope: 'test', bytes: Buffer.from('retained'), mediaType: 'text/plain', contentVersion: 1 });
    await original.request({ requestId: 'retained', fingerprint: 'retained' }, async tx => {
      await tx.query("INSERT INTO records(body) VALUES ('retained')"); await tx.reference('record', resource.resourceId); return { retained: true };
    });
    await original.participant().closeWrites(); await original.participant().closeDispatch();
    const dump = source.root + '/schema.dump'; let manifest;
    await original.snapshot('resources', async snapshot => {
      manifest = snapshot.manifest;
      await pgTool(source, 'pg_dump', ['-Fc', '-n', binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
    });
    const destination = await storage.prepareStorageRestore({ admin: target.admin, ...input });
    await pgTool(target, 'pg_restore', ['--exit-on-error', '--role', destination.migratorRole, '--no-owner', '--no-acl', dump]);
    const finalize = () => storage.finalizeStorageRestore({ admin: target.admin, binding: destination, migrations, manifest, backend: targetBackend });
    await assert.rejects(finalize(), { code: 'missing' });
    await assert.rejects(storage.openStorage({ binding: destination, migrations, backend: targetBackend }), { code: 'maintenance' });
    await targetBackend.put(resource.locator.key, await original.readResourceObject(resource.resourceId));
    await admin.query('SELECT setval($1,1,false)', [`${destination.schema}.records_id_seq`]);
    await assert.rejects(finalize(), { code: 'corrupt' });
    await admin.query('SELECT setval($1,1,true)', [`${destination.schema}.records_id_seq`]);
    restored = await finalize();
    assert.equal(restored.generation, String(BigInt(manifest.generation) + 1n));
    assert.deepEqual((await restored.receipt('retained')).result, { retained: true });
    assert.deepEqual(Buffer.from(await original.readResource(resource.resourceId)), Buffer.from('retained'));
    await restored.participant().resume();
    await restored.request({ requestId: 'after-repair', fingerprint: 'repair' }, async tx => {
      assert.equal((await tx.query("INSERT INTO records(body) VALUES ('after') RETURNING id")).rows[0].id, '2'); return {};
    });
  } finally { await admin.end(); await original?.close(); await restored?.close(); await source.close(); await target.close(); }
});

test('a manifest from another backup generation cannot finalize or enable the restored owner', async () => {
  const source = await nativeFixture(), target = await nativeFixture();
  let original, restored;
  try {
    const input = spec();
    const binding = await storage.provisionStorage({ admin: source.admin, ...input, migrations });
    const backend = storage.createFileBackend({ id: 'files', root: source.root + '/objects' });
    original = await storage.openStorage({ binding, migrations, backend });
    await original.participant().closeWrites(); await original.participant().closeDispatch();
    const dump = source.root + '/schema.dump'; let manifest;
    await original.snapshot('original-backup', async snapshot => {
      manifest = snapshot.manifest;
      await pgTool(source, 'pg_dump', ['-Fc', '-n', binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
    });
    const destination = await storage.prepareStorageRestore({ admin: target.admin, ...input });
    await pgTool(target, 'pg_restore', ['--exit-on-error', '--role', destination.migratorRole, '--no-owner', '--no-acl', dump]);
    await assert.rejects(storage.finalizeStorageRestore({ admin: target.admin, binding: destination, migrations,
      manifest: { ...manifest, generation: '999' }, backend }), { code: 'incompatible' });
    await assert.rejects(storage.openStorage({ binding: destination, migrations, backend }), { code: 'maintenance' });
    restored = await storage.finalizeStorageRestore({ admin: target.admin, binding: destination, migrations, manifest, backend });
    assert.equal(restored.generation, String(BigInt(manifest.generation) + 1n));
  } finally { await original?.close(); await restored?.close(); await source.close(); await target.close(); }
});

test('restored constraint definitions alone do not accept rows that violate a foreign key', async () => {
  const source = await nativeFixture(), target = await nativeFixture();
  let original, restored;
  const admin = new pg.Client(target.admin); await admin.connect();
  const domainMigrations = [...migrations, { version: 2, name: 'children', sql: 'CREATE TABLE children(id integer PRIMARY KEY, parent bigint NOT NULL REFERENCES records(id))' }];
  try {
    const input = spec();
    const binding = await storage.provisionStorage({ admin: source.admin, ...input, migrations: domainMigrations });
    const backend = storage.createFileBackend({ id: 'files', root: source.root + '/objects' });
    original = await storage.openStorage({ binding, migrations: domainMigrations, backend });
    await original.request({ requestId: 'parent', fingerprint: 'parent' }, async tx => {
      await tx.query("INSERT INTO records(body) VALUES ('parent')");
      await tx.query('INSERT INTO children VALUES (1,1)'); return {};
    });
    await original.participant().closeWrites(); await original.participant().closeDispatch();
    const dump = source.root + '/schema.dump'; let manifest;
    await original.snapshot('constraints', async snapshot => {
      manifest = snapshot.manifest;
      await pgTool(source, 'pg_dump', ['-Fc', '-n', binding.schema, '--snapshot', snapshot.databaseSnapshot, '-f', dump]);
    });
    const destination = await storage.prepareStorageRestore({ admin: target.admin, ...input });
    await pgTool(target, 'pg_restore', ['--exit-on-error', '--role', destination.migratorRole, '--no-owner', '--no-acl', dump]);
    await admin.query(`ALTER TABLE ${destination.schema}.children DISABLE TRIGGER ALL`);
    await admin.query(`UPDATE ${destination.schema}.children SET parent=99`);
    await admin.query(`ALTER TABLE ${destination.schema}.children ENABLE TRIGGER ALL`);
    const finalize = () => storage.finalizeStorageRestore({ admin: target.admin, binding: destination, migrations: domainMigrations, manifest, backend });
    await assert.rejects(finalize(), { code: 'corrupt' });
    await assert.rejects(storage.openStorage({ binding: destination, migrations: domainMigrations, backend }), { code: 'maintenance' });
    await admin.query(`UPDATE ${destination.schema}.children SET parent=1`);
    restored = await finalize();
    assert.deepEqual((await restored.read('SELECT parent FROM children')).rows, [{ parent: '1' }]);
  } finally { await admin.end(); await original?.close(); await restored?.close(); await source.close(); await target.close(); }
});

test('prepare refuses foreign schemas and roles; finalization refuses an unreserved binding and a replaced schema owner', async () => {
  const source = await nativeFixture(), target = await nativeFixture();
  const admin = new pg.Client(target.admin); await admin.connect();
  let sourceStorage;
  try {
    const input = spec();
    const binding = await storage.provisionStorage({ admin: source.admin, ...input, migrations });
    const backend = storage.createFileBackend({ id: 'files', root: source.root + '/objects' });
    sourceStorage = await storage.openStorage({ binding, migrations, backend });
    await sourceStorage.participant().closeWrites(); await sourceStorage.participant().closeDispatch();
    const manifest = await sourceStorage.snapshot('foreign', async snapshot => snapshot.manifest);
    const unreserved = { ...binding, connection: { ...target.admin, user: binding.connection.user, password: input.password } };
    await assert.rejects(storage.finalizeStorageRestore({ admin: target.admin, binding: unreserved, migrations, manifest, backend }), { code: 'forbidden' });
    await admin.query(`CREATE SCHEMA ${binding.schema}`);
    await assert.rejects(storage.prepareStorageRestore({ admin: target.admin, ...input }), { code: 'conflict' });
    await admin.query(`DROP SCHEMA ${binding.schema}`);
    await admin.query(`CREATE ROLE ${binding.migratorRole} NOLOGIN`);
    await assert.rejects(storage.prepareStorageRestore({ admin: target.admin, ...input }), { code: 'conflict' });
    await admin.query(`DROP ROLE ${binding.migratorRole}`);
    const destination = await storage.prepareStorageRestore({ admin: target.admin, ...input });
    await admin.query(`CREATE SCHEMA ${destination.schema}`);
    await assert.rejects(storage.finalizeStorageRestore({ admin: target.admin, binding: destination, migrations, manifest, backend }), { code: 'incompatible' });
    // It did not adopt or initialize the foreign schema; even the admin cannot
    // read a fabricated storage identity through a normal open.
    await assert.rejects(storage.openStorage({ binding: destination, migrations, backend }), { code: 'maintenance' });
  } finally { await admin.end(); await sourceStorage?.close(); await source.close(); await target.close(); }
});
