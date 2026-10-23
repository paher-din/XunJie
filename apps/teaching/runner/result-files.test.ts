import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { collectResultFiles } from './result-files.ts';
import { sha256 } from './snapshot.ts';

function resultDirectory(t: TestContext, prefix: string) {
  // The collector requires a canonical runner-owned path; macOS tmpdir can pass through /var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('returns bound content facts, distinguishes missing and unsafe files', t => {
  const root = resultDirectory(t, 'xunjie-c1-results-');
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

test('enforces combined byte budget and rejects invalid UTF-8', t => {
  const root = resultDirectory(t, 'xunjie-c1-output-');
  writeFileSync(join(root, 'one.txt'), Buffer.alloc(32768, 97));
  writeFileSync(join(root, 'two.txt'), Buffer.alloc(32768, 98));
  assert.equal(collectResultFiles(root, ['one.txt', 'two.txt'], 65536, true).length, 2);
  assert.throws(() => collectResultFiles(root, ['one.txt', 'two.txt'], 65535, true), /output_limit/);
  writeFileSync(join(root, 'invalid.txt'), Buffer.from([255]));
  assert.equal(collectResultFiles(root, ['invalid.txt'], 65536, true)[0]!.status, 'incomplete');
  writeFileSync(join(root, 'invalid-full.txt'), Buffer.alloc(65536, 255));
  assert.throws(() => collectResultFiles(root, ['invalid-full.txt', 'one.txt'], 65536, true), /output_limit/);
});

test('rejects symlink result directories', t => {
  const root = resultDirectory(t, 'xunjie-c1-root-link-');
  const trusted = join(root, 'trusted');
  mkdirSync(trusted);
  writeFileSync(join(trusted, 'report.txt'), 'synthetic canary');
  const link = join(root, 'link');
  symlinkSync(trusted, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(collectResultFiles(trusted, ['report.txt'], 65536, true)[0]!.status, 'complete');
  assert.throws(() => collectResultFiles(link, ['report.txt'], 65536, true), {
    name: 'RunnerError', code: 'INVALID_CONFIGURATION',
    message: 'Result directory must be a trusted real directory',
  });
});

test('rejects intermediate and final file symlinks', { skip: process.platform === 'win32' }, t => {
  const root = resultDirectory(t, 'xunjie-c1-links-');
  const outside = resultDirectory(t, 'xunjie-c1-outside-');
  writeFileSync(join(outside, 'private.txt'), 'synthetic canary');
  symlinkSync(outside, join(root, 'link'));
  symlinkSync(join(outside, 'private.txt'), join(root, 'report.txt'));
  assert.deepEqual(collectResultFiles(root, ['link/private.txt', 'report.txt'], 65536, true)
    .map(file => file.status), ['incomplete', 'incomplete']);
});

test('UTF-8 BOM remains in confirmed result text, byte count and checksum', t => {
  const root = resultDirectory(t, 'xunjie-c1-bom-');
  writeFileSync(join(root, 'report.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63]));
  const result = collectResultFiles(root, ['report.txt'], 65536, true)[0]!;
  assert.equal(result.status, 'complete');
  assert.equal(result.text, '\uFEFFabc');
  assert.equal(result.bytes, 6);
  assert.equal(result.contentHash, sha256('\uFEFFabc'));
});
