import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { buildRuntimeArtifact } from './build-runtime-artifact.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const COMMIT = '2'.repeat(40), TREE = '4'.repeat(40);

function sourceFixture(root) {
  const dist = join(root, 'apps/web/dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'),
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>循阶</title></head>'
    + '<body><div id="root"></div><script type="module" crossorigin src="/assets/index-test.js"></script></body></html>');
  writeFileSync(join(dist, 'assets', 'index-test.js'), 'export const value = ' + 'y'.repeat(512) + ';');
  writeFileSync(join(dist, 'assets', 'site.css'), '.rule { color: black; }\n'.repeat(16));
  writeFileSync(join(dist, 'assets', 'board.png'), Buffer.alloc(2048, 3));
  const teaching = join(root, 'apps/server');
  for (const name of ['dist/server/main.js', 'dist/server/access.test.js', 'dist/server/tests/fixture.js', 'dist/contracts/access.js',
    'dist/contracts/__tests__/access.js', 'dist/runner/snapshot.js', 'dist/runner/test/cases.js',
    'dist/server/app/i0-browser-runner.js', 'dist/server/app/i0-browser-fixture.js', 'dist/server/workspace/test-child.js',
    'dist/runner/acceptance.js', 'dist/runner/hdl-acceptance.js', 'dist/runner/record-validation.js',
    'dist/server/design/design-support.js', 'dist/server/fixtures/sample.js', 'tools/check-runtime.mjs']) {
    mkdirSync(dirname(join(teaching, name)), { recursive: true });
    writeFileSync(join(teaching, name), `export const fixture = '${name}';\n`);
  }
  writeFileSync(join(teaching, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  for (const name of ['node_modules/zod/index.js', 'node_modules/.package-lock.json', 'node_modules/better-sqlite3/prebuilds/linux-x64.node']) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), `production dependency ${name}`);
  }
  writeFileSync(join(root, 'node_modules/.package-lock.json'), JSON.stringify({packages:{'node_modules/zod':{version:'1.0.0'}}}));
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync('../zod/index.js', join(root, 'node_modules/.bin/zod'));
  mkdirSync(join(root, 'packages/contracts/dist'), { recursive: true });
  writeFileSync(join(root, 'packages/contracts/package.json'), JSON.stringify({name:'@xunjie/contracts',type:'module',exports:'./dist/index.js'}));
  writeFileSync(join(root, 'packages/contracts/dist/index.js'), 'export const contract = true;');
  mkdirSync(join(root, 'packages/storage/dist/tests'), { recursive: true });
  writeFileSync(join(root, 'packages/storage/package.json'), JSON.stringify({name:'@xunjie/storage',type:'module',exports:'./dist/index.js'}));
  writeFileSync(join(root, 'packages/storage/dist/index.js'), 'export const storageFixture = true;');
  writeFileSync(join(root, 'packages/storage/dist/tests/not-shipped.js'), 'throw new Error("test-only");');
  writeFileSync(join(teaching, 'dist/server/main.js'), 'export {storageFixture} from "@xunjie/storage";');
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
  mkdirSync(join(root, 'node_modules/@xunjie'), { recursive: true });
  symlinkSync('../../packages/contracts', join(root, 'node_modules/@xunjie/contracts'));
  symlinkSync('../../packages/storage', join(root, 'node_modules/@xunjie/storage'));
  symlinkSync('../../apps/server', join(root, 'node_modules/@xunjie/server'));
  mkdirSync(join(root, 'tools/i0-cloud'), { recursive: true });
  writeFileSync(join(root, 'tools/i0-cloud/cloud-host.mjs'), 'export const host = \'original\';\n');
  writeFileSync(join(root, 'tools/i0-cloud/build-runtime-artifact.test-helper.md'), 'not part of the runtime\n');
  for (const file of ['tools/xj-dev/src/enrollment-protocol.mjs', 'tools/xj-dev-access/server.mjs', 'tools/xj-dev-access/application-adapter.mjs', 'tools/xj-dev-access/access.test.mjs']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'export const fixture = true;\n');
  }
  return dist;
}

function entryMap(files) {
  return Object.fromEntries(files.map(file => [file.path, file.sha256]));
}

