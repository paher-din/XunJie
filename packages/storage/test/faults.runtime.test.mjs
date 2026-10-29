import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { provisionStorage, openStorage, createFileBackend } from '@xunjie/storage';
import { nativeFixture } from './native-fixture.mjs';

const migrations = [{ version: 1, name: 'fault-records', sql: 'CREATE TABLE records(id text PRIMARY KEY,version integer,body jsonb)' }];
const input = () => ({ owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations });

// A real PostgreSQL wire relay cuts/delays a COMMIT acknowledgement only after
// the server emitted CommandComplete. No transaction return values are mocked.
async function commitRelay(port, mode) {
  const sockets = new Set();
  let armed = false;
  const server = createServer(downstream => {
    const upstream = connect(port, '127.0.0.1');
    let pending = Buffer.alloc(0);
    for (const socket of [downstream, upstream]) {
      sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    }
    downstream.on('data', chunk => {
      upstream.write(chunk);
    });
    upstream.on('data', chunk => {
      pending = Buffer.concat([pending,chunk]);
      while (pending.length >= 5) {
        const length = pending.readInt32BE(1) + 1;
        if (pending.length < length) break;
        const message = pending.subarray(0,length); pending = pending.subarray(length);
        if (armed && message[0] === 67 && message.subarray(5).toString().startsWith('COMMIT')) {
          armed = false;
          if (mode === 'disconnect') { downstream.destroy(); upstream.destroy(); }
          // Holding the actual acknowledgement makes the client's query bound expire.
          else upstream.pause();
          return;
        }
        downstream.write(message);
      }
    });
    downstream.once('close', () => upstream.destroy()); upstream.once('close', () => downstream.destroy());
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { port: server.address().port, arm() { armed = true; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)); } };
}

test('real lost/timed-out COMMIT acknowledgements resolve by original identity without replay', { timeout: 60_000 }, async () => {
  const fixture = await nativeFixture();
  try {
    for (const mode of ['disconnect', 'timeout']) {
      const binding = await provisionStorage({ admin: fixture.admin, ...input() });
      const backend = createFileBackend({ id: 'files', root: join(fixture.root,'objects') });
      const relay = await commitRelay(fixture.admin.port, mode);
      const storage = await openStorage({ binding: { ...binding, connection: { ...binding.connection, port: relay.port } }, migrations, backend, queryTimeoutMs: 200 });
      const observer = await openStorage({ binding, migrations, backend });
      try {
        const requestId = `unknown-${mode}`;
        await assert.rejects(storage.request({ requestId, fingerprint: mode }, async tx => {
          await tx.query("INSERT INTO records VALUES ($1,1,'{}')", [mode]);
          await tx.enqueue(`intent-${mode}`, { saved: mode });
          relay.arm(); return { saved: mode };
        }), { code: 'commit-unknown', requestId });
        assert.deepEqual((await observer.receipt(requestId)).result, { saved: mode });
        assert.deepEqual((await observer.request({ requestId, fingerprint: mode }, async () => { throw new Error('must never replay'); })).result, { saved: mode });
        assert.equal((await observer.pendingIntents()).length, 1);
      } finally { await storage.close(); await observer.close(); await relay.close(); }
    }
  } finally { await fixture.close(); }
});

test('killing a real transaction process discards state, receipt and outbox together', { timeout: 60_000 }, async () => {
  const fixture = await nativeFixture();
  let storage, child;
  try {
    const binding = await provisionStorage({ admin: fixture.admin, ...input() });
    const backend = { id: 'files', root: join(fixture.root,'objects') };
    const path = join(fixture.root,'child-config.json');
    await writeFile(path, JSON.stringify({ binding,migrations,backend,requestId:'killed-request' }), { mode: 0o600 });
    child = fork(new URL('./transaction-child.mjs', import.meta.url), [path], { stdio: ['ignore','ignore','pipe','ipc'] });
    const [message] = await once(child,'message'); assert.equal(message.phase,'uncommitted');
    child.kill('SIGKILL'); await once(child,'exit'); child = undefined;
    storage = await openStorage({ binding,migrations,backend: createFileBackend(backend) });
    assert.equal(await storage.receipt('killed-request'),null);
    assert.equal((await storage.read('SELECT * FROM records')).rowCount,0);
    assert.deepEqual(await storage.pendingIntents(),[]);
  } finally { child?.kill('SIGKILL'); await storage?.close(); await fixture.close(); }
});

