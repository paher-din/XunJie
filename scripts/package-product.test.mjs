import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as packaging from './package-product.mjs';
const { npmCommand } = packaging;

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


test('product bundling executes fresh workspace source through declared root and feature exports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-product-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, source) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), source); };
  const packages = {
    contracts: ['index', 'export const value = 1;'],
    storage: ['chunks/owner', 'export { value } from "@xunjie/contracts";'],
    'agent-runtime': ['index', 'import { value } from "@xunjie/storage/chunks"; export const runtime = value + 1;'],
    'model-gateway': ['protocols/client', 'export const model = 3;'],
    'learning-space': ['index', 'export const learning = 4;'],
    agents: ['scenarios/student', 'import { runtime } from "@xunjie/agent-runtime"; import { model } from "@xunjie/model-gateway/protocols/client"; import { learning } from "@xunjie/learning-space"; export const agent = runtime + model + learning;'],
    'product-runtime': ['index', 'export { agent } from "@xunjie/agents/student";'],
  };
  for (const [name, [file, source]] of Object.entries(packages)) {
    const key = name === 'storage' ? './chunks' : name === 'agents' ? './student' : name === 'model-gateway' ? './protocols/*' : '.';
    const target = name === 'model-gateway' ? './dist/protocols/*.js' : `./dist/${file}.js`;
    await put(`packages/${name}/package.json`, JSON.stringify({ type: 'module', exports: { [key]: { types: './dist/absent.d.ts', import: target } } }));
    await put(`packages/${name}/src/${file}.ts`, source);
    await put(`packages/${name}/dist/${file}.js`, 'throw new Error("stale dist must not be bundled");');
  }
  await put('apps/local-runtime/src/cli.ts', 'import { agent } from "@xunjie/product-runtime"; console.log(agent);');
  const out = join(root, 'app');
  await packaging.bundleApplication(out, { sourceRoot: root, entryPoints: { cli: 'apps/local-runtime/src/cli.ts' } });
  const result = spawnSync(process.execPath, [join(out, 'cli.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '9');
  await put('apps/local-runtime/src/cli.ts', 'import "@xunjie/storage/private";');
  await assert.rejects(packaging.bundleApplication(out, { sourceRoot: root, entryPoints: { cli: 'apps/local-runtime/src/cli.ts' } }), /export/i);
  await put('packages/agent-runtime/src/index.ts', 'import "./hidden.test.js"; export const runtime = 2;');
  await put('packages/agent-runtime/src/hidden.test.ts', 'console.log("test host");');
  await put('apps/local-runtime/src/cli.ts', 'import "@xunjie/agent-runtime";');
  await assert.rejects(packaging.bundleApplication(out, { sourceRoot: root, entryPoints: { cli: 'apps/local-runtime/src/cli.ts' } }), /Non-production dependency/);
});

test('product source bundling rejects a reachable retired Agent run driver', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-product-retired-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, source) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), source); };
  await put('packages/agents/package.json', JSON.stringify({ type: 'module', exports: { './legacy': './dist/runtime/index.js' } }));
  await put('packages/agents/src/runtime/index.ts', 'export function createTeachingAgent() { return "retired driver"; }');
  await put('apps/local-runtime/src/cli.ts', 'import { createTeachingAgent } from "@xunjie/agents/legacy"; console.log(createTeachingAgent());');
  await assert.rejects(packaging.bundleApplication(join(root, 'app'), { sourceRoot: root, entryPoints: { cli: 'apps/local-runtime/src/cli.ts' } }), /Retired Agent dependency/);
  await put('packages/agents/package.json', JSON.stringify({ type: 'module', exports: { './legacy': './dist/transport/service.js' } }));
  await put('packages/agents/src/transport/service.ts', 'export function createTeachingAgent() { return "retired service"; }');
  await assert.rejects(packaging.bundleApplication(join(root, 'app'), { sourceRoot: root, entryPoints: { cli: 'apps/local-runtime/src/cli.ts' } }), /Retired Agent dependency/);
});


test('the current product source graph ships core v8 and chunk v9 migrations without a legacy runner', async t => {
  const app = await mkdtemp(join(tmpdir(), 'xunjie-product-agent-migrations-'));
  t.after(() => rm(app, { recursive: true, force: true }));
  await packaging.bundleApplication(app, { entryPoints: {
    cli: 'apps/local-runtime/src/cli.ts', daemon: 'packages/product-runtime/src/daemon.ts',
    'product-runtime': 'packages/product-runtime/src/index.ts',
    migrations: 'packages/agents/src/transport/session-storage.ts',
  } });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const {agentServiceMigrations}=await import(process.argv[1]); process.stdout.write(JSON.stringify(agentServiceMigrations));',
    pathToFileURL(join(app, 'migrations.js')).href], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const migrations = JSON.parse(result.stdout);
  assert.deepEqual(migrations.map(item => item.version), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(migrations[7].name, 'interruptible-agent-waits');
  assert.match(migrations[7].sql, /agent_waits ADD COLUMN interruptible/);
  assert.equal(migrations[8].name, 'agent-session-transport-v2');
  assert.match(migrations[8].sql, /CREATE TABLE agent_chunk_transfers/);
  assert.match(migrations[8].sql, /CREATE TABLE agent_chunk_parts/);
});
