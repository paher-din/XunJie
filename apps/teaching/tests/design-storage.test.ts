import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createDesignDatabase, openSyntheticDatabase } from '../server/db/transaction.ts';
import { createPasswordRecord } from '../server/access/password.ts';
import { createDesignVerificationApp } from '../server/design/app.ts';

const origin = 'https://synthetic.example';
async function fixture(logDestination?: { write(message: string): void }) {
  let db = createDesignDatabase();
  const password = randomBytes(32).toString('base64url');
  const record = await createPasswordRecord(password);
  db.withTransaction(tx => {
    for (const id of ['teacher', 'student', 'other-teacher']) {
      tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES (?,?,?,?,?,?,?,?,?)',
        id, id, record.hash, record.salt, 'scrypt', 131072, 8, 1, 64);
    }
    for (const id of ['course', 'other']) tx.run('INSERT INTO courses(id) VALUES (?)', id);
    for (const [course, user, role] of [['course', 'teacher', 'teacher'], ['course', 'student', 'student'],
      ['other', 'teacher', 'student'], ['other', 'other-teacher', 'teacher']]) {
      tx.run('INSERT INTO course_memberships(course_id,user_id,role,active) VALUES (?,?,?,1)', course!, user!, role!);
    }
  });
  let timestamp = Date.now();
  let generation = 'generation-1';
  let switchOnRead = false;
  let generationReads = 0;
  const signingSecret = randomBytes(48).toString('hex');
  const options = () => ({ db, origin, signingSecret, ...(logDestination ? { logDestination } : {}), now: () => timestamp, currentGeneration: () => switchOnRead && ++generationReads >= 2 ? 'generation-changed' : generation });
  let service = await createDesignVerificationApp(options());
  const registerReads = () => {
    service.app.get('/fixture/previews/:id/:audience', request => ({
      requestId: request.id, data: service.design.preview(request, (request.params as { id: string }).id, (request.params as { audience: string }).audience),
    }));
    service.app.get('/fixture/drafts/:id', request => ({
      requestId: request.id, data: service.design.readDraft(request, (request.params as { id: string }).id),
    }));
    service.app.get('/fixture/materials/:course/:id', request => ({
      requestId: request.id, data: service.design.readMaterial(request, (request.params as { course: string }).course, (request.params as { id: string }).id),
    }));
  };
  registerReads();
  const signIn = async (user = 'teacher') => {
    const response = await service.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin }, payload: { loginName: user, password } });
    assert.equal(response.statusCode, 200);
    const cookie = response.cookies.filter(c => c.value).map(c => `${c.name}=${encodeURIComponent(c.value)}`).join('; ');
    return { cookie, origin, 'x-csrf-token': response.json().data.csrfToken as string };
  };
  return {
    get app() { return service.app; }, get db() { return db; }, signIn, signingSecret,
    clock: () => timestamp, advance: () => { timestamp += 1000; },
    generation: () => generation, restoreGeneration: () => { generation = 'generation-2'; },
    armGenerationChange() { switchOnRead = true; generationReads = 0; },
    async reopen() {
      const file = db.file;
      await service.app.close(); db.close();
      db = openSyntheticDatabase(file);
      service = await createDesignVerificationApp(options());
      registerReads();
    },
    async close() { await service.app.close(); db.close(); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Headers = Awaited<ReturnType<Fixture['signIn']>>;
function command(f: Fixture, headers: Headers, url: string, key: string, input: object, method: 'POST' | 'PATCH' = 'POST') {
  return f.app.inject({ method, url, headers: { ...headers, 'idempotency-key': key },
    payload: { recoveryGeneration: f.generation(), ...input } });
}
async function createManual(f: Fixture, headers: Headers, content: object = {}) {
  const response = await command(f, headers, '/api/courses/course/blueprints', randomBytes(12).toString('hex'), { mode: 'manual', content });
  assert.equal(response.statusCode, 200);
  return response.json().data.result.draft;
}


async function childConnection(f: Fixture) {
  const child = fork(fileURLToPath(new URL('./fixtures/design-child.ts', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  async function send(input: object) {
    const waiting = once(child, 'message', { signal: AbortSignal.timeout(15000) });
    child.send(input);
    const [message] = await waiting;
    assert.notEqual(message.kind, 'error');
    return message as { kind: string; statusCode: number; body: string };
  }
  await send({ kind: 'init', file: f.db.file, origin, signingSecret: f.signingSecret, timestamp: f.clock(), generation: f.generation() });
  return {
    request(headers: Headers, url: string, key: string, input: object, method: 'POST' | 'PATCH' = 'POST') {
      return send({ kind: 'request', method, url, headers: { ...headers, 'idempotency-key': key },
        payload: { recoveryGeneration: f.generation(), ...input } });
    },
    async hold() {
      assert.equal((await send({ kind: 'hold' })).kind, 'holding');
      return { released: once(child, 'message', { signal: AbortSignal.timeout(15000) }) };
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const finished = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
      child.send({ kind: 'stop' });
      const [code] = await finished;
      assert.equal(code, 0);
    },
  };
}


test('teacher material is committed with a fixed paragraph reference and survives database reopening', async () => {
  const f = await fixture();
  try {
    const headers = await f.signIn();
    const saved = await command(f, headers, '/api/courses/course/resources', 'material-1',
      { material: { format: 'txt', title: 'sample', content: 'abc' }, teacherDesignAllowed: true });
    assert.equal(saved.statusCode, 200);
    const version = saved.json().data.result.resourceVersion;
    assert.equal(version.material.text, 'abc');
    assert.equal(version.material.byteLength, 3);
    assert.equal(version.material.contentHash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(version.material.visibility.student, false);
    assert.equal(version.material.visibility.tutor, false);
    assert.equal(version.material.paragraphs.length, 1);
    assert.ok(version.material.paragraphs[0].paragraphId);
    await f.reopen();
    const read = await f.app.inject({ url: '/fixture/materials/course/' + version.resourceVersionId, headers });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json().data, version);
    const replay = await command(f, headers, '/api/courses/course/resources', 'material-1',
      { material: { content: 'abc', title: 'sample', format: 'txt' }, teacherDesignAllowed: true });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json().data, saved.json().data);
    assert.notEqual(replay.json().requestId, saved.json().requestId);
  } finally { await f.close(); }
});

test('manual drafts retain teacher edits, copy independently, and replay original results before revision CAS', async () => {
  const f = await fixture();
  try {
    const headers = await f.signIn();
    const draft = await createManual(f, headers, { projectTitle: 'first', problem: 'original problem' });
    const url = '/api/blueprints/' + draft.blueprintId;
    const edited = await command(f, headers, url, 'edit-1', { expectedRevision: 1, patch: { projectTitle: 'manual title' } }, 'PATCH');
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json().data.result.draft.revision, 2);
    assert.equal(edited.json().data.result.draft.content.problem, 'original problem');
    assert.equal((await command(f, headers, url, 'edit-2', { expectedRevision: 2, patch: { problem: 'latest problem' } }, 'PATCH')).statusCode, 200);
    const replay = await command(f, headers, url, 'edit-1', { patch: { projectTitle: 'manual title' }, expectedRevision: 1 }, 'PATCH');
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json().data, edited.json().data);
    assert.equal((await command(f, headers, url, 'edit-1', { expectedRevision: 1, patch: { projectTitle: 'different' } }, 'PATCH')).statusCode, 409);
    const stale = await command(f, headers, url, 'edit-stale', { expectedRevision: 1, patch: { projectTitle: 'stale' } }, 'PATCH');
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'VERSION_CONFLICT');
    const copied = await command(f, headers, '/api/courses/course/blueprints', 'copy',
      { mode: 'copy', sourceBlueprintId: draft.blueprintId, expectedSourceRevision: 3 });
    assert.equal(copied.statusCode, 200);
    const copy = copied.json().data.result.draft;
    assert.notEqual(copy.blueprintId, draft.blueprintId);
    assert.equal(copy.revision, 1);
    assert.deepEqual(copy.source, { courseId: 'course', blueprintId: draft.blueprintId, revision: 3 });
    assert.equal((await command(f, headers, '/api/blueprints/' + copy.blueprintId, 'copy-edit',
      { expectedRevision: 1, patch: { projectTitle: 'independent' } }, 'PATCH')).statusCode, 200);
    const original = await f.app.inject({ url: '/fixture/drafts/' + draft.blueprintId, headers });
    assert.equal(original.statusCode, 200);
    assert.equal(original.json().data.content.projectTitle, 'manual title');
    assert.equal(original.json().data.revision, 3);
    const oldSource = await command(f, headers, '/api/courses/course/blueprints', 'old-source',
      { mode: 'copy', sourceBlueprintId: draft.blueprintId, expectedSourceRevision: 1 });
    assert.equal(oldSource.statusCode, 409);
  } finally { await f.close(); }
});

test('competency meaning is immutable across drafts and remove-readd history, while known older versions remain usable', async () => {
  const f = await fixture();
  try {
    const headers = await f.signIn();
    const goal = { competencyId: 'pointers', competencyVersion: 1, domain: 'domain', title: 'explain a pointer', core: true };
    const draft = await createManual(f, headers, { goals: [goal] });
    const conflict = await command(f, headers, '/api/courses/course/blueprints', 'conflicting-meaning',
      { mode: 'manual', content: { goals: [{ ...goal, title: 'different meaning' }] } });
    assert.equal(conflict.statusCode, 400);
    assert.equal(conflict.json().error.code, 'INVALID_REQUEST');
    const url = '/api/blueprints/' + draft.blueprintId;
    assert.equal((await command(f, headers, url, 'remove', { expectedRevision: 1, patch: { goals: [] } }, 'PATCH')).statusCode, 200);
    const readded = await command(f, headers, url, 'readd', { expectedRevision: 2, patch: { goals: [{ ...goal, title: 'silently replaced' }] } }, 'PATCH');
    assert.equal(readded.statusCode, 400);
    const read = await f.app.inject({ url: '/fixture/drafts/' + draft.blueprintId, headers });
    assert.equal(read.json().data.revision, 2);
    assert.deepEqual(read.json().data.content.goals, []);
    await createManual(f, headers, { goals: [{ ...goal, competencyVersion: 3, title: 'new meaning' }] });
    const unregisteredOlder = await command(f, headers, '/api/courses/course/blueprints', 'regression',
      { mode: 'manual', content: { goals: [{ ...goal, competencyVersion: 2, title: 'late new meaning' }] } });
    assert.equal(unregisteredOlder.statusCode, 400);
    const known = await createManual(f, headers, { goals: [goal] });
    assert.deepEqual(known.content.goals, [goal]);
  } finally { await f.close(); }
});

test('stored checks bind revisions and teacher previews redact private and unapproved materials without granting audience access', async () => {
  const f = await fixture();
  try {
    const headers = await f.signIn();
    const refs: { resourceVersionId: string }[] = [];
    let privateVersion: { resourceVersionId: string; material: { title: string; text: string; contentHash: string } } | undefined;
    for (const [key, material, allowed] of [
      ['public', { format: 'markdown', title: '公开', content: '\ufeffabc\r\n\r\n正文😀 ', visibility: { student: true, tutor: false } }, true],
      ['private', { format: 'txt', title: 'private answer title', content: 'synthetic secret answer', kind: 'private_answer' }, true],
      ['unapproved', { format: 'paste', title: 'unapproved', content: 'not approved for design' }, false],
    ] as const) {
      const response = await command(f, headers, '/api/courses/course/resources', key, { material, teacherDesignAllowed: allowed });
      assert.equal(response.statusCode, 200);
      const version = response.json().data.result.resourceVersion;
      refs.push({ resourceVersionId: version.resourceVersionId });
      if (key === 'public') {
        assert.equal(version.material.text, '\ufeffabc\r\n\r\n正文😀 ');
        assert.equal(version.material.byteLength, 21);
        assert.equal(version.material.paragraphs.length, 2);
      }
      if (key === 'private') privateVersion = version;
    }
    const draft = await createManual(f, headers, { resources: refs, runtimeProfileVersionId: 'claimed-ready' });
    const url = '/api/blueprints/' + draft.blueprintId;
    const checked = await command(f, headers, url + '/checks', 'checks', { expectedRevision: 1,
      concerns: [{ code: 'time', path: 'timeConstraints', reason: 'teacher estimate requires review', resolution: 'review before release' }] });
    assert.equal(checked.statusCode, 200);
    const report = checked.json().data.result.report;
    assert.equal(report.revision, 1);
    assert.ok(report.blocking.some((item: { code: string }) => item.code === 'runtime_not_ready'));
    assert.ok(report.blocking.some((item: { code: string }) => item.code === 'forbidden_resource'));
    assert.equal(report.designConcerns[0].status, 'teacher_recorded');
    assert.ok(report.unverified.every((item: { status: string }) => item.status === 'unknown'));
    assert.ok(privateVersion);
    for (const audience of ['student', 'tutor']) {
      const preview = await f.app.inject({ url: '/fixture/previews/' + draft.blueprintId + '/' + audience, headers });
      assert.equal(preview.statusCode, 200);
      assert.deepEqual(preview.json().data.materials.map((m: { status: string }) => m.status),
        audience === 'student' ? ['available', 'redacted', 'redacted'] : ['redacted', 'redacted', 'redacted']);
      for (const secret of [privateVersion.resourceVersionId, privateVersion.material.title, privateVersion.material.text, privateVersion.material.contentHash]) {
        assert.equal(preview.body.includes(secret), false);
      }
      assert.equal(preview.body.includes('claimed-ready'), false);
    }
    const validator = await f.app.inject({ url: '/fixture/previews/' + draft.blueprintId + '/teacher-validator', headers });
    assert.deepEqual(validator.json().data.materials.map((m: { status: string }) => m.status), ['available', 'available', 'redacted']);
    const student = await f.signIn('student');
    assert.equal((await f.app.inject({ url: '/fixture/previews/' + draft.blueprintId + '/teacher-validator', headers: student })).statusCode, 403);
    assert.equal((await command(f, headers, url, 'advance', { expectedRevision: 1, patch: { projectTitle: 'updated' } }, 'PATCH')).statusCode, 200);
    assert.deepEqual((await command(f, headers, url + '/checks', 'checks', { expectedRevision: 1,
      concerns: [{ code: 'time', path: 'timeConstraints', reason: 'teacher estimate requires review', resolution: 'review before release' }] })).json().data, checked.json().data);
    assert.equal((await command(f, headers, url + '/checks', 'stale-checks', { expectedRevision: 1 })).statusCode, 409);
    assert.equal((await command(f, headers, url + '/checks', 'forged-ready', { expectedRevision: 2, ready: true })).statusCode, 400);
  } finally { await f.close(); }
});

test('current session roles protect commands, reads and copy sources; hidden and missing references are indistinguishable', async () => {
  const f = await fixture();
  try {
    const headers = await f.signIn();
    const other = await f.signIn('other-teacher');
    const foreign = await command(f, other, '/api/courses/other/resources', 'foreign', { material: { format: 'txt', title: 'private foreign', content: 'foreign secret' } });
    const foreignId = foreign.json().data.result.resourceVersion.resourceVersionId;
    const draft = await createManual(f, headers);
    const url = '/api/blueprints/' + draft.blueprintId;
    const missing = await command(f, headers, url, 'missing', { expectedRevision: 1, patch: { resources: [{ resourceVersionId: 'not-present' }] } }, 'PATCH');
    const hidden = await command(f, headers, url, 'hidden', { expectedRevision: 1, patch: { resources: [{ resourceVersionId: foreignId }] } }, 'PATCH');
    assert.equal(hidden.statusCode, 403);
    assert.equal(missing.statusCode, 403);
    assert.deepEqual(hidden.json().error, missing.json().error);
    const student = await f.signIn('student');
    for (const actor of [student, other]) {
      assert.equal((await command(f, actor, url, 'unauthorized', { expectedRevision: 1, patch: {} }, 'PATCH')).statusCode, 403);
      assert.equal((await f.app.inject({ url: '/fixture/drafts/' + draft.blueprintId, headers: actor })).statusCode, 403);
    }
    assert.equal((await f.app.inject({ url: '/fixture/drafts/' + draft.blueprintId })).statusCode, 401);
    assert.equal((await command(f, headers, '/api/courses/other/blueprints', 'not-teacher', { mode: 'manual' })).statusCode, 403);
    const foreignDraft = await command(f, other, '/api/courses/other/blueprints', 'foreign-draft', { mode: 'manual' });
    assert.equal((await command(f, headers, '/api/courses/course/blueprints', 'foreign-copy',
      { mode: 'copy', sourceBlueprintId: foreignDraft.json().data.result.draft.blueprintId, expectedSourceRevision: 1 })).statusCode, 403);
    assert.equal((await command(f, headers, url, 'spoof-role', { expectedRevision: 1, patch: {}, role: 'teacher' }, 'PATCH')).statusCode, 400);
    assert.equal((await command(f, headers, url, 'spoof-owner', { expectedRevision: 1, patch: { studentId: 'student' } }, 'PATCH')).statusCode, 400);
    assert.equal((await command(f, { ...headers, origin: 'https://elsewhere.example' }, url, 'origin', { expectedRevision: 1, patch: {} }, 'PATCH')).statusCode, 403);
    assert.equal((await command(f, { ...headers, 'x-csrf-token': 'wrong' }, url, 'csrf', { expectedRevision: 1, patch: {} }, 'PATCH')).statusCode, 403);
    const committed = await command(f, headers, url, 'before-revoke', { expectedRevision: 1, patch: {} }, 'PATCH');
    assert.equal(committed.statusCode, 200);
    f.db.withTransaction(tx => tx.run('UPDATE course_memberships SET active=0 WHERE user_id=? AND course_id=?', 'teacher', 'course'));
    assert.equal((await command(f, headers, url, 'before-revoke', { expectedRevision: 1, patch: {} }, 'PATCH')).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/fixture/drafts/' + draft.blueprintId, headers })).statusCode, 403);
  } finally { await f.close(); }
});

test('recovery generation is checked before replay and a generation change before commit rolls back the entire command', async () => {
  const f = await fixture();
  try {
    const headers = await f.signIn();
    const input = { mode: 'manual', content: { projectTitle: 'original' } };
    const saved = await command(f, headers, '/api/courses/course/blueprints', 'generation-key', input);
    assert.equal(saved.statusCode, 200);
    const activity = f.db.withTransaction(tx => tx.get('SELECT last_active_at_ms FROM sessions WHERE user_id=?', 'teacher'))!.last_active_at_ms;
    f.advance();
    const absent = await f.app.inject({ method: 'POST', url: '/api/courses/course/blueprints',
      headers: { ...headers, 'idempotency-key': 'missing-generation' }, payload: input });
    assert.equal(absent.statusCode, 409);
    assert.equal(absent.json().error.code, 'RECOVERY_REQUIRED');
    f.restoreGeneration();
    for (const generation of ['generation-1', 'generation-2']) {
      const stale = await command(f, headers, '/api/courses/course/blueprints', 'generation-key', { ...input, recoveryGeneration: generation });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error.code, 'RECOVERY_REQUIRED');
      assert.equal(stale.json().data, undefined);
    }
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT last_active_at_ms FROM sessions WHERE user_id=?', 'teacher'))!.last_active_at_ms, activity);
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT COUNT(*) AS n FROM blueprint_drafts'))!.n, 1);
    const current = await command(f, headers, '/api/courses/course/blueprints', 'new-explicit-key', input);
    assert.equal(current.statusCode, 200);
    assert.equal(current.json().data.recoveryGeneration, 'generation-2');
    assert.notEqual(current.json().data.result.draft.blueprintId, saved.json().data.result.draft.blueprintId);
    await f.reopen();
    assert.deepEqual((await command(f, headers, '/api/courses/course/blueprints', 'new-explicit-key', input)).json().data, current.json().data);
    f.armGenerationChange();
    const changed = await command(f, headers, '/api/courses/course/blueprints', 'changing', input);
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json().error.code, 'RECOVERY_REQUIRED');
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT COUNT(*) AS n FROM blueprint_drafts'))!.n, 2);
    assert.equal(f.db.withTransaction(tx => tx.get('SELECT COUNT(*) AS n FROM command_receipts'))!.n, 2);
  } finally { await f.close(); }
});

