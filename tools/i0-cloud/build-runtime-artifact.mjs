#!/usr/bin/env node
// Assemble the Linux production runtime from a fresh checkout build and emit a
// verifiable artifact (runtime.tar.gz + manifest.json) for the shared host.
// Runs in CI only; the shared server verifies, backs up, assembles and switches.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const sha256File = path => {
  const descriptor = openSync(path, constants.O_RDONLY);
  try { return sha256(readFileSync(descriptor)); } finally { closeSync(descriptor); }
};
const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const extension = path => { const dot = path.lastIndexOf('.'); return dot === -1 ? '' : path.slice(dot); };

// Mirrors the host type table; only these are pre-compressed (build outputs never compress on request).
const compressibleExtensions = new Set(['.html', '.js', '.css', '.svg']);

// [source, destination, exclude tests] — same layout the server-side release runs from.
const runtimeCopies = [
  ['apps/web/dist', 'apps/web/dist', false],
  ['node_modules', 'node_modules', true],
  ['apps/server/dist', 'apps/server/dist', true],
  ['apps/server/package.json', 'apps/server/package.json', false],
  ['package.json', 'package.json', false],
  ['package-lock.json', 'package-lock.json', false],
  ['packages/contracts/package.json', 'node_modules/@xunjie/contracts/package.json', false],
  ['packages/contracts/dist', 'node_modules/@xunjie/contracts/dist', true],
  ['tools/i0-cloud/cloud-host.mjs', 'tools/i0-cloud/cloud-host.mjs', false],
];
const workspaceLinks = new Map([
  ['@xunjie/web', 'apps/web'], ['@xunjie/server', 'apps/server'],
  ['@xunjie/contracts', 'packages/contracts'], ['@xunjie/xj-dev', 'tools/xj-dev'],
  ['@xunjie/dev-access', 'tools/xj-dev-access'],
]);
const testDirectories = new Set(['test', 'tests', '__tests__', 'fixtures', '__fixtures__']);
const testFile = name => /\.(?:test|spec)\.(?:[cm]?[jt]sx?|d\.ts)(?:\.map)?$/.test(name)
  || /(?:-support|i0-browser-fixture|i0-browser-runner|test-child|acceptance|hdl-acceptance|record-validation)\.(?:[cm]?js|d\.ts)(?:\.map)?$/.test(name);


// Runtime resolution only needs real files; npm command shims under node_modules/.bin are not used by the server.

function listFiles(root, { excludeTests = false, dependencyRoot = null } = {}) {
  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (excludeTests && testDirectories.has(entry.name)) continue;
        visit(path);
      } else if (entry.isFile()) {
        if (excludeTests && testFile(entry.name)) continue;
        files.push(path);
      } else if (entry.isSymbolicLink()) {
        const within = relative(root, path).split('\\').join('/');
        if (dependencyRoot && within.startsWith('.bin/')) continue;
        const workspace = dependencyRoot && workspaceLinks.get(within);
        require(workspace && realpathSync(path) === realpathSync(join(dependencyRoot, workspace)), 'RUNTIME_SYMLINK_UNSUPPORTED');
      }
    }
  };
  visit(root);
  return files.sort();
}

class BuildError extends Error {}

function require(condition, code) {
  if (!condition) throw new BuildError(code);
}

function parseArguments(argv) {
  const values = { '--source': process.cwd(), '--output': '', '--commit': '', '--git-tree': '',
    '--expected-platform': '', '--expected-node-version': '', '--dependencies': '' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!Object.hasOwn(values, name) || !value || seen.has(name)) throw new BuildError('ARGUMENTS_REQUIRED');
    seen.add(name);
    values[name] = value;
  }
  require(values['--output'] && values['--commit'] && values['--git-tree'], 'ARGUMENTS_REQUIRED');
  require(/^[0-9a-f]{40}$/.test(values['--commit']), 'COMMIT_REQUIRED');
  require(/^[0-9a-f]{40}$/.test(values['--git-tree']), 'GIT_TREE_REQUIRED');
  return {
    source: realpathSync(resolve(values['--source'])), output: resolve(values['--output']),
    commit: values['--commit'], gitTree: values['--git-tree'],
    dependencies: values['--dependencies'] ? realpathSync(resolve(values['--dependencies'])) : undefined,
    expectedPlatform: values['--expected-platform'] || null,
    expectedNodeVersion: values['--expected-node-version'] || null,
  };
}

// Same entry contract as the deployment verifier: exactly one local module script under /assets.
function parseEntry(dist) {
  const index = join(dist, 'index.html');
  require(lstatSync(index).isFile(), 'BUILT_INDEX_REQUIRED');
  const html = readFileSync(index, 'utf8');
  const entries = [...html.matchAll(/<script\b[^>]*>/g)].map(match => match[0])
    .map(tag => ({ type: /\btype\s*=\s*["']([^"']+)["']/.exec(tag)?.[1], src: /\bsrc\s*=\s*["']([^"']+)["']/.exec(tag)?.[1] }))
    .filter(attribute => attribute.type === 'module' && attribute.src);
  require(entries.length === 1, 'SINGLE_BUILT_ENTRY_REQUIRED');
  const entry = entries[0].src;
  require(/^\/assets\/[A-Za-z0-9._-]+\.js$/.test(entry) && !entry.includes('..'), 'LOCAL_BUILT_ENTRY_REQUIRED');
  require(existsSync(join(dist, entry.slice(1))), 'BUILT_JAVASCRIPT_REQUIRED');
  return { entry, html };
}

