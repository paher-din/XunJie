import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, allocate } from '../../apps/teaching/tests/dl-a-support.ts';
import { prepareDemoData } from './prepare-demo-data.mjs';

const review = { versions: { modelConfigVersion: 'disabled', promptVersion: 'disabled', schemaVersion: 'disabled', analysisVersion: 'learner-analysis-v1' } };
function ownedRemove(directory, pattern) {
  assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()));
  assert.match(basename(directory), pattern);
  rmSync(directory, { recursive: true });
}
const rowCounts = f => f.db.withTransaction(tx => Object.fromEntries(['users', 'courses', 'assignments', 'attempts', 'workspace_files', 'jobs']
  .map(table => [table, tx.get(`SELECT COUNT(*) AS n FROM ${table}`).n])));
const credentialDigest = f => f.db.withTransaction(tx => createHash('sha256').update(JSON.stringify(tx.all(
  'SELECT id,login_name,password_hash,salt,algorithm,n,r,p,key_length FROM users WHERE id IN (?,?) ORDER BY id', 'teacher', 'student'))).digest('hex'));

test('demo maintenance preserves existing work and credentials, adds real memberships and assignments, and is idempotent', async () => {
  const f = await fixture(undefined, { review }), directory = mkdtempSync(join(realpathSync(tmpdir()), 'xunjie-demo-tool-test-'));
  const databaseDirectory = dirname(f.db.file), backupDirectory = join(directory, 'backups'), outputFile = join(directory, 'receipt.json');
  mkdirSync(backupDirectory, { mode: 0o700 });
  try {
    const teacher = await f.login('teacher'), student = await f.login(); await f.login('other');
    await allocate(f, teacher, student, false); await allocate(f, teacher, student, true);
    await f.host.shutdown();
    const before = rowCounts(f), credentials = credentialDigest(f);
    const studentDisplay = f.db.withTransaction(tx => tx.get('SELECT display_name FROM users WHERE id=?', 'student').display_name);
    const options = { config: { databaseFile: f.db.file, recoveryGeneration: 'generation', allowedLoginUserIds: ['teacher', 'student'] },
      teacherId: 'teacher', studentId: 'student', spec: { namespace: 'synthetic-demo-tool-test', sourceCourses: { c: 'course', hdl: 'logic-course' } },
      backupDirectory, outputFile };
    const plan = await prepareDemoData(options);
    assert.equal(plan.mode, 'plan'); assert.equal(plan.businessTables, 41); assert.equal(plan.restrictedLogin, true);
    assert.deepEqual(rowCounts(f), before); assert.deepEqual(readdirSync(backupDirectory), []);
    assert(!JSON.stringify(plan).includes('synthetic-demo-tool-test'));
    const first = await prepareDemoData({ ...options, apply: true });
    assert.equal(first.created.users, 6); assert.equal(first.created.courses, 2); assert.equal(first.created.assignments, 6);
    assert.equal(first.created.revokedSessions, 1); assert.equal(first.schemaChanges, 0);
    const after = rowCounts(f);
    assert.equal(after.users, before.users + 6); assert.equal(after.courses, before.courses + 2);
    for (const table of ['attempts', 'workspace_files', 'jobs']) assert.equal(after[table], before[table]);
    assert.equal(credentialDigest(f), credentials);
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT display_name FROM users WHERE id=?', 'student').display_name), studentDisplay);
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT display_name FROM users WHERE id=?', 'teacher').display_name), '陈老师');
    assert.equal(f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM course_memberships WHERE user_id='student' AND active=1").n), 4);
    assert.equal(f.db.withTransaction(tx => tx.get("SELECT COUNT(*) AS n FROM sessions WHERE user_id='other' AND revoked_at_ms IS NULL").n), 0);
    const receipt = JSON.parse(readFileSync(outputFile, 'utf8'));
    assert.equal(receipt.publicationPlan.length, 2);
    for (const pending of receipt.publicationPlan) {
      assert.equal(pending.studentIds.length, 4);
      assert.notEqual(pending.courseId, pending.sourceCourseId);
      assert(f.db.withTransaction(tx => tx.get('SELECT id FROM help_policy_versions WHERE course_id=? AND id=?', pending.courseId, pending.policyVersionId)));
      if (pending.kind === 'textscope') assert(f.db.withTransaction(tx => tx.get('SELECT id FROM check_rule_versions WHERE course_id=? AND id=?', pending.courseId, JSON.stringify([pending.courseId, pending.checkRuleVersionId]))));
      else assert.equal(pending.checkRuleVersionId, 'hdl-board-structure-v1');
    }
    const second = await prepareDemoData({ ...options, apply: true });
    assert.deepEqual(second.created, { users: 0, courses: 0, memberships: 0, assignments: 0, revokedSessions: 0 });
    assert.deepEqual(rowCounts(f), after); assert.equal(credentialDigest(f), credentials);
    assert.equal(JSON.parse(readFileSync(outputFile, 'utf8')).runs.length, 2);
    assert.equal(readdirSync(backupDirectory).length, 2);
  } finally {
    await f.close();
    ownedRemove(directory, /^xunjie-demo-tool-test-/);
    ownedRemove(databaseDirectory, /^xunjie-a12-completion-[A-Za-z0-9]+$/);
  }
});

test('apply refuses an absent or wider login policy before adding data or making a backup', async () => {
  const f = await fixture(undefined, { review }), directory = mkdtempSync(join(realpathSync(tmpdir()), 'xunjie-demo-tool-test-'));
  const databaseDirectory = dirname(f.db.file), backupDirectory = join(directory, 'backups');
  mkdirSync(backupDirectory, { mode: 0o700 });
  try {
    await f.host.shutdown(); const before = rowCounts(f);
    for (const allowedLoginUserIds of [undefined, ['teacher', 'student', 'other']]) {
      await assert.rejects(() => prepareDemoData({ apply: true, teacherId: 'teacher', studentId: 'student',
        config: { databaseFile: f.db.file, recoveryGeneration: 'generation', allowedLoginUserIds },
        backupDirectory, outputFile: join(directory, 'receipt.json') }), { code: 'EXACT_TWO_ID_LOGIN_POLICY_REQUIRED' });
    }
    assert.deepEqual(rowCounts(f), before); assert.deepEqual(readdirSync(backupDirectory), []);
  } finally {
    await f.close(); ownedRemove(directory, /^xunjie-demo-tool-test-/);
    ownedRemove(databaseDirectory, /^xunjie-a12-completion-[A-Za-z0-9]+$/);
  }
});

test('the preparation tool rejects a 35-table source without migrating it', async () => {
  const f = await fixture(), databaseDirectory = dirname(f.db.file);
  try {
    await f.host.shutdown(); const before = rowCounts(f);
    await assert.rejects(() => prepareDemoData({ teacherId: 'teacher', studentId: 'student',
      config: { databaseFile: f.db.file, recoveryGeneration: 'generation' } }), /explicit 41-table scope/);
    assert.deepEqual(rowCounts(f), before);
  } finally { await f.close(); ownedRemove(databaseDirectory, /^xunjie-a12-completion-[A-Za-z0-9]+$/); }
});
