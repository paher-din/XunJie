import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ARCHIVE_LIMITS, decodeZip, digest, encodeZip, jsonBytes, safeEntry } from '../src/repro-archive.mjs';
import { assertShareable, collectCode, git, restoreCode, validateCodePaths } from '../src/repro-code.mjs';
import { inspectRepro, lockfileDigest } from '../src/repro.mjs';

const worktree = resolve(import.meta.dirname, '../../..');
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'xj-repro-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}
test('ZIP roundtrip is deterministic and rejects traversal, symlinks, truncation, bombs and name collisions', () => {
  const entries = new Map([['manifest.json', jsonBytes({ version: 1 })], ['data/example', Buffer.from('payload')]]);
  const zip = encodeZip(entries);
  assert.deepEqual(decodeZip(zip), new Map([...entries].sort(([a], [b]) => a.localeCompare(b, 'en'))));
  assert.deepEqual(encodeZip(entries), zip);
  for (const path of ['../evil', '/absolute', 'C:/evil', 'a\\b', 'x/./y', 'x//y', 'NUL.txt', 'a.']) assert.throws(() => safeEntry(path), { code: 'UNSAFE_PATH' });
  assert.throws(() => encodeZip(new Map([['a', Buffer.alloc(0)], ['A', Buffer.alloc(0)]])), { code: 'UNSAFE_PATH' });
  assert.throws(() => decodeZip(zip.subarray(0, zip.length - 1)), { code: 'INVALID_ZIP' });
  const corrupted = Buffer.from(zip); corrupted[40] ^= 1;
  assert.throws(() => decodeZip(corrupted));
  const link = Buffer.from(zip), central = link.readUInt32LE(link.length - 6);
  link.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  assert.throws(() => decodeZip(link), { code: 'INVALID_ZIP' });
  const bomb = Buffer.from(zip); bomb.writeUInt32LE(ARCHIVE_LIMITS.entry + 1, central + 24);
  assert.throws(() => decodeZip(bomb), { code: 'INVALID_ZIP' });
  assert.throws(() => decodeZip(encodeZip(new Map([['a', Buffer.alloc(0)], ['a/b', Buffer.alloc(0)]]))), { code: 'UNSAFE_PATH' });
});

test('explicit invalid fixtures pass while credentials and private keys fail closed', () => {
  for (const value of ['synthetic-teacher-password', 'synthetic-key', 'offline-test-key', 'prep-only-not-a-real-credential']) assert.doesNotThrow(() => assertShareable(['pass', 'word: ', "'", value, "'"].join('')));
  const secret = ['sk', 'a'.repeat(30)].join('-');
  assert.throws(() => assertShareable(secret), { code: 'SECRET_DETECTED' });
  assert.throws(() => assertShareable(['pass', 'word: ', JSON.stringify('actual-value-for-a-service')].join('')), { code: 'SECRET_DETECTED' });
  assert.throws(() => assertShareable(['-----BEGIN ', 'OPENSSH PRIVATE KEY-----'].join('')), { code: 'SECRET_DETECTED' });
});

test('lock conditions normalize only CRLF while source paths reject casefold and directory collisions', () => {
  const lf = Buffer.from('{\n  "version": "1"\n}\n'), crlf = Buffer.from(lf.toString().replace(/\n/g, '\r\n'));
  assert.equal(lockfileDigest(lf), lockfileDigest(crlf));
  assert.notEqual(digest(lf), digest(crlf));
  assert.notEqual(lockfileDigest(lf), lockfileDigest(Buffer.from('{\n  "version": "2"\n}\n')));
  for (const paths of [['File.ts', 'file.ts'], ['A', 'a/b.ts'], ['.GIT/config']]) assert.throws(() => validateCodePaths(paths), { code: 'UNSAFE_PATH' });
});

test('real repository default roots can produce a portable bundle (including existing synthetic fixtures)', t => {
  const root = scratch(t);
  const code = collectCode(worktree, root);
  assert.ok(code.manifest.files.length > 500);
  assert.ok(code.bytes.length > 0);
  assert.ok(code.manifest.files.some(f => f.path === 'apps/teaching/tests/application-database.test.ts'));
  assert.ok(code.manifest.files.every(f => !f.path.startsWith('docs/archive/')));
  const imported = join(root, 'import'); mkdirSync(imported);
  git(imported, ['init', '-q']);
  const bundle = join(root, 'transfer.bundle'); writeFileSync(bundle, code.bytes);
  git(imported, ['fetch', bundle, 'refs/heads/repro-snapshot']);
  assert.equal(git(imported, ['rev-parse', 'FETCH_HEAD']).trim(), code.manifest.exportedCommit);
});

