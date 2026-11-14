import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentInputSchema } from '@xunjie/contracts/agent-runtime';

test('a home message needs only its own session and current text', () => {
  const input = agentInputSchema.parse({
    requestId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    text: '解释一下递归。',
  });
  assert.equal(input.text, '解释一下递归。');
  assert.equal(input.mode, 'steering');
  assert.deepEqual(input.context, {});
  assert.equal('activityId' in input, false);
});
