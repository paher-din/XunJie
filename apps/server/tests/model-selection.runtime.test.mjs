import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { createServer } from 'node:http';

const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
  webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
  windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
if (!resources.postgresBin) throw new Error('Requires native PostgreSQL 18.6.');
async function product(run) {
  const root = await mkdtemp(join(tmpdir(), 'xj-model-selection-'));
  const runtime = openProductRuntime({ root, resources });
  try {
    await runtime.install({ profile: 'local' }); const { endpoint } = await runtime.start();
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
    await run({ api, admin, member, runtime });
  } finally { await runtime.stop(); }
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
