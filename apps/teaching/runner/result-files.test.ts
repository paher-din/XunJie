import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectResultFiles } from './result-files.ts';
import { sha256 } from './snapshot.ts';

// Test-created files are retained because this workspace requires explicit deletion authorization.
test('returns bound content facts, distinguishes missing and unsafe files', () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-results-'));
  writeFileSync(join(root, 'report.txt'), 'TOTAL\t4\t11\t51\n');
  mkdirSync(join(root, 'directory'));
  const [report, missing, directory] = collectResultFiles(root, ['report.txt', 'missing.txt', 'directory'], 65536, true);
  assert(report && missing && directory);
  assert.equal(report.status, 'complete');
  assert.equal(report.contentHash, sha256('TOTAL\t4\t11\t51\n'));
  assert.equal(report.bytes, Buffer.byteLength(report.text!));
  assert.equal(missing.status, 'missing');
  assert.equal(directory.status, 'incomplete');
  assert.throws(() => collectResultFiles(root, ['report.txt'], 65536, false), /has not terminated/);
  assert.throws(() => collectResultFiles(root, ['../report.txt'], 65536, true), /relative path/);
});

test('enforces combined byte budget and rejects invalid UTF-8', () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-output-'));
  writeFileSync(join(root, 'one.txt'), Buffer.alloc(32768, 97));
  writeFileSync(join(root, 'two.txt'), Buffer.alloc(32768, 98));
  assert.equal(collectResultFiles(root, ['one.txt', 'two.txt'], 65536, true).length, 2);
  assert.throws(() => collectResultFiles(root, ['one.txt', 'two.txt'], 65535, true), /output_limit/);
  writeFileSync(join(root, 'invalid.txt'), Buffer.from([255]));
  assert.equal(collectResultFiles(root, ['invalid.txt'], 65536, true)[0]!.status, 'incomplete');
  writeFileSync(join(root, 'invalid-full.txt'), Buffer.alloc(65536, 255));
  assert.throws(() => collectResultFiles(root, ['invalid-full.txt', 'one.txt'], 65536, true), /output_limit/);
});

test('rejects intermediate and final symlinks in Linux', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-links-'));
  const outside = mkdtempSync(join(tmpdir(), 'xunjie-c1-outside-'));
  writeFileSync(join(outside, 'private.txt'), 'synthetic canary');
  symlinkSync(outside, join(root, 'link'));
  symlinkSync(join(outside, 'private.txt'), join(root, 'report.txt'));
  assert.deepEqual(collectResultFiles(root, ['link/private.txt', 'report.txt'], 65536, true)
    .map(file => file.status), ['incomplete', 'incomplete']);
});

test('UTF-8 BOM remains in confirmed result text, byte count and checksum', () => {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-c1-bom-'));
  writeFileSync(join(root, 'report.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63]));
  const result = collectResultFiles(root, ['report.txt'], 65536, true)[0]!;
  assert.equal(result.status, 'complete');
  assert.equal(result.text, '\uFEFFabc');
  assert.equal(result.bytes, 6);
  assert.equal(result.contentHash, sha256('\uFEFFabc'));
});
