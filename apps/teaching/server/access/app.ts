import type { ActorContext, ResourceScope, ResourceUse } from '../../contracts/access/index.ts';
import { assertResourceUse } from './resource.ts';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createApp, type AppOptions } from '../app.ts';
import { ApiError, domainError } from '../app/errors.ts';
import { parseRequest } from '../app/validation.ts';
import type { SyntheticDatabase, Transaction } from '../db/transaction.ts';
import { createPasswordVerifier, type PasswordRecord } from './password.ts';
import { absoluteLifetime, createSessionStore, digest, readActiveSession } from './session-store.ts';

export interface VerificationOptions extends AppOptions {
  db: SyntheticDatabase;
  origin: string;
  signingSecret: string;
  now?: () => number;
}
const loginSchema = z.strictObject({ loginName: z.string().min(1).max(128), password: z.string().min(1).max(1024) });
const windowLength = 15 * 60 * 1000;

export async function createAccessApp(options: VerificationOptions) {
  if (new URL(options.origin).origin !== options.origin || !options.origin.startsWith('https://') || options.signingSecret.length < 32) {
    throw new Error('Approved HTTPS origin and signing material required.');
  }
  const now = options.now ?? Date.now;
  const db = options.db;
  const app = createApp(options);
  const persistence = createSessionStore(db, now);
  const verifyPassword = await createPasswordVerifier();
  await app.register(cookie);
  await app.register(session, { secret: options.signingSecret, store: persistence.store, cookieName: '__Host-xunjie',
    cookie: { path: '/', httpOnly: true, sameSite: 'lax', secure: true }, rolling: false, saveUninitialized: false });

  const persisted = <T>(work: (tx: Transaction) => T) => {
    try { return db.withTransaction(work); }
    catch (error) { throw domainError(error, 'PERSISTENCE_UNAVAILABLE'); }
  };
  const activeSession = (request: FastifyRequest, tx: Transaction) => {
    const row = readActiveSession(tx, request.session.sessionId, now());
    if (!row || row.user_id !== request.session.userId) throw new ApiError('UNAUTHENTICATED');
    return row;
  };
  const withAuthorizedCourse = <T>(request: FastifyRequest, courseId: string | ((tx: Transaction) => string),
    requiredRole: 'teacher' | 'student' | undefined,
    work: (tx: Transaction, actor: { userId: string; courseId: string; role: 'teacher' | 'student' }) => T): T => {
    return persisted(tx => {
      if (work.constructor.name === 'AsyncFunction') throw new Error('Synchronous authorized work required.');
      const current = activeSession(request, tx);
      if (typeof courseId === 'function' && courseId.constructor.name === 'AsyncFunction') throw new Error('Synchronous course locator required.');
      const resolvedCourseId = typeof courseId === 'string' ? courseId : courseId(tx);
      if (typeof resolvedCourseId !== 'string' || !resolvedCourseId) throw new Error('Invalid course locator.');
      const membership = tx.get('SELECT role FROM course_memberships WHERE user_id=? AND course_id=? AND active=1', String(current.user_id), resolvedCourseId);
      const role = membership?.role;
      if ((role !== 'teacher' && role !== 'student') || (requiredRole && role !== requiredRole)) throw new ApiError('FORBIDDEN');
      tx.run('UPDATE sessions SET last_active_at_ms=? WHERE token_hash=?', now(), digest(request.session.sessionId));
      return work(tx, { userId: String(current.user_id), courseId: resolvedCourseId, role });
    });
  };
  const access = {
    withAuthorizedCourse,
    withAuthorizedResource<T>(request: FastifyRequest, locate: (tx: Transaction) => ResourceScope | undefined,
      use: ResourceUse, work: (tx: Transaction, actor: ActorContext, scope: ResourceScope) => T): T {
      if (locate.constructor.name === 'AsyncFunction' || work.constructor.name === 'AsyncFunction') throw new ApiError('PERSISTENCE_UNAVAILABLE');
      let resource: ResourceScope | undefined;
      return withAuthorizedCourse(request, tx => {
        resource = locate(tx);
        if (!resource) throw new ApiError('FORBIDDEN');
        return resource.courseId;
      }, undefined, (tx, actor) => {
        if (!resource) throw new ApiError('FORBIDDEN');
        assertResourceUse(actor, resource, use);
        return work(tx, actor, resource);
      });
    },
    authorizeCourse(request: FastifyRequest, courseId: string | ((tx: Transaction) => string), requiredRole?: 'teacher' | 'student') {
      return withAuthorizedCourse(request, courseId, requiredRole, (_tx, actor) => actor);
    },
  };

  app.addHook('preValidation', async request => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if (request.headers.origin !== options.origin) throw new ApiError('FORBIDDEN');
    if (request.url.split('?', 1)[0] === '/api/sessions') {
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(request.headers['content-type']))) throw new ApiError('INVALID_REQUEST');
      return;
    }
    persisted(tx => {
      const current = activeSession(request, tx);
      const supplied = request.headers['x-csrf-token'];
      if (typeof supplied !== 'string' || supplied.length > 128
        || !timingSafeEqual(Buffer.from(digest(supplied), 'hex'), Buffer.from(String(current.csrf_hash), 'hex'))) throw new ApiError('FORBIDDEN');
    });
  });

  const csrfFor = (token: string) => createHmac('sha256', options.signingSecret).update('xunjie-csrf\0').update(token).digest('base64url');
  app.get('/api/session', request => {
    const data = persisted(tx => {
      const current = activeSession(request, tx);
      const csrfToken = csrfFor(request.session.sessionId);
      if (digest(csrfToken) !== current.csrf_hash) throw new ApiError('UNAUTHENTICATED');
      const courses = tx.all('SELECT course_id,role FROM course_memberships WHERE user_id=? AND active=1 ORDER BY course_id', String(current.user_id))
        .map(row => ({ courseId: String(row.course_id), role: row.role }));
      tx.run('UPDATE sessions SET last_active_at_ms=? WHERE token_hash=?', now(), digest(request.session.sessionId));
      return { userId: String(current.user_id), courses, csrfToken };
    });
    return { requestId: request.id, data };
  });
  app.post('/api/sessions', async request => {
    const input = parseRequest(loginSchema, request.body);
    const buckets = [['account', input.loginName, 10], ['ip', request.ip, 50]] as const;
    const timestamp = now();
    const reservations = persisted(tx => buckets.map(([kind, value, limit]) => {
      const hash = createHmac('sha256', options.signingSecret).update(kind).update('\0').update(value).digest('hex');
      const row = tx.get('SELECT * FROM login_attempt_windows WHERE kind=? AND bucket_hash=?', kind, hash);
      const expired = !row || timestamp >= Number(row.window_start_ms) + windowLength;
      if (row && timestamp < Number(row.window_start_ms)) throw new ApiError('RATE_LIMITED');
      if (!expired && Number(row!.attempt_count) >= limit) throw new ApiError('RATE_LIMITED');
      tx.run(`INSERT INTO login_attempt_windows(kind,bucket_hash,window_start_ms,attempt_count,failure_count) VALUES (?,?,?,1,0)
        ON CONFLICT(kind,bucket_hash) DO UPDATE SET window_start_ms=excluded.window_start_ms,
        attempt_count=?, failure_count=?`, kind, hash, expired ? timestamp : Number(row!.window_start_ms), expired ? 1 : Number(row!.attempt_count) + 1, expired ? 0 : Number(row!.failure_count));
      return { kind, hash, start: expired ? timestamp : Number(row!.window_start_ms) };
    }));
    const user = persisted(tx => tx.get('SELECT * FROM users WHERE login_name=?', input.loginName));
    const record: PasswordRecord | undefined = user && Buffer.isBuffer(user.password_hash) && Buffer.isBuffer(user.salt)
      ? { hash: user.password_hash, salt: user.salt } : undefined;
    const valid = await verifyPassword(input.password, record);
    if (!valid || !user || user.disabled_at_ms !== null) {
      persisted(tx => { for (const bucket of reservations) tx.run('UPDATE login_attempt_windows SET failure_count=failure_count+1 WHERE kind=? AND bucket_hash=? AND window_start_ms=?', bucket.kind, bucket.hash, bucket.start); });
      throw new ApiError('UNAUTHENTICATED');
    }
    await request.session.regenerate();
    const csrfToken = csrfFor(request.session.sessionId);
    request.session.userId = String(user.id);
    request.session.csrfHash = digest(csrfToken);
    request.session.options({ expires: new Date(now() + absoluteLifetime) });
    persistence.approveLogin(request.session.sessionId, String(user.id), digest(csrfToken), record!.hash);
    await request.session.save();
    return { requestId: request.id, data: { csrfToken } };
  });
  app.post('/api/logout', async (request, reply) => {
    await request.session.destroy();
    reply.clearCookie('__Host-xunjie', { path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    return { requestId: request.id, data: { loggedOut: true } };
  });
  return { app, access };
}

// Historical verification entry remains compatible; both register the same real routes and storage. 
export const createVerificationApp = createAccessApp;
