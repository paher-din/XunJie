import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { openProductRuntime } from '@xunjie/product-runtime';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to PostgreSQL 18.6.');

test('product development serves live source and the real API from one origin', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xunjie-product-dev-test-'));
  const source = join(repository, 'apps/web/src', `product-dev-probe-${randomUUID()}.js`);
  const sharedSource = join(repository, 'packages/ui/src', `product-dev-probe-${randomUUID()}.js`);
  const runtime = openProductRuntime({ root, resources: {
    nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: join(repository, 'apps/web/dist-runtime'),
  } });
  let child, installed, log = '';
  try {
    installed = await runtime.install({ profile: 'local' });
    const endpoint = installed.environment.services[0].endpoint;
    await writeFile(source, 'export const marker = "initial-preview-marker";\n');
    await writeFile(sharedSource, 'export const marker = "initial-preview-marker";\n');
    child = spawn(process.execPath, [join(repository, 'scripts/dev-product.mjs'), '--root', root],
      { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`${endpoint}/runtime/status`);
        const status = await response.json();
        if (status.state === 'ready' || status.state === 'degraded') { ready = true; break; }
      } catch { /* The owned host is still starting. */ }
      await delay(200);
    }
    assert.ok(ready, `Development host did not start: ${log}`);
    const page = await fetch(endpoint);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /\/src\/main\.tsx/);
    const api = await fetch(`${endpoint}/api/learning/context`, { headers: { origin: endpoint } });
    assert.equal(api.status, 200);
    const rejected = await fetch(`${endpoint}/api/learning/context`, { headers: { origin: 'https://other.invalid' } });
    assert.equal(rejected.status, 403);
    const missing = await fetch(`${endpoint}/api/does-not-exist`, { headers: { accept: 'text/html' } });
    assert.equal(missing.status, 404);
    for (const [file, path] of [[source, `/src/${basename(source)}`], [sharedSource, `/@fs${sharedSource}`]]) {
      const sourceUrl = `${endpoint}${path}`;
      assert.match(await (await fetch(sourceUrl)).text(), /initial-preview-marker/);
      await writeFile(file, 'export const marker = "updated-preview-marker";\n');
      let updated = false;
      for (let i = 0; i < 50 && !updated; i++) {
        await delay(100);
        updated = (await (await fetch(sourceUrl)).text()).includes('updated-preview-marker');
      }
      assert.ok(updated, `Refreshing ${path} still returned the old version.`);
    }
  } finally {
    await rm(source, { force: true });
    await rm(sharedSource, { force: true });
    if (installed) {
      await runtime.stop();
      await runtime.deleteEnvironment({ environmentId: installed.environment.environmentId });
    }
    if (child && child.exitCode === null) {
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
      assert.notEqual(child.exitCode, null, `Development host did not exit: ${log}`);
    }
    await rm(root, { recursive: true, force: true });
  }
});
