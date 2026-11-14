import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agentSessionSchema, createAgentSessionSchema, updateAgentSessionSchema } from '../dist/agent-sessions.js';

test('home sessions need stable request/session ids but never a browser-supplied owner or activity', () => {
  const input = { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant' };
  assert.deepEqual(createAgentSessionSchema.parse(input), input);
  assert.equal(createAgentSessionSchema.safeParse({ ...input, sessionId: undefined }).success, false);
  assert.equal(createAgentSessionSchema.safeParse({ ...input, owner: {} }).success, false);
});

test('workspace sessions require an explicit activity and learning target; home sessions cannot smuggle one', () => {
  const base = { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'workspace-assistant' };
  const workspace = { activityId: randomUUID(), target: { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 } };
  assert.equal(createAgentSessionSchema.safeParse(base).success, false);
  assert.deepEqual(createAgentSessionSchema.parse({ ...base, workspace, title: '  项目讨论  ' }),
    { ...base, workspace, title: '项目讨论' });
  assert.equal(createAgentSessionSchema.safeParse({ ...base, workspace, scenario: 'student-assistant' }).success, false);
  assert.equal(createAgentSessionSchema.safeParse({ ...base, workspace: { activityId: workspace.activityId } }).success, false);
});

test('the directory record retains the complete owner descriptor and initialization lifecycle', () => {
  const session = { requestId: randomUUID(), sessionId: randomUUID(),
    identity: { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'Robert' },
    scenario: 'student-assistant', owner: { version: 1, connectionId: randomUUID(), installationId: randomUUID(),
      grantId: randomUUID(), executionGrantId: randomUUID(), delivery: 'service',
      target: { environmentId: randomUUID(), serviceId: randomUUID(), unit: 'teaching-agent',
        endpoint: 'https://agent.example.test', protocolVersion: 1, capabilities: [] } },
    title: null, pinned: false, archived: false, deleted: false, state: 'initializing',
    readyAt: null, createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z' };
  assert.deepEqual(agentSessionSchema.parse(session), session);
  assert.equal(agentSessionSchema.safeParse({ ...session, owner: { serviceId: randomUUID() } }).success, false);
  assert.equal(agentSessionSchema.safeParse({ ...session, state: 'ready' }).success, false);
  assert.equal(agentSessionSchema.safeParse({ ...session, readyAt: session.createdAt }).success, false);
  const update = { requestId: randomUUID(), sessionId: session.sessionId, title: '新标题', pinned: true, archived: true, deleted: true };
  assert.deepEqual(updateAgentSessionSchema.parse(update), update);
  assert.equal(updateAgentSessionSchema.safeParse({ ...update, owner: session.owner }).success, false);
  assert.equal(updateAgentSessionSchema.safeParse({ requestId: update.requestId, sessionId: update.sessionId }).success, false);
});
