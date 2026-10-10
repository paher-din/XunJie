import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createCompletionDatabase, openSyntheticDatabase } from '../server/db/transaction.ts';
import { createPasswordRecord } from '../server/access/password.ts';
import { createDesignApp } from '../server/design/application.ts';
import { readAssignment } from '../server/design/activities.ts';
import { readAttempt, saveAttempt, finishRecordCommand, enqueueStoredJob, readJobs, saveJob } from '../server/db/records-adapter.ts';
import { claimJob } from '../server/records/jobs.ts';
import { ApiError } from '../server/app/errors.ts';
import type { Job } from '../contracts/records/index.ts';
import type { RunnerTransport } from '../server/records/runner.ts';

const origin = 'https://synthetic.example';
const profile = { runtimeProfileVersion: 'runtime-v1', imageDigest: 'sha256:' + 'a'.repeat(64), compilerImage: 'sha256:' + 'b'.repeat(64), runtimeImage: 'sha256:' + 'c'.repeat(64), approvedResultFiles: ['report.txt'] };
async function fixture() {
  let db = createCompletionDatabase();
  const password = randomBytes(32).toString('base64url'), record = await createPasswordRecord(password);
  db.withTransaction(tx => {
    for (const user of ['teacher', 'student', 'other', 'foreign']) tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES (?,?,?,?,?,?,?,?,?)', user, user, record.hash, record.salt, 'scrypt', 131072, 8, 1, 64);
    for (const course of ['course', 'foreign-course']) tx.run('INSERT INTO courses(id) VALUES (?)', course);
    for (const [course, user, role] of [['course','teacher','teacher'],['course','student','student'],['course','other','student'],['foreign-course','foreign','teacher']]) tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,1)', course!, user!, role!);
  });
  let ready = true, generation = 'generation';
  const secret = randomBytes(48).toString('hex');
  const runner: RunnerTransport = async () => ({ data: { ready, ...profile, recoveryGeneration: generation, fingerprint: { profile } } });
  const options = () => ({ db, origin, signingSecret: secret, currentGeneration: () => generation, runner });
  let service = await createDesignApp(options());
  function register() {
    service.app.post('/fixture/jobs/:assignment', request => {
      const assignmentId = (request.params as { assignment: string }).assignment;
      const { queuedRun } = z.strictObject({ queuedRun: z.boolean().optional() }).parse(request.body);
      const data = service.access.withAuthorizedCourse(request, 'course', 'student', (tx, actor) => {
        const available = service.design.readAssignmentInTransaction(tx, actor, assignmentId);
        if (!available.active) throw new ApiError('STATE_CONFLICT');
        const assignment = readAssignment(tx, actor.courseId, assignmentId), attemptId = 'attempt-' + assignmentId;
        const attempt = { attemptId, courseId: actor.courseId, studentId: actor.userId, assignmentId, activityVersionId: assignment.activity_id,
          status: 'paused' as const, attemptRevision: 1, workspaceRevision: 0, decisionEpoch: 0, captureRevision: 0, collecting: false, reminders: false };
        saveAttempt(tx, attempt);
        const scope = { courseId: actor.courseId, studentId: actor.userId, attemptId };
        const jobs: Job[] = [];
        const receipt = finishRecordCommand(tx, { actorId: actor.userId, command: 'fixture.jobs', target: assignmentId, scope, idempotencyKey: 'fixture-' + assignmentId, recoveryGeneration: generation }, {}, generation, Date.now(), receiptId => {
          const acceptedAt = new Date().toISOString(), deadline = new Date(Date.now() + 30000).toISOString();
          for (const purpose of ['student_help','student_run'] as const) jobs.push({ jobId: randomUUID(), kind: purpose, purpose, scope, requestReceiptId: receiptId,
            status: 'queued', stopRequested: false, expectedRevision: 1, decisionEpoch: 0, recoveryGeneration: generation, acceptedAt, deadline, attemptCount: 0,
            ...(purpose === 'student_run' ? { runId: randomUUID() } : {}) });
          return { attemptId, jobIds: jobs.map(job => job.jobId) };
        }, value => z.strictObject({ attemptId: z.string(), jobIds: z.array(z.string()) }).parse(value));
        for (const job of jobs) {
          enqueueStoredJob(tx, job);
          if (job.purpose === 'student_run' && !queuedRun) saveJob(tx, claimJob(job, 'synthetic-lease', new Date(Date.now() + 20000).toISOString(), generation, new Date().toISOString()));
        }
        return receipt.result;
      });
      return { data };
    });
    service.app.get('/fixture/jobs/:assignment', request => {
      const assignmentId = (request.params as { assignment: string }).assignment;
      return { data: service.access.withAuthorizedCourse(request, 'course', 'student', (tx, actor) => {
        service.design.readAssignmentInTransaction(tx, actor, assignmentId);
        return { attempt: readAttempt(tx, 'attempt-' + assignmentId), jobs: readJobs(tx, actor.courseId).filter(job => job.scope.attemptId === 'attempt-' + assignmentId) };
      }) };
    });
    service.app.get('/fixture/tutor/:activity', request => ({ data: service.design.readTutorActivity(request, (request.params as { activity: string }).activity) }));
    service.app.post('/fixture/policy', request => ({ data: service.design.configurePolicy(request, 'course', request.body) }));
    service.app.post('/fixture/rule', request => ({ data: service.design.configureRule(request, 'course', request.body) }));
  }
  register();
  async function login(user = 'teacher') {
    const res = await service.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: user, password } });
    assert.equal(res.statusCode, 200);
    return { origin, cookie: res.cookies.filter(c => c.value).map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; '), 'x-csrf-token': res.json().data.csrfToken as string };
  }
  return { signingSecret: secret, login, get app() { return service.app; }, get db() { return db; }, generation: () => generation,
    unavailable() { ready = false; }, restore() { generation = 'new-generation'; },
    async reopen() { const file = db.file; await service.app.close(); db.close(); db = openSyntheticDatabase(file); service = await createDesignApp(options()); register(); },
    async close() { await service.app.close(); db.close(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Headers = Awaited<ReturnType<Fixture['login']>>;
function command(f: Fixture, headers: Headers, url: string, payload: object, key: string = randomUUID(), method: 'POST'|'PATCH' = 'POST') {
  return f.app.inject({ method, url, headers: { ...headers, 'idempotency-key': key }, payload: { recoveryGeneration: f.generation(), ...payload } });
}
async function draft(f: Fixture, headers: Headers) {
  assert.equal((await f.app.inject({ method: 'POST', url: '/fixture/policy', headers, payload: { versionId: 'help-v1', helpAllowed: true, wholeSolutionAllowed: false, limitedCheckHelpAllowed: false, description: 'Teacher help policy' } })).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'POST', url: '/fixture/rule', headers, payload: { versionId: 'textscope-core-v1', validatorVersion: 'textscope-validator-v1', limitedHelp: false, description: 'Trusted core checks' } })).statusCode, 200);
  const materials = [];
  for (const kind of ['learning_material', 'private_answer'] as const) {
    const res = await command(f, headers, '/api/courses/course/resources', { teacherDesignAllowed: true, material: { format: 'txt', title: kind === 'private_answer' ? 'PRIVATE_TITLE' : 'Reading', content: kind === 'private_answer' ? 'PRIVATE_BODY' : 'abc', kind, visibility: { student: kind === 'learning_material', tutor: kind === 'learning_material' } } });
    assert.equal(res.statusCode, 200); materials.push(res.json().data.result.resourceVersion.resourceVersionId as string);
  }
  const goals = [{ competencyId: 'k', competencyVersion: 1, domain: 'domain', title: 'Explain pointers' }, { competencyId: 'p', competencyVersion: 1, domain: 'project', title: 'Compare routes' }, { competencyId: 'a', competencyVersion: 1, domain: 'ai_collaboration', title: 'Check suggestions' }];
  const refs = goals.map(({ competencyId, competencyVersion }) => ({ competencyId, competencyVersion }));
  const content = { projectTitle: 'Synthetic', problem: 'Explore text', audience: 'Peers', artifact: 'C source', routes: ['array','tree'], goals,
    tasks: [{ taskId: 't', title: 'Compare', goalRefs: refs }], observations: [{ observationId: 'o', description: 'Explain decisions', goalRefs: refs, taskIds: ['t'] }],
    rubricCriteria: [{ criterionId: 'r', description: 'Reasoning', goalRefs: refs, observationIds: ['o'] }], milestones: [{ milestoneId: 'm', title: 'Review', taskIds: ['t'] }],
    resources: materials.map(resourceVersionId => ({ resourceVersionId })), helpPolicyVersionId: 'help-v1', checkRuleVersionId: 'textscope-core-v1', runtimeProfileVersionId: profile.runtimeProfileVersion };
  const res = await command(f, headers, '/api/courses/course/blueprints', { mode: 'manual', content });
  assert.equal(res.statusCode, 200);
  return { id: res.json().data.result.draft.blueprintId as string, materials };
}

