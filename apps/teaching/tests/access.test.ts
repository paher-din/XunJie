import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSyntheticDatabase, openSyntheticDatabase } from '../server/db/transaction.ts';
import { createPasswordRecord } from '../server/access/password.ts';
import { createVerificationApp } from '../server/access/app.ts';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const origin = 'https://synthetic.example';
async function fixture(logDestination?: { write(message: string): void }) {
  const db = createSyntheticDatabase();
  const password = randomBytes(32).toString('base64url');
  const record = await createPasswordRecord(password);
  db.withTransaction(tx => {
    tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES (?,?,?,?,?,?,?,?,?)',
      'user', 'learner', record.hash, record.salt, 'scrypt', 131072, 8, 1, 64);
    tx.run('INSERT INTO courses(id) VALUES (?)', 'course');
    tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,?)', 'course', 'user', 'student', 1);
  });
  let now = Date.now();
  const signingSecret = randomBytes(48).toString('hex');
  const verification = await createVerificationApp({ db, origin, signingSecret, now: () => now, ...(logDestination ? { logDestination } : {}) });
  verification.app.get('/fixture/course/:id', req => ({ requestId: req.id, data: verification.access.authorizeCourse(req, (req.params as { id: string }).id) }));
  verification.app.post('/fixture/teacher/:id', req => ({ requestId: req.id, data: verification.access.authorizeCourse(req, (req.params as { id: string }).id, 'teacher') }));
  return { ...verification, db, password, signingSecret, clock: () => now, advance: (ms: number) => { now += ms; }, close: async () => { await verification.app.close(); db.close(); } };
}
async function login(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password } });
  assert.equal(response.statusCode, 200);
  return { cookie: cookieHeader(response), csrfToken: response.json().data.csrfToken as string };
}
function cookieHeader(response: { cookies: { name: string; value: string }[] }) {
  return response.cookies.filter(c => c.value).map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');
}

test('login persists a Secure session and server-side course identity; logout revokes it', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password } });
    assert.equal(response.statusCode, 200);
    const cookie = cookieHeader(response);
    assert.ok(cookie);
    assert.match(String(response.headers['set-cookie']), /HttpOnly/);
    assert.match(String(response.headers['set-cookie']), /Secure/);
    assert.match(String(response.headers['set-cookie']), /SameSite=Lax/);
    const identity = await f.app.inject({ url: '/fixture/course/course', headers: { cookie } });
    assert.equal(identity.statusCode, 200);
    assert.deepEqual(identity.json().data, { userId: 'user', courseId: 'course', role: 'student' });
    const logout = await f.app.inject({ method: 'POST', url: '/api/logout', headers: { origin, cookie, 'x-csrf-token': response.json().data.csrfToken } });
    assert.equal(logout.statusCode, 200);
    assert.equal((await f.app.inject({ url: '/fixture/course/course', headers: { cookie } })).statusCode, 401);
  } finally { await f.close(); }
});

test('account window admits ten total attempts, concurrent hashing admits two, and expiry resets the window', async () => {
  const f = await fixture();
  try {
    const requests = Array.from({ length: 12 }, () => f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password } }));
    const responses = await Promise.all(requests);
    assert.equal(responses.filter(r => r.statusCode === 200).length, 2);
    assert.equal(responses.filter(r => r.statusCode === 429).length, 10);
    const limited = await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password } });
    assert.equal(limited.statusCode, 429);
    f.advance(15 * 60 * 1000 - 1);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password } })).statusCode, 429);
    f.advance(1);
    await login(f);
    // Nine more successful attempts count too; the eleventh is rejected.
    for (let i = 0; i < 9; i++) await login(f);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password } })).statusCode, 429);
  } finally { await f.close(); }
});

test('IP throttling covers unknown accounts and survives application recreation with the same signing material', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 50; i++) {
      assert.equal((await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: `missing-${i}`, password: f.password } })).statusCode, 401);
    }
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'new-missing', password: f.password } })).statusCode, 429);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password } })).statusCode, 429);
    await f.close();
    const reopened = openSyntheticDatabase(f.db.file);
    const restarted = await createVerificationApp({ db: reopened, origin, signingSecret: f.signingSecret, now: f.clock });
    try {
      assert.equal((await restarted.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password } })).statusCode, 429);
      f.advance(15 * 60 * 1000);
      assert.equal((await restarted.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password } })).statusCode, 200);
    } finally { await restarted.app.close(); reopened.close(); }
  } finally { await f.close(); }
});

