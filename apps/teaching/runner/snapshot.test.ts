import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compilerArgs, manifestHash, RunnerError, sha256, validatePath, validateSnapshot } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';

function snapshot(text = 'int main(void) { return 0; }', path = 'main.c'): Snapshot {
  const files = [{ fileId: 'file-1', path, documentVersion: 1, text, contentHash: sha256(text) }];
  return { snapshotId: 'snapshot-1', hashFormat: 'sha256-manifest-v1', hash: manifestHash(files), files };
}

test('hashes exact UTF-8 content and byte-sorted compact manifests', () => {
  const value = snapshot('中文\r\n🙂\n');
  value.files.push({ ...value.files[0]!, fileId: 'file-2', path: 'z.txt' });
  value.hash = manifestHash(value.files);
  validateSnapshot(value);
  assert.equal(value.hash, manifestHash([...value.files].reverse()));
  assert.notEqual(sha256('a\n'), sha256('a\r\n'));
});

test('rejects traversal, absolute, drive, UNC, backslash, NUL and empty components', () => {
  for (const path of ['/main.c', 'C:main.c', 'C:/main.c', '\\\\host\\main.c', 'a\\b.c',
    '..', 'a/../b.c', './main.c', '', 'a//b.c', 'a/', 'a\0b']) {
    assert.throws(() => validatePath(path), RunnerError, path);
  }
  validatePath('src/中文.c');
});

test('rejects stale body and manifest hashes and duplicate file identities', () => {
  const value = snapshot();
  value.files[0]!.text += '\n';
  assert.throws(() => validateSnapshot(value), /content hash mismatch/);
  const duplicate = snapshot();
  duplicate.files.push({ ...duplicate.files[0]! });
  assert.throws(() => validateSnapshot(duplicate), /Duplicate/);
  const changedPath = snapshot();
  changedPath.files[0]!.path = 'other.c';
  assert.throws(() => validateSnapshot(changedPath), /manifest hash mismatch/);
});

test('enforces file count and UTF-8 byte budget including multibyte text', () => {
  const value = snapshot('a'.repeat(1024 * 1024));
  validateSnapshot(value);
  assert.throws(() => validateSnapshot(snapshot('a'.repeat(1024 * 1024 + 1))), /1 MiB/);
  assert.throws(() => validateSnapshot(snapshot('中'.repeat(400000))), /1 MiB/);
  const many = snapshot();
  many.files = Array.from({ length: 51 }, (_, i) => ({ ...many.files[0]!, fileId: `f${i}`, path: `f${i}.c` }));
  many.hash = manifestHash(many.files);
  assert.throws(() => validateSnapshot(many), /Too many/);
});

test('builds fixed compiler argv only from approved C sources', () => {
  const value = snapshot('int main(void) { return 0; }', '-fplugin=evil.c');
  value.files.push({ ...value.files[0]!, fileId: 'file-2', path: 'Makefile', text: 'all: echo bad', contentHash: sha256('all: echo bad') });
  value.hash = manifestHash(value.files);
  const args = compilerArgs(value, 'file-1');
  assert(args.includes('/snapshot/-fplugin=evil.c'));
  assert(!args.some(arg => arg.includes('Makefile')));
  assert(!args.includes('-Werror'));
  assert.deepEqual(args.slice(0, 6), ['-std=c17', '-O0', '-Wall', '-Wextra', '-pedantic', '-static']);
  assert.throws(() => compilerArgs(value, 'file-2'), /Entry/);
});

test('rejects malformed input at the runtime boundary', () => {
  for (const value of [null, [], {}, { files: [] }, { ...snapshot(), files: [null] }]) {
    assert.throws(() => validateSnapshot(value), RunnerError);
  }
});
