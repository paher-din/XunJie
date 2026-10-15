import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assigned, command, fixture } from '../workspace/test-support.ts';
import { readStudentTasks } from './student-tasks.ts';

test('independent chat sees only its student assignments and public titles; pause is not completion', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const teacher = await f.login('teacher');
  const { assignmentId } = await assigned(f, teacher);

  const own = readStudentTasks(f.db, 'student');
  assert.deepEqual(own, { tasks: [{ assignmentId, courseId: 'course', title: 'TextScope', availability: 'active' }], hasMore: false });
  assert.deepEqual(readStudentTasks(f.db, 'other'), { tasks: [], hasMore: false });
  assert.deepEqual(readStudentTasks(f.db, 'teacher'), { tasks: [], hasMore: false });
  assert.doesNotMatch(JSON.stringify(own), /PRIVATE_TITLE|PRIVATE_BODY|completed|deadline/);

  const paused = await command(f, teacher, `/api/assignments/${assignmentId}/controls`,
    { expectedAssignmentRevision: 1, action: 'pause', reason: 'Synthetic pause' });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(readStudentTasks(f.db, 'student').tasks[0]?.availability, 'paused');

  f.db.withTransaction(tx => tx.run("UPDATE course_memberships SET active=0 WHERE course_id='course' AND user_id='student'"));
  assert.deepEqual(readStudentTasks(f.db, 'student'), { tasks: [], hasMore: false });
});
