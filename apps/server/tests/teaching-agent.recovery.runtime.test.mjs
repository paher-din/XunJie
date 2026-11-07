import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { test } from 'node:test';
import { createProductRuntimeHost, createProductLearningApplication, openProductRuntime, openRecoveredStorage, restoreProductRecovery } from '@xunjie/product-runtime';
import { collectTeachingBoundary, validateTeachingBoundary, createModelGateway, createSpaces, createCourses, createLearningData,
  spaceCourseMigrations, learningMigrations, modelMigrations, teachingAgentMigrations } from '@xunjie/learning-space';
import { createFileBackend } from '@xunjie/storage';
import { executionActionSchema } from '@xunjie/contracts/execution';
import { fixture, reply, until } from './support/teaching-input-control.mjs';
import { runPublishedAggregation } from './support/teaching-recovery.mjs';

test('formal backup accounts for a student Wait and revised queue, then re-derives the same owner facts in isolation', { timeout: 300000 }, async () => {
  const f = await fixture((_payload, response, index) => index === 1 ? reply(response, { calls: [{ id: 'recovery-question', name: 'student_ask',
    arguments: { question: '请保留你的预测。', source: '恢复验收', options: [], allowText: true, skippable: true } }] })
    : reply(response, { text: '按恢复后的原依据继续解释。' }));
  const directory = await mkdtemp(join(tmpdir(), 'xj-conversation-recovery-'));
  let target, restored;
  try {
    await f.configure();
    const activity = await f.activity(), base = `agent/${activity.activityId}`;
    const original = await f.send(activity, '先提问，等待我明确回应。');
    await until(async () => (await f.api(`${base}/conversation`)).questions[0]?.state === 'pending', 'A durable student Wait is visible.');
    const queued = await f.send(activity, '排队的原文。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } });
    const edit = { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'revise', text: '保留修订后的原文。' };
    const edited = await f.api(`${base}/inputs/${queued.inputId}/control`, edit);
    const before = await f.api(`${base}/conversation`), context = await f.api('context'), key = randomBytes(32);
    await f.runtime.setCredential('conversation-recovery', key.toString('base64'));
    const backup = await f.runtime.recovery.backup({ directory, recoveryKeyRef: 'conversation-recovery', leaveClosed: true });
    const agentBoundary = backup.boundary.services.find(service => service.kind === 'xunjie.teaching-agent.boundary');
    assert.ok(agentBoundary, 'The Agent must attest its received domain facts rather than report an empty generic storage boundary.');
    assert.equal(agentBoundary.unresolved, 1);
    restored = await restoreProductRecovery({ root: join(directory, 'target'), resources: f.resources,
      backupDirectory: join(directory, backup.backupId), key });
    const owner = restored.owners.find(owner => owner.participant.descriptor.serviceId === agentBoundary.serviceId);
    const material = await owner.material({ backupId: backup.backupId, boundaryAt: backup.boundaryAt, signal: new AbortController().signal });
    assert.equal(material.evidence.tables.teaching_runs.count, 1);
    assert.equal(material.evidence.tables.teaching_waits.count, 1);
    assert.equal(material.evidence.tables.teaching_inputs.count, 2);
    assert.equal(material.evidence.tables.teaching_input_revisions.count, 3);
    assert.equal(material.evidence.tables.teaching_student_questions.count, 1);
    assert.equal(material.evidence.tables.teaching_budgets.count, 1);
    assert.equal(material.evidence.pending.studentQuestions, 1);
    for (const entry of restored.owners) await entry.close?.();
    restored = undefined;
    target = openProductRuntime({ root: join(directory, 'target'), resources: f.resources });
    const state = await target.start();
    assert.equal(state.state, 'maintenance');
    const read = async route => { const response = await fetch(state.endpoint + '/api/learning/' + route, { headers: { 'x-xj-space': 'personal' } });
      assert.equal(response.status, 200); return response.json(); };
    const after = await read(`${base}/conversation`);
    for (const field of ['messages', 'inputs', 'questions', 'tools']) assert.deepEqual(after[field], before[field], field);
    assert.deepEqual(after.waits.map(wait => [wait.waitId, wait.deadline, wait.state]), before.waits.map(wait => [wait.waitId, wait.deadline, wait.state]));
    assert.deepEqual(after.runs.map(run => [run.runId, run.state, run.usage]), before.runs.map(run => [run.runId, run.state, run.usage]));
    assert.deepEqual(await read(`${base}/controls/${edit.requestId}`), edited);
    assert.equal(after.runs[0].runId, original.runId);
    assert.equal(f.payloads.length, 1, 'History and isolated restore cannot generate another answer.');
    const question = after.questions[0];
    const answer = { requestId: randomUUID(), questionVersion: question.version, waitVersion: question.waitVersion,
      answer: { kind: 'text', text: '我的明确预测仍属于原问题。' } };
    const post = async (route, body, namespace) => {
      const response = await fetch(state.endpoint + '/api/learning/' + route, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal', 'x-xj-namespace': namespace }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await post(`${base}/questions/${question.questionId}/responses`, answer, context.clientNamespace)).status, 503);
    // The operation commits through the production control boundary; the caller loses its result.
    const takeover = { sourceRoot: f.root, receivers: [] };
    await assert.rejects(async () => { await target.recovery.takeover(takeover); throw new Error('lost takeover confirmation'); }, /lost takeover confirmation/);
    assert.equal((await target.recovery.takeover(takeover)).phase, 'active');
    const restoredContext = await read('context');
    assert.notEqual(restoredContext.clientNamespace, context.clientNamespace);
    assert.equal((await post(`${base}/questions/${question.questionId}/responses`, answer, context.clientNamespace)).status, 403);
    const accepted = await post(`${base}/questions/${question.questionId}/responses`, answer, restoredContext.clientNamespace);
    assert.equal(accepted.status, 200); assert.equal(accepted.body.status, 'accepted');
    const final = await until(async () => {
      const value = await read(`${base}/conversation`);
      return value.runs.length === 2 && value.runs.every(run => run.state === 'completed') ? value : null;
    }, 'The original Run and then its revised FIFO input complete after takeover.', 60000);
    assert.equal(final.runs[0].runId, original.runId);
    assert.deepEqual(final.runs[0].usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
    assert.deepEqual(final.runs[1].usage, { state: 'final', inputTokens: 20, outputTokens: 10, totalTokens: 30 });
    assert.deepEqual(await read(`${base}/responses/${answer.requestId}`), accepted.body);
    assert.equal(f.payloads.length, 3);
    assert.match(JSON.stringify(f.payloads[1]), /我的明确预测仍属于原问题/);
    assert.match(JSON.stringify(f.payloads[2]), /保留修订后的原文/);
    await assert.rejects(f.runtime.start(), error => error.code === 'source-retired');
  } finally {
    for (const owner of restored?.owners ?? []) await owner.close?.();
    await target?.stop(); await f.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xj-conversation-recovery-')) throw new Error('Unexpected cleanup target');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a paused Run with an unconfirmed real physical model call remains unknown in owner maintenance', { timeout: 180000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (_payload, response) => { await gate; reply(response, { text: '原调用的真实结果。' }); });
  let observer;
  try {
    const activity = await f.activity(), c = await f.controlled(activity);
    // A separate real Gateway handle has no process-local dispatch confirmation. It does not fabricate a fact.
    observer = await createModelGateway(c.modelStorage, { authorize: async () => {} });
    const agent = c.makeAgent({ models: { ...c.models, checks: { ...c.models.checks, read: observer.checks.read } } });
    agent.resume();
    const first = await c.send('保留尚未确认结束的原调用。', undefined, [], agent);
    const paused = await until(async () => { const value = await agent.run(c.identity, activity.activityId, first.runId);
      return value.state === 'paused' && value.reason === 'result-unknown' ? value : null;
    }, 'The real unconfirmed dispatcher observation pauses the original Run.');
    assert.equal(f.payloads.length, 1);
    agent.closeWrites(); agent.closeDispatch(); await agent.drain();
    const participant = c.storage.participant(); await participant.closeDispatch(); await participant.closeWrites(); await participant.drain();
    const boundary = await collectTeachingBoundary(c.storage), pending = boundary.unresolved.find(item => item.executionRef === paused.runId);
    assert.equal(pending.statusKnowledge, 'unknown'); assert.equal(pending.disposition, 'unknown');
  } finally { release(); observer?.closeWrites(); await f.close(); }
});

test('a complete native result before Agent association survives formal restore and seals its original segment', { timeout: 300000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'fixed.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '原始测量是 37 和 46。' };
  const f = await fixture(async (_payload, response, index) => {
    if (index === 1) { await gate; reply(response, { calls: [{ id: 'fixed-original', name: 'read_work', arguments: { objectId: work.objectId, contentId: work.contentId } }] }); }
    else reply(response, { text: '固定测量仍是 37 和 46。' });
  });
  const directory = await mkdtemp(join(tmpdir(), 'xj-conversation-recovery-'));
  const handles = [];
  let target, restored, sourceHost, sourceApplication, failure, stage = 'source';
  async function openOwner(root, unit, migrations) {
    const environment = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8'));
    const service = environment.services.find(item => item.unit === unit);
    const storage = await openRecoveredStorage({ root, serviceId: service.serviceId, migrations,
      backend: createFileBackend({ id: unit, root: join(root, 'learning-resources', unit) }) });
    handles.push(storage); return storage;
  }
  try {
    await f.runtime.stop();
    sourceHost = await createProductRuntimeHost({ root: f.root, createApplication: async context => {
      sourceApplication = await createProductLearningApplication(context); return sourceApplication;
    } });
    await f.configure();
    const activity = await f.activity(), base = `agent/${activity.activityId}`;
    await f.api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    const first = await f.send(activity, '读取这次固定的原始测量。', undefined, [work]);
    await until(() => f.payloads.length === 1, 'The actual upstream call starts.');
    const events = await f.api(base + '/events'), snapshotEvent = events.find(event => event.kind === 'context-assembled');
    const environment = JSON.parse(await readFile(join(f.root, 'environment.json'), 'utf8'));
    const agentId = environment.services.find(item => item.unit === 'teaching-agent').serviceId;
    const sourceAgent = sourceApplication.owners.find(owner => owner.participant.descriptor.serviceId === agentId);
    stage = 'gate';
    // Public owner maintenance gate faults only association timing; the real model owner completes normally.
    await sourceAgent.participant.closeWrites(); await sourceAgent.participant.closeDispatch();
    const modelStorage = await openOwner(f.root, 'model-connection', modelMigrations);
    const model = await createModelGateway(modelStorage, { authorize: async () => {} });
    stage = 'native-result';
    release();
    const native = await until(async () => { const fact = await model.checks.read(activity.identity, snapshotEvent.body.attemptId);
      return fact.state === 'completed' && fact.physicalRequestEnded && fact.resultRef ? fact : null;
    }, 'The real native result is saved before Agent association.');
    assert.equal((await f.api(base + '/events')).filter(event => event.kind === 'tool-intent').length, 0);
    await f.api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 1,
      files: [{ ...work, contentId: randomUUID(), value: '最新作品变成了 999。' }] });
    const key = randomBytes(32);
    stage = 'backup';
    const backup = await sourceHost.recovery.backup({ directory, key, leaveClosed: true });
    restored = await restoreProductRecovery({ root: join(directory, 'target'), resources: f.resources,
      backupDirectory: join(directory, backup.backupId), key });
    for (const owner of restored.owners) await owner.close?.(); restored = undefined;
    target = openProductRuntime({ root: join(directory, 'target'), resources: f.resources });
    stage = 'isolated';
    const state = await target.start();
    const restoredModel = await createModelGateway(await openOwner(join(directory, 'target'), 'model-connection', modelMigrations), { authorize: async () => {} });
    const isolatedFact = await restoredModel.checks.read(activity.identity, native.attemptId);
    assert.equal(isolatedFact.resultRef, native.resultRef); assert.equal(isolatedFact.requestRef, native.requestRef);
    const api = async (route, body) => { const context = await fetch(state.endpoint + '/api/learning/context', { headers: { 'x-xj-space': 'personal' } }).then(response => response.json());
      const response = await fetch(state.endpoint + '/api/learning/' + route, { headers: { 'x-xj-space': 'personal', 'content-type': 'application/json', 'x-xj-namespace': context.clientNamespace },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, 200, route + ': ' + JSON.stringify(value)); return value;
    };
    assert.equal((await api(base + '/conversation')).tools.length, 0); assert.equal(f.payloads.length, 1);
    await target.recovery.takeover({ sourceRoot: f.root, receivers: [] });
    stage = 'active';
    const final = await until(async () => { const value = await api(base + '/conversation'); return value.runs[0]?.state === 'completed' ? value : null;
    }, 'The saved original attempt is associated and its real tool result continues.', 60000);
    const intent = (await api(base + '/events')).find(event => event.kind === 'tool-intent');
    assert.equal(intent.body.attemptId, native.attemptId); assert.equal(intent.body.resultRef, native.resultRef);
    assert.equal(final.tools[0].result.file.value, work.value); assert.equal(final.runs[0].runId, first.runId);
    assert.equal(f.payloads.length, 2); assert.deepEqual(final.runs[0].usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
    const selection = await api('models/selection');
    const switched = await api(base + '/model-switches', { requestId: randomUUID(), selectionVersion: selection.version });
    assert.equal(switched.state, 'completed');
    assert.notEqual(switched.toSegmentId, native.segment.segmentId);
    const closedSegment = await restoredModel.segments.read(activity.identity, native.segment.segmentId);
    const newSegment = await restoredModel.segments.read(activity.identity, switched.toSegmentId);
    assert.equal(closedSegment.closed, true); assert.equal(newSegment.closed, false);
    // A second formal restore must retain both sealed and newly created native segments without a call.
    await target.setCredential('sealed-segment-recovery', key.toString('base64'));
    stage = 'second-backup';
    const second = await target.recovery.backup({ directory: join(directory, 'second'), recoveryKeyRef: 'sealed-segment-recovery', leaveClosed: true });
    restored = await restoreProductRecovery({ root: join(directory, 'second-target'), resources: f.resources,
      backupDirectory: join(directory, 'second', second.backupId), key });
    const finalModel = await createModelGateway(await openOwner(join(directory, 'second-target'), 'model-connection', modelMigrations), { authorize: async () => {} });
    assert.deepEqual(await finalModel.segments.read(activity.identity, native.segment.segmentId), closedSegment);
    assert.deepEqual(await finalModel.segments.read(activity.identity, switched.toSegmentId), newSegment);
    assert.equal(f.payloads.length, 2);
  } catch (error) { failure = error; throw new Error(stage + ': ' + (error.code ?? '') + ' ' + error.message, { cause: error }); }
  finally {
    release(); for (const owner of restored?.owners ?? []) await owner.close?.();
    for (const handle of handles) await handle.close();
    try { await target?.stop(); await sourceHost?.stop(); await f.close(); }
    catch (error) { if (!failure) throw error; console.error('native-result cleanup: ' + error.message); }
    // The second independent target was validated but never launched.
    const secondTarget = openProductRuntime({ root: join(directory, 'second-target'), resources: f.resources });
    await secondTarget.stop().catch(() => {});
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xj-conversation-recovery-')) throw new Error('Unexpected cleanup target');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('the closed owner rejects a mismatched inventory and unsupported mandatory evidence version', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    await f.configure();
    const activity = await f.activity(), c = await f.controlled(activity);
    c.agent.resume();
    const sent = await c.send('固定一个有真实快照的回答。');
    await until(async () => (await c.agent.run(c.identity, activity.activityId, sent.runId)).state === 'completed', 'The actual result is committed.');
    c.agent.closeWrites(); c.agent.closeDispatch(); await c.agent.drain();
    const participant = c.storage.participant();
    await participant.closeDispatch(); await participant.closeWrites(); await participant.drain();
    const evidence = await collectTeachingBoundary(c.storage);
    assert.equal(evidence.evidence.tables.teaching_runs.count, 1);
    assert.ok(evidence.evidence.resources.length > 0);
    await validateTeachingBoundary(c.storage, evidence);
    await validateTeachingBoundary(c.storage, { kind: 'xunjie.storage.boundary', unresolved: [], settled: 0, retained: {}, blocking: [] });
    const wrongCount = structuredClone(evidence);
    wrongCount.evidence.tables.teaching_runs.count = 0;
    await assert.rejects(validateTeachingBoundary(c.storage, wrongCount), error => error.code === 'corrupt');
    const future = structuredClone(evidence);
    future.evidence.formatVersion = 3;
    await assert.rejects(validateTeachingBoundary(c.storage, future), error => error.code === 'incompatible');
  } finally { await f.close(); }
});

test('an unclaimed real WP03 command survives independent restore; an unconfirmed live browser blocks backup', { timeout: 300000 }, async () => {
  const f = await fixture((_payload, response, index) => index === 1 ? reply(response, { calls: [{ id: 'original-wasm', name: 'course_operation',
    arguments: { componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }] })
    : reply(response, { text: '原计算的真实均值是 83.33333333333333。' }));
  const directory = await mkdtemp(join(tmpdir(), 'xj-conversation-recovery-'));
  let target, restored, settleEffect, finalReport, failure, stage = 'source';
  const handles = [];
  try {
    const session = await f.browserCourse({ withSession: true });
    const { activity, headers } = session, base = `agent/${activity.activityId}`;
    await f.configure(headers);
    const binding = activity.course.components[0], manifest = binding.definition.manifest;
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
        instanceId: activity.activityId + ':table', componentId: manifest.componentId, version: manifest.version,
        definitionDigest: binding.definition.digest, stateVersion: 1, operationId: randomUUID(), content: manifest.initialState }) };
    await f.api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 0, files: [work] }, headers);
    const first = await f.send(activity, '运行真实分组计算。', undefined, [work], headers);
    const before = await until(async () => { const value = await f.api(base + '/conversation', undefined, headers);
      return value.runs[0]?.state === 'waiting' && value.tools.length === 1 ? value : null;
    }, 'The real unclaimed browser command has a durable Agent Wait.');
    const commandId = before.tools[0].commandId, key = randomBytes(32);
    await f.runtime.setCredential('tool-recovery', key.toString('base64'));
    const backup = await f.runtime.recovery.backup({ directory, recoveryKeyRef: 'tool-recovery', leaveClosed: true });
    restored = await restoreProductRecovery({ root: join(directory, 'target'), resources: f.resources,
      backupDirectory: join(directory, backup.backupId), key });
    for (const owner of restored.owners) await owner.close?.(); restored = undefined;
    target = openProductRuntime({ root: join(directory, 'target'), resources: f.resources });
    const state = await target.start(); assert.equal(state.state, 'maintenance');
    let studentHeaders = headers;
    const api = async (route, body) => {
      const response = await fetch(state.endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', ...studentHeaders },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, 200, route + ': ' + JSON.stringify(value)); return value;
    };
    const login = async () => {
      const response = await fetch(state.endpoint + '/api/learning/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(session.login) });
      assert.equal(response.status, 200); studentHeaders = { cookie: response.headers.get('set-cookie').split(';')[0] };
    };
    await login(); // Isolation creates only an in-memory read session; source cookies are not restored.
    const isolated = await api(base + '/conversation');
    assert.deepEqual(isolated.tools, before.tools); assert.deepEqual(isolated.waits, before.waits);
    assert.equal(f.payloads.length, 1);
    await target.recovery.takeover({ sourceRoot: f.root, receivers: [] });
    await login();
    studentHeaders['x-xj-namespace'] = (await api('context')).clientNamespace;
    const browserId = randomUUID(), executionBase = `executions/${activity.activityId}`;
    const claimed = await api(`${executionBase}/agent/${commandId}/claim`, { browserId });
    assert.equal(claimed.association.commandId, commandId);
    const action = claimed.action, acceptance = { receipt: { requestId: commandId, receiver: action.receiver, state: 'accepted',
      inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(action))).digest('hex'), receiptId: 'restore:' + commandId, detail: '' },
      execution: { executionRef: randomUUID(), acceptedSeq: 1 } };
    const accepted = await api(`${executionBase}/agent/${commandId}/accept`, { browserId, acceptance });
    stage = 'compute';
    const { computed, resultInput } = await runPublishedAggregation(action, manifest);
    assert.equal(computed.result.value, 83.33333333333333);
    const environment = JSON.parse(await readFile(join(directory, 'target', 'environment.json'), 'utf8'));
    const open = async (unit, migrations) => {
      const storage = await openRecoveredStorage({ root: join(directory, 'target'),
        serviceId: environment.services.find(service => service.unit === unit).serviceId, migrations,
        backend: createFileBackend({ id: unit, root: join(directory, 'target', 'learning-resources', unit) }) });
      handles.push(storage); return storage;
    };
    const space = await open('space-course', spaceCourseMigrations), spaces = createSpaces(space);
    const learning = createLearningData(await open('learning-data', learningMigrations), spaces, createCourses(space, spaces), {});
    settleEffect = async () => {
      const result = await learning.executions.result(activity.identity, activity.activityId, commandId, resultInput);
      finalReport = { ...result, state: 'succeeded', confirmedSeq: 3 };
      await learning.executions.report(activity.identity, activity.activityId, commandId, finalReport);
    };
    await target.setCredential('live-tool', key.toString('base64'));
    stage = 'unsafe-backup';
    await assert.rejects(target.recovery.backup({ directory: join(directory, 'unsafe'), recoveryKeyRef: 'live-tool' }),
      error => error.code === 'unavailable'); // The execution owner's shutdown refuses an unconfirmed browser Worker before export.
    stage = 'archive-original-result'; await settleEffect();
    stage = 'resume'; await target.recovery.resume();
    assert.equal((await api(`${executionBase}/${commandId}`)).executionRef, accepted.executionRef);
    const final = await until(async () => { const value = await api(base + '/conversation'); return value.runs[0]?.state === 'completed' ? value : null;
    }, 'The restored original command settles from its real result, without replay.', 60000);
    assert.equal(final.runs[0].runId, first.runId); assert.equal(final.tools[0].commandId, commandId);
    assert.equal(final.tools[0].result.query.output.output.value, computed.result.value);
    assert.equal((await api(`workspaces/${activity.activityId}`)).files[0].contentId, work.contentId);
    await api(`${executionBase}/${commandId}/report`, finalReport);
    assert.equal(f.payloads.length, 2);
    assert.deepEqual(final.runs[0].usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
  } catch (error) { failure = error; throw new Error(stage + ': ' + (error.code ?? '') + ' ' + error.message, { cause: error }); }
  finally {
    // Close the real effect even if an assertion fails after its acceptance.
    if (settleEffect) try {
      await settleEffect();
      await target.recovery.resume().catch(() => {});
    } catch { /* The production stop below remains responsible for cleanup. */ }
    for (const owner of restored?.owners ?? []) await owner.close?.();
    for (const handle of handles) await handle.close();
    let stopped = false;
    try { await target?.stop(); stopped = true; } catch (error) { if (!failure) throw error; console.error('WP03 target cleanup: ' + error.message); }
    try { await f.close(); } catch (error) { if (!failure) throw error; console.error('WP03 source cleanup: ' + error.message); }
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xj-conversation-recovery-')) throw new Error('Unexpected cleanup target');
    if (stopped) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
