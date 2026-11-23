import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completed, projectResult } from '../dist/capabilities/tool-support.js';

test('工具结果超过自身反馈上限时返回明确截断状态，不静默切片', () => {
  const result = completed('x'.repeat(9000), { whole: 'x'.repeat(9000) });
  assert.equal(result.kind, 'completed');
  assert.equal(result.outcome, 'success');
  const summary = JSON.parse(result.summary);
  assert.equal(summary.truncated, true);
  assert.match(summary.unreadable, /没有声明安全的继续读取参数/);
  assert.ok(summary.original.byteLength > 8192);
  assert.ok(Buffer.byteLength(result.summary, 'utf8') <= 8192);
});

test('projectResult 对超长原始结果同时保留有界摘要和不可完整读取状态', () => {
  const full = { payload: 'y'.repeat(9000) };
  const result = projectResult(full, '关键观察：窗口压力');
  assert.equal(result.kind, 'completed');
  const summary = JSON.parse(result.summary);
  assert.equal(summary.truncated, true);
  assert.match(summary.unreadable, /未提供统一读取入口/);
  assert.equal(summary.summary, '关键观察：窗口压力');
  assert.equal(result.data.payload.length, 9000, '完整原件仍保存在工具结果 data');
});
