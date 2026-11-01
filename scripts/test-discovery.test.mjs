import assert from 'node:assert/strict';
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { discoverTests, discoverTestWorkspaces, parseOptions, sensitiveTools, shardTests, targetDirectories, targetTasks, verificationPlan } from './test-discovery.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value = '') => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  return { root, write };
}

test('recursive discovery preserves the entire legacy local/external partition', t => {
  const { root, write } = fixture(t);
  const local = ['new/nested/check.test.ts', 'another.test.mjs', 'local.test.py'];
  const external = ['runner/alu-node.runtime.test.ts', 'runner/node.rpc.test.ts', 'server/tutoring/test/real-provider-failures.test.ts'];
  for (const path of [...local, ...external, 'dist/compiled.test.mjs', 'nested/node_modules/dependency.test.ts',
    'nested/evidence/generated.test.ts', 'docs/archive/stale.test.mjs']) write(`apps/server/${path}`);
  assert.deepEqual(discoverTests(root, 'server'), local.sort().map(path => 'apps/server/' + path));
  assert.deepEqual(discoverTests(root, 'server', { external: true }), external.sort().map(path => 'apps/server/' + path));
  write('tools/xj-dev-access/ssh-policy.test.py');
  write('tools/local.test.mjs');
  assert.deepEqual(discoverTests(root, 'tools', { external: true }), ['tools/xj-dev-access/ssh-policy.test.py']);
  assert.deepEqual(discoverTests(root, 'tools'), ['tools/local.test.mjs']);
});

test('server sorted modulo shards are stable, disjoint and exhaustive with new files', () => {
  const files = Array.from({ length: 29 }, (_, i) => `nested/${String(i).padStart(2, '0')}.test.ts`).reverse();
  const shards = Array.from({ length: 4 }, (_, i) => shardTests(files, 'server', { index: i + 1, count: 4 }));
  assert.deepEqual(shards.flat().sort(), files.sort());
  assert.equal(new Set(shards.flat()).size, files.length);
  assert.deepEqual(shards[0], files.filter((_, index) => index % 4 === 0));
});

test('tools shards keep each approved lifecycle pair and automatically collect every other file', () => {
  const rest = ['new/sub/new.test.mjs', 'xj-dev/tests/new-lifecycle.test.mjs', 'i0-cloud/backup-retained.test.mjs'];
  const shards = Array.from({ length: 4 }, (_, i) => shardTests([...rest, ...sensitiveTools].reverse(), 'tools', { index: i + 1, count: 4 }));
  assert.deepEqual(shards[0], ['xj-dev/tests/repro-e2e.test.mjs', 'xj-dev/tests/repro-restore.test.mjs']);
  assert.deepEqual(shards[1], ['xj-dev/tests/env-removal.test.mjs', 'xj-dev/tests/integration.test.mjs']);
  assert.deepEqual(shards[2], ['xj-dev/tests/gateway-certificate-lifecycle.test.mjs', 'xj-dev/tests/local-status.test.mjs']);
  assert.deepEqual(shards[3], rest.sort());
  assert.equal(new Set(shards.flat()).size, rest.length + sensitiveTools.size);
  assert.throws(() => shardTests(rest, 'tools', { index: 1, count: 2 }), /i\/4/);
});

test('current checkout discovery equals the original recursive test sets, including external Python', () => {
  const root = dirname(import.meta.dirname);
  // An independent copy of the old classification guards against unintentionally
  // removing tests when the scheduler/discovery implementation changes.
  for (const [target, directory] of Object.entries(targetDirectories)) {
    const discovered = globSync('**/*.test.{ts,mjs,py}', { cwd: join(root, directory),
      exclude: ['**/node_modules/**', '**/dist/**', '**/evidence/**', '**/docs/archive/**'] })
      .map(path => path.replaceAll('\\', '/')).sort();
    const legacyExternal = path => /\.runtime\.test\.(?:ts|mjs)$/.test(path)
      || ['runner/node.rpc.test.ts', 'server/tutoring/test/real-provider-failures.test.ts', 'xj-dev-access/ssh-policy.test.py'].includes(path);
    for (const external of [false, true]) {
      const expected = discovered.filter(path => legacyExternal(path) === external).map(path => directory + '/' + path);
      if (!expected.length && target !== 'contracts') assert.throws(() => discoverTests(root, target, { external }), /No .* tests discovered/);
      else assert.deepEqual(discoverTests(root, target, { external }), expected);
    }
  }
});

