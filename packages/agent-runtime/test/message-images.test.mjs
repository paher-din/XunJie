import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { resolveMessageImages } from '../dist/message-images.js';
import { StorageError } from '@xunjie/storage';
import { operationId } from '@xunjie/storage/identity';

test('message images and PDF crops follow the dispatched segment and can be restored from the fixed source', async () => {
  const identity = { kind: 'personal', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const sessionId = randomUUID(), segmentId = randomUUID();
  const scope = { kind: 'session', sessionId };
  const uploaded = { imageId: randomUUID(), version: 1, sha256: '1'.repeat(64), name: 'pasted.png' };
  const crop = { imageId: randomUUID(), version: 1, sha256: '2'.repeat(64), name: 'selected-region.png' };
  const stored = new Map();
  const requests = [];
  let attachmentScope = scope;
  const gateway = { images: {
    async readAttachment(actor, reference, requestedScope) {
      assert.equal(actor, identity);
      assert.deepEqual(reference, { imageId: uploaded.imageId, version: 1 });
      if (attachmentScope.sessionId !== requestedScope.sessionId) throw new StorageError('forbidden');
      return { sha256: uploaded.sha256, dataBase64: 'AQ==' };
    },
    async upload(actor, image, destination) {
      assert.equal(actor, identity);
      assert.equal(image.requestId, image.imageId);
      requests.push(destination);
      const sha256 = image.dataBase64 === 'AQ==' ? uploaded.sha256 : crop.sha256;
      stored.set(image.imageId, { imageId: image.imageId, version: 1, sha256, attachmentScope: image.attachmentScope });
    },
    async read(actor, { imageId }) { assert.equal(actor, identity); return stored.get(imageId); },
  } };
  const source = {
    async resolve({ segmentId: chosenSegment, includeRetained }) {
      assert.equal(chosenSegment, segmentId);
      return { scope, images: [uploaded], ...(includeRetained ? { retained: [{ image: crop, dataBase64: 'AA==' }] } : {}) };
    },
    async assertActive() {},
  };
  assert.deepEqual(await resolveMessageImages(identity, source, segmentId, true, gateway, []), [
    { imageId: operationId(`agent-message-image:${segmentId}:${uploaded.imageId}:1`), version: 1 },
    { imageId: crop.imageId, version: 1 },
  ]);
  assert.deepEqual(requests, [segmentId, segmentId]);
  const nextSegment = randomUUID();
  const later = { ...source, async resolve() {}, async restore() { return { scope, images: [uploaded] }; } };
  assert.deepEqual(await resolveMessageImages(identity, later, nextSegment, true, gateway, [], true), [
    { imageId: operationId(`agent-message-image:${nextSegment}:${uploaded.imageId}:1`), version: 1 },
  ]);
  assert.deepEqual(await resolveMessageImages(identity, later, nextSegment, false, gateway, [], true), []);
  await assert.rejects(resolveMessageImages(identity, source, segmentId, false, gateway, []), { code: 'image-input-unavailable' });
  attachmentScope = { kind: 'session', sessionId: randomUUID() };
  await assert.rejects(resolveMessageImages(identity, source, segmentId, true, gateway, []), { code: 'image-source-unavailable' });
});
