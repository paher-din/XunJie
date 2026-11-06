import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { test } from 'node:test';
import { openProductRuntime, restoreProductRecovery, resolveCredential } from '@xunjie/product-runtime';
import { fixture, reply, until } from './support/teaching-input-control.mjs';
import { runPublishedAggregation } from './support/teaching-recovery.mjs';
import { executionActionSchema } from '@xunjie/contracts/execution';

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

for (const mode of ['student', 'tool']) test(`a restored independent Agent continues its original ${mode} Wait through the existing learning-data route`, { timeout: 300000 }, async () => {
  const f = await fixture((_payload, response, index) => {
    if (index === 1 || mode === 'student' && index === 2) return reply(response, { calls: [{ id: 'independent-question', name: 'student_ask',
      arguments: { question: '原服务保存的预测是什么？', source: '固定学习依据', options: [], allowText: true, skippable: true } }] });
    if (mode === 'tool' && index === 2) return reply(response, { calls: [{ id: 'independent-wasm', name: 'course_operation',
      arguments: { componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } }] });
    reply(response, { text: '恢复服务沿原问题和真实结果继续。' });
  });
  const directory = await mkdtemp(join(tmpdir(), 'xj-independent-recovery-'));
  const sourceRoot = join(directory, 'source'), targetRoot = join(directory, 'target');
  const source = openProductRuntime({ root: sourceRoot, resources: f.resources });
  const target = openProductRuntime({ root: targetRoot, resources: f.resources });
  let backend = await freePort(), restored, failure, browser, page;
  // A stable product address forwards real HTTP only. Both sides remain full production hosts.
  const proxy = createServer((incoming, outgoing) => {
    const forwarded = httpRequest({ hostname: '127.0.0.1', port: backend, path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
    });
    forwarded.on('error', () => { outgoing.writeHead(503); outgoing.end(); }); incoming.pipe(forwarded);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const publicEndpoint = `http://127.0.0.1:${proxy.address().port}`;
  try {
    await f.configure();
    const dormant = await f.activity('接收学校中无关的休眠学习对话');
    await f.send(dormant, '保留这个未回应的问题。');
    const dormantBefore = await until(async () => { const value = await f.api(`agent/${dormant.activityId}/conversation`);
      return value.questions[0]?.state === 'pending' ? value : null;
    }, 'The receiving school also holds a dormant local student Wait.');
    const course = mode === 'tool' ? await f.browserCourse({ withSession: true }) : null;
    const activity = course?.activity ?? await f.activity(), base = `agent/${activity.activityId}`;
    const api = (route, body) => f.api(route, body, course?.headers);
    if (course) await f.configure(course.headers);
    const binding = activity.course?.components[0], manifest = binding?.definition.manifest;
    const works = manifest ? [{ objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1, instanceId: activity.activityId + ':table',
        componentId: manifest.componentId, version: manifest.version, definitionDigest: binding.definition.digest,
        stateVersion: 1, operationId: randomUUID(), content: manifest.initialState }) }] : [];
    if (works.length) await api(`workspaces/${activity.activityId}`, { requestId: randomUUID(), baseRevision: 0, files: works });
    const schoolEnvironment = (await f.runtime.status()).environment;
    const data = schoolEnvironment.services.find(service => service.unit === 'learning-data');
    const dependencyConnectionId = randomUUID(), agentConnectionId = randomUUID();
    await source.install({ profile: 'agent', agent: { dependencyConnectionId }, port: backend, publicEndpoint });
    const sourceState = await source.start(), agent = sourceState.environment.services.find(service => service.unit === 'teaching-agent');
    const inbound = await source.authorize({ sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
      sourceInstallationId: schoolEnvironment.installationId, capabilities: ['teaching.agent'] }, agent.serviceId);
    const schoolConnection = { connectionId: agentConnectionId, sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
      target: agent, requiredCapabilities: ['teaching.agent'], optionalCapabilities: [], credentialRef: 'recovery-independent-agent' };
    await f.runtime.connect(schoolConnection, inbound.token);
    await f.api('manage/agent-binding', { requestId: randomUUID(), identity: activity.identity, connectionId: agentConnectionId,
      target: agent, installationId: sourceState.environment.installationId }, { authorization: 'Bearer ' + await resolveCredential(f.root, 'control') });
    const dependency = { connectionId: dependencyConnectionId, sourceEnvironmentId: agent.environmentId, sourceServiceId: agent.serviceId,
      target: data, requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [], credentialRef: 'recovery-dependencies' };
    const grant = await f.runtime.authorize({ sourceEnvironmentId: agent.environmentId, sourceServiceId: agent.serviceId,
      sourceInstallationId: sourceState.environment.installationId, capabilities: ['teaching.dependencies'] }, data.serviceId);
    await source.connect(dependency, grant.token);
    const first = await f.send(activity, mode === 'tool' ? '计算真实均值并保留原命令。' : '提问后等待我的明确回应。', undefined, works, course?.headers);
    const before = await until(async () => {
      const read = await f.raw(base + '/conversation', undefined, course?.headers);
      if (read.status === 503 && read.body.error === 'unavailable') return null;
      assert.equal(read.status, 200, JSON.stringify(read.body));
      const value = read.body; return value.runs[0]?.state === 'waiting'
      && (mode === 'tool' ? value.tools.length === 1 : value.questions[0]?.state === 'pending') ? value : null;
    }, 'The independently installed Agent persists the original student Wait.', 60000);
    if (mode === 'tool') {
      const pending = await api(`executions/${activity.activityId}/agent-pending`);
      assert.ok(pending.some(item => item.association.commandId === before.tools[0].commandId),
        'The real execution owner must have accepted the original command before backup: ' + JSON.stringify({ outcome: before.tools[0].outcome, reason: before.tools[0].result?.reason }));
    }
    const key = randomBytes(32); await source.setCredential('independent-backup', key.toString('base64'));
    const backup = await source.recovery.backup({ directory: join(directory, 'backups'), recoveryKeyRef: 'independent-backup', leaveClosed: true });
    const targetPort = await freePort();
    restored = await restoreProductRecovery({ root: targetRoot, resources: f.resources, backupDirectory: join(directory, 'backups', backup.backupId), key,
      installation: { profile: 'agent', publicEndpoint, port: targetPort } });
    const owner = restored.owners.find(item => item.participant.descriptor.serviceId === agent.serviceId);
    const material = await owner.material({ backupId: backup.backupId, boundaryAt: backup.boundaryAt, signal: new AbortController().signal });
    assert.equal(material.evidence.tables.teaching_runs.count, 1); assert.equal(material.evidence.pending.studentQuestions, mode === 'student' ? 1 : 0);
    for (const entry of restored.owners) await entry.close?.(); restored = undefined;
    const isolated = await target.start(); assert.equal(isolated.state, 'maintenance'); assert.equal(f.payloads.length, 2);
    await target.recovery.takeover({ sourceRoot, receivers: [{ id: `${data.environmentId}/${data.serviceId}`, root: f.root }] });
    backend = targetPort;
    const freshInbound = await target.authorize({ sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
      sourceInstallationId: schoolEnvironment.installationId, capabilities: ['teaching.agent'] }, agent.serviceId);
    const reconnected = { ...schoolConnection, credentialRef: 'recovery-independent-agent-restored' };
    await f.runtime.reconnect(reconnected, freshInbound.token);
    await f.runtime.reconnect(reconnected, freshInbound.token);
    const freshDependency = await f.runtime.authorize({ sourceEnvironmentId: agent.environmentId, sourceServiceId: agent.serviceId,
      sourceInstallationId: isolated.environment.installationId, capabilities: ['teaching.dependencies'] }, data.serviceId);
    await target.connect(dependency, freshDependency.token);
    const after = await api(base + '/conversation');
    const rotatedGrant = await f.runtime.authorize({ sourceEnvironmentId: agent.environmentId, sourceServiceId: agent.serviceId,
      sourceInstallationId: isolated.environment.installationId, capabilities: ['teaching.dependencies'] }, data.serviceId);
    await target.reconnect({ ...dependency, credentialRef: 'recovery-dependencies-rotated' }, rotatedGrant.token);
    await target.recovery.takeover({ sourceRoot, receivers: [{ id: `${data.environmentId}/${data.serviceId}`, root: f.root }] });
    assert.deepEqual((await api(base + '/conversation')).questions, after.questions);
    assert.deepEqual(after.questions, before.questions); assert.equal(after.runs[0].runId, first.runId);
    if (mode === 'student') {
      const question = after.questions[0];
      if (process.env.XUNJIE_RECOVERY_CHROME === '1') {
        const { chromium, expect } = await import('@playwright/test');
        browser = await chromium.launch({ channel: 'chrome', headless: false });
        page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(f.endpoint + '/?activity=' + activity.activityId);
        await page.getByRole('button', { name: '打开对话', exact: true }).click();
        const card = page.getByRole('group', { name: 'Agent 的提问', exact: true });
        await expect(card).toContainText('原服务保存的预测是什么？');
        await card.getByLabel('你的回应', { exact: true }).fill('这是对原服务中同一问题的明确回应。');
        await card.getByRole('button', { name: '提交回应', exact: true }).click();
      } else await api(`${base}/questions/${question.questionId}/responses`, { requestId: randomUUID(), questionVersion: question.version,
        waitVersion: question.waitVersion, answer: { kind: 'text', text: '这是对原服务中同一问题的明确回应。' } });
    } else {
      const commandId = before.tools[0].commandId, executionBase = `executions/${activity.activityId}`, browserId = randomUUID();
      assert.equal(after.tools[0].commandId, commandId); assert.deepEqual(after.waits.map(wait => [wait.waitId, wait.deadline]), before.waits.map(wait => [wait.waitId, wait.deadline]));
      const claimed = await api(`${executionBase}/agent/${commandId}/claim`, { browserId });
      const action = claimed.action;
      await api(`${executionBase}/agent/${commandId}/accept`, { browserId, acceptance: {
        receipt: { requestId: commandId, receiver: action.receiver, state: 'accepted', inputDigest: createHash('sha256').update(JSON.stringify(executionActionSchema.parse(action))).digest('hex'),
          receiptId: 'independent:' + commandId, detail: '' }, execution: { executionRef: randomUUID(), acceptedSeq: 1 } } });
      const { computed, resultInput } = await runPublishedAggregation(action, manifest); assert.equal(computed.result.value, 83.33333333333333);
      const result = await api(`${executionBase}/${commandId}/result`, resultInput);
      await api(`${executionBase}/${commandId}/report`, { ...result, state: 'succeeded', confirmedSeq: 3 });
    }
    const final = await until(async () => { const value = await api(base + '/conversation'); return value.runs[0]?.state === 'completed' ? value : null;
    }, 'The new installation resumes only the original Run.', 60000);
    assert.equal(final.runs[0].runId, first.runId); assert.equal(f.payloads.length, 3);
    const dormantAfter = await f.api(`agent/${dormant.activityId}/conversation`);
    assert.deepEqual(dormantAfter.questions, dormantBefore.questions); assert.equal(dormantAfter.runs[0].state, 'waiting');
    assert.deepEqual(final.runs[0].usage, { state: 'final', inputTokens: 40, outputTokens: 20, totalTokens: 60 });
    await assert.rejects(source.start(), error => error.code === 'source-retired');
    if (page) {
      const evidence = resolve(process.env.XUNJIE_RECOVERY_EVIDENCE_DIR ?? '.verification/wp07-204/chrome-independent');
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, 'active-' + process.platform + '.png'), fullPage: true });
      await writeFile(join(evidence, 'report.json'), JSON.stringify({ source: 'independent-agent-same-host-stable-endpoint', platform: process.platform,
        chromeVersion: browser.version(), originalRunId: first.runId, finalRunId: final.runs[0].runId,
        modelCalls: f.payloads.length, repeatedTakeoverAfterReconnection: true, credentialRotationInSameProcess: true,
        dormantReceiverQuestionRetained: true, sourceRetired: true, cleanup: 'pending' }, null, 2));
    }
  } catch (error) { failure = error; throw error; }
  finally {
    await browser?.close();
    for (const owner of restored?.owners ?? []) await owner.close?.();
    const errors = [];
    for (const [runtime, root] of [[target, targetRoot], [source, sourceRoot]]) if (await access(join(root, 'installation.json')).then(() => true, () => false)) {
      try { await runtime.stop(); } catch (error) { errors.push(error); }
    }
    try { await f.close(); } catch (error) { errors.push(error); }
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xj-independent-recovery-')) throw new Error('Unexpected cleanup target');
    if (!errors.length) {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      if (page) {
        const reportFile = join(resolve(process.env.XUNJIE_RECOVERY_EVIDENCE_DIR ?? '.verification/wp07-204/chrome-independent'), 'report.json');
        if (await access(reportFile).then(() => true, () => false)) {
          const report = JSON.parse(await readFile(reportFile, 'utf8'));
          await writeFile(reportFile, JSON.stringify({ ...report, cleanup: 'completed' }, null, 2));
        }
      }
    }
    else if (!failure) throw new AggregateError(errors, 'Independent recovery cleanup failed');
  }
});
