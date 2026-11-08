import { captureEvidence, writeEvidence } from './lib/probe-evidence.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect } from '@playwright/test';

/** Runs inside the actual product page; execution and checkpoint bytes stay at the school owner. */
export async function probeCheckpointCombination({ page, activityId, title, api, until, output, label }) {
  const report = { status: 'running', label, controls: [], startedAt: new Date().toISOString() };
  let action;
  const onRequest = request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'POST') return;
    if (path === `/api/learning/executions/${activityId}`) action = request.postDataJSON().action;
    if (path.endsWith('/control')) report.controls.push(request.postDataJSON());
  };
  page.on('request', onRequest);
  let path, restoredPath;
  const read = async target => {
    const reply = await api(target);
    assert.equal(reply.status, 200, `${target}: ${reply.status}`);
    return reply.body;
  };
  const panel = page.locator('.native-session');
  const poll = (target, accepts, name) => until(() => read(target), accepts, `${label}: ${name}`, 60_000);
  const effect = async (target, name, seq, value) => {
    if (value !== undefined) await page.getByLabel('输入整数（0–99）').fill(String(value));
    await panel.getByRole('button', { name, exact: true }).click();
    const query = await poll(target, query => query.session?.appliedSeq === seq && query.statusKnowledge === 'confirmed', name);
    await panel.getByRole('button', { name: '核对状态', exact: true }).click();
    await expect(panel.getByRole('list', { name: '已确认观察', exact: true })).toContainText(`第 ${seq} 次`);
    return query;
  };
  try {
    await panel.getByRole('button', { name: '开始新会话', exact: true }).click();
    await until(async () => action, Boolean, `${label}: 新启动请求`);
    path = `executions/${activityId}/${action.requestId}`;
    const original = await poll(path, query => query.state === 'running', '真实实例启动');
    report.original = original;
    await effect(path, '输入', 1, 1);
    const beforePause = await effect(path, '输入', 2, 2);
    assert.equal(beforePause.session.observation.value, 3);
    const paused = await effect(path, '暂停', 3);
    assert.equal(paused.state, 'paused');
    assert.equal(paused.session.executorInstanceId, original.session.executorInstanceId);
    report.original = original;
    report.beforeCheckpoint = paused;
    const checkpointRoute = `**/api/learning/${path}/control`;
    let lost = false;
    const discardCheckpointReply = async route => {
      if (route.request().postDataJSON().effect !== 'checkpoint' || lost) return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await poll(path, query => query.session?.checkpoints?.length === 1, '资源重读确认后丢弃保存回包');
      lost = true;
      await route.abort('failed');
    };
    await page.route(checkpointRoute, discardCheckpointReply);
    await panel.getByRole('button', { name: '保存检查点', exact: true }).click();
    const saved = await poll(path, query => query.session?.checkpoints?.length === 1, '检查点可恢复');
    await until(async () => lost, Boolean, `${label}: 已丢弃真实保存回包`);
    const checkpoint = saved.session.checkpoints[0];
    assert.equal(checkpoint.sessionRef, original.executionRef);
    assert.equal(checkpoint.appliedSeq, 4);
    assert.match(checkpoint.sha256, /^[a-f0-9]{64}$/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: title, exact: true }).click();
    await expect(panel.getByRole('button', { name: '恢复推进', exact: true })).toBeEnabled({ timeout: 60_000 });
    assert.equal(report.controls.filter(control => control.effect === 'checkpoint').length, 1);
    const baseline = await effect(path, '单步', 5, 2);
    assert.equal(baseline.session.observation.value, 1);
    const control = report.controls.at(-1);
    const replay = await api(path + '/control', control);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.session.appliedSeq, 5);
    await captureEvidence(page, { path: join(output, `${label}-checkpoint-before-restore.png`), fullPage: true });
    await panel.getByRole('button', { name: '停止会话', exact: true }).click();
    const stopped = await poll(path, query => query.state === 'cancelled' && query.statusKnowledge === 'confirmed', '原会话确认结束');
    const originalAction = action;
    await expect(panel.getByRole('combobox', { name: '恢复检查点', exact: true })).toBeVisible();
    await panel.getByRole('combobox', { name: '恢复检查点', exact: true }).selectOption(checkpoint.checkpointId);
    await panel.getByRole('button', { name: '从检查点建立恢复会话', exact: true }).click();
    await until(async () => action, next => next?.requestId !== originalAction.requestId, `${label}: 显式恢复请求`);
    restoredPath = `executions/${activityId}/${action.requestId}`;
    const restored = await poll(restoredPath, query => query.state === 'paused' && query.statusKnowledge === 'confirmed', '新实例恢复实际暂停状态');
    assert.notEqual(restored.executionRef, original.executionRef);
    assert.notEqual(restored.session.executorInstanceId, original.session.executorInstanceId);
    assert.equal(restored.session.restoredFrom.checkpointId, checkpoint.checkpointId);
    assert.equal(restored.session.nodeId, original.session.nodeId);
    assert.equal(restored.session.observation.value, 3);
    assert.equal(restored.session.observation.total, 3);
    assert.equal(restored.session.observation.applied, 2);
    if (original.session.observation.pid) assert.notEqual(restored.session.observation.pid, original.session.observation.pid);
    await expect(panel).toContainText('这是从检查点建立的新恢复实例');
    const next = await effect(restoredPath, '单步', 1, 2);
    for (const key of ['value', 'total', 'applied'])
      assert.equal(next.session.observation[key], baseline.session.observation[key], `真实恢复的下一步 ${key}`);
    assert.equal((await read(path)).state, stopped.state);
    await captureEvidence(page, { path: join(output, `${label}-checkpoint-restored.png`), fullPage: true });
    const reset = await effect(restoredPath, '复位', 2);
    assert.equal(reset.session.observation.value, 0);
    assert.equal(reset.session.observation.total, 0);
    assert.equal(reset.session.executorInstanceId, restored.session.executorInstanceId);
    assert.equal((await effect(restoredPath, '恢复推进', 3)).state, 'running');
    assert.equal((await effect(restoredPath, '暂停', 4)).state, 'paused');
    await panel.getByRole('button', { name: '停止会话', exact: true }).click();
    const final = await poll(restoredPath, query => query.state === 'cancelled' && query.statusKnowledge === 'confirmed', '恢复实例确认停止');
    report.status = 'passed';
    Object.assign(report, { checkpoint, lostCheckpointReply: lost, checkpointPosts: 1, baseline, restored, next, final,
      originalAfterRestore: await read(path) });
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = String(error);
    report.failureQuery = path ? await read(restoredPath ?? path).catch(() => null) : null;
    const checkpointControl = report.controls.find(control => control.effect === 'checkpoint');
    if (path && checkpointControl) report.failureReceipt = await api(path + '/controls/' + checkpointControl.controlId).catch(() => null);
    await captureEvidence(page, { path: join(output, `${label}-checkpoint-failed.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await writeEvidence(join(output, `${label}-checkpoint-combination.json`), JSON.stringify(report, null, 2) + '\n');
    page.off('request', onRequest);
    for (const target of [path, restoredPath].filter(Boolean))
      await api(target + '/stop', { stopId: randomUUID(), reason: '检查点组合验收清理' }).catch(() => {});
  }
}
