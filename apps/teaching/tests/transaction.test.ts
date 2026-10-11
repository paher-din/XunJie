import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticDatabase } from '../server/db/transaction.ts';

test('fresh synthetic database enforces configuration, foreign keys and atomic rollback', () => {
  const store = createSyntheticDatabase();
  try {
    assert.ok(store.diagnostics.sqliteVersion.split('.').map(Number)[0]! >= 3);
    assert.equal(store.diagnostics.journalMode, 'wal');
    assert.equal(store.diagnostics.foreignKeys, 1);
    assert.equal(store.diagnostics.synchronous, 2);
    assert.equal(store.diagnostics.busyTimeout, 1000);
    store.withTransaction(tx => tx.run('INSERT INTO courses(id) VALUES (?)', 'course'));
    assert.throws(() => store.withTransaction(tx => {
      tx.run('INSERT INTO courses(id) VALUES (?)', 'rollback');
      tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,?)', 'rollback', 'missing', 'student', 1);
    }), /FOREIGN KEY/);
    assert.equal(store.withTransaction(tx => tx.get('SELECT id FROM courses WHERE id=?', 'rollback')), undefined);
    assert.deepEqual(store.withTransaction(tx => tx.get('SELECT id FROM courses WHERE id=?', 'course')), { id: 'course' });
  } finally { store.close(); }
});

test('transaction rejects async, thenables, nesting and escaped capability; uniqueness rolls back', () => {
  const store = createSyntheticDatabase();
  try {
    let called = false;
    assert.throws(() => store.withTransaction(async () => { called = true; }), /Synchronous/);
    assert.equal(called, false);
    assert.throws(() => store.withTransaction(tx => {
      tx.run('INSERT INTO courses(id) VALUES (?)', 'promise');
      return Promise.resolve();
    }), /Synchronous/);
    assert.throws(() => store.withTransaction(tx => {
      tx.run('INSERT INTO courses(id) VALUES (?)', 'nested');
      store.withTransaction(() => 0);
    }), /non-nested/);
    assert.throws(() => store.withTransaction(tx => {
      tx.run('INSERT INTO courses(id) VALUES (?)', 'unique');
      tx.run('INSERT INTO courses(id) VALUES (?)', 'unique');
    }), /UNIQUE/);
    assert.deepEqual(store.withTransaction(tx => tx.all('SELECT id FROM courses')), []);
    const escaped = store.withTransaction(tx => tx);
    assert.throws(() => escaped.run('INSERT INTO courses(id) VALUES (?)', 'late'), /expired/);
  } finally { store.close(); }
});
