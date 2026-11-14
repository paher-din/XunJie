import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { recoveryOwners } from '../../../apps/server/tests/support/teaching-recovery.mjs';
import { reply, until } from '../../../apps/server/tests/support/session-product.mjs';
import { createWorkspaceAgentWaits, readWorkspaceAgentWait } from '../dist/workspace-agent-waits.js';

test('an original native input whose receipt arrives later resumes the Agent before its parent process ends', { timeout: 60000 }, async t => {
  let requestId, initialQuery;
  const f = await recoveryOwners(t, (payload, response, index) => {
    if (index === 1) return reply(response, { calls: [{ id: 'start-original', name: 'course_operation',
      arguments: { componentKey: 'counter', operationId: 'start_session', parameters: {} } }] });
    if (index === 2) {
      initialQuery = payload.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content)).at(-1).query;
      requestId = initialQuery.requestId;
      return reply(response, { calls: [{ id: 'one-original-input', name: 'course_operation',
        arguments: { componentKey: 'counter', operationId: 'advance', parameters: { value: 1 }, requestId, expectedSeq: 0 } }] });
    }
    assert.equal(index, 3, 'a single original input only needs one resumed model call');
    return reply(response, { text: '原输入已经确认，原生会话仍在运行。' });
  }, { native: true });
  const controlReceipt = f.learning.executions.controlReceipt;
  let delayed = false;
  f.learning.executions.controlReceipt = async (...args) => {
    const receipt = await controlReceipt(...args);
    if (!delayed && receipt?.status === 'applied') {
      delayed = true;
      return { ...receipt, status: 'dispatching', query: initialQuery };
    }
    return receipt;
  };
  const accepted = await f.send('启动累加器，输入一次 1，然后报告原输入已确认；保持会话运行。');
  async function advance(check) {
    return until(async () => {
      await f.runtime.advance(accepted.runId);
      const snapshot = await f.snapshot(accepted.runId);
      assert.ok(!['failed', 'paused'].includes(snapshot.run.state), JSON.stringify(snapshot.run));
      return check(snapshot) ? snapshot : null;
    }, 'The original native input did not settle.', 20000);
  }
  const waiting = await advance(snapshot => snapshot.waits.some(wait => wait.kind === 'workspace-execution' && wait.state === 'pending'));
  assert.equal(delayed, true);
  assert.equal(f.payloads.length, 2);
  const query = await f.learning.executions.read(f.identity, f.activity.activityId, requestId);
  assert.equal(query.state, 'running'); assert.equal(query.session.appliedSeq, 1);
  const callbacks = new Map(); let next = 0;
  const observer = createWorkspaceAgentWaits({
    timers: { setTimeout(callback) { callbacks.set(++next, callback); return next; }, clearTimeout(id) { callbacks.delete(id); } },
    read: (session, wait) => readWorkspaceAgentWait(f.learning.executions, session, wait),
    resolve: (session, wait, result) => f.runtime.resolveWait(session.identity, session.sessionId,
      { requestId: randomUUID(), waitId: wait.waitId, expectedVersion: wait.version, result }),
  });
  t.after(async () => { observer.closeDispatch(); await observer.drain(); });
  observer.observe({ session: waiting.session, runId: accepted.runId, waits: waiting.waits.filter(wait => wait.state === 'pending') });
  callbacks.values().next().value(); await observer.drain();
  const completed = await advance(snapshot => snapshot.run.state === 'completed');
  assert.equal(f.payloads.length, 3);
  assert.ok(completed.waits.every(wait => wait.state === 'consumed'));
  const original = await f.learning.executions.read(f.identity, f.activity.activityId, requestId);
  assert.equal(original.state, 'running', 'a confirmed input must not wait for physical session termination');
  assert.deepEqual(original.session.observation, { value: 1, total: 1, applied: 1 });
  assert.equal((await controlReceipt(f.identity, f.activity.activityId, requestId, waiting.waits[0].presentation.commandId)).status, 'applied');
});
