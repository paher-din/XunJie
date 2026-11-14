import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProductRuntimeHost, createProductLearningApplication, openProductRuntime, restoreProductRecovery, resolveCredential } from '@xunjie/product-runtime';
import { StorageError } from '@xunjie/storage';
import { fixture, reply, until } from './support/session-product.mjs';
import { recoveryCourse, runPublishedAggregation } from './support/teaching-recovery.mjs';
import { question, bindIndependent } from '../../../packages/product-runtime/test/support/installed-agent-v2.mjs';
import { executionActionSchema } from '@xunjie/contracts/execution';

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

// Real installed owners, an independent Agent process, authenticated v2 connections and
// the published browser Wasm. Only the model supplier and a failed receiver reply are controlled.
test('a restored independent v2 Agent continues the original Wasm wait through the existing data owner', { timeout: 300000 }, async t => {
  const f = await fixture((_payload, response, index) => {
    if (index === 1) return reply(response, { calls: [{ id: 'dormant-question', name: 'student_ask',
      arguments: { question: '原服务保存的预测是什么？', source: '固定学习依据', options: [], allowText: true, skippable: true } }] });
    if (index === 2) return reply(response, { calls: [{ id: 'original-wasm', name: 'course_operation',
      arguments: { componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }] });
    reply(response, { text: '恢复服务沿原命令和真实均值 83.33333333333333 继续。' });
  });
  const directory = await mkdtemp(join(tmpdir(), 'xj-independent-recovery-'));
  const sourceRoot = join(directory, 'source'), targetRoot = join(directory, 'target');
  const source = openProductRuntime({ root: sourceRoot, resources: f.resources });
  const target = openProductRuntime({ root: targetRoot, resources: f.resources });
  let backend = await freePort(), restored, receiverHost, failure, liveCommand, report;
  const proxy = createServer((incoming, outgoing) => {
    const forwarded = httpRequest({ hostname: '127.0.0.1', port: backend, path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
    });
    forwarded.on('error', () => { outgoing.writeHead(503); outgoing.end(); }); incoming.pipe(forwarded);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const publicEndpoint = `http://127.0.0.1:${proxy.address().port}`;
  try {
    await f.runtime.stop();
    let failMaterialOnce = true;
    receiverHost = await createProductRuntimeHost({ root: f.root, createApplication: async context => {
      const application = await createProductLearningApplication(context);
      return { ...application, owners: application.owners.map(owner => !owner.receiverMaterial ? owner : { ...owner,
        async receiverMaterial(input) {
          if (failMaterialOnce) { failMaterialOnce = false; throw new StorageError('unavailable'); }
          return owner.receiverMaterial(input);
        } }) };
    } });
    await f.configure();
    const dormant = await f.activity('接收学校中无关的休眠学习对话');
    const dormantInput = await f.send(dormant, '保留这个未回应的问题。');
    const dormantBase = `agent-sessions/${dormantInput.sessionId}`;
    const dormantBefore = await until(async () => { const value = await f.api(dormantBase + '/conversation');
      return value.waits.some(wait => wait.kind === 'user' && wait.state === 'pending') ? value : null;
    }, 'The school holds its own dormant user wait.');
    const { activity, headers, manifest, work } = await recoveryCourse(f);
    const api = (route, body) => f.api(route, body, headers);
    const schoolState = await f.runtime.status(), schoolEnvironment = schoolState.environment;
    const dependencyConnectionId = randomUUID(), agentConnectionId = randomUUID();
    await source.install({ profile: 'agent', agent: { dependencyConnectionId }, port: backend, publicEndpoint });
    const sourceState = await source.start();
    const { data, service: agent } = await bindIndependent({ school: f.runtime, agent: source, schoolState, agentState: sourceState,
      dependencyConnectionId, agentConnectionId, identity: activity.identity, api: f.api,
      admin: { authorization: 'Bearer ' + await resolveCredential(f.root, 'control') } });
    const session = await api('agent-sessions/workspace', { activityId: activity.activityId, target: activity.target });
    const base = `agent-sessions/${session.sessionId}`;
    const input = question(activity, session, '计算真实均值并保留原命令。', randomUUID(), { works: [work] });
    const first = await api(base + '/inputs', input), startedAt = Date.now();
    async function waitFor(state) {
      return until(async () => {
        const run = await api(base + '/runs/' + first.runId);
        assert.ok(!['paused', 'failed', 'stopped'].includes(run.state), JSON.stringify(run));
        if (run.state !== state) return null;
        const value = await api(base + '/conversation');
        return state !== 'waiting' || value.waits.some(wait => wait.kind === 'workspace-execution' && wait.state === 'pending') ? value : null;
      }, 'The original independent Run did not become ' + state, 60000);
    }
    const before = await waitFor('waiting');
    const originalWait = before.waits.find(wait => wait.kind === 'workspace-execution' && wait.state === 'pending');
    assert.ok(originalWait, 'The original workspace command has a durable execution wait.');
    const commandId = originalWait.presentation.commandId;
    const pending = await api(`executions/${activity.activityId}/agent-pending`);
    assert.equal(pending.filter(item => item.association.commandId === commandId).length, 1);
    const snapshotBefore = await api(base + '/snapshots/' + first.runId);
    const originalStep = snapshotBefore.steps.find(step => step.operation.operationId === commandId);
    assert.equal(originalStep.continuationOpen, true);
    const originalReceipt = await api(base + '/requests/' + input.requestId);
    assert.deepEqual(originalReceipt.input, input);
    const key = randomBytes(32); await source.setCredential('independent-backup', key.toString('base64'));
    const backup = await source.recovery.backup({ directory: join(directory, 'backups'), recoveryKeyRef: 'independent-backup', leaveClosed: true });
    const targetPort = await freePort();
    restored = await restoreProductRecovery({ root: targetRoot, resources: f.resources,
      backupDirectory: join(directory, 'backups', backup.backupId), key,
      installation: { profile: 'agent', publicEndpoint, port: targetPort } });
    const owner = restored.owners.find(item => item.participant.descriptor.serviceId === agent.serviceId);
    const material = await owner.material({ backupId: backup.backupId, boundaryAt: backup.boundaryAt, signal: new AbortController().signal });
    assert.equal(material.kind, 'xunjie.agent-runtime.boundary/2');
    assert.equal(material.evidence.tables.agent_runs.count, 1);
    assert.equal(material.evidence.pending.waits, 1);
    assert.equal(material.evidence.pending.continuations, 1);
    for (const entry of restored.owners) await entry.close?.(); restored = undefined;
    const isolated = await target.start(); assert.equal(isolated.state, 'maintenance'); assert.equal(f.payloads.length, 2);
    const takeover = { sourceRoot, receivers: [{ id: `${data.environmentId}/${data.serviceId}`, root: f.root }] };
    await assert.rejects(target.recovery.takeover(takeover), error => error.code === 'maintenance-failed');
    assert.equal(failMaterialOnce, false, 'Takeover actually reaches the receiving data owner.');
    await target.recovery.takeover(takeover); backend = targetPort;
    const freshInbound = await target.authorize({ sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
      sourceInstallationId: schoolEnvironment.installationId, capabilities: ['agent.sessions.v2'] }, agent.serviceId);
    const reconnected = { connectionId: agentConnectionId, sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
      target: agent, requiredCapabilities: ['agent.sessions.v2'], optionalCapabilities: [], credentialRef: 'recovery-agent-v2' };
    await f.runtime.reconnect(reconnected, freshInbound.token); await f.runtime.reconnect(reconnected, freshInbound.token);
    const dependency = { connectionId: dependencyConnectionId, sourceEnvironmentId: agent.environmentId, sourceServiceId: agent.serviceId,
      target: data, requiredCapabilities: ['agent.dependencies.v2'], optionalCapabilities: [], credentialRef: 'recovery-dependencies-v2' };
    const freshDependency = await f.runtime.authorize({ sourceEnvironmentId: agent.environmentId, sourceServiceId: agent.serviceId,
      sourceInstallationId: isolated.environment.installationId, capabilities: ['agent.dependencies.v2'] }, data.serviceId);
    await target.connect(dependency, freshDependency.token);
    const after = await api(base + '/conversation');
    const grants = await Promise.all([0, 1].map(() => f.runtime.authorize({ sourceEnvironmentId: agent.environmentId, sourceServiceId: agent.serviceId,
      sourceInstallationId: isolated.environment.installationId, capabilities: ['agent.dependencies.v2'] }, data.serviceId)));
    await target.reconnect({ ...dependency, credentialRef: 'recovery-dependencies-rotated' }, grants[0].token);
    await f.runtime.revoke(grants[1].grantId); await f.runtime.revoke(freshDependency.grantId);
    await target.recovery.takeover(takeover);
    assert.deepEqual((await api(base + '/conversation')).waits, after.waits);
    assert.deepEqual(after.waits, before.waits);
    assert.deepEqual(await api(base + '/requests/' + input.requestId), originalReceipt);
    const recoveredSnapshot = await api(base + '/snapshots/' + first.runId);
    assert.equal(recoveredSnapshot.steps.find(step => step.operation.operationId === commandId).stepId, originalStep.stepId);
    const executionBase = `executions/${activity.activityId}`, browserId = randomUUID();
    const claimed = await api(`${executionBase}/agent/${commandId}/claim`, { browserId });
    assert.equal(claimed.association.commandId, commandId);
    const action = claimed.action;
    const accepted = await api(`${executionBase}/agent/${commandId}/accept`, { browserId, acceptance: {
      receipt: { requestId: commandId, receiver: action.receiver, state: 'accepted',
        inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(action))).digest('hex'),
        receiptId: 'independent:' + commandId, detail: '' }, execution: { executionRef: randomUUID(), acceptedSeq: 1 } } });
    liveCommand = { api, executionBase, commandId };
    const { computed, resultInput } = await runPublishedAggregation(action, manifest);
    assert.equal(computed.result.value, 83.33333333333333);
    const result = await api(`${executionBase}/${commandId}/result`, resultInput);
    report = { ...result, state: 'succeeded', confirmedSeq: 3 };
    await api(`${executionBase}/${commandId}/report`, report);
    const final = await waitFor('completed');
    assert.equal(final.runs[0].runId, first.runId); assert.equal(f.payloads.length, 3);
    assert.equal(final.waits.find(wait => wait.waitId === originalWait.waitId).state, 'consumed');
    assert.equal((await api(`${executionBase}/${commandId}`)).executionRef, accepted.executionRef);
    const finalSnapshot = await api(base + '/snapshots/' + first.runId);
    assert.equal(finalSnapshot.steps.filter(step => step.operation.operationId === commandId).length, 1);
    assert.equal(finalSnapshot.steps.find(step => step.operation.operationId === commandId).continuationOpen, false);
    assert.equal((await api(`workspaces/${activity.activityId}`)).files[0].contentId, work.contentId);
    await api(`${executionBase}/${commandId}/report`, report);
    assert.equal(f.payloads.length, 3, 'A duplicate original report never sends a second model continuation.');
    assert.deepEqual((await f.api(dormantBase + '/conversation')).waits, dormantBefore.waits);
    assert.equal((await f.api(dormantBase + '/runs/' + dormantInput.runId)).state, 'waiting');
    await assert.rejects(source.start(), error => error.code === 'source-retired');
    t.diagnostic('Original Wasm wait, restore, failed/retried takeover, credential rotation and continuation completed in ' + (Date.now() - startedAt) + 'ms.');
  } catch (error) { failure = error; throw error; }
  finally {
    if (liveCommand) {
      const { api, executionBase, commandId } = liveCommand;
      if (report) await api(`${executionBase}/${commandId}/report`, report).catch(() => {});
      else await api(`${executionBase}/${commandId}/stop`, { stopId: randomUUID(), reason: 'fixture cleanup' }).catch(() => {});
    }
    for (const owner of restored?.owners ?? []) await owner.close?.();
    const errors = [];
    for (const [runtime, root] of [[target, targetRoot], [source, sourceRoot]]) if (await access(join(root, 'installation.json')).then(() => true, () => false)) {
      try { await runtime.stop(); } catch (error) { errors.push(error); }
    }
    try { await receiverHost?.stop(); } catch (error) { errors.push(error); }
    try { await f.close(); } catch (error) { errors.push(error); }
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    if (!errors.length) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    else if (!failure) throw new AggregateError(errors, 'Independent recovery cleanup failed');
  }
});
