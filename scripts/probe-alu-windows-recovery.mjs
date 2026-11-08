import { probeEvidenceDirectory, writeEvidence, captureEvidence, mkdtemp } from './lib/probe-evidence.mjs';
// Windows acceptance for the #192 clauses the product probe does not reach:
//   * Chinese text through Chrome's composition event pipeline (not synthetic insertText),
//   * a question draft that survives a run unchanged,
//   * a started-but-unheld run that a reload reports as unknown instead of rerunning,
//   * fixed-release text materials and the component entry read from the local cache after a reload.
//
// Composition is driven with CDP `Input.imeSetComposition`, which makes Chrome commit through its
// real composition path. It does NOT open the operating system's candidate window: that window is
// drawn by the OS input method, and this probe deliberately does not change the machine's input
// settings to obtain it. The report says so rather than implying the candidate window was observed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { aluPackage, aluCoursePackage } from '../components/alu-experiment/package.mjs';

const output = probeEvidenceDirectory(process.env.XUNJIE_ALU_OUTPUT);
await mkdir(output, { recursive: true });
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Native PostgreSQL required (set XUNJIE_PRODUCT_POSTGRES_BIN).');
const root = await mkdtemp(join(tmpdir(), 'xj-alu-recovery-'));
const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
  postgresVersion: '18.6', webRoot: resolve('apps/web/dist-runtime'), windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') } });