test('runtime artifact carries per-file digests, pre-compressed static outputs and a digest map', () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-artifact-build-')), output = join(root, 'output');
  try {
    const dist = sourceFixture(root);
    const { manifest, archive } = buildRuntimeArtifact({ source: root, output, commit: COMMIT, gitTree: TREE });
    assert.equal(manifest.format, 'xunjie-runtime-artifact');
    assert.equal(manifest.commit, COMMIT);
    assert.equal(manifest.gitTree, TREE);
    assert.equal(manifest.platform, `${process.platform}-${process.arch}`);
    assert.match(manifest.nodeVersion, /^v\d+\.\d+\.\d+$/);
    assert.equal(manifest.entryJs, '/assets/index-test.js');
    assert.equal(manifest.entryJsSha256, sha256(readFileSync(join(dist, 'assets/index-test.js'))));
    assert.equal(manifest.indexSha256, sha256(readFileSync(join(dist, 'index.html'))));
    assert.equal(manifest.artifactSha256, sha256(readFileSync(archive)));

    const staticFiles = entryMap(manifest.staticFiles);
    for (const name of ['index.html', 'assets/index-test.js', 'assets/site.css', 'assets/board.png',
      'assets/index-test.js.br', 'assets/index-test.js.gz', 'assets/site.css.br', 'assets/site.css.gz',
      'index.html.br', 'index.html.gz', 'asset-digests.json']) {
      assert.ok(staticFiles[name], `static file missing: ${name}`);
    }
    assert.equal(staticFiles['assets/board.png'], sha256(readFileSync(join(dist, 'assets/board.png'))));
    // The pre-compressed sidecars must be smaller than the identity file they replace.
    assert.ok(statSync(join(dist, 'assets/index-test.js.br')).size < statSync(join(dist, 'assets/index-test.js')).size);
    // The digest map matches the identity files it names and never maps itself.
    const map = JSON.parse(readFileSync(join(dist, 'asset-digests.json'), 'utf8'));
    assert.equal(map['assets/index-test.js'], staticFiles['assets/index-test.js']);
    assert.equal(map['index.html'], staticFiles['index.html']);
    assert.equal(map['asset-digests.json'], undefined);
    assert.deepEqual(map, manifest.staticDigests);

    const runtimeFiles = entryMap(manifest.runtimeFiles);
    for (const name of ['apps/server/dist/server/main.js', 'apps/server/dist/contracts/access.js', 'apps/server/dist/runner/snapshot.js',
      'apps/server/package.json', 'package-lock.json', 'node_modules/@xunjie/contracts/dist/index.js',
      'node_modules/@xunjie/storage/dist/index.js', 'node_modules/@xunjie/storage/package.json',
      'node_modules/zod/index.js', 'node_modules/.package-lock.json',
      'node_modules/better-sqlite3/prebuilds/linux-x64.node', 'tools/i0-cloud/cloud-host.mjs']) {
      assert.ok(runtimeFiles[name], `runtime file missing: ${name}`);
    }
    for (const excluded of ['apps/server/dist/server/access.test.js', 'apps/server/dist/server/tests/fixture.js',
      'apps/server/dist/contracts/__tests__/access.js', 'apps/server/dist/runner/test/cases.js',
      'tools/i0-cloud/build-runtime-artifact.mjs', 'tools/i0-cloud/build-runtime-artifact.test-helper.md',
      'apps/server/tools/xj-dev-access/access.test.mjs',
      'apps/server/tools/xj-dev-access/server.mjs', 'apps/server/tools/xj-dev/src/enrollment-protocol.mjs',
      'tools/xj-dev-access/server.mjs', 'tools/xj-dev/src/enrollment-protocol.mjs',
      'apps/web/src/main.tsx']) {
      assert.equal(runtimeFiles[excluded], undefined, excluded);
    }
    assert.equal(runtimeFiles['apps/server/dist/server/main.js'], sha256(readFileSync(join(root, 'apps/server/dist/server/main.js'))));
    assert.equal(manifest.runtimeFiles.some(file => file.path.includes('xj-dev')), false, 'standard product runtime excludes development facilities');
    // Every manifest entry also records its byte size so the server can compare
    // the release shape with stat calls alone in the steady state.
    const sizeOf = files => Object.fromEntries(files.map(file => [file.path, file.bytes]));
    assert.equal(sizeOf(manifest.staticFiles)['index.html'], statSync(join(dist, 'index.html')).size);
    assert.equal(sizeOf(manifest.runtimeFiles)['node_modules/zod/index.js'],
      statSync(join(root, 'node_modules/zod/index.js')).size);

    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    for (const name of ['apps/web/dist/index.html', 'apps/web/dist/asset-digests.json',
      'apps/server/dist/server/main.js', 'node_modules/zod/index.js', 'tools/i0-cloud/cloud-host.mjs']) {
      assert.ok(listing.includes(name), `tarball missing: ${name}`);
    }
    assert.ok(listing.includes('node_modules/@xunjie/contracts/dist/index.js'));
    assert.equal(runtimeFiles['node_modules/@xunjie/server/package.json'], undefined);
    for (const excluded of ['dist/server/app/i0-browser-runner.js', 'dist/server/app/i0-browser-fixture.js',
      'dist/server/workspace/test-child.js', 'dist/runner/acceptance.js', 'dist/runner/hdl-acceptance.js',
      'dist/runner/record-validation.js', 'dist/server/design/design-support.js', 'dist/server/fixtures/sample.js']) {
      assert.equal(runtimeFiles['apps/server/' + excluded], undefined, excluded);
    }
    const extracted = mkdtempSync(join(tmpdir(), 'xunjie-artifact-extract-'));
    try {
      execFileSync('tar', ['-xzf', archive, '-C', extracted]);
      assert.equal(readFileSync(join(extracted, 'apps/server/dist/server/main.js'), 'utf8'),
        readFileSync(join(root, 'apps/server/dist/server/main.js'), 'utf8'));
      assert.equal(readFileSync(join(extracted, 'apps/web/dist/assets/index-test.js.br')).toString('hex'),
        readFileSync(join(dist, 'assets/index-test.js.br')).toString('hex'));
      const consumer = spawnSync(process.execPath, ['--input-type=module', '-e',
        'const module=await import(process.argv[1]);process.stdout.write(String(module.storageFixture));',
        pathToFileURL(join(extracted, 'apps/server/dist/server/main.js')).href], {encoding:'utf8'});
      assert.equal(consumer.status,0,consumer.stderr);
      assert.equal(consumer.stdout,'true');
      assert.equal(runtimeFiles['node_modules/@xunjie/storage/dist/tests/not-shipped.js'],undefined);
    } finally { rmSync(extracted, { recursive: true, force: true }); }
    assert.ok(statSync(archive).size > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime artifact rejects unsupported symlinks, wrong inputs and platform mismatches', () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-artifact-reject-')), output = join(root, 'output');
  try {
    sourceFixture(root);
    symlinkSync('./main.js', join(root, 'apps/server/dist/server/alias.js'));
    assert.throws(() => buildRuntimeArtifact({ source: root, output, commit: COMMIT, gitTree: TREE }), /RUNTIME_SYMLINK_UNSUPPORTED/);
    rmSync(join(root, 'apps/server/dist/server/alias.js'));

    const dist = join(root, 'apps/web/dist');
    const entry = readFileSync(join(dist, 'index.html'), 'utf8');
    writeFileSync(join(dist, 'index.html'), entry.replace('/assets/index-test.js', 'https://cdn.example/app.js'));
    assert.throws(() => buildRuntimeArtifact({ source: root, output, commit: COMMIT, gitTree: TREE }), /SINGLE_BUILT_ENTRY_REQUIRED|LOCAL_BUILT_ENTRY_REQUIRED/);
    writeFileSync(join(dist, 'index.html'), entry);

    rmSync(join(root, 'apps/server/dist'), { recursive: true });
    assert.throws(() => buildRuntimeArtifact({ source: root, output, commit: COMMIT, gitTree: TREE }), /RUNTIME_INPUT_REQUIRED/);

    assert.throws(() => buildRuntimeArtifact({ source: root, output, commit: COMMIT, gitTree: TREE, expectedPlatform: 'other-platform' }), /PLATFORM_MISMATCH/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the CLI reports a summary and fails with usage on bad arguments', () => {
  const script = join(import.meta.dirname, 'build-runtime-artifact.mjs');
  const bad = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Usage: node tools\/i0-cloud\/build-runtime-artifact\.mjs/);
  const badCommit = spawnSync(process.execPath, [script, '--source', '.', '--output', 'out', '--commit', 'short', '--git-tree', TREE], { encoding: 'utf8' });
  assert.equal(badCommit.status, 2);
  assert.match(badCommit.stderr, /COMMIT_REQUIRED/);

  const root = mkdtempSync(join(tmpdir(), 'xunjie-artifact-cli-'));
  try {
    sourceFixture(root);
    const output = join(root, 'output');
    const result = spawnSync(process.execPath, [script, '--source', root, '--output', output,
      '--commit', COMMIT, '--git-tree', TREE, '--expected-platform', `${process.platform}-${process.arch}`,
      '--expected-node-version', process.version], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'built');
    assert.equal(summary.commit, COMMIT);
    assert.equal(summary.artifactSha256, sha256(readFileSync(join(output, 'runtime.tar.gz'))));
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.runtimeFiles.length, summary.runtimeFiles);
    assert.equal(manifest.staticFiles.length, summary.staticFiles);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('manifest aggregates stay stable across repeated builds of the same inputs', () => {
  const first = mkdtempSync(join(tmpdir(), 'xunjie-artifact-stable-1-')), second = mkdtempSync(join(tmpdir(), 'xunjie-artifact-stable-2-'));
  try {
    sourceFixture(first);
    sourceFixture(second);
    const one = buildRuntimeArtifact({ source: first, output: join(first, 'output'), commit: COMMIT, gitTree: TREE }).manifest;
    const two = buildRuntimeArtifact({ source: second, output: join(second, 'output'), commit: COMMIT, gitTree: TREE }).manifest;
    assert.equal(one.runtimeSha256, two.runtimeSha256);
    assert.equal(one.staticSha256, two.staticSha256);
    assert.deepEqual(one.staticDigests, two.staticDigests);
    assert.deepEqual(entryMap(one.runtimeFiles), entryMap(two.runtimeFiles));
    assert.deepEqual(entryMap(one.staticFiles), entryMap(two.staticFiles));
    // A rebuilt bundle must change its digest and therefore its immutable URL.
    writeFileSync(join(second, 'apps/web/dist/assets/index-test.js'), 'export const changed = true;\n');
    const three = buildRuntimeArtifact({ source: second, output: join(second, 'output2'), commit: COMMIT, gitTree: TREE }).manifest;
    assert.notEqual(three.staticDigests['assets/index-test.js'], one.staticDigests['assets/index-test.js']);
    assert.notEqual(three.staticSha256, one.staticSha256);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
