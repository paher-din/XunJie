// Separate developer-service source bundle. Never added to product artifacts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEPLOYMENT_FILES = [
  'apps/teaching/server/access/local-socket.ts',
  'tools/xj-dev/src/enrollment-protocol.mjs',
  ...['server.mjs', 'store.mjs', 'identity.mjs', 'adapters.mjs', 'admin.mjs', 'system-helper.py',
    'install.py', 'xunjie-dev-access-candidate129.service'].map(file => 'tools/xj-dev-access/' + file),
];
export function prepareDeployment(commit, output, cwd = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(commit) || existsSync(output)) throw new Error('FIXED_COMMIT_AND_NEW_DIRECTORY_REQUIRED');
  const git = args => {
    const result = spawnSync('git', args, { cwd, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status !== 0) throw new Error('COMMITTED_DEPLOYMENT_SOURCE_REQUIRED');
    return result.stdout;
  };
  if (git(['rev-parse', commit + '^{commit}']).toString().trim() !== commit) throw new Error('COMMIT_REQUIRED');
  const files = DEPLOYMENT_FILES.map(path => ({ path, bytes: git(['show', `${commit}:${path}`]) }));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const receipt = { format: 'xunjie/dev-access-source-v1', sourceCommit: commit,
    files: files.map(({ path, bytes }) => ({ path, sha256: createHash('sha256').update(bytes).digest('hex') })) };
  for (const { path, bytes } of files) { const target = resolve(output, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); }
  writeFileSync(resolve(output, 'deployment.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--commit' || args[2] !== '--output') throw new Error('ARGUMENTS_REQUIRED');
    const receipt = prepareDeployment(args[1], resolve(args[3]));
    process.stdout.write(JSON.stringify({ sourceCommit: receipt.sourceCommit, files: receipt.files.length, directory: resolve(args[3]) }) + '\n');
  } catch { process.stderr.write('Use --commit FULL_SHA --output NEW_DIRECTORY; only committed source is deployable.\n'); process.exitCode = 1; }
}