test('unpublished committed bytes, selected dirty/untracked source transfer; unrelated changes and history do not', t => {
  const root = scratch(t), repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'app.mjs'), 'export const value = 1;\n');
  writeFileSync(join(repo, 'other.mjs'), 'export const original = true;\n');
  mkdirSync(join(repo, 'docs/archive'), { recursive: true }); writeFileSync(join(repo, 'docs/archive/old'), 'do not export');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'unpublished']);
  const originalCommit = git(repo, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(repo, 'app.mjs'), 'export const value = 2;\n');
  writeFileSync(join(repo, 'other.mjs'), 'UNRELATED_CHANGE');
  writeFileSync(join(repo, 'selected.mjs'), 'export const selected = true;\n');
  writeFileSync(join(repo, 'unrelated.mjs'), 'UNRELATED_UNTRACKED');
  const code = collectCode(repo, root, { roots: ['app.mjs', 'other.mjs', 'selected.mjs'], paths: ['app.mjs', 'selected.mjs'] });
  assert.equal(code.manifest.sourceCommit, originalCommit);
  assert.ok(code.manifest.files.some(f => f.path === 'selected.mjs'));
  assert.ok(!code.manifest.files.some(f => /archive|unrelated/.test(f.path)));
  const bundle = join(root, 'transfer.bundle'); writeFileSync(bundle, code.bytes);
  const imported = join(root, 'import'); mkdirSync(imported); git(imported, ['init', '-q']); git(imported, ['fetch', bundle, 'refs/heads/repro-snapshot']);
  assert.equal(git(imported, ['show', 'FETCH_HEAD:app.mjs']).trim(), 'export const value = 2;');
  assert.equal(git(imported, ['show', 'FETCH_HEAD:other.mjs']).trim(), 'export const original = true;');
  assert.equal(git(imported, ['rev-list', '--count', 'FETCH_HEAD']).trim(), '1', 'history is deliberately not shared');
  symlinkSync(join(repo, 'app.mjs'), join(repo, 'link.mjs'));
  assert.throws(() => collectCode(repo, join(root, 'another'), { roots: ['link.mjs'], paths: ['link.mjs'] }), { code: 'UNSAFE_PATH' });
});

test('inspection detects wrong whole digest, unsupported version and a missing required resource', t => {
  const root = scratch(t), file = join(root, 'invalid.zip');
  writeFileSync(file, Buffer.from('not zip'));
  assert.throws(() => inspectRepro(file, { expectedDigest: digest('different') }), { code: 'DIGEST_MISMATCH' });
  const entries = new Map([['manifest.json', jsonBytes({ formatVersion: 'future/2' })], ['checksums.json', jsonBytes({})]]);
  writeFileSync(file, encodeZip(entries));
  assert.throws(() => inspectRepro(file), { code: 'FORMAT_MISMATCH' });
  entries.delete('manifest.json'); writeFileSync(file, encodeZip(entries));
  assert.throws(() => inspectRepro(file), { code: 'RESOURCE_MISSING' });
});

test('bundle path conflicts are rejected before worktree registration; restore invokes no checkout hooks or package scripts', t => {
  const root = scratch(t), repo = join(root, 'repo'); mkdirSync(repo); git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'source.mjs'), 'export const ready = true;\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base']);
  const marker = join(root, 'unexpected-hook');
  writeFileSync(join(repo, '.git/hooks/post-checkout'), `#!/bin/sh\necho ran > '${marker.replaceAll("'", "'\\''")}'\n`, { mode: 0o755 });
  const sourceScratch = join(root, 'capture'); mkdirSync(sourceScratch);
  const source = collectCode(repo, sourceScratch, { roots: ['source.mjs'] });
  const file = join(root, 'source.bundle'); writeFileSync(file, source.bytes);
  const restoreScratch = join(root, 'restore'); mkdirSync(restoreScratch);
  const target = join(root, 'target');
  restoreCode(repo, file, source.manifest, restoreScratch, target);
  assert.equal(readFileSync(join(target, 'source.mjs'), 'utf8'), 'export const ready = true;\n');
  assert.equal(existsSync(marker), false);
  git(repo, ['worktree', 'remove', '--force', target]);

  const evil = join(root, 'evil.git'); mkdirSync(evil); git(evil, ['init', '--bare', '-q']);
  const oid = git(evil, ['hash-object', '-w', '--stdin'], { input: 'content' }).trim();
  const tree = git(evil, ['mktree'], { input: `100644 blob ${oid}\tA\n100644 blob ${oid}\ta\n` }).trim();
  const commit = git(evil, ['commit-tree', tree, '-m', 'case collision']).trim();
  git(evil, ['update-ref', 'refs/heads/repro-snapshot', commit]);
  const badBundle = join(root, 'evil.bundle'); git(evil, ['bundle', 'create', badBundle, 'refs/heads/repro-snapshot']);
  const badScratch = join(root, 'bad-restore'); mkdirSync(badScratch);
  const before = git(repo, ['worktree', 'list', '--porcelain']);
  assert.throws(() => restoreCode(repo, badBundle, { exportedCommit: commit, files: ['A', 'a'].map(path => ({ path, mode: '100644', bytes: 7, digest: digest('content') })) }, badScratch, target), { code: 'UNSAFE_PATH' });
  assert.equal(existsSync(target), false);
  assert.equal(git(repo, ['worktree', 'list', '--porcelain']), before);
});