test('teacher checks and fixes a version; only its assigned student reads approved material after reopen', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login(), student = await f.login('student'), other = await f.login('other');
    const initial = await draft(f, teacher);
    const checks = await command(f, teacher, `/api/blueprints/${initial.id}/checks`, { expectedRevision: 1 });
    assert.equal(checks.statusCode, 200); assert.deepEqual(checks.json().data.result.report.blocking, []);
    const input = { expectedRevision: 1, confirmed: true };
    const released = await command(f, teacher, `/api/blueprints/${initial.id}/releases`, input, 'release');
    assert.equal(released.statusCode, 200, released.body);
    const activityId = released.json().data.result.activityVersionId as string;
    assert.equal((await f.app.inject({ url: `/api/activities/${activityId}`, headers: student })).statusCode, 403);
    const assigned = await command(f, teacher, `/api/activities/${activityId}/assignments`, { expectedActivityControlRevision: 1, studentIds: ['student'] });
    assert.equal(assigned.statusCode, 200, assigned.body);
    assert.equal((await command(f, teacher, `/api/blueprints/${initial.id}`, { expectedRevision: 1, patch: { projectTitle: 'Later draft' } }, randomUUID(), 'PATCH')).statusCode, 200);
    f.unavailable();
    assert.deepEqual((await command(f, teacher, `/api/blueprints/${initial.id}/releases`, input, 'release')).json().data, released.json().data);
    await f.reopen();
    const visible = await f.app.inject({ url: `/api/activities/${activityId}`, headers: student });
    assert.equal(visible.statusCode, 200, visible.body); assert.equal(visible.json().data.content.content.projectTitle, 'Synthetic');
    for (const secret of ['PRIVATE_TITLE','PRIVATE_BODY',initial.materials[1]!]) assert.ok(!visible.body.includes(secret));
    assert.equal((await f.app.inject({ url: `/api/activities/${activityId}`, headers: other })).statusCode, 403);
    assert.equal((await f.app.inject({ url: `/api/blueprints/${initial.id}`, headers: student })).statusCode, 403);
    assert.equal((await f.app.inject({ url: `/api/resources/${initial.materials[0]}`, headers: student })).statusCode, 200);
    assert.equal((await f.app.inject({ url: `/api/resources/${initial.materials[1]}`, headers: student })).statusCode, 403);
    assert.equal((await f.app.inject({ url: `/api/resources/${initial.materials[0]}`, headers: other })).statusCode, 403);
  } finally { await f.close(); }
});
async function releaseAndAssign(f: Fixture, teacher: Headers, students = ['student','other']) {
  const initial = await draft(f, teacher);
  const res = await command(f, teacher, `/api/blueprints/${initial.id}/releases`, { expectedRevision: 1, confirmed: true });
  assert.equal(res.statusCode, 200, res.body);
  const activityId = res.json().data.result.activityVersionId as string;
  const assigned = await command(f, teacher, `/api/activities/${activityId}/assignments`, { expectedActivityControlRevision: 1, studentIds: students });
  assert.equal(assigned.statusCode, 200, assigned.body);
  return { activityId, blueprintId: initial.id, materials: initial.materials, assignments: assigned.json().data.result.assignments as { assignmentId: string; studentId: string }[] };
}

