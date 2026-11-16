import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorkspaceAgentAuthority } from '../../packages/product-runtime/dist/workspace-agent-authority.js';

test('workspace authority resolves the retained Session instead of the first Session for an activity', async () => {
  const activityId = randomUUID(), identity = { kind: 'personal', name: 'Authority regression', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const first = { sessionId: randomUUID(), workspace: { activityId } };
  const actual = { sessionId: randomUUID(), workspace: { activityId } };
  const other = { sessionId: randomUUID(), workspace: { activityId: randomUUID() } };
  const association = { sessionId: actual.sessionId, runId: randomUUID(), stepId: randomUUID(), commandId: randomUUID(), snapshotId: randomUUID() };
  const full = { turns: [{ turnId: association.runId, state: 'active' }], steps: [{ stepId: association.stepId, turnId: association.runId }],
    toolCalls: [{ toolCallId: association.commandId, stepId: association.stepId, state: 'closed', executionMode: 'background', result: { kind: 'accepted' } }] };
  const reads = [], dispatched = [];
  const authority = createWorkspaceAgentAuthority({
    activity: async () => ({ status: 'open' }), sessions: async () => [first, other, actual],
    agent: async session => ({ sessionSnapshot: async (_who, id) => {
      reads.push(id); return session === first ? { turns: [], steps: [], toolCalls: [] } : full;
    }, assertDispatch: async (_who, permit) => { dispatched.push(permit); } }),
  });
  await authority.assertDispatch(identity, activityId, association);
  assert.deepEqual(reads, [actual.sessionId]);
  assert.equal(dispatched[0].sessionId, actual.sessionId);
  await authority.assertTaskDispatch(identity, activityId, association);
  const { sessionId: _sessionId, ...legacy } = association;
  reads.length = 0;
  await authority.assertTaskDispatch(identity, activityId, legacy);
  assert.deepEqual(reads, [first.sessionId, actual.sessionId], 'legacy association searches the retained Turn');
  for (const sessionId of [first.sessionId, other.sessionId, randomUUID()])
    await assert.rejects(() => authority.assertDispatch(identity, activityId, { ...association, sessionId }), { code: 'forbidden' });
  full.steps[0].turnId = randomUUID();
  await assert.rejects(() => authority.assertDispatch(identity, activityId, association), { code: 'forbidden' });
});
