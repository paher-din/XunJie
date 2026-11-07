import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { teachingEventSchema } from '@xunjie/contracts/teaching-agent';

test('explicitly ignorable extensions retain their original payload while unknown required event formats fail closed', () => {
  const event = { activityId: randomUUID(), seq: 12, eventId: randomUUID(), kind: 'extension', version: 1,
    body: { ignorable: true, extensionId: 'org.example.study-note', extensionVersion: 7,
      payload: { original: '保留原件，不按当前配置重写。', nested: [1, null, { future: true }] }, extra: 'unrecognized-but-retained' },
    createdAt: '2026-11-07T00:00:00.000Z' };
  assert.deepEqual(teachingEventSchema.parse(event), event);
  assert.equal(teachingEventSchema.safeParse({ ...event, body: { ...event.body, ignorable: false } }).success, false);
  assert.equal(teachingEventSchema.safeParse({ ...event, kind: 'future-required' }).success, false);
  assert.equal(teachingEventSchema.safeParse({ ...event, version: 2 }).success, false);
  assert.equal(teachingEventSchema.safeParse({ ...event, kind: 'run-completed', version: 2 }).success, false);
});
