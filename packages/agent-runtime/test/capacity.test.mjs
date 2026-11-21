import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { requestCapacity } from '../dist/capacity.js';
import { measureNativeCapacity } from '@xunjie/model-gateway/service';

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

test('窗口压力采用 W/O/M 与最终输入估值，80% 软触发、100% 准入边界', () => {
  const at = bytes => measureNativeCapacity(Buffer.alloc(bytes, 120), 64_000, 8_000, 1_000_000);
  const below = at(126_717);
  assert.equal(below.inputEstimateTokens, 42_239);
  assert.equal(below.safetyMarginTokens, 3_200);
  assert.equal(below.pressure < 0.8, true);
  assert.equal(below.pressureState, 'ok');
  assert.equal(below.dispatchable, true);

  const soft = at(126_720);
  assert.equal(soft.inputEstimateTokens, 42_240);
  assert.equal(soft.pressure, 0.8);
  assert.equal(soft.pressureState, 'compact');
  assert.equal(soft.dispatchable, true);

  const limit = at(158_400);
  assert.equal(limit.inputEstimateTokens, 52_800);
  assert.equal(limit.pressure, 1);
  assert.equal(limit.pressureState, 'compact');
  assert.equal(limit.dispatchable, true);

  const over = at(158_403);
  assert.equal(over.inputEstimateTokens, 52_801);
  assert.equal(over.pressure > 1, true);
  assert.equal(over.pressureState, 'blocked');
  assert.equal(over.dispatchable, false);
  assert.equal(over.reason, 'context-window');

  const unknown = measureNativeCapacity(Buffer.alloc(30, 120), null, 100, 1_000_000);
  assert.equal(unknown.pressure, null);
  assert.equal(unknown.pressureState, 'unknown');
});

test('图片或未校准路线使用 10% 安全余量', () => {
  const image = measureNativeCapacity(Buffer.alloc(30, 120), 64_000, 8_000, 1_000_000, 0.1);
  assert.equal(image.safetyMarginTokens, 6_400);
  assert.equal(image.pressureState, 'ok');
});