test('a real database failure during password verification cannot ACK a session or expose sensitive diagnostics', async () => {
  const logs: string[] = [];
  const f = await fixture({ write: message => { logs.push(message); } });
  try {
    const responsePromise = f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password } });
    await nextTurn();
    f.db.close();
    const response = await responsePromise;
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'PERSISTENCE_UNAVAILABLE');
    assert.equal(response.json().data, undefined);
    assert.equal(response.cookies.some(c => c.value), false);
    const visible = logs.join('') + response.body;
    for (const sensitive of [f.password, 'learner', f.db.file, 'database connection', 'password_hash', 'csrfHash']) assert.equal(visible.includes(sensitive), false);
  } finally { await f.close(); }
});

test('the mature session plugin propagates a real store save failure before an HTTP acknowledgement', async () => {
  const f = await fixture();
  let entered = false;
  let acknowledged = false;
  f.app.post('/fixture/save-failure', async request => {
    entered = true;
    f.db.close();
    await request.session.save();
    acknowledged = true;
    return { requestId: request.id, data: { saved: true } };
  });
  try {
    const signed = await login(f);
    const response = await f.app.inject({ method: 'POST', url: '/fixture/save-failure', headers: { origin, cookie: signed.cookie, 'x-csrf-token': signed.csrfToken } });
    assert.equal(entered, true);
    assert.equal(acknowledged, false);
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'PERSISTENCE_UNAVAILABLE');
    assert.equal(response.json().data, undefined);
    assert.equal(response.cookies.some(c => c.value), false);
  } finally { await f.close(); }
});

test('session identity and reserved account attempts survive an actual process restart using IPC-only signing material', { timeout: 15000 }, async t => {
  const f = await fixture();
  try {
    const responses = await Promise.all(Array.from({ length: 10 }, () => f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password } })));
    const signed = responses.find(response => response.statusCode === 200)!;
    assert.ok(signed);
    const cookie = cookieHeader(signed);
    const rows = f.db.withTransaction(tx => ({ sessions: tx.all('SELECT * FROM sessions'), windows: tx.all('SELECT * FROM login_attempt_windows'), users: tx.all('SELECT * FROM users') }));
    const stored = JSON.stringify(rows);
    for (const raw of [cookie, signed.json().data.csrfToken, f.password, '127.0.0.1']) assert.equal(stored.includes(raw), false);
    await f.close();
    const child = fork(fileURLToPath(new URL('./fixtures/auth-child.ts', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    let diagnostics = '';
    child.stderr!.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
    const message = once(child, 'message');
    child.send({ file: f.db.file, origin, signingSecret: f.signingSecret, cookie, loginName: 'learner', password: f.password });
    const received = await Promise.race([message, exited.then(() => [null])]);
    assert.deepEqual(received[0], { identityStatus: 200, loginStatus: 429 }, diagnostics);
    const exit = await exited;
    assert.equal(exit[0], 0);
    assert.equal(diagnostics, '');
  } finally { await f.close(); }
});

test('credentials and role spoofing are rejected; current course role is reread on every request', async () => {
  const f = await fixture();
  try {
    const wrong = await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password + ' ' } });
    const unknown = await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'missing', password: f.password } });
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(wrong.json().error, unknown.json().error);
    for (const forged of [{ role: 'teacher' }, { studentId: 'other' }]) {
      assert.equal((await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: 'learner', password: f.password, ...forged } })).statusCode, 400);
    }
    const signed = await login(f);
    assert.equal((await f.app.inject({ url: '/fixture/course/other', headers: signed })).statusCode, 403);
    const teacherRequest = { method: 'POST' as const, url: '/fixture/teacher/course', headers: { cookie: signed.cookie, origin, 'x-csrf-token': signed.csrfToken } };
    assert.equal((await f.app.inject(teacherRequest)).statusCode, 403);
    f.db.withTransaction(tx => {
      tx.run('INSERT INTO courses(id) VALUES (?)', 'second');
      tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,?)', 'second', 'user', 'teacher', 1);
    });
    assert.equal((await f.app.inject({ ...teacherRequest, url: '/fixture/teacher/second' })).statusCode, 200);
    assert.equal((await f.app.inject(teacherRequest)).statusCode, 403);
    f.db.withTransaction(tx => tx.run('UPDATE course_memberships SET role=? WHERE course_id=? AND user_id=?', 'teacher', 'course', 'user'));
    assert.equal((await f.app.inject(teacherRequest)).statusCode, 200);
    f.db.withTransaction(tx => tx.run('UPDATE course_memberships SET active=0 WHERE course_id=? AND user_id=?', 'course', 'user'));
    assert.equal((await f.app.inject(teacherRequest)).statusCode, 403);
    f.db.withTransaction(tx => tx.run('UPDATE users SET disabled_at_ms=? WHERE id=?', Date.now(), 'user'));
    assert.equal((await f.app.inject({ url: '/fixture/course/second', headers: { cookie: signed.cookie } })).statusCode, 401);
  } finally { await f.close(); }
});

