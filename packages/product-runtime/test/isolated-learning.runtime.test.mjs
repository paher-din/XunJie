import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openProductRuntime, restoreProductRecovery } from '@xunjie/product-runtime';

test('the normal product opens restored learning data read-only without enabling experiments', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xunjie-176-isolated-product-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
    ...(process.platform === 'win32' ? { windowsPrerequisitePath:
      fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } : {}),
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)) };
  assert.ok(resources.postgresBin, 'Provide the pinned native PostgreSQL distribution.');
  const source = openProductRuntime({ root: join(directory, 'source'), resources });
  const target = openProductRuntime({ root: join(directory, 'target'), resources });
  const key = randomBytes(32);
  let restored;
  async function request(endpoint, route, body) {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json() };
  }
  try {
    await source.install({ profile: 'local' });
    const running = await source.start();
    const original = await request(running.endpoint, 'context');
    assert.equal(original.status, 200);
    const connection = await request(running.endpoint, 'models/connections', {
      requestId: randomUUID(), connectionId: randomUUID(), expectedVersion: 0, name: '隔离恢复保留的模型',
      protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:9/v1', path: '/chat/completions',
      modelId: 'synthetic-no-dispatch', dialect: 'standard', parameterMode: 'plain', enabled: true,
      credential: { action: 'replace', value: 'synthetic-isolated-key' },
    });
    assert.equal(connection.status, 200, JSON.stringify(connection.value));
    const connections = await request(running.endpoint, 'models/connections');
    const selection = await request(running.endpoint, 'models/selection');
    assert.equal(selection.status, 200);
    const created = await request(running.endpoint, 'activities', {
      requestId: randomUUID(), goal: '恢复后从原学习入口阅读作品', question: '', references: [],
    });
    assert.equal(created.status, 200);
    const activity = created.value;
    const files = [{ objectId: randomUUID(), contentId: randomUUID(), name: 'notes.txt', kind: 'text',
      encoding: 'utf8', mediaType: 'text/plain', value: '隔离还原保留原作品内容' }];
    const saved = await request(running.endpoint, `workspaces/${activity.activityId}`, {
      requestId: randomUUID(), baseRevision: 0, files,
    });
    assert.equal(saved.status, 200);
    await source.setCredential('test-recovery-key', key.toString('base64'));
    const manifest = await source.recovery.backup({ directory: join(directory, 'backups'),
      recoveryKeyRef: 'test-recovery-key', leaveClosed: true });
    restored = await restoreProductRecovery({ root: join(directory, 'target'),
      backupDirectory: join(directory, 'backups', manifest.backupId), key, resources });
    for (const owner of restored.owners) await owner.close?.();
    restored = undefined;
    const isolated = await target.start();
    assert.equal(isolated.state, 'maintenance');
    assert.match(await (await fetch(isolated.endpoint)).text(), /循阶/);
    const context = await request(isolated.endpoint, 'context');
    assert.equal(context.status, 200, JSON.stringify(context.value));
    assert.equal(context.value.readOnly, true);
    assert.notEqual(context.value.clientNamespace, original.value.clientNamespace);
    assert.deepEqual(context.value.identities, original.value.identities);
    const activities = await request(isolated.endpoint, 'activities');
    assert.equal(activities.status, 200);
    assert.equal(activities.value[0].activityId, activity.activityId);
    const works = await request(isolated.endpoint, `workspaces/${activity.activityId}`);
    assert.equal(works.status, 200);
    assert.deepEqual(works.value.files, files);
    for (const [route, expected] of [['models/connections', connections.value], ['models/selection', selection.value]]) {
      const models = await request(isolated.endpoint, route);
      assert.equal(models.status, 200, JSON.stringify(models.value));
      assert.deepEqual(models.value, expected);
    }
    for (const [route, body] of [
      ['activities', { requestId: randomUUID(), goal: 'must not create', question: '', references: [] }],
      [`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 1, files: [] }],
      [`executions/${activity.activityId}`, {}], ['native-channel/claim', {}],
      ['client/start', {}], ['execution-environment', undefined],
      ['models/connections', {}], ['models/checks', {}],
    ]) assert.equal((await request(isolated.endpoint, route, body)).status, 503, route);
    assert.deepEqual((await request(isolated.endpoint, `workspaces/${activity.activityId}`)).value, works.value);
    await assert.rejects(target.recovery.resume(), { code: 'target-isolated' });
    await target.recovery.takeover({ sourceRoot: join(directory, 'source'), receivers: [] });
    const newActivity = { requestId: randomUUID(), goal: '当前握手后的新活动', question: '', references: [] };
    assert.equal((await request(isolated.endpoint, 'activities', newActivity)).status, 403, 'missing namespace cannot write to a recovered installation');
    for (const [namespace, expected] of [[original.value.clientNamespace, 403], [context.value.clientNamespace, 200]]) {
      const response = await fetch(new URL('/api/learning/activities', isolated.endpoint), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', 'x-xj-namespace': namespace },
        body: JSON.stringify(newActivity),
      });
      assert.equal(response.status, expected);
    }
  } finally {
    for (const owner of restored?.owners ?? []) await owner.close?.();
    await Promise.allSettled([source.stop(), target.stop()]);
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
