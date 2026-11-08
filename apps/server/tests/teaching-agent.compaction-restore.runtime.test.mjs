import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createFileBackend, StorageError } from '@xunjie/storage';
import { collectTeachingBoundary, teachingAgentMigrations } from '@xunjie/learning-space';
import { openProductRuntime, openRecoveredStorage, restoreProductRecovery } from '@xunjie/product-runtime';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

function summaryInput(payload) {
  for (const message of payload.messages ?? []) {
    const texts = typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(part => part.text);
    for (const text of texts) {
      try {
        const value = JSON.parse(text);
        if (value.kind === 'xunjie.context-compaction') return value;
      } catch { /* Ordinary learning messages are not summary requests. */ }
    }
  }
  return null;
}

function answer(payload, response) {
  const source = summaryInput(payload);
  reply(response, { text: source ? JSON.stringify({ version: 1,
    sourceDigest: source.sourceDigest, retainedDigest: source.retainedDigest,
    retainedIds: source.retained.map(item => item.id),
    facts: [{ text: '原观测为 37，原因尚未核实。', sources: [source.messages[0].eventId] }],
    inferences: [], contradictions: [], unknowns: [], unfinished: [],
  }) : '原观测为 37，原因尚未核实。' });
}

async function completed(agent, identity, activityId, runId) {
  return until(async () => {
    const run = await agent.run(identity, activityId, runId);
    if (['paused', 'failed', 'stopped'].includes(run.state)) throw new Error(JSON.stringify(run));
    return run.state === 'completed' ? run : null;
  }, 'The public learning Run completes.', 30000);
}

async function history(c, activityId) {
  for (let index = 0; index < 7; index++) {
    const sent = await c.send(`历史 ${index + 1}：` + 'observation 37; cause unconfirmed. '.repeat(280));
    await completed(c.agent, c.identity, activityId, sent.runId);
  }
  c.agent.close(); await c.agent.drain();
}

// Only negative cases alter durable rows. Every positive record above is produced
// by the public owner and real ModelGateway, including the interrupted commit case.
async function changedRow(storage, table, key, original, changes, check) {
  const columns = Object.keys(changes);
  const write = values => storage.request({ requestId: randomUUID(), fingerprint: 'restore-corruption-injection' }, async tx => {
    const { rows } = await tx.query(`UPDATE ${table} SET ${columns.map((column, index) => `${column}=$${index + 2}`).join(',')}
      WHERE ${key}=$1 RETURNING ${key}`, [original[key], ...values.map(value =>
      value !== null && typeof value === 'object' ? JSON.stringify(value) : value)]);
    assert.equal(rows.length, 1);
    return null;
  });
  await write(Object.values(changes));
  try { await check(); }
  finally { await write(columns.map(column => original[column])); }
}

