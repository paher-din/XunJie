import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { test } from 'node:test';
import { openProductRuntime, openRecoveredStorage, restoreProductRecovery } from '@xunjie/product-runtime';
import { createSpaces, createCourses, createLearningData, createExecutionOwner, executionOwnerMigrations,
  spaceCourseMigrations, learningMigrations } from '@xunjie/learning-space';
import { createFileBackend } from '@xunjie/storage';
import { executionActionSchema } from '@xunjie/contracts/execution';
import { fixture, reply, until } from './support/session-product.mjs';
import { recoveryCourse, runPublishedAggregation } from './support/teaching-recovery.mjs';
import { question } from '../../../packages/product-runtime/test/support/installed-agent-v2.mjs';

test('an unclaimed current session command survives local owner restore; an unconfirmed live browser blocks backup', { timeout: 300000 }, async () => {
  const f = await fixture((_payload, response, index) => index === 1 ? reply(response, { calls: [{ id: 'original-wasm', name: 'course_operation',
    arguments: { componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }] })
    : reply(response, { text: '原计算的真实均值是 83.33333333333333。' }));
  const directory = await mkdtemp(join(tmpdir(), 'xj-conversation-recovery-'));
  let target, restored, settleEffect, finalReport, failure, stage = 'source';
  const handles = [];
  try {
    await f.configure();
    let memberLogin;
    const { activity, headers, manifest, work } = await recoveryCourse({ ...f, async api(route, body, ...args) {
      if (route === 'manage/members') memberLogin = { loginName: body.loginName, password: body.password };
      return f.api(route, body, ...args);
    } });
    const session = await f.api('agent-sessions/workspace', { activityId: activity.activityId, target: activity.target }, headers);
    const base = `agent-sessions/${session.sessionId}`;
    const input = question(activity, session, '运行真实分组计算。', randomUUID(), { works: [work] });
    const first = await f.api(base + '/inputs', input, headers);
    const before = await until(async () => { const value = await f.api(base + '/conversation', undefined, headers);
      return value.runs[0]?.state === 'waiting' && value.waits.some(wait => wait.kind === 'workspace-execution' && wait.state === 'pending') ? value : null;
    }, 'The real unclaimed browser command has a durable Agent Wait.');
    const originalWait = before.waits.find(wait => wait.kind === 'workspace-execution' && wait.state === 'pending');
    const commandId = originalWait.presentation.commandId, key = randomBytes(32);
    const originalSnapshot = await f.api(base + '/snapshots/' + first.runId, undefined, headers);
    const originalStep = originalSnapshot.steps.find(step => step.operation.operationId === commandId);
    const originalReceipt = await f.api(base + '/requests/' + input.requestId, undefined, headers);
    await f.runtime.setCredential('tool-recovery', key.toString('base64'));
    const backup = await f.runtime.recovery.backup({ directory, recoveryKeyRef: 'tool-recovery', leaveClosed: true });
    restored = await restoreProductRecovery({ root: join(directory, 'target'), resources: f.resources,
      backupDirectory: join(directory, backup.backupId), key });
    for (const owner of restored.owners) await owner.close?.(); restored = undefined;
    target = openProductRuntime({ root: join(directory, 'target'), resources: f.resources });
    const state = await target.start(); assert.equal(state.state, 'maintenance');
    let studentHeaders = headers;
    const api = async (route, body) => {
      const response = await fetch(state.endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', 'x-xj-agent-contract': '2', ...studentHeaders },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, 200, route + ': ' + JSON.stringify(value)); return value;
    };
    const login = async () => {
      const response = await fetch(state.endpoint + '/api/learning/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(memberLogin) });
      assert.equal(response.status, 200); studentHeaders = { cookie: response.headers.get('set-cookie').split(';')[0] };
    };
    await login(); // Isolation creates only an in-memory read session; source cookies are not restored.
    const isolated = await api(base + '/conversation');
    assert.deepEqual(isolated.waits, before.waits);
    assert.deepEqual(await api(base + '/snapshots/' + first.runId), originalSnapshot);
    assert.deepEqual(await api(base + '/requests/' + input.requestId), originalReceipt);
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
    const { executions } = createExecutionOwner(await open('tool-execution', executionOwnerMigrations), {
      activity: learning.open, sourceFile: learning.works.content });
    settleEffect = async () => {
      const result = await executions.result(activity.identity, activity.activityId, commandId, resultInput);
      finalReport = { ...result, state: 'succeeded', confirmedSeq: 3 };
      await executions.report(activity.identity, activity.activityId, commandId, finalReport);
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
    assert.equal(final.runs[0].runId, first.runId);
    assert.equal(final.waits.find(wait => wait.waitId === originalWait.waitId).state, 'consumed');
    const finalSnapshot = await api(base + '/snapshots/' + first.runId);
    const completed = finalSnapshot.steps.filter(step => step.operation.operationId === commandId);
    assert.equal(completed.length, 1); assert.equal(completed[0].stepId, originalStep.stepId);
    assert.equal(completed[0].continuationOpen, false);
    assert.equal((await api(`${executionBase}/${commandId}`)).output.output.value, computed.result.value);
    assert.equal((await api(`workspaces/${activity.activityId}`)).files[0].contentId, work.contentId);
    await api(`${executionBase}/${commandId}/report`, finalReport);
    assert.equal(f.payloads.length, 2);
    const attempts = finalSnapshot.steps.filter(step => step.operation.kind === 'model.call').map(step => step.result.value.attempt);
    assert.equal(attempts.reduce((sum, attempt) => sum + attempt.usage.inputTokens, 0), 40);
    assert.equal(attempts.reduce((sum, attempt) => sum + attempt.usage.outputTokens, 0), 20);
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
