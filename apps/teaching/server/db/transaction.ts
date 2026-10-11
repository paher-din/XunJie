import { completionSchema } from './completion-schema.ts';
import { workspaceSchema } from '../workspace/schema.ts';
import { designSchema } from './design-schema.ts';
import { createRequire } from 'node:module';
import { closeSync, lstatSync, mkdtempSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export type SqlValue = string | number | null | Buffer;
export type SqlRow = Record<string, SqlValue>;
export interface Transaction {
  run(sql: string, ...params: SqlValue[]): { changes: number };
  get(sql: string, ...params: SqlValue[]): SqlRow | undefined;
  all(sql: string, ...params: SqlValue[]): SqlRow[];
}
// Narrow boundary for the APIs used from the untyped native driver; rows remain untrusted.
interface NativeDatabase {
  prepare(sql: string): {
    run(...params: SqlValue[]): { changes: number };
    get(...params: SqlValue[]): SqlRow | undefined;
    all(...params: SqlValue[]): SqlRow[];
  };
  exec(sql: string): void;
  pragma(sql: string, options: { simple: true }): SqlValue;
  inTransaction: boolean;
  close(): void;
}
const Driver = createRequire(import.meta.url)('better-sqlite3') as new (file: string, options: { fileMustExist: true }) => NativeDatabase;

const schema = `
CREATE TABLE users (
 id TEXT PRIMARY KEY NOT NULL, login_name TEXT UNIQUE NOT NULL,
 password_hash BLOB NOT NULL CHECK(typeof(password_hash)='blob' AND length(password_hash)=64), salt BLOB NOT NULL CHECK(typeof(salt)='blob' AND length(salt)=16),
 algorithm TEXT NOT NULL CHECK(algorithm='scrypt'), n INTEGER NOT NULL CHECK(n=131072),
 r INTEGER NOT NULL CHECK(r=8), p INTEGER NOT NULL CHECK(p=1), key_length INTEGER NOT NULL CHECK(key_length=64),
 disabled_at_ms INTEGER);
CREATE TABLE courses (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE course_memberships (
 course_id TEXT NOT NULL REFERENCES courses(id), user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('teacher','student')), active INTEGER NOT NULL CHECK(active IN (0,1)),
 PRIMARY KEY(course_id,user_id));
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64), user_id TEXT NOT NULL REFERENCES users(id),
 created_at_ms INTEGER NOT NULL, last_active_at_ms INTEGER NOT NULL,
 absolute_expires_at_ms INTEGER NOT NULL CHECK(absolute_expires_at_ms=created_at_ms+28800000),
 revoked_at_ms INTEGER, csrf_hash TEXT NOT NULL CHECK(length(csrf_hash)=64),
 CHECK(last_active_at_ms>=created_at_ms));
CREATE TABLE login_attempt_windows (
 kind TEXT NOT NULL CHECK(kind IN ('account','ip')), bucket_hash TEXT NOT NULL CHECK(length(bucket_hash)=64),
 window_start_ms INTEGER NOT NULL, attempt_count INTEGER NOT NULL CHECK(attempt_count>=0),
 failure_count INTEGER NOT NULL CHECK(failure_count>=0 AND failure_count<=attempt_count),
 PRIMARY KEY(kind,bucket_hash));
`;

function validateSyntheticFile(file: string) {
  const directory = dirname(resolve(file));
  if (basename(file) !== 'synthetic.sqlite' || dirname(directory) !== realpathSync(tmpdir())
    || !/^xunjie-(?:a1-p2|a2-s2|a12-completion)-[A-Za-z0-9]+$/.test(basename(directory))
    || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory
    || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
    throw new Error('Invalid synthetic database target.');
  }
}

export function openSyntheticDatabase(file: string) {
  validateSyntheticFile(file);
  const db = new Driver(file, { fileMustExist: true });
  try {
    db.pragma('foreign_keys=ON', { simple: true });
    db.pragma('journal_mode=WAL', { simple: true });
    db.pragma('synchronous=FULL', { simple: true });
    db.pragma('busy_timeout=1000', { simple: true });
    const diagnostics = {
      sqliteVersion: String(db.prepare('SELECT sqlite_version() AS version').get()!.version),
      journalMode: db.pragma('journal_mode', { simple: true }),
      foreignKeys: db.pragma('foreign_keys', { simple: true }),
      synchronous: db.pragma('synchronous', { simple: true }),
      busyTimeout: db.pragma('busy_timeout', { simple: true }),
    };
    const [major, minor, patch] = diagnostics.sqliteVersion.split('.').map(Number);
    if (major !== 3 || minor! < 51 || (minor === 51 && patch! < 3)
      || diagnostics.journalMode !== 'wal' || diagnostics.foreignKeys !== 1
      || diagnostics.synchronous !== 2 || diagnostics.busyTimeout !== 1000) {
      throw new Error('Unsupported database configuration.');
    }
    return {
      file, diagnostics,
      withTransaction<T>(work: (tx: Transaction) => T): T {
        if (work.constructor.name === 'AsyncFunction' || db.inTransaction) throw new Error('Synchronous non-nested transaction required.');
        db.exec('BEGIN IMMEDIATE');
        let active = true;
        const prepare = (sql: string) => {
          if (!active) throw new Error('Transaction capability expired.');
          // Transaction control and schema changes are never delegated to callbacks.
          if (!/^\s*(SELECT|INSERT|UPDATE)\b/i.test(sql)) throw new Error('Approved data statements only.');
          return db.prepare(sql);
        };
        const tx: Transaction = {
          run: (sql, ...params) => prepare(sql).run(...params),
          get: (sql, ...params) => prepare(sql).get(...params),
          all: (sql, ...params) => prepare(sql).all(...params),
        };
        try {
          const value = work(tx);
          if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
            throw new Error('Synchronous transaction required.');
          }
          db.exec('COMMIT');
          return value;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        } finally { active = false; }
      },
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}

export type SyntheticDatabase = ReturnType<typeof openSyntheticDatabase>;

export function createSyntheticDatabase(): SyntheticDatabase {
  return createFreshDatabase('access');
}
export function createDesignDatabase(): SyntheticDatabase {
  return createFreshDatabase('design');
}
export function createCompletionDatabase(): SyntheticDatabase { return createFreshDatabase('completion'); }
export function createWorkspaceDatabase(): SyntheticDatabase { return createFreshDatabase('workspace'); }
function createFreshDatabase(kind: 'access' | 'design' | 'completion' | 'workspace'): SyntheticDatabase {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), ['completion','workspace'].includes(kind) ? 'xunjie-a12-completion-' : kind === 'design' ? 'xunjie-a2-s2-' : 'xunjie-a1-p2-'));
  const file = join(directory, 'synthetic.sqlite');
  closeSync(openSync(file, 'wx', 0o600));
  validateSyntheticFile(file);
  const db = new Driver(file, { fileMustExist: true });
  try {
    db.exec('BEGIN IMMEDIATE');
    try { db.exec(schema); if (kind !== 'access') db.exec(designSchema); if (kind === 'completion' || kind === 'workspace') db.exec(completionSchema); if (kind === 'workspace') db.exec(workspaceSchema); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
  return openSyntheticDatabase(file);
}
