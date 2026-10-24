import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ensureBaseline } from '../src/baseline.mjs';
import { environmentPaths, repoPaths } from '../src/paths.mjs';
import { collectData, databaseDriver, restoreData } from '../src/repro-data.mjs';

test('course baselines explicitly retain unopened assignments without widening the selected courses or attempts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'xj-unstarted-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = { env: environmentPaths(root, 'source'), repo: repoPaths(resolve(import.meta.dirname, '../../..')) };
  await ensureBaseline(context.repo.teaching, context.env, () => {});
  const Driver = databaseDriver(context.repo.teaching), db = new Driver(context.env.database);
  let attempt;
  try {
    attempt = db.prepare("SELECT * FROM attempts WHERE course_id='synthetic-textscope-c'").get();
    const columns = db.prepare('PRAGMA table_info(assignments)').all().map(row => row.name);
    const copy = (id, sourceId) => {
      const source = db.prepare('SELECT activity_id FROM assignments WHERE id=?').get(sourceId);
      const activityId = id + '-activity';
      for (const [table, key] of [['activity_versions', 'id'], ['activity_controls', 'activity_id']]) {
        const names = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
        db.prepare(`INSERT INTO ${table} (${names.join(',')}) SELECT ${names.map(name => name === key ? '?' : name).join(',')} FROM ${table} WHERE ${key}=?`)
          .run(activityId, source.activity_id);
      }
      db.prepare(`INSERT INTO assignments (${columns.join(',')}) SELECT ${columns.map(name => ['id', 'activity_id'].includes(name) ? '?' : name).join(',')} FROM assignments WHERE id=?`)
        .run(id, activityId, sourceId);
      return activityId;
    };
    copy('unopened-c', attempt.assignment_id);
    const otherActivity = copy('another-started-c', attempt.assignment_id);
    const attemptColumns = db.prepare('PRAGMA table_info(attempts)').all().map(row => row.name);
    const projection = attemptColumns.map(name => ['attempt_id', 'assignment_id', 'activity_id'].includes(name) ? '?' : name).join(',');
    db.prepare(`INSERT INTO attempts (${attemptColumns.join(',')}) SELECT ${projection} FROM attempts WHERE attempt_id=?`)
      .run(...attemptColumns.filter(name => ['attempt_id', 'assignment_id', 'activity_id'].includes(name)).map(name => ({ attempt_id: 'unselected-attempt', assignment_id: 'another-started-c', activity_id: otherActivity })[name]), attempt.attempt_id);
    const other = db.prepare("SELECT id FROM assignments WHERE course_id='synthetic-digital-logic'").get();
    copy('unopened-outside-course', other.id);
  } finally { db.close(); }
  const scope = { courseIds: ['synthetic-textscope-c'], userIds: ['synthetic-teacher', 'synthetic-student'], attemptIds: [attempt.attempt_id] };
  async function collect(name, extra = {}) {
    const scratch = join(root, name); mkdirSync(scratch);
    return collectData(context, scratch, { scope, ...extra });
  }
  const ordinary = await collect('ordinary');
  assert.equal(ordinary.manifest.tables.assignments, 1);
  assert.equal(ordinary.manifest.includeUnstartedAssignments, undefined);
  const selected = await collect('course', { includeUnstartedAssignments: true });
  assert.equal(selected.manifest.tables.assignments, 2);
  assert.equal(selected.manifest.tables.attempts, 1);
  assert.equal(selected.manifest.includeUnstartedAssignments, true);
  const file = join(root, 'selected.sqlite'); writeFileSync(file, selected.bytes);
  const restored = environmentPaths(root, 'restored');
  await restoreData(context.repo.teaching, file, selected.manifest, restored, 'course-v1');
  const result = new Driver(restored.database, { readonly: true });
  try {
    assert.deepEqual(result.prepare('SELECT id FROM assignments ORDER BY id').all().map(row => row.id).sort(), [attempt.assignment_id, 'unopened-c'].sort());
    assert.equal(result.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(result.pragma('foreign_key_check'), []);
    assert.equal(result.prepare('SELECT count(*) n FROM sessions').get().n, 0);
  } finally { result.close(); }
  await assert.rejects(collect('invalid', { includeUnstartedAssignments: 'yes' }), { code: 'INVALID_SCOPE' });
});
