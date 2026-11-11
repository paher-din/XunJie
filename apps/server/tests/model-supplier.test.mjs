import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { StorageError } from '@xunjie/storage';
import { createCatalogueCache } from '../../../packages/learning-space/dist/model-connections/catalogue-cache.js';
import { createModelDirectory } from '../../../packages/learning-space/dist/model-connections/directory.js';
import { createModelProfiles } from '../../../packages/learning-space/dist/model-connections/profiles.js';
import { createModelGateway } from '../../../packages/learning-space/dist/model-connections/index.js';
import { routeModels } from '../../../packages/learning-space/dist/model-connections/wire.js';
import { createLearningEntry } from '../../../packages/learning-space/dist/learning-entry/index.js';
import { sealCredential } from '../../../packages/learning-space/dist/model-connections/vault.js';

const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'test' };
const secret = 'synthetic-supplier-credential-fixture';
const input = { baseUrl: 'https://supplier.example/v1', protocol: 'chat-completions', credential: { action: 'replace', value: secret } };
const source = { baseUrl: input.baseUrl, protocol: input.protocol, modelsUrl: input.baseUrl + '/models', catalogues: ['fixture'], models: [{ modelId: 'seed' }] };
const json = (value, init) => new Response(JSON.stringify(value), init);
function fixture(fetcher = async () => json({ data: [{ id: 'actual' }] }), extra = {}) {
  let publicCalls = 0, supplierCalls = 0;
  const saved = new Map();
  const cache = createCatalogueCache(Date.now, { async load() { return saved; }, async save(k, v) { saved.set(k, structuredClone(v)); } });
  const profiles = createModelProfiles(async () => { publicCalls++; throw new Error('public unavailable'); }, Date.now, cache);
  const directory = createModelDirectory(profiles, { authorize: async () => {}, key: new Uint8Array(32),
    source: () => source, credential: async () => secret, requestFetch: async () => async (...args) => { supplierCalls++; return fetcher(...args); }, ...extra });
  return { directory, profiles, cache, saved, calls: () => ({ publicCalls, supplierCalls }) };
}

// Narrow in-memory storage fixture: no real provider, DNS, config writes or user runtime.
async function gatewayFixture(supplierFetch, { holder = 'device' } = {}) {
  const key = new Uint8Array(32).fill(7), heads = new Map(), credentials = new Map(), cache = new Map();
  let writes = 0;
  const storage = {
    async read(sql, args = []) {
      if (sql.includes('FROM model_vault')) return { rows: [{ resource_id: randomUUID() }] };
      if (sql.includes('FROM model_directory_cache')) return { rows: [...cache].map(([cache_key, body]) => ({ cache_key, body })) };
      if (sql.includes('FROM model_connections')) { const head = heads.get(args.join(':')); return { rows: head ? [{ body: head }] : [] }; }
      if (sql.includes('FROM model_credentials')) { const value = credentials.get(args.join(':')); return { rows: value ? [value] : [] }; }
      throw new Error('Unexpected read: ' + sql);
    },
    async readResource() { return key; },
    async request(_receipt, run) {
      const result = await run({ async query(sql, args) {
        assert.match(sql, /INSERT INTO model_directory_cache/); cache.set(args[0], structuredClone(args[1])); writes++; return { rows: [] };
      } });
      return { result };
    },
  };
  const gateway = await createModelGateway(storage, { holder, authorize: async () => {},
    catalogueFetch: async () => { throw new Error('Unexpected public request'); }, ...(supplierFetch ? { supplierFetch } : {}) });
  function saveHead({ scope = [identity.environmentId, identity.spaceId, identity.principalId].join('.'), protocol = 'chat-completions', baseUrl = 'http://127.0.0.1:32123/v1' } = {}) {
    const connectionId = randomUUID(), ref = randomUUID(), version = 3;
    const configuration = { connectionId, name: 'fixture', protocol, baseUrl,
      path: protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions',
      modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true };
    const binding = JSON.stringify([scope, connectionId, version, JSON.stringify([protocol, baseUrl, configuration.path])]);
    heads.set(scope + ':' + connectionId, { configuration, credentialRef: ref, routeId: randomUUID(), version });
    credentials.set(ref + ':' + scope, { binding, sealed: sealCredential(key, binding, secret) });
    return { connectionId, version };
  }
  return { gateway, saveHead, cache, writes: () => writes };
}

