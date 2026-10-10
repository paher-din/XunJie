import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createCompletionDatabase, openSyntheticDatabase } from '../server/db/transaction.ts';
import { createVerificationApp } from '../server/access/app.ts';
import { createPasswordRecord } from '../server/access/password.ts';
import { ApiError } from '../server/app/errors.ts';
import { parseRequest } from '../server/app/validation.ts';
import { finishRecordCommand, readAttempt, saveAttempt, enqueueStoredJob, readJobs } from '../server/db/records-adapter.ts';
import type { Job } from '../contracts/records/index.ts';
const origin = 'https://synthetic.example';
const schema = z.strictObject({ expectedRevision: z.number().int().positive(), recoveryGeneration: z.string(), fail: z.boolean().default(false) });
async function fixture() {
  let db = createCompletionDatabase();
  const password = randomBytes(32).toString('base64url'), secret = randomBytes(48).toString('hex');
  const record = await createPasswordRecord(password);
  db.withTransaction(tx => {
    for (const user of ['student', 'other', 'teacher']) tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES (?,?,?,?,?,?,?,?,?)',
      user, user, record.hash, record.salt, 'scrypt', 131072, 8, 1, 64);
    tx.run('INSERT INTO courses(id) VALUES (?)', 'course');
    for (const user of ['student', 'other', 'teacher']) tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,1)', 'course', user, user === 'teacher' ? 'teacher' : 'student');
    tx.run('INSERT INTO blueprint_drafts(id,course_id,created_by,created_at_ms,revision,draft_json) VALUES (?,?,?,?,?,?)', 'blueprint', 'course', 'teacher', Date.now(), 1, '{}');
    tx.run('INSERT INTO activity_versions(id,course_id,blueprint_id,source_revision,created_by,created_at_ms,activity_json,content_hash) VALUES (?,?,?,?,?,?,?,?)', 'activity', 'course', 'blueprint', 1, 'teacher', Date.now(), '{}', 'a'.repeat(64));
    tx.run('INSERT INTO activity_controls(activity_id,control_revision,status,reason,controlled_by,controlled_at_ms) VALUES (?,1,?,?,?,?)', 'activity', 'active', '', 'teacher', Date.now());
    tx.run('INSERT INTO assignments(id,course_id,student_id,activity_id,assignment_revision,status,individual_paused,paused_by_activity,individual_reason,activity_reason,controlled_by,controlled_at_ms) VALUES (?,?,?,?,1,?,0,0,?,?,?,?)',
      'assignment', 'course', 'student', 'activity', 'active', '', '', 'teacher', Date.now());
    saveAttempt(tx, { attemptId: 'attempt', courseId: 'course', studentId: 'student', assignmentId: 'assignment', activityVersionId: 'activity',
      status: 'active', attemptRevision: 1, workspaceRevision: 0, decisionEpoch: 0, captureRevision: 0, collecting: true, reminders: false });
  });
  const create = async () => {
    const instance = await createVerificationApp({ db, origin, signingSecret: secret });
    instance.app.post('/fixture/jobs', request => {
      const input = parseRequest(schema, request.body);
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !key) throw new ApiError('INVALID_REQUEST');
      const data = instance.access.withAuthorizedResource(request, tx => {
        const attempt = readAttempt(tx, 'attempt');
        return { kind: 'student_work', courseId: attempt.courseId, studentId: attempt.studentId, stage: attempt.status, assignmentActive: true };
      }, 'student_help', (tx, actor) => {
        if (input.recoveryGeneration !== 'generation') throw new ApiError('RECOVERY_REQUIRED');
        let job: Job | undefined;
        const receipt = finishRecordCommand(tx, { actorId: actor.userId, command: 'help', target: 'attempt', scope: { courseId: actor.courseId, studentId: actor.userId, attemptId: 'attempt' },
          idempotencyKey: key, recoveryGeneration: input.recoveryGeneration }, input, 'generation', Date.now(), receiptId => {
          const attempt = readAttempt(tx, 'attempt');
          if (attempt.attemptRevision !== input.expectedRevision) throw new ApiError('VERSION_CONFLICT');
          const now = Date.now(), jobId = randomUUID();
          saveAttempt(tx, { ...attempt, attemptRevision: attempt.attemptRevision + 1, decisionEpoch: attempt.decisionEpoch + 1 });
          job = { jobId, kind: 'help', purpose: 'student_help', scope: { courseId: actor.courseId, studentId: actor.userId, attemptId: 'attempt' },
            requestReceiptId: receiptId, status: 'queued', stopRequested: false, expectedRevision: 2, decisionEpoch: 1, recoveryGeneration: 'generation',
            acceptedAt: new Date(now).toISOString(), deadline: new Date(now + 45000).toISOString(), attemptCount: 0 };
          return { jobId, attemptRevision: 2 };
        });
        if (job) enqueueStoredJob(tx, job);
        if (input.fail) tx.run('INSERT INTO courses(id) VALUES (?)', 'course');
        return receipt;
      });
      return { requestId: request.id, data };
    });
    instance.app.get('/fixture/jobs', request => ({ requestId: request.id, data: instance.access.withAuthorizedResource(request, tx => {
      const attempt = readAttempt(tx, 'attempt');
      return { kind: 'student_work', courseId: attempt.courseId, studentId: attempt.studentId, stage: attempt.status, assignmentActive: true };
    }, 'read', (tx, actor) => readJobs(tx, actor.courseId).map(job => ({ jobId: job.jobId, status: job.status, stopRequested: job.stopRequested }))) }));
    return instance;
  };
  let instance = await create();
  async function login(user = 'student') {
    const response = await instance.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: user, password } });
    assert.equal(response.statusCode, 200);
    return { cookie: response.cookies.filter(c => c.value).map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; '), csrf: response.json().data.csrfToken as string };
  }
  return { login, get app() { return instance.app; }, get db() { return db; },
    restart: async () => { const file = db.file; await instance.app.close(); db.close(); db = openSyntheticDatabase(file); instance = await create(); },
    close: async () => { await instance.app.close(); db.close(); } };
}
function command(f: Awaited<ReturnType<typeof fixture>>, signed: { cookie: string; csrf: string }, key: string, fields: Record<string, unknown> = {}) {
  return f.app.inject({ method: 'POST', url: '/fixture/jobs', headers: { origin, cookie: signed.cookie, 'x-csrf-token': signed.csrf, 'idempotency-key': key },
    payload: { expectedRevision: 1, recoveryGeneration: 'generation', ...fields } });
}
test('shared C records commit once with actual Session, Attempt and Job, replay before CAS, and survive reopen', async () => {
  const f = await fixture();
  try {
    const signed = await f.login();
    const first = await command(f, signed, 'same');
    assert.equal(first.statusCode, 200);
    const duplicate = await command(f, signed, 'same');
    assert.equal(duplicate.statusCode, 200);
    assert.deepEqual(duplicate.json().data, first.json().data);
    assert.equal((await command(f, signed, 'same', { expectedRevision: 2 })).statusCode, 409);
    await f.restart();
    assert.deepEqual((await command(f, signed, 'same')).json().data, first.json().data);
    assert.equal((await f.app.inject({ url: '/fixture/jobs', headers: { cookie: signed.cookie } })).json().data.length, 1);
    const session = await f.app.inject({ url: '/api/session', headers: { cookie: signed.cookie } });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().data.csrfToken, signed.csrf);
    assert.deepEqual(session.json().data.courses, [{ courseId: 'course', role: 'student' }]);
    const counts = f.db.withTransaction(tx => ({ events: tx.get('SELECT COUNT(*) AS n FROM audit_events')!.n, receipts: tx.get('SELECT COUNT(*) AS n FROM command_receipts')!.n,
      attempt: readAttempt(tx, 'attempt') }));
    assert.equal(counts.events, 1); assert.equal(counts.receipts, 1); assert.equal(counts.attempt.attemptRevision, 2);
  } finally { await f.close(); }
});
test('late actual SQL failure rolls back Attempt, Job, C receipt/event and Session; failed command can explicitly retry', async () => {
  const f = await fixture();
  try {
    const signed = await f.login();
    const before = f.db.withTransaction(tx => tx.get('SELECT last_active_at_ms FROM sessions')!.last_active_at_ms);
    const failed = await command(f, signed, 'failed', { fail: true });
    assert.equal(failed.statusCode, 503); assert.equal(failed.json().data, undefined);
    f.db.withTransaction(tx => {
      assert.equal(readAttempt(tx, 'attempt').attemptRevision, 1);
      for (const table of ['jobs', 'audit_events', 'command_receipts']) assert.equal(tx.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n, 0);
      assert.equal(tx.get('SELECT last_active_at_ms FROM sessions')!.last_active_at_ms, before);
    });
    assert.equal((await command(f, signed, 'failed')).statusCode, 200);
  } finally { await f.close(); }
});
test('current resource owner, generation and role are checked before stored C results', async () => {
  const f = await fixture();
  try {
    const own = await f.login();
    assert.equal((await command(f, own, 'private')).statusCode, 200);
    const other = await f.login('other'), teacher = await f.login('teacher');
    assert.equal((await command(f, other, 'private')).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/fixture/jobs', headers: { cookie: other.cookie } })).statusCode, 403);
    assert.equal((await command(f, teacher, 'private')).statusCode, 403);
    assert.equal((await command(f, own, 'private', { recoveryGeneration: 'old' })).statusCode, 409);
    assert.equal((await command(f, own, 'private', { role: 'teacher' })).statusCode, 400);
    f.db.withTransaction(tx => tx.run('UPDATE course_memberships SET active=0 WHERE user_id=?', 'student'));
    assert.equal((await command(f, own, 'private')).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/api/session' })).statusCode, 401);
  } finally { await f.close(); }
});
