#!/usr/bin/env node
/**
 * #188 execution-disposition negatives on a real client product package.
 *
 * A real managed PostgreSQL instance and the product's own owner boundary code are used. The
 * probe only writes accepted-but-unsettled execution commands through the product's owned storage
 * API (the same way #176's engineering case does); every classification, every refusal and the
 * held backup are produced by product code, never by a mock.
 *
 * The packaged executor refuses to drain while any received command lacks a confirmed terminal
 * fact, so a backup with unsettled commands is rejected during maintenance drain with
 * `unavailable` before any boundary material could be published. That fail-closed refusal is
 * recorded as-is; the probe never weakens a product assertion. A clean held backup is published
 * first as the positive control, and its bytes are rechecked after every refusal.
 *
 * Usage:
 *   node scripts/probe-execution-disposition-negative.mjs <PACKAGE> <OUTPUT> \
 *     --migrations=<frozen-learning-migrations.json> [--label=NAME]
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  label: { type: 'string' }, migrations: { type: 'string' } } });
const product = resolve(positionals[0] ?? '');
const output = resolve(positionals[1] ?? '.verification/wp03-188/execution-disposition');
const migrationsPath = resolve(values.migrations ?? '');
await mkdir(output, { recursive: true });
const runtime = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const resourcePaths = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
const resources = { ...resourcePaths };
for (const name of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper'])
  if (resources[name]) resources[name] = resolve(product, resources[name]);
const migrationsBytes = await readFile(migrationsPath);
const migrations = JSON.parse(migrationsBytes.toString('utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const outerRoot = await mkdtemp(join(tmpdir(), 'xunjie-188-disposition-'));
// The product refuses a backup directory nested inside its data root; keep them siblings.
const root = join(outerRoot, 'source');
const report = {
  label: values.label ?? `${process.platform}-${process.arch}`, platform: process.platform, arch: process.arch,
  os: release(), node: process.version, product, packageSha256: hash(await readFile(join(product, 'distribution.json'))),
  migrationsSha256: hash(migrationsBytes), migrationsCount: migrations.length,
  postgresVersion: resources.postgresVersion ?? null, cases: [], status: 'running',
  startedAt: new Date().toISOString(),
};
const reportPath = join(output, 'disposition-negative.json');
const pass = (name, detail) => { report.cases.push({ name, ...detail }); console.log('PASS ' + name + ' ' + JSON.stringify(detail)); };
const save = async () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(file)); else result.push(file);
  }
  return result;
}
async function fingerprint(directory) {
  const files = (await walk(directory)).sort();
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(relative(directory, file).split('\\').join('/'));
    digest.update(await readFile(file));
  }
  return { files: files.length, sha256: digest.digest('hex') };
}

let source, app, storage, owner;
const openedApps = [];
try {
  source = runtime.openProductRuntime({ root, resources });
  await source.install({ profile: 'local' });
  const started = await source.start();
  assert.equal(started.state, 'ready', 'the real product service must start');
  report.endpoint = started.endpoint;
  const backupDirectory = join(outerRoot, 'backups');
  const key = randomBytes(32);
  await source.setCredential('disposition-recovery-key', key.toString('base64'));
  const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
  const configuration = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'));
  const learningService = environment.services.find(item => item.unit === 'learning-data');
  assert.ok(learningService, 'the packaged runtime must have a learning-data owner');
  report.learningOwnerServiceId = learningService.serviceId;

  // A backup rotates the storage generation; always re-open the product owner through its own
  // API after a completed backup so later writes are checked against the current generation.
  async function openOwners() {
    const currentEnvironment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
    const currentConfiguration = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'));
    const service = currentEnvironment.services.find(item => item.unit === 'learning-data');
    assert.ok(service, 'the packaged runtime must have a learning-data owner');
    const currentBinding = JSON.parse(await runtime.resolveCredential(root, 'storage-' + service.serviceId));
    storage = await runtime.storage.openStorage({ binding: currentBinding, migrations,
      backend: runtime.storage.createFileBackend({ id: 'learning-data', root: join(root, 'learning-resources', 'learning-data') }) });
    app = await runtime.createProductLearningApplication({ root, environment: currentEnvironment, configuration: currentConfiguration });
    openedApps.push(app);
    owner = app.owners.find(item => typeof item.material === 'function'
      && item.participant.descriptor.serviceId === service.serviceId);
    assert.ok(owner, 'the learning-data owner must expose boundary material');
  }
  await openOwners();
  const material = async () => owner.material({ backupId: randomUUID(), boundaryAt: new Date().toISOString(),
    signal: AbortSignal.timeout(30_000) });
  const write = async (query, params) => storage.request({ requestId: randomUUID(), fingerprint: randomUUID() },
    async tx => { await tx.query(query, params); return null; });

  const attemptBackup = async () => {
    try {
      const manifest = await source.recovery.backup({ directory: backupDirectory,
        recoveryKeyRef: 'disposition-recovery-key', leaveClosed: false });
      return { published: true, backupId: manifest.backupId ?? null, manifest };
    } catch (error) {
      return { published: false, code: error.code ?? error.name, message: String(error.message ?? error).slice(0, 160) };
    }
  };
  const published = async () => (await source.recovery.catalog(backupDirectory, key)).backups;

  // 1. Positive control: a clean, fully settled boundary publishes a complete held backup.
  let heldBackup;
  {
    const name = 'a clean settled boundary publishes a complete boundary-aware held backup';
    const attempt = await attemptBackup();
    assert.equal(attempt.published, true, `the clean boundary must allow a real backup: ${attempt.code ?? ''} ${attempt.message ?? ''}`);
    const manifest = attempt.manifest;
    assert.ok(manifest.boundary?.services?.length >= 1, 'a published backup must carry aggregate boundary evidence');
    assert.ok(manifest.boundary.services.every(item => item.blocking === 0 && item.unresolved === 0));
    assert.equal((await published()).length, 1);
    const directory = join(backupDirectory, manifest.backupId);
    const before = await fingerprint(directory);
    assert.deepEqual(await fingerprint(directory), before, 'the published backup bytes must stay unchanged');
    heldBackup = { directory, fingerprint: before };
    report.publishedBackup = { backupId: manifest.backupId, services: manifest.boundary.services,
      fingerprint: before, sourceEnvironmentId: manifest.source.environmentId,
      sourceInstallationId: manifest.source.installationId };
    pass(name, { backupId: manifest.backupId, boundaryServices: manifest.boundary.services.length,
      files: before.files, sha256: before.sha256 });
    await storage.close();
    await app.lifecycle?.close?.().catch(() => {});
    for (const item of app.owners) await item.close?.().catch(() => {});
    await openOwners();
  }

  const activityId = randomUUID();
  await write('INSERT INTO activities VALUES ($1,$2,$3,$4,$5)', [activityId, environment.environmentId,
    randomUUID(), randomUUID(), JSON.stringify({ activityId, identity: { environmentId: environment.environmentId,
      spaceId: randomUUID(), principalId: randomUUID() }, target: { environmentId: environment.environmentId,
      serviceId: environment.services[0].serviceId, version: 1 }, goal: '维护边界', question: '', references: [],
      status: 'open', createdAt: new Date().toISOString() })]);
  async function command(state, statusKnowledge, stopRequested) {
    const requestId = randomUUID(), executionRef = randomUUID(), inputDigest = randomBytes(32).toString('hex');
    await write(`INSERT INTO execution_commands(request_id,activity_id,input_digest,execution_ref,body,acceptance,state,
      status_knowledge,stop_requested,confirmed_seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [requestId, activityId, inputDigest, executionRef, JSON.stringify({ activityId, requestId }),
      JSON.stringify({ accepted: true }), state, statusKnowledge, stopRequested, 1]);
    return { requestId, executionRef, inputDigest };
  }
  const settle = async ids => write(`UPDATE execution_commands SET state='succeeded',status_knowledge='confirmed',confirmed_seq=2
    WHERE request_id IN (${ids.map((_, index) => '$' + (index + 1)).join(',')})`, ids);

  // 2. The product itself classifies the stored commands and marks unprovable ones as blocking.
  const notStarted = await command('queued', 'confirmed', false);
  const unknown = await command('running', 'unknown', false);
  const stopping = await command('paused', 'confirmed', true);
  report.acceptedCommands = { notStarted, unknown, stopping };
  {
    const name = 'the packaged owner classifies accepted-not-started, stop-pending and unknown commands itself';
    const m = await material();
    const byId = new Map(m.unresolved.map(item => [item.requestId, item]));
    assert.equal(byId.size, 3, 'all three accepted commands must remain unresolved');
    assert.equal(byId.get(notStarted.requestId).disposition, 'accepted-not-started');
    assert.equal(byId.get(stopping.requestId).disposition, 'stop-pending');
    assert.equal(byId.get(unknown.requestId).disposition, 'unknown');
    assert.deepEqual(m.blocking.map(item => item.code).sort(),
      ['unconfirmed-browser-boundary', 'unresolved-stop-pending', 'unresolved-unknown']);
    for (const item of m.unresolved) {
      assert.ok(item.requestId && item.inputDigest && item.executionRef && item.activityId,
        'the boundary must keep the original execution identity');
      assert.equal(item.location, 'browser');
    }
    report.boundary = { kind: m.kind, commands: { total: m.unresolved.length, settled: m.settled },
      dispositions: m.unresolved.map(item => ({ requestId: item.requestId, disposition: item.disposition,
        inputDigest: item.inputDigest, executionRef: item.executionRef })),
      blocking: m.blocking.map(item => item.code) };
    pass(name, { kind: m.kind, dispositions: Object.fromEntries(m.unresolved.map(item => [item.disposition, item.requestId])),
      blocking: report.boundary.blocking });
  }

  // 3. A single confirmed terminal fact changes only that command; the rest stay blocking.
  {
    const name = 'settling one unknown command leaves stop-pending and accepted-not-started blocking';
    await settle([unknown.requestId]);
    const m = await material();
    assert.equal(m.settled, 1);
    assert.equal(m.unresolved.length, 2);
    assert.deepEqual(m.blocking.map(item => item.code).sort(),
      ['unconfirmed-browser-boundary', 'unresolved-stop-pending']);
    pass(name, { settled: m.settled, unresolved: m.unresolved.length,
      blocking: m.blocking.map(item => item.code) });
  }

  // 4. The same owner re-derives a clean boundary only after every command is settled.
  {
    const name = 'the packaged owner re-derives an unblocked boundary only after every command is settled';
    await settle([notStarted.requestId, stopping.requestId]);
    const m = await material();
    assert.equal(m.unresolved.length, 0);
    assert.deepEqual(m.blocking, []);
    assert.equal(m.settled, 3);
    pass(name, { settled: m.settled, unresolved: 0, blocking: 0 });
  }

  // 5. Two concrete unsettled dispositions make the packaged executor refuse maintenance drain;
  //    no complete maintenance success is published and the held backup stays byte-identical.
  const lateNotStarted = await command('queued', 'confirmed', false);
  const lateStopping = await command('paused', 'confirmed', true);
  report.lateCommands = { notStarted: lateNotStarted, stopPending: lateStopping };
  {
    const name = 'accepted-not-started and stop-pending commands make the product refuse maintenance and publish nothing new';
    const m = await material();
    const byId = new Map(m.unresolved.map(item => [item.requestId, item]));
    assert.equal(byId.get(lateNotStarted.requestId).disposition, 'accepted-not-started');
    assert.equal(byId.get(lateStopping.requestId).disposition, 'stop-pending');
    const attempt = await attemptBackup();
    console.log('BACKUP_ATTEMPT ' + JSON.stringify({ ...attempt, manifest: undefined }));
    assert.equal(attempt.published, false, 'the product must refuse this backup');
    assert.equal(attempt.code, 'unavailable', 'the packaged executor must fail closed during drain');
    assert.equal((await published()).length, 1, 'no additional backup may be published');
    const operationFiles = (await readdir(join(root, 'recovery-operations'))).filter(file => file.endsWith('.json'));
    const operations = await Promise.all(operationFiles.map(async file =>
      JSON.parse(await readFile(join(root, 'recovery-operations', file), 'utf8'))));
    const failed = operations.find(item => item.phase === 'failed');
    assert.ok(failed, 'the refused maintenance run must leave a durable failed operation');
    assert.equal(failed.error, 'unavailable');
    const maintenance = JSON.parse(await readFile(join(root, 'maintenance.json'), 'utf8'));
    assert.notEqual(maintenance.safeToStop, true, 'a refused boundary must not report a safe maintenance stop');
    assert.ok(!(await walk(backupDirectory)).some(file => file.endsWith('manifest.json')
      && file.includes(failed.backupId)), 'the failed operation must not leave a sealed manifest');
    assert.deepEqual(await fingerprint(heldBackup.directory), heldBackup.fingerprint,
      'the earlier held backup must remain byte-identical');
    report.refusal = { code: attempt.code, operationId: failed.operationId, operationPhase: failed.phase,
      operationError: failed.error, maintenancePhase: maintenance.phase, safeToStop: maintenance.safeToStop,
      publishedBackups: 1, heldBackupUnchanged: true };
    pass(name, { code: attempt.code, operationPhase: failed.phase, maintenancePhase: maintenance.phase,
      safeToStop: maintenance.safeToStop, publishedBackups: 1, heldBackupSha256: heldBackup.fingerprint.sha256 });
  }

  // 6. Refusals never retired the source, and the temporary product root is removed.
  {
    const name = 'the source installation survives the refused maintenance run';
    const status = await source.status();
    assert.notEqual(status.state, 'retired');
    assert.ok(!(await readFile(join(root, 'retired.json'), 'utf8').catch(() => null)), 'no retirement marker');
    pass(name, { sourceState: status.state, retiredMarker: false });
  }

  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { code: error.code ?? error.name, message: String(error.message ?? error).slice(0, 400),
    stack: String(error.stack ?? '').split('\n').slice(0, 6).join('\n') };
  console.log('FAILED ' + JSON.stringify(report.error));
} finally {
  try { await storage?.close?.(); } catch { /* best effort */ }
  for (const opened of openedApps) {
    try { await opened.lifecycle?.close?.(); } catch { /* best effort */ }
    for (const item of opened.owners ?? []) try { await item.close?.(); } catch { /* best effort */ }
  }
  try { await source?.stop(); } catch { /* best effort */ }
  try {
    if (!(report.status === 'failed' && process.env.XUNJIE_KEEP_FAILED_ROOT === '1')) {
      // Windows may keep short-lived handles on the managed PostgreSQL directory after stop().
      for (let attempt = 0; attempt < 5; attempt++) {
        await rm(outerRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
        if (!(await stat(outerRoot).then(() => true).catch(() => false))) break;
        await new Promise(done => setTimeout(done, 500));
      }
    }
  } catch { /* best effort */ }
  report.temporaryRootRemoved = !(await stat(outerRoot).then(() => true).catch(() => false));
  if (!report.temporaryRootRemoved) {
    report.retainedRoot = outerRoot;
    console.log('RUNTIME_LOG_TAIL ' + JSON.stringify((await readFile(join(root, 'logs', 'runtime.log'), 'utf8').catch(() => '')).trim().split('\n').slice(-12)));
  }
  report.finishedAt = new Date().toISOString();
  await save();
  console.log('STATUS ' + report.status + ' cases=' + report.cases.length + ' output=' + reportPath);
}
if (report.status !== 'passed') process.exitCode = 1;
