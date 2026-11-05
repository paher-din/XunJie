import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const { values } = parseArgs({ options: { package: { type: 'string' }, out: { type: 'string' } } });
if (!values.package || !values.out) throw new Error('Usage: node scripts/probe-component-package.mjs --package PRODUCT --out REPORT_DIRECTORY');
const product = resolve(values.package), output = resolve(values.out);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
for (const name of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath']) {
  if (resources[name]) resources[name] = resolve(product, resources[name]);
}
const cli = join(product, 'app', 'cli.js');
const pgTool = name => join(resources.postgresBin, name + (process.platform === 'win32' ? '.exe' : ''));
const report = { formatVersion: 1, status: 'running', startedAt: new Date().toISOString(), product,
  platform: process.platform, arch: process.arch, osRelease: release(), harnessNode: process.version,
  commands: [], api: [], cases: [], browser: 'not-run', systemIme: 'not-run', teachingOutcome: 'not-evaluated' };
const scratch = await mkdtemp(join(tmpdir(), 'xj-component-package-'));
const root = join(scratch, 'product-root'), imports = join(scratch, 'imports');
let installed = false, stopped = false;

async function command(executable, args, purpose, json = true) {
  const record = { purpose, argv: [executable, ...args], cwd: repo, startedAt: new Date().toISOString() };
  report.commands.push(record);
  try {
    const result = await execute(executable, args, { cwd: repo, timeout: 180000, maxBuffer: 8000000, windowsHide: true });
    record.exitCode = 0;
    return json ? JSON.parse(result.stdout) : result.stdout.trim();
  } catch (error) {
    record.exitCode = typeof error.code === 'number' ? error.code : null;
    // Child diagnostics may contain private configuration. Keep only exit status and phase.
    throw new Error(`${purpose} failed (${record.exitCode ?? 'process error'})`);
  } finally { record.finishedAt = new Date().toISOString(); }
}
const productCommand = (purpose, ...args) => command(resources.nodePath, [cli, ...args, '--root', root], purpose);
async function input(name, value) {
  const path = join(imports, name + '.json');
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 }); return path;
}
async function tree(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const digests = [];
  let files = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await tree(path); digests.push([entry.name, child.sha256]); files += child.files;
    } else { digests.push([entry.name, hash(await readFile(path))]); files++; }
  }
  return { sha256: hash(JSON.stringify(digests)), files };
}
async function api(endpoint, route, body, headers = {}) {
  const response = await fetch(new URL('/api/learning/' + route, endpoint), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  report.api.push({ method: body === undefined ? 'GET' : 'POST', route, status: response.status });
  assert.equal(response.status, 200, `API ${route} must succeed`);
  return { body: await response.json(), headers: response.headers };
}
const passed = name => report.cases.push(name);

try {
  const distributionBytes = await readFile(join(product, 'distribution.json'));
  const distribution = JSON.parse(distributionBytes);
  report.distributionSha256 = hash(distributionBytes);
  assert.equal(distribution.profile, 'full');
  assert.equal(distribution.platform, `${process.platform}-${process.arch}`);
  for (const [path, expected] of Object.entries(distribution.entryHashes)) {
    if (expected.sha256) assert.equal(hash(await readFile(join(product, path))), expected.sha256, `package entry ${path}`);
    if (expected.symlink) assert.equal(await readlink(join(product, path)), expected.symlink);
  }
  for (const resource of distribution.resources) for (const [path, expected] of Object.entries(resource.entryHashes)) {
    assert.equal(hash(await readFile(join(product, 'resources', resource.id, path))), expected, `resource ${resource.id}/${path}`);
  }
  report.packageEntriesVerified = true;
  report.node = await command(resources.nodePath, ['--version'], 'bundled Node version', false);
  report.postgres = await command(pgTool('postgres'), ['--version'], 'bundled PostgreSQL version', false);
  assert.equal(report.node, 'v24.21.0'); assert.match(report.postgres, /PostgreSQL\) 18\.6\b/);
  if (process.platform === 'darwin') report.macOS = await command('/usr/bin/sw_vers', [], 'macOS version', false);
  report.webBefore = await tree(resources.webRoot);

  await mkdir(imports);
  const generator = join(repo, 'components/material-annotation/package.mjs');
  await command(resources.nodePath, [generator, join(imports, 'components')], 'export public component files', false);
  const importFiles = ['component.json', 'component-v2.json'].map(name => join(imports, 'components', name));
  const componentInputs = await Promise.all(importFiles.map(async path => JSON.parse(await readFile(path, 'utf8'))));
  assert.deepEqual(componentInputs.map(value => [value.manifest.version, value.manifest.formatVersion]), [[3, 1], [2, 2]]);
  for (const value of componentInputs) {
    assert.equal(value.manifest.componentId, value.manifest.componentId.toLowerCase());
    assert.equal(value.contentBase64, undefined); assert.equal(typeof value.path, 'string');
    for (const dependency of value.dependencies ?? []) {
      assert.equal(typeof dependency.dependencyId, 'string'); assert.equal(typeof dependency.path, 'string');
      assert.equal(dependency.contentBase64, undefined);
    }
  }
  report.publicResourceGenerator = { sha256: hash(await readFile(generator)),
    components: componentInputs.map(value => ({ version: value.manifest.version, formatVersion: value.manifest.formatVersion,
      entry: value.manifest.entry, dependencies: value.manifest.dependencies ?? [] })) };

  const installation = await productCommand('CLI install', 'install', '--profile', 'local');
  assert.equal(installation.state, 'installed'); installed = true;
  const started = await productCommand('CLI first start', 'start'); assert.equal(started.state, 'ready');
  report.environmentId = started.environment.environmentId;
  passed('formal bundled CLI installs and starts an independent native product environment');
  const definitions = [];
  for (const [index, path] of importFiles.entries()) {
    const definition = await productCommand(`CLI component-import v${componentInputs[index].manifest.version}`, 'component-import', '--file', path);
    assert.deepEqual(definition.manifest, componentInputs[index].manifest); definitions.push(definition);
  }
  passed('formal CLI imports canonical v3 and prepared v2 using path and dependencyId files');

  const courseId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID();
  const materialBytes = Buffer.from('\uFEFF观察与解释\r\n阅读材料，保留原文与换行。\r\n');
  await mkdir(join(imports, 'materials'));
  await writeFile(join(imports, 'materials/open.txt'), materialBytes);
  const bindings = definitions.map((definition, index) => ({ key: index ? 'prepared' : 'annotation', definition,
    configuration: { title: index ? '材料高亮标注' : '材料标注' }, materialIds: [materialId] }));
  const course = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '独立产品包验收课程' },
    task: { taskId: randomUUID(), title: '阅读与标注', summary: '正式 CLI 路径验收' },
    release: { releaseId, objectives: ['保留固定材料与标注'], requirements: '阅读并标注，不替换原版本。',
      materials: [{ materialId, title: '公开材料', path: 'materials/open.txt', mediaType: 'text/plain', access: 'student',
        sha256: hash(materialBytes), byteLength: materialBytes.length }], starterWorks: [], capabilities: [], components: bindings } };
  assert.equal(course.resources, undefined);
  const imported = await productCommand('CLI course-import from real material path and SHA', 'course-import', '--file', await input('course', course));
  assert.equal(imported.releaseId, releaseId);
  report.material = { path: 'materials/open.txt', sha256: hash(materialBytes), byteLength: materialBytes.length };
  passed('formal CLI course-import reads the real material file and checks SHA256 and length');
  const queries = await Promise.all(definitions.map((definition, i) => input(`component-read-${i}`, {
    componentId: definition.manifest.componentId, version: definition.manifest.version })));
  for (const [i, path] of queries.entries()) {
    assert.deepEqual(await productCommand(`CLI component-read v${definitions[i].manifest.version}`, 'component-read', '--file', path), definitions[i]);
  }
  passed('formal CLI component-read returns both exact immutable definitions');

  const { resolveCredential } = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const loginName = 'package-probe-' + randomUUID(), password = randomUUID();
  const member = (await api(started.endpoint, 'manage/members', { requestId: randomUUID(), loginName, password }, admin)).body;
  await productCommand('CLI course-access for synthetic member', 'course-access', '--file', await input('access', {
    requestId: randomUUID(), courseId, principalId: member.principalId, active: true }));
  const login = async endpoint => {
    const response = await api(endpoint, 'login', { loginName, password });
    return { cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const student = await login(started.endpoint);
  const activity = (await api(started.endpoint, 'course-activities', { requestId: randomUUID(), releaseId }, student)).body;
  assert.deepEqual(activity.course.components, bindings);
  const files = bindings.map(binding => ({ objectId: randomUUID(), contentId: randomUUID(), name: `components/${binding.key}.json`,
    kind: 'state', encoding: 'json', mediaType: 'application/vnd.xunjie.component-state+json',
    value: JSON.stringify({ formatVersion: 1, instanceId: `${activity.activityId}:${binding.key}`,
      componentId: binding.definition.manifest.componentId, version: binding.definition.manifest.version,
      definitionDigest: binding.definition.digest, stateVersion: 1, operationId: randomUUID(),
      content: { annotations: [{ id: randomUUID(), quote: '观察与解释', note: '保留我的标注\n以及第二行。' }] } }) }));
  const saved = (await api(started.endpoint, 'workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 0, files }, student)).body;
  assert.deepEqual(saved.files, files);
  passed('synthetic member and fixed activity persist both component state objects through the real API');

  const stop = await productCommand('CLI first stop', 'stop'); assert.equal(stop.state, 'stopped'); stopped = true;
  const reopened = await productCommand('CLI restart', 'start'); stopped = false; assert.equal(reopened.state, 'ready');
  assert.equal(reopened.environment.environmentId, started.environment.environmentId);
  const freshStudent = await login(reopened.endpoint);
  assert.deepEqual((await api(reopened.endpoint, 'activities/' + activity.activityId, undefined, freshStudent)).body, activity);
  assert.deepEqual((await api(reopened.endpoint, 'workspaces/' + activity.activityId, undefined, freshStudent)).body, saved);
  const delivered = (await api(reopened.endpoint, `releases/${releaseId}/materials/${materialId}`, undefined, freshStudent)).body;
  assert.deepEqual(Buffer.from(delivered.contentBase64, 'base64'), materialBytes);
  const dependency = definitions[1].manifest.dependencies[0];
  const acquired = (await api(reopened.endpoint, `releases/${releaseId}/components/prepared/dependencies/${dependency.dependencyId}`, undefined, freshStudent)).body;
  assert.equal(hash(Buffer.from(acquired.contentBase64, 'base64')), dependency.sha256);
  for (const [i, path] of queries.entries()) {
    assert.deepEqual(await productCommand(`CLI component-read after restart v${definitions[i].manifest.version}`, 'component-read', '--file', path), definitions[i]);
  }
  report.stateSha256 = files.map(file => ({ name: file.name, sha256: hash(file.value) }));
  passed('CLI restart and fresh login recover the same activity, exact state, original material bytes and prepared dependency');
  const finalStop = await productCommand('CLI final stop', 'stop'); assert.equal(finalStop.state, 'stopped'); stopped = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof assert.AssertionError ? error.message : error.message;
  process.exitCode = 1;
} finally {
  try {
    if (installed && !stopped) { assert.equal((await productCommand('CLI cleanup stop', 'stop')).state, 'stopped'); stopped = true; }
    if (installed) {
      const status = await productCommand('CLI final status', 'status'); assert.equal(status.state, 'stopped');
      try { await execute(pgTool('pg_ctl'), ['status', '-D', join(root, 'pgdata')], { windowsHide: true });
        throw new Error('PostgreSQL is still running');
      } catch (error) { assert.equal(error.code, 3, 'pg_ctl must confirm the owned database is stopped'); }
      report.cleanup = { cliState: status.state, pgCtlStatusExitCode: 3 };
    } else report.cleanup = { cliState: 'installation not completed' };
    report.webAfter = await tree(resources.webRoot);
    assert.deepEqual(report.webAfter, report.webBefore, 'entire package Web tree must remain unchanged');
    await rm(scratch, { recursive: true, force: true });
    Object.assign(report.cleanup, { privateRoot: 'removed', syntheticAccount: 'removed with independent database', importDirectory: 'removed' });
  } catch {
    report.cleanup = { ...report.cleanup, status: 'failed; private scratch retained', scratch };
    report.status = 'failed'; process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'package-cli-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases, distributionSha256: report.distributionSha256,
    webBefore: report.webBefore, webAfter: report.webAfter, cleanup: report.cleanup }));
}
