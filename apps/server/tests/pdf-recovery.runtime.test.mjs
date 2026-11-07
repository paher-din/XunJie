import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProductRuntime, restoreProductRecovery } from '@xunjie/product-runtime';
import { pdfRuntime, modelReply } from './fixtures/pdf-runtime.mjs';

test('formal backup restores PDF originals, used pages, actions and model evidence without conversion or generation', { timeout: 300000 }, async () => {
  let referenceId;
  const f = await pdfRuntime((_payload, index, protocol) => modelReply(protocol, index === 1
    ? { id: 'pdf-backup-read', name: 'read_reference', arguments: { referenceId } } : null));
  referenceId = f.reference.referenceId;
  const directory = await mkdtemp(join(tmpdir(), 'xj-pdf-backup-218-'));
  let restored, target;
  try {
    const conversation = await f.completed(await f.send());
    const route = `pdf/${f.activity.activityId}`;
    const original = await f.api(route + '/originals/' + f.document.documentId);
    const action = await f.api(`intents/${f.activity.activityId}/${f.input.requestId}`);
    const key = randomBytes(32);
    await f.runtime.setCredential('pdf-recovery-key', key.toString('base64'));
    const backup = await f.runtime.recovery.backup({ directory, recoveryKeyRef: 'pdf-recovery-key', leaveClosed: true });
    restored = await restoreProductRecovery({ root: join(directory, 'target'), resources: f.resources,
      backupDirectory: join(directory, backup.backupId), key });
    for (const owner of restored.owners) await owner.close?.(); restored = undefined;
    target = openProductRuntime({ root: join(directory, 'target'), resources: f.resources });
    const state = await target.start();
    assert.equal(state.state, 'maintenance');
    const read = async path => {
      const response = await fetch(state.endpoint + '/api/learning/' + path, { headers: { 'x-xj-space': 'personal' } });
      assert.equal(response.status, 200, path); return response.json();
    };
    assert.deepEqual(await read(route + '/originals/' + f.document.documentId), original);
    assert.deepEqual(await read(route + '/reads/' + f.reading.readingId), f.reading);
    assert.deepEqual(await read(`intents/${f.activity.activityId}/${f.input.requestId}`), action);
    const after = await read(`agent/${f.activity.activityId}/conversation`);
    assert.deepEqual(after.tools, conversation.tools);
    assert.deepEqual(after.messages, conversation.messages);
    assert.equal(f.payloads.length, 2, 'Isolated restore and source browsing never invoke the provider.');
    const write = await fetch(state.endpoint + '/api/learning/' + route + '/read', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' }, body: JSON.stringify({
        requestId: f.reading.readingId, documentId: f.document.documentId, pages: [2], region: null }) });
    assert.equal(write.status, 503, 'Isolated restore cannot dispatch another conversion.');
  } finally {
    for (const owner of restored?.owners ?? []) await owner.close?.();
    await target?.stop(); await f.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
