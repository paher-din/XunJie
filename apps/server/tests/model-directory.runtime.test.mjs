import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { createModelGateway, modelMigrations } from '../../../packages/learning-space/dist/model-connections/index.js';
import { routeModels } from '../../../packages/learning-space/dist/model-connections/wire.js';

test('directory storage, owning-account credentials and lifecycle use native PostgreSQL', { timeout: 90000 }, async t => {
  const fixture = await nativeFixture();
  let storage, gateway, publicCalls = 0, supplierCalls = 0, presetCalls = 0, time = Date.UTC(2026, 10, 10), denied = false, hang = false, started;
  const secret = 'directory-synthetic-credential-value';
  const server = createServer((request, response) => {
    supplierCalls++;
    assert.equal(request.method, 'GET'); assert.equal(request.url, '/v1/models');
    assert.equal(request.headers.authorization, 'Bearer ' + secret);
    if (hang) { started(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'native-directory-model', context_length: 1048576, max_output_tokens: 1048576,
      think_efforts: { valid_efforts: ['low', 'high', 'max'], default_effort: 'high' },
      supported_endpoints: ['/v1/chat/completions'] }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: fixture.admin, owner, password: randomUUID(), migrations: modelMigrations });
    const backend = () => createFileBackend({ id: 'files', root: fixture.root + '/objects' });
    const options = { holder: 'device', catalogueNow: () => time, authorize: async () => { if (denied) throw new StorageError('forbidden'); },
      supplierFetch: async (url, init) => {
        if (String(url).startsWith(baseUrl)) return fetch(url, init);
        presetCalls++;
        assert.equal(url, 'https://opencode.ai/inference/go/v1/models');
        assert.equal(init.headers.authorization, 'Bearer ' + secret);
        return new Response(JSON.stringify({ data: [
          { id: 'directory-only-messages', context_window: 786432, max_output_tokens: 196608, supported_endpoints: ['messages'] },
          { id: 'directory-only-chat', context_window: 524288, max_output_tokens: 131072, supported_endpoints: ['chat.completions'],
            think_efforts: { valid_efforts: ['low', 'high'], default_effort: 'high' } },
        ] }));
      },
      catalogueFetch: async url => { publicCalls++; assert.equal(url, 'https://models.dev/api.json');
        return new Response(JSON.stringify({ future: { api: 'https://public.example/v1', models: { 'public-model': { limit: { context: 262144, output: 65536 } } } } })); } };
    storage = await openStorage({ binding, migrations: modelMigrations, backend: backend() });
    gateway = await createModelGateway(storage, options);
    const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '目录测试' };
    const other = { ...identity, principalId: randomUUID() };
    const query = { presetId: 'custom', baseUrl, protocol: 'chat-completions', credential: { action: 'replace', value: secret } };
    let connection;

    await t.test('initialization and owner read perform no external IO; explicit refresh only sends GET models', async () => {
      assert.equal(publicCalls + supplierCalls, 0);
      const initial = await routeModels(gateway, identity, 'models/directory', query);
      assert.deepEqual(initial.models, []); assert.equal(initial.catalogue.status, 'idle');
      assert.equal(publicCalls + supplierCalls, 0);
      const updated = await routeModels(gateway, identity, 'models/directory', { ...query, refresh: true });
      assert.equal(publicCalls, 1); assert.equal(supplierCalls, 1);
      assert.equal(updated.models[0].contextWindow, 1048576); assert.equal(updated.models[0].maxOutputTokens, 1048576);
      assert.equal(updated.models[0].defaultEffort, 'high');
      assert.equal(JSON.stringify(updated).includes(secret), false);
    });

    await t.test('persisted cache contains HMAC identity and metadata, never credentials; owners do not share supplier state', async () => {
      const { rows } = await storage.read('SELECT cache_key,body FROM model_directory_cache');
      assert.equal(rows.length, 2); assert.equal(JSON.stringify(rows).includes(secret), false);
      assert.equal(JSON.stringify(rows).includes(identity.principalId), false);
      assert.ok(rows.some(row => /^supplier:[a-f0-9]{64}$/.test(row.cache_key)));
      assert.deepEqual((await gateway.directory.read(other, query)).models, []);
      denied = true;
      await assert.rejects(gateway.directory.read(identity, { ...query, refresh: true }), { code: 'forbidden' });
      denied = false; assert.equal(supplierCalls, 1);
      await gateway.validate();
    });

    await t.test('restart loads last-good metadata/cooldown without network, and explicit update bypasses 10 minutes after 3 seconds', async () => {
      gateway.closeWrites(); await gateway.checks.drain(); await storage.close();
      storage = await openStorage({ binding, migrations: modelMigrations, backend: backend() });
      gateway = await createModelGateway(storage, options);
      assert.equal(publicCalls + supplierCalls, 2);
      assert.equal((await gateway.directory.read(identity, query)).models[0].modelId, 'native-directory-model');
      assert.equal((await gateway.directory.read(identity, { ...query, refresh: true })).supplier.status, 'cooldown');
      time += 3000;
      assert.equal((await gateway.directory.read(identity, { ...query, manual: true })).supplier.status, 'ready');
      assert.equal(publicCalls, 2); assert.equal(supplierCalls, 2);
    });

    await t.test('saved key stays bound to owner, current version and exact endpoint; saving does not refresh', async () => {
      connection = await gateway.save(identity, { connectionId: randomUUID(), requestId: randomUUID(), expectedVersion: 0,
        name: '本机目录', protocol: 'chat-completions', baseUrl, path: '/chat/completions', modelId: 'native-directory-model',
        dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: secret } });
      const savedCredential = { connectionId: connection.connectionId, version: connection.version };
      const saved = { ...query, credential: { action: 'keep' }, savedCredential };
      assert.equal((await gateway.directory.read(identity, saved)).models[0].modelId, 'native-directory-model');
      await assert.rejects(gateway.directory.read(other, saved), { code: 'missing' });
      await assert.rejects(gateway.directory.read(identity, { ...saved, baseUrl: baseUrl + '/other' }), { code: 'conflict' });
      await assert.rejects(gateway.directory.read(identity, { ...saved, savedCredential: { ...savedCredential, version: 99 } }), { code: 'conflict' });
      const cleared = await gateway.directory.read(identity, { ...saved, credential: { action: 'clear' } });
      assert.equal(cleared.supplier.status, 'needs-credential'); assert.deepEqual(cleared.models, []);
      assert.equal(publicCalls, 2); assert.equal(supplierCalls, 2);
    });

    await t.test('preset keep reuses a canonical sibling protocol and save consumes actual account metadata without network', async () => {
      const primary = { presetId: 'opencode-go', variantId: 'go', protocol: 'chat-completions', baseUrl: 'https://opencode.ai/inference/go/openai/v1' };
      const messages = { protocol: 'messages', baseUrl: 'https://opencode.ai/inference/go/anthropic' };
      const source = { ...primary, credential: query.credential };
      const listed = await gateway.directory.read(identity, { ...source, refresh: true });
      assert.equal(listed.supplier.status, 'ready'); assert.equal(presetCalls, 1);
      const before = publicCalls + supplierCalls + presetCalls;
      let provider = await gateway.providers.save(identity, { ...primary, requestId: randomUUID(), providerId: randomUUID(), expectedVersion: 0,
        name: '跨协议目录', enabled: true, credential: query.credential, models: [
          { ...messages, connectionId: randomUUID(), expectedVersion: 0, modelId: 'directory-only-messages', enabled: true },
          { connectionId: randomUUID(), expectedVersion: 0, modelId: 'directory-only-chat', enabled: true, reasoningEffort: 'high' },
        ] });
      assert.equal(provider.models[0].protocol, 'messages');
      assert.equal(provider.models[0].contextWindow, 786432); assert.equal(provider.models[0].maxOutputTokens, 196608);
      assert.equal(provider.models[1].contextWindow, 524288); assert.equal(provider.models[1].maxOutputTokens, 131072);
      assert.deepEqual(provider.models[1].reasoningLevels, ['low', 'high']);
      assert.equal(provider.models[1].reasoningSource, 'catalogue'); assert.equal(provider.models[1].reasoningEffort, 'high');
      const first = provider.models[0], savedCredential = { connectionId: first.connectionId, version: first.version };
      const kept = { ...primary, credential: { action: 'keep' }, savedCredential };
      assert.equal((await gateway.directory.read(identity, kept)).supplier.status, 'ready');
      assert.equal((await gateway.directory.read(identity, { ...kept, variantId: undefined })).supplier.status, 'ready', 'default variant shares cache identity');
      await assert.rejects(gateway.directory.read(identity, { ...kept, presetId: 'kimi', variantId: 'code',
        baseUrl: 'https://api.kimi.com/coding/v1' }), { code: 'conflict' });
      const models = provider.models.map(model => ({ connectionId: model.connectionId, expectedVersion: model.version,
        modelId: model.modelId, enabled: true, reasoningEffort: model.reasoningEffort }));
      provider = await gateway.providers.save(identity, { ...primary, requestId: randomUUID(), providerId: provider.providerId,
        expectedVersion: provider.version, name: provider.name, enabled: true, credential: { action: 'keep' }, models });
      assert.equal(provider.models[0].contextWindow, 786432);
      assert.equal(provider.models[1].reasoningSource, 'catalogue');
      assert.equal(publicCalls + supplierCalls + presetCalls, before, 'save/cache reads cannot trigger supplier or public fetch');

      const glm = await gateway.save(identity, { connectionId: randomUUID(), requestId: randomUUID(), expectedVersion: 0,
        presetId: 'zhipu', variantId: 'api', name: '普通 API', protocol: 'messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        path: '/v1/messages', modelId: 'channel-directory-test', dialect: 'standard', parameterMode: 'plain', enabled: true,
        credential: query.credential });
      const glmKeep = { presetId: 'zhipu', variantId: 'api', protocol: 'messages', baseUrl: glm.baseUrl,
        credential: { action: 'keep' }, savedCredential: { connectionId: glm.connectionId, version: glm.version } };
      assert.equal((await gateway.directory.read(identity, glmKeep)).supplier.status, 'idle');
      await assert.rejects(gateway.directory.read(identity, { ...glmKeep, variantId: 'coding' }), { code: 'conflict' },
        'shared protocol URL cannot authorize a different billing channel');
    });

    await t.test('close aborts and drains metadata fetches before storage maintenance', async () => {
      hang = true; time += 3000;
      const reached = new Promise(resolve => { started = resolve; });
      const refresh = gateway.directory.read(identity, { ...query, manual: true });
      await reached;
      gateway.closeWrites(); await gateway.checks.drain();
      assert.equal((await refresh).supplier.status, 'failed');
      assert.equal((await gateway.directory.read(identity, query)).models[0].modelId, 'native-directory-model');
      await assert.rejects(gateway.directory.read(identity, { ...query, manual: true }), { code: 'maintenance' });
      gateway.resume(); await gateway.validate();
    });
  } finally {
    gateway?.closeWrites(); await gateway?.checks.drain(); await storage?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fixture.close();
  }
});