test('a real late SQL failure rolls back draft, competency, audit, receipt and session activity without an ACK', async () => {
  const f = await fixture();
  try {
    const headers = await f.signIn();
    const draft = await createManual(f, headers, { projectTitle: 'committed' });
    f.db.withTransaction(tx => {
      tx.run(`INSERT INTO audit_events(server_seq,event_id,actor_id,course_id,command_id,command,target,object_ref_json,recovery_generation,committed_at_ms)
        VALUES (CAST(? AS INTEGER),?,?,?,?,?,?,?,?,?)`,
      '9223372036854775807', 'exhausted-sequence', 'teacher', 'course', 'fixture-command', 'fixture', 'course', '{}', f.generation(), f.clock());
    });
    const activity = f.db.withTransaction(tx => tx.get('SELECT last_active_at_ms FROM sessions WHERE user_id=?', 'teacher'))!.last_active_at_ms;
    f.advance();
    const failed = await command(f, headers, '/api/blueprints/' + draft.blueprintId, 'late-failure',
      { expectedRevision: 1, patch: { projectTitle: 'must rollback',
        goals: [{ competencyId: 'new-goal', competencyVersion: 1, domain: 'project', title: 'must rollback' }] } }, 'PATCH');
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().error.code, 'PERSISTENCE_UNAVAILABLE');
    assert.equal(failed.json().data, undefined);
    f.db.withTransaction(tx => {
      assert.equal(tx.get('SELECT revision FROM blueprint_drafts WHERE id=?', draft.blueprintId)!.revision, 1);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM competency_versions')!.n, 0);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM command_receipts')!.n, 1);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM audit_events')!.n, 2);
      assert.equal(tx.get('SELECT last_active_at_ms FROM sessions WHERE user_id=?', 'teacher')!.last_active_at_ms, activity);
    });
    const read = await f.app.inject({ url: '/fixture/drafts/' + draft.blueprintId, headers });
    assert.equal(read.json().data.content.projectTitle, 'committed');
  } finally { await f.close(); }
});

