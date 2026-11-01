import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { removeWorkspaceDependencies, reuseWorkspaceDependencies } from './workspace-dependencies.mjs';

function write(root, path, contents) {
  const file = join(root, path); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
}
function link(from, to, file = false) {
  mkdirSync(dirname(to), { recursive: true });
  symlinkSync(from, to, file ? 'file' : process.platform === 'win32' ? 'junction' : 'dir');
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xj-dependency-reuse-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const source = join(root, 'source'), target = join(root, 'target');
  write(source, 'package.json', { workspaces: ['legacy/*'] });
  write(target, 'package.json', { workspaces: { packages: ['packages/*'] } });
  for (const base of [source, target]) write(base, 'package-lock.json', { lockfileVersion: 3 });
  for (const [base, folder, label] of [[source, 'legacy', 'original'], [target, 'packages', 'restored']]) {
    for (const name of ['contracts', 'server']) {
      write(base, `${folder}/${name}/package.json`, { name: `@fixture/${name}`, main: './dist/index.cjs' });
      write(base, `${folder}/${name}/dist/index.cjs`, `module.exports = '${label}-${name}';`);
    }
  }
  write(source, 'node_modules/.package-lock.json', { lockfileVersion: 3 });
  write(source, 'node_modules/external/package.json', { name: 'external', main: 'index.cjs' });
  write(source, 'node_modules/external/index.cjs', "module.exports = 'external';");
  write(source, 'node_modules/@vendor/codec/package.json', { name: '@vendor/codec', main: 'index.cjs' });
  write(source, 'node_modules/@vendor/codec/index.cjs', "module.exports = 'codec';");
  for (const name of ['contracts', 'server']) link(join(source, 'legacy', name), join(source, 'node_modules/@fixture', name));
  link(join(source, 'legacy/contracts'), join(source, 'node_modules/contracts-alias'));
  write(source, 'node_modules/typescript/package.json', { name: 'typescript', version: '7.0.2' });
  write(source, 'legacy/contracts/node_modules/typescript/package.json', { name: 'typescript', version: '5.9.2' });
  write(source, 'legacy/contracts/node_modules/typescript/bin/tsc', "process.stdout.write('nested-compiler');");
  // npm uses symlink bins on POSIX and ordinary command shims on Windows.
  if (process.platform !== 'win32') {
    link(join(source, 'legacy/contracts/node_modules/typescript/bin/tsc'), join(source, 'legacy/contracts/node_modules/.bin/tsc'), true);
    write(source, 'legacy/contracts/cli.cjs', "process.stdout.write('original-cli');");
    write(target, 'packages/contracts/cli.cjs', "process.stdout.write('restored-cli');");
    link(join(source, 'legacy/contracts/cli.cjs'), join(source, 'node_modules/.bin/fixture'), true);
  }
  write(source, 'node_modules/.bin/tsc.cmd', '@node "%~dp0\\..\\typescript\\bin\\tsc" %*\r\n');
  link(join(source, 'legacy/contracts'), join(source, 'legacy/server/node_modules/@fixture/contracts'));
  return { source, target };
}

test('reused dependencies resolve root and nested workspace imports to restored outputs', t => {
  const { source, target } = fixture(t);
  const external = join(source, 'node_modules/external/index.cjs'); chmodSync(external, 0o444);
  const before = { bytes: readFileSync(external), mode: statSync(external).mode, mtime: statSync(external).mtimeMs };
  const marker = join(source, 'node_modules/.package-lock.json'), markerBefore = readFileSync(marker);
  reuseWorkspaceDependencies(source, target);
  assert.equal(lstatSync(join(target, 'node_modules')).isSymbolicLink(), false);
  assert.equal(lstatSync(join(target, 'node_modules/@fixture')).isSymbolicLink(), false);
  assert.equal(lstatSync(join(target, 'packages/server/node_modules/@fixture')).isSymbolicLink(), false);
  const rootRequire = createRequire(join(target, 'consumer.cjs'));
  const serverRequire = createRequire(join(target, 'packages/server/consumer.cjs'));
  for (const require of [rootRequire, serverRequire]) {
    assert.equal(require('@fixture/contracts'), 'restored-contracts');
    assert.equal(require('@fixture/server'), 'restored-server');
    assert.equal(require('external'), 'external'); assert.equal(require('@vendor/codec'), 'codec');
  }
  assert.equal(rootRequire('contracts-alias'), 'restored-contracts');
  assert.equal(realpathSync(join(target, 'node_modules/external')), realpathSync(join(source, 'node_modules/external')));
  assert.deepEqual(readFileSync(external), before.bytes); assert.equal(statSync(external).mode, before.mode); assert.equal(statSync(external).mtimeMs, before.mtime);
  writeFileSync(join(target, 'node_modules/.package-lock.json'), '{}');
  assert.deepEqual(readFileSync(marker), markerBefore, 'install marker is owned by the target');
  for (const path of ['package.json', 'package-lock.json', 'packages/contracts/package.json', 'packages/server/package.json']) {
    assert.equal(statSync(join(target, path)).mtimeMs, 0);
  }
});