test('supplier-only returns actual IDs, bypasses cooldown and never waits for the public catalogue', async () => {
  const f = fixture();
  assert.deepEqual((await f.directory.read(identity, { source: 'supplier' })).models, []);
  await f.profiles.update(); // A previous public failure cannot block supplier discovery.
  for (let i = 0; i < 2; i++) {
    const result = await f.directory.read(identity, { ...input, source: 'supplier', refresh: true });
    assert.deepEqual(result.models.map(m => m.modelId), ['actual']);
    assert.equal(result.supplier.status, 'ready');
  }
  assert.deepEqual(f.calls(), { publicCalls: 1, supplierCalls: 2 });
});

test('supplier discovery does not wait for an already-running public refresh', async () => {
  let release, supplierCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const profiles = createModelProfiles(async () => { await gate; throw new Error('public offline'); });
  const refreshing = profiles.update();
  const directory = createModelDirectory(profiles, { authorize: async () => {}, key: new Uint8Array(32),
    source: () => source, credential: async () => secret, requestFetch: async () => async () => { supplierCalls++; return json({ data: [{ id: 'actual' }] }); } });
  try {
    const result = await directory.read(identity, { ...input, source: 'supplier', refresh: true });
    assert.equal(result.catalogue.status, 'refreshing'); assert.equal(result.supplier.status, 'ready');
    assert.equal(supplierCalls, 1);
  } finally { release(); await refreshing; }
});

test('catalogue-only never resolves a credential or opens supplier GET; default combined keeps seeds', async () => {
  const f = fixture(undefined, { credential: async () => { throw new Error('must not read key'); } });
  const result = await f.directory.read(identity, { ...input, source: 'catalogue', refresh: true });
  assert.deepEqual(result.models, [{ modelId: 'seed' }]);
  assert.equal(result.supplier, undefined);
  assert.deepEqual(f.calls(), { publicCalls: 1, supplierCalls: 0 });
  const defaulted = fixture();
  assert.deepEqual((await defaulted.directory.read(identity, input)).models, [{ modelId: 'seed' }]);
  assert.deepEqual(defaulted.calls(), { publicCalls: 0, supplierCalls: 0 });
});

