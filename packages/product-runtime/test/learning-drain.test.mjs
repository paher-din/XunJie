import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openProductRuntime, createProductRuntimeHost } from '@xunjie/product-runtime';

test('maintenance rejects new learning requests and waits for admitted remote work to finish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-learning-drain-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) } });
  await runtime.install({ profile: 'remote' });
  let release; let admitted;
  const ready = new Promise(resolve => { admitted = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const host = await createProductRuntimeHost({ root, createApplication: async () => ({ owners: [],
    async handle(request, response) {
      if (request.url !== '/api/learning/hold') return false;
      admitted(); await pending; response.end('complete'); return true;
    },
  }) });
  try {
    const request = fetch(new URL('/api/learning/hold', host.endpoint));
    await ready;
    let finished = false;
    const maintenance = host.maintenance.enter('test').then(() => { finished = true; });
    await delay(50);
    assert.equal(finished, false, 'a maintenance boundary cannot precede an admitted handler');
    assert.equal((await fetch(new URL('/api/learning/hold', host.endpoint))).status, 503);
    release();
    assert.equal(await (await request).text(), 'complete');
    await maintenance;
    assert.equal(host.maintenance.status().safeToStop, true);
  } finally { release(); await host.stop(); }
});
