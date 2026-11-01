import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import serverTimings from './server-test-weights.json' with { type: 'json' };

export const targetDirectories = {
  server: 'apps/server', contracts: 'packages/contracts', storage: 'packages/storage',
  'product-runtime': 'packages/product-runtime', tools: 'tools', checks: 'scripts',
};
export const groups = ['prepare', 'unit', 'server', 'tools', 'tests'];
export const verifyUsage = 'Usage: npm run verify [-- --group prepare|unit|server|tools|tests] [--shard i/n] [--jobs N] [--list | --help]\n'
  + 'No arguments: prepare, then all local tests. tests: unit + server + tools. Tests always run; only builds are cached.\n'
  + 'Jobs: 1..4 (default 4). Shards: server --shard uses measured-weight LPT, longest first; unsharded server stays lexical; tools has four fixed shards.\n'
  + 'Raw logs, durations and exit statuses: .verification/latest.json';
export const testUsage = 'Usage: node scripts/test.mjs <server|contracts|product-runtime|storage|tools|checks> [--external] [--shard i/n] [--jobs N] [--list | --help]';

export function parseOptions(args, mode = 'verify') {
  const usage = mode === 'verify' ? verifyUsage : testUsage;
  const fail = () => { throw new Error(usage); };
  const options = { jobs: 4, group: undefined, target: undefined, external: false, list: false, help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === '-h') arg = '--help';
    if (seen.has(arg)) fail();
    seen.add(arg);
    if (arg === '--help') options.help = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--external' && mode === 'test') options.external = true;
    else if (['--group', '--jobs', '--shard'].includes(arg)) {
      const value = args[++i];
      if (!value) fail();
      if (arg === '--group') {
        if (mode !== 'verify' || !groups.includes(value)) fail();
        options.group = value;
      } else if (arg === '--jobs') {
        if (!/^[1-4]$/.test(value)) fail();
        options.jobs = Number(value);
      } else {
        const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
        if (!match) fail();
        const [index, count] = match.slice(1).map(Number);
        if (!Number.isSafeInteger(count) || index > count) fail();
        options.shard = { index, count };
      }
    } else if (mode === 'test' && !options.target && Object.hasOwn(targetDirectories, arg)) options.target = arg;
    else fail();
  }
  if (options.help && options.list) fail();
  if (mode === 'test' && !options.target && !options.help) fail();
  if (mode === 'verify' && options.shard && !['server', 'tools'].includes(options.group)) fail();
  if ((options.group ?? options.target) === 'tools' && options.shard && options.shard.count !== 4) fail();
  return options;
}

export function isExternalTest(path) {
  return /\.runtime\.test\.(?:ts|mjs)$/.test(path)
    || ['runner/node.rpc.test.ts', 'server/tutoring/test/real-provider-failures.test.ts',
      'xj-dev-access/ssh-policy.test.py'].includes(path);
}

const toolsShards = [
  ['repro-e2e', 'repro-restore'], ['env-removal', 'integration'], ['local-status', 'gateway-certificate-lifecycle'],
].map(names => names.map(name => `xj-dev/tests/${name}.test.mjs`));
export const sensitiveTools = new Set(toolsShards.flat());

