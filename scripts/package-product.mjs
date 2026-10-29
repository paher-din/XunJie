import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isSupportedPostgresVersion, supportedPostgresVersions } from '@xunjie/storage';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = join(root, 'scripts/product-resources.json');
const slash = path => path.split(sep).join('/');
const builtin = new Set(builtinModules.flatMap(name => [name, `node:${name.replace(/^node:/, '')}`]));
const forbidden = /(?:^|\/)(?:tests?|__tests__|fixtures|__fixtures__|acceptance|验收宿主)(?:\/|$)|(?:\.test|\.spec|\.fixtures|test-child|test-host|acceptance-host|acceptance-runner|test-support)\.[^/]+$/i;

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function json(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }

async function run(command, args, options = {}) {
  await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`${basename(command)} failed (${signal ?? code}).`)));
  });
}

export async function cachedArchive(cache, resource) {
  await mkdir(cache, { recursive: true });
  const archive = join(cache, basename(new URL(resource.url).pathname));
  const check = async path => {
    if ((await stat(path)).size !== resource.bytes || await sha256(path) !== resource.sha256) {
      throw new Error(`Archive checksum/size mismatch: ${basename(archive)}. Cached bytes are not trusted; remove that archive and retry.`);
    }
  };
  if (await exists(archive)) {
    await check(archive);
    return archive;
  }
  const temporary = `${archive}.${randomUUID()}.download`;
  try {
    console.log(`Downloading ${basename(archive)}`);
    const response = await fetch(resource.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${resource.url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    await check(temporary);
    await rename(temporary, archive);
    return archive;
  } finally { await rm(temporary, { force: true }); }
}

// Only authenticated-by-pinned-digest archives reach the system extractor.
// tar and unzip preserve package symlinks; no dereferencing copy is involved.
export async function unpackArchive(archive, resource, destination) {
  const scratch = await mkdtemp(join(dirname(destination), '.unpack-'));
  try {
    if (archive.endsWith('.zip') && process.platform !== 'win32') {
      await run('unzip', ['-q', archive, '-d', scratch]);
    } else {
      await run('tar', ['-xf', archive, '-C', scratch]);
    }
    const entries = await readdir(scratch);
    if (entries.length !== 1 || entries[0] !== resource.archiveRoot) throw new Error(`Unexpected archive root in ${basename(archive)}.`);
    await rename(join(scratch, resource.archiveRoot), destination);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function selectNodeRuntime(destination, executable) {
  const selected = await mkdtemp(join(dirname(destination), '.node-subset-'));
  try {
    for (const name of [executable, 'LICENSE']) {
      const source = join(destination, name);
      if (!(await lstat(source)).isFile()) throw new Error(`Expected a regular Node runtime file: ${name}`);
      await mkdir(dirname(join(selected, name)), { recursive: true });
      await cp(source, join(selected, name));
    }
    await rm(destination, { recursive: true, force: true });
    await rename(selected, destination);
  } finally { await rm(selected, { recursive: true, force: true }); }
}

export async function writeLaunchers(directory, platform) {
  const names = platform === 'win32-x64' ? ['xunjie.cmd']
    : platform === 'darwin-arm64' ? ['xunjie', '循阶.command'] : ['xunjie'];
  const script = platform === 'win32-x64'
    ? '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset NODE_OPTIONS=\r\nset NODE_PATH=\r\nif "%~1"=="" goto default_launch\r\n"%~dp0resources\\node\\node.exe" "%~dp0app\\cli.js" %*\r\nexit /b %errorlevel%\r\n:default_launch\r\n"%~dp0resources\\node\\node.exe" "%~dp0app\\cli.js" launch\r\nexit /b %errorlevel%\r\n'
    : '#!/bin/sh\nset -eu\nunset NODE_OPTIONS NODE_PATH\nBASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nif [ "$#" -eq 0 ]; then set -- launch; fi\nexec "$BASE/resources/node/bin/node" "$BASE/app/cli.js" "$@"\n';
  for (const name of names) {
    await writeFile(join(directory, name), script);
    if (platform !== 'win32-x64') await chmod(join(directory, name), 0o755);
  }
  return names;
}

export function assertProductionGraph(metafile) {
  for (const input of Object.keys(metafile.inputs)) {
    const path = slash(isAbsolute(input) ? relative(root, input) : input);
    if (path.startsWith('product-node-only:')) continue;
    if (forbidden.test(path) || /(?:^|\/)pg-native(?:\/|$)|node_modules\/pg\/lib\/native(?:\/|\.)/.test(path)) {
      throw new Error(`Non-production dependency in product bundle: ${path}`);
    }
    if (!/^(?:(?:(?:apps\/local-runtime|packages\/(?:product-runtime|contracts|storage))\/)?node_modules\/|apps\/local-runtime\/src\/|packages\/(?:product-runtime|storage)\/src\/|packages\/contracts\/(?:src|dist)\/)/.test(path)) {
      throw new Error(`Dependency outside the product production graph: ${path}`);
    }
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const item of output.imports) {
      if (item.external && !builtin.has(item.path)) throw new Error(`Unbundled product dependency: ${item.path}`);
    }
  }
}

async function assertNoWorkspacePath(path) {
  const text = await readFile(path, 'utf8');
  const variants = [root, root.replaceAll('\\', '/'), JSON.stringify(root).slice(1, -1), pathToFileURL(root).href];
  if (variants.some(value => text.includes(value))) throw new Error(`Workspace absolute path leaked into ${basename(path)}.`);
}

async function bundledLicenses(metafile, app) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!slash(input).includes('node_modules/')) continue;
    let current = dirname(resolve(root, input));
    while (current !== root && current !== dirname(current)) {
      if (await exists(join(current, 'package.json'))) {
        const pkg = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'));
        // Some packages have nested { "type": "module" } markers; keep
        // walking to the actual named package before collecting its notices.
        if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
          packages.set(`${pkg.name}@${pkg.version}`, { directory: current, pkg });
          break;
        }
      }
      current = dirname(current);
    }
  }
  const records = [];
  for (const [id, { directory, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const notices = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name));
    const target = join(app, 'licenses', id.replaceAll('/', '+'));
    await mkdir(target, { recursive: true });
    for (const name of notices) await cp(join(directory, name), join(target, name), { recursive: true, dereference: false, verbatimSymlinks: true });
    await cp(join(directory, 'package.json'), join(target, 'package.json'));
    if (notices.length === 0) {
      for (const name of (await readdir(directory)).filter(name => /^readme(?:\.|$)/i.test(name))) {
        await cp(join(directory, name), join(target, name));
      }
    }
    records.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'NOASSERTION', notices: notices.map(name => slash(relative(app, join(target, name)))) });
  }
  await json(join(app, 'licenses.json'), records);
  return records;
}

