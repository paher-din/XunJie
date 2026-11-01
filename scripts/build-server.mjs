import { readdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const forbidden = /(?:^|\/)(?:test|tests|fixtures|__tests__)(?:\/|$)|(?:\.test|\.fixtures|-support|test-child|i0-browser-fixture|i0-browser-runner|acceptance|record-validation)\.(?:js|d\.ts|js\.map)$/;

export async function scanServerOutput(dist) {
  for (const entry of await readdir(dist, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(dist, join(entry.parentPath, entry.name)).split('\\').join('/');
    if (forbidden.test(path)) throw new Error(`Test-only file in production build: ${path}`);
  }
}

export async function buildServer({ root = repository, compiler, run, args = [] }) {
  const server = join(root, 'apps/server');
  let output = 'dist';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--outDir' && args[index + 1]) output = args[++index];
    else if (args[index].startsWith('--outDir=')) output = args[index].slice('--outDir='.length);
  }
  const dist = resolve(server, output);
  await run(process.execPath, ['tools/check-runtime.mjs'], { cwd: server });
  if (!args.length) await rm(dist, { recursive: true, force: true });
  await run(process.execPath, [compiler, '-p', 'tsconfig.build.json', ...args], { cwd: server });
  // Imports can pull excluded test hosts back in: scan the emitted graph too.
  await scanServerOutput(dist);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { buildCli } = await import('./build.mjs');
  buildCli(['server', '--', ...process.argv.slice(2)]).catch(error => { console.error(`[build] ${error.message}`); process.exitCode ||= 1; });
}
