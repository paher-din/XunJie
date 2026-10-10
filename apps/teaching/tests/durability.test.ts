import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createSyntheticDatabase, openSyntheticDatabase } from '../server/db/transaction.ts';

test('committed rows survive forced process exit; busy writers and an interrupted transaction leave no partial rows', { timeout: 15000 }, async t => {
  let db = createSyntheticDatabase();
  const file = db.file;
  const start = async (mode: 'commit' | 'hold', id: string) => {
    const child = fork(fileURLToPath(new URL('./fixtures/storage-child.ts', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    let diagnostic = '';
    child.stderr!.on('data', (chunk: Buffer) => { diagnostic += chunk.toString(); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    const message = once(child, 'message');
    child.send({ file, mode, id });
    const received = await Promise.race([message, exited.then(() => [null])]);
    assert.deepEqual(received[0], { state: mode === 'commit' ? 'committed' : 'holding' }, diagnostic);
    return { child, exited };
  };
  try {
    const committed = await start('commit', 'confirmed');
    committed.child.kill('SIGKILL');
    await committed.exited;
    db.close(); db = openSyntheticDatabase(file);
    assert.deepEqual(db.withTransaction(tx => tx.get('SELECT id FROM courses WHERE id=?', 'confirmed')), { id: 'confirmed' });
    const held = await start('hold', 'interrupted');
    let invoked = false;
    assert.throws(() => db.withTransaction(tx => { invoked = true; tx.run('INSERT INTO courses(id) VALUES (?)', 'busy'); }), /locked/);
    assert.equal(invoked, false);
    held.child.kill('SIGKILL');
    await held.exited;
    db.close(); db = openSyntheticDatabase(file);
    assert.deepEqual(db.withTransaction(tx => tx.all('SELECT id FROM courses ORDER BY id')), [{ id: 'confirmed' }]);
    db.withTransaction(tx => tx.run('INSERT INTO courses(id) VALUES (?)', 'after-crash'));
  } finally { db.close(); }
});

test('competing CAS updates observe the committed value; a loser rolls back all preceding writes', () => {
  const first = createSyntheticDatabase();
  const second = openSyntheticDatabase(first.file);
  try {
    first.withTransaction(tx => tx.run('INSERT INTO login_attempt_windows(kind,bucket_hash,window_start_ms,attempt_count,failure_count) VALUES (?,?,?,1,0)', 'account', 'a'.repeat(64), 1000));
    assert.equal(first.withTransaction(tx => tx.run('UPDATE login_attempt_windows SET attempt_count=2 WHERE bucket_hash=? AND attempt_count=1', 'a'.repeat(64))).changes, 1);
    assert.throws(() => second.withTransaction(tx => {
      tx.run('INSERT INTO courses(id) VALUES (?)', 'loser');
      if (tx.run('UPDATE login_attempt_windows SET attempt_count=3 WHERE bucket_hash=? AND attempt_count=1', 'a'.repeat(64)).changes !== 1) throw new Error('CAS conflict');
    }), /CAS conflict/);
    assert.equal(first.withTransaction(tx => tx.get('SELECT id FROM courses WHERE id=?', 'loser')), undefined);
    assert.equal(second.withTransaction(tx => tx.get('SELECT attempt_count FROM login_attempt_windows WHERE bucket_hash=?', 'a'.repeat(64)))!.attempt_count, 2);
  } finally { second.close(); first.close(); }
});