export async function buildApplication(app) {
  const require = createRequire(join(root, 'packages/product-runtime/package.json'));
  const driver = JSON.parse(await readFile(require.resolve('pg/package.json'), 'utf8'));
  if (driver.version !== '8.16.3') throw new Error(`Expected pg 8.16.3; found ${driver.version}. Run npm ci first.`);
  const { build } = await import('esbuild');
  const result = await build({
    absWorkingDir: root,
    entryPoints: { cli: 'apps/local-runtime/src/cli.ts', daemon: 'packages/product-runtime/src/daemon.ts',
      'product-runtime': 'packages/product-runtime/src/index.ts' },
    outdir: app, bundle: true, splitting: false, platform: 'node', target: 'node24', format: 'esm',
    packages: 'bundle', external: [...builtin], sourcemap: false, metafile: true, write: true,
    legalComments: 'eof', logLevel: 'warning',
    banner: { js: "import { createRequire as __productCreateRequire } from 'node:module'; const require = __productCreateRequire(import.meta.url);" },
    define: { 'process.env.NODE_PG_FORCE_NATIVE': 'undefined' },
    plugins: [{
      name: 'product-production-only',
      setup(plugin) {
        plugin.onResolve({ filter: /^@xunjie\/product-runtime$/ }, () => ({ path: join(root, 'packages/product-runtime/src/index.ts') }));
        plugin.onResolve({ filter: /^@xunjie\/storage$/ }, () => ({ path: join(root, 'packages/storage/src/index.ts') }));
        plugin.onResolve({ filter: /^@xunjie\/contracts(?:\/[^/]+)?$/ }, args => ({
          path: join(root, 'packages/contracts/src', `${args.path === '@xunjie/contracts' ? 'index' : args.path.split('/')[2]}.ts`),
        }));
        // pg's optional native getter must keep its MODULE_NOT_FOUND semantics,
        // without resolving either libpq bindings or the Cloudflare-only SDK.
        plugin.onResolve({ filter: /^\.\/native$/ }, args => slash(args.importer).endsWith('/pg/lib/index.js')
          ? { path: 'native-unavailable', namespace: 'product-node-only' } : undefined);
        plugin.onResolve({ filter: /^pg-native$/ }, () => ({ errors: [{ text: 'pg-native is forbidden in the product distribution.' }] }));
        plugin.onResolve({ filter: /^pg-cloudflare$/ }, () => ({ path: 'worker-unavailable', namespace: 'product-node-only' }));
        plugin.onLoad({ filter: /.*/, namespace: 'product-node-only' }, () => ({
          loader: 'js', contents: 'throw Object.assign(new Error("This product uses the Node.js PostgreSQL driver only."), { code: "MODULE_NOT_FOUND" });',
        }));
      },
    }],
  });
  assertProductionGraph(result.metafile);
  for (const name of ['cli.js', 'daemon.js', 'product-runtime.js']) await assertNoWorkspacePath(join(app, name));
  const recordedMetafile = { ...result.metafile, outputs: Object.fromEntries(
    Object.entries(result.metafile.outputs).map(([path, details]) => [`app/${slash(relative(app, resolve(root, path)))}`, details]),
  ) };
  await json(join(app, 'metafile.json'), recordedMetafile);
  await assertNoWorkspacePath(join(app, 'metafile.json'));
  return { driverVersion: driver.version, dependencies: await bundledLicenses(result.metafile, app) };
}

