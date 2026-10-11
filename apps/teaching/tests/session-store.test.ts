import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Session } from 'fastify';
import type { SessionStore } from '@fastify/session';
import { createSyntheticDatabase, openSyntheticDatabase } from '../server/db/transaction.ts';
import { createSessionStore, digest, absoluteLifetime, idleLifetime } from '../server/access/session-store.ts';

const get = (store: SessionStore, token: string) => new Promise<Session | null>((resolve, reject) => store.get(token, (error, value) => error ? reject(error) : resolve(value ?? null)));
const set = (store: SessionStore, token: string, value: Session) => new Promise<void>((resolve, reject) => store.set(token, value, error => error ? reject(error) : resolve()));
const destroy = (store: SessionStore, token: string) => new Promise<void>((resolve, reject) => store.destroy(token, error => error ? reject(error) : resolve()));

test('persistent store cannot revive revoked/expired sessions or persist untrusted identities', async () => {
  let db = createSyntheticDatabase();
  const file = db.file;
  let now = Date.now();
  const hash = randomBytes(64);
  db.withTransaction(tx => tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES (?,?,?,?,?,?,?,?,?)', 'user', 'synthetic', hash, randomBytes(16), 'scrypt', 131072, 8, 1, 64));
  let access = createSessionStore(db, () => now);
  const value: Session = { userId: 'user', csrfHash: digest(randomBytes(32).toString('hex')), cookie: { originalMaxAge: null, secure: true, path: '/' } };
  const token = randomBytes(32).toString('hex');
  try {
    await assert.rejects(set(access.store, token, value), { code: 'UNAUTHENTICATED' });
    await set(access.store, 'anonymous', { cookie: { originalMaxAge: null } });
    assert.equal(await get(access.store, 'anonymous'), null);
    access.approveLogin(token, 'user', value.csrfHash!, hash);
    await set(access.store, token, value);
    const stale = (await get(access.store, token))!;
    assert.equal(stale.userId, 'user');
    await destroy(access.store, token);
    await assert.rejects(set(access.store, token, stale), { code: 'UNAUTHENTICATED' });
    db.close();
    db = openSyntheticDatabase(file);
    access = createSessionStore(db, () => now);
    assert.equal(await get(access.store, token), null);
    await assert.rejects(set(access.store, token, stale), { code: 'UNAUTHENTICATED' });
    const expiring = randomBytes(32).toString('hex');
    access.approveLogin(expiring, 'user', value.csrfHash!, hash);
    await set(access.store, expiring, value);
    const original = (await get(access.store, expiring))!;
    now += idleLifetime - 1;
    await set(access.store, expiring, { ...original, cookie: { ...original.cookie, expires: new Date(now + absoluteLifetime) } });
    now += 1;
    assert.equal(await get(access.store, expiring), null);
    await assert.rejects(set(access.store, expiring, original), { code: 'UNAUTHENTICATED' });
    const invalidated = randomBytes(32).toString('hex');
    access.approveLogin(invalidated, 'user', value.csrfHash!, hash);
    db.withTransaction(tx => tx.run('UPDATE users SET disabled_at_ms=? WHERE id=?', now, 'user'));
    await assert.rejects(set(access.store, invalidated, value), { code: 'UNAUTHENTICATED' });
  } finally { db.close(); }
});
