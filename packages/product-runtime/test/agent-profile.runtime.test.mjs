import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { get } from 'node:https';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createProductRuntimeHost, openProductRuntime } from '@xunjie/product-runtime';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to PostgreSQL 18.6.');
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };

test('agent managed PostgreSQL assembly preserves dependency configuration and accepts application degraded facts', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-agent-pg-'));
  let host;
  try {
    for (const configured of [false, true]) {
      const root = join(directory, String(configured));
      const runtime = openProductRuntime({ root, resources });
      const agent = configured ? { dependencyConnectionId: randomUUID() } : undefined;
      await runtime.install({ profile: 'agent', ...(agent ? { agent } : {}) });
      host = await createProductRuntimeHost({ root, createApplication: async ({ configuration }) => {
        assert.deepEqual(configuration.agent, agent);
        return { owners: [], facts: async () => [{ name: 'agent-dependency', required: false, state: 'unavailable', detail: 'not connected' }],
          async handle() { return false; } };
      } });
      const status = await runtime.status();
      assert.equal(status.state, 'degraded');
      assert.equal(status.dependencies.find(item => item.name === 'PostgreSQL').state, 'ready');
      assert.deepEqual(JSON.parse(await readFile(join(root, 'installation.json'), 'utf8')).agent, agent);
      assert.ok(await runtime.database());
      await host.stop(); host = undefined;
      assert.equal((await runtime.status()).state, 'stopped');
    }
  } finally { await host?.stop(); await rm(directory, { recursive: true, force: true }); }
});


test('agent and school shared hosts require TLS; device profiles remain loopback-only', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xj-shared-profiles-'));
  let host;
  try {
    const tls = { certificateFile: join(directory, 'cert.pem'), keyFile: join(directory, 'key.pem') };
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tls.keyFile,
      '-out', tls.certificateFile, '-subj', '/CN=localhost', '-days', '1']);
    for (const profile of ['local', 'remote', 'model', 'school', 'agent']) {
      const runtime = openProductRuntime({ root: join(directory, profile), resources });
      const server = createServer();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      await new Promise(resolve => server.close(resolve));
      const shared = { profile, host: '0.0.0.0', port, publicEndpoint: `https://127.0.0.1:${port}` };
      if (['local', 'remote', 'model'].includes(profile)) {
        await assert.rejects(runtime.install({ ...shared, tls }), /loopback listener/);
        await assert.rejects(runtime.install({ profile, publicEndpoint: 'https://school.example' }), /loopback endpoint/);
        continue;
      }
      await assert.rejects(runtime.install(shared), /TLS certificate/);
      await assert.rejects(runtime.install({ ...shared, tls, publicEndpoint: `http://127.0.0.1:${port}` }), /Invalid public endpoint/);
      await runtime.install({ ...shared, tls });
      host = await createProductRuntimeHost({ root: join(directory, profile) });
      const wire = await new Promise((resolve, reject) => {
        get(new URL('/runtime/environment', host.endpoint), { rejectUnauthorized: false }, response => {
          let body = ''; response.on('data', chunk => { body += chunk; });
          response.on('end', () => resolve(JSON.parse(body)));
          response.on('error', reject);
        }).on('error', reject);
      });
      assert.equal(wire.profile, profile);
      assert.equal((await runtime.status()).state, 'ready');
      await host.stop(); host = undefined;
    }
  } finally { await host?.stop(); await rm(directory, { recursive: true, force: true }); }
});