test('Origin, JSON and session-bound CSRF are required; relogin rotates both tokens', async () => {
  const f = await fixture();
  try {
    for (const headers of [{}, { origin: 'null' }, { origin: 'https://evil.example' }, { origin: origin + '/' }, { origin: `${origin}, ${origin}` }, { host: 'synthetic.example', 'x-forwarded-proto': 'https' }]) {
      assert.equal((await f.app.inject({ method: 'POST', url: '/api/sessions', headers, payload: { loginName: 'learner', password: f.password } })).statusCode, 403);
    }
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin, 'content-type': 'text/plain' }, payload: 'ignored' })).statusCode, 400);
    const first = await login(f);
    for (const csrfToken of [undefined, '', 'forged']) {
      const headers: Record<string, string> = { origin, cookie: first.cookie };
      if (csrfToken !== undefined) headers['x-csrf-token'] = csrfToken;
      assert.equal((await f.app.inject({ method: 'POST', url: '/api/logout', headers })).statusCode, 403);
    }
    const rotated = await f.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin, cookie: first.cookie }, payload: { loginName: 'learner', password: f.password } });
    assert.equal(rotated.statusCode, 200);
    const second = { cookie: cookieHeader(rotated), csrfToken: rotated.json().data.csrfToken as string };
    assert.notEqual(first.cookie, second.cookie);
    assert.notEqual(first.csrfToken, second.csrfToken);
    assert.equal((await f.app.inject({ url: '/fixture/course/course', headers: { cookie: first.cookie } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/logout', headers: { origin, cookie: second.cookie, 'x-csrf-token': first.csrfToken } })).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/fixture/course/course', headers: { cookie: second.cookie + 'tampered' } })).statusCode, 401);
  } finally { await f.close(); }
});

test('idle and absolute deadlines reject at the exact boundary; forbidden requests do not extend activity', async () => {
  const f = await fixture();
  try {
    const signed = await login(f);
    f.advance(30 * 60 * 1000 - 1);
    assert.equal((await f.app.inject({ url: '/fixture/course/other', headers: { cookie: signed.cookie } })).statusCode, 403);
    f.advance(1);
    assert.equal((await f.app.inject({ url: '/fixture/course/course', headers: { cookie: signed.cookie } })).statusCode, 401);
    const active = await login(f);
    for (let i = 0; i < 16; i++) {
      f.advance(30 * 60 * 1000 - 1);
      assert.equal((await f.app.inject({ url: '/fixture/course/course', headers: { cookie: active.cookie } })).statusCode, 200);
    }
    f.advance(16);
    assert.equal((await f.app.inject({ url: '/fixture/course/course', headers: { cookie: active.cookie } })).statusCode, 401);
  } finally { await f.close(); }
});

test('course authorization and a SQL command share the same atomic transaction', async () => {
  const f = await fixture();
  f.app.post('/fixture/atomic', request => ({
    requestId: request.id,
    data: f.access.withAuthorizedCourse(request, 'course', 'student', (tx, actor) => {
      tx.run('INSERT INTO courses(id) VALUES (?)', 'committed-marker');
      return { ...actor, committed: true };
    }),
  }));
  try {
    const signed = await login(f);
    f.advance(1000);
    const response = await f.app.inject({ method: 'POST', url: '/fixture/atomic',
      headers: { origin, cookie: signed.cookie, 'x-csrf-token': signed.csrfToken }, payload: {} });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, { userId: 'user', courseId: 'course', role: 'student', committed: true });
    assert.deepEqual(f.db.withTransaction(tx => tx.get('SELECT id FROM courses WHERE id=?', 'committed-marker')), { id: 'committed-marker' });
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT last_active_at_ms FROM sessions'))!.last_active_at_ms, f.clock());
  } finally { await f.close(); }
});


test('authorized SQL failure rolls back session activity and revoked roles cannot enter the callback', async () => {
  const f = await fixture();
  let entered = 0;
  f.app.post('/fixture/atomic-failure', request => f.access.withAuthorizedCourse(request, 'course', 'student', tx => {
    entered++;
    tx.run('INSERT INTO courses(id) VALUES (?)', 'rollback-marker');
    tx.run('INSERT INTO courses(id) VALUES (?)', 'course');
    return { acknowledged: true };
  }));
  f.app.post('/fixture/atomic-teacher', request => f.access.withAuthorizedCourse(request, 'course', 'teacher', () => {
    entered++;
    return { acknowledged: true };
  }));
  try {
    const signed = await login(f);
    const originalActivity = f.db.withTransaction(tx => tx.get('SELECT last_active_at_ms FROM sessions'))!.last_active_at_ms;
    f.advance(1000);
    const headers = { origin, cookie: signed.cookie, 'x-csrf-token': signed.csrfToken };
    const failed = await f.app.inject({ method: 'POST', url: '/fixture/atomic-failure', headers, payload: {} });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().error.code, 'PERSISTENCE_UNAVAILABLE');
    assert.equal(failed.json().acknowledged, undefined);
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT id FROM courses WHERE id=?', 'rollback-marker')), undefined);
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT last_active_at_ms FROM sessions'))!.last_active_at_ms, originalActivity);
    assert.equal(entered, 1);
    assert.equal((await f.app.inject({ method: 'POST', url: '/fixture/atomic-teacher', headers, payload: {} })).statusCode, 403);
    assert.equal(entered, 1);
    f.db.withTransaction(tx => tx.run('UPDATE course_memberships SET active=0 WHERE course_id=? AND user_id=?', 'course', 'user'));
    assert.equal((await f.app.inject({ method: 'POST', url: '/fixture/atomic-failure', headers, payload: {} })).statusCode, 403);
    assert.equal(entered, 1);
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT last_active_at_ms FROM sessions'))!.last_active_at_ms, originalActivity);
  } finally { await f.close(); }
});


