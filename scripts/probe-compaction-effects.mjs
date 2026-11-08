#!/usr/bin/env node
import { probeEvidenceFile, writeEvidence, captureEvidence, hasProbeEvidence } from './lib/probe-evidence.mjs';
// #220: real Chat -> Responses, production HTTP owners/RunDriver and headed Chrome Worker.
// Only browser result delivery is interrupted. No receipt, result, summary or model answer is fabricated.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { chromium, expect } from '@playwright/test';
import { fixture, until } from '../apps/server/tests/support/teaching-input-control.mjs';
import { acquireNativeDesktop } from './lib/native-desktop-lock.mjs';

const { values } = parseArgs({ options: {
  'output': { type: 'string' }, 'evidence-dir': { type: 'string' },  run: { type: 'boolean', default: false }, session: { type: 'string' },
  out: { type: 'string' },
  'credentials-file': { type: 'string', default: join(homedir(), '.config/magpie/providers.json') },
  'provider-address': { type: 'string' } } });
const prefix = probeEvidenceFile(values.out, 'wp08-220-live-effects');
if (values['provider-address']) assert.ok(net.isIP(values['provider-address']));
const report = { issue: 220, startedAt: new Date().toISOString(), status: 'planned', phase: 'plan',
  route: 'real deepseek-flash Chat -> Responses, plain mode, TLS verified',
  execution: 'real headed Chrome table Worker/WASM; delayed result delivery, not long-running computation',
  credentialBoundary: 'real provider key exists only in relay memory; production holder stores a synthetic loopback key',
  limits: { chatRequests: 6, responsesRequests: 2, maxOutputTokens: 2048, providerTimeoutMs: 120000, retries: 0 },
  steps: [], requests: [], workerEvents: [], assertions: {}, cleanup: [] };
