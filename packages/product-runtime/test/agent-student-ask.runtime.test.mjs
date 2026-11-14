import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openStorage, createFileBackend } from '@xunjie/storage';
import { resolveCredential } from '@xunjie/product-runtime';
import { agentServiceMigrations } from '@xunjie/agents/transport/session-storage';
import { installedIndependent, question, completed, until, answer } from './support/installed-agent-v2.mjs';

const prompt = { question: '你预计状态 3 再输入 2 会变成几？', source: '当前四态累加活动的先验预测',
  options: [{ id: 'one', label: '1' }, { id: 'three', label: '3' }], allowText: true, skippable: true };

test('independent v2 student questions retain explicit responses, expired waits, steering and fixed Run identities', { timeout: 240000 }, async t => {
  let ask = true;
  const f = await installedIndependent(t, async (_payload, response) => {
    const asking = ask; ask = false;
    answer(response, '你选择了 1；原状态 3 加 2 后按 4 取余，结果是 1。', asking ? { name: 'student_ask', arguments: prompt } : undefined);
  });
  const activity = await f.api('activities', { requestId: randomUUID(), goal: '明确回应', question: '', references: [] });
  const { service } = await f.bind(activity.identity); await f.model();
  const session = await f.api('agent-sessions/workspace', { activityId: activity.activityId, target: activity.target });
  const base = `agent-sessions/${session.sessionId}`;
  const acceptedAt = Date.now();
  const received = await f.api(base + '/inputs', question(activity, session, '请先询问我的预测'));
  const waiting = await until(async () => { const value = await f.api(base + '/conversation');
    const run = value.runs.find(run => run.runId === received.runId);
    if (run && ['completed', 'paused', 'failed', 'stopped'].includes(run.state)) {
      const snapshot = await f.api(base + '/snapshots/' + received.runId);
      assert.fail(JSON.stringify({ run: { state: run.state, reason: run.reason }, modelDispatchMs: f.requestTimes.map(time => time - acceptedAt),
        steps: snapshot.steps.map(step => ({ kind: step.operation.kind, state: step.state, resultState: step.result?.state,
          reason: step.result?.value?.reason })) }));
    }
    return value.waits.some(wait => wait.state === 'pending') ? value : null; }, 'The original user question was not persisted.');
  t.diagnostic(JSON.stringify({ firstDispatchMs: f.requestTimes[0] - acceptedAt, waitCommittedMs: Date.now() - acceptedAt }));
  const wait = waiting.waits.find(wait => wait.state === 'pending');
  assert.equal(wait.presentation.question, prompt.question); assert.equal(wait.interruptible, true);
  assert.equal(f.requests.length, 1);
  assert.deepEqual((await f.api(base + '/conversation')).waits, waiting.waits, 'reading or presenting never answers the question');
  const response = { requestId: randomUUID(), expectedVersion: wait.version, answer: { kind: 'choice', optionId: 'one' } };
  const responseRoute = base + '/waits/' + wait.waitId + '/responses';
  const accepted = await f.api(responseRoute, response);
  assert.deepEqual(accepted, { runId: received.runId, waitId: wait.waitId });
  assert.deepEqual(await f.api(responseRoute, response), accepted);
  await f.api(responseRoute, { ...response, answer: { kind: 'choice', optionId: 'three' } }, {}, 409);
  const finished = await completed(f.api, session.sessionId, received.runId);
  assert.equal(finished.runs.length, 1); assert.equal(finished.waits[0].state, 'consumed');
  assert.deepEqual(finished.waits[0].response, response.answer); assert.equal(f.requests.length, 2);
  assert.ok(JSON.stringify(f.requests[1]).includes(prompt.question)); assert.ok(JSON.stringify(f.requests[1]).includes('one'));
  const events = await f.api(base + '/events');
  assert.equal(events.filter(event => event.kind === 'wait-consumed' && event.body.waitId === wait.waitId).length, 1);
  await f.restartAgent(); await f.restartSchool();
  assert.deepEqual(await f.api(responseRoute, response), accepted);
  assert.deepEqual(await f.api(base + '/conversation'), finished); assert.equal(f.requests.length, 2);
  ask = true;
  const expiring = await f.api(base + '/inputs', question(activity, session, '这次等待超过期限后保留原提问'));
  const expiringWait = await until(async () => (await f.api(base + '/conversation')).waits.find(wait => wait.runId === expiring.runId && wait.state === 'pending'), 'The next question was not saved.');
  const binding = JSON.parse(await resolveCredential(join(f.root, 'agent'), 'storage-' + service.serviceId));
  const clock = await openStorage({ binding, migrations: agentServiceMigrations,
    backend: createFileBackend({ id: 'teaching-agent', root: join(f.root, 'agent/learning-resources/teaching-agent') }) });
  try { await clock.request({ requestId: randomUUID(), fingerprint: 'advance-native-wait-deadline' }, async tx => {
    await tx.query("UPDATE agent_waits SET deadline=clock_timestamp()-interval '1 second' WHERE wait_id=$1", [expiringWait.waitId]); return null;
  }); } finally { await clock.close(); }
  await f.api(base + '/waits/' + expiringWait.waitId + '/responses', { requestId: randomUUID(), expectedVersion: expiringWait.version,
    answer: { kind: 'text', text: '迟到回应' } }, {}, 409);
  assert.equal(f.requests.length, 3, 'an expired response does not generate a continuation');
  const steered = await f.api(base + '/inputs', question(activity, session, '取消原问题，直接继续解释'));
  assert.equal(steered.runId, expiring.runId);
  const after = await completed(f.api, session.sessionId, steered.runId);
  const cancelled = after.waits.find(wait => wait.waitId === expiringWait.waitId);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.response, null);
  assert.equal(f.requests.length, 4);
});