function precompress(dist) {
  const written = [];
  for (const path of listFiles(dist)) {
    if (!compressibleExtensions.has(extension(path))) continue;
    const content = readFileSync(path);
    const brotli = brotliCompressSync(content);
    const gzip = gzipSync(content, { level: 9 });
    if (brotli.length < content.length) { writeFileSync(path + '.br', brotli); written.push(path + '.br'); }
    if (gzip.length < content.length) { writeFileSync(path + '.gz', gzip); written.push(path + '.gz'); }
  }
  return written;
}

function writeDigestMap(dist) {
  const digests = {};
  for (const path of listFiles(dist)) {
    const name = relative(dist, path).split('\\').join('/');
    if (name === 'asset-digests.json') continue;
    digests[name] = sha256File(path);
  }
  writeFileSync(join(dist, 'asset-digests.json'), JSON.stringify(digests) + '\n');
  return digests;
}

function copyRuntime(source, runtime, dependencies = source) {
  for (const [from, to, excludeTests] of runtimeCopies) {
    const origin = join(from === 'node_modules' ? dependencies : source, from);
    require(existsSync(origin), 'RUNTIME_INPUT_REQUIRED');
    const destination = join(runtime, to);
    mkdirSync(dirname(destination), { recursive: true });
    if (lstatSync(origin).isFile()) { copyFileSync(origin, destination); continue; }
    for (const path of listFiles(origin, { excludeTests, dependencyRoot: from === 'node_modules' ? dependencies : null })) {
      const target = join(runtime, to, relative(origin, path));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(path, target);
    }
  }
}

function fileDigests(root, prefix) {
  return listFiles(root).map(path => ({ path: prefix + relative(root, path).split('\\').join('/'),
    sha256: sha256File(path), bytes: statSync(path).size }));
}

function packTarball(runtime, archive) {
  const result = spawnSync('tar', ['-czf', archive, '-C', runtime, 'apps', 'tools', 'node_modules', 'package.json', 'package-lock.json'], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status !== 0) throw new BuildError('TARBALL_FAILED');
}

export function buildRuntimeArtifact(options) {
  const { source, output, commit, gitTree, expectedPlatform, expectedNodeVersion } = options;
  const platform = `${process.platform}-${process.arch}`;
  require(!expectedPlatform || platform === expectedPlatform, 'PLATFORM_MISMATCH');
  require(!expectedNodeVersion || process.version === expectedNodeVersion, 'NODE_VERSION_MISMATCH');
  const dependencyRoot = options.dependencies ?? source;
  const installed = JSON.parse(readFileSync(join(dependencyRoot, 'node_modules/.package-lock.json'), 'utf8'));
  require(!Object.values(installed.packages ?? {}).some(pkg => pkg.dev === true), 'PRODUCTION_DEPENDENCIES_REQUIRED');
  const dist = join(source, 'apps/web/dist');
  const { entry, html } = parseEntry(dist);
  precompress(dist);
  const digests = writeDigestMap(dist);
  mkdirSync(output, { recursive: true });
  const runtime = join(output, 'runtime');
  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(runtime);
  try {
    copyRuntime(source, runtime, options.dependencies);
    const staticFiles = fileDigests(join(runtime, 'apps/web/dist'), '');
    const runtimeFiles = [...fileDigests(join(runtime, 'apps/server'), 'apps/server/'),
      ...fileDigests(join(runtime, 'tools/i0-cloud'), 'tools/i0-cloud/'),
      ...fileDigests(join(runtime, 'node_modules'), 'node_modules/'),
      ...['package.json', 'package-lock.json'].map(path => ({ path, sha256: sha256File(join(runtime, path)), bytes: statSync(join(runtime, path)).size }))];
    const aggregate = files => sha256(JSON.stringify(files.map(file => [file.path, file.sha256])));
    const manifest = {
      format: 'xunjie-runtime-artifact', version: 1, commit, gitTree, platform, nodeVersion: process.version,
      builtAt: utcNow(), runtimeFiles, staticFiles,
      runtimeSha256: aggregate(runtimeFiles), staticSha256: aggregate(staticFiles),
      indexSha256: sha256(html), entryJs: entry, entryJsSha256: sha256File(join(dist, entry.slice(1))),
      // The map the static host loads for ETag revalidation; keys must match dist file names.
      staticDigests: digests,
    };
    const archive = join(output, 'runtime.tar.gz');
    packTarball(runtime, archive);
    manifest.artifactSha256 = sha256File(archive);
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { manifest, archive, runtime };
  } finally {
    // The release directory is assembled again server-side from the verified tarball.
    rmSync(runtime, { recursive: true, force: true });
  }
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write('Usage: node tools/i0-cloud/build-runtime-artifact.mjs --source <repo-root> --output <dir> '
      + '--commit <sha> --git-tree <sha> [--dependencies <production-workspace>] [--expected-platform linux-x64] [--expected-node-version v24.21.0]\n');
    if (error instanceof BuildError) process.stderr.write(error.message + '\n');
    process.exitCode = 2;
    return;
  }
  try {
    const { manifest, archive } = buildRuntimeArtifact(options);
    process.stdout.write(JSON.stringify({
      status: 'built', commit: manifest.commit, platform: manifest.platform, nodeVersion: manifest.nodeVersion,
      manifest: 'manifest.json', archive: 'runtime.tar.gz', artifactSha256: manifest.artifactSha256,
      archiveBytes: statSync(archive).size, staticFiles: manifest.staticFiles.length, runtimeFiles: manifest.runtimeFiles.length,
    }, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'failed', code: error instanceof BuildError ? error.message : 'BUILD_FAILED' }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
