import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createApp } from '../server/app.ts';
import { readPort } from '../server/app/config.ts';

test('startup port accepts only an explicit valid TCP port or the default', () => {
  assert.equal(readPort(undefined), 3000);
  assert.equal(readPort('49152'), 49152);
  assert.equal(readPort('65535'), 65535);
  for (const value of ['', '0', '65536', '-1', '3000junk', ' 3000', '3.1', 'SYNTHETIC_SECRET']) {
    assert.throws(() => readPort(value), { message: 'PORT must be an integer from 1 to 65535.' });
  }
});

test('the entry process refuses invalid configuration without logging its value', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/server/main.js', import.meta.url))], {
    env: { ...process.env, PORT: 'SYNTHETIC_SECRET' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Teaching server startup failed/);
  assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_SECRET'), false);
  assert.equal(result.stderr.includes('node:internal'), false);
});

test('the compiled entry listens on the configured loopback port', { timeout: 10000 }, async (t) => {
  const probe = createServer();
  t.after(() => new Promise<void>((resolve) => probe.close(() => resolve())));
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/server/main.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  });
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  const startup = await Promise.race([
    once(child.stdout, 'data').then(() => 'listening'),
    exited.then(() => 'exited'),
  ]);
  assert.equal(startup, 'listening', errors);
  const response = await fetch(`http://127.0.0.1:${port}/health/live`);
  assert.equal(response.status, 200);
  assert.equal(errors, '');
});

test('the real HTTP listener responds locally and releases its port on close', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/health/live`);
  const body = z.object({ requestId: z.uuid(), data: z.object({ status: z.literal('alive') }) }).parse(await response.json());
  assert.equal(response.status, 200);
  assert.equal(body.data.status, 'alive');
  assert.equal(response.headers.get('x-request-id'), body.requestId);
  await app.close();
  const replacement = createApp();
  t.after(() => replacement.close());
  await replacement.listen({ host: '127.0.0.1', port: Number(new URL(address).port) });
});
