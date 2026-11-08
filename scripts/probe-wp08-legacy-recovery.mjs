import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Actual old code generates the history and encrypted backup. No business SQL is fabricated.
// Run with Node 24.21.0 and XUNJIE_PRODUCT_POSTGRES_BIN, after the host has built both checkouts.
//   node scripts/probe-wp08-legacy-recovery.mjs --legacy-root <checkout> --report <summary.json>
// A failed target leaves a private artifact directory. Reuse the SAME backup after rebuilding:
//   node scripts/probe-wp08-legacy-recovery.mjs --reuse <artifact-directory> --report <summary.json>
const legacyCommit = 'e7eab19bf1be16d615e500d4e301d90b1f659360';
const skills11Checksum = '4572fa1a2eb9e9a9a54e86212a60f48eb6f8d0f6e83b8c5c2ebc74f02d588baa';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.parse(JSON.stringify(value));
const checksum = item => sha(`${item.version}\n${item.name}\n${item.sql}`);
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!['--legacy-root', '--reuse', '--report', '--phase', '--artifacts'].includes(key) || !process.argv[index + 1])
    throw new Error('Expected --legacy-root, --reuse, --report, --phase or --artifacts followed by a value.');
  options[key.slice(2)] = process.argv[index + 1];
}
const load = async (root, name) => {
  // Workspace packages expose ESM import only; resolve the declared public entry, not a private src/dist seam.
  const file = join(root, 'node_modules', name, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const entry = manifest.exports?.['.']?.import;
  assert.equal(typeof entry, 'string');
  return import(pathToFileURL(resolve(dirname(file), entry)).href);
};
const safeError = error => ({ name: error?.name ?? 'Error',
  code: typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? error.code : 'probe-failed' });
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
let phase = 'initialize';

async function source(artifacts) {
  const root = resolve(options['legacy-root']);
  const { stdout } = await exec('rtk', ['bypass', 'git', '-C', root, 'rev-parse', 'HEAD']);
  assert.equal(stdout.trim(), legacyCommit, 'The legacy producer must be the pinned published Skills commit.');
  const dirty = await exec('rtk', ['bypass', 'git', '-C', root, 'status', '--porcelain', '--untracked-files=no']);
  assert.equal(dirty.stdout.trim(), '', 'The legacy producer must have no tracked edits.');
  assert.equal(process.version, 'v24.21.0');
  assert.ok(process.env.XUNJIE_PRODUCT_POSTGRES_BIN);
  assert.equal(process.env.XUNJIE_INPUT_CONTROL_ENDPOINT, undefined, 'This probe owns isolated fixtures only.');
  phase = 'old-public-module-imports';
  const learning = await load(root, '@xunjie/learning-space');
  const storageApi = await load(root, '@xunjie/storage');
  const runtimeApi = await load(root, '@xunjie/product-runtime');
  assert.equal(learning.teachingAgentMigrations.length, 11);
  assert.equal(checksum(learning.teachingAgentMigrations[10]), skills11Checksum);
  const { fixture, reply, until } = await import(pathToFileURL(join(root, 'apps/server/tests/support/teaching-input-control.mjs')).href);
  let reference;
  const f = await fixture((_payload, response, index) => {
    assert.ok(index <= 2, 'Only the original two model calls are permitted.');
    return reply(response, index === 1 ? { calls: [{ id: 'legacy-217-fixed-read', name: 'skill_read',
      arguments: { ...reference, path: 'references/checklist.txt' } }] }
      : { text: '根据固定检查表，先保留原预测与观察，再解释差异。' });
  });
  let owner;
  try {
    phase = 'old-agent-question-and-skill-read';
    await f.configure();
    const activity = await f.activity('WP08 旧 Skills 历史恢复'), route = `agent/${activity.activityId}`;
    const packageInput = { requestId: randomUUID(), source: 'acceptance:wp08-legacy-recovery', packageVersion: '1.0.0', files: [
      { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: fixed-observation\ndescription: 保留学习观察与问题\n---\n使用 references/checklist.txt 核对原始观察。' },
      { path: 'references/checklist.txt', encoding: 'utf8', content: '原预测：每次循环保持同一条件。原观察：边界值需要单独核对。' },
    ] };
    const imported = await f.api('skills/import', packageInput);
    reference = { skillId: imported.skillId, version: imported.version };
    await f.api('skills/select', { requestId: randomUUID(), range: { kind: 'all' }, skills: [reference] });
    const sent = await f.send(activity, '请读取固定检查表，解释原预测和边界观察的差异。');
    const conversation = await until(async () => {
      const value = await f.api(route + '/conversation'), run = value.runs.find(item => item.runId === sent.runId);
      if (run && ['failed', 'paused'].includes(run.state)) throw new Error('The old Agent did not finish the real question.');
      return run?.state === 'completed' ? value : null;
    }, 'The old real Skill read must complete.', 60000);
    assert.equal(conversation.tools.length, 1);
    assert.equal(conversation.tools[0].name, 'skill_read');
    assert.equal(conversation.tools[0].outcome, 'completed');
    assert.equal(conversation.tools[0].result.loaded.content, packageInput.files[1].content);
    assert.equal(conversation.tools[0].result.loaded.digest, sha(packageInput.files[1].content));
    assert.equal(f.payloads.length, 2);
    const events = await f.api(route + '/events');
    const snapshots = await Promise.all(events.filter(event => event.kind === 'context-assembled')
      .map(event => f.api(route + '/snapshots/' + event.body.snapshotId)));
    assert.equal(snapshots.length, 2);
    assert.deepEqual(snapshots[1].contextManifest.items.find(item => item.selection?.access === 'fixed-skill-content')?.content,
      conversation.tools[0].result.loaded);
    const settings = await f.api('skills');
    phase = 'old-domain-backup';
    const key = randomBytes(32); await writeFile(join(artifacts, 'recovery-key.bin'), key, { mode: 0o600 });
    await f.runtime.setCredential('legacy-probe-backup', key.toString('base64'));
    const backupDirectory = join(artifacts, 'backups');
    const backup = await f.runtime.recovery.backup({ directory: backupDirectory, recoveryKeyRef: 'legacy-probe-backup', leaveClosed: true });
    const boundary = backup.boundary.services.find(item => item.kind === 'xunjie.teaching-agent.boundary');
    assert.ok(boundary); assert.equal(boundary.unresolved, 0);
    // Public owner storage is read-only here: all business facts above came from the old HTTP/Agent path.
    const binding = JSON.parse(await runtimeApi.resolveCredential(f.root, 'storage-' + boundary.serviceId));
    owner = await storageApi.openStorage({ binding, migrations: learning.teachingAgentMigrations,
      backend: storageApi.createFileBackend({ id: 'teaching-agent', root: join(f.root, 'learning-resources', 'teaching-agent') }) });
    const material = await learning.collectTeachingBoundary(owner);
    assert.equal(material.evidence.formatVersion, 2);
    assert.equal(material.evidence.tables.teaching_compactions, undefined);
    const histories = {};
    for (const table of ['teaching_runs', 'teaching_steps', 'teaching_segment_transitions', 'teaching_skill_loads']) {
      histories[table] = json((await owner.read(`SELECT * FROM ${table}`)).rows);
      assert.ok(histories[table].length > 0, `The legacy backup must contain actual ${table} history.`);
    }
    assert.equal(histories.teaching_steps.length, 2);
    assert.ok(histories.teaching_steps.every(row => !Object.hasOwn(row, 'capacity_rejected')));
    assert.ok(histories.teaching_segment_transitions.every(row => !Object.hasOwn(row, 'compaction_id')));
    const saved = { legacyCommit, skills11Checksum, backupId: backup.backupId, serviceId: boundary.serviceId,
      activityId: activity.activityId, requestId: sent.input.requestId, conversation, events, snapshots, settings,
      material, histories, modelCalls: f.payloads.length };
    await save(join(artifacts, 'expected.json'), saved);
    const summary = { phase: 'legacy-source-complete', legacyCommit, skills11Checksum, formatVersion: 2,
      counts: Object.fromEntries(Object.entries(histories).map(([table, rows]) => [table, rows.length])),
      resources: material.evidence.resources.length, modelCalls: f.payloads.length,
      materialSha256: sha(JSON.stringify(material)), backupId: backup.backupId };
    await save(join(artifacts, 'source-summary.json'), summary); emit(summary);
    assert.deepEqual(f.failures, []);
  } finally { await owner?.close(); await f.close(); }
}

function resources() {
  return { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
    postgresVersion: '18.6', webRoot: join(repo, 'apps/web/dist-runtime'),
    windowsPrerequisitePath: join(repo, 'scripts/windows-prereq-prepare.ps1') };
}

async function target(artifacts, report) {
  const runtimeApi = await load(repo, '@xunjie/product-runtime'), learning = await load(repo, '@xunjie/learning-space');
  const storageApi = await load(repo, '@xunjie/storage');
  const expected = JSON.parse(await readFile(join(artifacts, 'expected.json'), 'utf8'));
  assert.equal(expected.legacyCommit, legacyCommit); assert.equal(expected.skills11Checksum, skills11Checksum);
  report.backupId = expected.backupId;
  report.originalMaterialSha256 = sha(JSON.stringify(expected.material));
  report.counts = Object.fromEntries(Object.entries(expected.histories).map(([table, rows]) => [table, rows.length]));
  report.originalModelCalls = expected.modelCalls;
  report.targetMaintenanceSha256 = sha(await readFile(join(repo, 'packages/learning-space/dist/teaching-agent/maintenance.js')));
  const targetRoot = join(artifacts, 'target-' + randomUUID());
  const runtime = runtimeApi.openProductRuntime({ root: targetRoot, resources: resources() });
  let restored, owner;
  try {
    phase = 'new-target-restore-with-original-domain-boundary';
    restored = await runtimeApi.restoreProductRecovery({ root: targetRoot, resources: resources(),
      backupDirectory: join(artifacts, 'backups', expected.backupId), key: await readFile(join(artifacts, 'recovery-key.bin')) });
    const teaching = restored.owners.find(item => item.participant.descriptor.serviceId === expected.serviceId);
    assert.ok(teaching);
    const material = await teaching.material({ backupId: expected.backupId, boundaryAt: restored.manifest.boundaryAt,
      signal: new AbortController().signal });
    assert.equal(material.evidence.formatVersion, 3);
    report.targetFormatVersion = material.evidence.formatVersion;
    for (const item of restored.owners) await item.close?.(); restored = undefined;
    const binding = JSON.parse(await runtimeApi.resolveCredential(targetRoot, 'storage-' + expected.serviceId));
    owner = await storageApi.openStorage({ binding, migrations: learning.teachingAgentMigrations,
      backend: storageApi.createFileBackend({ id: 'teaching-agent', root: join(targetRoot, 'learning-resources', 'teaching-agent') }) });
    phase = 'domain-boundary-and-history-equality';
    await learning.validateTeachingBoundary(owner, expected.material);
    for (const [table, original] of Object.entries(expected.histories)) {
      const actual = json((await owner.read(`SELECT * FROM ${table}`)).rows);
      if (table === 'teaching_steps') for (const row of actual) { assert.equal(row.capacity_rejected, false); delete row.capacity_rejected; }
      if (table === 'teaching_segment_transitions') for (const row of actual) { assert.equal(row.compaction_id, null); delete row.compaction_id; }
      const sort = rows => rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort();
      assert.deepEqual(sort(actual), sort(original), `The migrated ${table} history must retain every old field.`);
    }
    for (const reference of expected.material.evidence.resources) {
      const bytes = await owner.readResource(reference.resourceId);
      assert.equal(sha(bytes), reference.sha256); assert.equal(bytes.length, reference.byteLength);
    }
    await owner.close(); owner = undefined;
    phase = 'restored-public-api-and-restart';
    let state = await runtime.start(); assert.equal(state.state, 'maintenance');
    const read = async route => {
      const response = await fetch(state.endpoint + '/api/learning/' + route, { headers: { 'x-xj-space': 'personal' } });
      assert.equal(response.status, 200); return response.json();
    };
    const compare = async () => {
      const route = `agent/${expected.activityId}`;
      assert.deepEqual(await read(route + '/conversation'), expected.conversation);
      assert.deepEqual(await read(route + '/events'), expected.events);
      assert.deepEqual(await read('skills'), expected.settings);
      for (const snapshot of expected.snapshots) assert.deepEqual(await read(route + '/snapshots/' + snapshot.snapshotId), snapshot);
    };
    await compare(); await runtime.stop(); state = await runtime.start(); assert.equal(state.state, 'maintenance'); await compare();
    report.status = 'passed'; report.domainBoundaryValidated = true; report.historyPreserved = true;
    report.resourcesVerified = expected.material.evidence.resources.length; report.restartVerified = true;
  } finally {
    await owner?.close();
    if (restored) for (const item of restored.owners) await item.close?.();
    await runtime.stop();
    await rm(targetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main() {
  if (options.phase === 'source') return source(resolve(options.artifacts));
  const artifacts = options.reuse ? resolve(options.reuse) : await mkdtemp(join(tmpdir(), 'xj-wp08-legacy-recovery-'));
  await chmod(artifacts, 0o700);
  const report = { status: 'running', measuredAt: new Date().toISOString(), legacyCommit, skills11Checksum,
    artifacts, browser: 'not-run', teachingEffect: 'not-assessed' };
  try {
    if (!options.reuse) {
      assert.ok(options['legacy-root'], '--legacy-root is required to generate a real old backup.');
      phase = 'legacy-source-process';
      await new Promise((done, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--phase', 'source', '--legacy-root',
          resolve(options['legacy-root']), '--artifacts', artifacts], { stdio: ['ignore', 'inherit', 'inherit'] });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? done() : reject(Object.assign(new Error('Legacy source failed.'), { code: 'legacy-source-failed' })));
      });
    }
    await target(artifacts, report);
  } catch (error) { report.status = 'failed'; report.phase = phase; report.error = safeError(error); process.exitCode = 1; }
  finally {
    if (options.report) { const path = resolve(options.report); await mkdir(dirname(path), { recursive: true }); await save(path, report); }
    emit(report);
    // Keep the exact failed producer artifact for a same-backup green retry; successful runs clean their private data.
    if (report.status === 'passed') await rm(artifacts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

await main().catch(error => { emit({ status: 'failed', phase, error: safeError(error) }); process.exitCode = 1; });