test('independent processes commit one receipt per key, arbitrate revision CAS and enforce the course quota atomically', async () => {
  const f = await fixture();
  const peers: Awaited<ReturnType<typeof childConnection>>[] = [];
  try {
    const headers = await f.signIn();
    peers.push(await childConnection(f), await childConnection(f));
    const [a, b] = peers;
    assert.ok(a && b);
    const drafts = await Promise.all([a, b].map(p => p.request(headers, '/api/courses/course/blueprints', 'same-key',
      { mode: 'manual', content: { projectTitle: 'single result' } })));
    assert.deepEqual(drafts.map(r => r.statusCode), [200, 200]);
    const first = JSON.parse(drafts[0]!.body).data;
    assert.deepEqual(JSON.parse(drafts[1]!.body).data, first);
    const url = '/api/blueprints/' + first.result.draft.blueprintId;
    const edits = await Promise.all([a, b].map((p, index) => p.request(headers, url, 'cas-' + index,
      { expectedRevision: 1, patch: { projectTitle: 'winner-' + index } }, 'PATCH')));
    assert.deepEqual(edits.map(r => r.statusCode).sort(), [200, 409]);
    const winner = JSON.parse(edits.find(r => r.statusCode === 200)!.body).data.result.draft;
    const read = await f.app.inject({ url: '/fixture/drafts/' + first.result.draft.blueprintId, headers });
    assert.deepEqual(read.json().data, winner);
    const body = 'x'.repeat(256 * 1024);
    for (let index = 0; index < 7; index++) {
      assert.equal((await command(f, headers, '/api/courses/course/resources', 'quota-' + index,
        { material: { format: 'txt', title: 'synthetic quota', content: body } })).statusCode, 200);
    }
    const final = await Promise.all([a, b].map((p, index) => p.request(headers, '/api/courses/course/resources', 'last-' + index,
      { material: { format: 'txt', title: 'synthetic quota', content: body } })));
    assert.deepEqual(final.map(r => r.statusCode).sort(), [200, 413]);
    f.db.withTransaction(tx => {
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM blueprint_drafts')!.n, 1);
      assert.equal(tx.get('SELECT SUM(byte_length) AS bytes FROM resource_versions')!.bytes, 2 * 1024 * 1024);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM command_receipts')!.n, 10);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM audit_events')!.n, 10);
    });
  } finally { for (const peer of peers) await peer.close(); await f.close(); }
});

