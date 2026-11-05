import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { annotationPackage } from '../components/material-annotation/package.mjs';

const legacy = process.env.XUNJIE_COMPONENT_LEGACY_PACKAGE;
const current = process.env.XUNJIE_COMPONENT_CURRENT_PACKAGE;
if (!legacy || !current) throw new Error('Set XUNJIE_COMPONENT_LEGACY_PACKAGE and XUNJIE_COMPONENT_CURRENT_PACKAGE to complete product packages.');
const fixed = resolve(current), output = resolve(process.env.XUNJIE_COMPONENT_REPORT_DIR ?? '.verification/wp03-169');
const { openProductRuntime, resolveCredential } = await import(pathToFileURL(join(fixed, 'app', 'product-runtime.js')).href);
const oldApi = await import(pathToFileURL(join(resolve(legacy), 'app', 'product-runtime.js')).href);
const scratch = await mkdtemp(join(tmpdir(), 'xj-component-legacy-'));
const root = join(scratch, 'source'), target = join(scratch, 'target');
const run = promisify(execFile), cli = join(resolve(legacy), 'app', 'cli.js');
const node = join(resolve(legacy), 'resources', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const command = async (...args) => JSON.parse((await run(node, [cli, ...args, '--root', root], { windowsHide: true, maxBuffer: 8000000 })).stdout);
const resources = JSON.parse(await readFile(join(fixed, 'resources.json'), 'utf8'));
for (const key of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath']) if (resources[key]) resources[key] = resolve(fixed, resources[key]);
const fixedCommand = async (selectedRoot, ...args) => JSON.parse((await run(resources.nodePath,
  [join(fixed, 'app', 'cli.js'), ...args, '--root', selectedRoot], { windowsHide: true, maxBuffer: 8000000 })).stdout);
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
let runtime, databaseStarted = false;
const report = { status: 'running', root, target, cases: [], legacyPackage: resolve(legacy), currentPackage: fixed,
  platform: process.platform, arch: process.arch, node: process.version, teachingOutcome: 'not-evaluated',
  productRestoreTakeover: 'not-run' };
const privateInput = async (name, value) => {
  const path = join(scratch, name + '.json'); await writeFile(path, JSON.stringify(value), { mode: 0o600 }); return path;
};
// Record categories, never child stdout/configuration, credentials or a raw SQL diagnostic.
const category = error => /corrupt/i.test(String(error.stderr ?? error.message)) ? 'corrupt'
  : /incompatible/i.test(String(error.stderr ?? error.message)) ? 'incompatible' : 'operation-failed';
try {
  report.legacyDistributionSha256 = await digest(join(resolve(legacy), 'distribution.json'));
  report.currentDistributionSha256 = await digest(join(fixed, 'distribution.json'));
  report.postgres = (await run(join(resources.postgresBin, process.platform === 'win32' ? 'postgres.exe' : 'postgres'), ['--version'])).stdout.trim();
  await command('install', '--profile', 'local');
  const { endpoint } = await command('start');
  let authorization = `Bearer ${await resolveCredential(root, 'control')}`;
  const input = { requestId: randomUUID(), ...await annotationPackage() };
  input.manifest.componentId = input.manifest.componentId.toUpperCase();
  const response = await fetch(endpoint + '/api/learning/manage/component-import', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 200, 'the unchanged legacy product must accept the counterexample');
  const original = await response.json();
  const call = async (base, route, body, headers = { authorization }) => {
    const response = await fetch(base + '/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, route); return { value: await response.json(), headers: response.headers };
  };
  const courseId = randomUUID(), releaseId = randomUUID(), password = randomUUID(), loginName = 'legacy-component-member';
  const member = await call(endpoint, 'manage/members', { requestId: randomUUID(), loginName, password });
  await call(endpoint, 'manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '原大写组件课程' },
    task: { taskId: randomUUID(), title: '原固定活动', summary: '' }, release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['保留原活动状态'], requirements: '保留旧活动', materials: [],
      starterWorks: [], capabilities: [], components: [{ key: 'annotation', definition: original, configuration: { title: '标注' }, materialIds: [] }] }, resources: [] });
  await call(endpoint, 'manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true });
  const login = await call(endpoint, 'login', { loginName, password }, {});
  let student = { cookie: login.headers.get('set-cookie').split(';')[0] };
  const activity = (await call(endpoint, 'course-activities', { requestId: randomUUID(), releaseId }, student)).value;
  const stateFile = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/annotation.json', kind: 'state', encoding: 'json',
    mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1, instanceId: activity.activityId + ':annotation',
      componentId: input.manifest.componentId, version: input.manifest.version, definitionDigest: original.digest, stateVersion: 1,
      operationId: randomUUID(), content: { annotations: [{ id: randomUUID(), quote: '旧依据', note: '旧活动必须保留' }] } }) };
  await call(endpoint, 'workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [stateFile] }, student);
  const query = async (endpoint, componentId) => {
    const result = await fetch(endpoint + '/api/learning/manage/component-read', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ componentId, version: input.manifest.version }) });
    return { status: result.status, value: await result.json() };
  };
  assert.equal((await query(endpoint, input.manifest.componentId.toLowerCase())).status, 503, 'old artifact reproduces R5');
  report.cases.push('unchanged legacy product accepts uppercase UUID and fails lowercase read');
  const keyFile = join(scratch, 'recovery-key');
  await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  const backupDirectory = join(scratch, 'backups');
  let backup;
  try {
    backup = await command('backup', '--file', await privateInput('backup', { keyFile, directory: backupDirectory, leaveClosed: true }));
    report.oldBackup = { status: 'passed', backupId: backup.backupId };
  } catch (error) {
    report.oldBackup = { status: 'failed', category: category(error) };
    if (report.oldBackup.category !== 'corrupt') throw error;
  }
  if (backup) {
    const restored = await fixedCommand(target, 'restore', '--file', await privateInput('restore', {
      keyFile, backupDirectory: join(backupDirectory, backup.backupId) }));
    assert.equal(restored.phase, 'isolated');
    runtime = openProductRuntime({ root: target });
    assert.equal((await fixedCommand(target, 'start')).state, 'maintenance');
    await fixedCommand(target, 'takeover', '--file', await privateInput('takeover', { sourceRoot: root, receivers: [] }));
    report.productRestoreTakeover = 'passed';
    report.migration = { path: 'old CLI held backup -> current CLI restore -> target takeover', status: 'passed' };
    authorization = `Bearer ${await resolveCredential(target, 'control')}`;
  } else {
    // A legacy owner may reject its own uppercase record during backup validation. This
    // fallback verifies R5 after an explicit owner migration; it does not claim a successful
    // product backup/restore, and never rewrites an existing migration or business record.
    const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
    const bindings = await Promise.all(['space-course', 'learning-data'].map(async unit => {
      const descriptor = environment.services.find(service => service.unit === unit);
      assert.ok(descriptor, unit);
      const binding = JSON.parse(await resolveCredential(root, `storage-${descriptor.serviceId}`));
      return { unit, binding };
    }));
    const { spaceCourseMigrations, learningMigrations } = await import('@xunjie/learning-space');
    const histories = [];
    // Use the old owner's public storage surface to close the existing generation before
    // stopping its daemon. 60f58c5 has 8 course and 5 learning migrations; openStorage
    // checks that this current-plan prefix matches every registered old checksum.
    for (const { unit, binding } of bindings) {
      const plan = unit === 'space-course' ? spaceCourseMigrations : learningMigrations;
      const oldLength = unit === 'space-course' ? 8 : 5;
      const storage = await oldApi.storage.openStorage({ binding, migrations: plan.slice(0, oldLength),
        backend: oldApi.storage.createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) }) });
      try {
        await storage.participant().closeWrites(); await storage.participant().closeDispatch(); await storage.participant().drain();
        histories.push({ unit, before: oldLength, after: plan.length });
      } finally { await storage.close(); }
    }
    await command('stop');
    const database = JSON.parse(await readFile(join(root, 'database.json'), 'utf8'));
    const pgCtl = join(resources.postgresBin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
    await run(pgCtl, ['start', '-D', join(root, 'pgdata'), '-l', join(root, 'postgres.log'), '-w', '-t', '30',
      '-o', `-h 127.0.0.1 -p ${database.binding.port} -c timezone=UTC -c unix_socket_directories=${process.platform === 'win32' ? '' : "''"}`]);
    databaseStarted = true;
    const { storage, recoveryDatabase } = await import(pathToFileURL(join(fixed, 'app', 'product-runtime.js')).href);
    const admin = await recoveryDatabase(root);
    for (const { unit, binding } of bindings) {
      const migrated = await storage.provisionStorage({ admin, owner: binding.owner, password: binding.connection.password,
        migrations: unit === 'space-course' ? spaceCourseMigrations : learningMigrations });
      assert.ok(JSON.stringify(migrated) === JSON.stringify(binding), 'explicit migration must preserve the original owner and login binding');
    }
    await run(pgCtl, ['stop', '-D', join(root, 'pgdata'), '-m', 'fast', '-w', '-t', '30']);
    databaseStarted = false;
    runtime = openProductRuntime({ root, resources });
    report.migration = { path: 'explicit owner storage.provisionStorage on closed schemas; not product automatic upgrade', status: 'passed', histories };
  }
  const started = await runtime.start();
  assert.ok(['ready', 'degraded'].includes(started.state));
  const verify = async base => {
    const login = await call(base, 'login', { loginName, password }, {});
    student = { cookie: login.headers.get('set-cookie').split(';')[0] };
    for (const identity of [input.manifest.componentId, input.manifest.componentId.toLowerCase()]) {
      const result = await query(base, identity); assert.equal(result.status, 200); assert.deepEqual(result.value, original);
    }
    assert.deepEqual((await call(base, 'activities/' + activity.activityId, undefined, student)).value, activity);
    assert.equal((await call(base, 'workspaces/' + activity.activityId, undefined, student)).value.files[0].value, stateFile.value);
  };
  await verify(started.endpoint);
  report.cases.push('after explicit migration and fresh login both UUID spellings preserve the original manifest/digest, activity and state bytes');
  for (let cycle = 1; cycle <= 2; cycle++) {
    await runtime.stop(); const reopened = await runtime.start();
    assert.ok(['ready', 'degraded'].includes(reopened.state)); await verify(reopened.endpoint);
    report.cases.push(`stop/start cycle ${cycle} preserves original definition, fixed activity and state after fresh login`);
  }
  report.original = { componentId: input.manifest.componentId, version: input.manifest.version,
    definitionDigest: original.digest, stateSha256: createHash('sha256').update(stateFile.value).digest('hex') };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof assert.AssertionError ? error.message : category(error);
  throw new Error(report.error);
}
finally {
  const cleanup = [];
  if (runtime) { try { await runtime.stop(); cleanup.push('fixed stopped'); } catch { cleanup.push('fixed stop failed'); } }
  try { await command('stop'); cleanup.push('legacy stopped'); } catch { cleanup.push('legacy stop failed'); }
  if (databaseStarted) {
    try { await run(join(resources.postgresBin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'),
      ['stop', '-D', join(root, 'pgdata'), '-m', 'fast', '-w', '-t', '30']); cleanup.push('migration PostgreSQL stopped'); }
    catch { cleanup.push('migration PostgreSQL stop failed'); }
  }
  report.cleanup = cleanup;
  if (!cleanup.some(item => item.includes('failed'))) { await rm(scratch, { recursive: true, force: true }); report.privateScratch = 'removed'; }
  else report.privateScratch = 'retained for stop failure';
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'legacy-remediation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, cases: report.cases, cleanup: report.cleanup }));
}