test('authorized transactions reject async and nested work and expire escaped SQL capability', async () => {
  const f = await fixture();
  let asyncStarted = false;
  let escaped: Parameters<Parameters<typeof f.db.withTransaction>[0]>[0] | undefined;
  f.app.post('/fixture/atomic-async', request => f.access.withAuthorizedCourse(request, 'course', 'student', async () => {
    asyncStarted = true;
    return { acknowledged: true };
  }));
  f.app.post('/fixture/atomic-thenable', request => f.access.withAuthorizedCourse(request, 'course', 'student', tx => {
    tx.run('INSERT INTO courses(id) VALUES (?)', 'thenable-marker');
    return Promise.resolve({ acknowledged: true });
  }));
  f.app.post('/fixture/atomic-nested', request => f.access.withAuthorizedCourse(request, 'course', 'student', tx => {
    tx.run('INSERT INTO courses(id) VALUES (?)', 'nested-marker');
    return f.db.withTransaction(() => ({ acknowledged: true }));
  }));
  f.app.post('/fixture/atomic-escape', request => f.access.withAuthorizedCourse(request, 'course', 'student', (tx, actor) => {
    escaped = tx;
    return actor;
  }));
  try {
    const signed = await login(f);
    const headers = { origin, cookie: signed.cookie, 'x-csrf-token': signed.csrfToken };
    for (const path of ['async', 'thenable', 'nested']) {
      const response = await f.app.inject({ method: 'POST', url: '/fixture/atomic-' + path, headers, payload: {} });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'PERSISTENCE_UNAVAILABLE');
      assert.equal(response.json().acknowledged, undefined);
    }
    assert.equal(asyncStarted, false);
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT id FROM courses WHERE id=?', 'thenable-marker')), undefined);
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT id FROM courses WHERE id=?', 'nested-marker')), undefined);
    assert.equal((await f.app.inject({ method: 'POST', url: '/fixture/atomic-escape', headers, payload: {} })).statusCode, 200);
    assert.ok(escaped);
    assert.throws(() => escaped!.get('SELECT id FROM courses'), /expired/);
  } finally { await f.close(); }
});

test('resource authorization denies another student and private material before reading or committing work', async () => {
  const f = await fixture();
  let entered = 0;
  f.app.get('/fixture/resource/:kind', request => ({ requestId: request.id,
    data: f.access.withAuthorizedResource(request, tx => {
      assert.ok(tx.get('SELECT id FROM courses WHERE id=?', 'course'));
      const kind = (request.params as { kind: string }).kind;
      if (kind === 'missing') return undefined;
      if (kind === 'private') return { kind: 'material' as const, courseId: 'course', studentId: 'user',
        materialKind: 'private_answer' as const, studentVisible: true, tutorVisible: true, teacherDesignAllowed: false };
      return { kind: 'student_work' as const, courseId: 'course', studentId: kind === 'own' ? 'user' : 'other',
        stage: 'ready' as const, assignmentActive: true };
    }, 'read', (_tx, actor) => { entered++; return { owner: actor.userId }; }),
  }));
  try {
    const signed = await login(f);
    const headers = { cookie: signed.cookie };
    assert.equal((await f.app.inject({ url: '/fixture/resource/own', headers })).statusCode, 200);
    for (const kind of ['foreign', 'private', 'missing']) {
      const denied = await f.app.inject({ url: '/fixture/resource/' + kind, headers });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().error.code, 'FORBIDDEN');
      assert.equal(denied.json().data, undefined);
    }
    assert.equal(entered, 1);
    f.db.withTransaction(tx => tx.run('UPDATE course_memberships SET active=0 WHERE course_id=? AND user_id=?', 'course', 'user'));
    assert.equal((await f.app.inject({ url: '/fixture/resource/own', headers })).statusCode, 403);
    assert.equal(entered, 1);
  } finally { await f.close(); }
});
