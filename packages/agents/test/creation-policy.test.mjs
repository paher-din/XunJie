import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { verifyProjectCreation } from '../src/student-assistant/creation-policy.ts';

const content = { title: '排序实践', goal: '理解排序', stages: ['设计', '实现'], materialRefs: [] };
const proposalKey = 'proposal-1';
const identity = { kind: 'personal', name: '学生', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
const ctx = (inputIds = [], visibleAnswerInputIds = []) => ({ sessionId: randomUUID(), turnId: randomUUID(), inputIds, visibleAnswerInputIds });

function record(overrides = {}) {
  return { questionId: randomUUID(), version: 1, state: 'answered', purpose: 'create_personal_project',
    proposalKey, personalProjectContent: content,
    question: '是否创建排序实践项目？', options: [{ id: 'confirm', label: '同意创建' }, { id: 'decline', label: '暂不创建' }],
    allowText: true, skippable: true, createdAt: new Date().toISOString(),
    answer: { kind: 'choice', optionId: 'confirm' }, sourceInputId: randomUUID(), answerInputId: randomUUID(), ...overrides };
}
const port = records => ({ async findByProposal() { return records; } });

test('§8.1 固定 confirm 且内容匹配 → 允许创建', async () => {
  const decision = await verifyProjectCreation(ctx(), identity, content, proposalKey, port([record()]));
  assert.equal(decision.kind, 'allow');
  assert.equal(decision.basis, 'confirm');
});

test('§8.1 暂不创建/拒绝 → declined，不创建', async () => {
  const decision = await verifyProjectCreation(ctx(), identity, content, proposalKey,
    port([record({ answer: { kind: 'choice', optionId: 'decline' } })]));
  assert.equal(decision.kind, 'declined');
});

test('§8.1 跳过/关闭/到期 → declined，不构成同意', async () => {
  for (const state of ['skipped', 'closed', 'expired']) {
    const decision = await verifyProjectCreation(ctx(), identity, content, proposalKey,
      port([record({ state, answer: null })]));
    assert.equal(decision.kind, 'declined', state);
  }
});

test('§8.1 问题未回答 → confirmation_required', async () => {
  const decision = await verifyProjectCreation(ctx(), identity, content, proposalKey,
    port([record({ state: 'pending', answer: null })]));
  assert.equal(decision.kind, 'confirmation_required');
});

test('§8.1 没有匹配提案内容的问题 → confirmation_required，需先提问', async () => {
  const other = { ...content, title: '别的内容' };
  const decision = await verifyProjectCreation(ctx(), identity, content, proposalKey,
    port([record({ personalProjectContent: other })]));
  assert.equal(decision.kind, 'confirmation_required');
});

test('§8.1 自由文本答案尚未进入本 Step 输入范围 → answer_requires_model_judgment', async () => {
  const decision = await verifyProjectCreation(ctx([]), identity, content, proposalKey,
    port([record({ answer: { kind: 'text', text: '好啊，做吧' }, answerInputId: randomUUID() })]));
  assert.equal(decision.kind, 'answer_requires_model_judgment');
});

test('§8.1 自由文本答案已进入本 Step inputIds → 允许主模型语义判断', async () => {
  const answerInputId = randomUUID();
  const decision = await verifyProjectCreation(ctx([answerInputId]), identity, content, proposalKey,
    port([record({ answer: { kind: 'text', text: '好啊，做吧' }, answerInputId })]));
  assert.equal(decision.kind, 'allow');
  assert.equal(decision.basis, 'model-judgment');
});

test('§8.1 结构化拒绝不被模型叙述覆盖（非 confirm 选项即使自由文本存在也拒绝）', async () => {
  const answerInputId = randomUUID();
  const decision = await verifyProjectCreation(ctx([answerInputId]), identity, content, proposalKey,
    port([record({ answer: { kind: 'choice', optionId: 'other' } })]));
  assert.equal(decision.kind, 'declined');
});

test('§8.1 confirm 选项文字被反转或缺少真实回答来源 → 不允许创建', async () => {
  const reversed = record({ options: [{ id: 'confirm', label: '暂不创建' }, { id: 'decline', label: '同意创建' }] });
  assert.equal((await verifyProjectCreation(ctx(), identity, content, proposalKey, port([reversed]))).kind, 'declined');
  for (const missing of [{ sourceInputId: null }, { answerInputId: null }]) {
    assert.equal((await verifyProjectCreation(ctx(), identity, content, proposalKey, port([record(missing)]))).kind,
      'confirmation_required');
  }
});

test('§8.1 自由文本真实回答已由此前 Step 展示 → 后续 Step 仍可判断', async () => {
  const answerInputId = randomUUID();
  const decision = await verifyProjectCreation(ctx([], [answerInputId]), identity, content, proposalKey,
    port([record({ answer: { kind: 'text', text: '好啊，做吧' }, answerInputId })]));
  assert.equal(decision.kind, 'allow');
  assert.equal(decision.basis, 'model-judgment');
});
