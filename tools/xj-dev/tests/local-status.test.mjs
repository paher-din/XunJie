import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { environmentId, environmentPaths } from '../src/paths.mjs';
import { stopComponent } from '../src/processes.mjs';

const worktree = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');
const cli = join(worktree, 'tools/xj-dev/xj-dev.mjs');

test('local status reports selected-entry readiness through real CLI lifecycle', { timeout: 300_000 }, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'xj-status-'));
  const home = join(parent, 'home');
  const instance = `status-${process.pid}`;
  const paths = environmentPaths(home, environmentId(worktree, instance));
  const run = command => {
    const result = spawnSync(process.execPath, [cli, command, '--json', '--worktree', worktree, '--instance', instance], {
      env: { ...process.env, XJ_DEV_HOME: home }, encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(result.error, undefined);
    const body = JSON.parse(result.stdout);
    assert.equal(result.status === 0, body.ok, body.failure?.code);
    return body;
  };
  const unavailable = body => {
    assert.equal(body.ok, false);
    assert.equal(body.capabilities.frontend.available, false);
    assert.equal(body.capabilities.frontend.hmr, false);
    assert.equal(body.capabilities.api.available, false);
  };
  t.after(() => {
    run('down');
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await t.test('never started is unavailable and status creates no home', () => {
    unavailable(run('status'));
    assert.equal(existsSync(home), false);
    const doctor = run('doctor');
    assert.equal(doctor.ok, true, 'doctor checks prerequisites independently of service readiness');
    assert.equal(doctor.capabilities.frontend.available, false);
    assert.equal(doctor.capabilities.api.available, false);
  });
  await t.test('healthy up and status expose both available capabilities', () => {
    assert.equal(run('up').ok, true);
    for (const command of ['status', 'doctor']) {
      const body = run(command);
      assert.equal(body.ok, true);
      assert.equal(body.capabilities.frontend.available, true);
      assert.equal(body.capabilities.frontend.hmr, true);
      assert.equal(body.capabilities.api.available, true);
    }
  });
  await t.test('backend exit leaves frontend available but API unavailable', async () => {
    assert.equal((await stopComponent(paths, 'backend')).result, 'stopped');
    const body = run('status');
    assert.equal(body.ok, false);
    assert.equal(body.capabilities.frontend.available, true);
    assert.equal(body.capabilities.api.available, false);
  });
  await t.test('Vite exit leaves API available but frontend and HMR unavailable', async () => {
    assert.equal(run('up').ok, true);
    assert.equal((await stopComponent(paths, 'vite')).result, 'stopped');
    const body = run('status');
    assert.equal(body.ok, false);
    assert.equal(body.capabilities.frontend.available, false);
    assert.equal(body.capabilities.frontend.hmr, false);
    assert.equal(body.capabilities.api.available, true);
  });
  await t.test('gateway exit makes both selected-entry capabilities unavailable', async () => {
    assert.equal(run('up').ok, true);
    assert.equal((await stopComponent(paths, 'gateway')).result, 'stopped');
    unavailable(run('status'));
  });
  await t.test('down succeeds, preserves data and credentials, then status is unavailable', () => {
    const credentials = readFileSync(paths.baselineCredentials);
    assert.equal(run('down').ok, true);
    unavailable(run('status'));
    assert.ok(existsSync(paths.database));
    assert.ok(readFileSync(paths.baselineCredentials).equals(credentials), 'down preserves credentials');
  });
});
