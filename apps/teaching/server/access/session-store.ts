import { createHash } from 'node:crypto';
import type { Session } from 'fastify';
import type { SessionStore } from '@fastify/session';
import { ApiError } from '../app/errors.ts';
import type { SyntheticDatabase, Transaction } from '../db/transaction.ts';

declare module 'fastify' {
  interface Session { userId?: string; csrfHash?: string }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const absoluteLifetime = 8 * 60 * 60 * 1000;
export const idleLifetime = 30 * 60 * 1000;

export function readActiveSession(tx: Transaction, token: string, now: number) {
  return tx.get(`SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.revoked_at_ms IS NULL AND u.disabled_at_ms IS NULL
    AND s.created_at_ms<=? AND s.last_active_at_ms<=? AND s.absolute_expires_at_ms>?
    AND s.last_active_at_ms+1800000>?`, digest(token), now, now, now, now);
}

export function createSessionStore(db: SyntheticDatabase, now: () => number) {
  const grants = new Map<string, { userId: string; csrfHash: string; passwordHash: Buffer }>();
  const store: SessionStore = {
    get(token, callback) {
      let result: Session | null;
      try {
        result = db.withTransaction(tx => {
          const row = readActiveSession(tx, token, now());
          return row ? { userId: String(row.user_id), csrfHash: String(row.csrf_hash),
            cookie: { originalMaxAge: null, expires: new Date(Number(row.absolute_expires_at_ms)), path: '/', secure: true, httpOnly: true, sameSite: 'lax' } } : null;
        });
      } catch { callback(new ApiError('PERSISTENCE_UNAVAILABLE')); return; }
      callback(null, result);
    },
    set(token, session, callback) {
      try {
        db.withTransaction(tx => {
          const existing = tx.get('SELECT token_hash FROM sessions WHERE token_hash=?', digest(token));
          if (existing) {
            const active = readActiveSession(tx, token, now());
            if (!active || active.user_id !== session.userId || active.csrf_hash !== session.csrfHash) throw new ApiError('UNAUTHENTICATED');
            return; // Activity is advanced only by an authorized operation, never by plugin set/touch.
          }
          const grant = grants.get(token);
          if (!grant) {
            if (session.userId || session.csrfHash) throw new ApiError('UNAUTHENTICATED');
            return; // Anonymous regenerate does not persist a session.
          }
          if (grant.userId !== session.userId || grant.csrfHash !== session.csrfHash) throw new ApiError('UNAUTHENTICATED');
          const user = tx.get('SELECT id FROM users WHERE id=? AND password_hash=? AND disabled_at_ms IS NULL', grant.userId, grant.passwordHash);
          if (!user) throw new ApiError('UNAUTHENTICATED');
          const timestamp = now();
          tx.run(`INSERT INTO sessions(token_hash,user_id,created_at_ms,last_active_at_ms,absolute_expires_at_ms,csrf_hash)
            VALUES (?,?,?,?,?,?)`, digest(token), grant.userId, timestamp, timestamp, timestamp + absoluteLifetime, grant.csrfHash);
        });
      } catch (error) {
        callback(error instanceof ApiError ? error : new ApiError('PERSISTENCE_UNAVAILABLE')); return;
      } finally { grants.delete(token); }
      callback();
    },
    destroy(token, callback) {
      grants.delete(token);
      try { db.withTransaction(tx => tx.run('UPDATE sessions SET revoked_at_ms=COALESCE(revoked_at_ms,?) WHERE token_hash=?', now(), digest(token))); }
      catch { callback(new ApiError('PERSISTENCE_UNAVAILABLE')); return; }
      callback();
    },
  };
  return { store, approveLogin(token: string, userId: string, csrfHash: string, passwordHash: Buffer) {
    grants.set(token, { userId, csrfHash, passwordHash });
  } };
}