test('restore rejects summary results and adoption receipts belonging to another durable identity', { timeout: 180000 }, async t => {
  const f = await fixture(answer);
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await history(c, activity.activityId);
    const agent = c.makeAgent();
    const sent = await c.send('压缩后沿原观测继续。', undefined, [], agent);
    await completed(agent, c.identity, activity.activityId, sent.runId);
    agent.close(); await agent.drain();
    const restored = c.makeAgent();
    await restored.validate();
    const { rows: [record] } = await c.storage.read("SELECT * FROM teaching_compactions WHERE run_id=$1 AND state='adopted'", [sent.runId]);
    assert.ok(record);
    const { rows: [step] } = await c.storage.read('SELECT * FROM teaching_steps WHERE step_id=$1', [record.step_id]);
    const { rows: events } = await c.storage.read('SELECT * FROM teaching_events WHERE activity_id=$1 ORDER BY seq', [activity.activityId]);
    const generated = events.find(event => event.kind === 'context-compaction-generated' && event.body.compactionId === record.compaction_id);
    const adopted = events.find(event => event.kind === 'context-compacted' && event.body.compactionId === record.compaction_id);
    const foreign = events.find(event => event.kind === 'assistant' && event.body.runId !== sent.runId && event.body.resultRef);
    assert.ok(generated); assert.ok(adopted); assert.ok(foreign);
    const { rows: [transition] } = await c.storage.read('SELECT * FROM teaching_segment_transitions WHERE transition_id=$1', [record.adoption_transition_id]);
    const otherTransition = (await c.storage.read(`SELECT * FROM teaching_segment_transitions
      WHERE activity_id=$1 AND reason='compaction-generation' AND compaction_id=$2`, [activity.activityId, record.compaction_id])).rows[0];
    assert.ok(transition); assert.ok(otherTransition);
    const cases = [
      ['summary result reference', 'teaching_compactions', 'compaction_id', record, { result_ref: foreign.body.resultRef }],
      ['settled step result reference', 'teaching_steps', 'step_id', step, { result_ref: foreign.body.resultRef }],
      ['missing settled step result', 'teaching_steps', 'step_id', step, { result_ref: null }],
      ...[
        ['result reference', { resultRef: foreign.body.resultRef }],
        ['attempt identity', { attemptId: foreign.body.attemptId }],
        ['step identity', { stepId: randomUUID() }],
        ['Run identity', { runId: foreign.body.runId }],
        ['missing generation identity', { compactionId: randomUUID() }],
        ['generated result content', { result: { ...generated.body.result, facts: [] } }],
      ].map(([name, change]) => ['generation ' + name, 'teaching_events', 'event_id', generated,
        { body: { ...generated.body, ...change } }]),
      ...[
        ['result reference', { resultRef: foreign.body.resultRef }],
        ['transition identity', { transitionId: otherTransition.transition_id }],
        ['Run identity', { runId: foreign.body.runId }],
      ].map(([name, change]) => ['adoption ' + name, 'teaching_events', 'event_id', adopted,
        { body: { ...adopted.body, ...change } }]),
      ['adopted portable summary', 'teaching_segment_transitions', 'transition_id', transition,
        { create_body: { ...transition.create_body, portable: transition.create_body.portable.map(message =>
          message.text.includes(record.compaction_id) ? { ...message, text: '错误地采用了另一份摘要。' } : message) } }],
    ];
    const calls = f.payloads.length;
    for (const [name, table, key, original, changes] of cases) await t.test(name, async () => {
      await changedRow(c.storage, table, key, original, changes, async () => {
        await assert.rejects(restored.validate(), { code: 'corrupt' });
      });
      await restored.validate();
      assert.equal(f.payloads.length, calls, 'Restore validation never calls the model.');
    });
  } finally { await f.close(); }
});

