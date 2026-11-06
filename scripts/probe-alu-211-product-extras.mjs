// #211 extra real-product checks: legacy stateVersion1 coexistence, tutor draft preservation,
// offline check retention + single sync, and Worker/WASM resource accounting.
// Real desktop Chrome + native PostgreSQL + packaged product; no teaching claim.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, freemem, loadavg, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { aluPackage, aluCoursePackage } from '../components/alu-experiment/package.mjs';

const output = resolve(process.env.XUNJIE_ALU_OUTPUT ?? '.verification/wp04-211/product-extras');
await mkdir(output, { recursive: true });
const packageRoot = resolve(process.env.XUNJIE_ALU_PRODUCT_ROOT ?? 'dist/product-darwin-arm64-wp04-211b');
const declared = JSON.parse(await readFile(join(packageRoot, 'resources.json'), 'utf8'));
const resources = { ...declared, nodePath: resolve(packageRoot, declared.nodePath),
  postgresBin: resolve(packageRoot, declared.postgresBin), webRoot: resolve(packageRoot, declared.webRoot) };
const bundled = await import(pathToFileURL(join(packageRoot, 'app/product-runtime.js')).href);
const root = await mkdtemp(join(tmpdir(), 'xj-alu-211-extras-'));
const runtime = bundled.openProductRuntime({ root, resources });
const report = { platform: process.platform, arch: process.arch, candidate: packageRoot, browser: '', cases: [], timings: {}, status: 'running' };
const check = (condition, message) => { assert.ok(condition, message); report.cases.push(message); };
const loadJson = async path => JSON.parse(await readFile(path, 'utf8'));
const readIdb = page => page.evaluate(async () => {
  const db = await new Promise((done, reject) => { const request = indexedDB.open('xunjie-reliable-works-v1');
    request.onsuccess = () => done(request.result); request.onerror = () => reject(request.error); });
  const rows = await new Promise(done => { const request = db.transaction('executionCommands').objectStore('executionCommands').getAll(); request.onsuccess = () => done(request.result); });
  db.close();
  return rows.map(row => ({ requestId: row.requestId ?? row.action?.requestId, operationId: row.action?.execution?.operation.operationId, state: row.state }));
});
let browser, page;
try {
  await runtime.install({ profile: 'local' });
  const { endpoint } = await runtime.start();
  const admin = { authorization: `Bearer ${await bundled.resolveCredential(root, 'control')}` };
  const api = async (route, body) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: 'POST', headers: { 'content-type': 'application/json', ...admin }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`); return value;
  };
  const component = await aluPackage(), course = await aluCoursePackage();
  const v2Definition = await api('manage/component-import', component);
  course.release.components[0].definition = v2Definition;
  await api('manage/course-import', course);
  report.cases.push('formal product imports the new stateVersion2 course');
  const password = randomUUID(), loginName = 'alu-211-extras';
  const member = await api('manage/members', { requestId: randomUUID(), loginName, password });
  await api('manage/course-access', { requestId: randomUUID(), courseId: course.course.courseId, principalId: member.principalId, active: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  assert.equal((await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
  const createActivity = async releaseId => {
    const created = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
    assert.equal(created.status(), 200); return created.json();
  };
  const activity = await createActivity(course.release.releaseId);
  page = await context.newPage();
  page.on('pageerror', error => console.log('PAGE ERROR ' + error.message));
  const observedWorkers = [], wasmResponses = [];
  const instrument = target => {
    target.on('worker', worker => observedWorkers.push(worker.url()));
    target.on('response', response => {
      const type = response.headers()['content-type'] ?? '';
      if (type.includes('wasm') || /\.wasm($|\?)/.test(response.url())) {
        wasmResponses.push({ url: response.url(), status: response.status(), contentLength: Number(response.headers()['content-length'] ?? 0), contentType: type });
      }
    });
  };
  instrument(page);
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 120000 });
  await expect(page.getByRole('button', { name: 'alu.sv', exact: true }).first()).toBeVisible({ timeout: 60000 });
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.getByRole('button', { name: '运行', exact: true })).toBeEnabled({ timeout: 120000 });
  await page.screenshot({ path: join(output, 'before-tutor.png') });

  // Open the real tutor pane and keep a Chinese question draft across run and check.
  await page.getByRole('button', { name: '打开对话', exact: true }).click();
  const draftText = '请解释固定映射下 A=15、B=1 时为什么会进位，先不要给完整实现。';
  const draft = page.getByLabel('你的问题');
  await draft.fill(draftText);
  await expect(draft).toHaveValue(draftText);
  await page.screenshot({ path: join(output, 'after-tutor-draft.png') });
  const draftSends = [];
  page.on('request', request => { const body = request.postData(); if (body?.includes(draftText)) draftSends.push({ url: request.url(), method: request.method() }); });
  const correct = `// correct ALU typed through the real editor\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); always_comb begin F=0; Cout=0; case({M,S}) 3'b000:F=~A; 3'b001:F=A&B; 3'b010:F=A|B; 3'b011:F=A^B; 3'b100:{Cout,F}={1'b0,A}+{1'b0,B}+Cin; default:begin F=0;Cout=0;end endcase end endmodule`;
  const replace = async text => {
    const editor = page.locator('.monaco-editor textarea').first();
    await editor.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(text);
  };
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  await replace(correct);
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByText(/已启用这次运行的作品/, { exact: false })).toBeVisible({ timeout: 120000 });
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(draft).toHaveValue(draftText);
  check(true, 'a tutor question draft survives work enablement without being cleared or sent');
  await page.getByRole('button', { name: /^(检查全部输入|再次检查)$/ }).click();
  await expect(page.getByText('4096 组检查通过', { exact: true })).toBeVisible({ timeout: 120000 });
  await expect(draft).toHaveValue(draftText);
  report.draftRequests = draftSends;
  assert.ok(draftSends.every(request => /\/api\/learning\/drafts\//.test(request.url)),
    'draft leaked outside its own draft store: ' + JSON.stringify(draftSends));
  await page.screenshot({ path: join(output, 'after-check-draft-preserved.png') });
  check(true, 'a full 4096-input check does not clear or send the tutor question draft (only its own draft store saves it)');

  // Retained resource accounting from the real service artifact.
  const history = await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json();
  const passCheck = history.entries.find(entry => entry.action.execution.operation.operationId === 'check-all' && entry.query.state === 'succeeded');
  const artifact = await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/${passCheck.query.requestId}/artifact`)).json();
  report.resources = { primary: passCheck.query.output.artifact.byteLength,
    extras: (artifact.resources ?? []).map(item => ({ name: item.name, byteLength: item.byteLength })),
    total: passCheck.query.output.artifact.byteLength + (artifact.resources ?? []).reduce((sum, item) => sum + item.byteLength, 0) };

  // An offline check still returns its local result; reconnect syncs the same request once, never reruns.
  const beforeHistory = (await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json()).entries.filter(entry => entry.action.execution.operation.operationId === 'check-all').length;
  await context.route('**/api/learning/**', route => route.abort());
  await page.getByRole('button', { name: '再次检查', exact: true }).click();
  await expect(page.getByText('已提交全量检查；完成前不会显示通过。')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(6000);
  await expect(page.getByText('4096 组检查通过', { exact: true })).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: join(output, 'after-offline-check.png') });
  check(true, 'a check still completes from local execution while the application API is unavailable');
  await context.unroute('**/api/learning/**');
  await expect.poll(async () => {
    const rows = (await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json()).entries;
    return rows.filter(entry => entry.action.execution.operation.operationId === 'check-all').length;
  }, { timeout: 60000 }).toBe(beforeHistory + 1);
  const afterReconnect = (await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json()).entries.filter(entry => entry.action.execution.operation.operationId === 'check-all');
  const reloadCheckCount = afterReconnect.length;
  await page.waitForTimeout(4000);
  const stableChecks = (await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json()).entries.filter(entry => entry.action.execution.operation.operationId === 'check-all').length;
  assert.equal(stableChecks, reloadCheckCount, 'offline check synced more than once');
  await page.reload();
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.getByText('4096 组检查通过', { exact: true })).toBeVisible({ timeout: 60000 });
  await page.waitForTimeout(1200);
  const afterReloadChecks = (await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json()).entries.filter(entry => entry.action.execution.operation.operationId === 'check-all').length;
  assert.equal(afterReloadChecks, reloadCheckCount, 'old check auto-reran after reload');
  check(true, 'reconnect syncs exactly one offline check and reload does not rerun the old check');

  // Worker/WASM resource evidence from the browser process itself.
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  const largeResources = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(entry => entry.encodedBodySize > 100000 || /\.wasm($|\?)/.test(entry.name))
    .map(entry => ({ name: entry.name, initiatorType: entry.initiatorType, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize })));
  const memory = await page.evaluate(() => performance.memory ? ({ usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit }) : null);
  const cdp = await context.newCDPSession(page);
  const targets = await cdp.send('Target.getTargets');
  const liveWorkers = targets.targetInfos.filter(target => target.type === 'worker' || target.type === 'service_worker').map(target => ({ type: target.type, url: target.url }));
  report.runtime = { wasmResponses, observedWorkers, largeResources, memory, liveWorkers,
    hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
    device: { cpu: cpus()[0]?.model, cores: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), loadAverage: loadavg(), platform: process.platform, arch: process.arch } };
  check(observedWorkers.length > 0 && (wasmResponses.length > 0 || largeResources.length > 0),
    'browser records the live Worker and the loaded WASM resource sizes for resource accounting');

  // Archived stateVersion1 activity in its own product instance: five selects, single run, real F/Cout.
  const legacyRoot = await mkdtemp(join(tmpdir(), 'xj-alu-211-legacy-'));
  const legacyRuntime = bundled.openProductRuntime({ root: legacyRoot, resources });
  let legacyBrowser;
  try {
    await legacyRuntime.install({ profile: 'local' });
    const legacyEndpoint = (await legacyRuntime.start()).endpoint;
    const legacyAdmin = { authorization: `Bearer ${await bundled.resolveCredential(legacyRoot, 'control')}` };
    const legacyApi = async (route, body) => {
      const response = await fetch(new URL('/api/learning/' + route, legacyEndpoint), { method: 'POST', headers: { 'content-type': 'application/json', ...legacyAdmin }, body: JSON.stringify(body) });
      const value = await response.json(); assert.equal(response.status, 200, `legacy ${route}: ${JSON.stringify(value)}`); return value;
    };
    const legacyComponent = await loadJson('.verification/wp04-211/legacy-component.json');
    const legacyCourse = await loadJson('.verification/wp04-211/legacy-course.json');
    const v1Definition = await legacyApi('manage/component-import', legacyComponent);
    legacyCourse.release.components[0].definition = v1Definition;
    await legacyApi('manage/course-import', legacyCourse);
    const legacyMember = await legacyApi('manage/members', { requestId: randomUUID(), loginName, password });
    await legacyApi('manage/course-access', { requestId: randomUUID(), courseId: legacyCourse.course.courseId, principalId: legacyMember.principalId, active: true });
    legacyBrowser = await chromium.launch({ channel: 'chrome', headless: true });
    const legacyContext = await legacyBrowser.newContext({ viewport: { width: 1440, height: 1000 } });
    assert.equal((await legacyContext.request.post(legacyEndpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
    const legacyCreated = await legacyContext.request.post(legacyEndpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId: legacyCourse.release.releaseId } });
    assert.equal(legacyCreated.status(), 200);
    const legacyActivity = await legacyCreated.json();
    const legacyPage = await legacyContext.newPage();
    legacyPage.on('pageerror', error => console.log('LEGACY PAGE ERROR ' + error.message));
    await legacyPage.goto(legacyEndpoint + '?space=school&activity=' + legacyActivity.activityId);
    await expect(legacyPage.locator('.monaco-editor').first()).toBeVisible({ timeout: 120000 });
    await legacyPage.getByRole('tab', { name: '作品', exact: true }).click();
    const legacyEditor = legacyPage.locator('.monaco-editor textarea').first();
    await legacyEditor.focus(); await legacyPage.keyboard.press('ControlOrMeta+A'); await legacyPage.keyboard.insertText(correct);
    await legacyPage.waitForTimeout(1500);
    await legacyPage.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
    await expect(legacyPage.locator('.execution-panel.runtime-tool select')).toHaveCount(5, { timeout: 120000 });
    await expect(legacyPage.getByRole('button', { name: '运行', exact: true })).toBeEnabled({ timeout: 120000 });
    await legacyPage.getByLabel('A（4 位）').selectOption('15');
    await legacyPage.getByLabel('B（4 位）').selectOption('1');
    await legacyPage.getByLabel('M（1 位）').selectOption('1');
    await legacyPage.getByLabel('S（2 位）').selectOption('0');
    await legacyPage.getByLabel('Cin（1 位）').selectOption('0');
    await legacyPage.getByRole('button', { name: '运行', exact: true }).click();
    await expect(legacyPage.getByText(/F：0000/)).toBeVisible({ timeout: 60000 });
    await expect(legacyPage.getByText(/Cout：1/)).toBeVisible();
    await legacyPage.screenshot({ path: join(output, 'legacy-stateversion1-run.png') });
    check(true, 'archived stateVersion1 course renders its five-select single-run form and produces real F=0000/Cout=1');
  } finally { await legacyBrowser?.close().catch(() => {}); await legacyRuntime.stop().catch(() => {}); }

  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack ?? error);
  if (page) { report.visibleText = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
  throw error;
} finally {
  await browser?.close();
  await runtime.stop().catch(() => {});
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
