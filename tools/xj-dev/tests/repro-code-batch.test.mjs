import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { digest } from '../src/repro-archive.mjs';
import { collectCode, decodeBlobBatch, git, LOCK_DIGEST_ALGORITHM, lockfileDigest, restoreCode } from '../src/repro-code.mjs';

const oid = 'a'.repeat(40), other = 'b'.repeat(40);
const frame = (body, id = oid) => Buffer.concat([Buffer.from(`${id} blob ${body.length}\n`), body, Buffer.from('\n')]);
test('batch decoding preserves binary, empty and duplicate blobs and SHA-256 object IDs', () => {
  const binary = Buffer.from([0, 255, 10, 13, 128, 0]), long = 'c'.repeat(64);
  const records = [{ oid, size: binary.length }, { oid, size: binary.length }, { oid: long, size: 0 }];
  assert.deepEqual([...decodeBlobBatch(Buffer.concat([frame(binary), frame(binary), frame(Buffer.alloc(0), long)]), records)], [binary, binary, Buffer.alloc(0)]);
  assert.deepEqual([...decodeBlobBatch(Buffer.alloc(0), [])], []);
});

test('batch decoding rejects wrong IDs/types/sizes, errors, non-ASCII headers and every truncation', () => {
  const body = Buffer.from(`\0\xff\n${other} blob 3\nabc\n`, 'latin1'), valid = frame(body);
  const records = [{ oid, size: body.length }];
  for (const output of [
    frame(body, other), Buffer.from(`${oid} missing\n`), Buffer.from(`${oid} ambiguous\n`),
    Buffer.from(`${oid} tree ${body.length}\n${body}\n`),
    ...['-1', '1.5', 'NaN', 'Infinity', '9007199254740992', `0${body.length}`, String(body.length - 1), String(body.length + 1)]
      .map(size => Buffer.concat([Buffer.from(`${oid} blob ${size}\n`), body, Buffer.from('\n')])),
    Buffer.concat([valid, Buffer.from('\n')]), Buffer.concat([valid.subarray(0, -1), Buffer.from('x')]),
    Buffer.from(`${oid} blob 0\r\n\n`),
  ]) assert.throws(() => [...decodeBlobBatch(output, records)], { code: 'GIT_FAILED' });
  for (let length = 0; length < valid.length; length++) {
    assert.throws(() => [...decodeBlobBatch(valid.subarray(0, length), records)], { code: 'GIT_FAILED' });
  }
  const nonAscii = Buffer.from(frame(Buffer.alloc(0))); nonAscii[0] |= 128;
  assert.throws(() => [...decodeBlobBatch(nonAscii, [{ oid, size: 0 }])], { code: 'GIT_FAILED' });
  assert.throws(() => [...decodeBlobBatch(frame(Buffer.alloc(0)), [])], { code: 'GIT_FAILED' });
});

test('batch budgets split combined output and allow a large individual blob without allocating large fixtures', t => {
  const limit = 128 * 1024 * 1024;
  let sizes, requests;
  const mocked = t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.equal(command, 'git');
    const operation = args.slice(10);
    if (operation[0] === 'rev-parse') return { status: 0, stdout: oid + '\n' };
    if (operation[0] === 'ls-tree') return { status: 0, stdout: sizes.map((size, i) => `100644 blob ${i ? other : oid} ${size}\tfile${i}`).join('\0') + '\0' };
    assert.equal(operation[0], 'cat-file'); assert.equal(operation[1], '--batch');
    requests.push(options);
    // A process buffer/timeout error must fail even if stdout and status look OK.
    return { status: 0, error: Object.assign(new Error('fixture buffer failure'), { code: 'ENOBUFS' }), stdout: Buffer.alloc(0) };
  });
  syncBuiltinESMExports();
  try {
    sizes = [limit - 80, 1]; requests = [];
    assert.throws(() => collectCode('/unused', '/unused', { roots: ['file0', 'file1'] }), { code: 'GIT_FAILED' });
    assert.equal(requests.length, 1); assert.equal(requests[0].input, oid + '\n');
    assert.equal(requests[0].maxBuffer, limit);
    sizes = [limit + 1024]; requests = [];
    assert.throws(() => collectCode('/unused', '/unused', { roots: ['file0'] }), { code: 'GIT_FAILED' });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].maxBuffer >= sizes[0] + `${oid} blob ${sizes[0]}\n\n`.length);
  } finally {
    mocked.mock.restore(); syncBuiltinESMExports();
  }
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xj-blob-batch-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const repo = join(root, 'repo'); mkdirSync(repo); git(repo, ['init', '-q']);
  const contents = new Map([
    ['binary.dat', Buffer.from([0, 255, 10, 13, 128])], ['empty', Buffer.alloc(0)],
    ['run.sh', Buffer.from('#!/bin/sh\nexit 0\n')], ['package-lock.json', Buffer.from('{}\n')],
    ['nested/copy.dat', Buffer.from([0, 255, 10, 13, 128])],
  ]);
  for (const [path, bytes] of contents) {
    mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), bytes);
  }
  git(repo, ['add', '.']); git(repo, ['update-index', '--chmod=+x', 'run.sh']); git(repo, ['commit', '-qm', 'fixture']);
  const capture = join(root, 'capture'); mkdirSync(capture);
  const code = collectCode(repo, capture, { roots: [...contents.keys()] });
  const bundle = join(root, 'code.bundle'); writeFileSync(bundle, code.bytes);
  return { root, repo, contents, code, bundle };
}

