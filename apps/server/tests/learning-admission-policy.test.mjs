import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLearningAdmissionPolicy, learningAdmissionPolicySchema, learningFinalUnits, learningReservationUnits }
  from '../../../packages/model-gateway/src/learning-admission.ts';

test('learning billing requires final complete counters and preserves real zero without double counting cache/reasoning', () => {
  assert.equal(learningFinalUnits({ state: 'unknown' }), null);
  assert.equal(learningFinalUnits({ state: 'partial', inputTokens: 5, outputTokens: 7 }), null);
  assert.equal(learningFinalUnits({ state: 'final', totalTokens: 0 }), null);
  assert.equal(learningFinalUnits({ state: 'final', inputTokens: 0, outputTokens: 0 }), 0);
  assert.equal(learningFinalUnits({ state: 'final', inputTokens: 12, outputTokens: 8, cachedTokens: 10, reasoningTokens: 7 }), 20);
  assert.equal(learningFinalUnits({ state: 'final', inputTokens: 12, outputTokens: 8, totalTokens: 25 }), 25);
});

test('learning reservations include Unicode request bytes and finite versioned production policy', () => {
  assert.ok(learningReservationUnits({ input: '学习' }, 100) > 4106);
  assert.ok(learningReservationUnits({ input: '学习' }, 100) > learningReservationUnits({ input: 'ab' }, 100));
  assert.equal(learningAdmissionPolicySchema.parse(defaultLearningAdmissionPolicy).maxPrincipalPhysical, 1);
  assert.equal(learningAdmissionPolicySchema.safeParse({ ...defaultLearningAdmissionPolicy, feeBudgetTokens: Infinity }).success, false);
  assert.equal(learningAdmissionPolicySchema.safeParse({ ...defaultLearningAdmissionPolicy, version: '' }).success, false);
});
