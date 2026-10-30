// Install the locked production graph separately from the checked/tested workspace.
import { cpSync, existsSync, globSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { npmCliJs } from '../xj-dev/src/runtime.mjs';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg || process.argv.length !== 4 || process.version !== 'v24.21.0') {
  throw new Error('Use Node24.21.0: prepare-production-runtime.mjs SOURCE NEW_DIRECTORY');
}
const source = resolve(sourceArg), output = resolve(outputArg);
if (existsSync(output)) throw new Error('NEW_PRODUCTION_DIRECTORY_REQUIRED');
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const workspaces = manifest.workspaces?.packages ?? manifest.workspaces;
const manifests = globSync(workspaces.map(pattern => pattern + '/package.json'), { cwd: source });
for (const path of ['package.json', 'package-lock.json', ...manifests, 'apps/server/tools/check-runtime.mjs']) {
  const target = join(output, path);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(source, path), target);
}
const result = spawnSync(process.execPath, [npmCliJs(process.execPath), 'ci', '--workspace', '@xunjie/server', '--workspace', '@xunjie/contracts', '--include-workspace-root', '--omit=dev', '--no-audit', '--no-fund'],
  { cwd: output, stdio: 'inherit' });
if (result.status !== 0) throw new Error('PRODUCTION_INSTALL_FAILED');
