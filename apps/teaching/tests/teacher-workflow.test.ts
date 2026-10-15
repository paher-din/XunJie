import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, allocate, command, view } from './dl-a-support.ts';
import { teacherWorkbenchSchema } from '../contracts/design/workbench.ts';
import { createDigitalLogicApplication } from '../server/app/digital-logic.ts';
import type { SyntheticDatabase, SqlRow } from '../server/db/transaction.ts';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const review = { versions: { modelConfigVersion: 'disabled', promptVersion: 'disabled', schemaVersion: 'review-v1', analysisVersion: 'review-v1' } };

test('allowed login users preserve 35/41 hosts and active virtual teacher rosters',async()=>{
  for(const reviewEnabled of [false,true]){
    const f=await fixture(undefined,reviewEnabled?{review}:{});let restricted:Awaited<ReturnType<typeof createDigitalLogicApplication>>|undefined;
    try{
      const teacher=await f.login('teacher'),student=await f.login(),virtual=await f.login('other');await f.host.shutdown();
      restricted=await createDigitalLogicApplication({...f.settings,...(reviewEnabled?{review}:{}),allowedLoginUserIds:['teacher','student']});
      for(const headers of [teacher,student])assert.equal((await restricted.app.inject({url:'/api/session',headers})).statusCode,200);
      assert.equal((await restricted.app.inject({url:'/api/session',headers:virtual})).statusCode,401);
      assert.equal(f.db.withTransaction(tx=>tx.get("SELECT active FROM course_memberships WHERE course_id='course' AND user_id='other'")!.active),1);
      if(reviewEnabled){const workbench=await restricted.app.inject({url:'/api/courses/course/teacher-workbench',headers:teacher});assert.equal(workbench.statusCode,200,workbench.body);assert(workbench.json().data.members.some((member:{userId:string})=>member.userId==='other'));}
      assert.equal(f.db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length),reviewEnabled?41:35);
    }finally{await restricted?.shutdown();await f.close();}
  }
});

test('41-table teacher review and independent personal-model settings coexist in one host without a model call', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'xunjie-teacher-models-'));
  const f = await fixture(undefined, { review, personalModels: { directory, callsEnabled: false } });
  try {
    const teacher = await f.login('teacher'), student = await f.login();
    for (const headers of [teacher, student]) {
      const settings = await f.app.inject({ url: '/api/model-settings', headers });
      assert.equal(settings.statusCode, 200, settings.body);
      assert.equal(settings.json().data.callsEnabled, false);
    }
    const workbench = await f.app.inject({ url: '/api/courses/course/teacher-workbench', headers: teacher });
    assert.equal(workbench.statusCode, 200, workbench.body);
    assert.equal(workbench.json().data.courseId, 'course');
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT COUNT(*) AS n FROM jobs')!.n), 0);
  } finally { await f.close(); }
});

test('normal teacher workbench requires explicit 41-table composition and retains the default 35-table host', async () => {
  const f = await fixture();
  try {
    assert.equal(f.app.hasRoute({ method: 'GET', url: '/api/courses/:id/teacher-workbench' }), false);
    await assert.rejects(createDigitalLogicApplication({ ...f.settings, review }), /41-table scope/);
    assert.equal(f.db.withTransaction(tx => tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length), 35);
  } finally { await f.close(); }
});

