import { randomUUID, createHash } from 'node:crypto';
import { provisionStorage, openStorage, createFileBackend } from '@xunjie/storage';
import { nativeFixture } from '../../../../packages/storage/test/native-fixture.mjs';
export const source = path => import(new URL('../../../../' + path, import.meta.url));
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export async function waitFor(read, description, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await read(); if (result) return result; await new Promise(done => setTimeout(done, 10)); }
  throw new Error(description);
}
/** Fault hooks delay real owner operations; no transaction, lock or resource implementation is replaced. */
export async function reviewStorage(migrations) {
  const pg = await nativeFixture();
  const binding = await provisionStorage({ admin: pg.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() },
    password: randomUUID(), migrations });
  const native = await openStorage({ binding, migrations, backend: createFileBackend({ id: 'files', root: pg.root + '/objects' }) });
  const hooks = {};
  const storage = new Proxy(native, { get(target, property) {
    if (property === 'read') return async (sql, values = []) => {
      const result = await native.read(sql, values); await hooks.afterRead?.(sql, values, result); return result;
    };
    if (property === 'request') return async (input, effect) => {
      await hooks.beforeRequest?.(input); return native.request(input, effect);
    };
    if (property === 'close') return async () => { try { await native.close(); } finally { await pg.close(); } };
    const member = Reflect.get(target, property);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
  const transaction = async effect => (await native.request({ requestId: randomUUID(), fingerprint: 'review-fixture' },
    async tx => (await effect(tx)) ?? null)).result;
  return { storage, hooks, db: {
    exec: sql => transaction(tx => tx.query(sql)),
    query: (sql, values = []) => transaction(tx => tx.query(sql, values)), transaction,
  } };
}
