import { digitalLogicSchema } from './digital-logic-schema.ts';
import { hdlSchema } from '../workspace/hdl-schema.ts';
import { reviewSchema } from './review-schema.ts';
import { teacherDesignSchema } from '../design/teacher-schema.ts';
import { completionSchema } from './completion-schema.ts';
import { workspaceSchema } from '../workspace/schema.ts';
import { teachingSchema } from '../records/schema.ts';
import { designSchema } from './design-schema.ts';
import { createRequire } from 'node:module';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
 disabled_at_ms INTEGER, display_name TEXT);
CREATE TABLE courses (id TEXT PRIMARY KEY NOT NULL, name TEXT);
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

function openVerifiedDatabase(file: string) {
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

export function openSyntheticDatabase(file: string) {
  validateSyntheticFile(file);
  return openVerifiedDatabase(file);
}

/** Persistent application databases live at an explicit caller-owned path; the tmpdir factories above stay synthetic-only. */
function validatePersistentDatabaseFile(file: string, create: boolean) {
  if (!isAbsolute(file)) throw new Error('An absolute application database path is required.');
  const directory = dirname(file);
  // Only the final component must be a real, non-symlink directory. Ancestor symlinks (macOS /var→/private/var,
  // symlinked home directories) are the caller's own environment and stay valid.
  if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw new Error('Invalid application database directory.');
  }
  const stat = existsSync(file) ? lstatSync(file) : undefined;
  if (create) {
    if (stat) throw new Error('Application database file already exists.');
    return;
  }
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error('An existing application database file is required.');
}

export function openApplicationDatabase(file: string): ApplicationDatabase {
  validatePersistentDatabaseFile(file, false);
  return openVerifiedDatabase(file);
}

export function createApplicationDatabase(file: string, scope: ApplicationDatabaseScope): ApplicationDatabase {
  assertApplicationScope(scope);
  validatePersistentDatabaseFile(file, true);
  closeSync(openSync(file, 'wx', 0o600));
  applyDatabaseScope(file, scope);
  return openApplicationDatabase(file);
}

/** The same handle serves tmpdir synthetic factories and explicit persistent application databases. */
export type ApplicationDatabase = ReturnType<typeof openSyntheticDatabase>;

/** @deprecated Historical name kept for existing callers; new code uses ApplicationDatabase. */
export type SyntheticDatabase = ApplicationDatabase;

