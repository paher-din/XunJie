// Separate developer-service source bundle. Never added to product artifacts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEPLOYMENT_FILES = [
  'apps/teaching/server/access/local-socket.ts',
  'tools/xj-dev/src/enrollment-protocol.mjs',
  ...['server.mjs', 'store.mjs', 'identity.mjs', 'adapters.mjs', 'admin.mjs', 'system-helper.py',
    'install.py', 'prepare-tls.py', 'package-store.mjs', 'packages.mjs', 'github-login.mjs', 'oss-storage.mjs', 'package.json', 'package-lock.json',
    'xunjie-dev-access-candidate129.service'].map(file => 'tools/xj-dev-access/' + file),
];
export function prepareDeployment(commit, output, cwd = process.cwd(), { installDependencies = false } = {}) {
  if (!/^[a-f0-9]{40}$/.test(commit) || existsSync(output)) throw new Error('FIXED_COMMIT_AND_NEW_DIRECTORY_REQUIRED');
  const git = args => {
    const result = spawnSync('git', args, { cwd, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status !== 0) throw new Error('COMMITTED_DEPLOYMENT_SOURCE_REQUIRED');
    return result.stdout;
  };
  if (git(['rev-parse', commit + '^{commit}']).toString().trim() !== commit) throw new Error('COMMIT_REQUIRED');
  const files = DEPLOYMENT_FILES.map(path => ({ path, bytes: git(['show', `${commit}:${path}`]) }));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const receipt = { format: 'xunjie/dev-access-source-v2', sourceCommit: commit,
    files: files.map(({ path, bytes }) => ({ path, sha256: createHash('sha256').update(bytes).digest('hex') })) };
  for (const { path, bytes } of files) { const target = resolve(output, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); }
  if (installDependencies) {
    if (process.version !== 'v24.21.0') throw new Error('PINNED_NODE_REQUIRED');
    const npm = process.platform === 'win32' ? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    if (!existsSync(npm)) throw new Error('PINNED_NPM_REQUIRED');
    const dependencyRoot = resolve(output, 'tools/xj-dev-access');
    const installed = spawnSync(process.execPath, [npm, 'ci', '--ignore-scripts', '--omit=dev', '--bin-links=false', '--no-audit', '--no-fund'], {
      cwd: dependencyRoot, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (installed.status !== 0) throw new Error('LOCKED_DEPENDENCIES_REQUIRED');
    const lock = readFileSync(resolve(dependencyRoot, 'package-lock.json'));
    const parsed = JSON.parse(lock);
    if (Object.values(parsed.packages).some(p => p.hasInstallScript || p.os || p.cpu)) throw new Error('PORTABLE_JAVASCRIPT_DEPENDENCIES_REQUIRED');
    const dependencies = [];
    const walk = path => {
      for (const name of readdirSync(resolve(output, path)).sort()) {
        const child = path + '/' + name, stat = lstatSync(resolve(output, child));
        if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error('DEPENDENCY_PATH_INVALID');
        if (stat.isDirectory()) walk(child);
        else {
          if (/\.(node|so|dylib|dll|exe)$/i.test(child)) throw new Error('PORTABLE_JAVASCRIPT_DEPENDENCIES_REQUIRED');
          dependencies.push({ path: child, bytes: stat.size, sha256: createHash('sha256').update(readFileSync(resolve(output, child))).digest('hex') });
        }
      }
    };
    walk('tools/xj-dev-access/node_modules');
    receipt.dependencies = { lockfileSha256: createHash('sha256').update(lock).digest('hex'), nodeVersion: process.version, files: dependencies };
  }
  writeFileSync(resolve(output, 'deployment.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--commit' || args[2] !== '--output') throw new Error('ARGUMENTS_REQUIRED');
    const receipt = prepareDeployment(args[1], resolve(args[3]), process.cwd(), { installDependencies: true });
    process.stdout.write(JSON.stringify({ sourceCommit: receipt.sourceCommit, files: receipt.files.length, directory: resolve(args[3]) }) + '\n');
  } catch { process.stderr.write('Use --commit FULL_SHA --output NEW_DIRECTORY; only committed source is deployable.\n'); process.exitCode = 1; }
}
