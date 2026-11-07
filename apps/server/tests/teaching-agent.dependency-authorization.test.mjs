import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StorageError } from '@xunjie/storage';
import { createTeachingDependencyClient, createTeachingDependencyService } from '@xunjie/learning-space';

test('bounded activity authorization checks current activity access without transferring its contents', async () => {
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'school', name: 'School' };
  const activityId = randomUUID();
  let allowed = true, reads = 0;
  const service = createTeachingDependencyService({ authorize: async () => {}, identityFor: async () => identity,
    activity: async (actor, id) => {
      assert.deepEqual(actor, identity); assert.equal(id, activityId); reads++;
      if (!allowed) throw new StorageError('forbidden');
      return { contents: 'large activity material'.repeat(100000) };
    }, models: {}, tools: {} });
  const client = createTeachingDependencyClient(async input => {
    const result = await service(input);
    assert.deepEqual(result, { authorized: true });
    return result;
  });
  await client.authorizeActivity(identity, activityId);
  allowed = false;
  await assert.rejects(client.authorizeActivity(identity, activityId), { code: 'forbidden' });
  assert.equal(reads, 2);
});