const report = { ticket: '#192', platform: process.platform, arch: process.arch, node: process.version, root,
  compositionDriver: 'CDP Input.imeSetComposition', osCandidateWindow: 'not exercised', cases: [], status: 'running' };
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };
let browser;
try {
  await runtime.install({ profile: 'local' });
  const { endpoint } = await runtime.start();
  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const api = async (route, body) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', ...admin }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`);
    return value;
  };
  const component = await aluPackage(), course = await aluCoursePackage();
  course.release.components[0].definition = await api('manage/component-import', component);
  await api('manage/course-import', course);
  const password = randomUUID(), loginName = 'alu-recovery';
  const member = await api('manage/members', { requestId: randomUUID(), loginName, password });
  await api('manage/course-access', { requestId: randomUUID(), courseId: course.course.courseId,
    principalId: member.principalId, active: true });

  browser = await chromium.launch({ channel: 'chrome', headless: false });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  assert.equal((await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities',
    { data: { requestId: randomUUID(), releaseId: course.release.releaseId } });
  assert.equal(created.status(), 200);
  const activity = (await created.json()).activityId;

  const page = await context.newPage();
  page.on('pageerror', error => console.log('PAGE ERROR ' + error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    console.log('BROWSER ' + message.text().slice(0, 300));
    report.consoleErrors = [...(report.consoleErrors ?? []), message.text().slice(0, 300)];
  });
  const materialRequests = [], refused = [];
  page.on('request', request => { if (request.url().includes('/materials/')) materialRequests.push(new URL(request.url()).pathname); });
  page.on('response', response => { if (response.status() >= 400) refused.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  const open = async () => {
    await page.goto(endpoint + '?space=school&activity=' + activity);
    await expect(page.locator('#activity-title')).toHaveText(course.task.title);
  };
  await open();
  await expect(page.getByRole('button', { name: '运行', exact: true })).toBeEnabled({ timeout: 180000 });
  passed('the fixed ALU course opens with its runtime prepared');

  // --- Chinese composition through Chrome's own composition pipeline --------------------------
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  const editor = page.locator('.monaco-editor textarea').first();
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText("module alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); always_comb begin F=0; Cout=0; if(M) begin if(S==0) {Cout,F}={1'b0,A}+{1'b0,B}+Cin; end else case(S) 0:F=~A; 1:F=A&B; 2:F=A|B; 3:F=A^B; endcase end endmodule\n");
  // Compose into a trailing comment line so the committed Chinese is real source the run compiles.
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n// ');
  const cdp = await context.newCDPSession(page);
  await page.evaluate(() => {
    window.__composition = [];
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'keydown'])
      document.addEventListener(type, event => window.__composition.push({ type, trusted: event.isTrusted,
        data: event.data ?? null, composing: event.isComposing ?? false }), true);
  });
  const runButton = page.getByRole('button', { name: '运行', exact: true });
  const runsBefore = await page.locator('.execution-records > li').count();
  // A live composition shows in the editor but must never start a run on its own.
  await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
  await expect(page.locator('.monaco-editor')).toContainText('zhongwen');
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.execution-records > li').count(), runsBefore,
    'a live composition must not start a run');
  passed('a live Chinese composition edits the work without starting a run');

  await cdp.send('Input.insertText', { text: '中文组合校验' });
  await cdp.send('Input.imeSetComposition', { text: 'zhengque', selectionStart: 7, selectionEnd: 7 });
  await cdp.send('Input.insertText', { text: '正确' });
  await expect(page.locator('.monaco-editor')).toContainText('中文组合校验正确');
  await expect(page.locator('.monaco-editor')).not.toContainText('zhongwen');
  await expect(page.locator('.monaco-editor')).not.toContainText('zhengque');
  const events = await page.evaluate(() => window.__composition);
  report.composition = { events };
  const ends = events.filter(event => event.type === 'compositionend');
  assert.ok(events.some(event => event.type === 'compositionstart' && event.trusted), 'composition must start as a trusted browser event');
  assert.ok(events.some(event => event.type === 'input' && event.composing && event.trusted), 'composed text must arrive as trusted composing input');
  assert.ok(ends.some(event => event.data === '中文组合校验'), 'the committed Chinese word must finish through compositionend');
  passed('Chrome commits Chinese through its composition pipeline and leaves no pinyin in the editor');

  await page.getByLabel('A（4 位）').selectOption('15');
  await page.getByLabel('B（4 位）').selectOption('1');
  await page.getByLabel('M（1 位）').selectOption('1');
  await runButton.click();
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.getByText('F：0000　Cout：1', { exact: false })).toBeVisible({ timeout: 90000 });
  passed('the composed Chinese source compiles and produces the real carry observation');

  // --- The question draft is neither sent nor cleared by a run -------------------------------
  await page.getByRole('button', { name: /询问 Agent|打开对话/ }).click();
  const question = page.getByRole('region', { name: 'Agent 问题草稿' }).locator('textarea');
  await question.fill('为什么保留组合要归零？');
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  await runButton.click();
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.locator('.execution-records > li')).toHaveCount(runsBefore + 2, { timeout: 90000 });
  // The discussion pane is still open: a run must not have touched the draft in it.
  await expect(question).toHaveValue('为什么保留组合要归零？');
  // The same text is also protected and synchronized; the run never rewrites it there either.
  await expect.poll(async () => (await (await context.request.get(`${endpoint}/api/learning/drafts/${activity}`)).json()).question,
    { timeout: 30000 }).toBe('为什么保留组合要归零？');
  report.draftAfterRun = (await (await context.request.get(`${endpoint}/api/learning/drafts/${activity}`)).json()).question;
  passed('a run neither sends nor clears the original question draft');

  // --- A started run the reloaded page does not hold becomes unknown, never a rerun -----------
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+A');
  // A zero-time loop keeps the Worker busy so the reload really interrupts an unfinished run.
  await page.keyboard.insertText("module alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); initial begin F=0; Cout=0; forever #0 F=~F; end endmodule");
  await runButton.click();
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.getByText('正在执行', { exact: false }).first()).toBeVisible({ timeout: 30000 });
  // The durable local ledger is what a reload must not extend: a run already started keeps its
  // owner, and the reloaded page is allowed to reconcile it, never to mint or restart one. The
  // service history is sampled separately because a late acceptance may still arrive there.
  const commandKeys = () => page.evaluate(() => new Promise((done, reject) => {
    const request = indexedDB.open('xunjie-reliable-works-v1', 7);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('executionCommands', 'readonly');
      const all = tx.objectStore('executionCommands').getAllKeys();
      all.onsuccess = () => { db.close(); done(all.result.map(String)); };
      all.onerror = () => reject(all.error);
    };
  }));
  const keysBefore = await commandKeys();
  await page.reload();
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.getByText('状态待核实', { exact: false }).first()).toBeVisible({ timeout: 60000 });
  // Time for an automatic rerun to show up if one were attempted.
  await page.waitForTimeout(4000);
  const keysAfter = await commandKeys();
  assert.deepEqual(keysAfter.filter(key => !keysBefore.includes(key)), [],
    'a reload must not accept a second run for the same activity');
  const historyAfter = (await (await context.request.get(`${endpoint}/api/learning/executions/${activity}/history`)).json()).entries;
  report.unknown = { commandsBefore: keysBefore.length, commandsAfter: keysAfter.length,
    historyEntries: historyAfter.length, label: await page.getByText('状态待核实', { exact: false }).first().innerText(),
    labels: historyAfter.map(entry => `${entry.query.state}/${entry.query.statusKnowledge}`) };
  passed('a reload reports the unheld run as unknown and never reruns it');

  // --- Fixed-release text and the component entry come from the local cache on reopen --------
  // The first open had to fetch them; the assertion below only means something because of this.
  assert.ok(materialRequests.length > 0, 'the first open must have read the materials over the service');
  report.firstOpenMaterialRequests = [...materialRequests];
  materialRequests.length = 0;
  await open();
  await expect(page.getByText('保留组合需要确定归零', { exact: false })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: '运行', exact: true })).toBeEnabled({ timeout: 120000 });
  assert.deepEqual(materialRequests, [], `a reopened fixed release must not refetch text materials, saw ${materialRequests.join(', ')}`);
  report.materialRequests = materialRequests;
  report.refused = refused;
  console.log('REFUSED ' + JSON.stringify(refused));
  passed('a reopened activity reads its fixed text materials and runtime entry from the local cache');
  report.status = 'passed';
  await captureEvidence(page, { path: join(output, 'recovery.png') });
} catch (error) {
  report.status = 'failed';
  report.error = String(error?.stack ?? error);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await runtime.stop().catch(() => undefined);
  await writeEvidence(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error ?? null }));
}
