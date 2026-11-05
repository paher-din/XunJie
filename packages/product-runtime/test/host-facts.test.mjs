import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, createProductRuntimeHost } from '@xunjie/product-runtime';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };

test('a host reports the facts the application measured next to every other dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-host-facts-'));
  const runtime = openProductRuntime({ root, resources });
  await runtime.install({ profile: 'remote' });
  const host = await createProductRuntimeHost({ root, createApplication: async () => ({ owners: [],
    facts: async () => [{ name: 'native-sessions', required: false, state: 'ready',
      detail: 'systemd-unit: network denied; writes session-directory' }],
    async handle() { return false; },
  }) });
  try {
    const status = await (await fetch(new URL('/runtime/status', host.endpoint))).json();
    assert.equal(status.state, 'ready');
    const fact = status.dependencies.find(item => item.name === 'native-sessions');
    assert.deepEqual(fact, { name: 'native-sessions', required: false, state: 'ready',
      detail: 'systemd-unit: network denied; writes session-directory' });
  } finally { await host.stop(); }
});

test('outbound workers drain before safe stop and resume only after maintenance opens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-host-lifecycle-'));
  const runtime = openProductRuntime({ root, resources });
  await runtime.install({ profile: 'remote' });
  const events = [];
  let pauseRelease;
  let pauseStarted;
  const paused = new Promise(resolve => { pauseStarted = resolve; });
  let blockPause = false;
  const host = await createProductRuntimeHost({ root, createApplication: async () => ({ owners: [],
    lifecycle: {
      async pause() {
        events.push('pause');
        if (blockPause) {
          pauseStarted();
          await new Promise(resolve => { pauseRelease = resolve; });
          blockPause = false;
        }
      },
      async resume() {
        const state = await readFile(join(root, 'maintenance.json'), 'utf8').then(JSON.parse, () => ({ phase: 'open' }));
        assert.equal(state.phase, 'open');
        events.push('resume');
      },
      async close() { events.push('close'); },
    },
    async handle() { return false; },
  }) });
  try {
    assert.deepEqual(events, ['resume']);
    blockPause = true;
    const entering = host.maintenance.enter('backup');
    await paused;
    assert.equal(host.maintenance.status().safeToStop, false);
    pauseRelease();
    await entering;
    assert.equal(host.maintenance.status().safeToStop, true);
    assert.deepEqual(events, ['resume', 'pause', 'pause']);
    await host.maintenance.resume();
    assert.equal(events.at(-1), 'resume');
  } finally { await host.stop(); }
  assert.equal(events.at(-1), 'close');
});

test('a fact that cannot be measured is reported, and never replaces the rest of the status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-host-facts-fail-'));
  const runtime = openProductRuntime({ root, resources });
  await runtime.install({ profile: 'remote' });
  const host = await createProductRuntimeHost({ root, createApplication: async () => ({ owners: [],
    facts: async () => { throw new Error('entry unreadable'); },
    async handle() { return false; },
  }) });
  try {
    const response = await fetch(new URL('/runtime/status', host.endpoint));
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.deepEqual(status.dependencies.find(item => item.name === 'application-facts'),
      { name: 'application-facts', required: false, state: 'unavailable', detail: 'entry unreadable' });
  } finally { await host.stop(); }
});
