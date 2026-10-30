#!/usr/bin/env node
// Actual distributed CLI consumer. No workspace or test-fixture imports.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: { package: { type: 'string' }, 'source-package': { type: 'string' },
  root: { type: 'string' }, out: { type: 'string' }, 'keep-running': { type: 'boolean' } } });
for (const name of ['package', 'root', 'out']) assert.ok(values[name], `--${name} required`);
const root = resolve(values.root), targetPackage = resolve(values.package), sourcePackage = resolve(values['source-package'] ?? values.package);
await mkdir(root, { mode: 0o700 });
const source = join(root, 'source'), target = join(root, 'target'), b = join(root, 'unrelated-B');
const evidence = { formatVersion: 1, issue: 145, startedAt: new Date().toISOString(), platform: process.platform, steps: [], status: 'running' };
const contexts = [[sourcePackage, source], [targetPackage, target], [targetPackage, b]];
const json = async (name, value) => { const path = join(root, name); await writeFile(path, JSON.stringify(value), { mode: 0o600 }); return path; };
async function cli(pkg, environmentRoot, command, args = [], reject = false) {
  const raw = JSON.parse(await readFile(join(pkg, 'resources.json'), 'utf8'));
  let result;
  try {
    result = await promisify(execFile)(resolve(pkg, raw.nodePath), [join(pkg, 'app/cli.js'), command, '--root', environmentRoot,
      ...args, '--json'], { timeout: 300_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PG/.test(name) && !['NODE_OPTIONS', 'NODE_PATH'].includes(name))) });
  } catch (error) {
    if (!reject) throw new Error(`CLI ${command} failed`, { cause: { code: error.code } });
    const value = JSON.parse(error.stderr.trim());
    evidence.steps.push({ command, rejected: true, message: value.message }); return value;
  }
  assert.equal(reject, false, `CLI ${command} should have rejected`);
  const value = JSON.parse(result.stdout.trim());
  assert.notEqual(value?.state, 'failed');
  evidence.steps.push({ command, passed: true }); return value;
}
try {
  await cli(sourcePackage, source, 'install'); await cli(sourcePackage, source, 'start');
  const installedB = await cli(targetPackage, b, 'install'); await cli(targetPackage, b, 'start');
  const keyFile = join(root, 'recovery.key'); await cli(sourcePackage, source, 'recovery-key', ['--out', keyFile]);
  const backupDirectory = join(root, 'independent-backups');
  const policy = await json('policy.json', { directory: backupDirectory, keyFile, intervalMs: 86_400_000, keep: 1, minimumFreeBytes: 64 * 1024 * 1024 });
  await cli(sourcePackage, source, 'backup-policy', ['--file', policy]);
  const deadline = Date.now() + 25_000;
  let scheduled;
  while (Date.now() < deadline) {
    scheduled = await cli(sourcePackage, source, 'backup-list');
    if (scheduled.backups.length) break;
    await delay(750);
  }
  assert.equal(scheduled?.backups.length, 1, 'the live product scheduler must create the first backup');
  evidence.scheduledBackup = { backupId: scheduled.backups[0].backupId, boundaryAt: scheduled.backups[0].boundaryAt };
  await cli(sourcePackage, source, 'backup'); await cli(sourcePackage, source, 'backup');
  const catalog = await cli(sourcePackage, source, 'backup-list'); assert.equal(catalog.backups.length, 1);
  const version = JSON.parse(await readFile(join(sourcePackage, 'resources.json'), 'utf8')).postgresVersion;
  const targetVersion = JSON.parse(await readFile(join(targetPackage, 'resources.json'), 'utf8')).postgresVersion;
  let manifest;
  if (sourcePackage !== targetPackage) {
    const config = await json('upgrade.json', { kind: Number.parseInt(version) === Number.parseInt(targetVersion) ? 'pg-minor' : 'pg-major',
      targetRoot: target, backupDirectory, keyFile });
    const result = await cli(sourcePackage, source, 'upgrade', ['--file', config, '--resources', join(targetPackage, 'resources.json')]);
    assert.equal(result.phase, 'isolated'); manifest = result.backupId;
  } else {
    const held = await json('held.json', { leaveClosed: true });
    manifest = (await cli(sourcePackage, source, 'backup', ['--file', held])).backupId;
    const config = await json('restore.json', { backupDirectory: join(backupDirectory, manifest), keyFile });
    const result = await cli(targetPackage, target, 'restore', ['--file', config, '--resources', join(targetPackage, 'resources.json')]);
    assert.equal(result.phase, 'isolated');
  }
  assert.equal((await cli(targetPackage, target, 'start')).state, 'maintenance');
  await cli(targetPackage, target, 'maintenance-resume', [], true);
  const transfer = await json('takeover.json', { sourceRoot: source, receivers: [] });
  assert.equal((await cli(targetPackage, target, 'takeover', ['--file', transfer])).phase, 'active');
  const ready = await cli(targetPackage, target, 'status'); assert.equal(ready.state, 'ready');
  await cli(sourcePackage, source, 'start', [], true);
  const bAfter = await cli(targetPackage, b, 'status');
  assert.equal(bAfter.state, 'ready'); assert.deepEqual(bAfter.environment, installedB.environment);
  evidence.endpoint = ready.endpoint; evidence.targetRoot = target; evidence.backupId = manifest;
  evidence.environment = ready.environment; evidence.engineUpgrade = sourcePackage !== targetPackage;
  evidence.originalBUnchanged = true; evidence.status = 'passed'; evidence.browser = 'not-run';
} catch (error) { evidence.status = 'failed'; evidence.error = error.message; }
finally {
  if (!values['keep-running'] || evidence.status !== 'passed') {
    for (const [pkg, environmentRoot] of contexts) await cli(pkg, environmentRoot, 'stop').catch(() => {});
  }
  evidence.retainedRunning = Boolean(values['keep-running'] && evidence.status === 'passed');
  evidence.finishedAt = new Date().toISOString();
  await mkdir(dirname(resolve(values.out)), { recursive: true });
  await writeFile(resolve(values.out), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify({ status: evidence.status, endpoint: evidence.endpoint, out: resolve(values.out) }));
if (evidence.status !== 'passed') process.exitCode = 1;
