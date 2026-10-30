import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from './native-fixture.mjs';

export const migrations = [{ version: 1, name: 'owned-records', sql: `
  CREATE TABLE records (id text PRIMARY KEY, version integer NOT NULL, body jsonb NOT NULL);
  CREATE TABLE totals (id text PRIMARY KEY, amount integer NOT NULL);
  INSERT INTO totals VALUES ('total',0);
` }];

test('two real sessions atomically receive one stable request and preserve its receipt after reopening', { timeout: 60_000 }, async () => {
  const fixture = await nativeFixture();
  let a; let b;
  try {
    const binding = await provisionStorage({ admin: fixture.admin,
      owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations });
    const backend = createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    a = await openStorage({ binding, migrations, backend });
    b = await openStorage({ binding, migrations, backend });
    const effect = async tx => {
      await tx.query("INSERT INTO records VALUES ('a',1,$1)", [{ saved: true }]);
      await tx.query("UPDATE totals SET amount=amount+1 WHERE id='total'");
      await tx.enqueue('send-a', { accepted: true });
      return { saved: 'a' };
    };
    const input = { requestId: 'request-a', fingerprint: 'save-a-v1' };
    const receipts = await Promise.all([a.request(input, effect), b.request(input, effect)]);
    assert.deepEqual(receipts[0], receipts[1]);
    assert.deepEqual((await a.read('SELECT amount FROM totals')).rows, [{ amount: 1 }]);
    assert.deepEqual(await b.pendingIntents(), [{ intentId: 'send-a', payload: { accepted: true } }]);
    await a.close(); a = await openStorage({ binding, migrations, backend });
    assert.deepEqual(await a.receipt(input.requestId), receipts[0]);
    await assert.rejects(a.request({ ...input, fingerprint: 'different' }, effect), { code: 'identity-conflict' });
  } finally {
    await a?.close(); await b?.close(); await fixture.close();
  }
});

test('conditional updates, uniqueness and cross-row effects either commit together or leave no receipt', { timeout: 60_000 }, async () => {
  const fixture = await nativeFixture();
  let a; let b;
  try {
    const binding = await provisionStorage({ admin: fixture.admin,
      owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations });
    const backend = createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    a = await openStorage({ binding, migrations, backend }); b = await openStorage({ binding, migrations, backend });
    await a.request({ requestId: 'create', fingerprint: 'create' }, async tx => {
      await tx.query("INSERT INTO records VALUES ('a',1,'{}')"); return { version: 1 };
    });
    const update = (storage, requestId) => storage.request({ requestId, fingerprint: 'version-1' }, async tx => {
      const updated = await tx.query("UPDATE records SET version=2 WHERE id='a' AND version=1 RETURNING version");
      if (!updated.rowCount) throw new StorageError('conflict');
      await tx.query('UPDATE totals SET amount=amount+10');
      await tx.enqueue(requestId, { version: 2 }); return { version: 2 };
    });
    const outcomes = await Promise.allSettled([update(a, 'change-a'), update(b, 'change-b')]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'conflict');
    assert.deepEqual((await a.read('SELECT amount FROM totals')).rows, [{ amount: 10 }]);
    const loser = outcomes[0].status === 'rejected' ? 'change-a' : 'change-b';
    assert.equal(await a.receipt(loser), null);
    await assert.rejects(a.request({ requestId: 'unique-failure', fingerprint: 'unique' }, async tx => {
      await tx.query('UPDATE totals SET amount=999');
      await tx.enqueue('must-rollback', {});
      await tx.query("INSERT INTO records VALUES ('a',7,'{}')"); return {};
    }), { code: 'conflict' });
    assert.equal(await a.receipt('unique-failure'), null);
    assert.deepEqual((await a.read('SELECT amount FROM totals')).rows, [{ amount: 10 }]);
    assert.equal((await a.pendingIntents()).length, 1);
    await assert.rejects(a.request({ requestId: 'illegal-commit', fingerprint: 'commit' }, async tx => {
      await tx.query('COMMIT'); return {};
    }), { code: 'invalid' });
    assert.equal(await a.receipt('illegal-commit'), null);
    await assert.rejects(a.request({ requestId: 'multi-commit', fingerprint: 'commit' }, async tx => {
      await tx.query('SELECT 1; COMMIT'); return {};
    }));
    assert.equal(await a.receipt('multi-commit'), null);
  } finally { await a?.close(); await b?.close(); await fixture.close(); }
});

test('environment/service roles isolate identical identifiers and preserve actual PostgreSQL value semantics', { timeout: 60_000 }, async () => {
  const fixture = await nativeFixture();
  const stores = [];
  try {
    const env = randomUUID(), service = randomUUID();
    const owners = [{ environmentId: env, serviceId: service }, { environmentId: randomUUID(), serviceId: service }, { environmentId: env, serviceId: randomUUID() }];
    const bindings = [];
    for (const [index, owner] of owners.entries()) {
      const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations });
      bindings.push(binding);
      const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: 'files', root: fixture.root + '/objects' }) });
      stores.push(storage);
      await storage.request({ requestId: 'same-request', fingerprint: 'same-input' }, async tx => {
        await tx.query("INSERT INTO records VALUES ('same-record',1,$1)", [{ index }]); return { index };
      });
    }
    for (const [index, storage] of stores.entries()) assert.deepEqual((await storage.receipt('same-request')).result, { index });
    await assert.rejects(stores[0].request({ requestId: 'cross-owner', fingerprint: 'cross' }, async tx => {
      await tx.query(`DELETE FROM ${bindings[1].schema}.records`); return {};
    }), { code: 'forbidden' });
    await assert.rejects(stores[0].request({ requestId: 'cross-role', fingerprint: 'cross-role' }, async tx => {
      await tx.query('SELECT set_config(\'role\',$1,true)', [bindings[1].connection.user]); return {};
    }), { code: 'forbidden' });
    const values = await stores[0].read(`SELECT $1::uuid AS id, $2::bigint AS count, $3::numeric AS number,
      $4::timestamptz::text AS instant, $5::jsonb AS body, $6::bytea AS bytes`,
    [service, '9223372036854775807', '12345678901234567890.0123456789', '2026-10-29T01:02:03.123456Z', { text: '中文😀', nested: [null, true] }, Buffer.from([0,255,10,13])]);
    assert.deepEqual(values.rows[0], { id: service, count: '9223372036854775807', number: '12345678901234567890.0123456789',
      instant: '2026-10-29 01:02:03.123456+00', body: { text: '中文😀', nested: [null, true] }, bytes: Buffer.from([0,255,10,13]) });
  } finally { await Promise.all(stores.map(store => store.close())); await fixture.close(); }
});
