import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { resolveMessageImages } from '../dist/message-images.js';

test('message images keep their fixed scope and retained PDF images use the dispatched segment', async () => {
  const identity = { kind: 'personal', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const sessionId = randomUUID(), segmentId = randomUUID();
  const scope = { kind: 'session', sessionId };
  const uploaded = { imageId: randomUUID(), version: 1, sha256: '1'.repeat(64), name: 'pasted.png' };
  const crop = { imageId: randomUUID(), version: 1, sha256: '2'.repeat(64), name: 'selected-region.png' };
  const stored = new Map([[uploaded.imageId, { ...uploaded, attachmentScope: scope }]]);
  const gateway = { images: {
    async upload(actor, image, destination) {
      assert.equal(actor, identity);
      assert.equal(image.requestId, crop.imageId);
      assert.equal(destination, segmentId);
      stored.set(image.imageId, { ...crop, attachmentScope: image.attachmentScope });
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
  assert.deepEqual(await resolveMessageImages(identity, source, segmentId, true, gateway, []),
    [{ imageId: uploaded.imageId, version: 1 }, { imageId: crop.imageId, version: 1 }]);
  await assert.rejects(resolveMessageImages(identity, source, segmentId, false, gateway, []), { code: 'image-input-unavailable' });
  stored.set(uploaded.imageId, { ...uploaded, attachmentScope: { kind: 'session', sessionId: randomUUID() } });
  await assert.rejects(resolveMessageImages(identity, source, segmentId, true, gateway, []), { code: 'image-source-unavailable' });
});
