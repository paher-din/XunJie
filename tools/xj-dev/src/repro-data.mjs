import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertShareable } from './repro-code.mjs';
import { digest, jsonBytes, reproError } from './repro-archive.mjs';
import { writeJsonAtomic } from './state.mjs';

// Everything else stays empty in the newly constructed database, including all execution queues.
export const SHARED_TABLES = Object.freeze([
  'users', 'courses', 'course_memberships', 'application_control',
  'resource_versions', 'competency_versions', 'blueprint_drafts', 'help_policy_versions', 'check_rule_versions',
  'activity_versions', 'activity_controls', 'assignments', 'attempts', 'digital_logic_config_versions',
  'workspace_files', 'artifact_snapshots', 'audit_events', 'command_receipts', 'workspace_command_bindings',
  'workspace_process_records', 'workspace_submissions', 'workspace_reopen_grants',
  'learner_context_revisions', 'learner_state_revisions', 'teacher_decisions', 'learner_disputes', 'teacher_feedback',
]);
export const DATA_EXCLUSIONS = ['sessions', 'login_attempt_windows', 'jobs', 'workspace_runs', 'hdl_builds', 'hdl_sessions', 'hdl_operations',
  'teacher_design_requests', 'teacher_design_proposals', 'analysis_results', 'teaching_messages', 'teaching_actions', 'teaching_deliveries', 'teaching_action_receipts',
  'personal models and conversations', 'browser state', 'machine identity', 'original credentials'];

export function databaseDriver(teachingDir) {
  return createRequire(join(teachingDir, 'package.json'))('better-sqlite3');
}
export async function schemaFingerprint(teachingDir, scratch) {
  const { createApplicationDatabase } = await import(pathToFileURL(join(teachingDir, 'server/db/transaction.ts')).href);
  const file = join(scratch, 'schema.sqlite');
  const handle = createApplicationDatabase(file, 'digital-logic-review-application'); handle.close();
  const Driver = databaseDriver(teachingDir), db = new Driver(file);
  try { return fingerprint(db); } finally { db.close(); }
}
function fingerprint(db) {
  return digest(jsonBytes(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()));
}
function placeholders(values) { return values.map(() => '?').join(','); }
function validIds(ids) { return Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128); }
function parseScope(scope) {
  if (!scope || !validIds(scope.courseIds) || !validIds(scope.userIds) || !validIds(scope.attemptIds)) {
    throw reproError('INVALID_SCOPE', 'data.scope 必须明确给出非空 courseIds、userIds、attemptIds；只采集这些课程与成员的任务。');
  }
  return scope;
}
function userRow(row) {
  return { ...row, login_name: 'repro-' + digest(row.id).slice(7, 19), display_name: '复现成员',
    password_hash: Buffer.alloc(64), salt: Buffer.alloc(16), disabled_at_ms: 1 };
}

function assertPayloadScope(row, scope) {
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|signing[_-]?secret|csrf[_-]?token|cookie)$/i.test(key)
        && item !== null && item !== '' && item !== false) throw reproError('SECRET_DETECTED', '业务 JSON 带有凭据字段，不能进入共享库。');
      if (/^(?:student|user|actor|teacher|recipient|owner)(?:Id|_id)$/.test(key) && typeof item === 'string' && !scope.userIds.includes(item)) {
        throw reproError('SCOPE_VIOLATION', '选中对象的 JSON 引用了范围外成员；请缩小场景或明确补充必要成员。');
      }
      if ((key === 'courseId' || key === 'course_id') && typeof item === 'string' && !scope.courseIds.includes(item)) throw reproError('SCOPE_VIOLATION', 'JSON 业务载荷引用了范围外课程。');
      walk(item);
    }
  };
  for (const [column, value] of Object.entries(row)) if (column.endsWith('_json') && typeof value === 'string') {
    try { walk(JSON.parse(value)); } catch (error) { if (error.code) throw error; throw reproError('INVALID_DATA', '选中业务 JSON 无效。'); }
  }
}

