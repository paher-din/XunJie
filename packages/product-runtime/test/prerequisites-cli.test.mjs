import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { build } from 'esbuild';
import { assertProductionGraph, buildApplication } from '../../../scripts/package-product.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const packager = join(repository, 'scripts/package-product.mjs');
const catalogPath = join(repository, 'scripts/product-resources.json');
const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('the public packaging CLI selects versioned resources and emits an independently importable API', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xunjie-package-api-'));
  try {
    const cache = join(directory, 'cache');
    await mkdir(cache);
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    // Replace only the archive boundary with tiny local inputs. The real public
    // CLI still extracts, bundles production entries, collects licenses, audits
    // its metafile/paths and writes the final resources and distribution records.
    const specifications = [catalog.node, catalog.postgres, ...Object.values(catalog.postgresVersions)];
    for (const spec of specifications) {
      const asset = spec.platforms['darwin-arm64'];
      const source = join(directory, 'inputs', asset.archiveRoot);
      for (const name of spec.license.preserve) {
        const path = join(source, name);
        if (name === 'dependency-notices') {
          await mkdir(path, { recursive: true });
          await writeFile(join(path, 'NOTICE'), 'fixture dependency license');
        } else {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, 'fixture license/build metadata');
        }
      }
      const tools = spec === catalog.node ? [asset.executable] : spec.requiredTools.map(name => `bin/${name}`);
      for (const tool of tools) {
        await mkdir(dirname(join(source, tool)), { recursive: true });
        await writeFile(join(source, tool), `fixture ${spec.version} ${tool}`);
      }
      const archive = join(cache, new URL(asset.url).pathname.split('/').at(-1));
      await execute('tar', ['-czf', archive, '-C', dirname(source), asset.archiveRoot]);
      const bytes = await readFile(archive);
      asset.bytes = bytes.length;
      asset.sha256 = digest(bytes);
    }
    const preload = join(directory, 'archive-boundary.mjs');
    await writeFile(preload, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readFile;
fs.readFile = (path, ...args) => path === ${JSON.stringify(catalogPath)}
  ? Promise.resolve(${JSON.stringify(JSON.stringify(catalog))}) : original(path, ...args);
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error('Packaging regression must never use the network'); };
`);
    const npm = join(directory, 'web-build.mjs');
    await writeFile(npm, `import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const out=process.argv[process.argv.indexOf('--outDir')+1];
await mkdir(out,{recursive:true}); await writeFile(join(out,'index.html'),'<html>fixture</html>');
`);
    const invoke = args => execute(process.execPath, ['--import', preload, packager, '--platform', 'darwin-arm64', '--cache', cache, ...args], {
      cwd: directory, env: { ...process.env, npm_execpath: npm, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    for (const version of ['18.6', '17.10', '17.11']) {
      const out = join(directory, `candidate-${version}`);
      // Omission is intentional: assert that the original default stays 18.6.
      await invoke(['--out', out, ...(version === '18.6' ? [] : ['--postgres-version', version])]);
      const resources = JSON.parse(await readFile(join(out, 'resources.json'), 'utf8'));
      const manifest = JSON.parse(await readFile(join(out, 'distribution.json'), 'utf8'));
      assert.equal(resources.postgresVersion, version);
      assert.equal(resources.postgresBin, 'resources/postgres/bin');
      const pg = manifest.resources.find(item => item.id === 'postgres');
      const expected = version === '18.6' ? catalog.postgres : catalog.postgresVersions[version];
      assert.equal(pg.version, version);
      assert.equal(pg.distributionVersion, `${version}.1`);
      assert.deepEqual(pg.license, expected.license);
      assert.equal(pg.archive.url, expected.platforms['darwin-arm64'].url);
      assert.equal(pg.archive.sha256, expected.platforms['darwin-arm64'].sha256);
      assert.equal(pg.archive.bytes, expected.platforms['darwin-arm64'].bytes);
      assert.equal(pg.archive.manifestSource, `${pg.archive.url}.manifest.json`);
      assert.equal(await readFile(join(out, 'resources/postgres/dependency-notices/NOTICE'), 'utf8'), 'fixture dependency license');
      const api = join(out, 'app/product-runtime.js');
      assert.equal(manifest.entryHashes['app/product-runtime.js'].sha256, digest(await readFile(api)));
      const metafile = JSON.parse(await readFile(join(out, 'app/metafile.json'), 'utf8'));
      assert.equal(metafile.outputs['app/product-runtime.js'].entryPoint, 'packages/product-runtime/src/index.ts');
      assertProductionGraph(metafile);
      assert.ok(manifest.application.dependencies.some(item => item.name === 'pg' && item.version === '8.16.3'));
      await assert.rejects(readFile(join(out, 'app/product-runtime.js.map')), { code: 'ENOENT' });
      // Import from outside the repository, with no workspace/node_modules
      // resolution. Exercise an actual public API without starting a service.
      const environment = join(directory, `not-created-${version}`);
      const code = `import {openProductRuntime,createProductRuntimeHost,resolveCredential,restoreProductRecovery,storage} from ${JSON.stringify(pathToFileURL(api).href)};
if(typeof createProductRuntimeHost!=='function'||typeof resolveCredential!=='function') throw Error('Missing public export');
if(typeof restoreProductRecovery!=='function'||typeof storage.provisionStorage!=='function'||typeof storage.openStorage!=='function') throw Error('Missing recovery/storage export');
const runtime=openProductRuntime({root:${JSON.stringify(environment)},resources:{nodePath:process.execPath,nodeVersion:'24.21.0',webRoot:${JSON.stringify(out)}}});
console.log(JSON.stringify(await runtime.prepare({profile:'remote'})));`;
      const result = await execute(process.execPath, ['--input-type=module', '-e', code], {
        cwd: directory, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
      });
      assert.equal(JSON.parse(result.stdout).status, 'ready');
      await assert.rejects(readdir(environment), { code: 'ENOENT' });
    }
    // A remote package omits PG regardless of the selected source version.
    const remote = join(directory, 'remote');
    await invoke(['--profile', 'remote', '--postgres-version', '17.10', '--out', remote]);
    const remoteResources = JSON.parse(await readFile(join(remote, 'resources.json'), 'utf8'));
    assert.equal(Object.hasOwn(remoteResources, 'postgresVersion'), false);
    assert.equal(Object.hasOwn(remoteResources, 'postgresBin'), false);
    assert.deepEqual(JSON.parse(await readFile(join(remote, 'distribution.json'), 'utf8')).resources.map(item => item.id), ['node']);
    const invalid = join(directory, 'invalid');
    for (const version of ['17.12', '__proto__']) {
      await assert.rejects(invoke(['--postgres-version', version, '--out', invalid]), error => {
        assert.match(error.stderr, /PostgreSQL version must be/); return true;
      });
    }
    await assert.rejects(readdir(invalid), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the bundle dependency guard rejects fixtures, unrelated modules and unbundled packages', () => {
  for (const input of ['packages/product-runtime/test/host.ts', 'packages/product-runtime/src/fixtures/sample.ts', 'packages/storage/test/host.ts', 'apps/server/server/index.ts']) {
    assert.throws(() => assertProductionGraph({ inputs: { [input]: {} }, outputs: {} }), /Non-production dependency|outside the product/);
  }
  assert.throws(() => assertProductionGraph({ inputs: {}, outputs: { api: { imports: [{ path: 'pg', external: true }] } } }), /Unbundled product dependency/);
});

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