async function walk(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await walk(path, `${name}/`));
    else files.push({ path, name, symlink: entry.isSymbolicLink() });
  }
  return files;
}

async function resourceRecord(id, specification, asset, destination, tools) {
  for (const name of specification.license.preserve) {
    if (!await exists(join(destination, name))) throw new Error(`Missing ${id} license/build record: ${name}`);
  }
  const entryHashes = {};
  for (const tool of tools) {
    const entry = join(destination, tool);
    if (!await exists(entry)) throw new Error(`Missing bundled ${id} tool: ${tool}`);
    entryHashes[tool] = await sha256(entry);
  }
  return {
    id, version: specification.version, ...(specification.distributionVersion ? { distributionVersion: specification.distributionVersion } : {}),
    distribution: id === 'node'
      ? { mode: 'controlled-subset', retainedFiles: [asset.executable, 'LICENSE'], upstreamArchiveVerifiedInFull: true, retainedFileContentsModified: false }
      : { mode: 'complete-upstream-archive' },
    source: specification.source, license: specification.license, archive: {
      filename: basename(new URL(asset.url).pathname), url: asset.url, sha256: asset.sha256, bytes: asset.bytes,
      sha256Source: specification.sha256Source ?? `${asset.url}.sha256`,
      ...(id === 'postgres' ? { manifestSource: `${asset.url}.manifest.json`, sbomSource: `${asset.url}.spdx.json` } : {}),
      archiveRoot: asset.archiveRoot,
    },
    target: asset.target, entryHashes,
  };
}