test('nested compiler packages and bins retain their own version without redirecting workspace bins', t => {
  const { source, target } = fixture(t);
  reuseWorkspaceDependencies(source, target);
  const rootRequire = createRequire(join(target, 'consumer.cjs'));
  const contractsRequire = createRequire(join(target, 'packages/contracts/consumer.cjs'));
  assert.equal(rootRequire('typescript/package.json').version, '7.0.2');
  assert.equal(contractsRequire('typescript/package.json').version, '5.9.2');
  assert.equal(realpathSync(join(target, 'packages/contracts/node_modules/typescript')), realpathSync(join(source, 'legacy/contracts/node_modules/typescript')));
  assert.equal(lstatSync(join(target, 'node_modules/.bin')).isSymbolicLink(), false);
  assert.equal(readFileSync(join(target, 'node_modules/.bin/tsc.cmd'), 'utf8'), readFileSync(join(source, 'node_modules/.bin/tsc.cmd'), 'utf8'));
  if (process.platform !== 'win32') {
    for (const [path, expected] of [['packages/contracts/node_modules/.bin/tsc', 'nested-compiler'], ['node_modules/.bin/fixture', 'restored-cli']]) {
      const result = spawnSync(process.execPath, [join(target, path)], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, expected);
    }
  }
});

test('new target workspaces get local links; source-only workspaces do not leak into acceptance', t => {
  const { source, target } = fixture(t);
  write(source, 'legacy/omitted/package.json', { name: '@fixture/omitted' });
  link(join(source, 'legacy/omitted'), join(source, 'node_modules/@fixture/omitted'));
  write(target, 'packages/new/package.json', { name: '@fixture/new', main: './index.cjs' });
  write(target, 'packages/new/index.cjs', "module.exports = 'new-target';");
  reuseWorkspaceDependencies(source, target);
  assert.equal(existsSync(join(target, 'node_modules/@fixture/omitted')), false);
  assert.equal(createRequire(join(target, 'consumer.cjs'))('@fixture/new'), 'new-target');
  assert.equal(createRequire(join(source, 'consumer.cjs'))('@fixture/contracts'), 'original-contracts');
});

test('a source checkout borrowing another installation still relocates workspaces and nested compilers', t => {
  const { source: installed, target } = fixture(t), source = join(installed, '..', 'borrowing-checkout');
  write(source, 'package.json', { workspaces: ['legacy/*'] });
  for (const name of ['contracts', 'server']) {
    write(source, `legacy/${name}/package.json`, { name: `@fixture/${name}` });
  }
  link(join(installed, 'node_modules'), join(source, 'node_modules'));
  reuseWorkspaceDependencies(source, target);
  const require = createRequire(join(target, 'packages/contracts/consumer.cjs'));
  assert.equal(require('@fixture/contracts'), 'restored-contracts');
  assert.equal(require('contracts-alias'), 'restored-contracts');
  assert.equal(require('typescript/package.json').version, '5.9.2');
  if (process.platform !== 'win32') {
    assert.equal(realpathSync(join(target, 'node_modules/.bin/fixture')), realpathSync(join(target, 'packages/contracts/cli.cjs')));
  }
});

test('teardown removes root and nested layouts while preserving shared packages and source workspaces', t => {
  const { source, target } = fixture(t);
  reuseWorkspaceDependencies(source, target);
  removeWorkspaceDependencies(target);
  for (const path of ['node_modules', 'packages/contracts/node_modules', 'packages/server/node_modules']) {
    assert.equal(existsSync(join(target, path)), false);
  }
  assert.equal(readFileSync(join(source, 'node_modules/external/index.cjs'), 'utf8'), "module.exports = 'external';");
  assert.equal(readFileSync(join(source, 'legacy/contracts/node_modules/typescript/package.json'), 'utf8'), JSON.stringify({ name: 'typescript', version: '5.9.2' }));
  assert.equal(readFileSync(join(target, 'packages/contracts/dist/index.cjs'), 'utf8'), "module.exports = 'restored-contracts';");
});
