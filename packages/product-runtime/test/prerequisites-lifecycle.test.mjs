import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('public lifecycle gates before identity changes and rejects damaged/uninstalled environments before OS preparation', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(import.meta.dirname, '.prereq-api-'));
  const oldSystemRoot = process.env.SystemRoot, oldLog = process.env.PREREQ_TEST_LOG;
  try {
    const executable = join(dir, 'Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
    await mkdir(join(executable, '..'), { recursive: true });
    const log = join(dir, 'calls');
    const fixture = join(dir, 'powershell-fixture.cjs');
    await writeFile(fixture, `
const fs=require('node:fs');const code=Buffer.from(process.argv.at(-1),'base64').toString('utf16le');const mode=code.match(/} -Mode (Check|Prepare)/)[1];fs.appendFileSync(process.env.PREREQ_TEST_LOG,mode+'\\n');
if(mode==='Check'){console.log(JSON.stringify({status:'preparation-required',runtime:{ready:false,productAcceptedMinimum:'14.51.36247.0'}}));process.exit(3)}
console.log(JSON.stringify({status:'downloaded-and-verified-not-installed',signature:{status:'Valid'},installer:'C:\\\\private\\\\VC_redist.x64.exe',fileVersion:'14.51.36247.0',sha256:'a'.repeat(64)}));
`);
    await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`);
    await chmod(executable, 0o700);
    process.env.SystemRoot = join(dir, 'Windows'); process.env.PREREQ_TEST_LOG = log;
    const entry = join(dir, 'api.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))], outfile: entry, bundle: true, platform: 'node', format: 'esm', external: ['pg'], logLevel: 'silent',
      plugins: [{ name: 'windows-prerequisite-host-only', setup(b) { b.onLoad({ filter: /[\\/]prerequisites\.ts$/ }, async ({ path }) => ({ contents: (await readFile(path, 'utf8')).replace('platform: process.platform', 'platform: "win32"'), loader: 'ts' })); } }] });
    const { openProductRuntime } = await import(pathToFileURL(entry).href);
    const helper = join(dir, 'helper.ps1'); await writeFile(helper, '# fixture');
    await writeFile(join(dir, 'index.html'), 'product');
    const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', webRoot: dir, windowsPrerequisitePath: helper };
    const root = join(dir, 'fresh');
    const runtime = openProductRuntime({ root, resources });
    await assert.rejects(runtime.install({ profile: 'local' }), error => error.code === 'PRODUCT_INSTALLATION_REQUIRED' && error.result.status === 'installation-required');
    await assert.rejects(readdir(root), { code: 'ENOENT' });
    assert.equal(typeof runtime.prepare, 'function');
    assert.equal((await runtime.prepare({ profile: 'local' })).status, 'installation-required');
    await assert.rejects(readdir(root), { code: 'ENOENT' });
    const savedRoot = join(dir, 'saved'); await mkdir(savedRoot);
    const descriptor = { formatVersion: 1, environmentId: '1e30ac9b-8124-4cac-9e10-6d85b9d53b3a', installationId: '769b7816-6a3a-4db5-8d39-50a9d82b0a4e', clientNamespace: 'fixture', profile: 'local', services: [] };
    const savedResources = { ...resources, nodePath: '/old/saved/node', postgresBin: '/old/saved/postgres' };
    delete savedResources.windowsPrerequisitePath;
    const config = { installed: true, resources: savedResources, database: { mode: 'managed' }, host: '127.0.0.1', port: 54321, requiredServiceIds: [], connections: [] };
    const configuration = join(savedRoot, 'installation.json');
    await writeFile(configuration, JSON.stringify(config)); await writeFile(join(savedRoot, 'environment.json'), JSON.stringify(descriptor));
    const saved = openProductRuntime({ root: savedRoot, resources });
    const calls = await readFile(log, 'utf8');
    for (const operation of [() => saved.prepare(), () => saved.start(), () => saved.install({ profile: 'local' })]) await assert.rejects(operation(), /ENOENT|product environment|occupied/i);
    assert.equal(await readFile(log, 'utf8'), calls);
    await writeFile(join(savedRoot, '.xunjie-root'), 'XunJie product environment v1\n');
    await writeFile(configuration, '{ damaged');
    await assert.rejects(saved.prepare());
    await writeFile(configuration, JSON.stringify(config));
    await writeFile(join(savedRoot, 'environment.json'), '{}');
    await assert.rejects(saved.prepare());
    assert.equal(await readFile(log, 'utf8'), calls);
    await writeFile(join(savedRoot, 'environment.json'), JSON.stringify(descriptor));
    await writeFile(configuration, JSON.stringify({ ...config, installed: false }));
    for (const operation of [() => saved.prepare(), () => saved.start()]) await assert.rejects(operation(), /install.*before|not installed/i);
    assert.equal(await readFile(log, 'utf8'), calls);
    await writeFile(configuration, JSON.stringify(config));
    const before = await readFile(configuration, 'utf8');
    await assert.rejects(saved.start(), error => error.code === 'PRODUCT_INSTALLATION_REQUIRED');
    assert.equal(await readFile(configuration, 'utf8'), before);
    await assert.rejects(readFile(join(savedRoot, 'launch.json')), { code: 'ENOENT' });
    await assert.rejects(readdir(join(savedRoot, 'logs')), { code: 'ENOENT' });
    // An explicit reinstall may prepare, but cannot flip installed:false first.
    await writeFile(configuration, JSON.stringify({ ...config, installed: false }));
    await assert.rejects(saved.install({ profile: 'local' }), error => error.code === 'PRODUCT_INSTALLATION_REQUIRED');
    assert.equal(JSON.parse(await readFile(configuration, 'utf8')).installed, false);
  } finally {
    if (oldSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = oldSystemRoot;
    if (oldLog === undefined) delete process.env.PREREQ_TEST_LOG; else process.env.PREREQ_TEST_LOG = oldLog;
    await rm(dir, { recursive: true, force: true });
  }
});