test('testConnection uses three native list endpoints/auth; it never generates, writes configuration or caches', async () => {
  for (const protocol of ['chat-completions', 'responses', 'messages']) {
    const baseUrl = 'http://127.0.0.1:32123' + (protocol === 'messages' ? '' : '/v1');
    const f = await gatewayFixture(async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:32123/v1/models'); assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined); assert.equal(init.redirect, 'error');
      const headers = new Headers(init.headers);
      assert.equal(headers.get(protocol === 'messages' ? 'x-api-key' : 'authorization'), protocol === 'messages' ? secret : 'Bearer ' + secret);
      assert.equal(headers.get('anthropic-version'), protocol === 'messages' ? '2023-06-01' : null);
      return json({ data: [] }, { headers: { 'request-id': 'fixture-request' } });
    });
    const result = await routeModels(f.gateway, identity, 'models/providers/test-connection', { ...input, baseUrl, protocol });
    assert.equal(result.status, 'passed'); assert.equal(result.modelCount, 0);
    assert.equal(result.upstream.httpStatus, 200); assert.equal(result.upstream.requestId, 'fixture-request');
    assert.equal(f.writes(), 0); assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('savedCredential requires the owning account, current version, exact base/protocol; draft key wins', async () => {
  let calls = 0;
  const f = await gatewayFixture(async (_url, init) => {
    calls++; assert.equal(init.headers.authorization, 'Bearer ' + secret); return json({ data: [] });
  });
  const savedCredential = f.saveHead();
  const query = { ...input, baseUrl: 'http://127.0.0.1:32123/v1', credential: { action: 'keep' }, savedCredential };
  assert.equal((await f.gateway.directory.testConnection(identity, query)).status, 'passed');
  for (const [who, changes] of [
    [{ ...identity, principalId: randomUUID() }, {}], [identity, { savedCredential: { ...savedCredential, version: 99 } }],
    [identity, { baseUrl: query.baseUrl + '/other' }], [identity, { protocol: 'responses' }],
  ]) {
    const result = await f.gateway.directory.testConnection(who, { ...query, ...changes });
    assert.equal(result.status, 'failed'); assert.equal(result.diagnostic.code, 'saved-credential-mismatch');
  }
  assert.equal(calls, 1);
  assert.equal((await f.gateway.directory.testConnection(identity, { ...query, savedCredential: { ...savedCredential, version: 99 }, credential: input.credential })).status, 'passed');
  assert.equal(calls, 2);
  assert.equal((await f.gateway.directory.testConnection(identity, { ...query, credential: { action: 'clear' } })).diagnostic.code, 'missing-credential');
  assert.equal(calls, 2);
});

test('404/405/HTML/invalid lists are unverified; exact HTTP/auth/rate-limit facts are bounded and redacted', async () => {
  for (const [status, body, expected] of [
    [404, {}, 'unverified'], [405, {}, 'unverified'], [200, '<html>login</html>', 'unverified'], [200, {}, 'unverified'],
    [401, { error: { code: 'invalid_api_key', param: 'api_key', message: 'Bearer ' + secret } }, 'failed'],
    [403, {}, 'failed'], [429, { error: { code: 'rate_limit', message: 'wait' } }, 'failed'], [500, {}, 'failed'],
  ]) {
    const f = fixture(async () => typeof body === 'string' ? new Response(body) : json(body, { status, headers: { 'request-id': 'fixture-id', 'retry-after': '30' } }));
    const result = await f.directory.testConnection(identity, input);
    assert.equal(result.status, expected, `${status} ${JSON.stringify(body)}`);
    assert.equal(result.upstream.httpStatus, status);
    assert.equal(JSON.stringify(result).includes(secret), false);
    if (status === 401) { assert.equal(result.upstream.errorCode, 'invalid_api_key'); assert.equal(result.upstream.parameter, 'api_key'); }
    if (status === 429) assert.equal(result.upstream.retryAfterSeconds, 30);
    const pulled = await f.directory.read(identity, { ...input, source: 'supplier', refresh: true });
    assert.equal(pulled.supplier.status, 'failed'); assert.deepEqual(pulled.models, []);
    assert.equal(pulled.supplier.upstream.httpStatus, status);
    assert.equal(JSON.stringify([...f.saved]).includes(secret), false);
  }
});

test('an HTML content type cannot pass the directory test even with JSON-shaped text', async () => {
  const f = fixture(async () => new Response('{"data":[]}', { headers: { 'content-type': 'text/html' } }));
  assert.equal((await f.directory.testConnection(identity, input)).status, 'unverified');
});

test('invalid targets and network cause return structured failures without forwarding a key', async () => {
  let calls = 0;
  const f = await gatewayFixture(async () => { calls++; throw new Error('must not fetch'); }, { holder: 'school' });
  for (const baseUrl of ['https://user:password@127.0.0.1/v1', 'https://127.0.0.1/v1', 'http://localhost/v1', 'https://example.com/' + secret + '/chat/completions', 'https://example.com/' + encodeURIComponent(secret) + '/chat/completions']) {
    const result = await f.gateway.directory.testConnection(identity, { ...input, baseUrl });
    assert.equal(result.status, 'failed'); assert.equal(result.diagnostic.field, 'baseUrl');
    assert.equal(JSON.stringify(result).includes('password'), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(calls, 0);
  const dns = fixture(undefined, { requestFetch: async () => { throw new Error('fetch failed', { cause: Object.assign(new Error('fixture'), { code: 'ENOTFOUND' }) }); } });
  const result = await dns.directory.testConnection(identity, input);
  assert.equal(result.status, 'failed'); assert.equal(result.upstream.networkCode, 'ENOTFOUND');
});

test('supplier diagnostics distinguish DNS, TLS, upstream timeouts and connection failures from structured causes', async t => {
  for (const [networkCode, code, message, suggestion, errorKind] of [
    ['ENOTFOUND', 'upstream-dns', /DNS.*地址/, /域名.*DNS/, 'offline'],
    ['EAI_AGAIN', 'upstream-dns', /DNS.*地址/, /域名.*DNS/, 'offline'],
    ['CERT_HAS_EXPIRED', 'upstream-tls', /TLS.*证书/, /系统时间.*证书.*代理/, 'offline'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'upstream-tls', /TLS.*证书/, /系统时间.*证书.*代理/, 'offline'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'upstream-tls', /TLS.*证书/, /系统时间.*证书.*代理/, 'offline'],
    ['ETIMEDOUT', 'upstream-timeout', /超时/, /服务状态.*网络.*代理/, 'timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'upstream-timeout', /超时/, /服务状态.*网络.*代理/, 'timeout'],
    ['ECONNREFUSED', 'upstream-network', /连接失败|中断/, /端口.*服务状态.*网络/, 'offline'],
    ['ECONNRESET', 'upstream-network', /连接失败|中断/, /端口.*服务状态.*网络/, 'offline'],
  ]) await t.test(networkCode, async () => {
    // Match the target-policy wrapper and aggregate cause produced by native networking.
    const cause = Object.assign(new Error('Bearer ' + secret), { code: networkCode });
    const error = Object.assign(new StorageError('unavailable'), { cause: new AggregateError([cause]) });
    const f = fixture(undefined, { requestFetch: async () => { throw error; } });
    const result = await f.directory.testConnection(identity, input);
    assert.equal(result.status, 'failed'); assert.equal(result.upstream.networkCode, networkCode);
    assert.equal(result.diagnostic.code, code); assert.equal(result.diagnostic.field, 'baseUrl');
    assert.match(result.diagnostic.message, message); assert.match(result.diagnostic.suggestion, suggestion);
    assert.doesNotMatch(result.diagnostic.message, /10 秒/, 'native timeouts need not consume the entire local deadline');
    const directory = await f.directory.read(identity, { ...input, source: 'supplier', refresh: true });
    assert.equal(directory.supplier.error, errorKind);
    assert.equal(directory.supplier.diagnostic.code, code);
    assert.equal(directory.supplier.upstream.networkCode, networkCode);
    assert.equal(JSON.stringify([...f.saved]).includes(secret), false);
  });
  await t.test('unstructured errors retain the generic recovery advice', async () => {
    const f = fixture(undefined, { requestFetch: async () => { throw new Error('DNS TLS timeout ENOTFOUND ' + secret); } });
    const result = await f.directory.testConnection(identity, input);
    assert.equal(result.diagnostic.code, 'network-error'); assert.equal(result.upstream.networkCode, undefined);
    assert.match(result.diagnostic.suggestion, /地址.*DNS.*网络/);
    assert.equal(JSON.stringify(result).includes(secret), false);
  });
});

test('supplier HTTP 429 distinguishes account quota or billing failures from request throttling', async t => {
  for (const [name, error, quota] of [
    ['quota code', { code: 'insufficient_quota' }, true],
    ['balance code', { code: 'InsufficientBalance' }, true],
    ['billing code', { code: 'billing_hard_limit_reached' }, true],
    ['credits code', { type: 'credits_exhausted' }, true],
    ['payment code', { code: 'payment_required' }, true],
    ['quota prose', { message: 'You exceeded your current quota.' }, true],
    ['balance prose', { message: 'Insufficient account balance.' }, true],
    ['billing prose', { message: 'Billing is not active.' }, true],
    ['Chinese quota prose', { message: '账户余额不足，请充值。' }, true],
    ['rate limit code', { code: 'rate_limit_exceeded', message: 'Too many requests.' }, false],
    ['quota documentation reference', { code: 'rate_limit_exceeded', message: 'Too many requests; see quota and billing documentation.' }, false],
    ['unspecified 429', {}, false],
  ]) await t.test(name, async () => {
    const f = fixture(async () => json({ error }, { status: 429,
      headers: { 'retry-after': '30', 'request-id': 'req-429-case' } }));
    const result = await f.directory.testConnection(identity, input);
    assert.equal(result.status, 'failed'); assert.equal(result.upstream.httpStatus, 429);
    assert.equal(result.upstream.retryAfterSeconds, 30); assert.equal(result.upstream.requestId, 'req-429-case');
    assert.equal(result.diagnostic.code, quota ? 'upstream-quota' : 'http-429');
    assert.match(result.diagnostic.message, quota ? /额度.*余额.*计费/ : /请求频率/);
    assert.match(result.diagnostic.suggestion, quota ? /控制台.*恢复计费/ : /减少并发.*重试时间/);
    const directory = await f.directory.read(identity, { ...input, source: 'supplier', refresh: true });
    assert.equal(directory.supplier.diagnostic.code, result.diagnostic.code);
    assert.equal(directory.supplier.upstream.httpStatus, 429);
    assert.equal(directory.supplier.upstream.retryAfterSeconds, 30);
  });
});

test('user cancellation aborts the actual GET and preserves the last successful supplier cache', async () => {
  let pending;
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET'); assert.equal(request.url, '/v1/models');
    if (pending) { pending(response); return; }
    response.end(JSON.stringify({ data: [{ id: 'last-good' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const query = { ...input, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const f = await gatewayFixture();
  try {
    const first = await f.gateway.directory.read(identity, { ...query, source: 'supplier', refresh: true });
    assert.deepEqual(first.models.map(x => x.modelId), ['last-good']);
    const previous = structuredClone([...f.cache]);
    for (const kind of ['test', 'directory']) {
      let reached, closed;
      const started = new Promise(resolve => { reached = resolve; });
      const disconnected = new Promise(resolve => { closed = resolve; });
      pending = response => { response.on('close', closed); reached(); };
      const controller = new AbortController();
      const result = kind === 'test' ? routeModels(f.gateway, identity, 'models/providers/test-connection', query, undefined, controller.signal)
        : routeModels(f.gateway, identity, 'models/directory', { ...query, source: 'supplier', refresh: true }, undefined, controller.signal);
      await started; controller.abort();
      const ended = await result; await disconnected;
      assert.equal(kind === 'test' ? ended.status : ended.supplier.diagnostic.code, 'cancelled');
      assert.deepEqual([...f.cache], previous);
      assert.deepEqual((await f.gateway.directory.read(identity, { ...query, source: 'supplier' })).models.map(x => x.modelId), ['last-good']);
    }
  } finally {
    f.gateway.closeWrites(); await f.gateway.directory.drain();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});


test('HTTP response disconnect propagates cancellation through both models routes; completed responses do not cancel', { timeout: 5000 }, async () => {
  let entry, waitForAbort = false, reached, observedSignal;
  const f = await gatewayFixture(async (_url, init) => {
    observedSignal = init.signal;
    if (!waitForAbort) return json({ data: [] });
    reached();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  const server = createServer((req, res) => { void entry(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  entry = createLearningEntry({ environment: { environmentId: identity.environmentId, profile: 'local', clientNamespace: 'test', services: [{ endpoint }] },
    target: {}, spaces: { personal: async () => identity, bindMember: async () => {} }, models: f.gateway, administratorToken: 'unused' });
  const query = { ...input, baseUrl: 'http://127.0.0.1:32123/v1' };
  const post = (route, body, signal) => fetch(endpoint + '/api/learning/' + route, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' }, body: JSON.stringify(body), signal });
  try {
    const result = await post('models/providers/test-connection', query);
    assert.equal(result.status, 200); assert.equal((await result.json()).status, 'passed');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(observedSignal.aborted, false);
    waitForAbort = true;
    for (const route of ['models/providers/test-connection', 'models/directory']) {
      const started = new Promise(resolve => { reached = resolve; });
      const controller = new AbortController();
      const response = post(route, route === 'models/directory' ? { ...query, source: 'supplier', refresh: true } : query, controller.signal)
        .then(() => assert.fail('cancelled request must reject'), error => assert.equal(error.name, 'AbortError'));
      await started;
      const supplierSignal = observedSignal;
      const aborted = new Promise(resolve => supplierSignal.addEventListener('abort', resolve, { once: true }));
      controller.abort(); await response; await aborted;
      assert.equal(supplierSignal.aborted, true);
    }
  } finally {
    f.gateway.closeWrites(); await f.gateway.directory.drain();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('the ten-second deadline includes unresolved DNS/transport preparation and prevents a late GET', { timeout: 15000 }, async () => {
  let release, called = 0;
  const preparation = new Promise(resolve => { release = resolve; });
  const f = fixture(undefined, { requestFetch: async () => { await preparation; return async () => { called++; return json({ data: [] }); }; } });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const started = performance.now();
    const result = await f.directory.testConnection(identity, input);
    assert.equal(result.status, 'failed'); assert.equal(result.diagnostic.code, 'timeout');
    assert.ok(performance.now() - started < 11500);
    release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(called, 0);
  } finally { release(); clearInterval(keepAlive); }
});
