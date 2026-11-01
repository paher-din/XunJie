import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, restoreProductRecovery, resolveCredential } from '@xunjie/product-runtime';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Set XUNJIE_PRODUCT_POSTGRES_BIN to PostgreSQL 18.6 bin.');
test('production activity works retain Chinese source and stable object/content identities', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-works-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresVersion: '18.6', postgresBin, webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  try {
    await runtime.install({ profile: 'local' });
    const status = await runtime.start();
    const send = async (path, body) => {
      const response = await fetch(new URL('/api/learning/' + path, status.endpoint), { headers: {
        'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return response;
    };
    const api = async (path, body) => {
      const response = await send(path, body);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const activity = await api('activities', { requestId: randomUUID(), goal: '编辑作品', question: '', references: [] });
    const path = 'workspaces/' + activity.activityId;
    assert.deepEqual(await api(path), { revision: 0, files: [] });
    const file = { objectId: randomUUID(), name: '递归.c', kind: 'code', contentId: randomUUID(),
      encoding: 'utf8', mediaType: 'text/plain', value: '\ufeff// 中文\r\nint main() {\r\n  return 0;\r\n}\r\n' };
    const input = { requestId: randomUUID(), baseRevision: 0, files: [file] };
    const result = await api(path, input);
    assert.deepEqual(result, { revision: 1, files: [file] });
    assert.deepEqual(await api(path, input), result);
    assert.deepEqual(await api(path + '/receipts/' + input.requestId), result);
    const renamed = await api(path, { requestId: randomUUID(), baseRevision: 1, files: [{ ...file, name: '主程序.c' }] });
    assert.equal(renamed.files[0].objectId, file.objectId);
    assert.equal(renamed.files[0].contentId, file.contentId);
    assert.equal((await send(path, { ...input, files: [{ ...file, value: '改变原请求' }] })).status, 409);
    const attempts = await Promise.all(['客户端甲', '客户端乙'].map(value => send(path, {
      requestId: randomUUID(), baseRevision: 2, files: [{ ...renamed.files[0], contentId: randomUUID(), value }] })));
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
    const winner = await attempts.find(r => r.status === 200).json();
    assert.ok(['客户端甲', '客户端乙'].includes(winner.files[0].value));
    assert.equal((await api(path + '/contents/' + file.contentId)).value, file.value);
    const deleted = await api(path, { requestId: randomUUID(), baseRevision: winner.revision, files: [] });
    assert.equal((await send(path, { requestId: randomUUID(), baseRevision: deleted.revision, files: [file] })).status, 409,
      'a deleted object identity cannot be silently recycled as a new same-name object');
    const recreated = { ...file, objectId: randomUUID(), contentId: randomUUID() };
    const state = { objectId: randomUUID(), contentId: randomUUID(), name: '组件状态', kind: 'state',
      encoding: 'json', mediaType: 'application/json', value: '{"中文状态":[1,true]}' };
    const binary = { objectId: randomUUID(), contentId: randomUUID(), name: '资源.bin', kind: 'resource',
      encoding: 'base64', mediaType: 'application/octet-stream', value: Buffer.from('中文资源\n'.repeat(20000)).toString('base64') };
    const latest = await api(path, { requestId: randomUUID(), baseRevision: deleted.revision, files: [recreated, state, binary] });
    assert.notEqual(recreated.objectId, file.objectId);
    assert.equal((await api(path + '/contents/' + file.contentId)).value, file.value);
    const other = await api('activities', { requestId: randomUUID(), goal: '另一个活动', question: '', references: [] });
    assert.equal((await send('workspaces/' + other.activityId + '/contents/' + file.contentId)).status, 404);
    const password = randomUUID();
    const managed = await fetch(new URL('/api/learning/manage/members', status.endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await resolveCredential(root, 'control') },
      body: JSON.stringify({ requestId: randomUUID(), loginName: 'works-other-member', password }) });
    assert.equal(managed.status, 200);
    const login = await send('login', { loginName: 'works-other-member', password });
    assert.equal(login.status, 200);
    const denied = await fetch(new URL('/api/learning/' + path, status.endpoint), { headers: {
      'x-xj-space': 'school', cookie: login.headers.get('set-cookie').split(';')[0] } });
    assert.equal(denied.status, 404, 'a real different member cannot read this workspace');
    const staleIdentity = await fetch(new URL('/api/learning/' + path, status.endpoint), { headers: {
      'x-xj-space': 'personal', 'x-xj-expected-subject': randomUUID() } });
    assert.equal(staleIdentity.status, 403);
    await runtime.stop(); await runtime.start();
    assert.deepEqual(await api(path), latest);
    const sourceNamespace = (await runtime.status()).environment.clientNamespace;
    const key = randomBytes(32), directory = await mkdtemp(join(tmpdir(), 'xj-works-backup-'));
    await runtime.setCredential('works-recovery-key', key.toString('base64'));
    const manifest = await runtime.recovery.backup({ directory, recoveryKeyRef: 'works-recovery-key', leaveClosed: true });
    const targetRoot = await mkdtemp(join(tmpdir(), 'xj-works-restored-'));
    const target = openProductRuntime({ root: targetRoot, resources });
    try {
      const restored = await restoreProductRecovery({ root: targetRoot, resources,
        backupDirectory: join(directory, manifest.backupId), key });
      for (const owner of restored.owners) await owner.close?.();
      const isolated = await target.start();
      assert.equal(isolated.state, 'maintenance');
      await target.recovery.takeover({ sourceRoot: root, receivers: [] });
      const restoredApi = async suffix => {
        const response = await fetch(new URL('/api/learning/' + path + suffix, isolated.endpoint), { headers: { 'x-xj-space': 'personal' } });
        assert.equal(response.status, 200); return response.json();
      };
      assert.deepEqual(await restoredApi(''), latest);
      assert.deepEqual(await restoredApi('/receipts/' + input.requestId), result);
      assert.equal((await restoredApi('/contents/' + file.contentId)).value, file.value);
      assert.equal((await fetch(new URL('/api/learning/' + path, isolated.endpoint), { headers: {
        'x-xj-space': 'personal', 'x-xj-namespace': sourceNamespace } })).status, 403);
    } finally { await target.stop().catch(() => {}); }
  } finally { await runtime.stop().catch(() => {}); }
});
