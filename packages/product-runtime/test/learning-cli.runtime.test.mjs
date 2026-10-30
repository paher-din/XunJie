import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../../apps/local-runtime/dist/cli.js', import.meta.url));
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to the complete native PostgreSQL 18.6 distribution.');

test('the normal CLI restores all learning owners and reaches schema upgrade validation', { timeout: 300000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-learning-cli-'));
  const source = join(directory, 'source'), target = join(directory, 'target');
  const upgradeTarget = join(directory, 'upgrade-target');
  const resources = join(directory, 'resources.json');
  await writeFile(resources, JSON.stringify({ nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) }));
  const input = async (name, value) => {
    const path = join(directory, name + '.json');
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const run = async (command, root, ...args) => {
    const { stdout } = await execute(process.execPath, [cli, command, '--root', root, '--resources', resources, ...args],
      { timeout: 180000, windowsHide: true });
    return JSON.parse(stdout);
  };
  try {
    await run('install', source, '--profile', 'local');
    const started = await run('start', source);
    assert.equal(started.state, 'ready');
    const body = { requestId: randomUUID(), goal: '通过正式 CLI 恢复活动', question: '', references: [] };
    const created = await fetch(new URL('/api/learning/activities', started.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' }, body: JSON.stringify(body) });
    assert.equal(created.status, 200);
    const activity = await created.json();
    const keyFile = join(directory, 'recovery-key');
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    const backupDirectory = join(directory, 'backups');
    const backup = await run('backup', source, '--file', await input('backup', { keyFile, directory: backupDirectory, leaveClosed: true }));
    assert.equal(backup.services.length, 3);
    const restored = await run('restore', target, '--file', await input('restore', {
      keyFile, backupDirectory: join(backupDirectory, backup.backupId) }));
    assert.equal(restored.phase, 'isolated');
    const isolated = await run('start', target);
    assert.equal(isolated.state, 'maintenance');
    await run('takeover', target, '--file', await input('takeover', { sourceRoot: source, receivers: [] }));
    const response = await fetch(new URL('/api/learning/activities/' + activity.activityId, isolated.endpoint), {
      headers: { 'x-xj-space': 'personal' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), activity);
    // No schema migration was released: the CLI must reach that check, rather than fail assembling owners.
    await assert.rejects(run('upgrade', target, '--file', await input('upgrade', { kind: 'schema', targetRoot: upgradeTarget,
      keyFile, backupDirectory: join(directory, 'upgrade-backups') })), error => {
      assert.match(error.stderr, /no-schema-upgrade-registered/);
      return true;
    });
  } finally {
    for (const root of [upgradeTarget, target, source]) await run('stop', root).catch(() => {});
  }
});
