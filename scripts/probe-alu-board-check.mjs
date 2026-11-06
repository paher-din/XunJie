// Real Chrome, native PostgreSQL, formal product, real Icarus Worker and the #193 board/check UI.
// This is engineering/browser evidence, not a teaching or school-network acceptance.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { aluPackage, aluCoursePackage } from '../components/alu-experiment/package.mjs';

const output = resolve(process.env.XUNJIE_ALU_OUTPUT ?? '.verification/wp04-193-product');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'xj-alu-board-'));
let resources = { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN ?? resolve('.verification/wp04-192-windows-final/resources/postgres/bin'),
  postgresVersion: '18.6', webRoot: resolve(process.env.XUNJIE_ALU_WEB_ROOT ?? 'apps/web/dist-runtime'),
  windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') };
let runtimeFactory = openProductRuntime, credential = resolveCredential;
if (process.env.XUNJIE_ALU_PRODUCT_ROOT) {
  const packageRoot = resolve(process.env.XUNJIE_ALU_PRODUCT_ROOT);
  const declared = JSON.parse(await readFile(join(packageRoot, 'resources.json'), 'utf8'));
  resources = { ...declared, nodePath: resolve(packageRoot, declared.nodePath),
    postgresBin: resolve(packageRoot, declared.postgresBin), webRoot: resolve(packageRoot, declared.webRoot),
    ...(declared.windowsPrerequisitePath ? { windowsPrerequisitePath: resolve(packageRoot, declared.windowsPrerequisitePath) } : {}),
    ...(declared.windowsSessionHelper ? { windowsSessionHelper: resolve(packageRoot, declared.windowsSessionHelper) } : {}) };
  const bundled = await import(pathToFileURL(join(packageRoot, 'app/product-runtime.js')).href);
  runtimeFactory = bundled.openProductRuntime;
  credential = bundled.resolveCredential;
}
const runtime = runtimeFactory({ root, resources });
const report = { platform: process.platform, arch: process.arch, root, candidate: process.env.XUNJIE_ALU_PRODUCT_ROOT ?? 'workspace production Web/runtime', cases: [], timings: {}, status: 'running' };
let browser, page;
const check = (condition, message) => { assert.ok(condition, message); report.cases.push(message); };
try {
  await runtime.install({ profile: 'local' });
  const { endpoint } = await runtime.start();
  const admin = { authorization: `Bearer ${await credential(root, 'control')}` };
  const api = async (route, body, headers = admin) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`);
    return value;
  };
  const component = await aluPackage(), course = await aluCoursePackage();
  const definition = await api('manage/component-import', component);
  course.release.components[0].definition = definition;
  await api('manage/course-import', course);
  report.cases.push('new component v2 and three-operation course import into the formal product');
  const password = randomUUID(), loginName = 'alu-board-product';
  const member = await api('manage/members', { requestId: randomUUID(), loginName, password });
  await api('manage/course-access', { requestId: randomUUID(), courseId: course.course.courseId, principalId: member.principalId, active: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  assert.equal((await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId: course.release.releaseId } });
  assert.equal(created.status(), 200);
  const activity = await created.json();
  page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') console.log('BROWSER ' + message.text().slice(0, 500)); });
  page.on('pageerror', error => console.log('PAGE ERROR ' + error.message));
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await expect(page.locator('#activity-title')).toHaveText(course.task.title);
  // The design tab owns starter import; switching away before it settles would leave no code file.
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 120000 });
  await expect(page.getByRole('button', { name: 'alu.sv', exact: true }).first()).toBeVisible({ timeout: 60000 });
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.getByRole('button', { name: '运行', exact: true })).toBeEnabled({ timeout: 120000 });
  check(await page.getByRole('button', { name: '检查全部输入', exact: true }).isDisabled(), 'check is disabled before any work is enabled');
  await page.screenshot({ path: join(output, 'after-initial.png') });
  check(true, 'board and numeric input render in the existing ALU experiment tab');

  // The starter is intentionally incomplete; an X observation is still a real, enablable observation.
  report.timings.starterRunStartedAt = new Date().toISOString();
  let startedAt = Date.now();
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByText(/已启用这次运行的作品/, { exact: false })).toBeVisible({ timeout: 120000 });
  report.timings.starterRunMs = Date.now() - startedAt;
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.locator('.alu-board')).toContainText(/已取得观察|输出含 X\/Z/, { timeout: 60000 });
  await page.screenshot({ path: join(output, 'after-starter-unknown.png') });
  check(true, 'starter produces and enables a four-state X observation instead of a fake zero');

  const correct = `// correct ALU typed through the real editor\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); always_comb begin F=0; Cout=0; case({M,S}) 3'b000:F=~A; 3'b001:F=A&B; 3'b010:F=A|B; 3'b011:F=A^B; 3'b100:{Cout,F}={1'b0,A}+{1'b0,B}+Cin; default:begin F=0;Cout=0;end endcase end endmodule`;
  const dropCarry = correct.replace("3'b100:{Cout,F}={1'b0,A}+{1'b0,B}+Cin;", "3'b100:F=A+B+Cin;");
  const spin = `module alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); initial begin F=0; Cout=0; forever #0 F=~F; end endmodule`;
  const replace = async text => {
    const editor = page.locator('.monaco-editor textarea').first();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(text);
  };
  const tab = async name => page.getByRole('tab', { name, exact: true }).click();
  const switchState = async (pattern, on) => {
    const buttons = page.getByRole('button', { name: pattern });
    const count = await buttons.count();
    for (let index = 0; index < count; index++) {
      const button = buttons.nth(index);
      if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click();
    }
  };
  const waitReadout = async (text, timeout = 60000) =>
    expect(page.locator('.alu-readout-value')).toContainText(text, { timeout });

  await tab('作品');
  await replace(correct);
  await tab('ALU 实验');
  await expect(page.getByText('修改尚未运行', { exact: false }).first()).toBeVisible();
  check(true, 'editing code after enablement shows “modified but not run” and does not silently test the head');
  startedAt = Date.now();
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByText(/已启用这次运行的作品/, { exact: false })).toBeVisible({ timeout: 120000 });
  report.timings.codeRunMs = Date.now() - startedAt;
  await tab('ALU 实验');
  await switchState(/^A 位/, true);
  await switchState(/^B 位/, false);
  await switchState(/^M 位/, true);
  await switchState(/^S 位/, false);
  startedAt = Date.now();
  await switchState(/^Cin 位/, true);
  await waitReadout('F=0000');
  report.timings.lastInputToObservationMs = Date.now() - startedAt;
  await expect(page.locator('.alu-readout-value')).toContainText('Cout=1');
  await page.screenshot({ path: join(output, 'after-observation.png') });
  check(true, 'virtual switches A=15/B=0/M=1/S=00/Cin=1 produce real F=0000/Cout=1 through the enabled work');
  check(await page.locator('.alu-numeric-field input').count() === 5, 'the host five-control numeric editor is the same input state as the switches');

  // A free observation must stay local while the application API is unreachable.
  await context.route('**/api/learning/**', route => route.abort());
  const b0 = page.getByRole('button', { name: /^B 位/ }).nth(3);
  startedAt = Date.now();
  if ((await b0.getAttribute('aria-pressed')) === 'false') await b0.click();
  await waitReadout('F=0001');
  report.timings.offlineObservationMs = Date.now() - startedAt;
  await expect(page.locator('.alu-readout-value')).toContainText('Cout=1');
  await context.unroute('**/api/learning/**');
  if ((await b0.getAttribute('aria-pressed')) === 'true') await b0.click();
  await waitReadout('F=0000');
  check(true, 'a free observation still reaches the real Worker while the application API is unavailable; inputs and results remain local');

  startedAt = Date.now();
  await page.getByRole('button', { name: /^(检查全部输入|再次检查)$/ }).click();
  await expect(page.getByText('4096 组检查通过', { exact: true })).toBeVisible({ timeout: 120000 });
  report.timings.checkPassMs = Date.now() - startedAt;
  await expect(page.locator('.alu-check-counts')).toContainText('16384');
  await expect(page.locator('.alu-check-counts')).toContainText('1536');
  await page.screenshot({ path: join(output, 'after-check-pass.png') });
  check(true, 'full 4096-input check passes with 16384 compared rows and 1536 reserved inputs covered');
  await expect(page.getByText('反例', { exact: true }).first()).toBeVisible();
  // Read the retained check artifact through the product owner, not the UI state.
  await expect.poll(async () => {
    const response = await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`);
    if (!response.ok()) return false;
    const value = await response.json();
    return value.entries.some(entry => entry.action.execution.operation.operationId === 'check-all' && entry.query.state === 'succeeded');
  }, { timeout: 30000 }).toBe(true);
  const passHistory = await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json();
  const passCheck = passHistory.entries.find(entry => entry.action.execution.operation.operationId === 'check-all' && entry.query.state === 'succeeded');
  assert.ok(passCheck?.query?.output?.artifact, 'service history exposes the primary check artifact');
  const forgedAction = structuredClone(passCheck.action);
  forgedAction.requestId = randomUUID();
  forgedAction.execution.basis.works.find(file => file.kind === 'code').value += '\n// not the enabled code';
  const forgedDigest = createHash('sha256').update(JSON.stringify(forgedAction)).digest('hex');
  const forgedAcceptance = structuredClone(passCheck.acceptance);
  Object.assign(forgedAcceptance.receipt, { requestId: forgedAction.requestId, inputDigest: forgedDigest,
    receiptId: 'browser:' + forgedAction.requestId });
  forgedAcceptance.execution.executionRef = randomUUID();
  const rejected = await context.request.post(`${endpoint}/api/learning/executions/${activity.activityId}`, {
    data: { action: forgedAction, acceptance: forgedAcceptance } });
  const rejection = await rejected.json();
  report.sourceRejection = { status: rejected.status(), reason: rejection.error ?? rejection.code ?? rejection };
  check(rejected.status() === 400, 'the real service refuses a check whose HDL differs from its successful enabled source');
  const passArtifact = await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/${passCheck.query.requestId}/artifact`)).json();
  report.timings.checkPrimaryBytes = passCheck.query.output.artifact.byteLength;
  report.timings.checkResources = (passArtifact.resources ?? []).map(resource => ({ name: resource.name, byteLength: resource.byteLength }));
  report.timings.checkResourceBytes = passCheck.query.output.artifact.byteLength
    + (passArtifact.resources ?? []).reduce((total, resource) => total + resource.byteLength, 0);

  // A long check keeps the input editable; the newest candidate is observed only after the slot frees.
  startedAt = Date.now();
  await page.getByRole('button', { name: '再次检查', exact: true }).click();
  const aSwitches = page.getByRole('button', { name: /^A 位/ });
  const a0 = aSwitches.nth(3);
  if ((await a0.getAttribute('aria-pressed')) === 'true') await a0.click();
  await expect(page.getByText('检查中，输入已保留', { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('4096 组检查通过', { exact: true })).toBeVisible({ timeout: 120000 });
  await waitReadout('F=1111');
  report.timings.checkDuringInputMs = Date.now() - startedAt;
  await expect(page.locator('.alu-readout-value')).toContainText('Cout=0');
  check(true, 'input can change while a check occupies the slot; the check result does not preempt the board, and the latest candidate is observed after it finishes');
  if ((await a0.getAttribute('aria-pressed')) === 'false') await a0.click();
  await waitReadout('F=0000');

  // An invalid numeric draft stays local and cannot change the port or start a simulation.
  const numericA = page.locator('.alu-numeric-field').filter({ hasText: 'A（无符号 4 位）' }).locator('input');
  await numericA.fill('16');
  await expect(numericA).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.alu-readout-value')).toContainText('F=0000');
  await numericA.fill('15');
  await expect(numericA).toHaveAttribute('aria-invalid', 'false');
  check(true, 'an out-of-range numeric draft is marked invalid and leaves the committed input and reading unchanged');

  // Keyboard toggles the same switch contract without a pointer.
  await a0.focus();
  const beforeKey = await a0.getAttribute('aria-pressed');
  await page.keyboard.press('Space');
  await expect(a0).toHaveAttribute('aria-pressed', beforeKey === 'true' ? 'false' : 'true');
  await page.keyboard.press('Space');
  await expect(a0).toHaveAttribute('aria-pressed', beforeKey);
  check(true, 'a switch is keyboard operable with Space and keeps aria-pressed in sync');

  await tab('作品');
  await replace(dropCarry);
  await tab('ALU 实验');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByText(/已启用这次运行的作品/, { exact: false })).toBeVisible({ timeout: 120000 });
  await tab('ALU 实验');
  startedAt = Date.now();
  await page.getByRole('button', { name: /^(检查全部输入|再次检查)$/ }).click();
  await expect(page.getByText('检查未通过', { exact: false }).first()).toBeVisible({ timeout: 120000 });
  report.timings.checkFailMs = Date.now() - startedAt;
  await expect(page.locator('.alu-check-counts')).toContainText('256');
  await page.screenshot({ path: join(output, 'after-check-fail.png') });
  await page.locator('.alu-counterexamples').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'after-counterexamples.png') });
  check(true, 'fixed drop-carry work is reported as failing with 256 unique counterexample inputs, not as a pass');

  startedAt = Date.now();
  await page.reload();
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.getByText('检查未通过', { exact: false }).first()).toBeVisible({ timeout: 60000 });
  await waitReadout('F=0000');
  report.timings.refreshMs = Date.now() - startedAt;
  await page.screenshot({ path: join(output, 'after-refresh.png') });
  check(true, 'refresh restores the enabled input, observation and selected latest failed report without recomputation');

  // A real hanging Worker is stopped through the existing controller, then a normal work runs again.
  await tab('作品');
  await replace(spin);
  await tab('ALU 实验');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  const stop = page.getByRole('button', { name: '停止', exact: true }).first();
  await expect(stop).toBeVisible({ timeout: 30000 });
  startedAt = Date.now();
  await stop.click();
  await expect(page.getByText('已取消', { exact: false }).first()).toBeVisible({ timeout: 30000 });
  report.timings.stopMs = Date.now() - startedAt;
  check(true, 'an actual zero-time Worker is stopped through the original execution controller');
  await tab('作品');
  await replace(correct);
  await tab('ALU 实验');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByText(/已启用这次运行的作品/, { exact: false })).toBeVisible({ timeout: 120000 });
  await tab('ALU 实验');
  await page.getByRole('button', { name: /^(检查全部输入|再次检查)$/ }).click();
  await expect(page.getByText('4096 组检查通过', { exact: true })).toBeVisible({ timeout: 120000 });
  check(true, 'normal work and check remain usable after a real Worker stop');

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: join(output, 'after-narrow.png') });
  await page.evaluate(() => localStorage.setItem('theme.v1', 'dark'));
  await page.reload();
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await page.screenshot({ path: join(output, 'after-dark.png') });
  check(true, 'narrow desktop and dark theme render the same board, inputs and check report');

  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.locator('.alu-board')).toBeVisible();
  await page.getByRole('button', { name: '再次检查', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'after-900.png') });
  check(true, '900px desktop keeps the board, values and check action reachable');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.getByRole('button', { name: '再次检查', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '再次检查', exact: true })).toBeInViewport();
  await page.screenshot({ path: join(output, 'after-200-content-zoom.png') });
  check(true, '200% content zoom keeps check controls in the reflowed desktop (CSS zoom, not a claim about OS display scaling)');
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page.getByRole('tab', { name: '作品', exact: true }).dispatchEvent('dragstart', { dataTransfer });
  await page.locator('.ws-dropzone.left').first().dispatchEvent('drop', { dataTransfer });
  await expect(page.locator('.alu-tool')).toHaveCount(2);
  const countObservations = () => page.evaluate(async () => {
    const db = await new Promise((done, reject) => {
      const request = indexedDB.open('xunjie-reliable-works-v1'); request.onsuccess = () => done(request.result); request.onerror = () => reject(request.error);
    });
    const rows = await new Promise(done => { const request = db.transaction('executionCommands').objectStore('executionCommands').getAll(); request.onsuccess = () => done(request.result); });
    db.close(); return rows.filter(row => row.action.execution.operation.operationId === 'observe-enabled').length;
  });
  const beforeSplit = await countObservations();
  await page.locator('.runtime-tool-full').getByRole('button', { name: /^A 位 0/ }).click();
  await expect.poll(countObservations).toBe(beforeSplit + 1);
  await expect(page.locator('.runtime-tool-full .alu-board-status')).toContainText('已取得观察');
  await page.waitForTimeout(650);
  assert.equal(await countObservations(), beforeSplit + 1);
  await page.screenshot({ path: join(output, 'after-split.png') });
  check(true, 'real split panes mount compact/full views but accept exactly one observation for one input change');

  const other = await context.newPage();
  await other.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await expect(other.locator('.alu-tool')).toHaveCount(2);
  await expect(other.locator('.runtime-tool-full').getByRole('button', { name: '运行', exact: true })).toBeEnabled({timeout:60000});
  const beforeTabs = new Set((await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json())
    .entries.map(entry => entry.action.requestId));
  await Promise.all([page.locator('.runtime-tool-full').getByRole('button', { name: '运行', exact: true }).click(),
    other.locator('.runtime-tool-full').getByRole('button', { name: '运行', exact: true }).click()]);
  let tabRuns = [], conflictVisible = false, headState;
  await expect.poll(async () => {
    conflictVisible = /分歧|冲突|另一标签/.test(await page.locator('body').innerText())
      || /分歧|冲突|另一标签/.test(await other.locator('body').innerText());
    const history = await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json();
    tabRuns = history.entries.filter(entry => !beforeTabs.has(entry.action.requestId) && entry.action.execution.operation.operationId === 'run-single');
    const head = await (await context.request.get(`${endpoint}/api/learning/workspaces/${activity.activityId}`)).json();
    const stateFile = head.files?.find(file => file.kind === 'state');
    headState = stateFile && JSON.parse(stateFile.value).content;
    return conflictVisible || tabRuns.length === 2 && tabRuns.every(entry => entry.query.statusKnowledge === 'confirmed' && entry.query.state === 'succeeded')
      && tabRuns.some(entry => JSON.parse(headState?.enabledBasis ?? '{}').requestId === entry.action.requestId);
  }, {timeout:30000}).toBe(true);
  const bases = tabRuns.map(entry => JSON.parse(entry.action.execution.basis.works.find(file => file.kind === 'state').value).content.activationRevision).sort((a,b)=>a-b);
  const serialized = bases.length === 2 && bases[1] === bases[0] + 1 && headState?.activationRevision === bases[1] + 1;
  report.twoTabs = { requests:tabRuns.map(entry=>entry.action.requestId), bases, activationRevision:headState?.activationRevision,
    conflictVisible, resolution:serialized?'serialized-from-fresh-bases':'explicit-conflict' };
  check(serialized || conflictVisible, 'two real tabs preserve both run identities and either serialize from fresh activation bases or expose a conflict');
  await page.screenshot({ path: join(output, 'after-two-tabs.png') });
  await other.close();

  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack ?? error);
  if (page) {
    report.visibleText = await page.locator('body').innerText().catch(() => '');
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await runtime.stop().catch(() => {});
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
