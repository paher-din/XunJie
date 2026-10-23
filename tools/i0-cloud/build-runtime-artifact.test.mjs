import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { buildRuntimeArtifact } from './build-runtime-artifact.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const COMMIT = '2'.repeat(40), TREE = '4'.repeat(40);

function sourceFixture(root) {
  const dist = join(root, 'apps/student/dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'),
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>循阶</title></head>'
    + '<body><div id="root"></div><script type="module" crossorigin src="/assets/index-test.js"></script></body></html>');
  writeFileSync(join(dist, 'assets', 'index-test.js'), 'export const value = ' + 'y'.repeat(512) + ';');
  writeFileSync(join(dist, 'assets', 'site.css'), '.rule { color: black; }\n'.repeat(16));
  writeFileSync(join(dist, 'assets', 'board.png'), Buffer.alloc(2048, 3));
  const teaching = join(root, 'apps/teaching');
  for (const name of ['server/main.ts', 'server/access.test.ts', 'server/tests/fixture.ts', 'contracts/access.ts',
    'contracts/__tests__/access.ts', 'runner/snapshot.ts', 'runner/test/cases.ts', 'tools/check-runtime.mjs']) {
    mkdirSync(dirname(join(teaching, name)), { recursive: true });
    writeFileSync(join(teaching, name), `export const fixture = '${name}';\n`);
  }
  writeFileSync(join(teaching, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(teaching, 'package-lock.json'), '{"lockfileVersion":3}\n');
  for (const name of ['node_modules/zod/index.js', 'node_modules/.package-lock.json', 'node_modules/better-sqlite3/prebuilds/linux-x64.node']) {
    mkdirSync(dirname(join(teaching, name)), { recursive: true });
    writeFileSync(join(teaching, name), `production dependency ${name}`);
  }
  mkdirSync(join(teaching, 'node_modules/.bin'), { recursive: true });
  symlinkSync('../zod/index.js', join(teaching, 'node_modules/.bin/zod'));
  mkdirSync(join(root, 'tools/i0-cloud'), { recursive: true });
  writeFileSync(join(root, 'tools/i0-cloud/cloud-host.mjs'), 'export const host = \'original\';\n');
  writeFileSync(join(root, 'tools/i0-cloud/build-runtime-artifact.test-helper.md'), 'not part of the runtime\n');
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
    for (const name of ['apps/teaching/server/main.ts', 'apps/teaching/contracts/access.ts', 'apps/teaching/runner/snapshot.ts',
      'apps/teaching/package.json', 'apps/teaching/package-lock.json', 'apps/teaching/tools/check-runtime.mjs',
      'apps/teaching/node_modules/zod/index.js', 'apps/teaching/node_modules/.package-lock.json',
      'apps/teaching/node_modules/better-sqlite3/prebuilds/linux-x64.node', 'tools/i0-cloud/cloud-host.mjs']) {
      assert.ok(runtimeFiles[name], `runtime file missing: ${name}`);
    }
    for (const excluded of ['apps/teaching/server/access.test.ts', 'apps/teaching/server/tests/fixture.ts',
      'apps/teaching/contracts/__tests__/access.ts', 'apps/teaching/runner/test/cases.ts',
      'tools/i0-cloud/build-runtime-artifact.mjs', 'tools/i0-cloud/build-runtime-artifact.test-helper.md',
      'apps/student/src/main.tsx']) {
      assert.equal(runtimeFiles[excluded], undefined, excluded);
    }
    assert.equal(runtimeFiles['apps/teaching/server/main.ts'], sha256(readFileSync(join(root, 'apps/teaching/server/main.ts'))));
    // Every manifest entry also records its byte size so the server can compare
    // the release shape with stat calls alone in the steady state.
    const sizeOf = files => Object.fromEntries(files.map(file => [file.path, file.bytes]));
    assert.equal(sizeOf(manifest.staticFiles)['index.html'], statSync(join(dist, 'index.html')).size);
    assert.equal(sizeOf(manifest.runtimeFiles)['apps/teaching/node_modules/zod/index.js'],
      statSync(join(root, 'apps/teaching/node_modules/zod/index.js')).size);

    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    for (const name of ['apps/student/dist/index.html', 'apps/student/dist/asset-digests.json',
      'apps/teaching/server/main.ts', 'apps/teaching/node_modules/zod/index.js', 'tools/i0-cloud/cloud-host.mjs']) {
      assert.ok(listing.includes(name), `tarball missing: ${name}`);
    }
    assert.ok(listing.every(name => name.startsWith('apps/') || name.startsWith('tools/') || name === 'apps' || name === 'tools'));
    const extracted = mkdtempSync(join(tmpdir(), 'xunjie-artifact-extract-'));
    try {
      execFileSync('tar', ['-xzf', archive, '-C', extracted]);
      assert.equal(readFileSync(join(extracted, 'apps/teaching/server/main.ts'), 'utf8'),
        readFileSync(join(root, 'apps/teaching/server/main.ts'), 'utf8'));
      assert.equal(readFileSync(join(extracted, 'apps/student/dist/assets/index-test.js.br')).toString('hex'),
        readFileSync(join(dist, 'assets/index-test.js.br')).toString('hex'));
    } finally { rmSync(extracted, { recursive: true, force: true }); }
    assert.ok(statSync(archive).size > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime artifact rejects unsupported symlinks, wrong inputs and platform mismatches', () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-artifact-reject-')), output = join(root, 'output');
  try {
    sourceFixture(root);
    symlinkSync('../server/main.ts', join(root, 'apps/teaching/server/alias.ts'));
    assert.throws(() => buildRuntimeArtifact({ source: root, output, commit: COMMIT, gitTree: TREE }), /RUNTIME_SYMLINK_UNSUPPORTED/);
    rmSync(join(root, 'apps/teaching/server/alias.ts'));

    const dist = join(root, 'apps/student/dist');
    const entry = readFileSync(join(dist, 'index.html'), 'utf8');
    writeFileSync(join(dist, 'index.html'), entry.replace('/assets/index-test.js', 'https://cdn.example/app.js'));
    assert.throws(() => buildRuntimeArtifact({ source: root, output, commit: COMMIT, gitTree: TREE }), /SINGLE_BUILT_ENTRY_REQUIRED|LOCAL_BUILT_ENTRY_REQUIRED/);
    writeFileSync(join(dist, 'index.html'), entry);

    rmSync(join(root, 'apps/teaching/contracts'), { recursive: true });
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
    writeFileSync(join(second, 'apps/student/dist/assets/index-test.js'), 'export const changed = true;\n');
    const three = buildRuntimeArtifact({ source: second, output: join(second, 'output2'), commit: COMMIT, gitTree: TREE }).manifest;
    assert.notEqual(three.staticDigests['assets/index-test.js'], one.staticDigests['assets/index-test.js']);
    assert.notEqual(three.staticSha256, one.staticSha256);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
