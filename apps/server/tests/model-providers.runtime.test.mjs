import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import pg from 'pg';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { modelCommitRelay } from './model-commit-relay.mjs';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
const key = 'synthetic-provider-key-never-project';
const child = (modelId, enabled = true) => ({ connectionId: randomUUID(), expectedVersion: 0, modelId, enabled, reasoningEffort: 'auto' });
const provider = baseUrl => ({ requestId: randomUUID(), providerId: randomUUID(), expectedVersion: 0,
  name: '共享供应商', protocol: 'chat-completions', baseUrl, enabled: true,
  credential: { action: 'replace', value: key }, models: [child('runtime-orbit-a'), child('runtime-orbit-b', false)] });
const revision = (saved, changes = {}) => ({ requestId: randomUUID(), providerId: saved.providerId, expectedVersion: saved.version,
  name: saved.name, protocol: saved.protocol, baseUrl: saved.baseUrl, enabled: saved.enabled, credential: { action: 'keep' },
  models: saved.models.map(model => ({ connectionId: model.connectionId, expectedVersion: model.version,
    modelId: model.modelId, enabled: model.modelEnabled, reasoningEffort: 'auto' })), ...changes });
const check = model => ({ attemptId: randomUUID(), purpose: 'connection-check', source: { connectionId: model.connectionId, version: model.version },
  limits: { maxOutputTokens: 32, timeoutMs: 5000 } });
