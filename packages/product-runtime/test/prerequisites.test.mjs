import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrerequisitePreparer } from '../dist/prerequisites.js';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', webRoot: '.', windowsPrerequisitePath: 'verified-product-helper.ps1' };
const required = { status: 'preparation-required', runtime: { ready: false, version: 'v14.50.35719.00', productAcceptedMinimum: '14.51.36247.0' } };
const prepared = { status: 'downloaded-and-verified-not-installed', installer: "C:\\Users\\O'Brien\\AppData\\Local\\XunJie\\VC_redist.x64.exe",
  fileVersion: '14.51.36247.0', sha256: 'a'.repeat(64), signature: { status: 'Valid' } };

test('remote/external PG and non-Windows never inspect or download the Windows runtime', async () => {
  for (const [platform, mode] of [['win32', 'none'], ['win32', 'external'], ['darwin', 'managed'], ['linux', 'managed']]) {
    const prepare = createPrerequisitePreparer({ platform, run() { assert.fail('unexpected OS inspection/download'); } });
    assert.deepEqual(await prepare({}, { mode }), { status: 'ready' });
  }
});

test('an adequate existing runtime avoids downloading; a 14.50 host prepares but never launches the installer', async () => {
  const calls = [];
  const ready = createPrerequisitePreparer({ platform: 'win32', async run(_path, mode) { calls.push(mode); return { status: 'ready', runtime: { ready: true } }; } });
  assert.equal((await ready(resources, { mode: 'managed' })).status, 'ready');
  assert.deepEqual(calls, ['Check']);
  calls.length = 0;
  const prepare = createPrerequisitePreparer({ platform: 'win32', async run(path, mode) { assert.equal(path, resources.windowsPrerequisitePath); calls.push(mode); return mode === 'Check' ? required : prepared; } });
  const result = await prepare(resources, { mode: 'managed' });
  assert.equal(result.status, 'installation-required');
  assert.deepEqual(calls, ['Check', 'Prepare']);
  assert.deepEqual(result.installer.arguments, ['/install', '/norestart']);
  assert.match(result.nextAction.command, /O''Brien/);
  assert.match(result.nextAction.retry, /重新检查/);
});

test('unverified or wrong-version downloads and preparation failures never become installation-ready', async () => {
  for (const bad of [
    { ...prepared, signature: { status: 'NotSigned' } },
    { ...prepared, fileVersion: '14.50.35719.0' },
    { ...prepared, sha256: '' },
    { status: 'ready', runtime: { ready: false } },
  ]) {
    const prepare = createPrerequisitePreparer({ platform: 'win32', async run(_path, mode) { return mode === 'Check' ? required : bad; } });
    await assert.rejects(prepare(resources, { mode: 'managed' }), /尚未通过完整校验/);
  }
  const prepare = createPrerequisitePreparer({ platform: 'win32', async run() { throw new Error('network unavailable'); } });
  await assert.rejects(prepare(resources, { mode: 'managed' }), /network unavailable/);
});

test('concurrent user installation between check and download is rechecked without offering another installer', async () => {
  const prepare = createPrerequisitePreparer({ platform: 'win32', async run(_path, mode) {
    return mode === 'Check' ? required : { status: 'ready', runtime: { ready: true } };
  } });
  assert.equal((await prepare(resources, { mode: 'managed' })).status, 'ready');
});
