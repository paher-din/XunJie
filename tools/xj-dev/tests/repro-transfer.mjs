// Explicit cross-machine acceptance: first export from repro-e2e with XJ_REPRO_EXPORT_DIR,
// transfer the same ZIP, then run this file with node --test and the required environment below.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { git } from '../src/repro-code.mjs';
import { digest } from '../src/repro-archive.mjs';
import { lockfileDigest } from '../src/repro.mjs';

test('transferred ZIP restores on the receiving machine and reproduces the recorded real business conflict via public CLI', { timeout: 300_000 }, t => {
  assert.ok(process.env.XJ_REPRO_TRANSFER_ZIP && process.env.XJ_REPRO_TRANSFER_DIGEST && process.env.XJ_REPRO_DEPENDENCIES_FROM,
    'Set XJ_REPRO_TRANSFER_ZIP, XJ_REPRO_TRANSFER_DIGEST and XJ_REPRO_DEPENDENCIES_FROM to actual transferred material/preinstalled dependencies.');
  const worktree = resolve(import.meta.dirname, '../../..'), cli = join(worktree, 'tools/xj-dev/xj-dev.mjs');
  const root = mkdtempSync(join(tmpdir(), 'xj-repro-transfer-')), home = join(root, 'home'), target = join(root, 'receiver');
  const file = resolve(process.env.XJ_REPRO_TRANSFER_ZIP), expectedDigest = process.env.XJ_REPRO_TRANSFER_DIGEST;
  const before = git(worktree, ['status', '--porcelain']), head = git(worktree, ['rev-parse', 'HEAD']);
  function run(args) {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: worktree, env: { ...process.env, XJ_DEV_HOME: home }, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const envelope = JSON.parse(result.stdout || '{}');
    assert.equal(result.status, 0, JSON.stringify(envelope.failure ?? result.stderr?.slice(-500)));
    assert.equal(envelope.ok, true, JSON.stringify(envelope.failure));
    return envelope;
  }
  t.after(() => {
    if (existsSync(target)) {
      run(['down', '--worktree', target]);
      for (const app of ['student', 'teaching']) {
        const dependencies = join(target, 'apps', app, 'node_modules');
        if (existsSync(dependencies) && lstatSync(dependencies).isSymbolicLink()) unlinkSync(dependencies);
      }
      git(worktree, ['worktree', 'remove', '--force', target]);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  assert.equal(digest(readFileSync(file)), expectedDigest, 'the exact exported ZIP arrived');
  if (process.platform === 'win32') {
    for (const app of ['student', 'teaching']) assert.ok(readFileSync(join(worktree, 'apps', app, 'package-lock.json'), 'utf8').includes('\r\n'), 'Windows receiver must exercise a real CRLF checkout');
  }
  const inspected = run(['repro', 'inspect', file, '--digest', expectedDigest]);
  assert.equal(inspected.verification.reproduction, 'unverified');
  const restored = run(['repro', 'restore', file, '--target', target, '--digest', expectedDigest]);
  assert.equal(restored.verification.restored, true); assert.equal(restored.verification.reproduction, 'unverified');
  for (const app of ['student', 'teaching']) {
    const existing = join(process.env.XJ_REPRO_DEPENDENCIES_FROM, 'apps', app);
    assert.equal(lockfileDigest(readFileSync(join(existing, 'package-lock.json'))), lockfileDigest(readFileSync(join(target, 'apps', app, 'package-lock.json'))), 'preinstalled dependencies use the same pinned lock');
    symlinkSync(join(existing, 'node_modules'), join(target, 'apps', app, 'node_modules'), 'junction');
    utimesSync(join(target, 'apps', app, 'package-lock.json'), new Date(0), new Date(0));
  }
  const started = run(['up', '--worktree', target]);
  assert.equal(started.capabilities.execution.available, false); assert.equal(started.capabilities.models.available, false);
  const result = run(['repro', 'verify', file, '--worktree', target]);
  assert.equal(result.verification.reproduction, 'verified');
  assert.equal(result.verification.evidence, 'real-local-business-https');
  assert.deepEqual(result.verification.results.map(r => [r.status, r.errorCode]), [[200, null], [409, 'VERSION_CONFLICT']]);
  assert.equal(git(worktree, ['status', '--porcelain']), before); assert.equal(git(worktree, ['rev-parse', 'HEAD']), head);
  t.diagnostic(JSON.stringify({ platform: process.platform, node: process.version, packageDigest: expectedDigest,
    sourceCommit: restored.package.manifest.code.sourceCommit, verified: result.verification, currentBranchPreserved: true }));
});
