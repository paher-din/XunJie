// Real local business API in two Git worktrees; no execution/model/network-service substitute.
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { resolveContext, up, down } from '../src/commands.mjs';
import { captureRepro, inspectRepro, restoreRepro } from '../src/repro.mjs';
import { verifyRepro } from '../src/repro-verify.mjs';
import { databaseDriver } from '../src/repro-data.mjs';
import { decodeZip, digest, encodeZip, jsonBytes } from '../src/repro-archive.mjs';
import { git } from '../src/repro-code.mjs';
import { listBaselines, publishBaseline, useBaseline } from '../src/baseline-versions.mjs';

const worktree = resolve(import.meta.dirname, '../../..');
function api(origin, method, path, body, auth) {
  return new Promise((resolveResult, reject) => {
    const req = request(origin + path, { method, agent: false, rejectUnauthorized: false, headers: {
      origin, connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth ? { cookie: auth.cookie, 'x-csrf-token': auth.csrf, 'idempotency-key': crypto.randomUUID() } : {}),
    } }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => resolveResult({ status: res.statusCode, body: JSON.parse(text), cookies: res.headers['set-cookie'] })); });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
function withDb(context, fn) {
  const Driver = databaseDriver(context.repo.teaching), db = new Driver(context.env.database);
  try { return fn(db); } finally { db.close(); }
}
function resign(entries) {
  entries.set('checksums.json', jsonBytes(Object.fromEntries([...entries].filter(([path]) => path !== 'checksums.json').map(([path, value]) => [path, digest(value)]))));
  return encodeZip(entries);
}