test('a competing SQL writer reports persistence failure without advancing session or acknowledging a command', async () => {
  const f = await fixture();
  let peer: Awaited<ReturnType<typeof childConnection>> | undefined;
  try {
    const headers = await f.signIn();
    peer = await childConnection(f);
    const activity = f.db.withTransaction(tx => tx.get('SELECT last_active_at_ms FROM sessions WHERE user_id=?', 'teacher'))!.last_active_at_ms;
    f.advance();
    const { released } = await peer.hold();
    const failed = await command(f, headers, '/api/courses/course/blueprints', 'busy-command', { mode: 'manual' });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().error.code, 'PERSISTENCE_UNAVAILABLE');
    assert.equal(failed.json().data, undefined);
    assert.equal((await released)[0].kind, 'released');
    f.db.withTransaction(tx => {
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM blueprint_drafts')!.n, 0);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM command_receipts')!.n, 0);
      assert.equal(tx.get('SELECT last_active_at_ms FROM sessions WHERE user_id=?', 'teacher')!.last_active_at_ms, activity);
    });
    assert.equal((await command(f, headers, '/api/courses/course/blueprints', 'busy-command', { mode: 'manual' })).statusCode, 200);
  } finally { await peer?.close(); await f.close(); }
});

test('corrupt persisted JSON cannot produce a read or replay ACK and diagnostics reveal no private content', async () => {
  const logs: string[] = [];
  const f = await fixture({ write: message => { logs.push(message); } });
  try {
    const headers = await f.signIn();
    const draft = await createManual(f, headers, { problem: 'synthetic confidential design' });
    const saved = await command(f, headers, '/api/courses/course/resources', 'corrupt-receipt', {
      material: { format: 'txt', title: 'synthetic private', content: 'synthetic secret body', kind: 'private_answer' },
    });
    const resourceId = saved.json().data.result.resourceVersion.resourceVersionId;
    f.db.withTransaction(tx => {
      tx.run('UPDATE blueprint_drafts SET draft_json=? WHERE id=?', '{}', draft.blueprintId);
      tx.run('UPDATE resource_versions SET paragraphs_json=? WHERE id=?', '[{}]', resourceId);
      tx.run('UPDATE command_receipts SET result_json=? WHERE receipt_id=?', '{}', saved.json().data.receiptId);
    });
    const badDraft = await f.app.inject({ url: '/fixture/drafts/' + draft.blueprintId, headers });
    const badMaterial = await f.app.inject({ url: '/fixture/materials/course/' + resourceId, headers });
    const badReceipt = await command(f, headers, '/api/courses/course/resources', 'corrupt-receipt', {
      material: { format: 'txt', title: 'synthetic private', content: 'synthetic secret body', kind: 'private_answer' },
    });
    for (const response of [badDraft, badMaterial, badReceipt]) {
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'PERSISTENCE_UNAVAILABLE');
      assert.equal(response.json().data, undefined);
      for (const secret of ['synthetic confidential design', 'synthetic secret body', f.db.file, headers.cookie, headers['x-csrf-token']]) {
        assert.equal(response.body.includes(secret), false);
        assert.equal(logs.join('').includes(secret), false);
      }
    }
  } finally { await f.close(); }
});