export async function packageProduct(options) {
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const profile = options.profile ?? 'full';
  const postgresVersion = options['postgres-version'] ?? catalog.postgres.version;
  const postgres = postgresVersion === catalog.postgres.version ? catalog.postgres
    : Object.hasOwn(catalog.postgresVersions ?? {}, postgresVersion) ? catalog.postgresVersions[postgresVersion] : undefined;
  if (!isSupportedPostgresVersion(postgresVersion) || !postgres) throw new Error(`PostgreSQL version must be one of ${supportedPostgresVersions.join(', ')}.`);
  if (!Object.hasOwn(catalog.platforms, platform)) throw new Error(`Unsupported platform: ${platform}`);
  if (!['full', 'remote'].includes(profile)) throw new Error('Profile must be full or remote.');
  const cache = resolve(options.cache ?? join(homedir(), '.cache/xunjie-product-runtime'));
  const out = resolve(options.out ?? join(root, `dist/product-${platform}${postgresVersion === catalog.postgres.version ? '' : `-pg${postgresVersion}`}`));
  // Never delete arbitrary output paths, another agent's package, or a previous candidate.
  if (await exists(out)) throw new Error(`Output already exists; choose a new --out: ${out}`);
  await mkdir(dirname(out), { recursive: true });
  const staging = await mkdtemp(join(dirname(out), '.product-'));
  try {
    // Each package owns its web output; never reuse or empty the shared Vite directory.
    const web = join(staging, 'web');
    const webArgs = ['run', 'build:runtime', '--workspace', '@xunjie/web', '--', '--outDir', web];
    if (process.env.npm_execpath) await run(process.execPath, [process.env.npm_execpath, ...webArgs]);
    else if (process.platform === 'win32') {
      // Keep command text fixed and pass the absolute output path through a quoted env reference.
      await run(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', 'npm.cmd run build:runtime --workspace @xunjie/web -- --outDir "%XUNJIE_PRODUCT_WEB_OUT%"'], {
        env: { ...process.env, XUNJIE_PRODUCT_WEB_OUT: web },
      });
    } else await run('npm', webArgs);
    if (!await exists(join(web, 'index.html'))) throw new Error('Runtime web build did not produce index.html.');
    await mkdir(join(staging, 'resources'), { recursive: true });
    const specifications = [['node', catalog.node], ...(profile === 'full' ? [['postgres', postgres]] : [])];
    const archives = await Promise.all(specifications.map(async ([id, spec]) => ({ id, spec, asset: spec.platforms[platform], archive: await cachedArchive(cache, spec.platforms[platform]) })));
    const resources = [];
    for (const { id, spec, asset, archive } of archives) {
      const destination = join(staging, 'resources', id);
      await unpackArchive(archive, asset, destination);
      if (id === 'node') await selectNodeRuntime(destination, asset.executable);
      const tools = id === 'node' ? [asset.executable] : spec.requiredTools.map(name => `bin/${name}${platform === 'win32-x64' ? '.exe' : ''}`);
      const additions = [];
      if (id === 'postgres' && platform === 'win32-x64') {
        // These pinned executables have no embedded manifest. Windows reads the
        // adjacent manifest before starting each process, including PG children.
        // This fixes non-ASCII paths without changing upstream executable bytes
        // or the user's system code page.
        for (const name of (await readdir(join(destination, 'bin'))).filter(name => name.endsWith('.exe')).sort()) {
          const manifest = `bin/${name}.manifest`;
          await cp(join(root, 'scripts/windows-postgres.manifest'), join(destination, manifest));
          additions.push(manifest);
        }
      }
      const record = await resourceRecord(id, spec, asset, destination, [...tools, ...additions]);
      if (additions.length) record.distribution = { ...record.distribution, additionalFiles: additions,
        upstreamFileContentsModified: false, windowsProcessCodePage: 'UTF-8',
        manifestSource: 'https://learn.microsoft.com/en-us/windows/apps/design/globalizing/use-utf8-code-page' };
      resources.push(record);
    }
    const application = await buildApplication(join(staging, 'app'));
    const windowsPrerequisitePath = platform === 'win32-x64' && profile === 'full'
      ? 'resources/prerequisites/windows-vc.ps1' : undefined;
    if (windowsPrerequisitePath) {
      const helperSource = await readFile(join(root, 'scripts/windows-prereq-prepare.ps1'), 'utf8');
      for (const value of [catalog.windowsPrerequisite.version, catalog.windowsPrerequisite.url,
        catalog.windowsPrerequisite.sha256, String(catalog.windowsPrerequisite.bytes)]) {
        if (!helperSource.includes(value)) throw new Error('Windows prerequisite helper/catalog pins differ.');
      }
      await mkdir(dirname(join(staging, windowsPrerequisitePath)), { recursive: true });
      await cp(join(root, 'scripts/windows-prereq-prepare.ps1'), join(staging, windowsPrerequisitePath));
    }
    for (const file of await walk(web)) {
      if (/\.map$/i.test(file.name)) throw new Error(`Source map in product web: ${file.name}`);
      if (/\.(?:js|json|html|css)$/i.test(file.name)) await assertNoWorkspacePath(file.path);
    }
    const runtimeResources = { nodePath: `resources/node/${catalog.node.platforms[platform].executable}`, nodeVersion: catalog.node.version,
      ...(profile === 'full' ? { postgresBin: 'resources/postgres/bin', postgresVersion: postgres.version } : {}),
      ...(windowsPrerequisitePath ? { windowsPrerequisitePath } : {}), webRoot: 'web' };
    await json(join(staging, 'resources.json'), runtimeResources);
    await json(join(staging, 'package.json'), { name: '@xunjie/product-distribution', private: true, type: 'module' });
    const launchers = await writeLaunchers(staging, platform);
    const entryHashes = {};
    if (windowsPrerequisitePath) entryHashes[windowsPrerequisitePath] = { sha256: await sha256(join(staging, windowsPrerequisitePath)) };
    for (const directory of ['app', 'web']) {
      for (const file of await walk(join(staging, directory))) entryHashes[`${directory}/${file.name}`] = file.symlink
        ? { symlink: await readlink(file.path) } : { sha256: await sha256(file.path) };
    }
    for (const name of ['resources.json', 'package.json', ...launchers]) entryHashes[name] = { sha256: await sha256(join(staging, name)) };
    await json(join(staging, 'distribution.json'), {
      formatVersion: 1, status: 'unsigned-candidate', platform, profile, createdAt: new Date().toISOString(),
      os: catalog.platforms[platform].os, architecture: catalog.platforms[platform].architecture,
      signing: catalog.signing,
      prerequisites: catalog.platforms[platform].prerequisites,
      upstreamSignature: catalog.platforms[platform].upstreamSignature.replace(`PostgreSQL ${catalog.postgres.distributionVersion}`, `PostgreSQL ${postgres.distributionVersion}`),
      resources, application, entryHashes, resourceCatalogSha256: await sha256(catalogPath),
      ...(windowsPrerequisitePath ? { windowsPrerequisite: { ...catalog.windowsPrerequisite, helperPath: windowsPrerequisitePath,
        helperSha256: entryHashes[windowsPrerequisitePath].sha256, installerBundled: false } } : {}),
      postgresBackupTools: profile === 'full' ? postgres.backupTools : [],
      verification: { archiveChecksums: 'passed', productionDependencyGraph: 'passed', workspacePathsInBundles: 'absent',
        nativeProcessProbes: 'not-run', backupUpgradeProbes: 'not-run', cleanMachineAcceptance: 'cancelled-by-owner',
        productSigning: 'deferred-by-user', notarization: 'deferred-by-user', gatekeeper: 'not-run' },
    });
    await rename(staging, out);
    console.log(`Unsigned product candidate: ${out}`);
    return out;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    platform: { type: 'string' }, cache: { type: 'string' }, out: { type: 'string' },
    profile: { type: 'string' }, 'postgres-version': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/package-product.mjs [--platform darwin-arm64|win32-x64|linux-x64] [--cache DIR] [--out DIR] [--profile full|remote] [--postgres-version 18.6|17.10|17.11]\nDefault: current platform, ~/.cache/xunjie-product-runtime, <repo>/dist/product-<platform>, full, PostgreSQL 18.6. Non-default PG versions append -pg<version> to the default output. Archives are cached by versioned upstream filename.\nOutput must not already exist. --help never downloads or builds. System tar (and unzip for ZIP on macOS/Linux) are build dependencies only. All outputs are unsigned candidates.');
    return;
  }
  await packageProduct(values);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`package-product: ${error.message}`); process.exitCode = 1; });
}
