#!/usr/bin/env node
/**
 * #211 independent school HTTPS cross-machine client acceptance.
 *
 * A real desktop Chrome on THIS machine opens the independent school node over pinned strict
 * HTTPS. The school service and its PostgreSQL live on another machine; the client has no local
 * XunJie product and no local database. The #193 ALU board/check UI flow is exercised end to end
 * through the school login + context.request path, without importing the product runtime.
 *
 * Run with NODE_EXTRA_CA_CERTS pointing at the acceptance CA (Node-side API calls only).
 * Chrome certificate verification stays on: only the exact SPKI public key is pinned.
 *
 * usage: node scripts/probe-alu-211-school-client.mjs --state=FILE --output=DIR [--label=NAME]
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import tls from 'node:tls';
import { chromium, expect } from '@playwright/test';

const { values } = parseArgs({ options: {
  state: { type: 'string' }, output: { type: 'string' }, label: { type: 'string' },
} });
for (const name of ['state', 'output']) if (!values[name]) throw new Error('usage: --state=FILE --output=DIR [--label=NAME]');
const statePath = resolve(values.state);
const state = JSON.parse(await readFile(statePath, 'utf8'));
const endpoint = state.endpoint;
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const label = values.label ?? `${process.platform}-${process.arch}`;
const school = new URL(endpoint);
const schoolHost = school.hostname;
const schoolOrigin = school.origin;
const localAddresses = Object.values(networkInterfaces()).flat()
  .filter(item => item && item.address).map(item => item.address);

// Timeouts: the school entry is genuinely remote. Monaco + app chunks + a 6.3 MB component
// preparation can be slow on a cold browser cache; the product work itself must stay generous.
const T = { ui: 90_000, prep: 300_000, run: 240_000, check: 300_000, sync: 180_000 };

const CASE_DEFS = [
  { id: 'env-placement', name: '学校服务与 PostgreSQL 位于客户端之外的真实机器' },
  { id: 'tls-pin', name: '严格 TLS + SPKI 公钥固定生效，entry 为 school profile' },
  { id: 'login-activity', name: '学校成员登录并创建固定 ALU 课程活动' },
  { id: 'preparation', name: '正常组件/课程/准备/自检（真实网络资源与浏览器 Worker）' },
  { id: 'starter-observation', name: '起始作品运行得到真实 X 观察（不是假零）' },
  { id: 'correct-observation', name: 'Monaco 输入正确 ALU 源码后运行，A=15/B=0/M=1/S=00/Cin=1 得到 F=0000/Cout=1' },
  { id: 'offline-sync', name: '应用 API 阻断时本地自由观察仍可用，恢复后同步到学校 owner 且不重复执行' },
  { id: 'check-pass', name: '完整检查通过：4096 组 / 16384 行 / 1536 保留输入，报告资源从学校 owner 可取' },
  { id: 'check-fail', name: '固定丢进位实现检查失败：256 个唯一反例 / 1024 错误行' },
  { id: 'refresh', name: '刷新后恢复已启用输入、观察与检查报告，不重算' },
  { id: 'worker-stop', name: '真实零时间 Worker 停止；停止后正常实验与检查可继续' },
  { id: 'second-activity', name: '同一身份第二活动不再 409 identity-conflict，且可正常准备/运行' },
  { id: 'network-origin', name: '页面仅访问学校 origin，无 loopback/localhost/SSH 隧道，refused 已记录' },
];

const report = {
  kind: 'alu-school-211-cross-machine-client',
  ticket: '#211',
  label,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  endpoint,
  schoolHost,
  schoolNodePlatform: state.nodePlatform,
  schoolNodeArch: state.nodeArch,
  schoolNodeVersion: state.nodeVersion,
  schoolDistributionSha256: state.distributionSha256,
  spki: state.spki,
  clientAddresses: localAddresses,
  clientLocalProduct: false,
  studentTrafficUsesSsh: false,
  startedAt: new Date().toISOString(),
  cases: [],
  caseSummary: { pass: 0, fail: 0, skip: 0 },
  timings: {},
  timestamps: {},
  traffic: [],
  apiPosts: [],
  refused: [],
  status: 'running',
};

let browser, context, page, secondPage;
let currentStep = 'setup';
let apiBlocked = false;
const caseResults = new Map();
const allRequestUrls = [];
const requestFailures = [];
const refused = [];

const sleep = ms => new Promise(done => setTimeout(done, ms));
const mark = (id, status, extra = {}) => caseResults.set(id, { status, ...extra });
const caseDetail = id => caseResults.get(id)?.detail;

function watchNetwork(browserContext) {
  browserContext.on('request', request => allRequestUrls.push(request.url()));
  browserContext.on('requestfailed', request => {
    if (apiBlocked) return; // deliberate application-API block for the offline case
    requestFailures.push({ url: request.url().slice(0, 500), error: request.failure()?.errorText ?? 'unknown' });
  });
  browserContext.on('response', response => {
    const url = new URL(response.url());
    const status = response.status();
    if (status >= 400) {
      const entry = { path: url.pathname, status, step: currentStep };
      refused.push(entry);
      response.text().then(text => { entry.body = text.slice(0, 500); }).catch(() => undefined);
    }
    if (response.request().method() !== 'POST') return;
    if (!/^\/api\/learning\/(?:workspaces|executions)\//.test(url.pathname)) return;
    const parts = url.pathname.split('/');
    const entry = { path: url.pathname, status, step: currentStep, activityId: parts[4] ?? '' };
    report.apiPosts.push(entry);
    if (status >= 400) response.text().then(text => { entry.body = text.slice(0, 2000); }).catch(() => undefined);
  });
}

async function runCase(id, fn, { fatal = true } = {}) {
  currentStep = id;
  try {
    const detail = await fn();
    mark(id, 'PASS', detail ? { detail } : {});
    console.log(`PASS ${id}`);
  } catch (error) {
    mark(id, 'FAIL', { error: String(error?.stack ?? error) });
    console.log(`FAIL ${id}: ${error?.message ?? error}`);
    const target = secondPage ?? page;
    if (target) await target.screenshot({ path: join(output, `failure-${id}.png`), fullPage: true }).catch(() => undefined);
    if (fatal) throw error;
  }
}

const historyOf = async activityId => {
  const response = await context.request.get(`${endpoint}/api/learning/executions/${activityId}/history`);
  assert.equal(response.status(), 200, `history ${activityId}: ${response.status()}`);
  return response.json();
};
/** Service history is paged by request id, not time; order locally by createdAt when selecting latest. */
const chronological = entries => [...entries].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
const checkOperation = (entry, operationId) => entry?.action?.execution?.operation?.operationId === operationId;
const latestCheck = async activityId => {
  const history = await historyOf(activityId);
  return chronological(history.entries).reverse().find(entry => checkOperation(entry, 'check-all'));
};
/** The browser completes the check locally before its reliable ledger syncs; wait for the owner copy. */
const waitForCheck = async (activityId, predicate) => {
  let found;
  await expect.poll(async () => {
    found = await latestCheck(activityId);
    return Boolean(found && found.query.state === 'succeeded' && predicate(found.query.output?.output ?? {}));
  }, { timeout: T.sync }).toBe(true);
  return found;
};

