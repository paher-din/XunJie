import { probeEvidenceDirectory, writeEvidence, captureEvidence, mkdtemp } from './lib/probe-evidence.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { aggregationPackage } from '../components/table-aggregation/package.mjs';

/**
 * Real offline/online acceptance for #170: a run that finishes while the execution owner is
 * unreachable keeps its local truth, and the same facts are delivered exactly once when the
 * service is reachable again. Nothing in the application is stubbed: Chromium drops the writes
 * at the network layer, the algorithm really computes in its worker, and the durable queue is
 * read back from the page's own IndexedDB before and after the reconnect.
 */
const output = probeEvidenceDirectory(process.env.XUNJIE_EXECUTION_OUTPUT);
const webRoot = resolve(process.env.XUNJIE_PRODUCT_WEB_ROOT ?? 'apps/web/dist-runtime');
await mkdir(output, { recursive: true });
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Native PostgreSQL required');
const root = await mkdtemp(join(tmpdir(), 'xj-execution-sync-'));
const report = { platform: process.platform, arch: process.arch, os: release(), node: process.version,
  root, browser: 'Google Chrome', cases: [], traffic: [], status: 'running', headless: false };
const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
  postgresVersion: '18.6', webRoot, windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') } });
let browser;
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };
try {
  await runtime.install({ profile: 'local' });
  const { endpoint } = await runtime.start();
  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const api = async (route, body, headers = {}) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, `API ${route} ${response.status}`); return response.json();
  };
  const published = await aggregationPackage();
  const definition = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
  await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '断连续传验收' }, task: { taskId, title: '离线计算与同步续传', summary: '执行服务不可达期间照常计算' },
    release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['断网-重连下恰好一次投递'], requirements: '执行服务不可达期间完成计算，恢复后续传。',
      starterWorks: [], capabilities: [],
      components: [{ key: 'table', definition, configuration: { title: '表格聚合' }, materialIds: [] }], materials: [] },
    resources: [] }, admin);
  const password = randomUUID(), loginName = 'execution-sync';
  const member = await api('manage/members', { requestId: randomUUID(), loginName, password }, admin);
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const login = await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  assert.equal(login.status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  assert.equal(created.status(), 200);
  const activity = await created.json();

  // Every write to the execution owner is classified and tagged with the phase it happened in.
  const traffic = report.traffic;
  let phase = 'setup';
  const classify = request => {
    const url = request.url();
    if (!url.includes('/api/learning/executions/') || request.method() !== 'POST') return null;
    const path = new URL(url).pathname.split('/api/learning/executions/')[1].split('/');
    const kind = path[2] === 'report' ? 'report' : path[2] === 'result' ? 'result' : 'accept';
    const body = request.postDataJSON?.() ?? {};
    return { kind, requestId: body.action?.requestId ?? body.requestId ?? path[1] ?? null };
  };
  const page = await context.newPage();
  page.on('pageerror', error => console.log('BROWSER ERROR ' + error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE ' + message.text().slice(0, 300)); });
  page.on('request', request => { const kind = classify(request); if (kind) traffic.push({ phase, ...kind, event: 'attempt' }); });
  page.on('requestfailed', request => { const kind = classify(request); if (kind) traffic.push({ phase, ...kind, event: 'failed' }); });
  page.on('response', response => {
    const kind = classify(response.request());
    if (kind) traffic.push({ phase, ...kind, event: response.ok() ? 'ok' : 'error' });
  });
  const count = (event, kind, inPhase) => traffic.filter(item => item.event === event
    && (!kind || item.kind === kind) && (!inPhase || item.phase === inPhase)).length;
  const localLedger = () => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('xunjie-reliable-works-v1');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const readAll = name => new Promise((resolve, reject) => {
      const request = db.transaction(name, 'readonly').objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return { commands: await readAll('executionCommands'), sync: await readAll('executionSync'),
      results: await readAll('executionResults') };
  });
  const remoteRead = async requestId => {
    const response = await context.request.get(endpoint + '/api/learning/executions/' + activity.activityId + '/' + requestId);
    return response.ok() ? response.json() : null;
  };

  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await expect(page.locator('#activity-title')).toHaveText('离线计算与同步续传');
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  const frame = page.frameLocator('iframe[title="表格聚合"]');
  await expect(frame.getByRole('heading', { name: '表格聚合', exact: true })).toBeVisible();
  const panel = page.getByRole('region', { name: '计算记录' });

  // Case A: the execution owner is unreachable at the network layer while a real run computes.
  phase = 'offline-run';
  await context.route('**/api/learning/executions/**', route => route.abort('connectionfailed'));
  await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  await expect(frame.locator('#summary')).toContainText('共 12 行、3 组', { timeout: 30000 });
  await expect(panel).toContainText('已完成', { timeout: 20000 });
  passed('the restricted algorithm computes to a real result while the execution owner is unreachable');
  // The delivery was attempted and dropped by the network, not skipped by the application.
  await expect.poll(() => count('attempt', 'accept', 'offline-run'), { timeout: 15000 }).toBeGreaterThan(0);
  assert.equal(count('ok', undefined, 'offline-run'), 0, 'no write may reach the unreachable owner');
  assert.ok(count('failed', undefined, 'offline-run') > 0, 'the delivery attempts must really fail');
  const offlineLedger = await localLedger();
  const runA = offlineLedger.commands.find(record => record.query.state === 'succeeded');
  assert.ok(runA, 'the finished run is readable from the local ledger');
  const requestIdA = runA.requestId;
  assert.equal(offlineLedger.sync.find(record => record.requestId === requestIdA), undefined,
    'a failed delivery records nothing in the sync ledger');
  const artifactA = offlineLedger.results.find(record => record.requestId === requestIdA);
  assert.ok(artifactA && artifactA.text.startsWith('小组,计数'), 'the result bytes stay readable locally');
  passed('the local ledger keeps the command, the terminal fact and the result bytes with no sync entry');
  await captureEvidence(page, { path: join(output, 'execution-sync-offline.png'), fullPage: true });

  // Connectivity returns; a reload is the page's own resume entry point.
  phase = 'resumed-1';
  await context.unroute('**/api/learning/executions/**');
  await page.reload();
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  await expect(page.getByRole('region', { name: '计算记录' })).toContainText('已完成', { timeout: 20000 });
  await expect.poll(async () => (await remoteRead(requestIdA))?.state, { timeout: 20000 }).toBe('succeeded');
  const remoteA = await remoteRead(requestIdA);
  assert.equal(remoteA.executionRef, runA.acceptance.execution.executionRef, 'the resumed delivery names the original acceptance');
  assert.equal(remoteA.output.contentId, runA.query.output.contentId, 'the service received the same result reference');
  assert.equal(remoteA.output.artifact.sha256, artifactA.sha256, 'the service received the same result bytes');
  assert.deepEqual([count('ok', 'accept', 'resumed-1'), count('ok', 'report', 'resumed-1'), count('ok', 'result', 'resumed-1')],
    [1, 1, 1], 'the resumed queue delivers each fact exactly once');
  const syncedA = (await localLedger()).sync.find(record => record.requestId === requestIdA);
  assert.deepEqual([syncedA.command, syncedA.result], [true, true]);
  passed('the interrupted queue resumes on the next open and delivers command, facts and result exactly once');

  phase = 'resumed-2';
  await page.reload();
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  await expect(page.getByRole('region', { name: '计算记录' })).toContainText('已完成', { timeout: 20000 });
  await page.waitForTimeout(1500);
  assert.equal(count('ok', undefined, 'resumed-2'), 0, 'a confirmed run is never written to the service twice');
  assert.equal((await remoteRead(requestIdA)).output.contentId, remoteA.output.contentId, 'the service keeps one result');
  passed('a second open consults the same sync ledger and writes nothing again');

  // Case B: a real full disconnect. The run cannot fetch its algorithm and records that fact locally.
  phase = 'offline-failed';
  await context.setOffline(true);
  await frame.getByRole('textbox', { name: '得分 第1行', exact: true }).fill('100');
  await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  await expect(panel.locator('li').first()).toContainText('未完成', { timeout: 30000 });
  const failedLedger = await localLedger();
  const runB = failedLedger.commands.find(record => record.query.state === 'failed');
  assert.ok(runB && runB.requestId !== requestIdA, 'the offline run is a new local record with its own failure fact');
  assert.equal(failedLedger.sync.find(record => record.requestId === runB.requestId), undefined);
  assert.equal(count('ok', undefined, 'offline-failed'), 0);
  passed('a fully disconnected run records its failure locally and syncs nothing');

  phase = 'failed-resumed-1';
  await context.setOffline(false);
  await page.reload();
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  await expect(page.getByRole('region', { name: '计算记录' })).toContainText('未完成', { timeout: 20000 });
  await expect.poll(async () => (await remoteRead(runB.requestId))?.state, { timeout: 20000 }).toBe('failed');
  assert.deepEqual([count('ok', 'accept', 'failed-resumed-1'), count('ok', 'report', 'failed-resumed-1'),
    count('ok', 'result', 'failed-resumed-1')], [1, 1, 0], 'the failure fact is delivered once, without inventing a result');
  phase = 'failed-resumed-2';
  await page.reload();
  await page.waitForTimeout(1500);
  assert.equal(count('ok', undefined, 'failed-resumed-2'), 0);
  passed('the reconnect delivers the failure fact once and then stays quiet');

  await captureEvidence(page, { path: join(output, 'execution-sync-resumed.png'), fullPage: true });
  report.status = 'passed';
  report.summary = { requestIdA, requestIdB: runB.requestId,
    deliveries: Object.fromEntries(['offline-run', 'resumed-1', 'resumed-2', 'offline-failed', 'failed-resumed-1', 'failed-resumed-2']
      .map(name => [name, { attempts: count('attempt', undefined, name), ok: count('ok', undefined, name),
        failed: count('failed', undefined, name) }])) };
} catch (error) {
  report.status = 'failed';
  report.error = error?.message ?? String(error);
  throw error;
} finally {
  await writeEvidence(join(output, 'execution-sync-report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  await browser?.close().catch(() => {});
  await runtime.stop().catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