test('normal review host exposes only the responsible teacher discovery; reads do not start assigned attempts', async () => {
  const f = await fixture(undefined, { review });
  try {
    const teacher = await f.login('teacher'), student = await f.login(), foreign = await f.login('foreign');
    const item = await allocate(f, teacher, student, false);
    const allocated = await command(f, teacher, `/api/activities/${item.activityId}/assignments`, { expectedActivityControlRevision: 1, studentIds: ['other'] });
    assert.equal(allocated.statusCode, 200, allocated.body);
    const before = f.db.withTransaction(tx => ({ attempts: tx.get('SELECT COUNT(*) AS n FROM attempts')!.n, jobs: tx.get('SELECT COUNT(*) AS n FROM jobs')!.n }));
    for (const headers of [undefined, student, foreign]) {
      const response = await f.app.inject({ url: '/api/courses/course/teacher-workbench', ...(headers ? { headers } : {}) });
      assert.equal(response.statusCode, headers ? 403 : 401, response.body);
      assert(!response.body.includes('PRIVATE_BODY'));
    }
    const response = await f.app.inject({ url: '/api/courses/course/teacher-workbench', headers: teacher });
    assert.equal(response.statusCode, 200, response.body);
    const data = teacherWorkbenchSchema.parse(response.json().data);
    assert.equal(data.recoveryGeneration, 'generation'); assert.equal(data.courseId, 'course');
    assert.deepEqual(data.members.map(member => member.userId), ['other', 'student']);
    assert.equal(data.assignments.length, 2); assert.equal(data.attempts.length, 1);
    assert.equal(data.attempts[0]!.latestSubmission, null);
    assert.equal(data.resources[0]!.material.text, 'PRIVATE_BODY');
    assert.equal(data.presets[0]!.content.helpPolicyVersionId, 'course-help');
    assert.equal(data.presets[0]!.content.checkRuleVersionId, 'textscope-core-v1');
    assert.equal(data.presets[0]!.helpPolicy.versionId, data.presets[0]!.content.helpPolicyVersionId);
    assert.equal(data.courseName, undefined); assert.equal(data.members[0]!.displayName, undefined); assert.equal(data.assignments[0]!.displayTitle, undefined);
    assert(!response.body.includes('password_hash')); assert(!response.body.includes('csrf_hash'));
    assert.deepEqual(f.db.withTransaction(tx => ({ attempts: tx.get('SELECT COUNT(*) AS n FROM attempts')!.n, jobs: tx.get('SELECT COUNT(*) AS n FROM jobs')!.n })), before);
    f.db.withTransaction(tx => {
      tx.run("UPDATE courses SET name='  Real Course  ' WHERE id='course'");
      tx.run("UPDATE users SET display_name='  Real Learner  ' WHERE id='student'");
      tx.run("UPDATE assignments SET display_title='  Real Assignment  ' WHERE id=?", item.assignmentId);
    });
    const named = (await f.app.inject({ url: '/api/courses/course/teacher-workbench', headers: teacher })).json().data;
    assert.equal(named.courseName, 'Real Course');
    assert.equal(named.members.find((row: { userId: string }) => row.userId === 'student').displayName, 'Real Learner');
    assert.equal(named.assignments.find((row: { assignmentId: string }) => row.assignmentId === item.assignmentId).displayTitle, 'Real Assignment');
    f.db.withTransaction(tx => tx.run("UPDATE course_memberships SET active=0 WHERE course_id='course' AND user_id='other'"));
    const withdrawn = (await f.app.inject({ url: '/api/courses/course/teacher-workbench', headers: teacher })).json().data;
    assert.deepEqual(withdrawn.members, [{ userId: 'student', displayName: 'Real Learner' }]);
    assert.equal(withdrawn.assignments.find((row: { studentId: string }) => row.studentId === 'other').active, false);
    assert.equal(f.db.withTransaction(tx => tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length), 41);
  } finally { await f.close(); }
});

test('retained databases without display columns keep session, course, assignment, bootstrap and teacher workbench reads usable', async () => {
  const f = await fixture(undefined, { review });
  let legacyHost: Awaited<ReturnType<typeof createDigitalLogicApplication>> | undefined;
  try {
    const teacher = await f.login('teacher'), student = await f.login();
    const item = await allocate(f, teacher, student, false);
    // A capability view models the older three-column absence without dropping or altering any schema. It
    // rejects exactly the SQL an old SQLite schema rejects and removes only the absent display metadata.
    const strip = (row: SqlRow | undefined) => {
      if (!row) return row;
      const copy = { ...row }; delete copy.display_name; delete copy.display_title; return copy;
    };
    const forbid = (sql: string) => {
      if (/\b(?:display_name|display_title)\b|\bc\.name\b|\bSELECT name FROM courses\b/i.test(sql)) throw new Error('no such display column');
    };
    const legacy: SyntheticDatabase = { ...f.db, withTransaction(work) { return f.db.withTransaction(tx => work({ ...tx,
      get(sql, ...params) { if (sql.includes('pragma_table_info')) return undefined; forbid(sql); return strip(tx.get(sql, ...params)); },
      all(sql, ...params) { forbid(sql); return tx.all(sql, ...params).map(row => strip(row)!); },
    })); } };
    legacyHost = await createDigitalLogicApplication({ ...f.settings, db: legacy, review });
    for (const url of ['/api/session', '/api/courses', '/api/courses/course/assignments', `/api/assignments/${item.assignmentId}`,
      `/api/assignments/${item.assignmentId}/bootstrap`, '/api/courses/course/teacher-workbench']) {
      const response: { statusCode: number; body: string } = await legacyHost.app.inject({ url, headers: teacher });
      assert.equal(response.statusCode, 200, response.body);
      assert(!response.body.includes('displayName')); assert(!response.body.includes('courseName')); assert(!response.body.includes('displayTitle'));
    }
    assert.equal(f.db.withTransaction(tx => tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length), 41);
  } finally { await legacyHost?.shutdown(); await f.close(); }
});

