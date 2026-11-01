import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contentManifest, runBuildGraph } from './build-cache.mjs';
import { buildServer } from './build-server.mjs';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaces = {
  contracts: 'packages/contracts', storage: 'packages/storage', 'learning-space': 'packages/learning-space',
  server: 'apps/server', 'product-runtime': 'packages/product-runtime', web: 'apps/web', 'local-runtime': 'apps/local-runtime',
};
const dependencies = {
  contracts: [], storage: ['contracts'], 'learning-space': ['contracts', 'storage'], server: ['contracts', 'storage', 'learning-space'],
  'product-runtime': ['contracts', 'storage', 'learning-space'], web: ['contracts'], 'local-runtime': ['product-runtime'],
};
const excluded = name => /(?:^|\/)(?:node_modules|dist|dist-runtime|\.git|\.cache|\.verification|\.playwright|test-results|playwright-report|evidence)(?:\/|$)/.test(name)
  || /\.tsbuildinfo$/.test(name);
const environment = env => Object.fromEntries(Object.entries(env).filter(([key]) =>
  /^(?:VITE_|TS_|TSC_|BROWSERSLIST|XUNJIE_)/.test(key) || ['NODE_ENV', 'NODE_OPTIONS', 'SOURCE_DATE_EPOCH', 'TZ', 'LANG'].includes(key))
  .filter(([key]) => key !== 'XUNJIE_VITE_CACHE_DIR').sort(([a], [b]) => a.localeCompare(b)));

/** Resolve from the workspace, never from the root/.bin shim (server uses TS7). */
export async function resolveTool(root, workspace, name, bin, from) {
  const require = createRequire(from ?? join(root, workspaces[workspace], 'package.json'));
  const manifest = require.resolve(`${name}/package.json`);
  const metadata = JSON.parse(await readFile(manifest, 'utf8'));
  const executable = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[bin];
  if (!executable) throw new Error(`Missing ${bin} executable in ${name}`);
  return { path: join(dirname(manifest), executable), directory: dirname(manifest), metadata, require: createRequire(manifest) };
}

