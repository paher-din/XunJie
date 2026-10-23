import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationDatabase, openApplicationDatabase, assertDigitalLogicApplicationDatabase } from '../server/db/transaction.ts';
import { initializeSyntheticApplication } from '../server/app/initialize.ts';
import { createDigitalLogicApplication } from '../server/app/digital-logic.ts';
import { fixture, allocate, view, syntheticNode, controlledRunner, runtime, profile } from './dl-a-support.ts';

const manifest = {
  synthetic: true as const, recoveryGeneration: 'generation',
  accounts: [
    { id: 'synthetic-teacher', loginName: 'synthetic-teacher', password: 'synthetic-teacher-password' },
    { id: 'synthetic-student', loginName: 'synthetic-student', password: 'synthetic-student-password' },
  ],
  courses: ['synthetic-textscope', 'synthetic-digital-logic'],
  memberships: [
    { courseId: 'synthetic-textscope', userId: 'synthetic-teacher', role: 'teacher' as const },
    { courseId: 'synthetic-textscope', userId: 'synthetic-student', role: 'student' as const },
    { courseId: 'synthetic-digital-logic', userId: 'synthetic-teacher', role: 'teacher' as const },
    { courseId: 'synthetic-digital-logic', userId: 'synthetic-student', role: 'student' as const },
  ],
};
const transports = () => ({ runner: controlledRunner().transport, hdlTransport: syntheticNode().transport });

test('persistent application database initializes at an explicit path and survives reopen', async () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'xunjie-persistent-test-'));
  const file = join(directory, 'xunjie.sqlite');
  const db = await initializeSyntheticApplication(manifest, transports(), [runtime],
    createApplicationDatabase(file, 'digital-logic-review-application'));
  assert.equal(db.file, file);
  assert.doesNotThrow(() => assertDigitalLogicApplicationDatabase(db, true));
  db.close();
  const reopened = openApplicationDatabase(file);
  try {
    const users = reopened.withTransaction(tx => tx.all('SELECT login_name FROM users ORDER BY login_name').map(row => String(row.login_name)));
    assert.deepEqual(users, ['synthetic-student', 'synthetic-teacher']);
    const control = reopened.withTransaction(tx => tx.get('SELECT recovery_generation FROM application_control WHERE singleton=1'));
    assert.equal(control?.recovery_generation, 'generation');
  } finally { reopened.close(); }
});

test('persistent database target validation rejects relative, existing, missing and symlinked paths', () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'xunjie-persistent-test-'));
  assert.throws(() => createApplicationDatabase('relative.sqlite', 'digital-logic-application'), /absolute/);
  const file = join(directory, 'xunjie.sqlite');
  createApplicationDatabase(file, 'digital-logic-application').close();
  assert.throws(() => createApplicationDatabase(file, 'digital-logic-application'), /already exists/);
  assert.throws(() => openApplicationDatabase(join(directory, 'missing.sqlite')), /existing/);
  const real = mkdtempSync(join(realpathSync(tmpdir()), 'xunjie-persistent-real-'));
  const link = join(directory, 'linked');
  symlinkSync(real, link);
  assert.throws(() => createApplicationDatabase(join(link, 'xunjie.sqlite'), 'digital-logic-application'), /directory/);
  assert.throws(() => openApplicationDatabase(join(directory, 'xunjie.sqlite', 'nested')), /directory/);
  // Ancestor symlinks are the caller's environment (macOS /var→/private/var, symlinked home): only the final
  // directory component must be a real directory.
  mkdirSync(join(link, 'inner'));
  const nested = join(link, 'inner', 'xunjie.sqlite');
  createApplicationDatabase(nested, 'digital-logic-application').close();
  openApplicationDatabase(nested).close();
});

test('composition without execution nodes stays ready and reports execution explicitly unavailable', async () => {
  const f = await fixture();
  try {
    const teacher = await f.login('teacher'), student = await f.login();
    const text = await allocate(f, teacher, student, false), hdl = await allocate(f, teacher, student);
    const { runner: _runner, hdlTransport: _hdlTransport, ...rest } = f.settings;
    const app = await createDigitalLogicApplication({ ...rest, executionNodes: [] });
    try {
      app.startConsumer();
      let ready;
      for (let attempt = 0; attempt < 50; attempt++) {
        ready = await app.app.inject({ url: '/health/ready' });
        if (ready.statusCode === 200) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(ready!.statusCode, 200, ready!.body);
      const login = await app.app.inject({ method: 'POST', url: '/api/sessions', headers: { origin: f.settings.origin },
        payload: { loginName: 'student', password: f.password } });
      assert.equal(login.statusCode, 200, login.body);
      const headers = { origin: f.settings.origin,
        cookie: login.cookies.filter(cookie => cookie.value).map(cookie => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join('; '),
        'x-csrf-token': String(login.json().data.csrfToken) };
      const nodes = await app.app.inject({ url: '/api/execution-nodes', headers });
      assert.equal(nodes.statusCode, 200, nodes.body);
      assert.deepEqual(nodes.json().data.nodes, []);
      const state = await view(f, student, text.attemptId);
      const sourceFile = state.files[0] as { fileId: string };
      const run = await app.app.inject({ method: 'POST', url: `/api/attempts/${text.attemptId}/runs`,
        headers: { ...headers, 'idempotency-key': 'no-execution-run' },
        payload: { recoveryGeneration: 'generation', expectedAttemptRevision: state.attempt.attemptRevision,
          snapshotId: text.snapshotId, runtimeProfileVersion: profile.runtimeProfileVersion, entryFileId: sourceFile.fileId,
          mode: 'run', input: { operation: 'stats', fileIds: [sourceFile.fileId] } } });
      assert.equal(run.json().error.code, 'RUNTIME_NOT_READY', run.body);
      const build = await app.app.inject({ method: 'POST', url: `/api/attempts/${hdl.attemptId}/hdl/builds`,
        headers: { ...headers, 'idempotency-key': 'no-execution-build' },
        payload: { recoveryGeneration: 'generation', expectedAttemptRevision: (await view(f, student, hdl.attemptId)).attempt.attemptRevision,
          snapshotId: hdl.snapshotId } });
      assert.equal(build.json().error.code, 'RUNTIME_NOT_READY', build.body);
      const saved = await app.app.inject({ method: 'POST', url: `/api/attempts/${text.attemptId}/sync`,
        headers: { ...headers, 'idempotency-key': 'no-execution-sync' },
        payload: { recoveryGeneration: 'generation', expectedWorkspaceRevision: 1, clientId: 'page', clientSeq: 2,
          operations: [{ kind: 'create', clientFileKey: 'notes', path: 'notes.txt', text: 'still writable' }] } });
      assert.equal(saved.statusCode, 200, saved.body);
    } finally { await app.shutdown(); }
  } finally { await f.close(); }
});
