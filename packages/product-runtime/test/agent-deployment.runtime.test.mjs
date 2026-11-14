import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openStorage, createFileBackend } from '@xunjie/storage';
import { createAgentRuntime } from '@xunjie/agent-runtime';
import { agentServiceMigrations } from '@xunjie/agents/transport/session-storage';
import { resolveCredential } from '@xunjie/product-runtime';
import { installedIndependent, question, completed, until, answer } from './support/installed-agent-v2.mjs';

test('independently installed v2 Agent preserves original sessions and operations through rebinding, process death and backup', { timeout: 240000 }, async t => {
  let held, release;
  const f = await installedIndependent(t, async (_payload, response) => {
    if (held) { const notify = held; held = undefined; await new Promise(resolve => { release = resolve; notify(); }); }
    answer(response, '原活动的独立服务回答');
  }, () => release?.());
  const activity = await f.api('activities', { requestId: randomUUID(), goal: '独立 Agent', question: '', references: [] });
  const local = await f.api('agent-sessions/workspace', { activityId: activity.activityId, target: activity.target });
  const originalLocal = await f.api(`agent-sessions/${local.sessionId}/conversation`);
  const binding = await f.bind(activity.identity);
  assert.deepEqual(await f.api(`agent-sessions/${local.sessionId}/conversation`), originalLocal);
  const remoteActivity = await f.api('activities', { requestId: randomUUID(), goal: '独立原 owner', question: '', references: [] });
  const session = await f.api('agent-sessions/workspace', { activityId: remoteActivity.activityId, target: remoteActivity.target });
  assert.equal(session.owner.target.serviceId, binding.service.serviceId);
  const model = await f.model();
  const input = question(remoteActivity, session, '解释独立运行的 Agent');
  const firstAcceptedAt = Date.now();
  const receipt = await f.api(`agent-sessions/${session.sessionId}/inputs`, input);
  assert.deepEqual(await f.api(`agent-sessions/${session.sessionId}/inputs`, input), receipt);
  let conversation = await completed(f.api, session.sessionId, receipt.runId);
  t.diagnostic(JSON.stringify({ firstDispatchMs: f.requestTimes[0] - firstAcceptedAt, firstRunMs: Date.now() - firstAcceptedAt }));
  assert.equal(conversation.messages.filter(item => item.role === 'assistant').at(-1).text, '原活动的独立服务回答');
  const first = await f.api(`agent-sessions/${session.sessionId}/snapshots/${receipt.runId}`);
  const firstModel = first.steps.find(step => step.operation.kind === 'model.call');
  assert.ok(firstModel); assert.equal(firstModel.result.value.attempt.connection.connectionId, model.connectionId);
  await f.restartAgent();
  assert.deepEqual(await f.api(`agent-sessions/${session.sessionId}/conversation`), conversation);
  const initialCalls = f.requests.length;
  const started = new Promise(resolve => { held = resolve; });
  const nextInput = question(remoteActivity, session, '重启后查询同一个请求');
  const next = await f.api(`agent-sessions/${session.sessionId}/inputs`, nextInput);
  await started;
  const before = await f.api(`agent-sessions/${session.sessionId}/snapshots/${next.runId}`);
  const originalOperation = before.steps.find(step => step.operation.kind === 'model.call').operation.operationId;
  const owner = JSON.parse(await readFile(join(f.root, 'agent', 'instance.json'), 'utf8'));
  process.kill(owner.pid, 'SIGKILL'); release();
  await f.recoverAgent();
  await until(async () => {
    const value = await f.api(`agent-sessions/${session.sessionId}/runs/${next.runId}`);
    return ['completed', 'paused', 'stopped', 'failed'].includes(value.state) ? value : null;
  }, 'The successor did not reconcile the original operation.');
  const after = await f.api(`agent-sessions/${session.sessionId}/snapshots/${next.runId}`);
  assert.equal(after.steps.find(step => step.operation.kind === 'model.call').operation.operationId, originalOperation);
  assert.equal(f.requests.length, initialCalls + 1, 'restart must never send a replacement model request');
  assert.deepEqual(await f.api(`agent-sessions/${session.sessionId}/requests/${nextInput.requestId}`), { receipt: next, input: nextInput });
  conversation = await f.api(`agent-sessions/${session.sessionId}/conversation`);
  await f.api('manage/agent-binding', { requestId: randomUUID(), identity: activity.identity, connectionId: session.owner.connectionId,
    target: binding.service, installationId: randomUUID() }, f.admin);
  assert.deepEqual(await f.api(`agent-sessions/${session.sessionId}/conversation`), conversation);
  const key = randomBytes(32).toString('base64');
  await f.school.setCredential('deployment-recovery', key); await f.agent.setCredential('deployment-recovery', key);
  const schoolBackup = await f.school.recovery.backup({ directory: join(f.root, 'school-backups'), recoveryKeyRef: 'deployment-recovery' });
  const agentBackup = await f.agent.recovery.backup({ directory: join(f.root, 'agent-backups'), recoveryKeyRef: 'deployment-recovery' });
  assert.ok(schoolBackup.services.some(owner => owner.serviceId === binding.data.serviceId));
  assert.ok(agentBackup.services.some(owner => owner.serviceId === binding.service.serviceId));
  assert.equal(f.requests.length, initialCalls + 1);
});

test('revoking the original dependency grant aborts an independent Agent SDK request without replaying its input', { timeout: 180000 }, async t => {
  let release, closed = false;
  const f = await installedIndependent(t, async (_payload, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '' }, finish_reason: null }] }) + '\n\n');
    response.once('close', () => { closed = true; });
    await new Promise(resolve => { release = resolve; });
    response.end('data: [DONE]\n\n');
  }, () => release?.());
  const activity = await f.api('activities', { requestId: randomUUID(), goal: '撤销原许可', question: '', references: [] });
  const binding = await f.bind(activity.identity); await f.model();
  const session = await f.api('agent-sessions/workspace', { activityId: activity.activityId, target: activity.target });
  const base = `agent-sessions/${session.sessionId}`, input = question(activity, session, '保留这个原始请求');
  const receipt = await f.api(base + '/inputs', input);
  await until(() => f.requests.length === 1 && release, 'The original physical SDK request did not start.');
  const original = await f.api(base + '/snapshots/' + receipt.runId);
  const operation = original.steps.find(step => step.operation.kind === 'model.call').operation.operationId;
  assert.equal(await f.school.revoke(binding.dependencyGrant.grantId, binding.data.serviceId), true);
  await until(() => closed, 'The original model owner did not abort after the Agent dependency grant was revoked.', 20000);
  assert.deepEqual(await f.api(base + '/requests/' + input.requestId, undefined, {}, 403), { error: 'forbidden' });
  const ownerBinding = JSON.parse(await resolveCredential(join(f.root, 'agent'), 'storage-' + binding.service.serviceId));
  const storage = await openStorage({ binding: ownerBinding, migrations: agentServiceMigrations,
    backend: createFileBackend({ id: 'teaching-agent', root: join(f.root, 'agent/learning-resources/teaching-agent') }) });
  const retainedOwner = createAgentRuntime(storage, { readOnly: true, authorize: async who => { assert.deepEqual(who, activity.identity); } });
  try {
    assert.deepEqual(await retainedOwner.request(activity.identity, session.sessionId, input.requestId), { receipt, input });
    const retained = await retainedOwner.snapshot(activity.identity, session.sessionId, receipt.runId);
    assert.equal(retained.steps.find(step => step.operation.kind === 'model.call').operation.operationId, operation);
  } finally { await retainedOwner.close(); await storage.close(); }
  assert.equal(f.requests.length, 1);
});
