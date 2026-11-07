import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

test('a real teaching Run releases its worker while shared admission waits and resumes the same attempt', { timeout: 60000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (_input, response, index) => {
    if (index === 1) await gate;
    reply(response, { text: '原身份取得资源后继续。' });
  });
  let c;
  try {
    const activity = await f.activity('共享准入等待'); c = await f.controlled(activity);
    const selection = await c.models.selection.read(c.identity);
    const choice = await c.models.selection.snapshot(c.identity, selection.version), connection = choice.choice.connection;
    const segmentId = randomUUID(), external = randomUUID();
    await c.models.segments.create(c.identity, { requestId: randomUUID(), segmentId, purpose: 'learning',
      source: { connectionId: connection.connectionId, version: connection.version }, prefix: { system: '', tools: [] }, portable: [] });
    await c.models.checks.receive(c.identity, { attemptId: external, segmentId, purpose: 'learning', expectedSequence: 0,
      input: { text: '先占用同一主体的物理槽', images: [], toolResults: [] }, limits: { maxOutputTokens: 256, timeoutMs: 30000 } });
    await c.models.checks.dispatch(c.identity, external);
    await until(() => f.payloads.length === 1, 'The original physical request starts.');
    const sent = await c.send('等待资源后继续同一个原问题。'); c.agent.resume();
    const waiting = await until(async () => {
      const run = await c.agent.run(c.identity, activity.activityId, sent.runId);
      return run.state === 'waiting' && run.reason === 'learning-principal-concurrency' ? run : null;
    }, 'The teaching Run yields admission.');
    c.agent.closeDispatch();
    await Promise.race([c.agent.drain(), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Admission wait retained a logical worker.')), 1000); timer.unref();
    })]);
    const { rows: [step] } = await c.storage.read('SELECT * FROM teaching_steps WHERE run_id=$1', [sent.runId]);
    assert.equal(step.phase, 'model'); assert.equal(step.dispatch_permitted, false);
    assert.equal(step.attempt_id, waiting.attemptId); assert.equal(f.payloads.length, 1);
    release();
    await until(async () => (await c.models.checks.read(c.identity, external)).state === 'completed', 'Original upstream ends.');
    c.agent.resume();
    const completed = await until(async () => {
      const run = await c.agent.run(c.identity, activity.activityId, sent.runId); return run.state === 'completed' ? run : null;
    }, 'The same teaching attempt resumes.');
    assert.equal(completed.attemptId, step.attempt_id); assert.equal(f.payloads.length, 2);
    assert.equal((await c.storage.read('SELECT * FROM teaching_steps WHERE run_id=$1', [sent.runId])).rows.length, 1);
  } finally { release(); await f.close(); }
});
