import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPrivateFile, ensurePrivateDirectory, privateJson, writePrivateFile, writePrivateJson } from '../src/enrollment-protocol.mjs';

test('shared private output protects both invitation JSON and device files; rejects broader access', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xj-private-files-'));
  try {
    ensurePrivateDirectory(directory);
    const file = join(directory, 'invitation.json');
    writePrivateJson(file, { fixture: true });
    assert.deepEqual(privateJson(file), { fixture: true });
    writePrivateFile(file, 'replacement');
    assert.equal(readFileSync(file, 'utf8'), 'replacement');
    assertPrivateFile(file);
    if (process.platform === 'win32') {
      const grant = spawnSync('icacls.exe', [file, '/grant', '*S-1-5-32-545:(R)'], { stdio: 'ignore' });
      assert.equal(grant.status, 0);
    } else {
      assert.equal(lstatSync(file).mode & 0o777, 0o600);
      chmodSync(file, 0o644);
    }
    assert.throws(() => assertPrivateFile(file), { code: 'PRIVATE_FILE_REQUIRED' });
    // Replacing an owned ordinary file publishes a newly protected inode/DACL.
    writePrivateJson(file, { repaired: true });
    assert.deepEqual(privateJson(file), { repaired: true });
    if (process.platform !== 'win32') {
      const link = join(directory, 'link');
      symlinkSync(file, link);
      assert.throws(() => writePrivateFile(link, 'must not overwrite'), { code: 'PRIVATE_FILE_REQUIRED' });
      assert.deepEqual(privateJson(file), { repaired: true });
    }
    const keyLike = join(directory, 'key');
    writePrivateFile(keyLike, 'private-fixture');
    assertPrivateFile(keyLike);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('large transfer files retain the same permission boundary while invitation size stays limited', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xj-private-large-'));
  try {
    ensurePrivateDirectory(directory);
    const file = join(directory, 'package.zip'), bytes = Buffer.alloc(1024 * 1024 + 1);
    assert.throws(() => writePrivateFile(file, bytes), { code: 'PRIVATE_FILE_REQUIRED' });
    writePrivateFile(file, bytes, { maxBytes: 128 * 1024 * 1024 });
    assert.throws(() => assertPrivateFile(file), { code: 'PRIVATE_FILE_REQUIRED' });
    assertPrivateFile(file, { maxBytes: 128 * 1024 * 1024 });
    if (process.platform === 'win32') assert.equal(spawnSync('icacls.exe', [file, '/grant', '*S-1-5-32-545:(R)'], { stdio: 'ignore' }).status, 0);
    else chmodSync(file, 0o644);
    assert.throws(() => assertPrivateFile(file, { maxBytes: 128 * 1024 * 1024 }), { code: 'PRIVATE_FILE_REQUIRED' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
