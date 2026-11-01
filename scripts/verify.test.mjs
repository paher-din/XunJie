import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const source = dirname(fileURLToPath(import.meta.url));
const executable = join(source, 'verify.mjs');

function fixture(t, extra = {}, args = []) {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-verify-'));
  const write = (name, value) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), value); };
  write('package.json', JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  for (const path of ['apps/server', 'apps/web', 'packages/contracts', 'packages/storage', 'packages/product-runtime']) {
    write(`${path}/package.json`, JSON.stringify({ name: '@fixture/' + path.split('/').at(-1), scripts: { test: 'fixture' } }));
  }
  const stageScript = String.raw`
import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {setTimeout} from 'node:timers/promises';
const stage = process.env.FIXTURE_STAGE ?? process.argv[2];
process.stdout.write('原始 stdout: ' + stage + '\n');
process.stderr.write('raw stderr: ' + stage + '\n');
appendFileSync(process.env.EVENTS, JSON.stringify({stage,args:process.argv.slice(2)})+'\n');
if(stage === 'typecheck' && process.env.HOLD_STAGE) {
  writeFileSync('child.pid', String(process.pid));
  if(process.env.GRANDCHILD) {
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('grandchild.pid',String(process.pid));setInterval(()=>{},1000)"], {detached:true,stdio:'ignore'});
    child.unref();
  }
  while(!existsSync('release')) await setTimeout(20);
}
if(stage.startsWith('server-') && process.env.HOLD_TESTS) {
  writeFileSync(process.env.EVENTS+'.'+stage+'.pid', String(process.pid));
  while(true) await setTimeout(20);
}
if(stage === process.env.FAIL_STAGE) { console.error('known failure detail'); process.exit(7); }
`;
  if (extra.EXTRA_WORKSPACE) {
    write('packages/new-package/package.json', JSON.stringify({ name: '@fixture/new-package', scripts: {
      pretest: 'node pretest.mjs', test: 'node test-entry.mjs',
    } }));
    write('packages/new-package/pretest.mjs', `process.env.FIXTURE_STAGE='new-pretest';\n${stageScript}`);
    write('packages/new-package/test-entry.mjs', `process.env.FIXTURE_STAGE='new-test';\n${stageScript}`);
  }
  write('scripts/build.mjs', stageScript);
  for (const [path, stage] of [
    ['scripts/check-contracts-browser.mjs', 'check:contracts:browser'], ['scripts/check-doc-links.mjs', 'check:docs'],
    ['node_modules/vitest/vitest.mjs', 'web'],
  ]) write(path, `process.env.FIXTURE_STAGE=${JSON.stringify(stage)};\n${stageScript}`);
  for (const path of ['packages/contracts', 'packages/storage', 'packages/product-runtime', 'apps/server', 'apps/web', 'tools', 'scripts']) mkdirSync(join(root, path), { recursive: true });
  for (const [path, stage] of [
    ['scripts/check.test.mjs', 'checks'], ['packages/storage/storage.test.mjs', 'storage'],
    ['packages/product-runtime/product.test.mjs', 'product-runtime'], ['apps/server/a.test.mjs', 'server-a'],
    ['apps/server/b.test.mjs', 'server-b'], ['tools/xj-dev/tests/integration.test.mjs', 'tools-integration'],
    ['tools/other.test.mjs', 'tools-other'],
  ]) write(path, `process.env.FIXTURE_STAGE=${JSON.stringify(stage)};\n${stageScript}`);
  write('apps/server/a.runtime.test.mjs', "throw new Error('external tests must not run locally')");
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: root, env: { ...process.env, HOLD_STAGE: '', HOLD_TESTS: '', FAIL_STAGE: '', GRANDCHILD: '', EVENTS: join(root, 'events.jsonl'), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'close');
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  t.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exit;
      const grandchild = join(root, 'grandchild.pid');
      if (existsSync(grandchild)) try { process.kill(Number(readFileSync(grandchild)), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  return { root, child, exit, output: () => output,
    events: () => existsSync(join(root, 'events.jsonl')) ? readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [],
    summary: () => JSON.parse(readFileSync(join(root, '.verification/latest.json'), 'utf8')) };
}

async function until(condition) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Verification did not reach the expected process boundary.');
    await delay(20);
  }
}

function gone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