test('capture before stale-editor save; restore actual code/data to another worktree and reproduce VERSION_CONFLICT', { timeout: 300_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'xj-repro-e2e-'));
  const previousHome = process.env.XJ_DEV_HOME; process.env.XJ_DEV_HOME = join(root, 'home');
  const source = resolveContext({ worktree, instance: 'repro-' + process.pid });
  const sourceHead = git(worktree, ['rev-parse', 'HEAD']);
  const sourceStatus = git(worktree, ['status', '--porcelain']);
  const receivers = [], targets = [];
  t.after(async () => {
    for (const context of [source, ...receivers]) await down(context);
    for (const target of targets) if (existsSync(target)) {
      for (const app of ['student', 'teaching']) {
        const dependencies = join(target, 'apps', app, 'node_modules');
        if (existsSync(dependencies) && lstatSync(dependencies).isSymbolicLink()) unlinkSync(dependencies);
      }
      git(worktree, ['worktree', 'remove', '--force', target]);
    }
    if (previousHome === undefined) delete process.env.XJ_DEV_HOME; else process.env.XJ_DEV_HOME = previousHome;
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const running = await up(source, () => {});
  const before = withDb(source, db => db.prepare("SELECT * FROM attempts WHERE course_id='synthetic-textscope-c'").get());
  const attempt = JSON.parse(before.attempt_json), generation = withDb(source, db => db.prepare('SELECT recovery_generation FROM application_control').get().recovery_generation);
  const contextFile = join(root, 'context.json'), file = join(root, 'scene.zip');
  const body = { recoveryGeneration: generation, expectedWorkspaceRevision: attempt.workspaceRevision, clientId: 'stale-editor', clientSeq: 1,
    operations: [{ kind: 'create', clientFileKey: 'first', path: 'stale-editor.txt', text: 'first tab saved' }] };
  const spec = { formatVersion: 'xj-repro-context/1',
    code: { paths: [] },
    data: { scope: { courseIds: ['synthetic-textscope-c'], userIds: ['synthetic-teacher', 'synthetic-student'], attemptIds: [before.attempt_id] } },
    scenario: { title: '旧编辑现场保存遇到版本冲突', start: 'before-trigger', expected: '旧版本不能覆盖较新的保存', observed: '第二个编辑现场返回 HTTP 409 VERSION_CONFLICT',
      capabilities: { execution: 'not-required', models: 'not-required' },
      steps: [
        { actorId: 'synthetic-student', method: 'POST', path: `/api/attempts/${before.attempt_id}/sync`, body, expect: { status: 200 } },
        { actorId: 'synthetic-student', method: 'POST', path: `/api/attempts/${before.attempt_id}/sync`, body: { ...body, clientSeq: 2,
          operations: [{ kind: 'create', clientFileKey: 'second', path: 'second-tab.txt', text: 'stale tab' }] }, expect: { status: 409, errorCode: 'VERSION_CONFLICT' } },
      ] },
  };
  writeFileSync(contextFile, JSON.stringify(spec));

  // Add an unrelated person and their free text in the same selected course: none may travel.
  withDb(source, db => {
    db.prepare(`INSERT INTO users SELECT 'unselected-member','unselected-login',password_hash,salt,algorithm,n,r,p,key_length,NULL,'UNRELATED_PERSON_CANARY' FROM users LIMIT 1`).run();
    db.prepare("INSERT INTO course_memberships VALUES ('synthetic-textscope-c','unselected-member','student',1)").run();
    db.prepare(`INSERT INTO blueprint_drafts SELECT 'unrelated-draft',course_id,'unselected-member',created_at_ms,revision,'{"note":"UNRELATED_FREE_TEXT_CANARY"}' FROM blueprint_drafts WHERE course_id='synthetic-textscope-c' LIMIT 1`).run();
  });
  const captured = await captureRepro(source, { contextFile, out: file });
  assert.equal(captured.verification.reproduction, 'unverified');
  assert.equal(captured.package.manifest.data.consistency.crossStorageAtomic, false);
  assert.ok(captured.package.manifest.data.tables.attempts === 1);
  assert.ok(captured.package.manifest.data.tables.users === 2);
  const entries = decodeZip(readFileSync(file)), shared = join(root, 'shared.sqlite'); writeFileSync(shared, entries.get('data/shared.sqlite'));
  const Driver = databaseDriver(source.repo.teaching), sharedDb = new Driver(shared, { readonly: true });
  try {
    for (const table of ['sessions', 'jobs', 'hdl_sessions', 'workspace_runs']) assert.equal(sharedDb.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    assert.equal(sharedDb.prepare("SELECT count(*) AS n FROM users WHERE id='unselected-member'").get().n, 0);
    assert.equal(sharedDb.prepare("SELECT count(*) AS n FROM blueprint_drafts WHERE id='unrelated-draft'").get().n, 0);
  } finally { sharedDb.close(); }
  const sharedBytes = entries.get('data/shared.sqlite');
  assert.equal(sharedBytes.includes(Buffer.from('UNRELATED_PERSON_CANARY')), false);
  assert.equal(sharedBytes.includes(Buffer.from('UNRELATED_FREE_TEXT_CANARY')), false);
  const sourceAccounts = JSON.parse(readFileSync(source.env.baselineCredentials, 'utf8'));
  for (const account of sourceAccounts) assert.equal(readFileSync(file).includes(Buffer.from(account.password)), false);

  const account = sourceAccounts.find(a => a.loginName === 'synthetic-student');
  const logged = await api(running.page.url, 'POST', '/api/sessions', { loginName: account.loginName, password: account.password });
  assert.equal(logged.status, 200);
  const auth = { cookie: logged.cookies.map(v => v.split(';')[0]).join('; '), csrf: logged.body.data.csrfToken };
  for (const step of spec.scenario.steps) {
    const result = await api(running.page.url, step.method, step.path, step.body, auth);
    assert.equal(result.status, step.expect.status, JSON.stringify(result.body));
    if (step.expect.errorCode) assert.equal(result.body.error.code, step.expect.errorCode);
  }
  if (process.env.XJ_REPRO_EXPORT_DIR) {
    mkdirSync(process.env.XJ_REPRO_EXPORT_DIR, { recursive: true });
    copyFileSync(file, join(process.env.XJ_REPRO_EXPORT_DIR, 'mac-scene.zip'));
    writeFileSync(join(process.env.XJ_REPRO_EXPORT_DIR, 'source-result.json'), JSON.stringify({
      packageDigest: captured.package.digest, platform: process.platform, node: process.version,
      source: 'real-local-business-https', results: [[200, null], [409, 'VERSION_CONFLICT']], capturedBeforeTrigger: true,
    }, null, 2));
  }
  const retry = await captureRepro(source, { contextFile, out: file });
  assert.equal(retry.reused, true); assert.equal(retry.package.digest, captured.package.digest, 'retry does not collect the post-trigger scene');

  const target = join(root, 'receiver'); targets.push(target);
  const restored = await restoreRepro(source, { file, target, expectedDigest: captured.package.digest });
  assert.equal(restored.verification.reproduction, 'unverified');
  assert.notEqual(restored.environment.root, source.env.root);
  const receiver = resolveContext({ worktree: target }); receivers.push(receiver);
  // Preinstalled local dependencies are reused for this acceptance, never installed during restore.
  for (const app of ['student', 'teaching']) {
    symlinkSync(join(worktree, 'apps', app, 'node_modules'), join(target, 'apps', app, 'node_modules'), 'junction');
    utimesSync(join(target, 'apps', app, 'package-lock.json'), new Date(0), new Date(0));
  }
  assert.equal(withDb(receiver, db => JSON.parse(db.prepare('SELECT attempt_json FROM attempts').get().attempt_json).workspaceRevision), attempt.workspaceRevision, 'restored the pre-trigger revision');
  assert.equal(withDb(receiver, db => db.prepare('SELECT count(*) AS n FROM sessions').get().n), 0);
  assert.equal(withDb(receiver, db => db.prepare('SELECT count(*) AS n FROM jobs').get().n), 0);
  const receiverUp = await up(receiver, () => {});
  assert.deepEqual(receiverUp.accounts.list.map(a => a.loginName).sort(), restored.data.accounts.map(a => a.loginName).sort(), 'public up reports regenerated account names');
  const verified = await verifyRepro(receiver, { file });
  assert.equal(verified.ok, true, JSON.stringify(verified.verification));
  assert.equal(verified.verification.reproduction, 'verified');
  assert.equal(verified.verification.evidence, 'real-local-business-https');
  assert.deepEqual(verified.verification.results.map(r => [r.status, r.errorCode]), [[200, null], [409, 'VERSION_CONFLICT']]);
  assert.equal(inspectRepro(file).verification.reproduction, 'unverified', 'immutable package does not acquire a fabricated verified label');
  assert.equal(git(worktree, ['rev-parse', 'HEAD']), sourceHead);
  assert.equal(git(worktree, ['status', '--porcelain']), sourceStatus);
  await down(receiver);

  await t.test('compatibility, digest and missing-resource failures preserve the receiving worktree', async () => {
    await assert.rejects(() => restoreRepro(source, { file, target }), { code: 'TARGET_EXISTS' });
    await assert.rejects(() => restoreRepro(source, { file, target: join(root, 'bad-digest'), expectedDigest: digest('wrong') }), { code: 'DIGEST_MISMATCH' });
    for (const [field, value, code] of [['node', 'v0.0.0', 'NODE_VERSION_MISMATCH'], ['toolVersion', 'future', 'TOOL_VERSION_MISMATCH']]) {
      const modified = decodeZip(readFileSync(file)), manifest = JSON.parse(modified.get('manifest.json'));
      manifest.conditions[field] = value; modified.set('manifest.json', jsonBytes(manifest));
      const bad = join(root, `bad-${field}.zip`); writeFileSync(bad, resign(modified));
      await assert.rejects(() => restoreRepro(source, { file: bad, target: join(root, `target-${field}`) }), { code });
      assert.equal(existsSync(join(root, `target-${field}`)), false);
    }
    for (const kind of ['lock', 'schema']) {
      const modified = decodeZip(readFileSync(file)), manifest = JSON.parse(modified.get('manifest.json'));
      if (kind === 'lock') manifest.conditions.lockfiles['apps/student/package-lock.json'] = digest('different dependency');
      else manifest.data.schema = digest('incompatible schema');
      modified.set('manifest.json', jsonBytes(manifest));
      const bad = join(root, `bad-${kind}.zip`); writeFileSync(bad, resign(modified));
      await assert.rejects(() => restoreRepro(source, { file: bad, target: join(root, `target-${kind}`) }), { code: kind === 'lock' ? 'LOCKFILE_MISMATCH' : 'SCHEMA_MISMATCH' });
      assert.equal(existsSync(join(root, `target-${kind}`)), false);
    }
    const modified = decodeZip(readFileSync(file)); modified.delete('code/source.bundle');
    const missing = join(root, 'missing.zip'); writeFileSync(missing, resign(modified));
    assert.throws(() => inspectRepro(missing), { code: 'RESOURCE_MISSING' });
  });

  await t.test('JSON membership references fail closed and secret source/data never get silently shared', async () => {
    withDb(source, db => db.prepare("UPDATE attempts SET attempt_json=json_set(attempt_json,'$.ownerId','unselected-member') WHERE attempt_id=?").run(before.attempt_id));
    await assert.rejects(() => captureRepro(source, { contextFile, out: join(root, 'bad-scope.zip') }), { code: 'SCOPE_VIOLATION' });
    withDb(source, db => db.prepare("UPDATE attempts SET attempt_json=json_remove(attempt_json,'$.ownerId') WHERE attempt_id=?").run(before.attempt_id));
  });

  await t.test('after-incident and uncertain external scenes remain unverified; queued source jobs cannot resume in restored data', async () => {
    withDb(source, db => {
      const receipt = db.prepare("SELECT receipt_id FROM command_receipts WHERE course_id='synthetic-textscope-c' LIMIT 1").get();
      db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?)').run('old-queued-job', 'synthetic-textscope-c', 'synthetic-student', before.attempt_id,
        receipt.receipt_id, 'student_help', 'queued', 0, generation, JSON.stringify({ state: 'queued', marker: 'OLD_QUEUE_CANARY' }));
    });
    for (const [name, scene] of [['after', { start: 'after-incident' }], ['uncertain', { externalUncertainty: true }]]) {
      const nextSpec = { ...spec, scenario: { ...spec.scenario, ...scene } };
      const nextContext = join(root, `${name}-context.json`), nextFile = join(root, `${name}.zip`), nextTarget = join(root, `${name}-target`);
      writeFileSync(nextContext, JSON.stringify(nextSpec)); targets.push(nextTarget);
      await captureRepro(source, { contextFile: nextContext, out: nextFile });
      await restoreRepro(source, { file: nextFile, target: nextTarget });
      const context = resolveContext({ worktree: nextTarget }); receivers.push(context);
      const result = await verifyRepro(context, { file: nextFile });
      assert.equal(result.verification.reproduction, 'unverified');
      const db = new Driver(context.env.database, { readonly: true });
      try { assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0); } finally { db.close(); }
      assert.equal(readFileSync(context.env.database).includes(Buffer.from('OLD_QUEUE_CANARY')), false);
    }
  });

  await t.test('immutable baseline publish/list/use preserve both the previous environment and other members', async () => {
    const sourceVersion = JSON.parse(readFileSync(source.env.baselineFile, 'utf8')).version;
    const published = await publishBaseline(source, { version: 'repro-v1', contextFile });
    assert.equal(listBaselines(source).baselines[0].digest, published.package.digest);
    await assert.rejects(() => publishBaseline(source, { version: 'repro-v1', contextFile }), { code: 'BASELINE_EXISTS' });
    const baselineTarget = join(root, 'baseline-adopter'); targets.push(baselineTarget);
    const adopted = await useBaseline(source, { version: 'repro-v1', target: baselineTarget });
    const adoptedContext = resolveContext({ worktree: baselineTarget }); receivers.push(adoptedContext);
    assert.equal(adopted.previous.preserved, true);
    assert.equal(JSON.parse(readFileSync(adoptedContext.env.baselineFile, 'utf8')).version, 'repro-v1');
    assert.equal(JSON.parse(readFileSync(source.env.baselineFile, 'utf8')).version, sourceVersion);
    assert.equal(JSON.parse(readFileSync(receiver.env.baselineFile, 'utf8')).version, sourceVersion);
  });
});
