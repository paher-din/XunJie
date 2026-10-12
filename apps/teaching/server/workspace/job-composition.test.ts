import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SyntheticProvider } from '../tutoring/providers.ts';
import { fixture, assigned, opened, files, snapshot, view, command } from './test-support.ts';

test('composed teacher and workspace jobs share routes while retaining their authorization and cancellation', async () => {
  const f = await fixture(undefined, { teacherAgent: {
    provider: new SyntheticProvider([]),
    versions: { modelConfig: 'synthetic-v1', prompt: 'teacher-v1', schema: 'teacher-v1', policy: 'teacher-v1' },
    budgetAvailable: () => true,
  } });
  try {
    const teacher = await f.login('teacher'), student = await f.login(), other = await f.login('other'), foreign = await f.login('foreign');
    const accepted = await command(f, teacher, '/api/courses/course/blueprints', {
      mode: 'agent', generationMode: 'candidates', request: 'Design a C project', references: [],
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    const teacherJobId = String(accepted.json().data.result.jobId);
    const teacherJobUrl = `/api/jobs/${teacherJobId}`;
    assert.equal((await f.app.inject({ url: teacherJobUrl, headers: teacher })).json().data.status, 'queued');
    for (const headers of [student, other, foreign]) {
      assert.equal((await f.app.inject({ url: teacherJobUrl, headers })).statusCode, 403);
      assert.equal((await command(f, headers, `${teacherJobUrl}/cancel`, {})).statusCode, 403);
    }
    f.db.withTransaction(tx => tx.run("INSERT INTO course_memberships(course_id,user_id,role,active) VALUES ('course','foreign','teacher',1)"));
    assert.equal((await f.app.inject({ url: teacherJobUrl, headers: foreign })).statusCode, 403, 'Another course teacher is not the original issuer.');
    assert.equal((await command(f, foreign, `${teacherJobUrl}/cancel`, {})).statusCode, 403);
    assert.equal((await command(f, teacher, `${teacherJobUrl}/cancel`, { recoveryGeneration: 'old-generation' })).statusCode, 409);
    const teacherStop = await command(f, teacher, `${teacherJobUrl}/cancel`, {}, 'teacher-stop');
    assert.equal(teacherStop.statusCode, 200, teacherStop.body);
    const teacherReplay = await command(f, teacher, `${teacherJobUrl}/cancel`, {}, 'teacher-stop');
    assert.equal(teacherReplay.statusCode, 200, teacherReplay.body);
    assert.equal(teacherReplay.json().data.receiptId, teacherStop.json().data.receiptId);
    assert.equal((await f.app.inject({ url: teacherJobUrl, headers: teacher })).json().data.status, 'cancelled');

    const allocation = await assigned(f, teacher), attemptId = await opened(f, student, allocation.assignmentId);
    const ids = await files(f, student, attemptId), snapshotId = await snapshot(f, student, attemptId);
    const state = await view(f, student, attemptId);
    const run = await command(f, student, `/api/attempts/${attemptId}/runs`, {
      expectedAttemptRevision: state.attempt.attemptRevision, snapshotId,
      runtimeProfileVersion: f.profile.runtimeProfileVersion, entryFileId: ids.source,
      input: { operation: 'stats', fileIds: [ids.input] }, mode: 'run',
    });
    assert.equal(run.statusCode, 200, run.body);
    const runJobUrl = `/api/jobs/${run.json().data.result.jobId}`;
    for (const headers of [student, teacher]) {
      const read = await f.app.inject({ url: runJobUrl, headers });
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(read.json().data.purpose, 'student_run');
    }
    assert.equal((await f.app.inject({ url: runJobUrl, headers: other })).statusCode, 403);
    for (const headers of [teacher, other]) assert.equal((await command(f, headers, `${runJobUrl}/cancel`, {})).statusCode, 403);
    const runStop = await command(f, student, `${runJobUrl}/cancel`, {}, 'run-stop');
    assert.equal(runStop.statusCode, 200, runStop.body);
    const runReplay = await command(f, student, `${runJobUrl}/cancel`, {}, 'run-stop');
    assert.equal(runReplay.statusCode, 200, runReplay.body);
    assert.equal(runReplay.json().data.receiptId, runStop.json().data.receiptId);
    await f.reopen();
    assert.equal((await f.app.inject({ url: teacherJobUrl, headers: teacher })).json().data.status, 'cancelled');
    assert.equal((await f.app.inject({ url: runJobUrl, headers: student })).json().data.status, 'cancelling',
      'The runner has not acknowledged termination, so cancellation remains pending.');
  } finally { await f.close(); }
});
