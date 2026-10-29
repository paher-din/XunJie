import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { nativeFixture } from '../../../../packages/storage/test/native-fixture.mjs';

function message(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Host did not report ${type}`)), 15_000);
    const onExit = () => finish(new Error(`Host exited before ${type}`));
    const onMessage = value => {
      if (value?.type === 'failed') finish(new Error('Acceptance host could not start'));
      if (value?.type === type) finish(null, value);
    };
    function finish(error, value) {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', finish);
      child.off('message', onMessage);
      if (error) reject(error); else resolve(value);
    }
    child.on('error', finish);
    child.on('exit', onExit);
    child.on('message', onMessage);
  });
}

test('real HTTP sessions recover stable receipts and bytes after response loss on file and S3', { timeout: 180_000 }, async t => {
  const configPath = process.env.XUNJIE_STORAGE_S3_CONFIG;
  if (!configPath) throw new Error('Set XUNJIE_STORAGE_S3_CONFIG to the private S3 fixture JSON file.');
  let s3;
  try { s3 = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { throw new Error('Cannot read XUNJIE_STORAGE_S3_CONFIG as JSON.'); }
  for (const kind of ['file', 's3']) {
    await t.test(kind, { timeout: 90_000 }, () => runHttpCase(kind, s3));
  }
});

async function runHttpCase(kind, s3) {
  const { sampleMigrations } = await import('../../dist/server/storage-sample/index.js');
  const { provisionStorage, openStorage, createFileBackend, createS3Backend } = await import('@xunjie/storage');
  const fixture = await nativeFixture();
  const children = [];
  let inspector;
  let backend;
  const resourceKeys = new Set();
  const configPath = `${fixture.root}/sample-config.json`;
  async function start() {
    const child = fork(fileURLToPath(new URL('./host.mjs', import.meta.url)), [], {
      env: { ...process.env, XUNJIE_STORAGE_SAMPLE_CONFIG: configPath },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.push(child);
    const { address } = await message(child, 'ready');
    return { child, address };
  }
  async function json(host, path, options) {
    const response = await fetch(host.address + path, options);
    return { status: response.status, body: await response.json() };
  }
  const put = payload => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  try {
    const binding = await provisionStorage({ admin: fixture.admin,
      owner: { environmentId: randomUUID(), serviceId: randomUUID() }, password: randomUUID(), migrations: sampleMigrations });
    const config = { binding, ...(kind === 's3'
      ? { blobBackend: { ...s3, kind: 's3' } }
      : { resourceRoot: `${fixture.root}/objects` }) };
    backend = kind === 's3' ? createS3Backend(s3)
      : createFileBackend({ id: 'sample-files', root: config.resourceRoot });
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const a = await start();
    const b = await start();
    const payload = { requestId: 'duplicate-save', expectedVersion: 0, body: { title: 'original', meta: { z: 2, a: 1 } },
      uploadId: randomUUID(), bytes: Buffer.from('original bytes\u0000\u00ff').toString('base64') };
    const [first, duplicate] = await Promise.all([
      json(a, '/records/one', put(payload)),
      json(b, '/records/one', put({ ...payload, body: { meta: { a: 1, z: 2 }, title: 'original' } })),
    ]);
    assert.equal(first.status, 200);
    resourceKeys.add(first.body.result.resource.locator.key);
    assert.deepEqual(duplicate, first);
    assert.equal(first.body.result.id, 'one');
    assert.equal(first.body.result.version, 1);
    const lostPayload = { requestId: 'lost-save', expectedVersion: 1, body: { title: 'committed' } };
    const confirmed = message(a.child, 'committed');
    const lost = fetch(a.address + '/records/one', {
      ...put(lostPayload), headers: { 'content-type': 'application/json', 'x-test-lose-response': 'yes' },
    }).then(() => 'unexpected-response', () => 'lost');
    await confirmed;
    const exited = once(a.child, 'exit');
    a.child.kill('SIGKILL');
    await exited;
    assert.equal(await lost, 'lost');
    const restarted = await start();
    const receipt = await json(restarted, '/receipts/lost-save');
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.result.version, 2);
    assert.deepEqual(receipt.body.result.resource, first.body.result.resource);
    assert.deepEqual(await json(restarted, '/records/one', put(lostPayload)), receipt);
    const record = await json(restarted, '/records/one');
    assert.equal(record.status, 200);
    assert.deepEqual(record.body, { id: 'one', version: 2, body: { title: 'committed' }, resource: receipt.body.result.resource });
    const resource = await fetch(`${restarted.address}/resources/${record.body.resource.resourceId}?recordId=one`);
    assert.equal(resource.status, 200);
    assert.deepEqual(Buffer.from(await resource.arrayBuffer()), Buffer.from('original bytes\u0000\u00ff'));

    assert.deepEqual(await json(b, '/records/one', put({ ...lostPayload, body: { changed: true } })),
      { status: 409, body: { code: 'identity-conflict' } });
    const stalePayload = { ...payload, requestId: 'stale-save', expectedVersion: 1,
      uploadId: randomUUID(), bytes: Buffer.from('must never replace original').toString('base64') };
    assert.deepEqual(await json(restarted, '/records/one', put(stalePayload)),
      { status: 409, body: { code: 'conflict' } });
    assert.deepEqual(await json(b, '/receipts/stale-save'), { status: 404, body: { code: 'missing' } });
    assert.deepEqual(await json(b, '/records/one'), record);

    const other = await json(b, '/records/two', put({ requestId: 'other-save', expectedVersion: 0, body: null }));
    assert.equal(other.status, 200);
    assert.deepEqual(await json(restarted, `/resources/${record.body.resource.resourceId}?recordId=two`),
      { status: 403, body: { code: 'forbidden' } });
    assert.deepEqual(await json(b, '/records/one', put({ ...lostPayload, requestId: 'bad-base64', bytes: 'private:not-base64' })),
      { status: 400, body: { code: 'invalid' } });
    assert.deepEqual(await json(b, '/records/one', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"private-secret":',
    }), { status: 400, body: { code: 'invalid' } });

    // Different request identities still compete on the record's expected version.
    const contenders = ['race-a', 'race-b'].map(requestId => ({
      requestId, expectedVersion: 2, body: { winner: requestId },
    }));
    const raced = await Promise.all([
      json(restarted, '/records/one', put(contenders[0])),
      json(b, '/records/one', put(contenders[1])),
    ]);
    assert.deepEqual(raced.map(value => value.status).sort(), [200, 409]);
    const winner = raced.find(value => value.status === 200);
    const loserIndex = raced.findIndex(value => value.status === 409);
    assert.equal(winner.body.result.version, 3);
    assert.deepEqual(raced[loserIndex].body, { code: 'conflict' });
    assert.deepEqual(await json(b, `/receipts/${contenders[loserIndex].requestId}`),
      { status: 404, body: { code: 'missing' } });
    assert.deepEqual((await json(b, '/records/one')).body,
      { id: 'one', version: 3, body: { winner: winner.body.requestId }, resource: record.body.resource });

    // Public storage inspection proves the consumer rolled back its outbox and resource binding.
    inspector = await openStorage({ binding, migrations: sampleMigrations, backend });
    assert.deepEqual((await inspector.pendingIntents()).map(intent => intent.payload)
      .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version),
    [first.body.result, receipt.body.result, winner.body.result, other.body.result]);
    const staged = await inspector.reconcileUpload(stalePayload.uploadId);
    resourceKeys.add(staged.locator.key);
    const collected = await inspector.collect({ olderThan: new Date(Date.now() + 60_000) });
    assert.ok(collected.includes(staged.resourceId));
    assert.ok(!collected.includes(record.body.resource.resourceId));
    const original = await fetch(`${b.address}/resources/${record.body.resource.resourceId}?recordId=one`);
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), Buffer.from('original bytes\u0000\u00ff'));

    const participant = inspector.participant();
    await participant.closeWrites();
    try {
      // Include the original upload bytes: a confirmed retry must never restage them.
      assert.deepEqual(await json(b, '/records/one', put(payload)), first);
      assert.deepEqual(await json(b, '/records/one', put({ ...payload,
        bytes: Buffer.from('different bytes under the same request').toString('base64') })),
      { status: 409, body: { code: 'identity-conflict' } });
      assert.deepEqual(await json(b, '/receipts/duplicate-save'), first);
    } finally {
      await participant.resume();
    }

    // Reopen against the resumed generation, then replace the record's mutable resource.
    const writable = await start();
    const replacement = await json(writable, '/records/one', put({
      requestId: 'replacement-save', expectedVersion: 3, body: { title: 'replacement' },
      uploadId: randomUUID(), bytes: Buffer.from('replacement bytes').toString('base64'),
    }));
    assert.equal(replacement.status, 200);
    resourceKeys.add(replacement.body.result.resource.locator.key);
    assert.equal(replacement.body.result.version, 4);
    assert.notEqual(replacement.body.result.resource.resourceId, first.body.result.resource.resourceId);
    assert.deepEqual(await json(writable, '/receipts/duplicate-save'), first);
    const swept = await inspector.collect({ olderThan: new Date(Date.now() + 60_000) });
    assert.ok(!swept.includes(first.body.result.resource.resourceId), 'a committed receipt must retain its original resource');
    assert.deepEqual(await inspector.resource(first.body.result.resource.resourceId), first.body.result.resource);
    assert.deepEqual(Buffer.from(await inspector.readResource(first.body.result.resource.resourceId)),
      Buffer.from('original bytes\u0000\u00ff'));
    assert.deepEqual(await json(writable, '/records/one', put(payload)), first);
    const current = await fetch(`${writable.address}/resources/${replacement.body.result.resource.resourceId}?recordId=one`);
    assert.equal(current.status, 200);
    assert.deepEqual(Buffer.from(await current.arrayBuffer()), Buffer.from('replacement bytes'));
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    try {
      await inspector?.close();
      for (const key of resourceKeys) await backend.remove(key);
    } finally {
      await fixture.close();
    }
  }
}
