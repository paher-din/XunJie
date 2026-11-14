import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const outputs = ['packages/contracts/dist', 'packages/storage/dist', 'packages/learning-space/dist',
  'packages/agent-runtime/dist', 'packages/model-gateway/dist', 'packages/agents/dist',
  'packages/product-runtime/dist', 'apps/server/dist', 'apps/web/dist', 'apps/web/dist-runtime', 'apps/local-runtime/dist'];
const cache = '.cache/xunjie-build';
const allowed = path => [...outputs, cache].some(root => path === root || path.startsWith(root + '/'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function command(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${binary} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
function inventory(root) {
  const files = {};
  function visit(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      if (/\r|\n/.test(name)) throw new Error('Invalid build artifact path');
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) {
        const bytes = readFileSync(join(root, name));
        files[name] = { bytes: bytes.length, sha256: digest(bytes) };
      } else throw new Error(`Build artifact must contain regular files: ${name}`);
    }
  }
  for (const path of [...outputs, cache]) if (existsSync(join(root, path))) visit(path);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
function identity(root) {
  return { commit: command('git', ['rev-parse', 'HEAD'], root).trim(),
    tree: command('git', ['rev-parse', 'HEAD^{tree}'], root).trim(), node: process.version,
    platform: process.platform, arch: process.arch };
}
export function packBuild(root, destination) {
  root = resolve(root); destination = resolve(destination);
  for (const path of outputs) if (!existsSync(join(root, path))) throw new Error(`Missing build output: ${path}`);
  const files = inventory(root);
  mkdirSync(destination, { recursive: true });
  const paths = [...outputs, ...(existsSync(join(root, cache)) ? [cache] : [])];
  command('tar', ['-cf', join(destination, 'build.tar'), ...paths], root);
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ version: 1, ...identity(root),
    archiveSha256: digest(readFileSync(join(destination, 'build.tar'))), files }, null, 2) + '\n');
}
export function restoreBuild(root, source) {
  root = resolve(root); source = resolve(source);
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || Object.entries(identity(root)).some(([key, value]) => manifest[key] !== value)) {
    throw new Error('Build artifact source or toolchain mismatch');
  }
  const archive = join(source, 'build.tar');
  if (manifest.archiveSha256 !== digest(readFileSync(archive))) throw new Error('Build artifact archive digest mismatch');
  for (const path of Object.keys(manifest.files)) {
    if (!allowed(path) || path.split('/').some(part => !part || part === '..' || part === '.') || /[\r\n\\]/.test(path)) {
      throw new Error('Invalid build artifact path');
    }
  }
  const names = command('tar', ['-tf', archive], root).trim().split('\n');
  if (names.some(path => !allowed(path.replace(/\/$/, '')) || path.split('/').includes('..'))) throw new Error('Invalid tar entry');
  if (command('tar', ['-tvf', archive], root).trim().split('\n').some(line => !['-', 'd'].includes(line[0]))) {
    throw new Error('Build artifact contains a link or special entry');
  }
  const staging = mkdtempSync(join(tmpdir(), 'xunjie-ci-build-'));
  try {
    command('tar', ['-xf', archive, '-C', staging], root);
    if (JSON.stringify(inventory(staging)) !== JSON.stringify(manifest.files)) throw new Error('Build artifact file digest mismatch');
    for (const path of outputs) if (!existsSync(join(staging, path))) throw new Error(`Missing build output: ${path}`);
    for (const path of [...outputs, cache]) {
      rmSync(join(root, path), { recursive: true, force: true });
      if (existsSync(join(staging, path))) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        renameSync(join(staging, path), join(root, path));
      }
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, directory, ...extra] = process.argv.slice(2);
  if (!['pack', 'restore'].includes(operation) || !directory || extra.length) throw new Error('Usage: node scripts/ci-build-artifact.mjs pack|restore DIRECTORY');
  (operation === 'pack' ? packBuild : restoreBuild)(process.cwd(), directory);
  console.log(`Build artifact ${operation}: ${directory}`);
}
