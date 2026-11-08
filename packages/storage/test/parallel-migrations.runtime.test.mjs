import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { nativeFixture } from './native-fixture.mjs';

const base = { version: 1, name: 'common-records', sql: 'CREATE TABLE records(id text PRIMARY KEY);' };
const parallel = { version: 2, name: 'published-parallel-feature', sql: 'CREATE TABLE feature_b(id text PRIMARY KEY);' };
const addition = { version: 2, name: 'other-parallel-feature', sql: 'CREATE TABLE feature_a(id text PRIMARY KEY);' };
const canonical = [base, addition, { ...parallel, version: 3, formerVersion: 2 }];
const checksum = item => createHash('sha256').update(`${item.version}\n${item.name}\n${item.sql}`).digest('hex');
const journal = async storage => (await storage.read('SELECT version,name,checksum,applied_at::text FROM _storage_migrations ORDER BY version')).rows;
async function closeGates(storage) { await storage.participant().closeWrites(); await storage.participant().closeDispatch(); }

test('a displaced published tail moves atomically without replaying its SQL or rewriting the prefix', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(), handles = [];
  try {
    const options = { admin: fixture.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID() };
    const migrations = [base, parallel], binding = await provisionStorage({ ...options, migrations });
    const backend = createFileBackend({ id: 'files', root: join(fixture.root, 'objects') });
    const old = await openStorage({ binding, backend, migrations }); handles.push(old);
    await old.request({ requestId: 'published', fingerprint: 'original' }, async tx => {
      await tx.query("INSERT INTO feature_b VALUES('published-before-integration')"); return { kept: true };
    });
    const before = await journal(old);
    await assert.rejects(provisionStorage({ ...options, migrations: canonical }), { code: 'maintenance' });
    await assert.rejects(openStorage({ binding, backend, migrations: canonical }), { code: 'incompatible' });
    assert.deepEqual(await journal(old), before);
    await closeGates(old);
    const closedPeer = await openStorage({ binding, backend, migrations }); handles.push(closedPeer);
    await provisionStorage({ ...options, migrations: canonical });
    const current = await openStorage({ binding, backend, migrations: canonical }); handles.push(current);
    const after = await journal(current);
    assert.deepEqual(after[0], before[0]);
    assert.deepEqual(after[2], { ...before[1], version: 3, checksum: checksum(canonical[2]) });
    assert.deepEqual((await current.read('SELECT * FROM feature_b')).rows, [{ id: 'published-before-integration' }]);
    assert.deepEqual((await current.read('SELECT * FROM feature_a')).rows, []);
    assert.deepEqual(await current.receipt('published'), await old.receipt('published'));
    assert.equal(BigInt(current.generation), BigInt(closedPeer.generation) + 1n);
    await assert.rejects(closedPeer.participant().resume(), { code: 'stale-generation' });
    await assert.rejects(current.request({ requestId: 'closed', fingerprint: 'closed' }, async () => ({})), { code: 'maintenance' });
    await assert.rejects(openStorage({ binding, backend, migrations }), { code: 'incompatible' });
    await provisionStorage({ ...options, migrations: canonical });
    assert.deepEqual(await journal(current), after);
  } finally { await Promise.all(handles.map(handle => handle.close())); await fixture.close(); }
});

test('failure while applying the missing migration rolls back the relocation, DDL and generation', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(); let old;
  try {
    const options = { admin: fixture.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID() };
    const migrations = [base, parallel], binding = await provisionStorage({ ...options, migrations });
    const backend = createFileBackend({ id: 'files', root: join(fixture.root, 'objects') });
    old = await openStorage({ binding, backend, migrations }); await closeGates(old);
    const before = await journal(old), generation = (await old.read('SELECT generation FROM _storage_identity')).rows;
    const failing = [base, { ...addition, sql: addition.sql + " INSERT INTO feature_a VALUES('duplicate'),('duplicate');" }, canonical[2]];
    await assert.rejects(provisionStorage({ ...options, migrations: failing }), { code: 'conflict' });
    assert.deepEqual(await journal(old), before);
    assert.deepEqual((await old.read('SELECT generation FROM _storage_identity')).rows, generation);
    assert.equal((await old.read("SELECT to_regclass('feature_a') AS relation")).rows[0].relation, null);
    const reopened = await openStorage({ binding, backend, migrations }); await reopened.close();
    await provisionStorage({ ...options, migrations: canonical });
  } finally { await old?.close(); await fixture.close(); }
});

test('relocation refuses edited SQL, prefix damage, mixed histories and ambiguous former-version registrations', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture(), admin = new pg.Client(fixture.admin); let old;
  await admin.connect();
  try {
    const options = { admin: fixture.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID() };
    const migrations = [base, parallel], binding = await provisionStorage({ ...options, migrations });
    const backend = createFileBackend({ id: 'files', root: join(fixture.root, 'objects') });
    old = await openStorage({ binding, backend, migrations }); await closeGates(old);
    const before = await journal(old);
    for (const candidate of [
      [base, addition, { ...canonical[2], sql: parallel.sql + ' -- edited' }],
      [base, addition, { ...canonical[2], name: parallel.name + '-edited' }],
      [base, addition, { ...canonical[2], formerVersion: 0 }],
      [base, addition, { ...canonical[2], formerVersion: 3 }],
      [base, addition, { ...canonical[2], formerVersion: 1.5 }],
      [...canonical, { version: 4, name: 'ambiguous', sql: 'SELECT 1;', formerVersion: 2 }],
    ]) await assert.rejects(provisionStorage({ ...options, migrations: candidate }), { code: 'incompatible' });
    await admin.query(`UPDATE ${binding.schema}._storage_migrations SET checksum=$1 WHERE version=1`, ['0'.repeat(64)]);
    await assert.rejects(provisionStorage({ ...options, migrations: canonical }), { code: 'incompatible' });
    await admin.query(`UPDATE ${binding.schema}._storage_migrations SET checksum=$1 WHERE version=1`, [before[0].checksum]);
    await admin.query(`INSERT INTO ${binding.schema}._storage_migrations(version,name,checksum) VALUES(3,$1,$2)`,
      [addition.name, checksum({ ...addition, version: 3 })]);
    await assert.rejects(provisionStorage({ ...options, migrations: canonical }), { code: 'incompatible' });
    await admin.query(`DELETE FROM ${binding.schema}._storage_migrations WHERE version=3`);
    assert.deepEqual(await journal(old), before);
  } finally { await old?.close(); await admin.end(); await fixture.close(); }
});
