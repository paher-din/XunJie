import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createDigitalLogicApplicationDatabase, migrateDisplayMetadata } from '../server/db/transaction.ts';
import { sessionViewSchema, courseMembershipViewSchema } from '../contracts/access/index.ts';
import { assignmentViewSchema, assignmentSummarySchema } from '../contracts/design/results.ts';
import { assignmentBootstrapSchema } from '../contracts/design/i0.ts';
import { fixture, allocate, command } from './dl-a-support.ts';

const Driver = createRequire(import.meta.url)('better-sqlite3') as new (file: string) => {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[]; get(): unknown };
  close(): void;
};

test('explicit old-database migration adds only three nullable fields, retains original records and can be repeated', () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'xunjie-display-migration-'));
  const file = join(directory, 'retained.sqlite');
  let db = new Driver(file);
  try {
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, login_name TEXT, password_hash BLOB, disabled_at_ms INTEGER);
      CREATE TABLE courses (id TEXT PRIMARY KEY);
      CREATE TABLE assignments (id TEXT PRIMARY KEY, course_id TEXT, student_id TEXT, activity_id TEXT, assignment_revision INTEGER);
      CREATE TABLE audit_events (event_id TEXT PRIMARY KEY, original_json TEXT);
      INSERT INTO users VALUES ('learner-42','learner42',x'010203',NULL);
      INSERT INTO courses VALUES ('circuits-2026');
      INSERT INTO assignments VALUES ('assignment-42','circuits-2026','learner-42','fixed-activity-3',7);
      INSERT INTO audit_events VALUES ('event-9','{"snapshotId":"snapshot-8","hash":"original-fixed-hash"}');`);
    const retained = ['users', 'courses', 'assignments', 'audit_events'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    db.close();
    assert.deepEqual(migrateDisplayMetadata(file), {
      addedColumns: ['users.display_name', 'courses.name', 'assignments.display_title'],
    });
    db = new Driver(file);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), tables);
    assert.deepEqual(db.prepare('SELECT id,login_name,password_hash,disabled_at_ms FROM users').all(), retained[0]);
    assert.deepEqual(db.prepare('SELECT id FROM courses').all(), retained[1]);
    assert.deepEqual(db.prepare('SELECT id,course_id,student_id,activity_id,assignment_revision FROM assignments').all(), retained[2]);
    assert.deepEqual(db.prepare('SELECT * FROM audit_events').all(), retained[3]);
    assert.deepEqual(db.prepare('SELECT display_name FROM users').get(), { display_name: null });
    db.exec("UPDATE users SET display_name='阿青'; UPDATE courses SET name='数字电路'; UPDATE assignments SET display_title='组合逻辑实验';");
    db.close();
    assert.deepEqual(migrateDisplayMetadata(file), { addedColumns: [] });
    db = new Driver(file);
    assert.deepEqual(db.prepare('SELECT display_name FROM users').get(), { display_name: '阿青' });
    assert.deepEqual(db.prepare('SELECT name FROM courses').get(), { name: '数字电路' });
    assert.deepEqual(db.prepare('SELECT display_title FROM assignments').get(), { display_title: '组合逻辑实验' });
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});

test('migration rejects a missing business table without partially changing the other tables', () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'xunjie-display-migration-'));
  const file = join(directory, 'retained.sqlite');
  let db = new Driver(file);
  try {
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE courses (id TEXT PRIMARY KEY);');
    db.close();
    assert.throws(() => migrateDisplayMetadata(file), /existing users, courses and assignments/);
    db = new Driver(file);
    assert.deepEqual(db.prepare("SELECT name FROM pragma_table_info('users')").all(), [{ name: 'id' }]);
    assert.deepEqual(db.prepare("SELECT name FROM pragma_table_info('courses')").all(), [{ name: 'id' }]);
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});

test('fresh 35-table factory includes display metadata without adding tables or requiring migration', () => {
  const db = createDigitalLogicApplicationDatabase();
  const file = db.file;
  try {
    assert.equal(db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")!.n), 35);
    for (const [table, column] of [['users', 'display_name'], ['courses', 'name'], ['assignments', 'display_title']]) {
      assert.deepEqual(db.withTransaction(tx => tx.get(`SELECT type,"notnull" FROM pragma_table_info('${table}') WHERE name=?`, column!)), { type: 'TEXT', notnull: 0 });
    }
  } finally { db.close(); }
  assert.deepEqual(migrateDisplayMetadata(file), { addedColumns: [] });
});

test('normal APIs project stored names for arbitrary identities and keep assignment authority and fixed activity intact', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login(), other = await f.login('other'), foreign = await f.login('foreign');
    const item = await allocate(f, teacher, student, false);
    const otherAllocation = await command(f, teacher, `/api/activities/${item.activityId}/assignments`, {
      expectedActivityControlRevision: 1, studentIds: ['other'],
    });
    assert.equal(otherAllocation.statusCode, 200, otherAllocation.body);
    const otherId = String(otherAllocation.json().data.result.assignments[0].assignmentId);
    const fixed = f.db.withTransaction(tx => tx.get('SELECT activity_json,content_hash FROM activity_versions WHERE id=?', item.activityId));
    f.db.withTransaction(tx => {
      tx.run('UPDATE users SET display_name=? WHERE id=?', '  夏禾  ', 'student');
      tx.run('UPDATE users SET display_name=? WHERE id=?', '仲夏', 'other');
      tx.run('UPDATE courses SET name=? WHERE id=?', 'C 语言项目课', 'course');
      tx.run('UPDATE courses SET name=? WHERE id=?', '数字电路课', 'logic-course');
      tx.run('UPDATE assignments SET display_title=? WHERE id=?', '  文本分析工具  ', item.assignmentId);
      tx.run('UPDATE assignments SET display_title=? WHERE id=?', '另一位同学的分配名称', otherId);
    });

    const sessionResponse = await f.app.inject({ url: '/api/session', headers: student });
    assert.equal(sessionResponse.statusCode, 200, sessionResponse.body);
    const session = sessionViewSchema.parse(sessionResponse.json().data);
    assert.equal(session.userId, 'student');
    assert.equal(session.displayName, '夏禾');
    assert.deepEqual(session.courses, [{ courseId: 'course', role: 'student', name: 'C 语言项目课' },
      { courseId: 'logic-course', role: 'student', name: '数字电路课' }]);
    assert.doesNotMatch(sessionResponse.body, /password_hash|salt|仲夏/);
    const otherSession = await f.app.inject({ url: '/api/session', headers: other });
    assert.equal(otherSession.json().data.displayName, '仲夏');
    const courses = await f.app.inject({ url: '/api/courses', headers: student });
    assert.deepEqual(courses.json().data.map((row: unknown) => courseMembershipViewSchema.parse(row)), session.courses);

    const list = await f.app.inject({ url: '/api/courses/course/assignments', headers: student });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().data.length, 1);
    const summary = assignmentSummarySchema.parse(list.json().data[0]);
    assert.equal(summary.assignmentId, item.assignmentId);
    assert.equal(summary.displayTitle, '文本分析工具');
    assert.doesNotMatch(list.body, /另一位同学的分配名称/);
    const detail = await f.app.inject({ url: `/api/assignments/${item.assignmentId}`, headers: student });
    const assignment = assignmentViewSchema.parse(detail.json().data);
    assert.equal(assignment.displayTitle, '文本分析工具');
    assert.equal(assignment.assignmentRevision, summary.assignmentRevision);
    const bootstrap = await f.app.inject({ url: `/api/assignments/${item.assignmentId}/bootstrap`, headers: student });
    assert.deepEqual(assignmentBootstrapSchema.parse(bootstrap.json().data).assignment, assignment);
    for (const headers of [other, foreign]) {
      assert.equal((await f.app.inject({ url: `/api/assignments/${item.assignmentId}`, headers })).statusCode, 403);
      assert.equal((await f.app.inject({ url: `/api/assignments/${item.assignmentId}/bootstrap`, headers })).statusCode, 403);
    }
    assert.equal((await f.app.inject({ url: '/api/courses/course/assignments', headers: foreign })).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/api/courses' })).statusCode, 401);
    const activity = await f.app.inject({ url: `/api/activities/${item.activityId}?audience=student`, headers: student });
    assert.equal(activity.json().data.content.content.projectTitle, 'TextScope');
    assert.deepEqual(f.db.withTransaction(tx => tx.get('SELECT activity_json,content_hash FROM activity_versions WHERE id=?', item.activityId)), fixed);

    f.db.withTransaction(tx => {
      tx.run('UPDATE users SET display_name=? WHERE id=?', '   ', 'student');
      tx.run('UPDATE courses SET name=NULL WHERE id=?', 'course');
      tx.run('UPDATE courses SET name=? WHERE id=?', '', 'logic-course');
      tx.run('UPDATE assignments SET display_title=? WHERE id=?', '   ', item.assignmentId);
    });
    const noNames = (await f.app.inject({ url: '/api/session', headers: student })).json().data;
    assert.equal('displayName' in noNames, false);
    assert(noNames.courses.every((row: object) => !('name' in row)));
    const unnamedCourses = (await f.app.inject({ url: '/api/courses', headers: student })).json().data;
    assert(unnamedCourses.every((row: object) => !('name' in row)));
    const unnamed = (await f.app.inject({ url: '/api/courses/course/assignments', headers: student })).json().data[0];
    assert.equal('displayTitle' in unnamed, false);
    for (const suffix of ['', '/bootstrap']) {
      const response = await f.app.inject({ url: `/api/assignments/${item.assignmentId}${suffix}`, headers: student });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal('displayTitle' in (suffix ? response.json().data.assignment : response.json().data), false);
    }
  } finally { await f.close(); }
});
