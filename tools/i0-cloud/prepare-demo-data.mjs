import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const marker = 'xunjie-demo-development-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
function ensure(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
function privateFile(file) {
  ensure(isAbsolute(file), 'ABSOLUTE_PRIVATE_FILE_REQUIRED');
  const stat = lstatSync(file);
  ensure(stat.isFile() && !stat.isSymbolicLink() && (process.platform === 'win32' || (stat.mode & 0o077) === 0), 'PRIVATE_REGULAR_FILE_REQUIRED');
  return stat;
}
function privateJson(file) { ensure(privateFile(file).size <= 1024 * 1024, 'PRIVATE_JSON_LIMIT'); return JSON.parse(readFileSync(file, 'utf8')); }
function privateDirectory(directory) {
  ensure(isAbsolute(directory), 'ABSOLUTE_PRIVATE_DIRECTORY_REQUIRED');
  const stat = lstatSync(directory);
  ensure(stat.isDirectory() && !stat.isSymbolicLink() && (process.platform === 'win32' || (stat.mode & 0o077) === 0), 'PRIVATE_DIRECTORY_REQUIRED');
}
function writePrivate(file, value) {
  privateDirectory(dirname(file));
  if (existsSync(file)) privateFile(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
}
function adapter(db) {
  return { get: (sql, ...values) => db.prepare(sql).get(...values), all: (sql, ...values) => db.prepare(sql).all(...values),
    run: (sql, ...values) => db.prepare(sql).run(...values) };
}
const counts = db => Object.fromEntries(['users', 'courses', 'course_memberships', 'assignments', 'attempts', 'jobs']
  .map(table => [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)]));
function intact(db) {
  ensure(db.pragma('integrity_check', { simple: true }) === 'ok', 'DATABASE_INTEGRITY_FAILED');
  ensure(db.pragma('foreign_key_check').length === 0, 'DATABASE_FOREIGN_KEYS_FAILED');
}

/** Maintenance only: no HTTP, login, execution, model request, schema change or old-record rewrite. */
export async function prepareDemoData(options) {
  const teachingRoot = resolve(options.teachingRoot ?? join(dirname(fileURLToPath(import.meta.url)), '../../apps/server'));
  const load = relative => import(pathToFileURL(join(teachingRoot, relative)).href);
  const [{ assertDigitalLogicApplicationDatabase }, activities, { finishRecordCommand }, { activityCommandResults }] = await Promise.all([
    load('server/db/transaction.ts'), load('server/design/activities.ts'), load('server/db/records-adapter.ts'), load('contracts/design/results.ts'),
  ]);
  const Driver = createRequire(join(teachingRoot, 'package.json'))('better-sqlite3');
  const config = options.config, spec = options.spec ?? {};
  ensure(config && typeof config.databaseFile === 'string', 'PRIVATE_APPLICATION_CONFIG_REQUIRED');
  const teacherId = options.teacherId ?? spec.teacherId, studentId = options.studentId ?? spec.studentId;
  ensure(typeof teacherId === 'string' && typeof studentId === 'string' && teacherId && studentId && teacherId !== studentId, 'TWO_RETAINED_IDENTITIES_REQUIRED');
  const namespace = spec.namespace ?? 'synthetic-demo-development-v1';
  ensure(/^synthetic-[A-Za-z0-9_-]{1,60}$/.test(namespace), 'SYNTHETIC_NAMESPACE_REQUIRED');
  privateFile(config.databaseFile);
  ensure(basename(config.databaseFile) === 'synthetic.sqlite', 'RETAINED_SYNTHETIC_DATABASE_REQUIRED');
  const db = new Driver(config.databaseFile, { readonly: !options.apply, fileMustExist: true });
  let backupFile;
  try {
    db.pragma('busy_timeout=1000');
    if (options.apply) db.pragma('foreign_keys=ON');
    const tx = adapter(db);
    // Reuse the original exact 41-table gate without starting an application or migrating a database.
    assertDigitalLogicApplicationDatabase({ withTransaction: work => work(tx) }, true);
    for (const [table, column] of [['users', 'display_name'], ['courses', 'name'], ['assignments', 'display_title']]) {
      ensure(db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column && row.type.toUpperCase() === 'TEXT'), 'DISPLAY_METADATA_REQUIRED');
    }
    intact(db);
    const generation = tx.get('SELECT recovery_generation FROM application_control WHERE singleton=1')?.recovery_generation;
    ensure(typeof generation === 'string' && generation === config.recoveryGeneration, 'APPLICATION_GENERATION_MISMATCH');
    for (const [userId, role] of [[teacherId, 'teacher'], [studentId, 'student']]) {
      ensure(tx.get('SELECT id FROM users WHERE id=? AND disabled_at_ms IS NULL', userId)
        && tx.get('SELECT user_id FROM course_memberships WHERE user_id=? AND role=? AND active=1', userId, role), 'RETAINED_IDENTITY_ROLE_REQUIRED');
    }
    const allowed = config.allowedLoginUserIds;
    const restrictedLogin = Array.isArray(allowed) && allowed.length === 2 && new Set(allowed).size === 2 && allowed.includes(teacherId) && allowed.includes(studentId);
    if (options.apply) ensure(restrictedLogin, 'EXACT_TWO_ID_LOGIN_POLICY_REQUIRED');
    const candidates = tx.all(`SELECT a.course_id,a.activity_id,a.display_title,v.created_at_ms FROM assignments a
      JOIN activity_versions v ON v.id=a.activity_id JOIN activity_controls c ON c.activity_id=v.id
      WHERE a.student_id=? AND a.status='active' AND c.status='active' ORDER BY v.created_at_ms,v.id`, studentId)
      .map(row => ({ ...row, activity: activities.readActivity(tx, String(row.course_id), String(row.activity_id)) }));
    const sources = ['c', 'hdl'].map(key => {
      const kind = key === 'hdl' ? 'hdl_board' : 'textscope';
      let selected = candidates.filter(row => ('kind' in row.activity.runtimeProfile ? row.activity.runtimeProfile.kind : 'textscope') === kind);
      if (spec.sourceCourses?.[key]) selected = selected.filter(row => row.course_id === spec.sourceCourses[key]);
      if (spec.sourceActivities?.[key]) selected = selected.filter(row => row.activity_id === spec.sourceActivities[key]);
      ensure(selected.length > 0 && new Set(selected.map(row => row.course_id)).size === 1, 'UNIQUE_SOURCE_COURSE_REQUIRED');
      return { key, kind, ...selected[0] };
    });
    ensure(sources[0].course_id !== sources[1].course_id, 'DISTINCT_SOURCE_COURSES_REQUIRED');
    const classNames = spec.classNames ?? ['计算机2401班', '计算机2402班'];
    ensure(Array.isArray(classNames) && classNames.length === 2 && classNames.every(name => typeof name === 'string' && name.trim().length > 0 && name.length <= 64), 'TWO_CLASS_NAMES_REQUIRED');
    const virtualNames = spec.virtualNames ?? ['张晨', '李悦', '王浩', '陈曦', '周宁', '赵安'];
    ensure(Array.isArray(virtualNames) && virtualNames.length === 6 && virtualNames.every(name => typeof name === 'string' && name.trim().length > 0 && name.length <= 64), 'SIX_VIRTUAL_NAMES_REQUIRED');
    const virtualStudents = virtualNames.map((displayName, index) => ({
      userId: `${namespace}-student-${index < 3 ? '2401' : '2402'}-${index % 3 + 1}`, displayName, classIndex: index < 3 ? 0 : 1,
    }));
    const courses = [0, 1].flatMap(classIndex => sources.map(source => {
      const courseId = classIndex === 0 ? String(source.course_id) : `${namespace}-course-2402-${source.key}`;
      return { courseId, sourceCourseId: String(source.course_id), sourceActivityVersionId: String(source.activity_id),
        kind: source.kind, className: classNames[classIndex], displayName: `${source.key === 'c' ? 'C 程序设计' : '数字逻辑与系统设计'} · ${classNames[classIndex]}`,
        projectTitle: source.display_title?.trim() || (source.key === 'c' ? '文本统计与检索' : '四位算术逻辑单元'),
        policyVersionId: classIndex === 0 ? source.activity.helpPolicy.versionId : `${courseId}-help`,
        checkRuleVersionId: source.activity.checkRule.versionId,
        studentIds: [...(classIndex === 0 ? [studentId] : []), ...virtualStudents.filter(user => user.classIndex === classIndex).map(user => user.userId)],
        publication: classIndex === 0 ? 'existing' : 'pending_teacher_api', classIndex };
    }));
    const teacherDisplayName = spec.teacherDisplayName ?? '陈老师';
    ensure(typeof teacherDisplayName === 'string' && teacherDisplayName.trim() && teacherDisplayName.length <= 128, 'TEACHER_DISPLAY_NAME_REQUIRED');
    const identity = { namespace, teacherId, studentId, generation, teacherDisplayName, virtualStudents, courses };
    const planHash = hash(JSON.stringify(identity));
    const before = counts(db);
    const summary = { mode: options.apply ? 'apply' : 'plan', businessTables: 41, before, targetVirtualStudents: 6,
      targetClasses: 2, targetCourseInstances: 4, sourceCourses: 2, newCourseInstances: 2, restrictedLogin,
      pendingTeacherPublications: 2, schemaChanges: 0, modelCalls: 0, programRuns: 0 };
    if (!options.apply) return summary;
    ensure(options.backupDirectory && options.outputFile, 'PRIVATE_BACKUP_AND_OUTPUT_REQUIRED');
    privateDirectory(options.backupDirectory); privateDirectory(dirname(options.outputFile));
    let previous;
    if (existsSync(options.outputFile)) {
      previous = privateJson(options.outputFile);
      ensure(previous.marker === marker && previous.planHash === planHash, 'EXISTING_OUTPUT_SCOPE_MISMATCH');
    }
    backupFile = join(options.backupDirectory, `demo-before-${Date.now()}-${randomUUID()}.sqlite`);
    closeSync(openSync(backupFile, 'wx', 0o600));
    await db.backup(backupFile);
    // This is the newly created backup only; a normal close also releases its transient WAL sidecars.
    const backup = new Driver(backupFile, { fileMustExist: true });
    try { intact(backup); assertDigitalLogicApplicationDatabase({ withTransaction: work => work(adapter(backup)) }, true); }
    finally { backup.close(); }
    const backupSha256 = hash(readFileSync(backupFile));
    const tables = tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row => row.name);
    const schemaBefore = JSON.stringify(tx.all("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"));
    const created = { users: 0, courses: 0, memberships: 0, assignments: 0, revokedSessions: 0 };
    const assignmentReceipts = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const preserved = tables.filter(table => !['users', 'courses', 'course_memberships', 'sessions'].includes(table))
        .map(table => ({ table, rows: tx.all(`SELECT rowid AS __demo_rowid__,* FROM ${table}`) }));
      const at = Date.now();
      for (const user of virtualStudents) {
        const old = tx.get('SELECT id,login_name,display_name,disabled_at_ms FROM users WHERE id=?', user.userId);
        if (old) ensure(old.login_name === user.userId && old.display_name === user.displayName && old.disabled_at_ms === null, 'VIRTUAL_IDENTITY_CONFLICT');
        else {
          // No password is generated or retained. The explicit login allowlist is the access boundary.
          tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length,display_name) VALUES (?,?,?,?,?,?,?,?,?,?)',
            user.userId, user.userId, randomBytes(64), randomBytes(16), 'scrypt', 131072, 8, 1, 64, user.displayName);
          created.users++;
        }
      }
      tx.run('UPDATE users SET display_name=? WHERE id=? AND display_name IS NOT ?', teacherDisplayName, teacherId, teacherDisplayName);
      for (const course of courses) {
        const old = tx.get('SELECT id,name FROM courses WHERE id=?', course.courseId);
        if (!old) { tx.run('INSERT INTO courses(id,name) VALUES (?,?)', course.courseId, course.displayName); created.courses++; }
        else if (course.classIndex === 0) tx.run('UPDATE courses SET name=? WHERE id=? AND name IS NOT ?', course.displayName, course.courseId, course.displayName);
        else ensure(old.name === course.displayName, 'NEW_COURSE_ID_CONFLICT');
        for (const [userId, role] of [[teacherId, 'teacher'], ...course.studentIds.map(id => [id, 'student'])]) {
          const oldMember = tx.get('SELECT role,active FROM course_memberships WHERE course_id=? AND user_id=?', course.courseId, userId);
          if (oldMember) {
            ensure(oldMember.role === role, 'MEMBERSHIP_ROLE_CONFLICT');
            if (oldMember.active !== 1) tx.run('UPDATE course_memberships SET active=1 WHERE course_id=? AND user_id=?', course.courseId, userId);
          } else { tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,1)', course.courseId, userId, role); created.memberships++; }
        }
        if (course.classIndex === 1) {
          const source = sources.find(item => item.course_id === course.sourceCourseId);
          const actor = { userId: teacherId, courseId: course.courseId, role: 'teacher' };
          activities.storePolicy(tx, actor, { ...source.activity.helpPolicy, versionId: course.policyVersionId }, at);
          // The existing HDL release path uses its built-in rule after fixed configuration registration.
          // storeRule is intentionally C-only; no unused HDL rule row or schema relaxation is needed.
          if (course.kind === 'textscope') activities.storeRule(tx, actor, source.activity.checkRule, at);
        } else {
          const control = tx.get('SELECT control_revision,status FROM activity_controls WHERE activity_id=?', course.sourceActivityVersionId);
          ensure(control?.status === 'active', 'SOURCE_ACTIVITY_NOT_ACTIVE');
          const input = { studentIds: course.studentIds, expectedActivityControlRevision: Number(control.control_revision), recoveryGeneration: generation };
          const prior = new Set(tx.all('SELECT id FROM assignments').map(row => row.id));
          const receipt = finishRecordCommand(tx, { actorId: teacherId, command: 'assignment.create', target: course.sourceActivityVersionId,
            scope: { courseId: course.courseId }, idempotencyKey: `${namespace}-assign-${course.kind}`, recoveryGeneration: generation }, input, generation, at,
          () => activities.assignActivity(tx, { userId: teacherId, courseId: course.courseId, role: 'teacher' }, course.sourceActivityVersionId,
            course.studentIds, Number(control.control_revision), at), value => activityCommandResults['assignment.create'].parse(value));
          for (const assigned of receipt.result.assignments) if (!prior.has(assigned.assignmentId)) {
            tx.run('UPDATE assignments SET display_title=? WHERE id=?', course.projectTitle, assigned.assignmentId); created.assignments++;
          }
          assignmentReceipts.push(receipt);
        }
      }
      created.revokedSessions = tx.run('UPDATE sessions SET revoked_at_ms=? WHERE user_id NOT IN (?,?) AND revoked_at_ms IS NULL', at, teacherId, studentId).changes;
      ensure(JSON.stringify(tx.all("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")) === schemaBefore, 'SCHEMA_CHANGED');
      for (const saved of preserved) for (const row of saved.rows) {
        ensure(JSON.stringify(tx.get(`SELECT rowid AS __demo_rowid__,* FROM ${saved.table} WHERE rowid=?`, row.__demo_rowid__)) === JSON.stringify(row), 'ORIGINAL_RECORD_CHANGED');
      }
      intact(db);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const after = counts(db);
    const run = { appliedAt: new Date().toISOString(), backupFile, backupSha256, before, after, created };
    writePrivate(options.outputFile, { marker, version: 1, namespace, planHash, status: 'prepared_pending_teacher_publication',
      identities: { teacherId, studentId }, source: { recoveryGeneration: generation }, virtualStudents, courses,
      publicationPlan: courses.filter(course => course.publication === 'pending_teacher_api'), assignmentReceipts,
      runs: [...(previous?.runs ?? []), run], schemaChanges: 0, originalRecordsPreserved: true });
    return { ...summary, after, created, privateReceiptWritten: true, originalRecordsPreserved: true };
  } finally { db.close(); }
}

