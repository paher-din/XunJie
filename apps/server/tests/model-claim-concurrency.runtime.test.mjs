import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createSpaces, spaceMigrations } from '@xunjie/learning-space';
import { createModelGateway, modelMigrations } from '@xunjie/model-gateway';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';

test('two lost concurrent claim acknowledgements cannot overwrite the original unsent claim', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  const opened = [];
  let sends = 0;
  const upstream = createServer((_request, response) => { sends++; response.writeHead(500); response.end(); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const environmentId = randomUUID();
    const owner = async (unit, migrations) => {
      const binding = await provisionStorage({ admin: fixture.admin, owner: { environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
      const storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: unit, root: join(fixture.root, unit) }) });
      opened.push(storage); return storage;
    };
    const spaces = createSpaces(await owner('space', spaceMigrations));
    const identity = await spaces.personal();
    const storage = await owner('model', modelMigrations);
    let arrived = 0, beginBoth, rejectFirstReceipt, rejected = false;
    const both = new Promise(resolve => { beginBoth = resolve; });
    const receiptFailed = new Promise(resolve => { rejectFirstReceipt = resolve; });
    // Supplemental ACK seam only: every transaction and receipt still uses real PostgreSQL.
    // Main public HTTP tests separately cut actual PostgreSQL wire acknowledgements.
    const boundary = { ...storage,
      async request(input, effect) {
        if (!input.fingerprint.startsWith('model-dispatch:')) return storage.request(input, effect);
        if (++arrived === 2) beginBoth();
        await both;
        const committed = await storage.request(input, effect);
        if (committed.result === false) await receiptFailed;
        throw new StorageError('commit-unknown', input.requestId);
      },
      async receipt(...args) {
        if (arrived === 2 && !rejected) {
          rejected = true; rejectFirstReceipt(); throw new StorageError('unavailable');
        }
        return storage.receipt(...args);
      },
    };
    const gateway = await createModelGateway(boundary, { holder: 'device', authorize: spaces.authorize });
    const connectionId = randomUUID();
    await gateway.save(identity, { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '并发确认', protocol: 'chat-completions',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, path: '/chat/completions', modelId: 'unused', dialect: 'standard', parameterMode: 'plain', enabled: true,
      credential: { action: 'replace', value: 'synthetic-unused-key' } });
    const attemptId = randomUUID();
    await gateway.checks.receive(identity, { attemptId, purpose: 'connection-check', source: { connectionId, version: 1 }, limits: { maxOutputTokens: 32, timeoutMs: 1000 } });
    await Promise.allSettled([gateway.checks.dispatch(identity, attemptId), gateway.checks.dispatch(identity, attemptId)]);
    const fact = await gateway.checks.read(identity, attemptId);
    assert.equal(arrived, 2); assert.equal(rejected, true);
    assert.equal(fact.physicalRequestEnded, true); assert.equal(fact.dispatched, false);
    assert.equal(fact.reason, 'dispatch-not-started');
    assert.equal(sends, 0, 'lost claims are reconciled before any SDK request');
    gateway.closeWrites(); await gateway.checks.drain();
  } finally {
    for (const storage of opened.reverse()) await storage.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await fixture.close();
  }
});
