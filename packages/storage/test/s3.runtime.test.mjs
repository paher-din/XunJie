import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { BlobError, createS3Backend } from '@xunjie/storage';
import { losePutReply } from './s3-loss-proxy.mjs';

// Explicit opt-in. Missing configuration is a failing acceptance run, never a skip.
const configPath = process.env.XUNJIE_STORAGE_S3_CONFIG;
if (!configPath) throw new Error('Set XUNJIE_STORAGE_S3_CONFIG to a private JSON file with id, endpoint, region, bucket, accessKeyId, secretAccessKey.');
let options;
try { options = JSON.parse(await readFile(configPath, 'utf8')); }
catch { throw new Error('Cannot read XUNJIE_STORAGE_S3_CONFIG as JSON.'); }
for (const field of ['id', 'endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey']) {
  if (typeof options[field] !== 'string' || !options[field]) throw new Error(`S3 configuration requires ${field}.`);
}
const exec = promisify(execFile);

test('real S3 preserves immutable bytes across a client process restart and conditional write races', { timeout: 60_000 }, async t => {
  const backend = createS3Backend(options);
  const prefix = `acceptance-${randomUUID()}`;
  const key = `${prefix}/original`;
  const race = `${prefix}/race`;
  const empty = `${prefix}/empty`;
  t.after(async () => { for (const item of [key, race, empty]) await backend.remove(item); });
  const bytes = new Uint8Array([0, 255, 128, 1, 10, 13, 0]);
  await assert.rejects(backend.get(key), { code: 'missing' });
  await backend.put(key, bytes);
  await backend.put(key, bytes);
  await assert.rejects(backend.put(key, new Uint8Array([9])), { code: 'identity-conflict' });
  assert.deepEqual(await createS3Backend(options).get(key), bytes);

  const reader = `import { readFile } from 'node:fs/promises';
    import { createS3Backend } from ${JSON.stringify(import.meta.resolve('@xunjie/storage'))};
    const backend = createS3Backend(JSON.parse(await readFile(process.env.XUNJIE_STORAGE_S3_CONFIG, 'utf8')));
    process.stdout.write(Buffer.from(await backend.get(process.argv[1])).toString('base64'));`;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', reader, key], { env: process.env });
  assert.equal(stdout, Buffer.from(bytes).toString('base64'));

  const contenders = Array.from({ length: 8 }, (_, i) => new Uint8Array(4096).fill(i));
  const results = await Promise.allSettled(contenders.map(content => createS3Backend(options).put(race, content)));
  const winner = results.findIndex(result => result.status === 'fulfilled');
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'real backend must honor atomic If-None-Match:*');
  for (const result of results.filter(result => result.status === 'rejected')) {
    assert.ok(result.reason instanceof BlobError);
    assert.equal(result.reason.code, 'identity-conflict');
  }
  assert.deepEqual(await backend.get(race), contenders[winner]);
  await backend.put(empty, new Uint8Array());
  assert.deepEqual(await backend.get(empty), new Uint8Array());
  await backend.remove(empty);
  await backend.remove(empty);
  await assert.rejects(backend.get(empty), { code: 'missing' });

  const unauthorized = createS3Backend({ ...options, secretAccessKey: 'deliberately-invalid-secret' });
  await assert.rejects(unauthorized.get(key), { code: 'forbidden' });
  const absentBucket = createS3Backend({ ...options, bucket: `missing-${randomUUID()}` });
  await assert.rejects(absentBucket.get(key), { code: 'unavailable' });
});

test('real S3 lost upload reply is reconciled by reading the same key without another PUT', { timeout: 30_000 }, async t => {
  const direct = createS3Backend(options);
  const key = `acceptance-${randomUUID()}/lost-reply`;
  t.after(() => direct.remove(key));
  const proxy = await losePutReply(t, options.endpoint);
  const backend = createS3Backend({ ...options, endpoint: proxy.endpoint });
  const bytes = new Uint8Array([255, 0, 17, 128]);
  await backend.put(key, bytes);
  assert.equal(proxy.lost(), 1, 'the real S3 server confirmed PUT before its reply was dropped');
  assert.deepEqual(await direct.get(key), bytes);
  await assert.rejects(backend.put(key, new Uint8Array([9])), { code: 'identity-conflict' });
  assert.deepEqual(await direct.get(key), bytes);
});