// One read transaction gives a consistent SQLite view; no original database pages are distributed.
export async function collectData(context, scratch, spec) {
  const scope = parseScope(spec?.scope), Driver = databaseDriver(context.repo.teaching);
  if (!existsSync(context.env.database)) throw reproError('RESOURCE_MISSING', '尚无本地业务库，先建立触发前环境。');
  const source = new Driver(context.env.database, { readonly: true, fileMustExist: true });
  const startedAt = new Date().toISOString();
  const rows = {};
  let schema;
  try {
    source.exec('BEGIN');
    schema = fingerprint(source);
    const all = Object.fromEntries(SHARED_TABLES.map(table => [table, source.prepare(`SELECT * FROM ${table}`).all()]));
    for (const course of scope.courseIds) if (!all.courses.some(row => row.id === course)) throw reproError('RESOURCE_MISSING', '选中课程不存在。');
    for (const user of scope.userIds) if (!all.users.some(row => row.id === user)) throw reproError('RESOURCE_MISSING', '选中成员不存在。');
    for (const id of scope.attemptIds) {
      const attempt = all.attempts.find(row => row.attempt_id === id);
      if (!attempt || !scope.courseIds.includes(attempt.course_id) || !scope.userIds.includes(attempt.student_id)) throw reproError('INVALID_SCOPE', '任务缺失或不属于选中课程/成员。');
    }
    const attemptRows = all.attempts.filter(row => scope.attemptIds.includes(row.attempt_id));
    const assignments = new Set(attemptRows.map(row => row.assignment_id));
    const activities = new Set(attemptRows.map(row => row.activity_id));
    for (const table of SHARED_TABLES) {
      rows[table] = all[table].filter(row => {
        if (table === 'application_control') return true;
        if (table === 'users') return scope.userIds.includes(row.id);
        if (table === 'courses') return scope.courseIds.includes(row.id);
        if ('course_id' in row && !scope.courseIds.includes(row.course_id)) return false;
        if ('student_id' in row && !scope.userIds.includes(row.student_id)) return false;
        if (table === 'course_memberships') return scope.userIds.includes(row.user_id);
        if ('attempt_id' in row) return scope.attemptIds.includes(row.attempt_id);
        if (table === 'assignments') return assignments.has(row.id);
        if (table === 'activity_versions') return activities.has(row.id);
        if (table === 'activity_controls') return activities.has(row.activity_id);
        // Receipt/audit/binding dependencies are pulled from exact FK references below.
        if (['audit_events', 'command_receipts', 'workspace_command_bindings', 'resource_versions', 'competency_versions',
          'blueprint_drafts', 'help_policy_versions', 'check_rule_versions', 'digital_logic_config_versions'].includes(table)) return false;
        if ('created_by' in row && !scope.userIds.includes(row.created_by)) return false;
        return true;
      });
    }
    // Pull exact referenced receipts/audit events; fail closed on references outside the declared scope.
    let changed = true;
    while (changed) {
      changed = false;
      const referenced = new Set();
      const strings = value => {
        if (typeof value === 'string') referenced.add(value);
        else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item);
      };
      for (const records of Object.values(rows)) for (const row of records) for (const [column, value] of Object.entries(row)) {
        if (column.endsWith('_json') && typeof value === 'string') strings(JSON.parse(value));
      }
      for (const table of ['resource_versions', 'help_policy_versions', 'check_rule_versions', 'digital_logic_config_versions', 'competency_versions']) {
        for (const row of all[table]) {
          if (scope.courseIds.includes(row.course_id) && referenced.has(row.id ?? row.competency_id) && !rows[table].includes(row)) {
            if (row.created_by && !scope.userIds.includes(row.created_by)) throw reproError('SCOPE_VIOLATION', '引用资源的作者不在成员范围内。');
            rows[table].push(row); changed = true;
          }
        }
      }
      for (const table of SHARED_TABLES) {
        const fks = source.prepare(`PRAGMA foreign_key_list(${table})`).all();
        for (const row of rows[table]) for (const fk of fks) {
          if (row[fk.from] === null) continue;
          if (!SHARED_TABLES.includes(fk.table)) throw reproError('UNSHAREABLE_REFERENCE', '选中对象依赖被排除的执行或个人记录。');
          if (rows[fk.table].some(candidate => candidate[fk.to] === row[fk.from])) continue;
          const candidate = all[fk.table].find(candidate => candidate[fk.to] === row[fk.from]);
          if (!candidate || (fk.table === 'users' && !scope.userIds.includes(candidate.id))
            || ('course_id' in candidate && !scope.courseIds.includes(candidate.course_id))
            || (candidate.actor_id && !scope.userIds.includes(candidate.actor_id))
            || (candidate.created_by && !scope.userIds.includes(candidate.created_by))
            || ('student_id' in candidate && candidate.student_id && !scope.userIds.includes(candidate.student_id))) {
            throw reproError('RESOURCE_MISSING', '业务依赖不在采集范围内；请补充必要课程/成员。');
          }
          rows[fk.table].push(candidate); changed = true;
        }
      }
    }
    rows.users = rows.users.map(userRow);
    for (const [table, records] of Object.entries(rows)) {
      for (const row of records) for (const [column, value] of Object.entries(row)) {
        if (typeof value === 'string') assertShareable(value, `${table}.${column}`);
      }
      for (const row of records) assertPayloadScope(row, scope);
    }
    source.exec('COMMIT');
  } finally { source.close(); }
  const expected = await schemaFingerprint(context.repo.teaching, scratch);
  if (expected !== schema) throw reproError('SCHEMA_MISMATCH', '源业务库结构与当前代码不符；不会暗中迁移。');
  const file = join(scratch, 'shared.sqlite');
  await createSharedDatabase(context.repo.teaching, file, rows);
  const marker = JSON.parse(readFileSync(context.env.baselineFile, 'utf8'));
  return { bytes: readFileSync(file), manifest: {
    schema, baselineVersion: marker.version, scope, tables: Object.fromEntries(Object.entries(rows).map(([table, data]) => [table, data.length])),
    consistency: { kind: 'single-sqlite-read-transaction', startedAt, finishedAt: new Date().toISOString(),
      crossStorageAtomic: false, missing: ['个人模型、浏览器状态、执行节点、外部服务均未采集；外部资源单独校验，不构成跨存储原子快照。'] },
    exclusions: DATA_EXCLUSIONS,
    accounts: rows.users.map(row => ({ id: row.id, loginName: row.login_name,
      role: rows.course_memberships.some(m => m.user_id === row.id && m.role === 'teacher') ? 'teacher' : 'student' })),
  } };
}

