import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createOssStorage, imdsCredentials } from './oss-storage.mjs';

test('IMDSv2 uses one temporary credential batch and refreshes without returning a token to client authorization', async () => {
  let clock = Date.now(), version = 0; const calls = [];
  const credentials = imdsCredentials('fixture-role', { now: () => clock, read: async (path, method, headers) => {
    calls.push({ path, method, tokenHeader: Boolean(headers['X-aliyun-ecs-metadata-token']) });
    if (method === 'PUT') return 'fixture-metadata-token';
    version++; return JSON.stringify({ Code: 'Success', AccessKeyId: 'fixture-id-' + version, AccessKeySecret: randomBytes(16).toString('hex'), SecurityToken: 'fixture-session-' + version, Expiration: new Date(clock + 1200000).toISOString() });
  } });
  const [a,b] = await Promise.all([credentials(), credentials()]); assert.equal(a, b); assert.equal(version, 1);
  clock += 700000; const c = await credentials(); assert.notEqual(c.accessKeyId, a.accessKeyId);
  assert.deepEqual(calls.map(c => c.method), ['PUT','GET','PUT','GET']); assert(calls.filter(c => c.method === 'GET').every(c => c.tokenHeader));
});

test('official V4 SDK binds each PUT MD5/length and each GET Range/If-Match using a fresh immutable snapshot', async () => {
  const expiresAt = Date.now() + 3600000;
  const storage = createOssStorage({ bucket: 'fixture-bucket', region:'oss-cn-beijing', prefix:'team/', roleName:'fixture-role' }, {
    credentials: async () => ({ accessKeyId: 'fixture-only-id', accessKeySecret: randomBytes(24).toString('hex'), stsToken: 'fixture-session', expiresAt }),
  });
  const key = 'team/packages/xjp_12345678-1234-1234-1234-123456789abc/repro.zip';
  const put = await storage.part(key, 'fixture-upload-id', { partNumber: 1, bytes: 17, contentMD5: randomBytes(16).toString('base64') });
  const url = new URL(put.url); assert.equal(url.host, 'fixture-bucket.oss-cn-beijing.aliyuncs.com');
  assert.equal(url.searchParams.get('x-oss-expires'), '300'); assert.equal(url.searchParams.get('x-oss-additional-headers'), 'content-length;host');
  assert.equal(put.headers['content-length'], '17'); assert.equal(put.allowedHost, url.host);
  assert(put.expiresAt <= Date.now() + 300000 && put.expiresAt > Date.now() + 298000);
  const get = await storage.download(key, 15, '"opaque-etag"');
  assert.equal(get.headers.range, 'bytes=15-'); assert.equal(get.headers['if-match'], '"opaque-etag"');
  assert.equal(new URL(get.url).searchParams.get('x-oss-additional-headers'), 'host;if-match;range');
  assert.equal('accessKeySecret' in get, false); assert.equal('stsToken' in get, false);
});

test('IMDS refresh fails closed for all concurrent callers and retries a complete batch after recovery', async () => {
  let clock = Date.now(), failure, batches = 0;
  const credentials = imdsCredentials('fixture-role', { now: () => clock, read: async (path, method) => {
    if (method === 'PUT') { batches++; if (failure === 'token') throw new Error('metadata unavailable'); return 'fixture-token'; }
    if (failure === 'json') return '{';
    return JSON.stringify({ Code: 'Success', AccessKeyId: 'fixture-id-' + batches, AccessKeySecret: 'fixture-secret-' + batches,
      SecurityToken: 'fixture-session-' + batches, Expiration: new Date(clock + (failure === 'expiry' ? 30000 : 1200000)).toISOString() });
  } });
  const initial = await credentials(); assert(Object.isFrozen(initial)); clock += 700000;
  for (failure of ['token', 'json', 'expiry']) {
    const before = batches;
    const calls = await Promise.allSettled([credentials(), credentials()]);
    assert.equal(batches, before + 1);
    for (const result of calls) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'OBJECT_STORAGE_UNAVAILABLE'); }
  }
  failure = undefined;
  const recovered = await credentials(); assert.notEqual(recovered.accessKeyId, initial.accessKeyId);
  assert.equal(recovered.accessKeyId.replace('fixture-id-', ''), recovered.stsToken.replace('fixture-session-', ''));
});