test('activity pause atomically stops teaching jobs and requests run cancellation; resume retains individual and Attempt pauses', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login(), student = await f.login('student'), other = await f.login('other');
    const released = await releaseAndAssign(f, teacher);
    const assignment = released.assignments.find(a => a.studentId === 'student')!.assignmentId;
    const otherAssignment = released.assignments.find(a => a.studentId === 'other')!.assignmentId;
    for (const [id, headers] of [[assignment, student], [otherAssignment, other]] as const) {
      const created = await f.app.inject({ method: 'POST', url: `/fixture/jobs/${id}`, headers, payload: {} });
      assert.equal(created.statusCode, 200, created.body);
    }
    const individual = await command(f, teacher, `/api/assignments/${assignment}/controls`, { expectedAssignmentRevision: 1, action: 'pause', reason: 'individual pause' });
    assert.equal(individual.statusCode, 200, individual.body);
    const pause = await command(f, teacher, `/api/activities/${released.activityId}/controls`, { expectedActivityControlRevision: 1, action: 'pause', reason: 'course pause' }, 'pause');
    assert.equal(pause.statusCode, 200, pause.body);
    assert.deepEqual((await command(f, teacher, `/api/activities/${released.activityId}/controls`, { expectedActivityControlRevision: 1, action: 'pause', reason: 'course pause' }, 'pause')).json().data, pause.json().data);
    const current = (await f.app.inject({ url: `/fixture/jobs/${assignment}`, headers: student })).json().data;
    assert.equal(current.attempt.status, 'paused'); assert.equal(current.attempt.decisionEpoch, 2);
    assert.equal(current.jobs.find((job: Job) => job.purpose === 'student_help').status, 'cancelled');
    const run = current.jobs.find((job: Job) => job.purpose === 'student_run');
    assert.equal(run.status, 'cancelling'); assert.equal(run.stopRequested, true); assert.ok(run.runId);
    assert.equal((await command(f, teacher, `/api/assignments/${assignment}/controls`, { expectedAssignmentRevision: 3, action: 'resume', reason: 'blocked' })).statusCode, 409);
    const noop = await command(f, teacher, `/api/activities/${released.activityId}/controls`, { expectedActivityControlRevision: 2, action: 'pause', reason: 'same state' });
    assert.equal(noop.statusCode, 200); assert.equal(noop.json().data.result.activityControlRevision, 2);
    assert.equal((await command(f, teacher, `/api/activities/${released.activityId}/assignments`, { expectedActivityControlRevision: 2, studentIds: ['student'] })).statusCode, 409);
    const resume = await command(f, teacher, `/api/activities/${released.activityId}/controls`, { expectedActivityControlRevision: 2, action: 'resume', reason: 'activity restored' });
    assert.equal(resume.statusCode, 200, resume.body);
    const ownRead = await f.app.inject({ url: `/api/assignments/${assignment}`, headers: student });
    assert.equal(ownRead.json().data.active, false); assert.equal(ownRead.json().data.reasons.individual, 'individual pause');
    assert.equal((await f.app.inject({ url: `/api/assignments/${otherAssignment}`, headers: other })).json().data.active, true);
    assert.equal((await f.app.inject({ url: `/api/assignments/${otherAssignment}`, headers: student })).statusCode, 403);
    await f.reopen();
    assert.deepEqual((await f.app.inject({ url: `/fixture/jobs/${assignment}`, headers: student })).json().data, current);
    assert.equal((await command(f, teacher, `/api/assignments/${assignment}/controls`, { expectedAssignmentRevision: 4, action: 'resume', reason: 'individual restored' })).statusCode, 200);
    assert.deepEqual((await f.app.inject({ url: `/fixture/jobs/${assignment}`, headers: student })).json().data, current);
  } finally { await f.close(); }
});
test('release rejects missing readiness, unresolved concerns, stale revisions and forged authorization; batch assignment is atomic', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login(), student = await f.login('student'), foreign = await f.login('foreign');
    const initial = await draft(f, teacher), url = `/api/blueprints/${initial.id}/releases`;
    assert.equal((await command(f, student, url, { expectedRevision: 1, confirmed: true })).statusCode, 403);
    assert.equal((await command(f, foreign, url, { expectedRevision: 1, confirmed: true })).statusCode, 403);
    assert.equal((await command(f, teacher, url, { expectedRevision: 1, confirmed: true, ready: true, role: 'teacher' })).statusCode, 400);
    assert.equal((await command(f, teacher, url, { expectedRevision: 1, confirmed: true, concerns: [{ code: 'time', path: 'timeConstraints', reason: 'Needs review' }] })).statusCode, 422);
    assert.equal((await command(f, teacher, url, { expectedRevision: 2, confirmed: true })).statusCode, 409);
    f.unavailable();
    const notReady = await command(f, teacher, url, { expectedRevision: 1, confirmed: true });
    assert.equal(notReady.statusCode, 422); assert.equal(notReady.json().error.code, 'RUNTIME_NOT_READY');
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT COUNT(*) AS n FROM activity_versions')!.n), 0);
    assert.equal((await command(f, teacher, `/api/blueprints/${initial.id}`, { expectedRevision: 1, patch: { projectTitle: 'Editable without runner' } }, randomUUID(), 'PATCH')).statusCode, 200);
  } finally { await f.close(); }
  const next = await fixture();
  try {
    const teacher = await next.login(), student = await next.login('student');
    const initial = await draft(next, teacher);
    const release = await command(next, teacher, `/api/blueprints/${initial.id}/releases`, { expectedRevision: 1, confirmed: true });
    assert.equal(release.statusCode, 200);
    const id = release.json().data.result.activityVersionId as string;
    assert.equal((await command(next, teacher, `/api/activities/${id}/assignments`, { expectedActivityControlRevision: 1, studentIds: ['student','foreign'] })).statusCode, 403);
    assert.equal((await next.app.inject({ url: `/api/activities/${id}`, headers: student })).statusCode, 403);
    const assigned = await command(next, teacher, `/api/activities/${id}/assignments`, { expectedActivityControlRevision: 1, studentIds: ['student'] }, 'assign');
    assert.equal(assigned.statusCode, 200);
    assert.equal((await command(next, teacher, `/api/activities/${id}/assignments`, { expectedActivityControlRevision: 1, studentIds: ['other'] }, 'assign')).statusCode, 409);
    next.restore();
    assert.equal((await command(next, teacher, `/api/activities/${id}/assignments`, { expectedActivityControlRevision: 1, studentIds: ['student'] }, 'assign')).json().error.code, 'RECOVERY_REQUIRED');
    next.db.withTransaction(tx => tx.run("UPDATE course_memberships SET active=0 WHERE user_id='teacher' AND course_id='course'"));
    assert.equal((await command(next, teacher, `/api/activities/${id}/assignments`, { expectedActivityControlRevision: 1, studentIds: ['student'] }, 'assign')).statusCode, 403);
  } finally { await next.close(); }
});