test('fixture restores all blobs in one batch with exact bytes, modes and lock checks', t => {
  const { root, repo, contents, code, bundle } = fixture(t);
  for (const [path, bytes] of contents) assert.deepEqual(code.sourceFiles.get(path), bytes);
  const scratch = join(root, 'restore'), target = join(root, 'target'), trace = join(root, 'git.trace'); mkdirSync(scratch);
  const previous = process.env.GIT_TRACE;
  try {
    process.env.GIT_TRACE = trace;
    restoreCode(repo, bundle, code.manifest, scratch, target, {
      lockfileDigestAlgorithm: LOCK_DIGEST_ALGORITHM,
      lockfiles: { 'package-lock.json': lockfileDigest(contents.get('package-lock.json')) },
    });
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = previous;
  }
  const calls = readFileSync(trace, 'utf8').split('\n').filter(line => line.includes('built-in: git cat-file'));
  assert.equal(calls.length, 1, calls.join('\n')); assert.match(calls[0], /cat-file --batch$/);
  for (const [path, bytes] of contents) assert.deepEqual(readFileSync(join(target, path)), bytes);
  if (process.platform !== 'win32') assert.equal(lstatSync(join(target, 'run.sh')).mode & 0o777, 0o755);
  git(repo, ['worktree', 'remove', '--force', target]);
});

test('batch restore retains manifest and lock guards before publishing a target', t => {
  const { root, repo, code, bundle } = fixture(t), target = join(root, 'target');
  const before = git(repo, ['worktree', 'list', '--porcelain']);
  const mutations = [
    [metadata => { metadata.files[0].digest = digest('wrong'); }, 'CODE_DIGEST_MISMATCH'],
    [metadata => { metadata.files[0].bytes++; }, 'CODE_DIGEST_MISMATCH'],
    [metadata => { metadata.files[0].mode = '120000'; }, 'UNSAFE_PATH'],
    [metadata => { metadata.files.pop(); }, 'CODE_DIGEST_MISMATCH'],
  ];
  for (const [mutate, error] of mutations) {
    const metadata = structuredClone(code.manifest); mutate(metadata);
    const scratch = join(root, `reject-${error}-${metadata.files[0].bytes}-${metadata.files.length}-${metadata.files[0].mode}`); mkdirSync(scratch);
    assert.throws(() => restoreCode(repo, bundle, metadata, scratch, target), { code: error });
    assert.equal(existsSync(target), false);
  }
  const scratch = join(root, 'wrong-lock'); mkdirSync(scratch);
  assert.throws(() => restoreCode(repo, bundle, code.manifest, scratch, target, {
    lockfileDigestAlgorithm: LOCK_DIGEST_ALGORITHM, lockfiles: { 'package-lock.json': digest('wrong') },
  }), { code: 'LOCKFILE_MISMATCH' });
  assert.equal(existsSync(target), false);
  assert.equal(git(repo, ['worktree', 'list', '--porcelain']), before);
});
