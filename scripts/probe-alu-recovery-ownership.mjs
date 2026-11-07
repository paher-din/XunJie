#!/usr/bin/env node
// Verify cleanup ownership through the real distributed runtime, without opening a browser.
// Usage: node scripts/probe-alu-recovery-ownership.mjs <full-product-package>
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openAluRecoveryHost } from './alu-recovery-host.mjs';

assert.ok(process.argv[2], 'a full product package is required');
const product = resolve(process.argv[2]);
const runtime = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const resources = JSON.parse(await readFile(join(product, 'resources.json')));
for (const key of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper'])
  if (resources[key]) resources[key] = resolve(product, resources[key]);
const parent = await mkdtemp(join(tmpdir(), 'xj-195-ownership-')), root = join(parent, 'existing');
const previousId = randomUUID(), currentId = randomUUID(), config = join(parent, 'private.json');
const instance = runtime.openProductRuntime({ root: join(root, 'source'), resources });
try {
  await mkdir(root); await writeFile(join(root, '.alu-recovery-probe'), previousId);
  await instance.install({ profile: 'local' });
  await mkdir(join(root, 'backups'));
  const sentinel = join(root, 'backups', 'previous-backup.txt');
  await writeFile(sentinel, 'previous run must remain');
  await writeFile(config, JSON.stringify({ root, product, packages: join(parent, 'unused.json'), probeId: previousId }), { mode: 0o600 });
  const driver = await openAluRecoveryHost(config);
  await assert.rejects(driver('setup', { probeId: currentId }), { code: 'EEXIST' });
  await assert.rejects(driver('cleanup', { probeId: currentId }), /has not claimed/);
  assert.equal(await readFile(sentinel, 'utf8'), 'previous run must remain');
  assert.equal((await instance.status()).environment.profile, 'local');
  console.log('PASS: a failed new claim preserves the previous installation and backup.');
} finally {
  await instance.stop();
  await rm(parent, { recursive: true, force: true });
}