test('late audit SQL failure leaves activity, assignment, Attempt, Job, receipts and Session unchanged', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login(), student = await f.login('student');
    const released = await releaseAndAssign(f, teacher, ['student']), assignment = released.assignments[0]!.assignmentId;
    assert.equal((await f.app.inject({ method: 'POST', url: `/fixture/jobs/${assignment}`, headers: student, payload: {} })).statusCode, 200);
    f.db.withTransaction(tx => tx.run("INSERT INTO audit_events(server_seq,event_id,actor_id,course_id,command_id,command,target,object_ref_json,recovery_generation,committed_at_ms) VALUES (9223372036854775807,'sentinel','foreign','foreign-course','sentinel','sentinel','sentinel','{}','generation',0)"));
    const before = f.db.withTransaction(tx => ({ activity: tx.get('SELECT * FROM activity_controls WHERE activity_id=?', released.activityId), assignment: tx.get('SELECT * FROM assignments WHERE id=?', assignment),
      attempt: readAttempt(tx, 'attempt-' + assignment), jobs: readJobs(tx, 'course'), receipts: tx.all('SELECT * FROM command_receipts'), events: tx.all('SELECT * FROM audit_events'), sessions: tx.all('SELECT * FROM sessions') }));
    const failed = await command(f, teacher, `/api/activities/${released.activityId}/controls`, { expectedActivityControlRevision: 1, action: 'pause', reason: 'atomic failure' });
    assert.equal(failed.statusCode, 503, failed.body); assert.equal(failed.json().data, undefined);
    const after = f.db.withTransaction(tx => ({ activity: tx.get('SELECT * FROM activity_controls WHERE activity_id=?', released.activityId), assignment: tx.get('SELECT * FROM assignments WHERE id=?', assignment),
      attempt: readAttempt(tx, 'attempt-' + assignment), jobs: readJobs(tx, 'course'), receipts: tx.all('SELECT * FROM command_receipts'), events: tx.all('SELECT * FROM audit_events'), sessions: tx.all('SELECT * FROM sessions') }));
    assert.deepEqual(after, before);
    assert.equal((await f.app.inject({ url: `/api/assignments/${assignment}`, headers: student })).json().data.active, true);
  } finally { await f.close(); }
});

