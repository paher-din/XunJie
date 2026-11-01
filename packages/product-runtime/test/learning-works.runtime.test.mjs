import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime';

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;

/** A fixed basis registered for a pending action must survive an older manifest that lands afterwards;
 *  only objects that really leave the editable head are tombstoned. */
test('a fixed basis registered before an older manifest lands stays publishable, while an explicit removal still deletes',
  { timeout: 180000, skip: !postgresBin && 'Requires native PostgreSQL 18.6.' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-learning-works-'));
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../../apps/web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) };
  const runtime = openProductRuntime({ root, resources });
  let host;
  try {
    await runtime.install({ profile: 'local' });
    host = await createProductRuntimeHost({ root, createApplication: createProductLearningApplication });
    const call = (path, body) => fetch(new URL('/api/learning/' + path, host.endpoint), { headers: {
      'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const api = async (path, body) => {
      const response = await call(path, body);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const activity = await api('activities', { requestId: randomUUID(), goal: '固定依据后继续编辑', question: '', references: [] });
    const path = 'workspaces/' + activity.activityId;
    assert.deepEqual(await api(path), { revision: 0, files: [] });
    const oldFile = { objectId: randomUUID(), name: 'old.c', kind: 'code', contentId: randomUUID(),
      encoding: 'utf8', mediaType: 'text/plain', value: 'int main() {\n  return 0;\n}\n' };
    const oldUpdated = { ...oldFile, contentId: randomUUID(), value: 'int main() {\n  return 1;\n}\n' };
    const newFile = { objectId: randomUUID(), name: 'new.c', kind: 'code', contentId: randomUUID(),
      encoding: 'utf8', mediaType: 'text/plain', value: 'int helper(void);\n' };
    const first = await api(path, { requestId: randomUUID(), baseRevision: 0, files: [oldFile] });
    assert.equal(first.revision, 1);
    const identity = (await api('context')).identities.find(item => item.key === 'personal').identity;
    // The pending action registers fixed bytes for both files without advancing the head.
    const prepared = await api('intents/' + activity.activityId, { requestId: randomUUID(),
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId,
        activityId: activity.activityId },
      receiver: { receiverId: 'future-agent', location: 'remote', kind: 'question' },
      draft: { token: 't', question: '', references: [], bases: [] }, works: [oldUpdated, newFile], evidence: [] });
    assert.equal(prepared.state, 'prepared');
    const second = await api(path, { requestId: randomUUID(), baseRevision: 1, files: [oldUpdated] });
    assert.equal(second.revision, 2);
    const third = await api(path, { requestId: randomUUID(), baseRevision: 2, files: [oldUpdated, newFile] });
    assert.equal(third.revision, 3, 'the newest manifest must not be refused by a tombstone on an unpublished fixed basis');
    assert.deepEqual(third.files.map(file => file.name).sort(), ['new.c', 'old.c']);
    assert.deepEqual(await api(path), third);
    // Removing an object that really was in the previous manifest still deletes it.
    const fourth = await api(path, { requestId: randomUUID(), baseRevision: 3, files: [oldUpdated] });
    assert.equal(fourth.revision, 4);
    assert.deepEqual((await api(path)).files.map(file => file.name), ['old.c']);
  } finally {
    await host?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
