// Create a self-contained local release candidate from verified equal builds.
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { resourceNames, adapterNames, bundleIdentity, compilerConfiguration } from './runtime/identity.mjs';

const [buildA, buildB, sourceRepo, destination, sdkRoot] = process.argv.slice(2);
if (!sdkRoot) throw new Error('usage: node pack.mjs <build-a> <build-b> <icarus-repo> <new-output> <emsdk-dir>');
try { await stat(destination); throw new Error('Output must be a new directory'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const lock = JSON.parse(await readFile('tools/alu-wasm/toolchain.lock.json', 'utf8'));
const assets = {}, files = {};
for (const name of resourceNames) {
  const a = await readFile(resolve(buildA, name)), b = await readFile(resolve(buildB, name));
  assert.deepEqual(a, b, `Clean build mismatch: ${name}`);
  assets[name] = { bytes: a.length, sha256: createHash('sha256').update(a).digest('hex') };
}
const archive = spawnSync('git', ['-C', resolve(sourceRepo), 'archive', lock.icarus.commit], { maxBuffer: 64 * 1024 * 1024 });
if (archive.status !== 0) throw new Error(String(archive.stderr));
await mkdir(resolve(destination, 'source'), { recursive: true });
const notices = [
  ['LICENSE', 'Emscripten-LICENSE'], ['AUTHORS', 'Emscripten-AUTHORS'],
  ['system/lib/libcxx/LICENSE.TXT', 'libcxx-LICENSE'], ['system/lib/libcxxabi/LICENSE.TXT', 'libcxxabi-LICENSE'],
  ['system/lib/compiler-rt/LICENSE.TXT', 'compiler-rt-LICENSE'], ['system/lib/libc/musl/COPYRIGHT', 'musl-COPYRIGHT'],
];
await mkdir(resolve(destination, 'notices'));
for (const [source, target] of notices) await copyFile(resolve(sdkRoot, 'upstream/emscripten', source), resolve(destination, 'notices', target));
for (const name of resourceNames) await copyFile(resolve(buildA, name), resolve(destination, name));
await writeFile(resolve(destination, 'checksums.txt'), resourceNames.map(name => `${assets[name].sha256}  ${name}\n`).join(''));
for (const name of ['index.mjs', 'worker.mjs', 'identity.mjs', 'index.d.mts']) await copyFile(resolve('tools/alu-wasm/runtime', name), resolve(destination, name));
for (const name of ['port.py', 'build-port.sh', 'doctor.sh', 'rebuild.sh', 'verify-sdk.py', 'toolchain.lock.json', 'ubuntu-packages.lock']) {
  await copyFile(resolve('tools/alu-wasm', name), resolve(destination, 'source', name));
}
await writeFile(resolve(destination, 'source/README.md'), `# Corresponding Icarus source and build instructions

This directory contains the exact upstream source archive, explicit port and
fixed toolchain/environment identities used for this candidate. Icarus source
notices and COPYING.icarus govern the upstream code; retain these on distribution.

On the recorded Ubuntu environment, prepare the Emsdk commit/version in
toolchain.lock.json. Run doctor.sh and compare ubuntu-packages.lock with
LC_ALL=C dpkg-query -W. Do not substitute a rolling SDK.

Extract iverilog.tar.gz into a new empty directory, run:

    python3 port.py /absolute/clean-source
    bash build-port.sh /absolute/clean-source /absolute/emsdk /absolute/new-output

Repeat in a second empty source directory with the same environment. All six
resource digests must match. SOURCE_DATE_EPOCH=0, UTC, C locale, fixed /runtime
installation prefix and optimization flags are set by build-port.sh.

rebuild.sh is the equivalent two-directory gate when the original pinned Git
repository is available. The archive above is sufficient to build without Git.
The XunJie adapter's source modules are supplied alongside the runtime assets.
Mac validation and product integration are not claimed by this candidate.
`);
const license = spawnSync('git', ['-C', resolve(sourceRepo), 'show', `${lock.icarus.commit}:COPYING`], { maxBuffer: 1024 * 1024 });
if (license.status !== 0) throw new Error('Missing upstream license');
await writeFile(resolve(destination, 'COPYING.icarus'), license.stdout);
await writeFile(resolve(destination, 'source/iverilog.tar.gz'), gzipSync(archive.stdout, { level: 9 }));
for (const name of [...resourceNames, 'checksums.txt', 'index.mjs', 'worker.mjs', 'identity.mjs', 'index.d.mts', 'COPYING.icarus', ...notices.map(([, target]) => 'notices/' + target),
  ...['port.py', 'build-port.sh', 'doctor.sh', 'rebuild.sh', 'verify-sdk.py', 'toolchain.lock.json', 'ubuntu-packages.lock', 'README.md', 'iverilog.tar.gz'].map(name => 'source/' + name)]) {
  const bytes = await readFile(resolve(destination, name));
  files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const adapters = Object.fromEntries(adapterNames.map(name => [name, files[name]]));
const manifest = { formatVersion: 1, name: 'xunjie-icarus-worker', version: '0.1.0',
  identity: await bundleIdentity(assets, adapters), assets, adapters, files, toolchain: lock,
  compilerConfiguration, license: { icarus: 'See COPYING.icarus and corresponding source notices',
    correspondingSource: 'source/iverilog.tar.gz', modifications: 'source/port.py', bundledRuntimeNotices: 'notices/' },
  limits: { files: 64, fixedFileBytes: 1048576, textOutputBytes: 2097152, generatedFileBytes: 8388608,
    totalFileExtentBytesPerModule: 16777216, moduleMemoryBytes: 268435456, parallelWorkersPerModuleRealm: 1, maxWallTimeMs: 60000, cacheEntries: 8, cacheBytes: 33554432 },
  scope: 'Runtime package only; Windows desktop Chrome validated, Apple Silicon Mac deferred; no product integration or teaching claim' };
await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ directory: resolve(destination), identity: manifest.identity, files: Object.keys(files).length }));
