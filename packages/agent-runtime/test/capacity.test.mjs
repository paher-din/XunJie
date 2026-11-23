import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { requestCapacity } from '../dist/capacity.js';
import { measureNativeCapacity } from '@xunjie/model-gateway/service';
import { modelCompactionBudget, modelContextPressurePolicy } from '@xunjie/contracts/model-connections';

function input() {
  return { identity: {}, sessionId: randomUUID(), turnId: randomUUID(), stepId: randomUUID(),
    system: '系统', tools: [], history: [], text: '问题', images: [], toolResults: [],
    budget: { maxSteps: 1, maxToolCalls: 1, maxInputTokens: 100000, maxOutputTokens: 10000,
      maxCallMs: 1000, deadline: new Date(Date.now() + 60000).toISOString() },
    spent: { inputTokens: 0, outputTokens: 0, inputReserved: 0, outputReserved: 0 },
    segmentEpoch: 0, signal: new AbortController().signal };
}
const connection = { connectionId: randomUUID(), version: 1, modelId: 'model', protocol: 'chat-completions',
  contextWindow: 10000, maxOutputTokens: 1000, routeId: randomUUID() };

test('最终请求按协议 payload 区分传输字节、上下文窗口和 Turn 输入预算', () => {
  const base = requestCapacity(input(), connection, { messages: [{ role: 'user', content: '问题' }] }, 1000, 100000);
  assert.equal(base.dispatchable, true);
  assert.equal(base.reason, 'ok');
  assert.ok(base.bytes > 0);

  const transport = requestCapacity(input(), connection, { text: 'x'.repeat(1_000_001) }, 1000, 100000);
  assert.equal(transport.reason, 'transport-bytes');
  assert.equal(transport.dispatchable, false);

  const window = requestCapacity(input(), connection, { text: 'x'.repeat(40) }, 9999, 100000);
  assert.equal(window.reason, 'context-window');

  const turn = requestCapacity(input(), connection, { text: 'x'.repeat(40) }, 1000, 1);
  assert.equal(turn.reason, 'input-budget');
});

test('压缩预留不足不伪造物理窗口超限，真实 C/R/Turn/传输边界仍然生效', () => {
  for (const [contextWindow, maxOutputTokens] of [[1_000, 100], [4_000, 512], [8_000, 512], [64_000, 8_000]]) {
    const physical = measureNativeCapacity(Buffer.from('中文🙂'.repeat(40), 'utf8'), contextWindow, maxOutputTokens, 1_000_000);
    assert.equal(physical.dispatchable, true, `${contextWindow} physical request fits despite planning pressure`);
    assert.ok(['ok', 'compact', 'blocked'].includes(physical.pressureState));
  }
  const outputExceedsWindow = measureNativeCapacity(Buffer.from('x'), 1_000, 1_001, 1_000_000);
  assert.equal(outputExceedsWindow.dispatchable, false);
  assert.equal(outputExceedsWindow.reason, 'context-window');
  const turnExceeds = measureNativeCapacity(Buffer.from('中文'.repeat(100), 'utf8'), 64_000, 1_000, 10);
  assert.equal(turnExceeds.reason, 'input-budget');
  const transportExceeds = measureNativeCapacity(Buffer.alloc(1_000_001, 120), 64_000, 1_000, 1_000_000);
  assert.equal(transportExceeds.reason, 'transport-bytes');
});

test('DeepSeek Harness 压力阈值：C/R/Hc 推导 pressureBudget、thresholdTokens 和 retainTokens', () => {
  const budget = modelCompactionBudget(64_000, 8_000, 3_200);
  assert.equal(budget.compactionHeadroomTokens, 4_096);
  assert.equal(budget.compactionHeadroomSource, 'estimated');
  assert.equal(budget.pressureBudgetTokens, 51_904);
  assert.equal(budget.thresholdTokens, 51_200);
  assert.equal(budget.retainTokens, 5_600);

  const at = bytes => measureNativeCapacity(Buffer.alloc(bytes, 120), 64_000, 8_000, 1_000_000);
  const below = at(153_597);
  assert.equal(below.inputEstimateTokens, 51_199);
  assert.equal(below.pressureState, 'ok', '低于压缩阈值不调用摘要');
  assert.equal(below.dispatchable, true);

  const threshold = at(153_600);
  assert.equal(threshold.inputEstimateTokens, 51_200);
  assert.equal(threshold.pressureState, 'compact', '恰好达到压缩阈值触发压力处理');
  assert.equal(threshold.thresholdTokens, 51_200);
  assert.equal(threshold.retainTokens, 5_600);
  assert.equal(threshold.dispatchable, true);

  const pressureLimit = at(155_712);
  assert.equal(pressureLimit.inputEstimateTokens, 51_904);
  assert.equal(pressureLimit.pressureBudgetTokens, 51_904);
  assert.equal(pressureLimit.pressure, 1);
  assert.equal(pressureLimit.pressureState, 'compact');
  assert.equal(pressureLimit.dispatchable, true);

  const overPhysical = at(168_003);
  assert.equal(overPhysical.inputEstimateTokens, 56_001);
  assert.equal(overPhysical.dispatchable, false);
  assert.equal(overPhysical.reason, 'context-window');

  const unknown = measureNativeCapacity(Buffer.alloc(30, 120), null, 100, 1_000_000);
  assert.equal(unknown.pressure, null);
  assert.equal(unknown.pressureState, 'unknown');
});

test('路线提供 compaction headroom 时优先使用并标记 route', () => {
  const measured = measureNativeCapacity(Buffer.alloc(153_600, 120), 64_000, 8_000, 1_000_000, 0.05, 4_096);
  assert.equal(measured.compactionHeadroomSource, 'route');
  assert.equal(measured.compactionHeadroomTokens, 4_096);
  assert.equal(measured.thresholdTokens, 51_200);
  assert.equal(measured.retainTokens, 5_600);
});

test('图片或未校准路线使用 10% 安全余量', () => {
  const image = measureNativeCapacity(Buffer.alloc(30, 120), 64_000, 8_000, 1_000_000, 0.1);
  assert.equal(image.safetyMarginTokens, 6_400);
  assert.equal(image.compactionHeadroomTokens, 6_400, '安全余量大于 4,096 时进入 headroom 估算');
  assert.equal(image.pressureState, 'ok');
});