async function toolIdentity(tool) {
  const files = await contentManifest(tool.directory, ['.'], { exclude: name => /(?:^|\/)node_modules(?:\/|$)/.test(name) });
  const native = [];
  // TS7, esbuild and Rollup dispatch to platform packages. Identify their bytes.
  for (const name of Object.keys(tool.metadata.optionalDependencies ?? {})) {
    let manifest;
    try { manifest = tool.require.resolve(`${name}/package.json`); }
    catch (error) { if (['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) continue; throw error; }
    native.push([name, await contentManifest(dirname(manifest), ['.'], { exclude: path => /(?:^|\/)node_modules(?:\/|$)/.test(path) })]);
  }
  return { name: tool.metadata.name, version: tool.metadata.version, files, native };
}

export async function createBuildTasks({ root = repository, env = process.env } = {}) {
  const tasks = {};
  const tools = new Map();
  const tool = (workspace, name = 'typescript', bin = 'tsc') => {
    const key = `${workspace}:${name}`;
    if (!tools.has(key)) tools.set(key, (async () => {
      const from = workspace === 'web' && ['esbuild', 'rollup'].includes(name)
        ? join((await tool('web', 'vite', 'vite')).directory, 'package.json') : undefined;
      return resolveTool(root, workspace, name, bin, from);
    })());
    return tools.get(key);
  };
  const common = async () => ({
    node: { version: process.version, versions: process.versions, platform: process.platform, arch: process.arch },
    env: environment(env),
    files: await contentManifest(root, ['package.json', 'package-lock.json', '.npmrc', '.node-version', '.nvmrc',
      // npm can change the installed graph without rewriting the root lock.
      // Include independent workspace installs and parent resolution locations.
      'node_modules/.package-lock.json', 'apps/node_modules/.package-lock.json', 'packages/node_modules/.package-lock.json',
      ...Object.values(workspaces).map(path => `${path}/node_modules/.package-lock.json`),
      'scripts/build.mjs', 'scripts/build-cache.mjs', 'scripts/build-server.mjs']),
  });
  const fingerprint = (workspace, paths, names = [['typescript', 'tsc']]) => async () => ({
    common: await common(),
    source: await contentManifest(root, paths.map(path => join(workspaces[workspace], path)), { exclude: excluded }),
    tools: await Promise.all(names.map(async ([name, bin]) => toolIdentity(await tool(workspace, name, bin)))),
  });
  for (const [name, path] of Object.entries(workspaces)) {
    if (name === 'web') continue;
    tasks[name] = {
      deps: dependencies[name], outputs: [`${path}/dist`],
      requiredOutputs: [`${path}/dist/${name === 'server' ? 'server/main' : name === 'local-runtime' ? 'cli' : 'index'}.js`],
      fingerprint: fingerprint(name, ['.']),
      async run({ run, signal }) {
        const compiler = (await tool(name)).path;
        if (name === 'server') return buildServer({ root, compiler, run });
        if (name === 'contracts') {
          const cache = join(root, '.cache/xunjie-build');
          await mkdir(cache, { recursive: true });
          const staging = await mkdtemp(join(cache, 'contracts-'));
          const dist = join(root, path, 'dist');
          try {
            await run(process.execPath, [compiler, '-p', 'tsconfig.json', '--outDir', staging], { cwd: join(root, path) });
            signal?.throwIfAborted();
            const staged = await contentManifest(staging, ['.'], { required: true });
            const existing = await contentManifest(dist, ['.']);
            signal?.throwIfAborted();
            // Instrumented CLI readers can rebuild under a different loader
            // environment. Keep their live dependency untouched when it matches.
            if (JSON.stringify(staged) !== JSON.stringify(existing)) {
              await rm(dist, { recursive: true, force: true });
              await rename(staging, dist);
            }
          } finally { await rm(staging, { recursive: true, force: true }); }
          return;
        }
        await rm(join(root, path, 'dist'), { recursive: true, force: true });
        await run(process.execPath, [compiler, '-p', 'tsconfig.json'], { cwd: join(root, path) });
      },
    };
    tasks[`${name}:typecheck`] = {
      // Emitting with the same tsconfig already checks the complete package.
      // Server alone has a distinct, wider test-inclusive checking config.
      deps: name === 'server' ? [...dependencies[name], 'product-runtime'] : [name], outputs: [], fingerprint: fingerprint(name, ['.']),
      async run({ run }) {
        if (name !== 'server') return;
        if (name === 'server') await run(process.execPath, ['tools/check-runtime.mjs'], { cwd: join(root, path) });
        await run(process.execPath, [(await tool(name)).path, '-p', 'tsconfig.json', '--noEmit'], { cwd: join(root, path) });
      },
    };
  }
  tasks['web:src'] = {
    deps: ['contracts'], outputs: [],
    fingerprint: fingerprint('web', ['src', 'tsconfig.json', 'package.json', '.env', '.env.local', '.env.production', '.env.production.local']),
    async run({ run }) {
      await run(process.execPath, [(await tool('web')).path, '--noEmit', '-p', 'tsconfig.json'], { cwd: join(root, workspaces.web) });
    },
  };
  tasks['web:node'] = {
    deps: ['contracts'], outputs: [], fingerprint: fingerprint('web', ['.']),
    async run({ run }) {
      await run(process.execPath, [(await tool('web')).path, '--noEmit', '-p', 'tsconfig.node.json'], { cwd: join(root, workspaces.web) });
    },
  };
  for (const [id, output, args] of [['web', 'dist', []], ['web:runtime', 'dist-runtime', ['--config', 'vite.runtime.config.ts']]]) {
    tasks[id] = {
      deps: ['web:src'], outputs: [`${workspaces.web}/${output}`], requiredOutputs: [`${workspaces.web}/${output}/index.html`],
      fingerprint: fingerprint('web', ['.'], [['vite', 'vite'], ['esbuild', 'esbuild'], ['rollup', 'rollup']]),
      async run({ run }) {
        await rm(join(root, workspaces.web, output), { recursive: true, force: true });
        await run(process.execPath, [(await tool('web', 'vite', 'vite')).path, 'build', ...args], { cwd: join(root, workspaces.web) });
      },
    };
  }
  return tasks;
}

export function expandTargets(targets = 'all') {
  const all = ['contracts', 'storage', 'learning-space', 'server', 'product-runtime', 'web', 'web:runtime', 'local-runtime'];
  return [...new Set((Array.isArray(targets) ? targets : [targets]).flatMap(value => {
    const target = value.replace(/^@xunjie\//, '');
    if (['all', 'test', 'tools:test'].includes(target)) return all;
    if (target === 'typecheck') return Object.keys(workspaces).filter(name => name !== 'web').map(name => `${name}:typecheck`).concat('web:src', 'web:node');
    if (target === 'web:typecheck') return ['web:src', 'web:node'];
    if (target.endsWith(':test')) {
      const name = target.slice(0, -5);
      if (['server', 'product-runtime', 'local-runtime'].includes(name)) return all;
      if (name in workspaces) return name === 'web' ? ['web', 'web:runtime'] : [name];
    }
    if (target in workspaces || ['web:runtime', 'web:src', 'web:node'].includes(target)
      || (target.endsWith(':typecheck') && target.slice(0, -10) in workspaces)) return [target];
    throw new Error(`Unknown build target: ${value}`);
  }))];
}

/** Content-checked preparation only. No test execution or test-result caching. */
export async function ensureBuild(targets = 'all', options = {}) {
  const { force = false, signal, env = process.env, root = repository, log = console.log, args = [] } = options;
  const expanded = expandTargets(targets);
  const tasks = await createBuildTasks({ root, env });
  if (args.length) {
    if (expanded.length !== 1 || !['web', 'web:runtime', ...Object.keys(workspaces).filter(name => name !== 'web')].includes(expanded[0])) {
      throw new Error('Custom build arguments require exactly one workspace build target.');
    }
    const id = expanded[0];
    const workspace = id === 'web:runtime' ? 'web' : id;
    tasks[id] = {
      ...tasks[id], outputs: [], requiredOutputs: [], cache: false,
      fingerprint: async () => ({ custom: args }),
      async run({ run }) {
        const cwd = join(root, workspaces[workspace]);
        if (workspace === 'web') {
          const vite = await resolveTool(root, 'web', 'vite', 'vite');
          await run(process.execPath, [vite.path, 'build', ...(id === 'web:runtime' ? ['--config', 'vite.runtime.config.ts'] : []), ...args], { cwd });
        } else {
          const compiler = (await resolveTool(root, workspace, 'typescript', 'tsc')).path;
          if (workspace === 'server') await buildServer({ root, compiler, run, args });
          else await run(process.execPath, [compiler, '-p', 'tsconfig.json', ...args], { cwd });
        }
      },
    };
  }
  return runBuildGraph({ root, tasks, targets: expanded, force, signal, env, log });
}

export function parseBuildArgs(argv) {
  const split = argv.indexOf('--');
  const flags = split < 0 ? argv : argv.slice(0, split);
  const args = split < 0 ? [] : argv.slice(split + 1);
  if (flags.length === 1 && ['--help', '-h'].includes(flags[0])) return { help: true };
  if (flags.filter(arg => arg === '--force').length > 1 || flags.some(arg => arg.startsWith('-') && arg !== '--force')
    || flags.filter(arg => arg !== '--force').length > 1) throw new Error('Usage: node scripts/build.mjs [all|<workspace>|typecheck|test] [--force] [-- <compiler/Vite arguments>]');
  const target = flags.find(arg => arg !== '--force') ?? 'all';
  expandTargets(target);
  return { target, force: flags.includes('--force'), args };
}

export async function buildCli(argv = process.argv.slice(2)) {
  const options = parseBuildArgs(argv);
  if (options.help) {
    console.log('Usage: node scripts/build.mjs [all|<workspace>|typecheck|test] [--force]\nWorkspace custom compiler/Vite arguments follow -- and are never cached.');
    return;
  }
  const controller = new AbortController();
  let interrupted;
  const stop = signal => { interrupted = signal; controller.abort(new Error(`Build interrupted: ${signal}`)); };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try { await ensureBuild(options.target, { ...options, signal: controller.signal }); }
  catch (error) { process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1; throw error; }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildCli().catch(error => { console.error(`[build] ${error.message}`); process.exitCode ||= 1; });
}
