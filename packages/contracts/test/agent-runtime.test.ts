import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentInputSchema, agentToolResultSchema, defaultAgentTurnBudget } from '@xunjie/contracts/agent-runtime';

test('a home message needs only its own session and current text', () => {
  const input = agentInputSchema.parse({
    requestId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    text: '解释一下递归。',
  });
  assert.equal(input.text, '解释一下递归。');
  assert.deepEqual(input.context, {});
  assert.equal('mode' in input, false);
  assert.equal('activityId' in input, false);
});

test('Turn budget defaults are the fixed plan limits', () => {
  assert.equal(defaultAgentTurnBudget.maxSteps, 16);
  assert.equal(defaultAgentTurnBudget.maxToolCalls, 64);
  assert.equal(defaultAgentTurnBudget.maxInputTokens, 1_048_576);
  assert.equal(defaultAgentTurnBudget.maxOutputTokens, 65_536);
  assert.equal(defaultAgentTurnBudget.maxCallMs, 600_000);
  assert.equal(defaultAgentTurnBudget.hardDeadlineMs, 86_400_000);
});

test('tool results keep five explicit kinds and never reuse one shape', () => {
  for (const result of [
    { kind: 'completed', outcome: 'success', summary: 'done' },
    { kind: 'accepted', taskId: 'task-1', summary: 'accepted' },
    { kind: 'interrupted', reason: 'stopped' },
    { kind: 'not_started', reason: 'cancelled' },
    { kind: 'outcome_unknown', reason: 'transport lost', taskId: 'task-1' },
  ]) assert.deepEqual(agentToolResultSchema.parse(result), result);
  for (const invalid of [
    { state: 'accepted', continuation: true, feedback: { outcome: 'success', text: '', images: [] } },
    { kind: 'accepted', taskId: 'task-1', summary: 'accepted', wait: { kind: 'fixture' } },
    { kind: 'completed', outcome: 'ok', summary: '' },
  ]) assert.equal(agentToolResultSchema.safeParse(invalid).success, false);
});
