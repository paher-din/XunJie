import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [target, ...args] = process.argv.slice(2);
if (!['server', 'contracts', 'tools', 'checks'].includes(target) || args.some(arg => !['--external', '--list'].includes(arg))) {
  throw new Error('Usage: node scripts/test.mjs <server|contracts|tools|checks> [--external] [--list]');
}
const external = args.includes('--external');
const cwd = join(root, { server: 'apps/server', contracts: 'packages/contracts', tools: 'tools', checks: 'scripts' }[target]);
const discovered = globSync('**/*.test.{ts,mjs,py}', {
  cwd, exclude: ['**/node_modules/**', '**/dist/**', '**/evidence/**'],
}).sort();
const isExternal = path => /\.runtime\.test\.ts$/.test(path)
  || ['runner/node.rpc.test.ts', 'server/tutoring/test/real-provider-failures.test.ts',
    'xj-dev-access/ssh-policy.test.py'].includes(path);
const files = discovered.filter(path => isExternal(path) === external);
if (!files.length) {
  if (target !== 'contracts') throw new Error(`No ${external ? 'external' : 'local'} tests discovered in ${cwd}`);
  console.log('contracts: no test files; typecheck and consumer regressions validate the unchanged wire behavior.');
  process.exit(0);
}
console.log(`${target}: ${files.length} ${external ? 'external' : 'local'} test files discovered recursively.`);
if (!external) {
  console.log('External runtime/provider/owner-sshd files are grouped under test:external; mixed files keep their explicit environment gates.');
}
if (args.includes('--list')) {
  for (const file of files) console.log(relative(root, join(cwd, file)));
  process.exit(0);
}
if (external) {
  console.log('External tests require their documented Linux VM, image/toolchain or approved model environment; see docs/student-agent-implementation/engineering-entrypoints.md.');
}
const run = (binary, argv) => {
  const result = spawnSync(binary, argv, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const nodeFiles = files.filter(file => !file.endsWith('.py'));
if (nodeFiles.length) run(process.execPath, ['--test', '--test-concurrency=4', ...nodeFiles]);
for (const file of files.filter(file => file.endsWith('.py'))) run('python3', [file]);