/** Explicit maintenance operation; opening or starting an application never migrates its database. */
export function migrateDisplayMetadata(file: string): { addedColumns: string[] } {
  if (!isAbsolute(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
    throw new Error('An explicit existing database file is required.');
  }
  const db = new Driver(file, { fileMustExist: true });
  try {
    db.pragma('busy_timeout=1000', { simple: true });
    db.exec('BEGIN IMMEDIATE');
    try {
      const additions = [['users', 'display_name'], ['courses', 'name'], ['assignments', 'display_title']] as const;
      const missing = additions.filter(([table, column]) => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.length) throw new Error('Display metadata migration requires the existing users, courses and assignments tables.');
        const existing = columns.find(row => row.name === column);
        if (existing && (String(existing.type).toUpperCase() !== 'TEXT' || existing.notnull !== 0)) {
          throw new Error('Existing display metadata column must be nullable TEXT.');
        }
        return !existing;
      });
      for (const [table, column] of missing) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      db.exec('COMMIT');
      return { addedColumns: missing.map(([table, column]) => `${table}.${column}`) };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

export function createSyntheticDatabase(): SyntheticDatabase {
  return createFreshDatabase('access');
}
export function createDesignDatabase(): SyntheticDatabase {
  return createFreshDatabase('design');
}
export function createCompletionDatabase(): SyntheticDatabase { return createFreshDatabase('completion'); }
export function createWorkspaceDatabase(): SyntheticDatabase { return createFreshDatabase('workspace'); }
export function createTeacherDesignDatabase(): SyntheticDatabase { return createFreshDatabase('teacher-design'); }
// C3 adds the four teaching tables on the same approved path/transaction rules; older factories never gain them.
export function createTeachingDatabase(): SyntheticDatabase { return createFreshDatabase('teaching'); }
// Exact scope approved for the A4 batch plus A5's `teacher_feedback`; detect composition drift before creating a file.
export function createReviewDatabase(): SyntheticDatabase {
  const approvedTables = ['activity_controls', 'activity_versions', 'analysis_results', 'artifact_snapshots', 'assignments', 'attempts', 'audit_events', 'blueprint_drafts', 'check_rule_versions', 'command_receipts', 'competency_versions', 'course_memberships', 'courses', 'help_policy_versions', 'jobs', 'learner_context_revisions', 'learner_disputes', 'learner_state_revisions', 'login_attempt_windows', 'resource_versions', 'sessions', 'teacher_decisions', 'teacher_feedback', 'teaching_action_receipts', 'teaching_actions', 'teaching_deliveries', 'teaching_messages', 'users', 'workspace_command_bindings', 'workspace_files', 'workspace_process_records', 'workspace_reopen_grants', 'workspace_runs', 'workspace_submissions'];
  assertApprovedScope(approvedTables,[schema,designSchema,completionSchema,workspaceSchema,teachingSchema,reviewSchema],'Review');
  return createFreshDatabase('review');
}
export function createDigitalLogicDatabase(): SyntheticDatabase {
  const approvedTables = ['activity_controls', 'activity_versions', 'artifact_snapshots', 'assignments', 'attempts', 'audit_events', 'blueprint_drafts', 'check_rule_versions', 'command_receipts', 'competency_versions', 'course_memberships', 'courses', 'hdl_builds', 'hdl_operations', 'hdl_sessions', 'help_policy_versions', 'jobs', 'login_attempt_windows', 'resource_versions', 'sessions', 'teaching_action_receipts', 'teaching_actions', 'teaching_deliveries', 'teaching_messages', 'users', 'workspace_command_bindings', 'workspace_files', 'workspace_process_records', 'workspace_reopen_grants', 'workspace_runs', 'workspace_submissions'];
  assertApprovedScope(approvedTables,[schema,designSchema,completionSchema,workspaceSchema,teachingSchema,hdlSchema],'Digital logic');
  return createFreshDatabase('digital-logic');
}
const digitalLogicApplicationTables = ['activity_controls', 'activity_versions', 'application_control', 'artifact_snapshots', 'assignments', 'attempts', 'audit_events', 'blueprint_drafts', 'check_rule_versions', 'command_receipts', 'competency_versions', 'course_memberships', 'courses', 'digital_logic_config_versions', 'hdl_builds', 'hdl_operations', 'hdl_sessions', 'help_policy_versions', 'jobs', 'login_attempt_windows', 'resource_versions', 'sessions', 'teacher_design_proposals', 'teacher_design_requests', 'teaching_action_receipts', 'teaching_actions', 'teaching_deliveries', 'teaching_messages', 'users', 'workspace_command_bindings', 'workspace_files', 'workspace_process_records', 'workspace_reopen_grants', 'workspace_runs', 'workspace_submissions'];
export const reviewTableNames = ['analysis_results','learner_context_revisions','learner_disputes','learner_state_revisions','teacher_decisions','teacher_feedback'];
export function assertDigitalLogicApplicationDatabase(db:SyntheticDatabase,review=false) {
 const names=db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row=>String(row.name)));
 const expected=review?[...digitalLogicApplicationTables,...reviewTableNames].sort():digitalLogicApplicationTables;
 if(JSON.stringify(names)!==JSON.stringify(expected))throw new Error('Digital logic application requires the explicit '+expected.length+'-table scope.');
}
export function createDigitalLogicApplicationDatabase(): SyntheticDatabase {
 assertApplicationScope('digital-logic-application');
 return createFreshDatabase('digital-logic-application');
}
// Opt-in only. Callers must obtain authorization for this exact 41-table composition before initialization.
export function createDigitalLogicReviewApplicationDatabase(): SyntheticDatabase {
 assertApplicationScope('digital-logic-review-application');
 return createFreshDatabase('digital-logic-review-application');
}
function assertApplicationScope(scope: ApplicationDatabaseScope) {
 if (scope === 'digital-logic-application') {
  assertApprovedScope(digitalLogicApplicationTables,[schema,designSchema,completionSchema,workspaceSchema,teachingSchema,teacherDesignSchema,hdlSchema,digitalLogicSchema],'Digital logic application');
 } else {
  assertApprovedScope([...digitalLogicApplicationTables,...reviewTableNames].sort(),[schema,designSchema,completionSchema,workspaceSchema,teachingSchema,teacherDesignSchema,hdlSchema,digitalLogicSchema,reviewSchema],'Digital logic review application');
 }
}
function assertApprovedScope(approvedTables:string[],schemas:string[],name:string) {
  const declaredTables = schemas.flatMap(sql=>[...sql.matchAll(/CREATE TABLE\s+([a-z_][a-z0-9_]*)/gi)].map(match=>match[1]!)).sort();
  if(JSON.stringify(declaredTables)!==JSON.stringify(approvedTables))
    throw new Error(name+' initialization requires the approved '+approvedTables.length+'-table scope; authorize a changed composition before creating a database.');
}
export type ApplicationDatabaseScope = 'digital-logic-application' | 'digital-logic-review-application';
type DatabaseKind = 'access' | 'design' | 'completion' | 'workspace' | 'teacher-design' | 'teaching' | 'review' | 'digital-logic' | ApplicationDatabaseScope;
const scopeSchemas: Record<DatabaseKind, string[]> = {
  'access': [schema],
  'design': [schema, designSchema],
  'completion': [schema, designSchema, completionSchema],
  'workspace': [schema, designSchema, completionSchema, workspaceSchema],
  'teacher-design': [schema, designSchema, completionSchema, workspaceSchema, teacherDesignSchema],
  'teaching': [schema, designSchema, completionSchema, workspaceSchema, teachingSchema],
  'review': [schema, designSchema, completionSchema, workspaceSchema, teachingSchema, reviewSchema],
  'digital-logic': [schema, designSchema, completionSchema, workspaceSchema, teachingSchema, hdlSchema],
  'digital-logic-application': [schema, designSchema, completionSchema, workspaceSchema, teachingSchema, teacherDesignSchema, hdlSchema, digitalLogicSchema],
  'digital-logic-review-application': [schema, designSchema, completionSchema, workspaceSchema, teachingSchema, teacherDesignSchema, hdlSchema, digitalLogicSchema, reviewSchema],
};
function applyDatabaseScope(file: string, kind: DatabaseKind) {
  const db = new Driver(file, { fileMustExist: true });
  try {
    db.exec('BEGIN IMMEDIATE');
    try { for (const sql of scopeSchemas[kind]) db.exec(sql); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
function createFreshDatabase(kind: DatabaseKind): SyntheticDatabase {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), ['completion','workspace','teacher-design','teaching','review','digital-logic','digital-logic-application','digital-logic-review-application'].includes(kind) ? 'xunjie-a12-completion-' : kind === 'design' ? 'xunjie-a2-s2-' : 'xunjie-a1-p2-'));
  const file = join(directory, 'synthetic.sqlite');
  closeSync(openSync(file, 'wx', 0o600));
  validateSyntheticFile(file);
  applyDatabaseScope(file, kind);
  return openSyntheticDatabase(file);
}