test('test task commands use exact cwd, a single worker, and Python for external ssh policy', () => {
  const tasks = targetTasks('/fixture', 'tools', ['tools/xj-dev/tests/integration.test.mjs', 'tools/other.test.mjs', 'tools/xj-dev-access/ssh-policy.test.py']);
  assert.deepEqual(tasks.map(task => task.exclusive), [true, false, false]);
  assert(tasks.every(task => task.cwd === join('/fixture', 'tools')));
  assert.deepEqual(tasks[0].args.slice(0, 2), ['--test', '--test-concurrency=1']);
  assert.equal(tasks[2].command, 'python3');
});

test('CLI defaults and compatibility include external, list, jobs and shards without a skip-build option', () => {
  assert.equal(parseOptions([]).jobs, 4);
  assert.equal(parseOptions(['--group', 'tests']).group, 'tests');
  assert.deepEqual(parseOptions(['server', '--external', '--list', '--shard', '2/4', '--jobs', '3'], 'test').shard, { index: 2, count: 4 });
  assert.throws(() => parseOptions(['server', '--skip-build'], 'test'), /Usage/);
  assert.throws(() => parseOptions(['tools', '--shard', '1/3'], 'test'), /Usage/);
});

test('prepare has no test tasks; full plan preserves independent unit/server work and a conservative tools barrier', t => {
  const { root, write } = fixture(t);
  write('package.json', JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  for (const path of ['apps/server', 'packages/contracts', 'packages/storage', 'packages/product-runtime']) {
    write(`${path}/package.json`, JSON.stringify({ scripts: { test: 'fixture' } }));
  }
  for (const path of ['scripts/check.test.mjs', 'apps/server/server.test.mjs', 'packages/storage/storage.test.mjs',
    'packages/product-runtime/product.test.mjs', 'tools/tool.test.mjs']) write(path);
  mkdirSync(join(root, 'packages/contracts'), { recursive: true });
  const prepare = verificationPlan(root, parseOptions(['--group', 'prepare']));
  assert.deepEqual(prepare.flat().map(task => task.name), ['typecheck', 'build', 'check:contracts:browser', 'check:docs']);
  const plan = verificationPlan(root, parseOptions(['--group', 'tests']));
  assert.deepEqual(plan[0].map(task => task.args), [['scripts/build.mjs', 'test']]);
  assert.deepEqual([...new Set(plan[1].map(task => task.group))], ['unit', 'server']);
  assert(plan[2].every(task => task.group === 'tools'));
  assert.equal(plan.flat().filter(task => task.name === 'build:test').length, 1);
});

test('new apps/packages test scripts are discovered automatically and run via an exclusive npm fallback', t => {
  const { root, write } = fixture(t);
  write('package.json', JSON.stringify({ workspaces: { packages: ['apps/*', 'packages/*', 'tools/*'] } }));
  write('scripts/check.test.mjs');
  for (const [directory, scripts] of [
    ['apps/new-app', { test: 'node --test custom.mjs' }],
    ['packages/new-package', { test: 'custom-runner' }],
    ['packages/no-tests', { build: 'tsc' }],
    ['packages/empty-test', { test: '  ' }],
    ['tools/new-tool', { test: 'node --test' }],
  ]) write(`${directory}/package.json`, JSON.stringify({ scripts }));
  assert.deepEqual(discoverTestWorkspaces(root).map(workspace => workspace.directory), ['apps/new-app', 'packages/new-package']);
  const plan = verificationPlan(root, parseOptions(['--group', 'unit']));
  const fallback = plan.flat().filter(task => task.name.startsWith('workspace:'));
  assert.deepEqual(fallback.map(task => task.name), ['workspace:apps/new-app', 'workspace:packages/new-package']);
  assert(fallback.every(task => task.group === 'unit' && task.exclusive && task.cwd === root && task.command === process.execPath));
  assert.deepEqual(fallback.map(task => task.args.slice(1)), [['test', '--workspace', 'apps/new-app'], ['test', '--workspace', 'packages/new-package']]);
});