for (const hdl of [false, true]) test(`normal ${hdl ? 'HDL' : 'C'} host fixes submission, saves feedback, grants and consumes student revision without replacing history`, async () => {
  const f = await fixture(undefined, { review });
  try {
    const teacher = await f.login('teacher'), student = await f.login();
    const item = await allocate(f, teacher, student, hdl);
    const head = await view(f, student, item.attemptId);
    const submitted = await command(f, student, `/api/attempts/${item.attemptId}/submissions`, { expectedAttemptRevision: head.attempt.attemptRevision, snapshotId: item.snapshotId, reflection: 'Synthetic learner reflection' });
    assert.equal(submitted.statusCode, 200, submitted.body);
    const submissionId = submitted.json().data.result.submissionId;
    const context = async () => {
      const response = await f.app.inject({ url: `/api/attempts/${item.attemptId}/review-context`, headers: teacher });
      assert.equal(response.statusCode, 200, response.body); return response.json().data;
    };
    const original = await context();
    assert.equal(original.submission.submissionId, submissionId); assert.equal(original.artifactSnapshotId, item.snapshotId);
    assert.equal(original.submission.reflection, 'Synthetic learner reflection');
    const feedbackBody = { expectedAttemptRevision: original.attempt.attemptRevision, expectedStateRevision: original.learnerStateRevision,
      expectedFeedbackRevision: original.feedback.feedbackRevision, submissionId, kind: 'submission_review', summary: 'Explain the next boundary case.', reason: 'Review of this fixed version',
      evidenceRefs: [{ kind: 'snapshot', id: item.snapshotId, attemptId: item.attemptId }] };
    const forbidden = await command(f, student, `/api/attempts/${item.attemptId}/feedback`, feedbackBody);
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    const saved = await command(f, teacher, `/api/attempts/${item.attemptId}/feedback`, feedbackBody, 'formal-feedback');
    assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().data.result.reviewed, true);
    const replay = await command(f, teacher, `/api/attempts/${item.attemptId}/feedback`, feedbackBody, 'formal-feedback');
    assert.equal(replay.statusCode, 200, replay.body); assert.deepEqual(replay.json().data.result, saved.json().data.result);
    const recovery = await f.app.inject({ url: `/api/attempts/${item.attemptId}/recovery`, headers: student });
    assert.equal(recovery.json().data.feedback.status, 'available');
    const reviewed = await context();
    const grant = await command(f, teacher, `/api/attempts/${item.attemptId}/reopen`, { expectedAttemptRevision: reviewed.attempt.attemptRevision, submissionId, reason: 'Please make the boundary explicit.' });
    assert.equal(grant.statusCode, 200, grant.body);
    const beforeResume = await view(f, student, item.attemptId); assert.equal(beforeResume.attempt.status, 'reviewed');
    const resumed = await command(f, student, `/api/attempts/${item.attemptId}/controls`, { expectedAttemptRevision: beforeResume.attempt.attemptRevision, control: { kind: 'resume_revision' } });
    assert.equal(resumed.statusCode, 200, resumed.body);
    const active = await view(f, student, item.attemptId); assert.equal(active.attempt.status, 'active');
    const file = active.files.find((row: { lifecycle: string }) => row.lifecycle === 'active');
    const changed = await command(f, student, `/api/attempts/${item.attemptId}/sync`, { expectedWorkspaceRevision: active.attempt.workspaceRevision, clientId: 'revision-page', clientSeq: 1,
      operations: [{ kind: 'update', fileId: file.fileId, baseVersion: file.documentVersion, text: hdl ? 'module top; wire revision_seen; endmodule' : 'int main(void){return 1;}' }] });
    assert.equal(changed.statusCode, 200, changed.body);
    const after = await context();
    assert.deepEqual(after.artifact, original.artifact); assert.equal(after.artifactSnapshotId, original.artifactSnapshotId);
    assert.notEqual(after.workspaceFiles[0].contentHash, original.artifact[0].contentHash);
    assert.equal(after.reopen.state, 'consumed');
    const feedback = await f.app.inject({ url: `/api/attempts/${item.attemptId}/feedback`, headers: student });
    assert.equal(feedback.json().data.entries[0].summary, feedbackBody.summary);
  } finally { await f.close(); }
});
