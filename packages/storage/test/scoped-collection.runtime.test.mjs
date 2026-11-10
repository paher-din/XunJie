import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { provisionStorage, openStorage, createFileBackend } from '@xunjie/storage';
import { nativeFixture } from './native-fixture.mjs';

test('targeted resource cleanup never collects another member staging object or a retained submission', async () => {
  const fixture = await nativeFixture(), migrations = [{ version: 1, name: 'scope-cleanup', sql: 'CREATE TABLE records(id text PRIMARY KEY)' }];
  let storage;
  try {
    const binding = await provisionStorage({ admin: fixture.admin, owner: { environmentId: randomUUID(), serviceId: randomUUID() },
      password: randomUUID(), migrations });
    storage = await openStorage({ binding, migrations, backend: createFileBackend({ id: 'scoped', root: join(fixture.root, 'objects') }) });
    const stage = text => storage.stageResource({ uploadId: randomUUID(), scope: text, bytes: Buffer.from(text), mediaType: 'text/plain', contentVersion: 1 });
    const mine = await stage('migrated private original'), other = await stage('other member pending upload'), retained = await stage('submitted original');
    await storage.request({ requestId: randomUUID(), fingerprint: 'retained' }, tx => tx.reference('submission/one', retained.resourceId));
    const olderThan = new Date(Date.now() + 60000);
    assert.deepEqual(await storage.collect({ olderThan, resourceIds: [] }), []);
    assert.deepEqual(await storage.collect({ olderThan, resourceIds: [mine.resourceId, retained.resourceId] }), [mine.resourceId]);
    assert.equal(Buffer.from(await storage.readResource(other.resourceId)).toString(), 'other member pending upload');
    assert.equal(Buffer.from(await storage.readResource(retained.resourceId)).toString(), 'submitted original');
    await assert.rejects(storage.readResource(mine.resourceId), error => ['resource-gone', 'missing'].includes(error.code));
  } finally { if (storage) await storage.close(); await fixture.close(); }
});