const secrets = [];
const redact = value => {
  let text = JSON.stringify(value, null, 2);
  for (const secret of secrets) if (secret) text = text.split(secret).join('<REDACTED>');
  return text + '\n';
};
async function save() { await mkdir(dirname(prefix), { recursive: true }); await writeEvidence(prefix + '-report.json', redact(report)); }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
async function step(name, action) {
  report.phase = name; const item = { name, startedAt: new Date().toISOString(), passed: false }; report.steps.push(item);
  await save(); console.log('START ' + name);
  await action(); item.passed = true; item.elapsedMs = Date.now() - Date.parse(item.startedAt); await save(); console.log('PASS ' + name);
}
if (!values.run) {
  report.plan = ['Acquire macOS desktop lock; provision isolated native PG runtime/course via public fixture.',
    'Let real Chat call course_operation; real Chrome broker accepts and Worker computes; block only result delivery.',
    'Adopt a long fixed work in a real discussion step, then explicitly steer once more to trigger real summary/continuation.',
    'Explicitly switch to real Responses, release browser delivery and consume the original Wait once.',
    'Match public snapshots to observed TLS relay payload digests and retain credential-free evidence.'];
  await save(); console.log(JSON.stringify(report));
} else {
  assert.equal(process.platform, 'darwin', 'This harness requires the authorized macOS desktop.');
  assert.ok(values.session, '--session is required to acquire the shared desktop lock.');
  let releaseDesktop, relay, f, browser, context, page, activity, session, commandId, originalRunId;
  let holdResults = true, closing = false;
  let monitor, monitorBusy = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => originalFetch(input, { ...init,
    signal: AbortSignal.any([AbortSignal.timeout(30000), ...(init.signal ? [init.signal] : [])]) });
  const payloads = [], blockedDeliveries = [];
  const workers = [];
  let api;
  try {
    releaseDesktop = await acquireNativeDesktop('macos', values.session, 'WP08 #220 real compaction accepted table effect Chat -> Responses');
    const privateDocument = JSON.parse((await readFile(resolve(values['credentials-file']), 'utf8')).replace(/^\uFEFF/, ''));
    const provider = privateDocument.providers?.find(item => /deepseek/i.test(item.preset ?? item.name ?? '') && item.key);
    assert.ok(provider?.key, 'Authorized DeepSeek provider is required.'); secrets.push(provider.key);
    relay = createServer(async (request, response) => {
      try {
        const path = request.url, protocol = path === '/v1/chat/completions' ? 'chat' : path === '/v1/responses' ? 'responses' : null;
        const limit = protocol === 'chat' ? report.limits.chatRequests : report.limits.responsesRequests;
        if (closing || request.method !== 'POST' || !protocol || report.requests.filter(item => item.protocol === protocol).length >= limit) {
          response.writeHead(429); response.end(); return;
        }
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; assert.ok(size <= 4_000_000); chunks.push(chunk); }
        const body = Buffer.concat(chunks), payload = JSON.parse(body);
        const item = { protocol, path, phase: report.phase, payloadSha256: digest(payload), status: null, tlsVerified: false,
          startedAt: new Date().toISOString() };
        report.requests.push(item); payloads.push(payload); await save();
        console.log('PROVIDER ' + protocol + ' request ' + report.requests.length);
        // Replace the holder's synthetic loopback credential only in memory at the real TLS hop.
        const remote = https.request({ hostname: 'api.deepseek.com', servername: 'api.deepseek.com', path, method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + provider.key, 'content-length': body.length },
          timeout: report.limits.providerTimeoutMs,
          ...(values['provider-address'] ? { lookup: (_host, _options, callback) => callback(null,
            [{ address: values['provider-address'], family: net.isIP(values['provider-address']) }]) } : {}) }, result => {
          item.status = result.statusCode; item.tlsVerified = result.socket.authorized === true;
          response.writeHead(result.statusCode, { 'content-type': result.headers['content-type'] ?? 'text/event-stream' });
          result.pipe(response); result.on('end', () => { item.elapsedMs = Date.now() - Date.parse(item.startedAt); });
        });
        remote.on('timeout', () => remote.destroy(new Error('provider-timeout')));
        remote.on('error', error => { item.errorCode = ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(error.code)
          ? error.code : 'provider-connection'; if (!response.headersSent) response.writeHead(502); response.end(); });
        response.on('close', () => { if (!response.writableEnded) remote.destroy(); }); remote.end(body);
      } catch { if (!response.headersSent) response.writeHead(502); response.end(); }
    });
    await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
    report.status = 'running';
    await step('production-course-and-Chrome', async () => {
      f = await fixture();
      session = await f.browserCourse({ withSession: true }); activity = session.activity;
      secrets.push(session.login.password, session.headers.cookie);
      api = async (route, body) => {
        const operation = { route, method: body === undefined ? 'GET' : 'POST', startedAt: new Date().toISOString() };
        report.activeHttp = operation;
        try { return await f.api(route, body, session.headers); }
        finally { if (report.activeHttp === operation) report.activeHttp = null; }
      };
      monitor = setInterval(async () => {
        if (monitorBusy || !originalRunId || closing) return;
        monitorBusy = true;
        try {
          const [value, log] = await Promise.all([api(`agent/${activity.activityId}/conversation`), api(`agent/${activity.activityId}/events`)]);
          report.owner = { at: new Date().toISOString(),
            runs: value.runs.map(run => ({ runId: run.runId, state: run.state, reason: run.reason, attemptId: run.attemptId, usage: run.usage })),
            inputs: value.inputs.map(input => ({ inputId: input.inputId, state: input.state, adoptedRunId: input.adoptedRunId })),
            tools: value.tools.map(tool => ({ commandId: tool.commandId, name: tool.name, state: tool.state, outcome: tool.outcome })),
            waits: value.waits.map(wait => ({ waitId: wait.waitId, commandId: wait.commandId, state: wait.state })),
            lastAssistant: value.messages.filter(message => message.role === 'assistant').at(-1)?.text.slice(0, 600),
            recentEvents: log.slice(-12).map(event => ({ seq: event.seq, kind: event.kind, runId: event.body.runId,
              stepId: event.body.stepId, attemptId: event.body.attemptId, reason: event.body.reason })) };
          await save(); console.log('OWNER ' + JSON.stringify(report.owner.runs.map(run => ({ state: run.state, reason: run.reason }))) + ' requests=' + report.requests.length);
        } catch (error) { report.ownerReadFailure = String(error.code ?? error.name ?? 'unavailable'); await save(); }
        finally { monitorBusy = false; }
      }, 5000);
      browser = await chromium.launch({ channel: 'chrome', headless: false });
      report.browserVersion = browser.version();
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const login = await context.request.post(f.endpoint + '/api/learning/login', { data: session.login });
      assert.equal(login.status(), 200);
      // Real browser requests are dropped only at result delivery; acceptance is never intercepted or manufactured.
      await context.route('**/api/learning/executions/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const terminalReport = path.endsWith('/report') && ['succeeded', 'failed', 'cancelled'].includes(request.postDataJSON()?.state);
        if (holdResults && request.method() === 'POST' && (path.endsWith('/result') || terminalReport)) {
          const bodySha256 = createHash('sha256').update(request.postData() ?? '').digest('hex');
          const prior = blockedDeliveries.find(item => item.path === path && item.bodySha256 === bodySha256);
          if (prior) prior.attempts++;
          else blockedDeliveries.push({ path, bodySha256, attempts: 1 });
          await route.abort('connectionfailed');
        } else await route.continue();
      });
      page = await context.newPage(); page.setDefaultTimeout(90000);
      page.on('worker', worker => { workers.push(worker.url()); report.workerEvents.push({ at: new Date().toISOString(), url: worker.url() }); });
      await page.goto(f.endpoint + '/?space=school&activity=' + activity.activityId);
      await expect(page.locator('#activity-title')).toBeVisible();
      await page.getByRole('tab', { name: activity.course.components.find(item => item.key === 'table').configuration.title, exact: true }).click();
      const table = page.frameLocator('.component-view iframe');
      await table.getByLabel('得分 第1行', { exact: true }).fill('89');
      await table.getByLabel('得分 第1行', { exact: true }).fill('88');
      await until(async () => {
        const workspace = await api('workspaces/' + activity.activityId);
        const work = workspace.files.find(file => file.name === 'components/table.json');
        return work && JSON.parse(work.value).content.table.rows[0][2] === '88' ? work : null;
      }, 'Formal UI persists the actual component state.', 60000);
      report.activityId = activity.activityId;
    });
    async function select(protocol) {
      const connectionId = randomUUID(), grantId = randomUUID();
      await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
        name: '#220 live accepted effect ' + protocol, protocol, baseUrl: `http://127.0.0.1:${relay.address().port}/v1`,
        path: protocol === 'responses' ? '/responses' : '/chat/completions', modelId: 'deepseek-flash', dialect: 'deepseek',
        parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: report.limits.maxOutputTokens,
        credential: { action: 'replace', value: 'synthetic-live-effects-relay' } });
      await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
      const selected = await api('models/selection');
      return api('models/selection', { requestId: randomUUID(), expectedVersion: selected.version,
        source: { kind: 'personal', connectionId, grantId } });
    }
    async function send(question, works, mode) {
      const accepted = await f.send(activity, question, mode ? { version: 1, mode,
        basis: { source: 'explicit', preferenceVersion: 0 } } : undefined, works, session.headers);
      return accepted;
    }
    const conversation = () => api(`agent/${activity.activityId}/conversation`);
    const events = () => api(`agent/${activity.activityId}/events`);
    const history = () => api(`executions/${activity.activityId}/history`);
    let originalWait, originalAcceptance, originalExecutionRef, componentWork, compactedSnapshot, adoption, switchReceipt;
    await step('real-Chat-accepted-Worker-and-held-result', async () => {
      await select('chat-completions');
      componentWork = (await api('workspaces/' + activity.activityId)).files.find(file => file.name === 'components/table.json');
      assert.ok(componentWork);
      const original = await send('请实际且只调用一次 course_operation：componentKey="table"，operationId="aggregate"，parameters={"groupColumn":"小组","valueColumn":"得分","aggregate":"mean"}。依据固定表格按小组计算平均值。接受回执后保留原操作等待，不要换身份重跑，不调用其他工具。', [componentWork]);
      originalRunId = original.runId; report.runId = originalRunId;
      const pending = await until(async () => {
        const value = await conversation(), run = value.runs.find(item => item.runId === originalRunId);
        assert.ok(!['failed', 'paused', 'stopped', 'completed'].includes(run?.state), 'Real Chat did not leave the required course operation pending: ' + run?.state + ':' + run?.reason);
        return value.tools.some(tool => tool.name === 'course_operation' && tool.outcome === 'accepted') && value.waits.some(wait => wait.state === 'pending') ? value : null;
      }, 'Real Chat must call the production course tool.', 180000);
      commandId = pending.tools.find(tool => tool.name === 'course_operation').commandId;
      originalWait = pending.waits.find(wait => wait.commandId === commandId);
      const accepted = await until(async () => (await history()).entries.find(entry => entry.action.requestId === commandId),
        'The real browser archives its own acceptance.', 90000);
      originalAcceptance = accepted.acceptance; originalExecutionRef = accepted.query.executionRef;
      assert.equal(originalAcceptance.receipt.state, 'accepted');
      assert.equal(originalAcceptance.receipt.receiptId, 'browser:' + commandId);
      await until(() => blockedDeliveries.some(item => item.path.endsWith('/' + commandId + '/result')),
        'Chrome actually computes and attempts to deliver its original artifact.', 90000);
      assert.ok(workers.length > 0, 'Formal Chrome must launch a real Worker.');
      report.commandId = commandId; report.waitId = originalWait.waitId; report.executionRef = originalExecutionRef;
      report.assertions.realBrowserAcceptance = true; report.assertions.actualWorkerWithHeldResult = true;
      await captureEvidence(page, { path: prefix + '-accepted.png', fullPage: true });
    });
    await step('real-long-history-summary-and-continuation', async () => {
      const note = { objectId: randomUUID(), contentId: randomUUID(), name: 'measurement-notes.txt', kind: 'text', encoding: 'utf8',
        mediaType: 'text/plain', value: '原表格计算的数值尚待原操作返回，不能声称已完成。\n'
          + 'Historical measurement notes: observation recorded; aggregate result still unconfirmed.\n'.repeat(850) };
      console.log('SEND steering with fixed long work');
      const steering = await send('补充这份固定测量资料，先用一句话确认仍在等待原表格运算的原结果；不要调用任何工具、不要重新执行计算，重复记录只是历史数据。', [componentWork, note], 'steering');
      console.log('ACCEPTED steering ' + steering.inputId);
      assert.equal(steering.runId, originalRunId);
      await until(async () => {
        const value = await conversation(), log = await events(), run = value.runs.find(item => item.runId === originalRunId);
        assert.ok(!['paused', 'failed', 'stopped', 'completed'].includes(run?.state), 'Long-input discussion failed: ' + run?.state + ':' + run?.reason);
        return value.inputs.find(input => input.inputId === steering.inputId)?.state === 'adopted'
          && log.filter(event => event.kind === 'context-assembled').length >= 2 && run?.state === 'waiting';
      }, 'The actual long-input discussion must finish before requesting the next step.', 60000);
      const beforeCompaction = await events();
      assert.ok(beforeCompaction.some(event => event.kind === 'tools-paired'), 'The original native call/result pair is closed before compaction.');
      await send('继续同一已接受问题：根据完整历史简短说明当前仍在等待原计算结果。不要发起任何新操作；只能沿原 Command/Wait 核对。', [componentWork], 'steering');
      const compacted = await until(async () => {
        const value = await conversation(), log = await events(), run = value.runs.find(item => item.runId === originalRunId);
        assert.ok(!['paused', 'failed', 'stopped', 'completed'].includes(run?.state), 'Original Run cannot finish before delivery: ' + run?.state + ':' + run?.reason);
        adoption = log.find(event => event.kind === 'context-compacted');
        return adoption && run?.state === 'waiting' ? { value, log } : null;
      }, 'A real summary is generated/adopted and the real continuation returns to the same pending Wait.', 90000);
      assert.equal(compacted.log.filter(event => event.kind === 'context-compacted').length, 1);
      assert.ok(adoption.body.source.retained.some(item => item.kind === 'effect' && item.content.commandId === commandId));
      assert.ok(adoption.body.source.retained.some(item => item.kind === 'wait' && item.content.wait_id === originalWait.waitId));
      const wait = compacted.value.waits.find(item => item.waitId === originalWait.waitId);
      assert.equal(wait.state, 'pending'); assert.equal(wait.deadline, originalWait.deadline);
      const latest = compacted.log.filter(event => event.kind === 'context-assembled').at(-1);
      compactedSnapshot = await api(`agent/${activity.activityId}/snapshots/${latest.body.snapshotId}`);
      const payload = JSON.stringify(compactedSnapshot.payload);
      for (const id of [commandId, originalWait.waitId, originalWait.deadline, adoption.body.compactionId]) assert.ok(payload.includes(id));
      assert.equal(compacted.log.filter(event => event.kind.startsWith('model-switch-')).length, 0);
      report.compaction = { compactionId: adoption.body.compactionId, sourceDigest: adoption.body.source.sourceDigest,
        resultRef: adoption.body.resultRef, transitionId: adoption.body.transitionId };
      report.assertions.realSummaryAndContinuationWithPendingWait = true;
      await captureEvidence(page, { path: prefix + '-compacted.png', fullPage: true });
    });
    await step('explicit-real-Responses-route-with-original-pending-Wait', async () => {
      const selected = await select('responses'), before = report.requests.length;
      switchReceipt = await api(`agent/${activity.activityId}/model-switches`, { requestId: randomUUID(), selectionVersion: selected.version });
      assert.equal(switchReceipt.state, 'completed'); assert.notEqual(switchReceipt.toSegmentId, compactedSnapshot.segmentId);
      assert.equal(report.requests.length, before, 'A switch cannot regenerate an answer.');
      const value = await conversation(), wait = value.waits.find(item => item.waitId === originalWait.waitId);
      assert.equal(wait.state, 'pending'); assert.equal(wait.deadline, originalWait.deadline);
      assert.equal((await history()).entries.find(item => item.action.requestId === commandId).query.executionRef, originalExecutionRef);
      report.switch = { fromSegmentId: switchReceipt.fromSegmentId, toSegmentId: switchReceipt.toSegmentId, protocol: 'responses' };
      report.assertions.pendingEffectSurvivesExplicitCrossRoute = true;
    });
    await step('original-browser-late-result-and-real-Responses-continuation', async () => {
      holdResults = false;
      const final = await until(async () => {
        const value = await conversation(), run = value.runs.find(item => item.runId === originalRunId);
        assert.ok(!['paused', 'failed', 'stopped'].includes(run?.state), 'Real Responses continuation failed: ' + run?.reason);
        return run?.state === 'completed' ? value : null;
      }, 'The original browser result resumes the original Run on Responses.', 180000);
      const courseTools = final.tools.filter(tool => tool.name === 'course_operation');
      assert.equal(courseTools.length, 1); assert.equal(courseTools[0].commandId, commandId); assert.equal(courseTools[0].outcome, 'completed');
      assert.equal(final.tools.length, 1, 'Discussion, compaction and switching cannot recreate an operation.');
      const wait = final.waits.find(item => item.waitId === originalWait.waitId);
      assert.equal(wait.state, 'consumed'); assert.equal(wait.deadline, originalWait.deadline);
      const entries = (await history()).entries; assert.equal(entries.length, 1);
      assert.deepEqual(entries[0].acceptance, originalAcceptance); assert.equal(entries[0].query.executionRef, originalExecutionRef);
      assert.equal(entries[0].query.state, 'succeeded'); assert.equal(entries[0].query.output.output.value, 83.33333333333333);
      const artifact = await api(`executions/${activity.activityId}/${commandId}/artifact`);
      assert.equal(artifact.executionRef, originalExecutionRef);
      assert.equal(createHash('sha256').update(artifact.text).digest('hex'), artifact.sha256);
      const log = await events();
      assert.equal(log.filter(event => event.kind === 'wait-consumed' && event.body.waitId === originalWait.waitId).length, 1);
      assert.equal(log.filter(event => event.kind === 'model-switch-completed').length, 1);
      assert.equal(log.filter(event => event.kind === 'context-compacted').length, 1);
      const snapshots = await Promise.all(log.filter(event => event.kind === 'context-assembled')
        .map(event => api(`agent/${activity.activityId}/snapshots/${event.body.snapshotId}`)));
      for (const snapshot of snapshots) {
        assert.equal(digest(snapshot.payload), snapshot.payloadSha256);
        assert.ok(report.requests.some(request => request.payloadSha256 === snapshot.payloadSha256));
      }
      const last = snapshots.at(-1);
      assert.equal(last.segmentId, switchReceipt.toSegmentId); assert.equal(last.model.protocol, 'responses');
      const actual = payloads.find(payload => digest(payload) === last.payloadSha256);
      assert.ok(actual); const sent = JSON.stringify(actual);
      for (const text of [commandId, originalWait.waitId, '83.33333333333333']) assert.ok(sent.includes(text));
      assert.ok(report.requests.every(request => request.status === 200 && request.tlsVerified));
      const calls = report.requests.length; await conversation(); await events(); await api(`agent/${activity.activityId}/snapshots/${last.snapshotId}`);
      assert.equal(report.requests.length, calls);
      report.snapshots = snapshots.map(snapshot => ({ snapshotId: snapshot.snapshotId, segmentId: snapshot.segmentId,
        protocol: snapshot.model.protocol, definitionId: snapshot.resolvedAgent.definition.definitionId, payloadSha256: snapshot.payloadSha256 }));
      report.result = { value: artifact.output.value, sha256: artifact.sha256, contentId: entries[0].query.output.contentId,
        usage: final.runs.find(run => run.runId === originalRunId).usage };
      report.assertions.originalIdentityAndArtifactPreserved = true; report.assertions.realCrossRoutePayloadMatched = true;
      report.assertions.onlyOneWaitConsumption = true; report.assertions.pureReadDoesNotGenerate = true;
      await captureEvidence(page, { path: prefix + '-completed.png', fullPage: true });
    });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = String(error.message ?? error).slice(0, 1600);
    report.failureLocation = String(error.stack ?? '').split('\n').slice(1, 5).join('\n'); process.exitCode = 1;
    await captureEvidence(page, { path: prefix + '-failure.png', fullPage: true }).catch(() => {});
  } finally {
    // Let only the real browser finish its already computed result; never synthesize cleanup evidence.
    holdResults = false;
    if (monitor) clearInterval(monitor);
    if (api && commandId) {
      try {
        await until(async () => (await api(`executions/${activity.activityId}/${commandId}`))?.state === 'succeeded',
          'Release original browser delivery before cleanup.', 15000);
      } catch { report.cleanup.push('original browser delivery did not confirm during bounded cleanup'); }
    }
    if (api && originalRunId) await api(`agent/${activity.activityId}/runs/${originalRunId}/stop`, { requestId: randomUUID() }).catch(() => {});
    await browser?.close().catch(() => { report.cleanup.push('Chrome close failed'); });
    closing = true;
    if (relay) { relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)); }
    try { await f?.close(); report.cleanup.push('isolated product and owned Chrome closed'); }
    catch (error) { report.cleanup.push('isolated product cleanup failed: ' + String(error.code ?? 'unavailable')); report.status = 'failed'; process.exitCode = 1; }
    if (releaseDesktop) await releaseDesktop();
    globalThis.fetch = originalFetch;
    report.blockedResultDeliveries = blockedDeliveries; report.completedAt = new Date().toISOString(); await save();
  }
  console.log(JSON.stringify({ status: report.status, phase: report.phase, report: hasProbeEvidence(prefix) ? prefix + '-report.json' : null, requests: report.requests.length }));
}