const removal = model => ({ connectionId: model.connectionId, expectedVersion: model.version });
function masked(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(key), false, 'credentials must never enter public model projections');
  assert.equal(serialized.includes('credentialRef'), false);
  assert.equal(serialized.includes('sealed'), false);
}
async function product(run) {
  const root = await mkdtemp(join(tmpdir(), 'xj-model-providers-'));
  const runtime = openProductRuntime({ root, resources });
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks)), authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '供应商回归完成' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await runtime.install({ profile: 'local' });
    let { endpoint } = await runtime.start();
    const api = async (path, body) => {
      const response = await fetch(endpoint + '/api/learning/models/' + path, {
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const save = async input => {
      const result = await api('providers', input);
      assert.equal(result.status, 200, JSON.stringify(result.value));
      masked(result.value);
      for (const model of result.value.models) {
        assert.equal(model.providerId, input.providerId);
        assert.equal(model.name, input.name);
        assert.equal(model.protocol, input.protocol);
        assert.equal(model.baseUrl, input.baseUrl);
        assert.equal(model.providerEnabled, input.enabled);
        assert.equal(model.modelEnabled, input.models.find(item => item.connectionId === model.connectionId).enabled);
        assert.equal(model.enabled, model.providerEnabled && model.modelEnabled);
      }
      return result.value;
    };
    const restart = async () => { await runtime.stop(); ({ endpoint } = await runtime.start()); };
    const send = async input => {
      const accepted = await api('checks', input);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
      masked(accepted.value);
      assert.equal((await api(`checks/${input.attemptId}/dispatch`, {})).status, 200);
      for (let count = 0; count < 200; count++) {
        const result = await api(`checks/${input.attemptId}`);
        assert.equal(result.status, 200);
        if (result.value.physicalRequestEnded) {
          assert.equal(result.value.state, 'completed', JSON.stringify(result.value));
          masked(result.value);
          return result.value;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('native SDK request did not reach a terminal state');
    };
    await run({ api, save, send, restart, runtime, root, received, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` });
  } finally {
    await runtime.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test('provider lifecycle uses real native storage and SDK dispatch', { timeout: 240000 }, async t => {
  await product(async ({ api, save, send, restart, received, baseUrl }) => {
    await t.test('mixed native routes share one provider and retain their primary address, identities and credentials after restart', async () => {
      const input = provider(baseUrl);
      input.presetId = 'custom';
      input.models[1].protocol = 'messages';
      input.models[1].baseUrl = baseUrl.replace(/\/v1$/, '');
      const first = await api('providers', input);
      assert.equal(first.status, 200, JSON.stringify(first.value));
      let saved = first.value;
      assert.deepEqual(saved.models.map(model => [model.protocol, model.baseUrl, model.path]), [
        ['chat-completions', baseUrl, '/chat/completions'], ['messages', input.models[1].baseUrl, '/v1/messages'],
      ]);
      const routes = saved.models.map(model => model.routeId);
      // A compatible older caller may omit per-model routes on a metadata-only edit.
      const renamed = await api('providers', revision(saved, { name: '共享身份，独立模型协议', presetId: 'custom' }));
      assert.equal(renamed.status, 200, JSON.stringify(renamed.value));
      saved = renamed.value;
      assert.deepEqual(saved.models.map(model => model.protocol), ['chat-completions', 'messages']);
      assert.deepEqual(saved.models.map(model => model.routeId), routes);
      assert.equal(saved.protocol, 'chat-completions'); assert.equal(saved.baseUrl, baseUrl);
      for (const model of saved.models)
        assert.equal((await api(`connections/${model.connectionId}/credential`, { version: model.version })).value.value, key);
      await restart();
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === input.providerId), saved);
    });

    await t.test('unknown models persist 256K/64K fallbacks while explicit capacities survive later edits and restart', async () => {
      const input = provider(baseUrl);
      input.models[1].contextWindow = 2 * 1024 * 1024;
      input.models[1].maxOutputTokens = 1024 * 1024;
      let saved = await save(input);
      const capacities = value => value.models.map(model => [model.contextWindow, model.maxOutputTokens]);
      assert.deepEqual(capacities(saved), [[262144, 65536], [2097152, 1048576]]);
      saved = await save(revision(saved, { name: '只改名称' }));
      assert.deepEqual(capacities(saved), [[262144, 65536], [2097152, 1048576]]);
      await restart();
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === saved.providerId), saved);
    });

    await t.test('independent model switches survive parent disable/restore and block pending dispatch', async () => {
      let saved = await save(provider(baseUrl));
      const [a, b] = saved.models;
      assert.deepEqual(saved.models.map(model => [model.enabled, model.modelEnabled, model.providerEnabled]), [[true, true, true], [false, false, true]]);
      assert.equal((await api('checks', check(b))).status, 503);
      const before = received.length;
      const pending = check(a);
      assert.equal((await api('checks', pending)).status, 200);
      saved = await save(revision(saved, { enabled: false }));
      assert.deepEqual(saved.models.map(model => [model.enabled, model.modelEnabled, model.providerEnabled]), [[false, true, false], [false, false, false]]);
      assert.equal((await api(`checks/${pending.attemptId}/dispatch`, {})).status, 403);
      for (const model of saved.models) assert.equal((await api('checks', check(model))).status, 503);
      assert.equal(received.length, before);
      saved = await save(revision(saved, { enabled: true }));
      assert.deepEqual(saved.models.map(model => model.enabled), [true, false]);
      assert.deepEqual(saved.models.map(model => model.routeId), [a.routeId, b.routeId]);
      await send(check(saved.models[0]));
      const switchModels = revision(saved);
      switchModels.models[0].enabled = false;
      switchModels.models[1].enabled = true;
      const pendingSibling = check(saved.models[0]);
      assert.equal((await api('checks', pendingSibling)).status, 200);
      saved = await save(switchModels);
      assert.equal((await api(`checks/${pendingSibling.attemptId}/dispatch`, {})).status, 403);
      assert.equal((await api('checks', check(saved.models[0]))).status, 503);
      await send(check(saved.models[1]));
      assert.deepEqual(received.slice(before).map(request => request.body.model), [a.modelId, b.modelId]);
      assert.ok(received.every(request => request.authorization === 'Bearer ' + key));
    });

    await t.test('provider and every model use CAS; a stale second model rolls back the first model and credential', async () => {
      const input = provider(baseUrl);
      let saved = await save(input);
      const staleParent = revision(saved, { expectedVersion: 0, name: '不能保存的供应商' });
      assert.equal((await api('providers', staleParent)).status, 409);
      const broken = revision(saved, { name: '不能部分保存', credential: { action: 'clear' } });
      broken.models[0].modelId = 'should-never-be-persisted';
      broken.models[1].expectedVersion = 0;
      assert.equal((await api('providers', broken)).status, 409);
      const listed = await api('providers');
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.value.find(item => item.providerId === saved.providerId), saved);
      const connections = await api('connections');
      assert.equal(connections.status, 200);
      for (const model of saved.models) {
        assert.deepEqual(connections.value.find(item => item.connectionId === model.connectionId), model);
        assert.equal((await api(`connections/${model.connectionId}/credential`, { version: model.version })).value.value, key);
        assert.equal((await api(`connections/${model.connectionId}/credential`, { version: model.version + 1 })).status, 409);
      }
      masked(listed.value); masked(connections.value);
      const corrected = structuredClone(broken);
      corrected.models[1].expectedVersion = saved.models[1].version;
      saved = await save(corrected); // A rolled-back requestId is retryable, not a partial receipt.
      assert.equal(saved.version, 2);
      assert.deepEqual(saved.models.map(model => model.version), [2, 2]);
      assert.equal(saved.hasCredential, false);
      assert.ok(saved.models.every(model => !model.hasCredential));
    });

    await t.test('removing a member hides it, blocks execution, retains disabled siblings and history, and can restore its identity', async () => {
      let saved = await save(provider(baseUrl));
      const [a, b] = saved.models;
      const completed = await send(check(a));
      const grant = await api('grants', { requestId: randomUUID(), grantId: randomUUID(), connectionId: a.connectionId, owner: 'self' });
      assert.equal(grant.status, 200);
      const current = await api('selection');
      const source = { kind: 'personal', connectionId: a.connectionId, grantId: grant.value.grantId };
      const selected = await api('selection', { requestId: randomUUID(), expectedVersion: current.value.version, source });
      assert.equal(selected.status, 200);
      const pending = check(a);
      assert.equal((await api('checks', pending)).status, 200);
      const input = revision(saved);
      input.models.shift();
      input.removedModels = [removal(a)];
      saved = await save(input);
      assert.equal(saved.credentialConnection, undefined);
      assert.deepEqual(saved.models.map(model => [model.connectionId, model.enabled, model.modelEnabled]), [[b.connectionId, false, false]]);
      assert.equal((await api(`connections/${b.connectionId}/credential`, { version: saved.models[0].version })).value.value, key);
      const listed = await api('connections');
      assert.equal(listed.value.some(model => model.connectionId === a.connectionId), false);
      assert.equal((await api('checks', check({ ...a, version: a.version + 1 }))).status, 503);
      assert.equal((await api('checks', { ...check(a), source: { selected: true, selectionVersion: selected.value.version } })).status, 503);
      assert.equal((await api(`checks/${pending.attemptId}/dispatch`, {})).status, 403);
      const selectionAgain = await api('selection', { requestId: randomUUID(), expectedVersion: selected.value.version, source });
      assert.equal(selectionAgain.status, 503);
      await restart(); // validate must retain grants, selection pointers, historical versions and calls.
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === saved.providerId), saved);
      assert.deepEqual((await api(`checks/${completed.attemptId}`)).value, completed);
      const restored = revision(saved);
      restored.models.unshift({ ...input.removedModels[0], expectedVersion: a.version + 1, modelId: a.modelId, enabled: true });
      saved = await save(restored);
      assert.equal(saved.models[0].version, a.version + 2);
      assert.equal(saved.models[0].routeId, a.routeId);
      assert.equal(saved.models[0].connectionId, a.connectionId);
      assert.equal(saved.models[1].modelEnabled, false);
      assert.equal((await api(`connections/${a.connectionId}/credential`, { version: saved.models[0].version })).value.value, key);
      await send(check(saved.models[0]));
      await restart();
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === saved.providerId), saved);
    });

    for (const action of ['keep', 'replace', 'clear']) await t.test(`empty provider retains metadata and applies credential.${action}, then new models inherit the current key`, async () => {
      let saved = await save(provider(baseUrl));
      const original = saved.models;
      const credential = action === 'replace' ? { action, value: key + '-replacement' } : { action };
      const input = revision(saved, { models: [], removedModels: original.map(removal), credential, enabled: false, name: '空供应商' });
      saved = await save(input);
      const expectedKey = action === 'clear' ? '' : action === 'replace' ? credential.value : key;
      assert.deepEqual(saved.models, []);
      assert.equal(saved.name, '空供应商');
      assert.equal(saved.enabled, false);
      assert.equal(saved.hasCredential, !!expectedKey);
      assert.deepEqual(saved.credentialConnection, { connectionId: original[1].connectionId, version: original[1].version + 1 });
      assert.deepEqual(await save(input), saved, 'removal requestId replay must not retire twice');
      const connections = (await api('connections')).value;
      for (const model of original) {
        assert.equal(connections.some(item => item.connectionId === model.connectionId), false);
        assert.equal((await api('checks', check({ ...model, version: model.version + 1 }))).status, 503);
      }
      assert.equal((await api(`connections/${saved.credentialConnection.connectionId}/credential`, { version: saved.credentialConnection.version })).value.value, expectedKey);
      await restart();
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === saved.providerId), saved);
      // The outer provider switch sends an empty selected set with credential.keep.
      const toggle = revision(saved, { enabled: true });
      saved = await save(toggle);
      assert.equal(saved.enabled, true);
      assert.deepEqual(saved.models, []);
      assert.equal((await api(`connections/${saved.credentialConnection.connectionId}/credential`, { version: saved.credentialConnection.version })).value.value, expectedKey);
      const emptyEdit = revision(saved, { name: '空供应商改名', protocol: 'responses', baseUrl: baseUrl + '/new' });
      saved = await save(emptyEdit);
      assert.equal(saved.protocol, 'responses');
      assert.equal(saved.baseUrl, emptyEdit.baseUrl);
      await restart();
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === saved.providerId), saved);
      // Use the original primary route for the synthetic upstream.
      const add = revision(saved, { protocol: 'chat-completions', baseUrl, models: [child('new-after-empty')] });
      saved = await save(add);
      assert.equal(saved.credentialConnection, undefined);
      assert.equal(saved.models[0].version, 1);
      assert.equal(saved.hasCredential, !!expectedKey);
      assert.equal((await api(`connections/${saved.models[0].connectionId}/credential`, { version: saved.models[0].version })).value.value, expectedKey);
      assert.equal(JSON.stringify(saved).includes(key + '-replacement'), false);
      await restart();
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === saved.providerId), saved);
    });

    await t.test('editing an already empty provider can replace and clear its anchor key and restore that same connection with CAS', async () => {
      let saved = await save(provider(baseUrl));
      const first = saved.models[0];
      const last = saved.models[1];
      saved = await save(revision(saved, { models: [], removedModels: saved.models.map(removal) }));
      saved = await save(revision(saved, { credential: { action: 'replace', value: key + '-new' }, enabled: false }));
      assert.equal((await api(`connections/${last.connectionId}/credential`, { version: saved.credentialConnection.version })).value.value, key + '-new');
      saved = await save(revision(saved, { credential: { action: 'clear' } }));
      assert.equal(saved.hasCredential, false);
      await restart();
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === saved.providerId), saved);
      const restore = revision(saved, { enabled: true, models: [{ connectionId: last.connectionId,
        expectedVersion: saved.credentialConnection.version, modelId: last.modelId, enabled: false }] });
      saved = await save(restore);
      assert.equal(saved.models[0].routeId, last.routeId);
      assert.equal(saved.models[0].modelEnabled, false);
      assert.equal(saved.models[0].hasCredential, false);
      const restoreOlder = revision(saved);
      restoreOlder.models.push({ connectionId: first.connectionId, expectedVersion: first.version + 1, modelId: first.modelId, enabled: true });
      saved = await save(restoreOlder);
      assert.equal(saved.models[1].hasCredential, false, 'restoring an older retired head must not resurrect a key cleared on the provider');
      await restart();
    });

    await t.test('explicit removal rejects omitted members, duplicates, overlap, wrong ownership and stale versions without partial writes', async () => {
      const saved = await save(provider(baseUrl));
      const other = await save(provider(baseUrl));
      const [a, b] = saved.models;
      const broken = revision(saved, { models: [], removedModels: saved.models.map(removal), name: '不能部分提交', credential: { action: 'clear' } });
      const cases = [
        [revision(saved, { models: [] }), 400],
        [revision(saved, { models: [revision(saved).models[0]], removedModels: [] }), 400],
        [{ ...broken, removedModels: [removal(a), removal(a)] }, 400],
        [{ ...broken, models: revision(saved).models }, 400],
        [{ ...broken, removedModels: [removal(a), removal(other.models[0])] }, 409],
        [{ ...broken, removedModels: [removal(a), { connectionId: randomUUID(), expectedVersion: 1 }] }, 409],
        [{ ...broken, removedModels: [removal(a), { ...removal(b), expectedVersion: b.version + 1 }] }, 409],
        [{ ...broken, expectedVersion: saved.version - 1 }, 409],
        [revision(saved, { models: [{ ...revision(saved).models[0], expectedVersion: 0 }], removedModels: [removal(b)], credential: { action: 'clear' } }), 409],
        [{ ...provider(baseUrl), models: [] }, 400],
      ];
      for (const [input, status] of cases) {
        assert.equal((await api('providers', input)).status, status);
        assert.deepEqual((await api('providers')).value.find(item => item.providerId === saved.providerId), saved);
        for (const model of saved.models)
          assert.equal((await api(`connections/${model.connectionId}/credential`, { version: model.version })).value.value, key);
      }
      const removed = await save(broken); // Failed requestId remains retryable.
      assert.equal(removed.version, saved.version + 1);
      const repeatRemoval = revision(removed, { removedModels: [removal(a)] });
      assert.equal((await api('providers', repeatRemoval)).status, 409);
      const staleRestore = revision(removed, { models: [{ connectionId: a.connectionId, expectedVersion: a.version, modelId: a.modelId, enabled: true }] });
      assert.equal((await api('providers', staleRestore)).status, 409);
      const foreignRestore = revision(removed, { models: [{ connectionId: other.models[0].connectionId,
        expectedVersion: other.models[0].version, modelId: 'foreign', enabled: true }] });
      assert.equal((await api('providers', foreignRestore)).status, 409);
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === saved.providerId), removed);
      await restart();
    });

    await t.test('legacy ungrouped connections can be explicitly removed into an empty provider without inventing a model', async () => {
      const old = { requestId: randomUUID(), connectionId: randomUUID(), expectedVersion: 0, name: '旧版待取消',
        protocol: 'chat-completions', baseUrl, path: '/chat/completions', modelId: 'legacy-remove',
        dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: key } };
      assert.equal((await api('connections', old)).status, 200);
      const legacy = (await api('providers')).value.find(item => item.providerId === old.connectionId);
      const input = revision(legacy, { models: [], removedModels: legacy.models.map(removal) });
      const saved = await save(input);
      assert.deepEqual(saved.models, []);
      assert.equal(saved.credentialConnection.connectionId, old.connectionId);
      assert.equal(saved.credentialConnection.version, 2);
      assert.equal((await api('connections', { ...old, requestId: randomUUID(), expectedVersion: 2 })).status, 409);
      await restart();
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === saved.providerId), saved);
    });

    await t.test('legacy lazy upgrade preserves connection/route/grant identity and keep inherits the key for new siblings', async () => {
      const old = { requestId: randomUUID(), connectionId: randomUUID(), expectedVersion: 0, name: '旧连接',
        protocol: 'chat-completions', baseUrl, path: '/chat/completions', modelId: 'legacy-orbit',
        dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: key } };
      const legacy = await api('connections', old);
      assert.equal(legacy.status, 200);
      const grantInput = { requestId: randomUUID(), grantId: randomUUID(), connectionId: old.connectionId, owner: 'self' };
      const grant = await api('grants', grantInput);
      assert.equal(grant.status, 200);
      const source = { kind: 'personal', connectionId: old.connectionId, grantId: grantInput.grantId };
      const selectionBefore = await api('selection');
      const selected = await api('selection', { requestId: randomUUID(), expectedVersion: selectionBefore.value.version, source });
      assert.equal(selected.status, 200);
      const lazy = (await api('providers')).value.find(item => item.providerId === old.connectionId);
      assert.equal(lazy.version, 0);
      assert.equal(lazy.providerId, old.connectionId);
      assert.deepEqual(lazy.models, [legacy.value]);
      const upgradedInput = revision(lazy, { name: '升级后共享配置' });
      upgradedInput.models[0].enabled = true;
      upgradedInput.models.push(child('new-sibling'));
      let upgraded = await save(upgradedInput);
      assert.equal(upgraded.version, 1);
      assert.equal(upgraded.models[0].version, 2);
      assert.equal(upgraded.models[0].connectionId, old.connectionId);
      assert.equal(upgraded.models[0].routeId, legacy.value.routeId);
      assert.ok(upgraded.models.every(model => model.hasCredential && model.providerId === old.connectionId));
      for (const model of upgraded.models)
        assert.equal((await api(`connections/${model.connectionId}/credential`, { version: model.version })).value.value, key);
      const currentSelection = await api('selection');
      assert.equal(currentSelection.status, 200);
      assert.equal(currentSelection.value.version, selected.value.version);
      assert.equal(currentSelection.value.selected.grantId, grant.value.grantId);
      assert.equal(currentSelection.value.selected.connection.routeId, legacy.value.routeId);
      masked(currentSelection.value); masked(grant.value);
      await send({ ...check(upgraded.models[0]), source: { selected: true, selectionVersion: selected.value.version } });
      const completed = await send(check(upgraded.models[1]));
      assert.equal(received.at(-1).body.model, 'new-sibling');
      // A successful restart runs the owner's validate() against all versions and encrypted bindings.
      await restart();
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === old.connectionId), upgraded);
      assert.deepEqual((await api(`checks/${completed.attemptId}`)).value, completed);
      const afterRestart = await api('selection');
      assert.deepEqual(afterRestart.value, currentSelection.value);
      assert.equal((await api(`connections/${upgraded.models[1].connectionId}/credential`, { version: 1 })).value.value, key);
      upgraded = await save(revision(upgraded, { name: '重启后仍可保存' }));
      assert.equal(upgraded.version, 2);
    });

    await t.test('metadata-only legacy saves preserve absent effort; explicitly choosing model default clears the legacy thinking mode', async () => {
      const old = { requestId: randomUUID(), connectionId: randomUUID(), expectedVersion: 0, name: '旧版思考配置',
        protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com/v1', path: '/chat/completions', modelId: 'deepseek-flash',
        dialect: 'deepseek', parameterMode: 'thinking', enabled: true, credential: { action: 'replace', value: key } };
      const created = await api('connections', old);
      assert.equal(created.status, 200, JSON.stringify(created.value));
      const legacy = (await api('providers')).value.find(item => item.providerId === old.connectionId);
      const metadataOnly = revision(legacy, { name: '仅修改名称' });
      metadataOnly.models[0].enabled = legacy.models[0].enabled;
      delete metadataOnly.models[0].reasoningEffort;
      let saved = await save(metadataOnly);
      assert.equal(saved.models[0].reasoningEffort, undefined);
      assert.equal(saved.models[0].parameterMode, 'thinking');
      assert.equal(saved.models[0].dialect, 'deepseek');
      const explicit = revision(saved);
      explicit.models[0].reasoningEffort = 'auto';
      saved = await save(explicit);
      assert.equal(saved.models[0].reasoningEffort, 'auto');
      assert.equal(saved.models[0].parameterMode, 'plain');
    });

    for (const scope of ['model', 'provider']) await t.test(`a disabled ${scope} cannot be selected through an existing valid grant`, async () => {
      const input = provider(baseUrl);
      if (scope === 'provider') input.enabled = false;
      const saved = await save(input);
      const disabled = saved.models[scope === 'model' ? 1 : 0];
      const grant = await api('grants', { requestId: randomUUID(), grantId: randomUUID(), connectionId: disabled.connectionId, owner: 'self' });
      assert.equal(grant.status, 200);
      const current = await api('selection');
      const result = await api('selection', { requestId: randomUUID(), expectedVersion: current.value.version,
        source: { kind: 'personal', connectionId: disabled.connectionId, grantId: grant.value.grantId } });
      assert.equal(result.status, 503, 'disabled models must be rejected at selection, not only when dispatching');
      assert.deepEqual((await api('selection')).value, current.value, 'rejected selection does not advance the pointer');
    });
  });
});

test('lost PostgreSQL provider COMMIT ACK replays the original receipt without another version or credential', { timeout: 180000 }, async () => {
  let relay;
  try {
    await product(async ({ api, save, runtime, restart, root, baseUrl }) => {
      await runtime.stop();
      const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
      const owner = environment.services.find(service => service.unit === 'model-connection');
      const ref = 'storage-' + owner.serviceId;
      const binding = JSON.parse(await resolveCredential(root, ref));
      relay = await modelCommitRelay(binding.connection.port);
      await writeFile(join(root, 'credentials', ref), JSON.stringify({ ...binding, connection: { ...binding.connection, port: relay.port } }), { mode: 0o600 });
      await runtime.start();
      const input = provider(baseUrl);
      relay.arm('INSERT INTO model_providers');
      const unknown = await api('providers', input);
      assert.equal(relay.cuts(), 1);
      assert.equal(unknown.status, 409, JSON.stringify(unknown.value));
      assert.equal(unknown.value.error, 'commit-unknown');
      const committed = (await api('providers')).value.find(item => item.providerId === input.providerId);
      assert.ok(committed, 'the server confirmed COMMIT before its acknowledgement was cut');
      const replay = await save(input);
      assert.deepEqual(replay, committed);
      assert.equal(replay.version, 1);
      assert.deepEqual(replay.models.map(model => model.version), [1, 1]);
      const next = await save(revision(replay, { name: '后续版本' }));
      assert.deepEqual(await save(input), replay, 'retry returns the original receipt even after a later save');
      assert.equal((await api('providers', { ...input, name: '篡改同请求' })).status, 409);
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === input.providerId), next);
      const client = new pg.Client(binding.connection);
      await client.connect();
      try {
        await client.query('SET search_path TO ' + '"' + binding.schema.replaceAll('"', '""') + '"');
        const { rows: [counts] } = await client.query(`SELECT
          (SELECT count(*)::int FROM model_versions) AS versions,
          (SELECT count(*)::int FROM model_credentials) AS credentials,
          (SELECT count(*)::int FROM _storage_requests WHERE request_id=$1) AS receipts`, [input.requestId]);
        assert.deepEqual(counts, { versions: 4, credentials: 2, receipts: 1 });
      } finally { await client.end(); }
      const remove = revision(next, { models: [], removedModels: next.models.map(removal) });
      relay.arm('INSERT INTO model_providers');
      const removalUnknown = await api('providers', remove);
      assert.equal(relay.cuts(), 2);
      assert.equal(removalUnknown.status, 409, JSON.stringify(removalUnknown.value));
      assert.equal(removalUnknown.value.error, 'commit-unknown');
      const empty = (await api('providers')).value.find(item => item.providerId === input.providerId);
      assert.deepEqual(empty.models, []);
      assert.equal(empty.version, next.version + 1);
      assert.deepEqual(await save(remove), empty);
      const toggled = await save(revision(empty, { enabled: false }));
      assert.equal(toggled.enabled, false);
      assert.deepEqual(await save(remove), empty, 'removal replay returns its original anchor version after a later edit');
      const audit = new pg.Client(binding.connection);
      await audit.connect();
      try {
        await audit.query('SET search_path TO ' + '"' + binding.schema.replaceAll('"', '""') + '"');
        const { rows: [counts] } = await audit.query(`SELECT
          (SELECT count(*)::int FROM model_versions) AS versions,
          (SELECT count(*)::int FROM model_credentials) AS credentials,
          (SELECT count(*)::int FROM model_connections WHERE body @> '{"retired":true}') AS retired,
          (SELECT count(*)::int FROM _storage_requests WHERE request_id=$1) AS receipts`, [remove.requestId]);
        assert.deepEqual(counts, { versions: 7, credentials: 2, retired: 2, receipts: 1 });
      } finally { await audit.end(); }
      await restart();
      assert.deepEqual(await save(input), replay);
      assert.deepEqual(await save(remove), empty);
      assert.deepEqual((await api('providers')).value.find(item => item.providerId === input.providerId), toggled);
    });
  } finally { await relay?.close(); }
});