async function competingService(f: Fixture) {
  const child = fork(fileURLToPath(new URL('./fixtures/activity-child.ts', import.meta.url)), [], { stdio: ['ignore','ignore','ignore','ipc'] });
  async function send(input: object) {
    const waiting = once(child, 'message', { signal: AbortSignal.timeout(15000) });
    child.send(input);
    const [response] = await waiting;
    assert.notEqual(response.kind, 'error');
    return response as { kind: string; statusCode: number; body: string };
  }
  await send({ kind: 'init', file: f.db.file, origin, signingSecret: f.signingSecret, timestamp: Date.now(), generation: f.generation() });
  return { request(headers: Headers, url: string, payload: object, key: string) {
    return send({ kind: 'request', method: 'POST', url, headers: { ...headers, 'idempotency-key': key }, payload: { recoveryGeneration: f.generation(), ...payload } });
  }, async hold() { assert.equal((await send({ kind: 'hold' })).kind, 'holding'); return { released: once(child,'message',{ signal: AbortSignal.timeout(15000) }) }; },
  async close() { const ended = once(child, 'exit', { signal: AbortSignal.timeout(15000) }); child.send({ kind: 'stop' }); assert.equal((await ended)[0],0); } };
}

test('two independent processes serialize identical receipts, reject competing control CAS and preserve state on lock busy', async () => {
  const f = await fixture();
  let child: Awaited<ReturnType<typeof competingService>> | undefined;
  try {
    const teacher = await f.login(), released = await releaseAndAssign(f, teacher, ['student']);
    child = await competingService(f);
    const url = `/api/activities/${released.activityId}/controls`, pause = { expectedActivityControlRevision: 1, action: 'pause', reason: 'same command' };
    const [one,two] = await Promise.all([command(f,teacher,url,pause,'same-control'),child.request(teacher,url,pause,'same-control')]);
    assert.equal(one.statusCode,200,one.body); assert.equal(two.statusCode,200,two.body);
    assert.deepEqual(JSON.parse(one.body).data,JSON.parse(two.body).data);
    const [first,second] = await Promise.all([command(f,teacher,url,{ expectedActivityControlRevision: 2, action: 'resume', reason: 'first' },'first'),
      child.request(teacher,url,{ expectedActivityControlRevision: 2, action: 'resume', reason: 'second' },'second')]);
    assert.deepEqual([first.statusCode,second.statusCode].sort(),[200,409]);
    const { released: releasedLock } = await child.hold();
    const busy = await command(f,teacher,url,{ expectedActivityControlRevision: 3, action: 'pause', reason: 'while busy' },'busy');
    assert.equal(busy.statusCode,503,busy.body);
    assert.equal((await releasedLock)[0].kind,'released');
    assert.equal((await f.app.inject({ url:`/api/activities/${released.activityId}`,headers:teacher })).json().data.activityControlRevision,3);
    assert.equal((await command(f,teacher,url,{ expectedActivityControlRevision: 3, action: 'pause', reason: 'while busy' },'busy')).statusCode,200);
  } finally { await child?.close(); await f.close(); }
});
test('paused assignments block tutor input and queued runs retain cancellation intent until the node confirms', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login(), student = await f.login('student');
    const released = await releaseAndAssign(f, teacher, ['student']);
    const assignment = released.assignments[0]!.assignmentId;
    const tutor = await f.app.inject({ url: `/fixture/tutor/${released.activityId}`, headers: student });
    assert.equal(tutor.statusCode, 200, tutor.body);
    for (const secret of ['PRIVATE_TITLE', 'PRIVATE_BODY', released.materials[1]!]) assert.ok(!tutor.body.includes(secret));
    assert.equal((await f.app.inject({ method: 'POST', url: `/fixture/jobs/${assignment}`, headers: student, payload: { queuedRun: true } })).statusCode, 200);
    assert.equal((await command(f, teacher, `/api/assignments/${assignment}/controls`, { expectedAssignmentRevision: 1, action: 'pause', reason: 'teacher pause' })).statusCode, 200);
    assert.equal((await f.app.inject({ url: `/fixture/tutor/${released.activityId}`, headers: student })).statusCode, 409);
    const state = (await f.app.inject({ url: `/fixture/jobs/${assignment}`, headers: student })).json().data;
    const run = state.jobs.find((job: Job) => job.purpose === 'student_run');
    assert.equal(run.status, 'cancelling'); assert.equal(run.stopRequested, true);
  } finally { await f.close(); }
});

test('a replaced material version cannot silently change the fixed activity projection', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login(), student = await f.login('student');
    const released = await releaseAndAssign(f, teacher, ['student']);
    f.db.withTransaction(tx => tx.run('UPDATE resource_versions SET title=? WHERE id=?', 'REPLACED_TITLE', released.materials[0]!));
    const response = await f.app.inject({ url: `/api/activities/${released.activityId}`, headers: student });
    assert.equal(response.statusCode, 503, response.body);
    assert.ok(!response.body.includes('REPLACED_TITLE'));
  } finally { await f.close(); }
});