import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanVerification } from './clean-verification.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-clean-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text = 'result') => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('source.txt');
  write('.verification/old-package/binary');
  write('.verification/current/result.json');
  write('.verification/current/debug.log');
  return { root, write, exists: path => existsSync(join(root, path)) };
}

test('default cleanup removes verification artifacts and leaves project files alone', async t => {
  const f = fixture(t);
  await cleanVerification({ root: f.root });
  assert.equal(f.exists('.verification'), false);
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'result');
  assert.equal((await cleanVerification({ root: f.root })).removedEntries, 0);
});

test('explicit selections retain only their files or subtrees', async t => {
  const f = fixture(t);
  f.write('.verification/input/fixture.json');
  await cleanVerification({ root: f.root, keep: ['current/result.json', 'input'] });
  assert(f.exists('.verification/current/result.json'));
  assert(f.exists('.verification/input/fixture.json'));
  assert.equal(f.exists('.verification/current/debug.log'), false);
  assert.equal(f.exists('.verification/old-package'), false);
});

test('preview leaves files intact and invalid selections fail before deletion', async t => {
  const f = fixture(t);
  assert((await cleanVerification({ root: f.root, dryRun: true })).removedEntries > 0);
  for (const keep of [['../source.txt'], [join(f.root, 'source.txt')], ['current/result.json', 'missing']]) {
    await assert.rejects(cleanVerification({ root: f.root, keep }));
    assert(f.exists('.verification/old-package/binary'));
  }
});

test('cleanup removes links without following them, including a linked verification root', async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'outside'));
  f.write('outside/preserved.txt');
  symlinkSync(join(f.root, 'outside'), join(f.root, '.verification/external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanVerification({ root: f.root, keep: ['external/preserved.txt'] }));
  await cleanVerification({ root: f.root });
  assert(f.exists('outside/preserved.txt'));
  symlinkSync(join(f.root, 'outside'), join(f.root, '.verification'), process.platform === 'win32' ? 'junction' : 'dir');
  await cleanVerification({ root: f.root });
  assert(f.exists('outside/preserved.txt'));
  assert.equal(f.exists('.verification'), false);
});
