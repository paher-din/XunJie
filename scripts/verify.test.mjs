import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const executable = fileURLToPath(new URL('./verify.mjs', import.meta.url));

function fixture(t, extra = {}, args = []) {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-verify-'));
  let child;
  let exit;
  t.after(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (exit) await exit;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const npm = join(root, 'npm.mjs');
  writeFileSync(npm, `
import {existsSync,writeFileSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
const [, , command, stage] = process.argv;
if(command !== 'run') process.exit(31);
process.stdout.write('原始 stdout: ' + stage + '\\n');
process.stderr.write('raw stderr: ' + stage + '\\n');
if(stage === 'typecheck' && process.env.HOLD_STAGE) {
  writeFileSync('child.pid', String(process.pid));
  while(!existsSync('release')) await setTimeout(20);
}
if(stage === process.env.FAIL_STAGE) { console.error('known failure detail'); process.exit(7); }
`);
  child = spawn(process.execPath, [executable, ...args], {
    cwd: root, env: { ...process.env, HOLD_STAGE: '', FAIL_STAGE: '', npm_execpath: npm, ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  exit = once(child, 'exit');
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  return { root, child, exit, output: () => output,
    summary: () => JSON.parse(readFileSync(join(root, '.verification/latest.json'), 'utf8')) };
}

async function until(condition) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Verification did not reach the expected process boundary.');
    await delay(20);
  }
}

test('raw stdout and stderr reach the log before the stage exits, with concise successful progress', { timeout: 10_000 }, async t => {
  const f = fixture(t, { HOLD_STAGE: '1' });
  await until(() => {
    if (!existsSync(join(f.root, '.verification/latest.json'))) return false;
    const summary = f.summary();
    return summary.stages[0].logFile && readFileSync(summary.stages[0].logFile, 'utf8').includes('raw stderr: typecheck');
  });
  assert.equal(f.child.exitCode, null);
  assert.equal(f.summary().status, 'running');
  assert.match(readFileSync(f.summary().logFile, 'utf8'), /原始 stdout: typecheck/);
  assert.doesNotMatch(f.output(), /原始 stdout/);
  writeFileSync(join(f.root, 'release'), '');
  assert.deepEqual(await f.exit, [0, null]);
  const summary = f.summary();
  assert.equal(summary.status, 'passed');
  assert.equal(summary.exitCode, 0);
  assert.deepEqual(summary.stages.map(stage => stage.name), ['typecheck', 'build', 'check:contracts:browser', 'check:docs', 'test']);
  assert(summary.stages.every(stage => stage.status === 'passed' && stage.durationMs >= 0));
  assert.match(f.output(), /PASSED test .*exit 0/);
  assert.match(readFileSync(summary.logFile, 'utf8'), /raw stderr: test/);
});

test('a failing stage preserves its exit code and raw diagnostics while later stages remain pending', { timeout: 10_000 }, async t => {
  const f = fixture(t, { FAIL_STAGE: 'check:docs' });
  assert.deepEqual(await f.exit, [7, null]);
  const summary = f.summary();
  assert.equal(summary.status, 'failed');
  assert.equal(summary.exitCode, 7);
  assert.equal(summary.stages[3].status, 'failed');
  assert.equal(summary.stages[4].status, 'pending');
  assert.match(f.output(), /known failure detail/);
  assert.match(readFileSync(summary.stages[3].logFile, 'utf8'), /known failure detail/);
  assert.doesNotMatch(readFileSync(summary.logFile, 'utf8'), /原始 stdout: test\n/);
});

test('POSIX: stopping verification terminates its active stage and records an interrupted result', {
  timeout: 10_000, skip: process.platform === 'win32' ? 'Windows forced SIGTERM bypasses Node signal handlers; this checks POSIX process groups.' : false,
}, async t => {
  const f = fixture(t, { HOLD_STAGE: '1' });
  await until(() => existsSync(join(f.root, 'child.pid')));
  const childPid = Number(readFileSync(join(f.root, 'child.pid'), 'utf8'));
  f.child.kill('SIGTERM');
  assert.deepEqual(await f.exit, [143, null]);
  assert.equal(f.summary().status, 'interrupted');
  assert.equal(f.summary().stages[0].status, 'interrupted');
  await until(() => { try { process.kill(childPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
});

for (const query of ['--help', '-h', '--list']) {
  test(`${query} describes verification without starting any stage or writing logs`, { timeout: 10_000 }, async t => {
    const f = fixture(t, {}, [query]);
    assert.deepEqual(await f.exit, [0, null]);
    assert.match(f.output(), query === '--list' ? /check:contracts:browser/ : /Usage: npm run verify/);
    assert.equal(existsSync(join(f.root, '.verification')), false);
    assert.doesNotMatch(f.output(), /原始 stdout/);
  });
}

test('unsupported arguments fail before running stages instead of silently discarding them', { timeout: 10_000 }, async t => {
  const f = fixture(t, {}, ['--unknown']);
  assert.deepEqual(await f.exit, [1, null]);
  assert.match(f.output(), /Usage: npm run verify/);
  assert.equal(existsSync(join(f.root, '.verification')), false);
});
