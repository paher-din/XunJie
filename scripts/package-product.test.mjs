import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { npmCommand } from './package-product.mjs';

test('product packaging invokes npm so passthrough arguments survive shell layers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = ['run', 'build:runtime', '--workspace', '@xunjie/web', '--', '--outDir', join(root, 'web')];
  // Every platform prefers the CLI entry: each extra shell (cmd.exe, npm.cmd)
  // re-quotes arguments and turns --outDir into a quoted relative path.
  const cli = join(root, 'node_modules/npm/bin/npm-cli.js');
  assert.deepEqual(await npmCommand(args, { execPath: cli, platform: 'linux' }), [process.execPath, [cli, ...args]]);
  await mkdir(join(root, 'node_modules/npm/bin'), { recursive: true });
  await writeFile(cli, '// npm cli');
  assert.deepEqual(await npmCommand(args, { execPath: join(root, 'npm.cmd'), platform: 'win32' }), [process.execPath, [cli, ...args]]);
  // Without a CLI next to the wrapper, Windows still needs the shell; other
  // platforms spawn npm directly.
  assert.equal(await npmCommand(args, { execPath: join(root, 'elsewhere/npm.cmd'), platform: 'win32' }), undefined);
  // undefined keeps the real npm_execpath; null models a shell-only npm.
  assert.deepEqual(await npmCommand(args, { execPath: null, platform: 'linux' }), ['npm', args]);
  assert.equal(await npmCommand(args, { execPath: null, platform: 'win32' }), undefined);
});