test('raw stdout/stderr reach logs before exit; no arguments prepare and run every local group', { timeout: 10_000 }, async t => {
  const f = fixture(t, { HOLD_STAGE: '1' });
  await until(() => {
    if (!existsSync(join(f.root, '.verification/latest.json'))) return false;
    return readFileSync(f.summary().stages[0].logFile, 'utf8').includes('raw stderr: typecheck');
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
  assert.equal(summary.testsCached, false);
  assert.deepEqual(summary.stages.map(stage => stage.name), ['prepare', 'build:test', 'unit', 'server', 'tools']);
  assert(summary.stages.every(stage => stage.status === 'passed' && stage.durationMs >= 0 && stage.exitCode === 0));
  assert(summary.stages.flatMap(stage => stage.tasks).every(task => task.durationMs >= 0 && task.exitCode === 0));
  assert.match(f.output(), /PASSED tools .*exit 0/);
  assert.match(readFileSync(summary.logFile, 'utf8'), /raw stderr: tools-other/);
  assert.deepEqual(f.events().slice(0, 5).map(event => event.stage), ['typecheck', 'all', 'check:contracts:browser', 'check:docs', 'test']);
  assert.deepEqual(f.events().slice(5).map(event => event.stage).sort(), ['checks', 'storage', 'product-runtime', 'server-a', 'server-b', 'web', 'tools-integration', 'tools-other'].sort());
});

test('failed prepare preserves exit code/diagnostics and leaves tests pending', { timeout: 10_000 }, async t => {
  const f = fixture(t, { FAIL_STAGE: 'check:docs' });
  assert.deepEqual(await f.exit, [7, null]);
  const summary = f.summary();
  assert.equal(summary.status, 'failed');
  assert.equal(summary.exitCode, 7);
  assert.equal(summary.stages[0].status, 'failed');
  assert(summary.stages.slice(1).every(stage => stage.status === 'pending'));
  assert.match(f.output(), /known failure detail/);
  assert.match(readFileSync(summary.stages[0].logFile, 'utf8'), /known failure detail/);
  assert.doesNotMatch(readFileSync(summary.logFile, 'utf8'), /原始 stdout: test\n/);
});

test('POSIX: cancellation kills the active process and a detached descendant that ignores SIGTERM', {
  timeout: 10_000, skip: process.platform === 'win32' ? 'Windows uses taskkill /t /f.' : false,
}, async t => {
  const f = fixture(t, { HOLD_STAGE: '1', GRANDCHILD: '1' });
  await until(() => existsSync(join(f.root, 'grandchild.pid')));
  const childPid = Number(readFileSync(join(f.root, 'child.pid'), 'utf8'));
  const grandchildPid = Number(readFileSync(join(f.root, 'grandchild.pid'), 'utf8'));
  f.child.kill('SIGTERM');
  assert.deepEqual(await f.exit, [143, null]);
  assert.equal(f.summary().status, 'interrupted');
  assert.equal(f.summary().stages[0].status, 'interrupted');
  await until(() => gone(childPid) && gone(grandchildPid));
});

test('POSIX: SIGINT terminates every concurrently active test group descendant and keeps logs', {
  timeout: 10_000, skip: process.platform === 'win32' ? 'Windows uses taskkill /t /f.' : false,
}, async t => {
  const f = fixture(t, { HOLD_TESTS: '1' }, ['--group', 'server', '--jobs', '2']);
  const pidFiles = ['server-a', 'server-b'].map(stage => join(f.root, `events.jsonl.${stage}.pid`));
  await until(() => pidFiles.every(path => existsSync(path)));
  const pids = pidFiles.map(path => Number(readFileSync(path, 'utf8')));
  f.child.kill('SIGINT');
  assert.deepEqual(await f.exit, [130, null]);
  const summary = f.summary();
  assert.equal(summary.status, 'interrupted');
  assert.equal(summary.stages[1].status, 'interrupted');
  assert(summary.stages[1].tasks.every(task => task.status === 'interrupted' && task.exitCode === 130));
  assert.match(readFileSync(summary.stages[1].logFile, 'utf8'), /raw stderr: server-a/);
  await until(() => pids.every(gone));
});

for (const query of ['--help', '-h', '--list']) {
  test(`${query} has no build/test or log side effects`, { timeout: 10_000 }, async t => {
    const f = fixture(t, {}, [query]);
    assert.deepEqual(await f.exit, [0, null]);
    assert.match(f.output(), query === '--list' ? /check:contracts:browser/ : /Usage: npm run verify/);
    assert.equal(existsSync(join(f.root, '.verification')), false);
    assert.deepEqual(f.events(), []);
  });
}

for (const args of [ ['--unknown'], ['--group', 'unknown'], ['--jobs', '5'], ['--jobs', '0'],
  ['--jobs', '1.5'], ['--jobs'], ['--group', 'tools', '--shard', '1/3'], ['--group', 'server', '--shard', '0/4'],
  ['--group', 'server', '--shard', '5/4'], ['--group', 'tests', '--shard', '1/4'], ['--group', 'unit', '--group', 'unit'],
  ['--help', '--unknown'], ['--external'],
]) {
  test(`rejects unsupported args ${args.join(' ')} before mutation`, { timeout: 10_000 }, async t => {
    const f = fixture(t, {}, args);
    assert.deepEqual(await f.exit, [1, null]);
    assert.match(f.output(), /Usage: npm run verify/);
    assert.equal(existsSync(join(f.root, '.verification')), false);
    assert.deepEqual(f.events(), []);
  });
}

for (const group of ['prepare', 'unit', 'server', 'tools', 'tests']) {
  test(`--group ${group} selects only its work and ensures builds`, { timeout: 10_000 }, async t => {
    const f = fixture(t, {}, ['--group', group, '--jobs', '2']);
    assert.deepEqual(await f.exit, [0, null], f.output());
    const summary = f.summary();
    assert.equal(summary.jobs, 2);
    assert.deepEqual(summary.stages.map(stage => stage.name), group === 'prepare' ? ['prepare']
      : group === 'tests' ? ['build:test', 'unit', 'server', 'tools'] : ['build:test', group]);
    assert.equal(f.events()[0].stage, group === 'prepare' ? 'typecheck' : 'test');
    if (group !== 'prepare') assert(!f.events().some(event => ['all', 'typecheck'].includes(event.stage)));
    const web = f.events().find(event => event.stage === 'web');
    if (web) assert(web.args.includes('--maxWorkers=1') && web.args.includes('--minWorkers=1') && web.args.includes('--no-file-parallelism'));
  });
}

test('build preparation failure prevents tests; no unsafe environment bypass', { timeout: 10_000 }, async t => {
  const f = fixture(t, { FAIL_STAGE: 'test', XUNJIE_SKIP_BUILD: '1' }, ['--group', 'server']);
  assert.deepEqual(await f.exit, [7, null]);
  assert.deepEqual(f.events().map(event => event.stage), ['test']);
  assert.equal(f.summary().stages[1].status, 'pending');
});

test('new workspace fallback executes its real npm lifecycle without recursive known-workspace calls', { timeout: 10_000 }, async t => {
  const f = fixture(t, { EXTRA_WORKSPACE: '1' }, ['--group', 'unit']);
  assert.deepEqual(await f.exit, [0, null], f.output());
  const stages = f.events().map(event => event.stage);
  assert.equal(stages.filter(stage => stage === 'test').length, 1, 'build prerequisite runs once');
  assert.equal(stages.filter(stage => stage === 'new-pretest').length, 1);
  assert.equal(stages.filter(stage => stage === 'new-test').length, 1);
  const fallback = f.summary().stages[1].tasks.find(task => task.name === 'workspace:packages/new-package');
  assert.equal(fallback.status, 'passed');
  assert.equal(fallback.exclusive, true);
});

test('a failed test does not discard the remaining files or groups', { timeout: 10_000 }, async t => {
  const f = fixture(t, { FAIL_STAGE: 'server-a' }, ['--group', 'tests', '--jobs', '1']);
  assert.deepEqual(await f.exit, [1, null]); // Node test runner returns 1 for a failing file.
  const summary = f.summary();
  assert.equal(summary.stages.find(stage => stage.name === 'server').status, 'failed');
  assert.equal(summary.stages.find(stage => stage.name === 'tools').status, 'passed');
  assert(f.events().some(event => event.stage === 'server-b'));
  assert.match(f.output(), /known failure detail/);
});

test('server weighted shard selection runs each file exactly once across four invocations', { timeout: 10_000 }, async t => {
  const seen = [];
  for (let index = 1; index <= 4; index++) {
    const f = fixture(t, {}, ['--group', 'server', '--shard', `${index}/4`]);
    assert.deepEqual(await f.exit, [0, null], f.output());
    seen.push(...f.events().filter(event => event.stage !== 'test').map(event => event.stage));
  }
  assert.deepEqual(seen.sort(), ['server-a', 'server-b']);
});

for (const target of ['checks', 'contracts', 'storage', 'product-runtime', 'server', 'tools']) {
  test(`independent ${target} test entry prepares build and preserves cwd`, { timeout: 10_000 }, async t => {
    const entry = join(source, 'test.mjs');
    const f = fixture(t, {}, ['--group', 'prepare', '--list']);
    await f.exit;
    cpSync(entry, join(f.root, 'scripts/test.mjs'));
    cpSync(join(source, 'test-discovery.mjs'), join(f.root, 'scripts/test-discovery.mjs'));
    cpSync(join(source, 'server-test-weights.json'), join(f.root, 'scripts/server-test-weights.json'));
    cpSync(join(source, 'test-scheduler.mjs'), join(f.root, 'scripts/test-scheduler.mjs'));
    const child = spawn(process.execPath, [join(f.root, 'scripts/test.mjs'), target], { cwd: tmpdir(),
      env: { ...process.env, EVENTS: join(f.root, 'events.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    assert.deepEqual(await once(child, 'close'), [0, null], output);
    assert.equal(f.events()[0].stage, 'test');
    assert.equal(realpathSync(f.summary().cwd), realpathSync(f.root));
  });
}