test('authorization-consistent previews remain fixed to the revision observed during concurrent edits', async () => {
  const f = await fixture();
  let peer: Awaited<ReturnType<typeof childConnection>> | undefined;
  try {
    const headers = await f.signIn();
    const refs: { resourceVersionId: string }[] = [];
    for (const text of ['old material', 'new material']) {
      const saved = await command(f, headers, '/api/courses/course/resources', text.replaceAll(' ', '-'),
        { material: { format: 'txt', title: text, content: text, visibility: { student: true, tutor: true } }, teacherDesignAllowed: true });
      assert.equal(saved.statusCode, 200);
      refs.push({ resourceVersionId: saved.json().data.result.resourceVersion.resourceVersionId });
    }
    const draft = await createManual(f, headers, { projectTitle: 'old', resources: [refs[0]!] });
    peer = await childConnection(f);
    const update = peer.request(headers, '/api/blueprints/' + draft.blueprintId, 'concurrent-edit',
      { expectedRevision: 1, patch: { projectTitle: 'new', resources: [refs[1]!] } }, 'PATCH');
    const observations = await Promise.all(Array.from({ length: 8 }, () =>
      f.app.inject({ url: '/fixture/previews/' + draft.blueprintId + '/student', headers })));
    assert.equal((await update).statusCode, 200);
    observations.push(await f.app.inject({ url: '/fixture/previews/' + draft.blueprintId + '/student', headers }));
    for (const response of observations) {
      assert.equal(response.statusCode, 200);
      const view = response.json().data;
      const old = view.revision === 1;
      assert.equal(view.revision, old ? 1 : 2);
      assert.equal(view.content.projectTitle, old ? 'old' : 'new');
      assert.equal(view.materials[0].resourceVersionId, refs[old ? 0 : 1]!.resourceVersionId);
      assert.equal(view.materials[0].text, old ? 'old material' : 'new material');
    }
  } finally { await peer?.close(); await f.close(); }
});

