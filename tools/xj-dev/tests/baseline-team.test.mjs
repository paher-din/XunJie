import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { test } from 'node:test';
import { createAccessService } from '../../xj-dev-access/server.mjs';
import { adminRequest } from '../../xj-dev-access/admin.mjs';
import { createPackages } from '../../xj-dev-access/packages.mjs';
import { authenticatedRequest, joinEnrollment } from '../src/enrollment-client.mjs';
import { ensureCertificateAuthority, ensureEnvironmentCertificate } from '../src/certificates.mjs';
import { environmentId, environmentPaths, repoPaths } from '../src/paths.mjs';
import { writePrivateJson } from '../src/enrollment-protocol.mjs';
import { ensureBaseline } from '../src/baseline.mjs';
import { databaseDriver } from '../src/repro-data.mjs';
import { captureRepro } from '../src/repro.mjs';
import { baselineRoute } from '../src/repro-routes.mjs';
import { LOCKFILES, git } from '../src/repro-code.mjs';
import { decodeZip, digest, encodeZip, jsonBytes } from '../src/repro-archive.mjs';
import { crc64XZ } from '../src/package-transfer.mjs';
import { acquireLock } from '../src/state.mjs';

const checkout = realpathSync(join(import.meta.dirname, '../../..'));

// Real access HTTPS/proof/SQLite, real ZIP/fetch/restore. Only object storage and
// privileged OS/account adapters are controlled; this is not cloud acceptance.
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xj-team-'))), home = join(root, 'home'), worktree = join(root, 'source');
  const targets = [], objects = new Map(), downloads = [], controls = {};
  let service, objectServer;
  const oldCA = getCACertificates('default');
  t.after(async () => {
    await service?.close();
    objectServer?.closeAllConnections();
    if (objectServer) await new Promise(done => objectServer.close(done));
    for (const target of targets) if (existsSync(target)) git(worktree, ['worktree', 'remove', '--force', target]);
    setDefaultCACertificates(oldCA);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const ca = ensureCertificateAuthority(root), cert = ensureEnvironmentCertificate(environmentPaths(root, 'tls'), ca);
  setDefaultCACertificates([...oldCA, readFileSync(ca.certFile, 'utf8')]);
  const host = join(root, 'host');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', host], { stdio: 'ignore' }).status, 0);
  const keyFile = join(root, 'credential.key'), pins = join(root, 'pins');
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  writeFileSync(pins, 'approved.test ' + readFileSync(host + '.pub', 'utf8'));
  objectServer = createServer({ key: readFileSync(cert.keyFile), cert: readFileSync(cert.certFile) }, (req, res) => {
    const id = new URL(req.url, 'https://localhost').pathname.slice(1), object = [...objects.values()].find(o => o.id === id);
    if (!object) { res.writeHead(404); res.end(); return; }
    const offset = Number(req.headers.range?.match(/^bytes=(\d+)-$/)?.[1]);
    downloads.push(id);
    if (!Number.isSafeInteger(offset) || req.headers['if-match'] !== object.etag) { res.writeHead(412); res.end(); return; }
    const bytes = Buffer.from(object.bytes);
    if (controls.corrupt) bytes[30] ^= 1;
    res.writeHead(206, { etag: object.etag, 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`, 'content-length': bytes.length - offset });
    res.end(bytes.subarray(offset));
  });
  await new Promise(done => objectServer.listen(0, '127.0.0.1', done));
  const objectOrigin = `https://127.0.0.1:${objectServer.address().port}`;
  const storage = {
    head: async key => objects.get(key)?.head ?? null,
    download: async (key, offset, etag) => ({ method: 'GET', url: `${objectOrigin}/${objects.get(key).id}?signature=${randomBytes(24).toString('hex')}`,
      headers: { host: new URL(objectOrigin).host, range: `bytes=${offset}-`, 'if-match': etag }, expiresAt: Date.now() + 299000, allowedHost: new URL(objectOrigin).host }),
  };
  const config = { serviceId: randomUUID(), endpoint: 'https://localhost:8443', port: 0, listenHost: '127.0.0.1',
    databaseFile: join(root, 'access.sqlite'), credentialKeyFile: keyFile, adminSocket: join(root, 'a'), backupDirectory: root,
    tls: { keyFile: cert.keyFile, certFile: cert.certFile, caFile: ca.certFile }, knownHostsFile: pins, cloudCaFile: ca.certFile,
    courseIds: ['course'], target: { schema: 'xj-dev/connection-v1', host: 'approved.test', port: 22, browserOrigin: 'https://localhost:13445', applicationPort: 13444 },
    packages: { bucket: 'fixture-bucket', prefix: 'team/' } };
  service = createAccessService(config, { storage, system: async input => ({ username: 'xjd_' + input.deviceId.replaceAll('-', '').slice(0, 28) }), application: async () => ({}) });
  // Exercise client binding against a conflicting/malformed catalog response,
  // while retaining the real service's proof and download authorization checks.
  service.publicServer.on('request', (_req, res) => {
    const end = res.end;
    res.end = function (bytes, ...args) {
      if (controls.catalog) {
        const body = JSON.parse(bytes);
        if (body.data?.baselines) { controls.catalog(body.data.baselines); bytes = JSON.stringify(body); }
      }
      return end.call(this, bytes, ...args);
    };
  });
  await service.listen(); config.endpoint = `https://127.0.0.1:${service.publicServer.address().port}`;
  const enroll = async (label, capabilities) => {
    const invite = await adminRequest(config.adminSocket, 'invite', { label, teamRole: 'developer', appRole: 'student', courseId: 'course', capabilities, ttlSeconds: 60 });
    const invitationFile = join(root, label + '.json'); writePrivateJson(invitationFile, invite);
    return joinEnrollment({ home: label === 'reader' ? home : join(root, label + '-home'), invitationFile });
  };
  const reader = await enroll('reader', ['file:read']), publisher = await enroll('publisher', ['file:publish']), page = await enroll('page', ['page']);
  mkdirSync(worktree); git(worktree, ['init', '-q']);
  for (const path of [...LOCKFILES, 'README.md']) {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), path === 'README.md' ? 'original source\n' : readFileSync(join(checkout, path)));
  }
  git(worktree, ['add', '.']); git(worktree, ['commit', '-qm', 'isolated baseline fixture']);
  const context = { home, worktree, instance: '', id: environmentId(worktree), env: environmentPaths(home, environmentId(worktree)), repo: repoPaths(checkout) };
  await ensureBaseline(context.repo.teaching, context.env, () => {});
  const Driver = databaseDriver(context.repo.teaching), db = new Driver(context.env.database);
  let attemptId;
  try { attemptId = db.prepare("SELECT attempt_id FROM attempts WHERE course_id='synthetic-textscope-c'").get().attempt_id; } finally { db.close(); }
  const contextFile = join(root, 'context.json');
  writeFileSync(contextFile, JSON.stringify({ formatVersion: 'xj-repro-context/1', code: { roots: [...LOCKFILES, 'README.md'] },
    data: { scope: { courseIds: ['synthetic-textscope-c'], userIds: ['synthetic-teacher', 'synthetic-student'], attemptIds: [attemptId] } },
    scenario: { title: 'team baseline fixture', start: 'before-trigger', steps: ['review isolated data'], expected: 'original is preserved', observed: 'unverified' } }));
  const file = join(root, 'baseline.zip'), captured = await captureRepro(context, { contextFile, out: file }), bytes = readFileSync(file);
  const catalog = createPackages(service.store, config.packages, { storage }).catalog;
  const publish = async (name, version, packageBytes = bytes) => {
    const p = catalog.reservation(publisher.identity, { idempotencyKey: randomUUID(), digest: digest(packageBytes), bytes: packageBytes.length,
      crc64: crc64XZ(packageBytes), formatVersion: 'xj-repro/1', toolVersion: '0.2.0' });
    const head = { bytes: p.bytes, crc64: p.crc64, etag: '"immutable-fixture"' };
    objects.set(p.object_key, { id: p.id, bytes: packageBytes, etag: head.etag, head });
    catalog.publish(p.id, head);
    await adminRequest(config.adminSocket, 'package-baseline', { name, version, reproId: p.id });
    return p.id;
  };
  const route = args => baselineRoute(context, { extraArgs: args });
  const target = label => { const path = join(root, label); targets.push(path); return path; };
  return { root, home, context, reader, publisher, page, config, service, route, target, publish, bytes, captured, catalog, controls, downloads };
}

test('team baseline catalog and pinned use retain read-only authorization, digest binding and previous data', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const entries = decodeZip(f.bytes), scenario = JSON.parse(entries.get('scenario.json'));
  entries.set('scenario.json', jsonBytes({ ...scenario, title: 'newer baseline fixture' }));
  entries.set('checksums.json', jsonBytes(Object.fromEntries([...entries].filter(([path]) => path !== 'checksums.json').map(([path, bytes]) => [path, digest(bytes)]))));
  const chosen = await f.publish('course-start', '0.2.0-fixed'), newer = await f.publish('course-start', '0.3.0-fixed', encodeZip(entries));
  await f.publish('other-course', '0.2.0-fixed');

  await t.test('catalog rejects unauthenticated, page-only, publish-only and revoked devices; reader cannot publish/manage', async () => {
    const raw = await new Promise((accept, reject) => {
      const req = request(new URL('/v1/packages/resolve', f.config.endpoint), { method: 'POST', ca: readFileSync(f.config.tls.caFile) }, res => {
        let text = ''; res.on('data', bytes => text += bytes); res.on('end', () => accept({ status: res.statusCode, body: JSON.parse(text) }));
      }); req.on('error', reject); req.end(JSON.stringify({ challengeId: randomUUID(), signature: 'invalid', body: { catalog: 'baselines' } }));
    });
    assert.equal(raw.status, 401); assert.equal(raw.body.data, undefined);
    for (const device of [f.page, f.publisher]) await assert.rejects(authenticatedRequest(device.deviceFile, '/v1/packages/resolve', { catalog: 'baselines' }), { code: 'CAPABILITY_DENIED' });
    await assert.rejects(authenticatedRequest(f.reader.deviceFile, '/v1/packages/upload', {}), { code: 'CAPABILITY_DENIED' });
    await assert.rejects(authenticatedRequest(f.reader.deviceFile, '/v1/packages/upload-status', { transferId: chosen }), { code: 'CAPABILITY_DENIED' });
    await adminRequest(f.config.adminSocket, 'revoke-device', { deviceId: f.publisher.identity.deviceId });
    await assert.rejects(authenticatedRequest(f.publisher.deviceFile, '/v1/packages/resolve', { catalog: 'baselines' }), { code: 'DEVICE_REVOKED' });
    const before = f.catalog.baselines();
    const listed = await authenticatedRequest(f.reader.deviceFile, '/v1/packages/resolve', { catalog: 'baselines', operation: 'package-baseline', name: 'injected', version: 'v1', reproId: chosen });
    assert.equal(listed.baselines.length, 3); assert.deepEqual(f.catalog.baselines(), before);
    assert.equal(f.service.store.inspect().devices.length, 3);
  });

  await t.test('list uses home registration or explicit device without changing local catalog; use requires exact name/version', async () => {
    const listed = await f.route(['list', '--team']);
    assert.equal(listed.scope, 'team'); assert.equal(listed.baselines.length, 3);
    assert.equal(listed.baselines.find(b => b.reproId === chosen).digest, digest(f.bytes));
    assert.deepEqual(await f.route(['list', '--team', '--device-file', f.reader.deviceFile]), listed);
    assert.equal((await f.route(['list'])).scope, 'local'); assert.deepEqual((await f.route(['list'])).baselines, []);
    for (const args of [['use', 'course-start', '--team'], ['use', 'course-start', '--team', '--version', 'latest'], ['list', '--device-file', f.reader.deviceFile], ['publish', '--team'], ['list', '--team', '--team']]) {
      await assert.rejects(f.route(args));
    }
    await assert.rejects(f.route(['use', 'course-start', '--team', '--version', 'missing']), { code: 'RESOURCE_MISSING' });
    assert.equal(f.downloads.length, 0);
  });

  await t.test('restore pins the older exact version, creates independent local data and refuses existing worktree/data', async () => {
    const beforeDb = digest(readFileSync(f.context.env.database)), beforeSource = readFileSync(join(f.context.worktree, 'README.md'));
    const beforeHead = git(f.context.worktree, ['rev-parse', 'HEAD']);
    const target = f.target('adopted');
    const result = await f.route(['use', 'course-start', '--team', '--version', '0.2.0-fixed', '--target', target]);
    assert.equal(result.scope, 'team'); assert.equal(result.baseline.reproId, chosen); assert.notEqual(result.baseline.reproId, newer);
    assert.equal(result.baseline.version, '0.2.0-fixed'); assert.equal(result.baseline.digest, digest(f.bytes));
    assert.equal(result.environment.worktree, target); assert.equal(result.environment.mode, 'local');
    assert.equal(result.verification.restored, true); assert.equal(result.verification.reproduction, 'unverified');
    assert.equal(result.previous.preserved, true); assert.deepEqual(f.downloads, [chosen]);
    assert.equal(result.data.database, environmentPaths(f.home, environmentId(target)).database);
    assert.notEqual(result.data.database, f.context.env.database);
    assert.equal(JSON.parse(readFileSync(environmentPaths(f.home, environmentId(target)).baselineFile)).version, '0.2.0-fixed');
    assert.equal(digest(readFileSync(f.context.env.database)), beforeDb);
    assert.deepEqual(readFileSync(join(f.context.worktree, 'README.md')), beforeSource);
    assert.equal(git(f.context.worktree, ['rev-parse', 'HEAD']), beforeHead);
    const adoptedDb = digest(readFileSync(result.data.database));
    const again = ['use', 'course-start', '--team', '--version', '0.2.0-fixed', '--target', target];
    await assert.rejects(f.route(again), { code: 'TARGET_EXISTS' });
    assert.equal(digest(readFileSync(result.data.database)), adoptedDb);
    const occupied = f.target('occupied-data'), env = environmentPaths(f.home, environmentId(occupied));
    mkdirSync(env.data, { recursive: true }); writeFileSync(env.database, 'existing data must survive');
    await assert.rejects(f.route([...again.slice(0, -1), occupied]), { code: 'TARGET_EXISTS' });
    assert.equal(existsSync(occupied), false); assert.equal(readFileSync(env.database, 'utf8'), 'existing data must survive');
    // Restore must recheck cached bytes against the selected digest each time.
    const corrupted = readFileSync(result.transfer.file); corrupted[30] ^= 1; writeFileSync(result.transfer.file, corrupted);
    const rejected = f.target('corrupt-cache');
    await assert.rejects(f.route([...again.slice(0, -1), rejected]), { code: 'DIGEST_MISMATCH' });
    assert.equal(existsSync(rejected), false); assert.equal(digest(readFileSync(f.context.env.database)), beforeDb);
  });

  await t.test('catalog digest is independently bound to fetch, and malformed/ambiguous entries cannot select a target', async () => {
    const target = f.target('conflicting-catalog');
    f.controls.catalog = entries => { entries.find(b => b.reproId === newer).digest = digest('different catalog claim'); };
    try {
      await assert.rejects(f.route(['use', 'course-start', '--team', '--version', '0.3.0-fixed', '--target', target]), { code: 'DIGEST_MISMATCH' });
      assert.equal(existsSync(target), false);
      assert.equal(existsSync(environmentPaths(f.home, environmentId(target)).root), false);
      assert.equal(f.downloads.at(-1), newer);
      for (const mutate of [entries => entries.push({ ...entries[0] }), entries => { entries[0].name = 123; }, entries => { entries[0].reproId = '../local.zip'; }]) {
        f.controls.catalog = mutate;
        await assert.rejects(f.route(['list', '--team']), { code: 'BASELINE_CATALOG_INVALID' });
      }
    } finally { delete f.controls.catalog; }
  });

  await t.test('CLI parses team boolean and catalog output through the existing authenticated route', async () => {
    const child = spawn(process.execPath, [join(checkout, 'tools/xj-dev/xj-dev.mjs'), 'baseline', 'list', '--team', '--worktree', checkout], {
      env: { ...process.env, XJ_DEV_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
    });
    let stdout = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.resume();
    assert.equal(await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }), 0);
    const result = JSON.parse(stdout); assert.equal(result.scope, 'team'); assert.equal(result.baselines.length, 3);
  });
});

test('--here initializes only empty local data, preserving current code and rejecting partial or concurrent environments', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.publish('course-start', '0.2.0-fixed');
  const cold = instance => {
    const id = environmentId(f.context.worktree, instance);
    return { ...f.context, instance, id, env: environmentPaths(f.home, id) };
  };
  const use = (context, extra = [], name = 'course-start') => baselineRoute(context, { extraArgs: ['use', name, '--team', '--version', '0.2.0-fixed', '--here', ...extra] });
  const absent = context => {
    for (const file of [context.env.database, context.env.baselineFile, context.env.baselineCredentials, context.env.stateFile]) assert.equal(existsSync(file), false);
    assert.equal(readdirSync(f.home).some(name => name.startsWith('baseline-import-')), false);
  };
  await t.test('imports into the same worktree without replacing dirty/untracked source or adding Git worktrees', async () => {
    const context = cold('first');
    mkdirSync(context.env.data, { recursive: true }); mkdirSync(context.env.secrets);
    writeFileSync(join(context.worktree, 'README.md'), 'my current local source\n');
    writeFileSync(join(context.worktree, 'local-only.txt'), 'must survive\n');
    const head = git(context.worktree, ['rev-parse', 'HEAD']), status = git(context.worktree, ['status', '--porcelain']);
    const worktrees = git(context.worktree, ['worktree', 'list', '--porcelain']);
    const result = await use(context);
    assert.equal(result.initializedHere, true); assert.equal(result.started, false); assert.equal(result.code.changed, false);
    assert.equal(result.environment.worktree, context.worktree); assert.equal(result.environment.root, context.env.root);
    assert.equal(result.data.database, context.env.database); assert.equal(result.verification.reproduction, 'unverified');
    assert.equal(result.baseline.digest, digest(f.bytes));
    const marker = JSON.parse(readFileSync(context.env.baselineFile));
    assert.equal(marker.version, '0.2.0-fixed'); assert.equal(marker.teamBaseline.reproId, result.baseline.reproId);
    assert.equal(git(context.worktree, ['rev-parse', 'HEAD']), head); assert.equal(git(context.worktree, ['status', '--porcelain']), status);
    assert.equal(git(context.worktree, ['worktree', 'list', '--porcelain']), worktrees);
    assert.equal(readFileSync(join(context.worktree, 'README.md'), 'utf8'), 'my current local source\n');
    assert.equal(readFileSync(join(context.worktree, 'local-only.txt'), 'utf8'), 'must survive\n');
    const before = digest(readFileSync(context.env.database));
    assert.deepEqual(await ensureBaseline(context.repo.teaching, context.env, () => {}), { created: false, version: '0.2.0-fixed' });
    await assert.rejects(use(context), { code: 'TARGET_EXISTS' });
    assert.equal(digest(readFileSync(context.env.database)), before);
  });

  await t.test('each existing DB/marker/sidecar/state/credential or unknown data file blocks initialization without touching bytes', async () => {
    const samples = ['database', 'baselineFile', 'stateFile', 'baselineCredentials', 'wal', 'shm', 'journal', 'state-temp', 'unknown'];
    const calls = f.downloads.length;
    for (const name of samples) {
      const context = cold(name), env = context.env;
      const file = ({ wal: env.database + '-wal', shm: env.database + '-shm', journal: env.database + '-journal', 'state-temp': env.stateFile + '.tmp', unknown: join(env.data, 'foreign.txt') })[name] ?? env[name];
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'preserve ' + name);
      await assert.rejects(use(context), { code: 'TARGET_EXISTS' });
      assert.equal(readFileSync(file, 'utf8'), 'preserve ' + name);
      if (file !== env.database) assert.equal(existsSync(env.database), false);
    }
    assert.equal(f.downloads.length, calls);
    for (const mode of ['cloud', 'cloud-api']) {
      const context = cold(mode); mkdirSync(context.env.root, { recursive: true });
      const selection = join(context.env.root, 'selection.json'); writeFileSync(selection, JSON.stringify({ mode, targets: {} }));
      await assert.rejects(use(context), { code: 'LOCAL_DATA_REQUIRED' }); absent(context);
      assert.equal(JSON.parse(readFileSync(selection)).mode, mode);
    }
    await assert.rejects(use(cold('conflict'), ['--target', join(f.root, 'unused')]), { code: 'INVALID_ARGUMENTS' });
    await assert.rejects(baselineRoute(cold('local-flag'), { extraArgs: ['use', 'local-v1', '--here'] }), { code: 'INVALID_ARGUMENTS' });
  });

  await t.test('the checks repeat after fetch and under both locks; a concurrent up/selection change cannot win unnoticed', async () => {
    for (const which of ['data', 'selection']) {
      const context = cold('held-' + which);
      const lock = acquireLock(which === 'data' ? context.env : { ...context.env, lockFile: join(context.env.root, 'selection.lock') });
      try { await assert.rejects(use(context), { code: 'LOCK_HELD' }); absent(context); }
      finally { lock.release(); }
    }
    for (const which of ['data', 'selection']) {
      const context = cold('race-' + which);
      f.controls.catalog = () => {
        const file = which === 'data' ? context.env.database : join(context.env.root, 'selection.json');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, which === 'data' ? 'foreign DB won the race' : JSON.stringify({ mode: 'cloud' }));
      };
      try {
        await assert.rejects(use(context), { code: which === 'data' ? 'TARGET_EXISTS' : 'LOCAL_DATA_REQUIRED' });
        assert.equal(existsSync(context.env.baselineFile), false); assert.equal(existsSync(context.env.baselineCredentials), false);
        if (which === 'data') assert.equal(readFileSync(context.env.database, 'utf8'), 'foreign DB won the race');
      } finally { delete f.controls.catalog; }
    }
  });

  await t.test('schema, dependencies, lockfiles and account metadata must all match before live publication', async () => {
    const variant = mutate => {
      const entries = decodeZip(f.bytes), manifest = JSON.parse(entries.get('manifest.json'));
      mutate(manifest); entries.set('manifest.json', jsonBytes(manifest));
      entries.set('checksums.json', jsonBytes(Object.fromEntries([...entries].filter(([path]) => path !== 'checksums.json').map(([path, bytes]) => [path, digest(bytes)]))));
      return encodeZip(entries);
    };
    await f.publish('wrong-schema', '0.2.0-fixed', variant(m => { m.data.schema = digest('different schema'); }));
    await f.publish('wrong-accounts', '0.2.0-fixed', variant(m => { m.data.accounts[0].id = 'missing-user'; }));
    for (const [name, code] of [['wrong-schema', 'SCHEMA_MISMATCH'], ['wrong-accounts', 'INVALID_DATA']]) {
      const context = cold(name); await assert.rejects(use(context, [], name), { code }); absent(context);
    }
    const missing = cold('missing-deps'); missing.repo = { ...missing.repo, teaching: join(f.root, 'no-dependencies') };
    await assert.rejects(use(missing), { code: 'DEPENDENCIES_NOT_READY' }); absent(missing);
    const changed = cold('changed-lock'), file = join(changed.worktree, LOCKFILES[0]), original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from('\nreal lock change\n')]));
    try { await assert.rejects(use(changed), { code: 'LOCKFILE_MISMATCH' }); absent(changed); }
    finally { writeFileSync(file, original); }
  });

  await t.test('staging errors and a failed final rename leave no half environment and preserve prior empty directories', async () => {
    const context = cold('publish-failure');
    mkdirSync(context.env.data, { recursive: true }); mkdirSync(context.env.secrets);
    const original = fs.renameSync;
    fs.renameSync = (from, to, ...args) => {
      if (to === context.env.data) {
        assert.equal(existsSync(context.env.baselineCredentials), true, 'credentials must be ready before data publication');
        throw Object.assign(new Error('controlled publish failure'), { code: 'ENOSPC' });
      }
      return original(from, to, ...args);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(use(context), { code: 'ENOSPC' }); }
    finally { fs.renameSync = original; syncBuiltinESMExports(); }
    absent(context); assert.deepEqual(readdirSync(context.env.data), []); assert.deepEqual(readdirSync(context.env.secrets), []);
    // The final check also protects against non-cooperating writes while the
    // staged restore awaits hashing. Verify both cooperative locks are held.
    const raced = cold('staging-race'), write = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = (file, ...args) => {
      if (!injected && typeof file === 'string' && file.includes('baseline-import-') && file.endsWith('baseline.json.tmp')) {
        injected = true;
        assert.throws(() => acquireLock(raced.env), { code: 'LOCK_HELD' });
        assert.throws(() => acquireLock({ ...raced.env, lockFile: join(raced.env.root, 'selection.lock') }), { code: 'LOCK_HELD' });
        mkdirSync(raced.env.data); write(raced.env.database, 'preserve late DB');
      }
      return write(file, ...args);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(use(raced), { code: 'TARGET_EXISTS' }); }
    finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
    assert.equal(injected, true); assert.equal(readFileSync(raced.env.database, 'utf8'), 'preserve late DB');
    assert.equal(existsSync(raced.env.baselineFile), false); assert.equal(existsSync(raced.env.secrets), false);
    assert.equal(readdirSync(f.home).some(name => name.startsWith('baseline-import-')), false);
  });

  await t.test('public CLI --here imports data in the specified current checkout instance', async () => {
    const instance = 'here-cli', env = environmentPaths(f.home, environmentId(checkout, instance));
    const child = spawn(process.execPath, [join(checkout, 'tools/xj-dev/xj-dev.mjs'), 'baseline', 'use', 'course-start', '--team', '--version', '0.2.0-fixed', '--here', '--worktree', checkout, '--instance', instance], {
      env: { ...process.env, XJ_DEV_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
    });
    let stdout = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.resume();
    assert.equal(await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); }), 0, stdout);
    const result = JSON.parse(stdout);
    assert.equal(result.environment.worktree, checkout); assert.equal(result.environment.root, env.root);
    assert.equal(result.initializedHere, true); assert.equal(existsSync(env.database), true); assert.equal(existsSync(env.stateFile), false);
  });
});