test('restore accepts a committed generation before budget settlement and resumes its original attempt', { timeout: 180000 }, async () => {
  const f = await fixture(answer);
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    await history(c, activity.activityId);
    let lost = false;
    const interruptedStorage = { ...c.storage, async request(input, effect) {
      let generated = false;
      const receipt = await c.storage.request(input, tx => effect({ ...tx, async query(sql, values) {
        const result = await tx.query(sql, values);
        if (sql.includes('INSERT INTO teaching_events') && values?.includes('context-compaction-generated')) generated = true;
        return result;
      } }));
      if (generated && !lost) { lost = true; throw new StorageError('resource-busy'); }
      return receipt;
    } };
    const first = c.makeAgent({}, interruptedStorage);
    const sent = await c.send('保持原摘要结果和预算身份。', undefined, [], first);
    await until(async () => (await first.run(c.identity, activity.activityId, sent.runId)).state === 'paused',
      'The generation receipt is lost before budget settlement.');
    assert.equal(lost, true);
    first.close(); await first.drain();
    const { rows: [record] } = await c.storage.read('SELECT * FROM teaching_compactions WHERE run_id=$1', [sent.runId]);
    const { rows: [step] } = await c.storage.read('SELECT * FROM teaching_steps WHERE step_id=$1', [record.step_id]);
    assert.equal(record.state, 'generated'); assert.ok(record.result_ref);
    assert.equal(step.phase, 'model'); assert.equal(step.usage, null); assert.equal(step.result_ref, null);
    const restored = c.makeAgent();
    const calls = f.payloads.length;
    await restored.validate();
    assert.equal(f.payloads.length, calls);
    await changedRow(c.storage, 'teaching_steps', 'step_id', step, { result_ref: randomUUID() }, async () => {
      await assert.rejects(restored.validate(), { code: 'corrupt' }, 'An unsettled step cannot already claim another result.');
    });
    await restored.validate();
    const receipt = await restored.continueRun(c.identity, activity.activityId, sent.runId,
      { version: 2, requestId: randomUUID(), inputs: [] });
    assert.equal(receipt.runId, sent.runId);
    const run = await completed(restored, c.identity, activity.activityId, sent.runId);
    restored.close(); await restored.drain();
    await restored.validate();
    const events = await restored.events(c.identity, activity.activityId);
    const generated = events.filter(event => event.kind === 'context-compaction-generated' && event.body.runId === sent.runId);
    assert.equal(generated.length, 1);
    assert.equal(generated[0].body.attemptId, step.attempt_id);
    assert.equal(generated[0].body.resultRef, record.result_ref);
    assert.equal(events.filter(event => event.kind === 'context-compacted' && event.body.runId === sent.runId).length, 1);
    assert.equal(events.filter(event => event.kind === 'budget-settled' && event.body.stepId === step.step_id).length, 1);
    assert.equal(f.payloads.filter(payload => summaryInput(payload)).length, 1);
    assert.deepEqual(run.usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
  } finally { await f.close(); }
});