export function serverTestWeight(path) {
  return serverTimings.durationMs[path.replace(/^apps\/server\//, '')] ?? serverTimings.defaultDurationMs;
}

function longestFirst(files) {
  return [...files].sort((a, b) => serverTestWeight(b) - serverTestWeight(a) || (a < b ? -1 : a > b ? 1 : 0));
}

export function shardTests(files, target, shard) {
  const sorted = [...files].sort();
  if (!shard) return sorted;
  if (target === 'server') {
    // LPT: descending weights, then lexical paths; equal loads choose the
    // lowest shard index. Never use machine-dependent runtime measurements.
    const bins = Array.from({ length: Math.min(shard.count, sorted.length) }, () => ({ load: 0, files: [] }));
    for (const file of longestFirst(sorted)) {
      let selected = 0;
      for (let index = 1; index < bins.length; index++) if (bins[index].load < bins[selected].load) selected = index;
      bins[selected].files.push(file);
      bins[selected].load += serverTestWeight(file);
    }
    return bins[shard.index - 1]?.files ?? [];
  }
  if (target === 'tools') {
    if (shard.count !== 4) throw new Error('tools requires --shard i/4');
    return sorted.filter(path => {
      const assigned = toolsShards.findIndex(paths => paths.includes(path));
      return (assigned < 0 ? 4 : assigned + 1) === shard.index;
    });
  }
  return sorted.filter((_, index) => index % shard.count === shard.index - 1);
}

export function discoverTests(root, target, { external = false, shard } = {}) {
  const directory = targetDirectories[target];
  if (!directory) throw new Error(`Unknown test target: ${target}`);
  const discovered = globSync('**/*.test.{ts,mjs,py}', {
    cwd: join(root, directory),
    exclude: ['**/node_modules/**', '**/dist/**', '**/evidence/**', '**/docs/archive/**'],
  }).map(path => path.replaceAll('\\', '/')).sort();
  const selected = discovered.filter(path => isExternalTest(path) === external);
  if (!selected.length && target !== 'contracts') throw new Error(`No ${external ? 'external' : 'local'} tests discovered in ${directory}`);
  return shardTests(selected, target, shard).map(path => `${directory}/${path}`);
}

export function targetTasks(root, target, files) {
  const directory = targetDirectories[target];
  const group = ['checks', 'contracts', 'storage', 'product-runtime'].includes(target) ? 'unit' : target;
  return files.map(file => ({
    name: file, group, cwd: join(root, directory),
    command: file.endsWith('.py') ? 'python3' : process.execPath,
    args: file.endsWith('.py') ? [join(root, file)] : ['--test', '--test-concurrency=1', join(root, file)],
    // Contracts compile into staging; byte-identical outputs stay in place.
    // Keep the bounded fencing protocol assertion outside competing test load.
    exclusive: file === 'packages/product-runtime/test/connections.test.ts',
  }));
}

export function discoverTestWorkspaces(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const patterns = manifest.workspaces?.packages ?? manifest.workspaces ?? [];
  return globSync(patterns.map(pattern => pattern + '/package.json'), { cwd: root,
    exclude: ['**/node_modules/**', '**/dist/**', '**/docs/archive/**'] })
    .map(path => path.replaceAll('\\', '/')).sort()
    .filter(path => /^(?:apps|packages)\//.test(path))
    .map(path => ({ directory: path.slice(0, -'/package.json'.length),
      manifest: JSON.parse(readFileSync(join(root, path), 'utf8')) }))
    .filter(workspace => typeof workspace.manifest.scripts?.test === 'string' && workspace.manifest.scripts.test.trim());
}

function npmCli() {
  const binaryDirectory = dirname(process.execPath);
  const candidates = [process.env.npm_execpath,
    join(binaryDirectory, 'node_modules/npm/bin/npm-cli.js'),
    join(binaryDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  const cli = candidates.find(path => path && existsSync(path));
  if (!cli) throw new Error('npm CLI not found; run verification with the supported Node/npm distribution.');
  return cli;
}

function workspaceTasks(root, workspace, options) {
  const target = Object.keys(targetDirectories).find(target => targetDirectories[target] === workspace.directory);
  if (target) return targetTasks(root, target, discoverTests(root, target, target === 'server' ? options : {}));
  if (workspace.directory === 'apps/web') return [{ name: 'web', group: 'unit', cwd: join(root, 'apps/web'), command: process.execPath,
    args: [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism'] }];
  // Preserve npm's automatic apps/packages workspace coverage. Unknown runners
  // and their lifecycle hooks own their concurrency, so reserve the whole pool.
  return [{ name: `workspace:${workspace.directory}`, group: 'unit', cwd: root,
    command: process.execPath, args: [npmCli(), 'test', '--workspace', workspace.directory], exclusive: true }];
}

function interleaveGroups(tasks) {
  const queues = new Map();
  for (const task of tasks) {
    if (!queues.has(task.group)) queues.set(task.group, []);
    queues.get(task.group).push(task);
  }
  const result = [];
  for (let index = 0; result.length < tasks.length; index++) {
    for (const queue of queues.values()) if (queue[index]) result.push(queue[index]);
  }
  return result;
}

export function scheduleTestPhases(tasks) {
  const independent = interleaveGroups(tasks.filter(task => !task.exclusive));
  const exclusive = tasks.filter(task => task.exclusive);
  return [independent, exclusive].filter(phase => phase.length);
}

export function verificationPlan(root, options) {
  const selected = options.group ?? 'full';
  const phases = [];
  if (selected === 'full' || selected === 'prepare') {
    phases.push([
      { name: 'typecheck', args: ['scripts/build.mjs', 'typecheck'] },
      { name: 'build', args: ['scripts/build.mjs', 'all'] },
      { name: 'check:contracts:browser', args: ['scripts/check-contracts-browser.mjs'] },
      { name: 'check:docs', args: ['scripts/check-doc-links.mjs'] },
    ].map(task => ({ ...task, command: process.execPath, cwd: root, group: 'prepare', exclusive: true })));
  }
  if (selected === 'prepare') return phases;
  phases.push([{ name: 'build:test', command: process.execPath, args: ['scripts/build.mjs', 'test'], group: 'build:test', cwd: root }]);
  const tasks = [];
  if (['full', 'tests', 'unit'].includes(selected)) {
    tasks.push(...targetTasks(root, 'checks', discoverTests(root, 'checks')));
  }
  if (selected !== 'tools') {
    for (const workspace of discoverTestWorkspaces(root)) {
      const group = workspace.directory === 'apps/server' ? 'server' : 'unit';
      if (['full', 'tests', group].includes(selected)) tasks.push(...workspaceTasks(root, workspace, options));
    }
  }
  if (['full', 'tests', 'tools'].includes(selected)) {
    tasks.push(...targetTasks(root, 'tools', discoverTests(root, 'tools', options)));
  }
  phases.push(...scheduleTestPhases(tasks));
  return phases;
}
