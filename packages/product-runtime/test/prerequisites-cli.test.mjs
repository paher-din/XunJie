import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { build } from 'esbuild';
import { buildApplication } from '../../../scripts/package-product.mjs';

test('packaged CLI gates managed install before data mutation and keeps read-only/remote/external paths inert', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xunjie-prereq-cli-'));
  try {
    const app = join(directory, 'app');
    await buildApplication(app);
    const cli = join(app, 'cli-windows.mjs');
    // Exercise the production CLI's Windows branch on CI without running any
    // Windows installer. Only its OS-command boundary is a process fixture.
    await build({ entryPoints: [join(app, 'cli.js')], outfile: cli, bundle: true, platform: 'node', format: 'esm',
      define: { 'process.platform': '"win32"' }, logLevel: 'silent' });
    const systemRoot = join(directory, 'Windows');
    const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await mkdir(join(executable, '..'), { recursive: true });
    const log = join(directory, 'calls.jsonl');
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const code = Buffer.from(process.argv[process.argv.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
const mode = code.match(/} -Mode (Check|Prepare)/)[1];
fs.appendFileSync(process.env.PREREQ_TEST_LOG, JSON.stringify(mode)+'\\n');
if(mode === 'Check') { console.log(JSON.stringify({status:'preparation-required',runtime:{ready:false,productAcceptedMinimum:'14.51.36247.0'}})); process.exit(3); }
if(process.env.PREREQ_TEST_BAD_CACHE) { console.error('PRIVATE_POWERSHELL_DETAIL_SHOULD_NOT_ESCAPE'); console.log(JSON.stringify({status:'preparation-failed',error:{code:'VC_CACHE_HASH_MISMATCH',message:'缓存 SHA-256 不匹配；原文件已保留。',cachePath:'C:\\\\private\\\\bad-cache\\\\VC_redist.x64.exe',recovery:'请手动移出并保留备份，再运行 xunjie prepare 重新下载。'}})); process.exit(1); }
console.log(JSON.stringify({status:'downloaded-and-verified-not-installed',installer:'C:\\\\private\\\\VC_redist.x64.exe',fileVersion:'14.51.36247.0',sha256:'a'.repeat(64),signature:{status:process.env.PREREQ_TEST_BAD ? 'NotSigned' : 'Valid'}}));
`);
    await chmod(executable, 0o700);
    const helper = join(directory, 'helper.ps1'); await writeFile(helper, '# product fixture');
    const resources = join(directory, 'resources.json');
    await writeFile(resources, JSON.stringify({ nodePath: process.execPath, nodeVersion: '24.21.0', webRoot: directory,
      postgresBin: directory, postgresVersion: '18.6', windowsPrerequisitePath: helper }));
    const root = join(directory, 'new-environment');
    const invoke = async (args, extra = {}) => {
      try { const result = await promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env, SystemRoot: systemRoot, PREREQ_TEST_LOG: log, ...extra } }); return { code: 0, ...result }; }
      catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    };
    for (const command of ['--help', 'status', 'stop']) {
      const result = await invoke([command, '--root', root, '--json']);
      assert.equal(result.code, command === '--help' ? 0 : 1);
    }
    for (const profile of ['remote']) assert.equal((await invoke(['prepare', '--profile', profile, '--root', root, '--resources', resources, '--json'])).code, 0);
    const external = join(directory, 'external.json');
    await writeFile(external, JSON.stringify({ profile: 'local', database: { mode: 'external' } }));
    assert.equal((await invoke(['prepare', '--config', external, '--root', root, '--resources', resources, '--json'])).code, 0);
    const savedRoot = join(directory, 'saved-environment');
    await mkdir(savedRoot);
    const savedResources = JSON.parse(await readFile(resources, 'utf8'));
    await writeFile(join(savedRoot, 'installation.json'), JSON.stringify({ resources: savedResources, database: { mode: 'external' } }));
    assert.equal((await invoke(['prepare', '--root', savedRoot, '--resources', resources, '--json'])).code, 1);
    // This intentionally incomplete environment fails its normal root check,
    // while proving that saved external mode does not invoke the preparer.
    assert.equal((await invoke(['start', '--root', savedRoot, '--json'])).code, 1);
    await assert.rejects(readFile(log), { code: 'ENOENT' });
    // A valid marker with an explicitly uninstalled configuration must also
    // fail before a helper/cache is touched, for both prepare and start.
    await writeFile(join(savedRoot, '.xunjie-root'), 'XunJie product environment v1\n');
    const descriptor = { formatVersion: 1, environmentId: '1e30ac9b-8124-4cac-9e10-6d85b9d53b3a', installationId: '769b7816-6a3a-4db5-8d39-50a9d82b0a4e', clientNamespace: 'fixture', profile: 'local', services: [] };
    await writeFile(join(savedRoot, 'environment.json'), JSON.stringify(descriptor));
    await writeFile(join(savedRoot, 'installation.json'), JSON.stringify({ installed: false, resources: savedResources, database: { mode: 'managed' } }));
    for (const command of ['prepare', 'start']) {
      const invalid = await invoke([command, '--root', savedRoot, '--resources', resources, '--json']);
      assert.equal(invalid.code, 1);
      assert.match(invalid.stderr, /Install the product before/);
    }
    await assert.rejects(readFile(log), { code: 'ENOENT' });
    const result = await invoke(['install', '--root', root, '--resources', resources, '--json']);
    assert.equal(result.code, 3, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'installation-required');
    assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse), ['Check', 'Prepare']);
    await assert.rejects(readFile(join(root, 'environment.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(root, '.xunjie-root')), { code: 'ENOENT' });
    await writeFile(join(savedRoot, 'installation.json'), JSON.stringify({ installed: true, resources: savedResources, database: { mode: 'managed' } }));
    const savedStart = await invoke(['start', '--root', savedRoot, '--json']);
    assert.equal(savedStart.code, 3);
    assert.equal(JSON.parse(savedStart.stdout).status, 'installation-required');
    const failed = await invoke(['install', '--root', root, '--resources', resources, '--json'], { PREREQ_TEST_BAD: 'yes' });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /尚未通过完整校验/);
    await assert.rejects(readFile(join(root, 'installation.json')), { code: 'ENOENT' });
    const badCache = await invoke(['prepare', '--root', root, '--resources', resources, '--json'], { PREREQ_TEST_BAD_CACHE: 'yes' });
    assert.equal(badCache.code, 1);
    const diagnostic = JSON.parse(badCache.stderr);
    assert.equal(diagnostic.code, 'VC_CACHE_HASH_MISMATCH');
    assert.match(diagnostic.cachePath, /bad-cache.*VC_redist/);
    assert.match(diagnostic.recovery, /手动移出.*备份.*prepare/);
    assert.match(diagnostic.message, /bad-cache/);
    assert.doesNotMatch(badCache.stderr, /PRIVATE_POWERSHELL/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