test('compaction survives formal backup, isolated restore and takeover without regenerating history', { timeout: 300000 }, async () => {
  const f = await fixture(answer);
  const directory = await mkdtemp(join(tmpdir(), 'xj-compaction-recovery-'));
  let target, restored;
  try {
    await f.configure();
    const activity = await f.activity('保留长对话的压缩来源与原始交流'), base = `agent/${activity.activityId}`;
    const questions = [];
    const send = async question => {
      questions.push(question);
      const sent = await f.send(activity, question);
      await until(async () => {
        const run = (await f.api(base + '/conversation')).runs.find(run => run.runId === sent.runId);
        if (run && ['paused', 'failed', 'stopped'].includes(run.state)) throw new Error(JSON.stringify(run));
        return run?.state === 'completed';
      }, 'The registered production Agent completes its HTTP request.', 30000);
    };
    for (let index = 0; index < 7; index++)
      await send(`原始历史 ${index + 1}：` + 'observation 37; cause unconfirmed. '.repeat(280));
    await send('请整理长历史后沿原观测继续，保留未知原因。');
    const before = await f.api(base + '/conversation'), events = await f.api(base + '/events');
    const context = await f.api('context');
    const generated = events.filter(event => event.kind === 'context-compaction-generated');
    const adoptions = events.filter(event => event.kind === 'context-compacted');
    assert.equal(generated.length, 1); assert.equal(adoptions.length, 1);
    assert.equal(f.payloads.filter(payload => summaryInput(payload)).length, 1);
    assert.equal(before.runs.length, 8);
    for (const question of questions)
      assert.ok(before.messages.some(message => message.role === 'student' && message.text.includes(question)));
    const snapshots = [];
    for (const event of events.filter(event => event.kind === 'context-assembled'))
      snapshots.push(await f.api(`${base}/snapshots/${event.body.snapshotId}`));
    const resultRef = generated[0].body.resultRef;
    assert.equal(adoptions[0].body.resultRef, resultRef);
    const originalResult = await f.api('models/results/' + resultRef);
    assert.equal(originalResult.attemptId, generated[0].body.attemptId);
    assert.deepEqual(JSON.parse(originalResult.text), generated[0].body.result);
    const calls = f.payloads.length;
    assert.equal(calls, 9, 'Seven historical answers, one summary and one learning continuation.');
    assert.equal(snapshots.length, calls);
    assert.equal(before.tools.length, 0);

    const key = randomBytes(32);
    await f.runtime.setCredential('compaction-recovery', key.toString('base64'));
    const backup = await f.runtime.recovery.backup({ directory, recoveryKeyRef: 'compaction-recovery', leaveClosed: true });
    const agentBoundary = backup.boundary.services.find(service => service.kind === 'xunjie.teaching-agent.boundary');
    assert.ok(agentBoundary); assert.equal(agentBoundary.unresolved, 0);
    const environment = JSON.parse(await readFile(join(f.root, 'environment.json'), 'utf8'));
    assert.equal(agentBoundary.serviceId, environment.services.find(service => service.unit === 'teaching-agent').serviceId,
      'The HTTP Agent belongs to the registered backup inventory.');
    const sourceStorage = await openRecoveredStorage({ root: f.root, serviceId: agentBoundary.serviceId,
      migrations: teachingAgentMigrations,
      backend: createFileBackend({ id: 'teaching-agent', root: join(f.root, 'learning-resources', 'teaching-agent') }) });
    let sourceBoundary;
    try { sourceBoundary = await collectTeachingBoundary(sourceStorage); }
    finally { await sourceStorage.close(); }
    assert.equal(sourceBoundary.evidence.tables.teaching_compactions.count, adoptions.length);
    assert.equal(sourceBoundary.evidence.tables.teaching_commands.count, 0);

    const targetRoot = join(directory, 'target');
    restored = await restoreProductRecovery({ root: targetRoot, resources: f.resources,
      backupDirectory: join(directory, backup.backupId), key });
    const owner = restored.owners.find(owner => owner.participant.descriptor.serviceId === agentBoundary.serviceId);
    assert.ok(owner);
    const material = await owner.material({ backupId: backup.backupId, boundaryAt: backup.boundaryAt, signal: new AbortController().signal });
    assert.deepEqual(material.evidence.tables.teaching_compactions, sourceBoundary.evidence.tables.teaching_compactions,
      'The restored owner re-derives the same complete compaction inventory, including sources and results.');
    assert.deepEqual(material.evidence.tables.teaching_snapshots, sourceBoundary.evidence.tables.teaching_snapshots);
    assert.deepEqual(material.evidence.tables.teaching_commands, sourceBoundary.evidence.tables.teaching_commands);
    for (const entry of restored.owners) await entry.close?.();
    restored = undefined;
    target = openProductRuntime({ root: targetRoot, resources: f.resources });
    const state = await target.start();
    assert.equal(state.state, 'maintenance');
    const read = async route => {
      const response = await fetch(new URL('/api/learning/' + route, state.endpoint), { headers: { 'x-xj-space': 'personal' } });
      assert.equal(response.status, 200, route); return response.json();
    };
    const unchanged = async () => {
      assert.deepEqual(await read(base + '/conversation'), before, 'All original conversation records survive.');
      const currentEvents = await read(base + '/events');
      assert.deepEqual(currentEvents, events, 'Original source events, generation and adoption identities survive.');
      assert.deepEqual(currentEvents.filter(event => event.kind === 'context-compacted'), adoptions);
      for (const snapshot of snapshots)
        assert.deepEqual(await read(`${base}/snapshots/${snapshot.snapshotId}`), snapshot);
      assert.deepEqual(await read('models/results/' + resultRef), originalResult, 'The original model-owned summary remains queryable.');
      assert.equal(f.payloads.length, calls, 'Reading restored history never invokes a model.');
      assert.equal(currentEvents.filter(event => event.kind === 'tool-permitted').length, 0, 'No tool is dispatched during recovery.');
    };
    await unchanged();
    assert.equal((await target.recovery.takeover({ sourceRoot: f.root, receivers: [] })).phase, 'active');
    const activeContext = await read('context');
    assert.notEqual(activeContext.clientNamespace, context.clientNamespace);
    await unchanged();
    const stale = await fetch(new URL(`/api/learning/${base}/snapshots/${snapshots[0].snapshotId}`, state.endpoint),
      { headers: { 'x-xj-space': 'personal', 'x-xj-namespace': context.clientNamespace } });
    assert.equal(stale.status, 403, 'The source client namespace no longer authorizes access at the target.');
    await stale.arrayBuffer();
    await assert.rejects(f.runtime.start(), error => error.code === 'source-retired');
    assert.equal(f.payloads.length, calls);
    assert.deepEqual(f.failures, []);
  } finally {
    for (const owner of restored?.owners ?? []) await owner.close?.();
    await target?.stop(); await f.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xj-compaction-recovery-'))
      throw new Error('Unexpected cleanup target');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

for (const lost of ['close', 'create']) test(`same-Run pending steering revision releases a summary-generation ${lost} with a lost receipt`,
  { timeout: 180000 }, async () => {
    let releaseFirst, firstEntered = false, dropped = false;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const f = await fixture(async (payload, response, index) => {
      if (index === 1) {
        firstEntered = true; await firstGate;
        reply(response, { text: '已收到原始观测，原因尚未核实。' });
      } else answer(payload, response);
    });
    try {
      const activity = await f.activity(), c = await f.controlled(activity);
      const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'original-observations.txt', kind: 'text', encoding: 'utf8',
        mediaType: 'text/plain', value: 'ORIGINAL_FIXED_OBSERVATION\n' + 'observation 37; cause unconfirmed. '.repeat(2300) };
      await c.learning.works.sync(c.identity, activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
      const models = { ...c.models, segments: { ...c.models.segments,
        async close(...args) {
          const result = await c.models.segments.close(...args);
          // The initial segment has no predecessor. Its first close belongs to
          // summary generation after the original normal step has completed.
          if (lost === 'close' && !dropped) { dropped = true; throw new StorageError('resource-busy'); }
          return result;
        },
        async create(identity, input) {
          const result = await c.models.segments.create(identity, input);
          if (lost === 'create' && !dropped && input.prefix.tools.length === 0) {
            dropped = true; throw new StorageError('resource-busy');
          }
          return result;
        },
      } };
      const first = c.makeAgent({ models });
      const original = await c.send('保留原观测和未知原因。', undefined, [work], first);
      await until(() => firstEntered, 'The original normal model attempt starts before steering arrives.');
      const steering = await c.send('STEERING_BEFORE_REVISION：接着解释原观测。',
        { version: 1, mode: 'steering', basis: { source: 'explicit', preferenceVersion: 0 } }, [], first);
      assert.equal(steering.runId, original.runId);
      const inFlight = await first.conversation(c.identity, activity.activityId);
      assert.equal(inFlight.inputs.find(input => input.inputId === original.inputId).state, 'adopted');
      assert.equal(inFlight.inputs.find(input => input.inputId === steering.inputId).state, 'pending');
      releaseFirst();
      const paused = await until(async () => {
        const run = await first.run(c.identity, activity.activityId, original.runId);
        return run.state === 'paused' ? run : null;
      }, 'The summary-generation segment receipt is lost after the prior normal step.');
      assert.equal(dropped, true); assert.equal(paused.reason, 'resource-busy');
      first.close(); await first.drain();
      const before = await first.events(c.identity, activity.activityId);
      const assembled = before.filter(event => event.kind === 'context-assembled');
      const selected = before.filter(event => event.kind === 'context-compaction-selected');
      assert.equal(assembled.length, 1); assert.equal(selected.length, 1);
      assert.equal(selected[0].body.runId, original.runId);
      assert.notEqual(selected[0].body.stepId, assembled[0].body.stepId,
        'The interrupted generation is the next step of the same Run, not its initial step.');
      assert.ok(before.some(event => event.kind === 'budget-settled' && event.body.stepId === assembled[0].body.stepId));
      assert.ok(!before.some(event => event.kind === 'input-adopted' && event.body.inputId === steering.inputId));
      assert.equal(f.payloads.length, 1, 'The normal result is durable; the summary has not been dispatched.');
      const snapshot = await first.snapshot(c.identity, activity.activityId, assembled[0].body.snapshotId);
      assert.ok(!snapshot.resolvedAgent.definition.definitionId.endsWith('.context-summary'));
      assert.equal((await c.models.checks.read(c.identity, assembled[0].body.attemptId)).state, 'completed');

      const reopened = c.makeAgent({ models });
      const revisedText = 'STEERING_AFTER_REVISION：只核对测量条件，沿原记录继续。';
      const revised = await reopened.controlInput(c.identity, activity.activityId, steering.inputId,
        { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'revise', text: revisedText });
      assert.equal(revised.status, 'accepted');
      const resumed = await reopened.continueRun(c.identity, activity.activityId, original.runId,
        { version: 2, requestId: randomUUID(), inputs: [] });
      assert.equal(resumed.runId, original.runId);
      await until(async () => {
        const run = await reopened.run(c.identity, activity.activityId, original.runId);
        if (run.state !== 'paused') {
          assert.ok(!['completed', 'failed', 'stopped'].includes(run.state), JSON.stringify(run));
          return null;
        }
        assert.equal(run.reason, 'compaction-source-changed'); return run;
      }, 'Recovery must reject the changed source before restoring the accepted generation transition, rather than loop on conflict.');
      const rejectedEvents = await reopened.events(c.identity, activity.activityId);
      const rejections = rejectedEvents.filter(event => event.kind === 'context-compaction-rejected');
      assert.equal(rejections.length, 1);
      assert.equal(rejections[0].body.compactionId, selected[0].body.compactionId);
      assert.equal(rejections[0].body.reason, 'compaction-source-changed');
      assert.equal(rejectedEvents.filter(event => event.kind === 'context-compaction-generated' || event.kind === 'context-compacted').length, 0);
      assert.equal(f.payloads.length, 1, 'Rejecting the obsolete choice does not regenerate or replay a model attempt.');
      assert.deepEqual(await reopened.snapshot(c.identity, activity.activityId, snapshot.snapshotId), snapshot);
      await reopened.validate();

      const successor = await reopened.continueRun(c.identity, activity.activityId, original.runId,
        { version: 2, requestId: randomUUID(), inputs: [{ inputId: steering.inputId, expectedVersion: 2 }] });
      assert.notEqual(successor.runId, original.runId);
      assert.equal(successor.previousRunId, original.runId);
      await completed(reopened, c.identity, activity.activityId, successor.runId);
      const final = await reopened.conversation(c.identity, activity.activityId);
      const adopted = final.inputs.find(input => input.inputId === steering.inputId);
      assert.equal(adopted.version, 2); assert.equal(adopted.state, 'adopted');
      assert.equal(adopted.adoptedRunId, successor.runId); assert.equal(adopted.input.draft.question, revisedText);
      assert.match(JSON.stringify(f.payloads.at(-1)), /STEERING_AFTER_REVISION/);
      const finalEvents = await reopened.events(c.identity, activity.activityId);
      assert.equal(finalEvents.filter(event => event.kind === 'context-compacted'
        && event.body.compactionId === selected[0].body.compactionId).length, 0);
      assert.equal(finalEvents.filter(event => event.kind === 'attempt-dispatched'
        && event.body.attemptId === assembled[0].body.attemptId).length, 1);
      assert.equal(final.tools.length, 0);
      await reopened.validate();
      assert.deepEqual(f.failures, []);
    } finally { releaseFirst(); await f.close(); }
  });
