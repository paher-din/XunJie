import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createProductRuntimeHost, openProductRuntime } from '@xunjie/product-runtime';

test('quiesced shutdown closes a public preconnection that has sent no HTTP request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-shutdown-preconnect-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) } });
  let host, socket, stopping, timer;
  try {
    await runtime.install({ profile: 'remote' });
    host = await createProductRuntimeHost({ root });
    const endpoint = new URL((await runtime.status()).endpoint);
    socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
    await once(socket, 'connect');
    // Chrome may open a connection before it has any request to send. It must not
    // own the product's shutdown boundary after all business owners have drained.
    stopping = host.stop();
    const completed = await Promise.race([stopping.then(() => true), new Promise(done => {
      timer = setTimeout(() => done(false), 1000);
    })]);
    assert.equal(completed, true, 'an unrequested public connection must not keep the owned host alive');
    assert.equal((await runtime.status()).state, 'stopped');
  } finally {
    clearTimeout(timer);
    socket?.destroy();
    if (stopping) await stopping;
    else await host?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('shutdown finishes an admitted learning response before retiring public connections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-shutdown-admitted-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) } });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let host, stopping;
  try {
    await runtime.install({ profile: 'remote' });
    host = await createProductRuntimeHost({ root, createApplication: async () => ({ owners: [],
      async handle(request, response) {
        if (request.url !== '/api/learning/hold') return false;
        entered.resolve(); await release.promise; response.end('confirmed original response'); return true;
      },
    }) });
    const response = fetch(new URL('/api/learning/hold', host.endpoint));
    await entered.promise;
    let stopped = false;
    stopping = host.stop().then(() => { stopped = true; });
    await delay(30);
    assert.equal(stopped, false, 'public sockets stay alive until the admitted handler drains');
    release.resolve();
    assert.equal(await (await response).text(), 'confirmed original response');
    await stopping;
  } finally {
    release.resolve();
    if (stopping) await stopping;
    else await host?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
