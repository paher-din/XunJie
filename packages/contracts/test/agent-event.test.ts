import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentEventSchema } from '@xunjie/contracts/agent-runtime';

test('module event facts retain their original payload while unsupported envelope versions fail closed', () => {
  const event = { sessionId: randomUUID(), seq: 12, eventId: randomUUID(), kind: 'extension', version: 1,
    body: { ignorable: true, extensionId: 'org.example.study-note', extensionVersion: 7,
      payload: { original: '保留原件，不按当前配置重写。', nested: [1, null, { future: true }] }, extra: 'unrecognized-but-retained' },
    createdAt: '2026-11-07T00:00:00.000Z' };
  assert.deepEqual(agentEventSchema.parse(event), event);
  assert.deepEqual(agentEventSchema.parse({ ...event, kind: 'module.note' }).body, event.body);
  assert.equal(agentEventSchema.safeParse({ ...event, version: 2 }).success, false);
  assert.equal(agentEventSchema.safeParse({ ...event, kind: 'run-completed', version: 2 }).success, false);
});
