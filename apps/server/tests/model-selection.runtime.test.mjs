import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { createServer } from 'node:http';
import pg from 'pg';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
  webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
async function product(run) {
  const root = await mkdtemp(join(tmpdir(), 'xj-model-selection-'));
  const runtime = openProductRuntime({ root, resources });
  try {
    await runtime.install({ profile: 'local' }); const { endpoint, environment } = await runtime.start();
    const api = async (path, body, headers = {}) => {
      const response = await fetch(endpoint + '/api/learning/' + path, { headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const admin = { authorization: 'Bearer ' + await resolveCredential(root, 'control') };
    const member = async loginName => {
      const password = randomUUID();
      const created = await api('manage/members', { requestId: randomUUID(), loginName, password }, admin);
      assert.equal(created.status, 200);
      const response = await fetch(endpoint + '/api/learning/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName, password }) });
      assert.equal(response.status, 200);
      return { identity: created.value, headers: { cookie: response.headers.get('set-cookie').split(';')[0], 'x-xj-space': 'school' } };
    };
    await run({ api, admin, member, runtime, root, modelServiceId: environment.services.find(item => item.unit === 'model-connection').serviceId });
  } finally {
    try { await runtime.stop(); } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
}
const configuration = () => ({ requestId: randomUUID(), connectionId: randomUUID(), expectedVersion: 0, name: '学校文本模型',
  protocol: 'chat-completions', baseUrl: 'https://fixture.invalid/v1', path: '/chat/completions', modelId: 'fixture-model',
  dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'synthetic-school-key' },
  policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 64, timeoutMs: 10000 } });

test('the supported school management entry owns a masked default with durable limits and real member selection', { timeout: 180000 }, async () => {
  await product(async ({ api, admin, member, runtime }) => {
    const alice = await member('selection-alice'), bob = await member('selection-bob');
    const input = configuration();
    assert.equal((await api('manage/model-default', input, alice.headers)).status, 403);
    const saved = await api('manage/model-default', input, admin);
    assert.equal(saved.status, 200);
    assert.equal(saved.value.connection.hasCredential, true);
    assert.equal(JSON.stringify(saved.value).includes(input.credential.value), false);
    const selected = await api('models/selection', undefined, alice.headers);
    assert.equal(selected.status, 200);
    assert.equal(selected.value.version, 0);
    assert.equal(selected.value.selected.kind, 'school');
    assert.equal(selected.value.selected.connection.connectionId, input.connectionId);
    assert.equal(selected.value.selected.policy.maxOutputTokens, 64);
    assert.deepEqual((await api('models/selection', undefined, bob.headers)).value.selected, selected.value.selected);
    assert.equal((await api('manage/model-default', { ...input, requestId: randomUUID(), name: '过期管理写入' }, admin)).status, 409);
    await runtime.stop(); await runtime.start();
    assert.deepEqual((await api('models/selection', undefined, alice.headers)).value, selected.value);
  });
});

test('the supported school-model CLI applies private input and prints only a masked school default', { timeout: 180000 }, async () => {
  await product(async ({ api, member, root }) => {
    const input = configuration(), alice = await member('cli-model-alice');
    const privateFile = join(root, 'school-model-input.json');
    await writeFile(privateFile, JSON.stringify(input), { mode: 0o600 });
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../local-runtime/dist/cli.js', import.meta.url)),
      'school-model', '--root', root, '--file', privateFile], { windowsHide: true, timeout: 30000 });
    assert.equal((stdout + stderr).includes(input.credential.value), false);
    const result = JSON.parse(stdout); assert.equal(result.kind, 'school'); assert.equal(result.connection.hasCredential, true);
    assert.equal((await api('models/selection', undefined, alice.headers)).value.selected.connection.connectionId, input.connectionId);
  });
});

test('measured capability evidence matches the exact endpoint, model and mode instead of a provider name', { timeout: 180000 }, async () => {
  await product(async ({ api }) => {
    const { policy: _policy, ...base } = configuration();
    const headers = { 'x-xj-space': 'personal' };
    const deepseek = await api('models/connections', { ...base, baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-flash', dialect: 'deepseek', parameterMode: 'thinking' }, headers);
    assert.equal(deepseek.status, 200); assert.equal(deepseek.value.capabilities.images, 'verified');
    assert.equal(deepseek.value.capabilities.nativeReplay, 'verified');
    assert.equal(deepseek.value.capabilityEvidence.sdk, 'openai@7.42.0');
    const command = await api('models/connections', { ...base, requestId: randomUUID(), connectionId: randomUUID(),
      baseUrl: 'https://api.commandcode.ai/provider/v1', modelId: 'deepseek/deepseek-v4.1-flash', dialect: 'command-code' }, headers);
    assert.equal(command.value.capabilities.strictSchema, 'unsupported'); assert.equal(command.value.capabilities.jsonMode, 'verified');
    const changed = await api('models/connections', { ...base, requestId: randomUUID(), connectionId: randomUUID(),
      baseUrl: 'https://synthetic.invalid/v1', name: 'DeepSeek 官方', modelId: 'deepseek-flash', dialect: 'deepseek', parameterMode: 'thinking' }, headers);
    assert.equal(changed.value.capabilities.images, 'unknown'); assert.equal(changed.value.capabilityEvidence, undefined);
  });
});

test('school checks fix configuration and costs, enforce the shared limit, and reject dispatch after disable', { timeout: 180000 }, async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '完成' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await product(async ({ api, admin, member }) => {
      const alice = await member('school-check-alice'), bob = await member('school-check-bob');
      const input = { ...configuration(), baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` };
      input.policy.maxChecksPerHour = 2;
      assert.equal((await api('manage/model-default', input, admin)).status, 200);
      const check = () => ({ attemptId: randomUUID(), purpose: 'connection-check', source: { selected: true, selectionVersion: 0 }, limits: { maxOutputTokens: 128, timeoutMs: 30000 } });
      const first = check();
      const accepted = await api('models/checks', first, alice.headers);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.value.source.kind, 'school');
      assert.equal(accepted.value.limits.maxOutputTokens, 64);
      assert.equal(accepted.value.limits.timeoutMs, 10000);
      const updated = { ...input, requestId: randomUUID(), expectedVersion: 1, modelId: 'new-school-model', credential: { action: 'keep' } };
      assert.equal((await api('manage/model-default', updated, admin)).status, 200);
      await api(`models/checks/${first.attemptId}/dispatch`, {}, alice.headers);
      for (let count = 0; count < 100; count++) {
        if ((await api(`models/checks/${first.attemptId}`, undefined, alice.headers)).value.physicalRequestEnded) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(received.length, 1); assert.equal(received[0].model, 'fixture-model');
      const second = check(); const next = await api('models/checks', second, bob.headers);
      assert.equal(next.status, 200); assert.equal(next.value.connection.modelId, 'new-school-model');
      assert.equal(next.value.source.feeSource, accepted.value.source.feeSource);
      assert.equal((await api('models/checks', check(), alice.headers)).status, 503, 'school allowance is shared across its members');
      await api('manage/model-default', { ...updated, requestId: randomUUID(), expectedVersion: 2, enabled: false }, admin);
      assert.equal((await api(`models/checks/${second.attemptId}/dispatch`, {}, bob.headers)).status, 403);
      assert.equal(received.length, 1);
      assert.equal((await api(`models/checks/${first.attemptId}`, undefined, bob.headers)).status, 404);
      assert.equal((await api(`models/checks/${first.attemptId}`, undefined, alice.headers)).value.state, 'completed');
    });
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('personal connection reuse needs explicit subject-scoped grants and revocation blocks pending dispatch without hiding history', { timeout: 180000 }, async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ body: JSON.parse(Buffer.concat(chunks)), authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '个人路线' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await product(async ({ api, admin, member }) => {
      const alice = await member('personal-choice-alice'), bob = await member('personal-choice-bob');
      await api('manage/model-default', configuration(), admin);
      const { policy: _policy, ...input } = configuration();
      input.name = '设备本人连接'; input.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
      input.credential.value = 'synthetic-personal-key';
      assert.equal((await api('models/connections', input, { 'x-xj-space': 'personal' })).status, 200);
      const choose = grantId => ({ requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId: input.connectionId, grantId } });
      assert.equal((await api('models/selection', choose(randomUUID()), alice.headers)).status, 403);
      const grant = await api('models/grants', { requestId: randomUUID(), grantId: randomUUID(), connectionId: input.connectionId, owner: 'device' }, alice.headers);
      assert.equal(grant.status, 200); assert.equal(grant.value.recipient.principalId, alice.identity.principalId);
      assert.equal(JSON.stringify(grant.value).includes(input.credential.value), false);
      assert.equal((await api('models/selection', choose(grant.value.grantId), bob.headers)).status, 403);
      const selected = await api('models/selection', choose(grant.value.grantId), alice.headers);
      assert.equal(selected.status, 200); assert.equal(selected.value.version, 1); assert.equal(selected.value.selected.kind, 'personal');
      assert.equal((await api('models/selection', undefined, bob.headers)).value.selected.kind, 'school');
      const check = () => ({ attemptId: randomUUID(), purpose: 'connection-check', source: { selected: true, selectionVersion: 1 }, limits: { maxOutputTokens: 32, timeoutMs: 5000 } });
      const first = check(); await api('models/checks', first, alice.headers);
      await api(`models/checks/${first.attemptId}/dispatch`, {}, alice.headers);
      for (let count = 0; count < 100; count++) {
        if ((await api(`models/checks/${first.attemptId}`, undefined, alice.headers)).value.physicalRequestEnded) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(received.length, 1); assert.equal(received[0].authorization, 'Bearer synthetic-personal-key');
      const second = check(); await api('models/checks', second, alice.headers);
      const revoked = await api(`models/grants/${grant.value.grantId}/revoke`, { requestId: randomUUID(), expectedVersion: 1 }, { 'x-xj-space': 'personal' });
      assert.equal(revoked.status, 200);
      assert.equal((await api(`models/checks/${second.attemptId}/dispatch`, {}, alice.headers)).status, 403);
      assert.equal((await api('models/checks', check(), alice.headers)).status, 403);
      assert.equal((await api(`models/checks/${first.attemptId}`, undefined, alice.headers)).value.state, 'completed');
      assert.equal((await api(`models/checks/${first.attemptId}`, undefined, bob.headers)).status, 404);
      const unavailable = await api('models/selection', undefined, alice.headers);
      assert.equal(unavailable.value.selected, null); assert.equal(unavailable.value.unavailableReason, 'grant-revoked');
      assert.equal(received.length, 1, 'revocation never switches back to school or resends the original attempt');
    });
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('configured personal models select directly, remain owner-scoped, and survive restart without grants', { timeout: 180000 }, async () => {
  await product(async ({ api, member, runtime, root, modelServiceId }) => {
    const alice = await member('direct-model-alice'), bob = await member('direct-model-bob');
    const { policy: _policy, ...input } = configuration();
    const local = { 'x-xj-space': 'personal' };
    assert.equal((await api('models/connections', input, local)).status, 200);
    const select = (expectedVersion = 0, owner = 'self') => ({ requestId: randomUUID(), expectedVersion,
      source: { kind: 'personal', connectionId: input.connectionId, owner } });
    const personal = await api('models/selection', select(), local);
    assert.equal(personal.status, 200);
    assert.equal(personal.value.selected.origin, 'self');
    assert.equal(personal.value.selected.grantId, undefined);
    assert.equal((await api('models/selection', select(), alice.headers)).status, 404,
      'connection ids do not confer access to another owner');
    assert.equal((await api('models/selection', select(0, 'device'), alice.headers)).status, 403,
      'school webpages cannot claim the server host personal identity');
    const schoolInput = { ...input, requestId: randomUUID(), connectionId: randomUUID() };
    assert.equal((await api('models/connections', schoolInput, alice.headers)).status, 200);
    const schoolSelect = { requestId: randomUUID(), expectedVersion: 0,
      source: { kind: 'personal', connectionId: schoolInput.connectionId, owner: 'self' } };
    assert.equal((await api('models/selection', schoolSelect, bob.headers)).status, 404);
    const schoolSelected = await api('models/selection', schoolSelect, alice.headers);
    assert.equal(schoolSelected.status, 200);
    assert.equal(schoolSelected.value.selected.grantId, undefined);
    await runtime.stop(); await runtime.start();
    assert.deepEqual((await api('models/selection', undefined, local)).value, personal.value);
    const restarted = (await api('models/selection', undefined, alice.headers)).value;
    assert.equal(restarted.version, schoolSelected.value.version);
    assert.deepEqual(restarted.selected, schoolSelected.value.selected);
    assert.equal((await api('models/selection', select(0), local)).status, 409);
    const binding = JSON.parse(await resolveCredential(root, 'storage-' + modelServiceId));
    const client = new pg.Client(binding.connection);
    try {
      await client.connect();
      const schema = '"' + binding.schema.replaceAll('"', '""') + '"';
      const { rows: [counts] } = await client.query(`SELECT (SELECT count(*)::int FROM ${schema}.model_use_grants) AS grants,
        (SELECT count(*)::int FROM ${schema}.model_selections) AS selections`);
      assert.equal(counts.grants, 0, 'direct selections never create model-use grants, including after restart');
      assert.equal(counts.selections, 2);
    } finally { await client.end(); }

  });
});