test('owner migrations are serialized, immutable, and upgrades require the same closed maintenance path', { timeout: 60_000 }, async () => {
  const fixture = await nativeFixture();
  const admin = new pg.Client(fixture.admin); await admin.connect();
  const spec = input();
  const blocked = [{ version: 1,name:'blocked',sql:'SELECT pg_advisory_xact_lock(144144); CREATE TABLE records(id text PRIMARY KEY,version integer,body jsonb)' }];
  let old, duringMaintenance, upgraded;
  try {
    await admin.query('SELECT pg_advisory_lock(144144)');
    const running = provisionStorage({ admin:fixture.admin,...spec,migrations:blocked });
    try {
      for (let i=0;i<100;i++) {
        const { rows }=await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name='xunjie-storage-migration' AND wait_event='advisory'");
        if(rows.length) break;
        if(i===99) throw new Error('Migration did not reach its real SQL barrier');
        await delay(10);
      }
      await assert.rejects(provisionStorage({admin:fixture.admin,...spec,migrations:blocked}),{code:'migration-busy'});
    } finally { await admin.query('SELECT pg_advisory_unlock(144144)'); }
    const binding=await running;
    const backend=createFileBackend({id:'files',root:join(fixture.root,'objects')});
    old=await openStorage({binding,migrations:blocked,backend});
    await assert.rejects(provisionStorage({admin:fixture.admin,...spec,migrations:[{...blocked[0],sql:blocked[0].sql+'; SELECT 2'}]}),{code:'incompatible'});
    const next=[...blocked,{version:2,name:'add-title',sql:"ALTER TABLE records ADD COLUMN title text NOT NULL DEFAULT 'upgraded'"}];
    await assert.rejects(provisionStorage({admin:fixture.admin,...spec,migrations:next}),{code:'maintenance'});
    await old.participant().closeWrites(); await old.participant().closeDispatch();
    duringMaintenance=await openStorage({binding,migrations:blocked,backend});
    await provisionStorage({admin:fixture.admin,...spec,migrations:next});
    await assert.rejects(openStorage({binding,migrations:blocked,backend}),{code:'incompatible'});
    upgraded=await openStorage({binding,migrations:next,backend});
    await upgraded.participant().resume();
    await upgraded.request({requestId:'after-upgrade',fingerprint:'v2'},async tx=>{
      await tx.query("INSERT INTO records(id,version,body) VALUES('one',1,'{}')");return {};
    });
    assert.deepEqual((await upgraded.read('SELECT title FROM records')).rows,[{title:'upgraded'}]);
    await assert.rejects(old.request({requestId:'old-binary',fingerprint:'v1'},async()=>({})),{code:'stale-generation'});
    await assert.rejects(duringMaintenance.request({requestId:'old-schema-new-session',fingerprint:'v1'},async()=>({})),{code:'stale-generation'});
    await admin.query("ALTER DATABASE postgres SET timezone='Asia/Shanghai'");
    await assert.rejects(provisionStorage({admin:fixture.admin,...input()}),{code:'incompatible'});
    await admin.query("ALTER DATABASE postgres SET timezone='UTC'");
    await admin.query("CREATE DATABASE incompatible_encoding TEMPLATE template0 ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C'");
    await assert.rejects(provisionStorage({admin:{...fixture.admin,database:'incompatible_encoding'},...input()}),{code:'incompatible'});
  } finally { await admin.end(); await old?.close(); await duringMaintenance?.close(); await upgraded?.close(); await fixture.close(); }
});