async function createSharedDatabase(teachingDir, file, rows) {
  const { createApplicationDatabase } = await import(pathToFileURL(join(teachingDir, 'server/db/transaction.ts')).href);
  mkdirSync(dirname(file), { recursive: true });
  const handle = createApplicationDatabase(file, 'digital-logic-review-application'); handle.close();
  const Driver = databaseDriver(teachingDir), target = new Driver(file);
  try {
    target.pragma('foreign_keys=OFF'); target.exec('BEGIN');
    for (const table of SHARED_TABLES) for (const row of rows[table] ?? []) {
      const columns = Object.keys(row);
      target.prepare(`INSERT INTO ${table} (${columns.map(c => '"' + c + '"').join(',')}) VALUES (${placeholders(columns)})`).run(...columns.map(c => row[c]));
    }
    if (target.prepare('PRAGMA foreign_key_check').all().length) throw reproError('RESOURCE_MISSING', '场景缺少业务引用，未生成可分发库。');
    target.exec('COMMIT'); target.pragma('journal_mode=DELETE');
  } finally { target.close(); }
}

export async function restoreData(teachingDir, sourceFile, metadata, envPaths, baselineVersion) {
  const scope = parseScope(metadata.scope);
  const Driver = databaseDriver(teachingDir), source = new Driver(sourceFile, { readonly: true, fileMustExist: true });
  const rows = {};
  try {
    if (fingerprint(source) !== metadata.schema) throw reproError('SCHEMA_MISMATCH', '包内库结构摘要不符。');
    if (source.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw reproError('INVALID_DATA', '包内数据库完整性检查失败。');
    const tableNames = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    for (const table of tableNames) {
      const records = source.prepare(`SELECT * FROM "${table}"`).all();
      if (!SHARED_TABLES.includes(table) && records.length) throw reproError('UNSHAREABLE_DATA', '包内含旧会话、队列或不允许共享的记录。');
      if (SHARED_TABLES.includes(table)) {
        if (records.length !== metadata.tables?.[table]) throw reproError('INVALID_DATA', '共享库记录数与清单不符。');
        for (const row of records) {
          if ((table === 'users' && !scope.userIds.includes(row.id)) || (table === 'courses' && !scope.courseIds.includes(row.id))
            || ('course_id' in row && !scope.courseIds.includes(row.course_id)) || ('attempt_id' in row && !scope.attemptIds.includes(row.attempt_id))
            || ['user_id', 'student_id', 'actor_id', 'teacher_id', 'created_by', 'controlled_by', 'granted_by'].some(key => row[key] && !scope.userIds.includes(row[key]))) throw reproError('SCOPE_VIOLATION', '包内业务记录超出声明的课程/成员/任务范围。');
          assertPayloadScope(row, scope);
          for (const value of Object.values(row)) if (typeof value === 'string') assertShareable(value, '包内业务载荷');
        }
        rows[table] = records;
      }
    }
    for (const user of rows.users) {
      if (!Buffer.isBuffer(user.password_hash) || !user.password_hash.equals(Buffer.alloc(64)) || !user.salt.equals(Buffer.alloc(16)) || user.disabled_at_ms !== 1) {
        throw reproError('UNSHAREABLE_DATA', '包内包含原凭据或可直接登录的身份。');
      }
    }
  } finally { source.close(); }
  await createSharedDatabase(teachingDir, envPaths.database, rows);
  const { createPasswordRecord } = await import(pathToFileURL(join(teachingDir, 'server/access/password.ts')).href);
  const restored = new Driver(envPaths.database), credentials = [];
  try {
    for (const user of rows.users) {
      const password = randomBytes(18).toString('base64url'), record = await createPasswordRecord(password);
      restored.prepare('UPDATE users SET password_hash=?,salt=?,disabled_at_ms=NULL WHERE id=?').run(record.hash, record.salt, user.id);
      credentials.push({ ...metadata.accounts.find(a => a.id === user.id), password });
    }
    restored.pragma('wal_checkpoint(TRUNCATE)');
  } finally { restored.close(); }
  mkdirSync(envPaths.secrets, { recursive: true, mode: 0o700 });
  writeJsonAtomic(envPaths.baselineCredentials, credentials);
  writeJsonAtomic(envPaths.baselineFile, { version: baselineVersion ?? metadata.baselineVersion, schema: metadata.schema, accounts: metadata.accounts,
    restoredAt: new Date().toISOString(), source: 'repro-package' });
  return { database: envPaths.database, credentialsFile: envPaths.baselineCredentials, accounts: metadata.accounts };
}
