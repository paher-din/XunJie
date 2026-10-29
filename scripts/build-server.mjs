import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = join(root, 'apps/server');
const dist = join(server, 'dist');
const require = createRequire(join(server, 'package.json'));
const compilerPackage = require.resolve('typescript/package.json');
const compiler = join(dirname(compilerPackage), JSON.parse(readFileSync(compilerPackage, 'utf8')).bin.tsc);
rmSync(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.build.json'], {
  cwd: server, stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Exclusions in tsconfig don't stop imports from pulling test hosts back in.
// Check the emitted graph too, so a future accidental import fails the build.
const forbidden = /(?:^|\/)(?:test|tests|fixtures|__tests__)(?:\/|$)|(?:\.test|\.fixtures|-support|test-child|i0-browser-fixture|i0-browser-runner|acceptance|record-validation)\.(?:js|d\.ts|js\.map)$/;
for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = relative(dist, join(entry.parentPath, entry.name)).split('\\').join('/');
  if (forbidden.test(path)) throw new Error(`Test-only file in production build: ${path}`);
}