async function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const name = process.argv[index];
    if (name === '--plan') options.apply = false;
    else if (name === '--apply') options.apply = true;
    else if (name === '--help') {
      process.stdout.write('Development data maintenance utility. Default --plan is read-only. Use a private --config and retained --teacher-id/--student-id or --spec. --apply requires --backup-dir and --output. No credentials are accepted or printed.\n');
      return;
    } else {
      const key = { '--config': 'configFile', '--spec': 'specFile', '--teacher-id': 'teacherId', '--student-id': 'studentId',
        '--backup-dir': 'backupDirectory', '--output': 'outputFile', '--teaching-root': 'teachingRoot' }[name];
      ensure(key && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), 'INVALID_ARGUMENT');
      options[key] = process.argv[++index];
    }
  }
  ensure(process.version === 'v24.21.0' && process.platform === 'linux', 'LINUX_NODE_24_21_REQUIRED');
  ensure(options.configFile, 'PRIVATE_CONFIG_REQUIRED');
  options.config = privateJson(options.configFile);
  options.spec = options.specFile ? privateJson(options.specFile) : {};
  const result = await prepareDemoData(options);
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ status: 'stopped', code: /^[A-Z0-9_]{1,64}$/.test(error.code ?? '') ? error.code : 'DEMO_PREPARATION_FAILED' }) + '\n');
    process.exitCode = 1;
  });
}