try {
  // ---------------------------------------------------------------------------------------
  // 1. The service and PostgreSQL are on a different real machine; strict TLS + pin.
  // ---------------------------------------------------------------------------------------
  await runCase('env-placement', async () => {
    assert.equal(school.protocol, 'https:', 'the school endpoint must be HTTPS');
    assert.equal(state.nodePlatform, 'linux', 'the school node platform must be the Linux host');
    assert.notEqual(state.nodePlatform, process.platform, `the school node must not run on this ${process.platform} client`);
    assert.ok(!localAddresses.includes(schoolHost), `school host ${schoolHost} must not be one of this client's addresses`);
    return {
      schoolHost, schoolNodePlatform: state.nodePlatform, schoolNodeArch: state.nodeArch,
      schoolNodeVersion: state.nodeVersion, distributionSha256: state.distributionSha256,
      clientAddressIsSchoolHost: false, localAddressCount: localAddresses.length,
    };
  });

  await runCase('tls-pin', async () => {
    const caPath = process.env.NODE_EXTRA_CA_CERTS ?? join(dirname(statePath), 'ca.crt');
    const ca = await readFile(caPath);
    const socket = tls.connect({ host: schoolHost, port: Number(school.port || 443), servername: schoolHost, ca });
    await once(socket, 'secureConnect');
    const certificate = socket.getPeerCertificate();
    const authorized = socket.authorized;
    const protocol = socket.getProtocol();
    const cipher = socket.getCipher()?.name;
    const spki = createHash('sha256').update(certificate.pubkey).digest('base64');
    socket.end();
    assert.ok(authorized, `strict TLS chain verification failed: ${socket.authorizationError}`);
    assert.equal(spki, state.spki, 'the live server SPKI does not match the pinned public key');
    report.tls = { authorized, spki, protocol, cipher };

    browser = await chromium.launch({ channel: 'chrome', headless: true,
      args: [`--ignore-certificate-errors-spki-list=${state.spki}`] });
    report.browser = browser.version();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
      ignoreHTTPSErrors: false });
    watchNetwork(context);

    const entry = await context.request.get(endpoint + '/api/learning/context');
    assert.equal(entry.status(), 200);
    const served = await entry.json();
    assert.equal(served.profile, 'school');
    assert.ok(!served.identities.some(item => item.key === 'personal'), 'the school entry must expose no personal identity');
    return { tlsAuthorized: authorized, spkiMatches: true, profile: served.profile, browser: report.browser, readOnly: served.readOnly };
  });

  // ---------------------------------------------------------------------------------------
  // 2. School member login and the fixed ALU course activity.
  // ---------------------------------------------------------------------------------------
  let activity;
  await runCase('login-activity', async () => {
    const started = Date.now();
    const login = await context.request.post(endpoint + '/api/learning/login',
      { data: { loginName: state.loginName, password: state.password } });
    assert.equal(login.status(), 200, `login failed: ${login.status()} ${await login.text()}`);
    const identity = (await login.json()).identity;
    assert.equal(identity.kind, 'school');
    report.identity = { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId };
    const created = await context.request.post(endpoint + '/api/learning/course-activities',
      { data: { requestId: randomUUID(), releaseId: state.releaseId } });
    assert.equal(created.status(), 200, `course-activities failed: ${created.status()} ${await created.text()}`);
    activity = await created.json();
    report.activityId = activity.activityId;
    report.timings.loginMs = Date.now() - started;
    report.timestamps.loginAt = new Date().toISOString();
    assert.equal(activity.course.releaseId, state.releaseId);
    assert.equal(activity.course.taskTitle, state.courseTitle);
    return { activityId: activity.activityId, releaseId: activity.course.releaseId, taskTitle: activity.course.taskTitle };
  });

  // ---------------------------------------------------------------------------------------
  // 3. Page, fixed component/course preparation and self-check over the cross-machine link.
  // ---------------------------------------------------------------------------------------
  await runCase('preparation', async () => {
    page = await context.newPage();
    const started = Date.now();
    await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
    await expect(page.locator('#activity-title')).toHaveText(state.courseTitle, { timeout: T.ui });
    // The design tab owns starter import; switching away before it settles would leave no code file.
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: T.prep });
    await expect(page.getByRole('button', { name: 'alu.sv', exact: true }).first()).toBeVisible({ timeout: T.ui });
    await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
    await expect(page.getByRole('button', { name: '运行', exact: true })).toBeEnabled({ timeout: T.prep });
    report.timings.preparationMs = Date.now() - started;
    report.timestamps.preparationReadyAt = new Date().toISOString();

    const reportsResponse = await context.request.get(
      `${endpoint}/api/learning/releases/${state.releaseId}/components/alu/preparation-reports`);
    assert.equal(reportsResponse.status(), 200);
    const reports = await reportsResponse.json();
    const ready = reports.filter(item => item.status === 'ready');
    assert.ok(ready.length > 0, 'no ready preparation report was recorded by the school owner');
    const latest = ready[ready.length - 1];
    assert.ok((latest.capabilities ?? []).every(item => item.availability === 'available' && item.verification === 'verified'),
      'preparation report does not show all capabilities verified');
    report.preparation = {
      reportCount: reports.length,
      readyCount: ready.length,
      latest: { status: latest.status, stage: latest.stage, durationMs: latest.durationMs,
        cacheHit: latest.cacheHit, resourceBytes: latest.resourceBytes,
        device: latest.device?.browser, platform: latest.device?.platform,
        features: latest.device?.features },
    };
    // The starter workspace must have synced to the school owner before a run can mean anything.
    const workResponse = await context.request.get(`${endpoint}/api/learning/workspaces/${activity.activityId}`);
    assert.equal(workResponse.status(), 200);
    const work = await workResponse.json();
    const workFile = work.files?.find(file => file.name === 'alu.sv');
    const conflicts = report.apiPosts.filter(entry => entry.activityId === activity.activityId
      && (entry.status === 409 || /identity-conflict/.test(entry.body ?? '')));
    if (conflicts.length) report.identityConflict = { reproduced: true, activityId: activity.activityId, events: conflicts };
    assert.ok(work.revision >= 1 && workFile,
      `the first activity workspace did not initialize${conflicts.length ? ': identity-conflict ' + JSON.stringify(conflicts.slice(0, 3)) : ''}`);
    report.firstActivityWorkspace = { revision: work.revision, objectId: workFile.objectId, contentId: workFile.contentId };
    assert.ok(await page.getByRole('button', { name: '检查全部输入', exact: true }).isDisabled(),
      'check must be disabled before any work is enabled');
    await page.screenshot({ path: join(output, 'before-run.png') });
    return { preparationMs: report.timings.preparationMs, workspaceRevision: work.revision, ...report.preparation };
  });

  // ---------------------------------------------------------------------------------------
  // 4. Starter run: a real four-state X observation, not a fake zero.
  // ---------------------------------------------------------------------------------------
  await runCase('starter-observation', async () => {
    const run = page.getByRole('button', { name: '运行', exact: true });
    const started = Date.now();
    await run.click();
    await expect(page.getByText(/已启用这次运行的作品/, { exact: false })).toBeVisible({ timeout: T.run });
    report.timings.starterRunMs = Date.now() - started;
    report.timestamps.starterRunAt = new Date().toISOString();
    await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
    await expect(page.locator('.alu-board')).toContainText(/已取得观察|输出含 X\/Z/, { timeout: T.ui });
    const status = await page.locator('.alu-board-status').innerText();
    const readout = await page.locator('.alu-readout-value').innerText();
    assert.match(status, /输出含 X\/Z|已取得观察/, `unexpected board status: ${status}`);
    assert.match(readout, /F=[xXzZ]|F=xxxx/, `starter must not be shown as a fake zero: ${readout}`);
    await page.screenshot({ path: join(output, 'after-starter-unknown.png') });
    let starter;
    await expect.poll(async () => {
      const history = await historyOf(activity.activityId);
      starter = chronological(history.entries).reverse().find(entry => checkOperation(entry, 'run-single')
        && entry.query.state === 'succeeded');
      return Boolean(starter && /^[xXzZ]+$/.test(String(starter.query.output?.output?.f ?? '')));
    }, { timeout: T.sync }).toBe(true);
    assert.match(String(starter.query.output?.output?.f ?? ''), /^[xXzZ]+$/, 'starter output was not four-state unknown');
    return { boardStatus: status, readout, requestId: starter.requestId, observationState: starter.query.output?.output?.observationState };
  });

  // ---------------------------------------------------------------------------------------
  // 5. Correct ALU code through Monaco, real Worker observation through the school link.
  // ---------------------------------------------------------------------------------------
  const correct = `// correct ALU typed through the real editor\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); always_comb begin F=0; Cout=0; case({M,S}) 3'b000:F=~A; 3'b001:F=A&B; 3'b010:F=A|B; 3'b011:F=A^B; 3'b100:{Cout,F}={1'b0,A}+{1'b0,B}+Cin; default:begin F=0;Cout=0;end endcase end endmodule`;
  const dropCarry = correct.replace("3'b100:{Cout,F}={1'b0,A}+{1'b0,B}+Cin;", "3'b100:F=A+B+Cin;");
  const spin = `module alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); initial begin F=0; Cout=0; forever #0 F=~F; end endmodule`;
  const tab = async name => page.getByRole('tab', { name, exact: true }).click();
  const replace = async text => {
    const editor = page.locator('.monaco-editor textarea').first();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(text);
  };
  const switchState = async (pattern, on) => {
    const buttons = page.getByRole('button', { name: pattern });
    const count = await buttons.count();
    for (let index = 0; index < count; index++) {
      const button = buttons.nth(index);
      if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click();
    }
  };
  const readout = () => page.locator('.alu-readout-value');

  await runCase('correct-observation', async () => {
    await tab('作品');
    await replace(correct);
    await tab('ALU 实验');
    await expect(page.getByText('修改尚未运行', { exact: false }).first()).toBeVisible({ timeout: T.ui });
    const started = Date.now();
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await expect(page.getByText(/已启用这次运行的作品/, { exact: false })).toBeVisible({ timeout: T.run });
    report.timings.correctRunMs = Date.now() - started;
    report.timestamps.correctRunAt = new Date().toISOString();
    await tab('ALU 实验');
    await switchState(/^A 位/, true);
    await switchState(/^B 位/, false);
    await switchState(/^M 位/, true);
    await switchState(/^S 位/, false);
    const inputStarted = Date.now();
    await switchState(/^Cin 位/, true);
    await expect(readout()).toContainText('F=0000', { timeout: T.run });
    await expect(readout()).toContainText('Cout=1', { timeout: T.run });
    report.timings.lastInputToObservationMs = Date.now() - inputStarted;
    report.timestamps.observationAt = new Date().toISOString();
    assert.equal(await page.locator('.alu-numeric-field input').count(), 5,
      'the host five-control numeric editor must be the same input state as the switches');
    await expect(page.locator('.alu-board-status')).toContainText('已取得观察', { timeout: T.ui });
    await page.screenshot({ path: join(output, 'after-observation.png') });

    let found;
    await expect.poll(async () => {
      const history = await historyOf(activity.activityId);
      found = chronological(history.entries).reverse().find(entry => checkOperation(entry, 'observe-enabled')
        && entry.query.state === 'succeeded'
        && entry.action.execution.parameters.A === 15 && entry.action.execution.parameters.B === 0
        && entry.action.execution.parameters.M === 1 && entry.action.execution.parameters.S === 0
        && entry.action.execution.parameters.Cin === 1);
      return Boolean(found && found.query.output?.output?.f === '0000' && found.query.output?.output?.cout === '1');
    }, { timeout: T.sync }).toBe(true);
    return { inputs: { A: 15, B: 0, M: 1, S: 0, Cin: 1 }, f: '0000', cout: '1',
      requestId: found.requestId, lastInputToObservationMs: report.timings.lastInputToObservationMs };
  });

  // ---------------------------------------------------------------------------------------
  // 6. Free observation stays local while the application API is unreachable, then syncs once.
  // ---------------------------------------------------------------------------------------
  await runCase('offline-sync', async () => {
    const before = await historyOf(activity.activityId);
    const beforeIds = new Set(before.entries.map(entry => entry.query.requestId));
    report.historySync = { beforeCount: before.entries.length, beforeRequestIds: [...beforeIds] };
    apiBlocked = true;
    await context.route('**/api/learning/**', route => route.abort());
    const b0 = page.getByRole('button', { name: /^B 位/ }).nth(3);
    const started = Date.now();
    if ((await b0.getAttribute('aria-pressed')) === 'false') await b0.click();
    await expect(readout()).toContainText('F=0001', { timeout: T.run });
    await expect(readout()).toContainText('Cout=1', { timeout: T.run });
    report.timings.offlineObservationMs = Date.now() - started;
    const offlineReadout = await readout().innerText();
    await context.unroute('**/api/learning/**');
    apiBlocked = false;
    if ((await b0.getAttribute('aria-pressed')) === 'true') await b0.click();
    await expect(readout()).toContainText('F=0000', { timeout: T.run });
    await expect(readout()).toContainText('Cout=1', { timeout: T.run });

    const offlineObservation = entry => !beforeIds.has(entry.query.requestId)
      && checkOperation(entry, 'observe-enabled') && entry.query.state === 'succeeded'
      && entry.action.execution.parameters.A === 15 && entry.action.execution.parameters.M === 1
      && entry.action.execution.parameters.S === 0 && entry.action.execution.parameters.Cin === 1;
    await expect.poll(async () => {
      const history = await historyOf(activity.activityId);
      const entries = history.entries.filter(offlineObservation);
      return entries.length === 2
        && entries.some(entry => entry.action.execution.parameters.B === 1
          && entry.query.output?.output?.f === '0001' && entry.query.output?.output?.cout === '1')
        && entries.some(entry => entry.action.execution.parameters.B === 0
          && entry.query.output?.output?.f === '0000' && entry.query.output?.output?.cout === '1');
    }, { timeout: T.sync }).toBe(true);
    await sleep(1500); // allow an accidental duplicate sync to materialise before judging it
    const after = await historyOf(activity.activityId);
    const newEntries = after.entries.filter(entry => !beforeIds.has(entry.query.requestId));
    const newObservations = newEntries.filter(entry => checkOperation(entry, 'observe-enabled'));
    const descriptions = newObservations.map(entry => ({ requestId: entry.query.requestId,
      parameters: entry.action.execution.parameters, state: entry.query.state,
      f: entry.query.output?.output?.f, cout: entry.query.output?.output?.cout,
      operation: entry.action.execution.operation.operationId }))
      .sort((a, b) => a.parameters.B - b.parameters.B);
    assert.equal(new Set(after.entries.map(entry => entry.query.requestId)).size, after.entries.length,
      'history contains duplicate request identities');
    assert.equal(newObservations.length, 2, `expected exactly two offline observations, saw ${newObservations.length}`);
    assert.ok(descriptions.some(item => item.parameters.B === 1 && item.f === '0001' && item.cout === '1'),
      `the offline B=1 observation did not sync: ${JSON.stringify(descriptions)}`);
    assert.ok(descriptions.some(item => item.parameters.B === 0 && item.f === '0000' && item.cout === '1'),
      `the restored B=0 observation did not sync: ${JSON.stringify(descriptions)}`);
    assert.equal(newEntries.length, 2, `syncing the two local observations must not duplicate executions: ${JSON.stringify(newEntries.map(entry => entry.query.requestId))}`);
    report.historySync = { ...report.historySync, afterCount: after.entries.length,
      newObservationRequestIds: newObservations.map(entry => entry.query.requestId), observations: descriptions,
      uniqueRequestIds: true };
    report.historySync.afterRequestIds = after.entries.map(entry => entry.query.requestId);
    return { offlineReadout, ...report.historySync };
  });

  // ---------------------------------------------------------------------------------------
  // 7. Full 4096-input check passes; its report artifact is readable through the school owner.
  // ---------------------------------------------------------------------------------------
  await runCase('check-pass', async () => {
    const started = Date.now();
    await page.getByRole('button', { name: /^(检查全部输入|再次检查)$/ }).click();
    await expect(page.getByText('4096 组检查通过', { exact: true })).toBeVisible({ timeout: T.check });
    report.timings.checkPassMs = Date.now() - started;
    report.timestamps.checkPassAt = new Date().toISOString();
    await expect(page.locator('.alu-check-counts')).toContainText('16384');
    await expect(page.locator('.alu-check-counts')).toContainText('1536');
    await page.screenshot({ path: join(output, 'after-check-pass.png') });

    const pass = await waitForCheck(activity.activityId, result => result.verdict === 'pass' && result.totalInputs === 4096)
      .catch(async error => {
        const active = await latestCheck(activity.activityId);
        throw new Error(`${error.message}; latest check=${JSON.stringify(active && { state: active.query.state, output: active.query.output?.output })}`);
      });
    const result = pass.query.output?.output ?? {};
    assert.equal(result.verdict, 'pass');
    assert.equal(result.totalInputs, 4096);
    assert.equal(result.plannedSamples, 16384);
    assert.equal(result.behaviorErrorInputs, 0);
    assert.ok(pass.query.output?.artifact, 'service history exposes the primary check artifact');
    const artifactResponse = await context.request.get(
      `${endpoint}/api/learning/executions/${activity.activityId}/${pass.query.requestId}/artifact`);
    assert.equal(artifactResponse.status(), 200);
    const artifact = await artifactResponse.json();
    const primary = JSON.parse(artifact.text);
    assert.equal(primary.reservedInputs, 1536, 'check report must cover the reserved combinations');
    assert.equal(primary.reservedCovered, 1536, 'check report must cover all reserved combinations');
    const resources = artifact.resources ?? [];
    assert.ok(resources.some(item => item.name === 'check-observations.json'), 'check observations resource is missing');
    report.checkPass = { requestId: pass.query.requestId, executionRef: pass.query.executionRef,
      metrics: { ...result, reservedInputs: primary.reservedInputs, reservedCovered: primary.reservedCovered,
        counterexampleTotal: primary.counterexampleTotal },
      primaryBytes: pass.query.output.artifact.byteLength,
      resources: resources.map(item => ({ name: item.name, byteLength: item.byteLength })),
      resourceBytes: pass.query.output.artifact.byteLength + resources.reduce((total, item) => total + item.byteLength, 0) };
    return report.checkPass;
  });

  // ---------------------------------------------------------------------------------------
  // 8. Fixed drop-carry implementation fails with 256 unique counterexamples / 1024 error rows.
  // ---------------------------------------------------------------------------------------
  await runCase('check-fail', async () => {
    await tab('作品');
    await replace(dropCarry);
    await tab('ALU 实验');
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await expect(page.getByText(/已启用这次运行的作品/, { exact: false })).toBeVisible({ timeout: T.run });
    await tab('ALU 实验');
    const started = Date.now();
    await page.getByRole('button', { name: /^(检查全部输入|再次检查)$/ }).click();
    await expect(page.getByText('检查未通过', { exact: false }).first()).toBeVisible({ timeout: T.check });
    report.timings.checkFailMs = Date.now() - started;
    report.timestamps.checkFailAt = new Date().toISOString();
    await expect(page.locator('.alu-check-counts')).toContainText('256');
    await page.screenshot({ path: join(output, 'after-check-fail.png') });
    await page.locator('.alu-counterexamples').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, 'after-counterexamples.png') });

    const fail = await waitForCheck(activity.activityId, result => result.verdict === 'fail' && result.behaviorErrorInputs === 256)
      .catch(async error => {
        const active = await latestCheck(activity.activityId);
        throw new Error(`${error.message}; latest check=${JSON.stringify(active && { state: active.query.state, output: active.query.output?.output })}`);
      });
    const result = fail.query.output?.output ?? {};
    assert.equal(result.verdict, 'fail');
    assert.equal(result.behaviorErrorInputs, 256, 'expected 256 unique counterexample inputs');
    assert.ok(result.unknownInputs === 0 && result.inconsistentInputs === 0 && result.missingInputs === 0);
    const rounds = result.roundsCompleted ?? (result.rounds?.length ?? 0);
    assert.equal(rounds, 4, 'all four sampling rounds must complete');
    const errorRows = result.behaviorErrorInputs * rounds;
    assert.equal(errorRows, 1024, 'expected 1024 error rows (256 inputs × 4 rounds)');
    const artifactResponse = await context.request.get(
      `${endpoint}/api/learning/executions/${activity.activityId}/${fail.query.requestId}/artifact`);
    assert.equal(artifactResponse.status(), 200);
    const artifact = await artifactResponse.json();
    report.checkFail = { requestId: fail.query.requestId, executionRef: fail.query.executionRef, metrics: result,
      errorRows, resources: (artifact.resources ?? []).map(item => ({ name: item.name, byteLength: item.byteLength })) };
    return report.checkFail;
  });

  // ---------------------------------------------------------------------------------------
  // 9. Refresh restores the enabled input, observation and failed report without recomputation.
  // ---------------------------------------------------------------------------------------
  await runCase('refresh', async () => {
    const before = await historyOf(activity.activityId);
    const beforeIds = before.entries.map(entry => entry.query.requestId).sort();
    const boardState = async () => ({
      readout: (await readout().innerText()).trim(),
      switches: await page.locator('.alu-switch button').evaluateAll(elements => elements.map(element => element.getAttribute('aria-pressed'))),
    });
    const beforeBoard = await boardState();
    assert.equal(beforeBoard.switches.length, 12, 'expected twelve ALU switches before refresh');
    const started = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: T.ui });
    await expect(page.locator('#activity-title')).toHaveText(state.courseTitle, { timeout: T.ui });
    await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
    await expect(page.getByText('检查未通过', { exact: false }).first()).toBeVisible({ timeout: T.check });
    await expect(page.locator('.alu-check-counts')).toContainText('256', { timeout: T.ui });
    await expect(readout()).toContainText('F=', { timeout: T.run });
    const afterBoard = await boardState();
    // The enabled work is the fixed drop-carry implementation from the previous case:
    // A=15/B=0/M=1/S=0/Cin=1 truthfully yields F=0000/Cout=0. Refresh must restore that
    // same enabled input and observation, not the older correct-work observation.
    assert.match(afterBoard.readout, /F=0000\s+Cout=0/, `restored observation is inconsistent with the enabled drop-carry work: ${afterBoard.readout}`);
    assert.deepEqual(afterBoard.switches, beforeBoard.switches, 'refresh must restore the enabled switch positions');
    assert.equal(afterBoard.readout, beforeBoard.readout, 'refresh must restore the same observation');
    report.timings.refreshMs = Date.now() - started;
    report.timestamps.refreshAt = new Date().toISOString();
    report.refreshState = { before: beforeBoard, after: afterBoard };
    await page.screenshot({ path: join(output, 'after-refresh.png') });
    const after = await historyOf(activity.activityId);
    const afterIds = after.entries.map(entry => entry.query.requestId).sort();
    assert.deepEqual(afterIds, beforeIds, 'refresh must not recompute or create execution history');
    return { refreshMs: report.timings.refreshMs, historyEntries: after.entries.length, recomputed: false,
      readout: afterBoard.readout };
  });

  // ---------------------------------------------------------------------------------------
  // 10. A real zero-time Worker is stopped; normal work and a check continue afterwards.
  // ---------------------------------------------------------------------------------------
  await runCase('worker-stop', async () => {
    await tab('作品');
    await replace(spin);
    await tab('ALU 实验');
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
    const stop = page.getByRole('button', { name: '停止', exact: true }).first();
    await expect(stop).toBeVisible({ timeout: T.run });
    const started = Date.now();
    await stop.click();
    await expect(page.getByText('已取消', { exact: false }).first()).toBeVisible({ timeout: T.run });
    report.timings.stopMs = Date.now() - started;
    report.timestamps.stopAt = new Date().toISOString();
    await page.screenshot({ path: join(output, 'after-stop.png') });

    await tab('作品');
    await replace(correct);
    await tab('ALU 实验');
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await expect(page.getByText(/已启用这次运行的作品/, { exact: false })).toBeVisible({ timeout: T.run });
    await tab('ALU 实验');
    await page.getByRole('button', { name: /^(检查全部输入|再次检查)$/ }).click();
    await expect(page.getByText('4096 组检查通过', { exact: true })).toBeVisible({ timeout: T.check });
    return { stopMs: report.timings.stopMs, normalRunAfterStop: true, checkPassAfterStop: true };
  });

  // ---------------------------------------------------------------------------------------
  // 11. Same identity, second activity with the same release: no 409 identity-conflict.
  // ---------------------------------------------------------------------------------------
  let secondActivityId;
  try {
    await runCase('second-activity', async () => {
      const created = await context.request.post(endpoint + '/api/learning/course-activities',
        { data: { requestId: randomUUID(), releaseId: state.releaseId } });
      assert.equal(created.status(), 200, `second course-activities failed: ${created.status()} ${await created.text()}`);
      const second = await created.json();
      secondActivityId = second.activityId;
      report.secondActivityId = secondActivityId;
      secondPage = await context.newPage();
      const started = Date.now();
      await secondPage.goto(endpoint + '?space=school&activity=' + secondActivityId);
      await expect(secondPage.locator('#activity-title')).toHaveText(state.courseTitle, { timeout: T.ui });
      await expect(secondPage.locator('.monaco-editor').first()).toBeVisible({ timeout: T.prep });
      await expect(secondPage.getByRole('button', { name: 'alu.sv', exact: true }).first()).toBeVisible({ timeout: T.ui });
      await secondPage.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
      await expect(secondPage.getByRole('button', { name: '运行', exact: true })).toBeEnabled({ timeout: T.prep });
      report.timings.secondActivityMs = Date.now() - started;

      const workResponse = await context.request.get(`${endpoint}/api/learning/workspaces/${secondActivityId}`);
      assert.equal(workResponse.status(), 200);
      const work = await workResponse.json();
      assert.ok(work.revision >= 1, 'second activity workspace was not initialized');
      const workFile = work.files?.find(file => file.name === 'alu.sv');
      assert.ok(workFile, 'second activity has no alu.sv starter');
      const firstWork = await (await context.request.get(`${endpoint}/api/learning/workspaces/${activity.activityId}`)).json();
      const firstFile = firstWork.files?.find(file => file.name === 'alu.sv');
      assert.notEqual(workFile.objectId, firstFile?.objectId, 'starter object identity must be per activity, never shared');
      const allPosts = report.apiPosts.filter(entry => entry.activityId === secondActivityId);
      const conflicts = allPosts.filter(entry => entry.status === 409 || /identity-conflict/.test(entry.body ?? ''));
      if (conflicts.length) {
        report.identityConflict = { reproduced: true, activityId: secondActivityId, events: conflicts };
      }
      assert.equal(conflicts.length, 0, `identity-conflict reproduced: ${JSON.stringify(conflicts)}`);
      assert.ok(allPosts.some(entry => entry.path === `/api/learning/workspaces/${secondActivityId}` && entry.status === 200),
        'second activity has no successful workspace POST');

      await secondPage.getByRole('button', { name: '运行', exact: true }).click();
      await expect(secondPage.getByText(/已启用这次运行的作品/, { exact: false })).toBeVisible({ timeout: T.run });
      await secondPage.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
      await expect(secondPage.locator('.alu-board')).toContainText(/已取得观察|输出含 X\/Z/, { timeout: T.ui });
      await secondPage.screenshot({ path: join(output, 'second-activity.png') });
      await expect.poll(async () => {
        const secondHistory = await historyOf(secondActivityId);
        return secondHistory.entries.some(entry => checkOperation(entry, 'run-single') && entry.query.state === 'succeeded');
      }, { timeout: T.sync }).toBe(true);
      const finalPosts = report.apiPosts.filter(entry => entry.activityId === secondActivityId);
      const lateConflicts = finalPosts.filter(entry => entry.status === 409 || /identity-conflict/.test(entry.body ?? ''));
      assert.equal(lateConflicts.length, 0, `identity-conflict reproduced on execution: ${JSON.stringify(lateConflicts)}`);
      const executionPosts = finalPosts.filter(entry => entry.path === `/api/learning/executions/${secondActivityId}`);
      assert.ok(!executionPosts.some(entry => entry.status === 409), 'execution POST returned 409');
      report.secondActivity = {
        activityId: secondActivityId,
        workRevision: work.revision,
        workspaceObjectId: workFile.objectId,
        contentId: workFile.contentId,
        firstActivityObjectId: firstFile?.objectId,
        objectIdIsPerActivity: workFile.objectId !== firstFile?.objectId,
        workspacePosts: allPosts.filter(entry => entry.path === `/api/learning/workspaces/${secondActivityId}`)
          .map(entry => ({ path: entry.path, status: entry.status })),
        executionPosts: executionPosts.map(entry => ({ path: entry.path, status: entry.status })),
        identityConflict: false,
        preparationMs: report.timings.secondActivityMs,
      };
      return report.secondActivity;
    });
  } catch (error) {
    // The known #206 defect must remain visible evidence, never a loosened assertion.
    // Only call it a reproduction when a real 409 identity-conflict exists.
    const message = String(error?.message ?? error);
    const conflictPosts = report.apiPosts.filter(entry => entry.activityId === secondActivityId
      && entry.status === 409 && /identity-conflict/.test(entry.body ?? ''));
    if (conflictPosts.length || /identity-conflict/.test(message)) {
      report.identityConflict = { reproduced: true, activityId: secondActivityId ?? null, step: currentStep,
        events: conflictPosts, error: message };
    } else {
      report.secondActivityError = { reproduced: false, activityId: secondActivityId ?? null, step: currentStep, error: message };
    }
    console.log('SECOND ACTIVITY FAILED: ' + message);
  }

  // ---------------------------------------------------------------------------------------
  // 12. Network origins: only the school origin, no loopback/local service/SSH tunnel.
  // ---------------------------------------------------------------------------------------
  await runCase('network-origin', async () => {
    const parsed = allRequestUrls.map(url => new URL(url));
    const http = parsed.filter(url => url.protocol === 'http:' || url.protocol === 'https:');
    const hosts = [...new Set(http.map(url => url.host))];
    const schemes = [...new Set(parsed.map(url => url.protocol))].sort();
    assert.deepEqual(hosts, [school.host], `page reached non-school hosts: ${hosts.join(', ')}`);
    assert.ok(!hosts.some(host => /^(127\.|localhost|\[::1\]|0\.0\.0\.0)/.test(host)), 'loopback or localhost was used');
    assert.ok(schemes.every(scheme => ['https:', 'blob:', 'data:'].includes(scheme)),
      `unexpected URL scheme: ${schemes.join(', ')}`);
    assert.ok(!allRequestUrls.some(url => /ssh|tunnel/i.test(url)), 'SSH tunnel URL appeared in the page');
    report.pageHosts = hosts;
    report.pageSchemes = schemes;
    report.requestFailures = requestFailures.slice(0, 40);
    report.refused = refused;
    return { pageHosts: hosts, pageSchemes: schemes, refused: refused.map(item => `${item.status} ${item.path}`),
      requestFailures: requestFailures.length };
  });

  report.status = CASE_DEFS.every(item => caseResults.get(item.id)?.status === 'PASS') ? 'passed' : 'failed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error?.stack ?? error);
  if (page) {
    report.visibleText = await page.locator('body').innerText().catch(() => '');
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  }
  console.log('PROBE FAILED: ' + (error?.stack ?? error));
} finally {
  report.finishedAt = new Date().toISOString();
  report.refused = refused;
  report.requestFailures = requestFailures.slice(0, 40);
  report.pageHosts = [...new Set(allRequestUrls.map(url => new URL(url)).filter(url => url.protocol === 'http:' || url.protocol === 'https:').map(url => url.host))];
  report.pageSchemes = [...new Set(allRequestUrls.map(url => new URL(url).protocol))].sort();
  report.cases = CASE_DEFS.map(item => ({ id: item.id, name: item.name,
    status: caseResults.get(item.id)?.status ?? 'SKIP',
    ...(caseResults.get(item.id)?.detail !== undefined ? { detail: caseResults.get(item.id).detail } : {}),
    ...(caseResults.get(item.id)?.error !== undefined ? { error: caseResults.get(item.id).error } : {}) }));
  const summary = { pass: 0, fail: 0, skip: 0 };
  for (const item of report.cases) summary[item.status.toLowerCase()]++;
  report.caseSummary = summary;
  if (report.status !== 'failed' && summary.skip > 0) report.status = 'failed';
  await browser?.close().catch(() => undefined);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, label, cases: report.caseSummary,
    identityConflict: report.identityConflict ?? null, report: join(output, 'report.json') }));
}
