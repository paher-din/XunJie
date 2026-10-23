// Optional local administration. Normal product startup does not enable this
// socket or require any external enrollment process, identity or credential.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { readControlledJson } from '../app/config.ts';
import { createPasswordRecord } from './password.ts';
import { localSocket } from './local-socket.ts';
import type { SyntheticDatabase, Transaction } from '../db/transaction.ts';

class AccountControlError extends Error {
  status: number;
  code: string;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
function requireAccess(value: unknown, code: string, status = 400): asserts value {
  if (!value) throw new AccountControlError(code, status);
}
const configurationSchema = z.strictObject({
  socketPath: z.string().refine(isAbsolute), stateFile: z.string().refine(isAbsolute),
  accountPrefix: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,31}$/),
  courseIds: z.array(z.string().min(1).max(128)).min(1).max(20), socketGid: z.number().int().nonnegative().optional(),
});
const accountSchema = z.strictObject({ externalId: z.string(), courseId: z.string(), role: z.enum(['student', 'teacher']), active: z.boolean() });
const registrySchema = z.strictObject({ format: z.literal('xunjie/account-control-v1'), accounts: z.record(z.string(), accountSchema) });
const externalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const inputSchema = z.strictObject({ externalId: externalIdSchema, loginName: z.string().min(1).max(128),
  password: z.string().min(32).max(128), courseId: z.string().min(1).max(128), role: z.enum(['student', 'teacher']) });
type Management = { disableUserInTransaction(tx: Transaction, userId: string): void };

export async function createLocalAccountControl(configurationFile: string, { db, staticAllowed }: { db: SyntheticDatabase; staticAllowed?: string[] }) {
  const config = configurationSchema.parse(readControlledJson(configurationFile));
  requireAccess(Array.isArray(staticAllowed) && staticAllowed.length, 'EXPLICIT_APPLICATION_SCOPE_REQUIRED');
  const baseAllowed = new Set(staticAllowed);
  let registry = existsSync(config.stateFile) ? registrySchema.parse(readControlledJson(config.stateFile)) : registrySchema.parse({ format: 'xunjie/account-control-v1', accounts: {} });
  const save = (next: typeof registry) => {
    mkdirSync(dirname(config.stateFile), { recursive: true, mode: 0o700 });
    const temporary = config.stateFile + '.' + randomBytes(12).toString('hex') + '.tmp';
    try { writeFileSync(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, config.stateFile); }
    finally { rmSync(temporary, { force: true }); }
    registry = next;
  };
  if (!existsSync(config.stateFile)) save(registry);
  const userId = (id: unknown) => config.accountPrefix + externalIdSchema.parse(id);
  let queue: Promise<unknown> = Promise.resolve(), management: Management;
  const serial = <T>(work: () => T | Promise<T>) => { const next = queue.then(work); queue = next.catch(() => {}); return next; };
  async function ensure(raw: unknown) {
    const input = inputSchema.parse(raw), id = userId(input.externalId), owned = registry.accounts[id];
    requireAccess(!owned || owned.active, 'APPLICATION_IDENTITY_REVOKED', 403);
    requireAccess(input.loginName === id && config.courseIds.includes(input.courseId), 'APPLICATION_SCOPE_DENIED', 403);
    if (owned) requireAccess(owned.externalId === input.externalId && owned.courseId === input.courseId && owned.role === input.role, 'APPLICATION_IDENTITY_CONFLICT');
    const old = db.withTransaction(tx => tx.get('SELECT id,login_name,disabled_at_ms FROM users WHERE id=?', id));
    const record = old ? undefined : await createPasswordRecord(input.password);
    db.withTransaction(tx => {
      requireAccess(tx.get('SELECT id FROM courses WHERE id=?', input.courseId), 'COURSE_NOT_FOUND');
      const existing = tx.get('SELECT id,login_name,disabled_at_ms FROM users WHERE id=?', id);
      if (existing) requireAccess(existing.login_name === id && existing.disabled_at_ms === null, 'APPLICATION_IDENTITY_CONFLICT');
      else {
        requireAccess(record, 'APPLICATION_IDENTITY_CONFLICT');
        tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length,display_name) VALUES (?,?,?,?,?,?,?,?,?,?)', id, id, record.hash, record.salt, 'scrypt', 131072, 8, 1, 64, 'Managed account');
      }
      const membership = tx.get('SELECT role,active FROM course_memberships WHERE course_id=? AND user_id=?', input.courseId, id);
      if (membership) requireAccess(membership.role === input.role && membership.active === 1, 'APPLICATION_IDENTITY_CONFLICT');
      else tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,1)', input.courseId, id, input.role);
    });
    save({ ...registry, accounts: { ...registry.accounts, [id]: { externalId: input.externalId, courseId: input.courseId, role: input.role, active: true } } });
    return { userId: id, applicationReady: true };
  }
  function disable(raw: unknown) {
    const input = z.strictObject({ externalId: externalIdSchema }).parse(raw), id = userId(input.externalId), owned = registry.accounts[id];
    if (!owned) return { userId: id, disabled: true, neverGranted: true };
    // Persist deny before business cleanup: failure cannot leave the old session
    // authorized, and the next explicit retry completes only unfinished cleanup.
    save({ ...registry, accounts: { ...registry.accounts, [id]: { ...owned, active: false } } });
    db.withTransaction(tx => {
      const account = tx.get('SELECT disabled_at_ms FROM users WHERE id=?', id);
      if (account && account.disabled_at_ms === null) management.disableUserInTransaction(tx, id);
      tx.run('UPDATE sessions SET revoked_at_ms=COALESCE(revoked_at_ms,?) WHERE user_id=?', Date.now(), id);
    });
    return { userId: id, disabled: true };
  }
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      requireAccess(req.method === 'POST' && typeof req.url === 'string' && ['/ensure', '/disable'].includes(req.url), 'APPLICATION_OPERATION_DENIED', 403);
      let body = '';
      for await (const bytes of req) { body += bytes; requireAccess(Buffer.byteLength(body) <= 8192, 'REQUEST_TOO_LARGE'); }
      const input = JSON.parse(body);
      const data = await serial<unknown>(() => req.url === '/ensure' ? ensure(input) : disable(input));
      send(200, { ok: true, data });
    } catch (error) { send(error instanceof AccountControlError ? error.status : 503, { ok: false, code: error instanceof AccountControlError ? error.code : error instanceof z.ZodError ? 'APPLICATION_CONTROL_INVALID' : 'APPLICATION_CONTROL_FAILED' }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  const endpoint = localSocket(config.socketPath);
  return {
    loginAuthorization: (id: string) => baseAllowed.has(id) || registry.accounts[id]?.active === true,
    async listen(service: { management: Management }) {
      management = service.management;
      await endpoint.listen(server, 0o660, config.socketGid);
    },
    async close() { server.closeAllConnections(); await endpoint.close(server); await queue; },
  };
}