test('material rejection preserves the committed catalog and does not issue receipts for invalid or oversized inputs', async () => {
  const f = await fixture();
  try {
    const headers = await f.signIn();
    const cases = [
      { status: 413, material: { format: 'txt', title: 'too large', content: 'x'.repeat(256 * 1024 + 1) } },
      { status: 400, material: { format: 'pdf', title: 'unsupported', content: 'text' } },
      { status: 400, material: { format: 'txt', title: 'unpaired surrogate', content: '\ud800' } },
      { status: 403, material: { format: 'txt', title: 'private', content: 'private answer', kind: 'private_answer', visibility: { student: true, tutor: false } } },
      { status: 400, material: { format: 'txt', title: 'forged summary', content: 'abc', contentHash: 'forged' } },
    ];
    for (const [index, input] of cases.entries()) {
      const response = await command(f, headers, '/api/courses/course/resources', 'bad-material-' + index, { material: input.material });
      assert.equal(response.statusCode, input.status);
      assert.equal(response.json().data, undefined);
    }
    const anonymous = await f.app.inject({ method: 'POST', url: '/api/courses/course/resources',
      headers: { origin, 'idempotency-key': 'anonymous' }, payload: { recoveryGeneration: f.generation(), material: { format: 'txt', title: 'abc', content: 'abc' } } });
    assert.equal(anonymous.statusCode, 401);
    f.db.withTransaction(tx => {
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM resource_versions')!.n, 0);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM command_receipts')!.n, 0);
      assert.equal(tx.get('SELECT COUNT(*) AS n FROM audit_events')!.n, 0);
      assert.equal(tx.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")!.n, 10);
    });
  } finally { await f.close(); }
});

test('a structurally valid but foreign result in a receipt is refused instead of leaking another course material', async () => {
  const f = await fixture();
  try {
    const headers = await f.signIn();
    const other = await f.signIn('other-teacher');
    const input = { material: { format: 'txt', title: 'local', content: 'local' } };
    const local = await command(f, headers, '/api/courses/course/resources', 'local-key', input);
    const foreign = await command(f, other, '/api/courses/other/resources', 'other-key', {
      material: { format: 'txt', title: 'foreign', content: 'synthetic other-course secret' },
    });
    const data = { ...local.json().data, result: foreign.json().data.result };
    f.db.withTransaction(tx => tx.run('UPDATE command_receipts SET result_json=? WHERE receipt_id=?', JSON.stringify(data), data.receiptId));
    const replay = await command(f, headers, '/api/courses/course/resources', 'local-key', input);
    assert.equal(replay.statusCode, 503);
    assert.equal(replay.json().error.code, 'PERSISTENCE_UNAVAILABLE');
    assert.equal(replay.body.includes('synthetic other-course secret'), false);
  } finally { await f.close(); }
});
