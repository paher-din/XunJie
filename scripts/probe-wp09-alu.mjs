import { probeEvidenceDirectory, writeEvidence, captureEvidence } from './lib/probe-evidence.mjs';
// Formal product/Chrome + actual Icarus. The generated-package fixture is controlled;
// real supplier generation is covered by probe-wp09-real-models.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { aluPackage, aluCoursePackage } from '../components/alu-experiment/package.mjs';
import { aluCaseFromAction } from '@xunjie/contracts/alu-learning';

async function pageScript(componentKey) {
  const x = window.xunjie; let state = (await x.read()).content;
  const a = document.querySelector('[aria-label="页面 A"]'), f = document.querySelector('[aria-label="页面预测 F"]');
  const c = document.querySelector('[aria-label="页面预测 Cout"]'), r = document.querySelector('textarea');
  const status = document.querySelector('[role="status"]');
  a.value = state.A; f.value = state.predictedF; c.value = state.predictedCout; r.value = state.reason;
  const save = () => x.change(state);
  for (const [input, key] of [[a, 'A'], [f, 'predictedF'], [c, 'predictedCout'], [r, 'reason']]) input.oninput = () => {
    state = { ...state, [key]: key === 'A' ? Number(input.value) : input.value }; save().catch(() => {});
  };
  const parameters = () => ({ A: state.A, B: 1, M: 1, S: 0, Cin: 0 });
  const send = async (compare) => {
    const key = compare ? 'comparisonRequestId' : 'runRequestId';
    state = { ...state, [key]: state[key] || crypto.randomUUID() }; await save();
    await x.execution.submit({ requestId: state[key], componentKey, operationId: compare ? 'observe-enabled' : 'run-single', parameters: parameters(),
      ...(compare ? { enabledByRequestId: state.runRequestId, caseDraft: { formatVersion: 1, caseId: state.caseId, revisionId: state.caseRevision,
        purpose: 'boundary', predictedF: state.predictedF, predictedCout: state.predictedCout, reason: state.reason, helpReported: false, priorSources: [] } } : {}) });
    status.textContent = compare ? '比较已提交' : '运行已提交';
  };
  const fail = message => error => { status.textContent = message + '：' + error.message; };
  document.querySelector('#run').onclick = () => send(false).catch(fail('运行尚未确认'));
  document.querySelector('#compare').onclick = () => send(true).catch(fail('比较尚未确认'));
  document.querySelector('#newrun').onclick = () => { state = { ...state, runRequestId: crypto.randomUUID() }; send(false).catch(fail('运行尚未确认')); };
  document.querySelector('#query').onclick = async () => { await x.execution.query({ requestId: state.comparisonRequestId }); status.textContent = '原比较已核对'; };
}

const { values: args } = parseArgs({ options: {
  'output': { type: 'string' }, 'evidence-dir': { type: 'string' },  product: { type: 'string' }, out: { type: 'string' } } });
const out = probeEvidenceDirectory(args.out);
await mkdir(out, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'xj-wp09-alu-'));
const report = { status: 'running', platform: process.platform, node: process.version, cases: [],
  model: 'controlled package fixture; no model requests', product: args.product ? resolve(args.product) : 'workspace production build' };
let resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
  postgresVersion: '18.6', webRoot: resolve(process.env.XUNJIE_PRODUCT_WEB_ROOT ?? 'apps/web/dist-runtime'), windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') };
let module = await import('@xunjie/product-runtime');
if (args.product) {
  const product = resolve(args.product), declared = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
  resources = { ...declared };
  for (const field of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper'])
    if (declared[field]) resources[field] = resolve(product, declared[field]);
  module = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
}
const runtime = module.openProductRuntime({ root, resources });
let browser, page;
try {
  await runtime.install({ profile: 'local' });
  const { endpoint } = await runtime.start();
  const control = await module.resolveCredential(root, 'control');
  const manage = async (route, body) => {
    const response = await fetch(endpoint + '/api/learning/manage/' + route, { method: 'POST',
      headers: { authorization: 'Bearer ' + control, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, route); return response.json();
  };
  const component = await manage('component-import', await aluPackage()), course = await aluCoursePackage();
  course.release.components[0].definition = component;
  await manage('course-import', course);
  const password = randomUUID(), loginName = 'wp09-alu';
  const member = await manage('members', { requestId: randomUUID(), loginName, password });
  await manage('course-access', { requestId: randomUUID(), courseId: course.course.courseId, principalId: member.principalId, active: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    if (window !== parent) return;
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    window.wp09ResultConfirmations = [];
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(handler) {
      descriptor.set.call(this, typeof handler === 'function' ? function (event) {
        if (window.wp09HoldResultConfirmation && this.mode === 'readwrite' && this.objectStoreNames.contains('executionResults'))
          window.wp09ResultConfirmations.push(() => handler.call(this, event));
        else handler.call(this, event);
      } : handler);
    } });
  });
  const login = await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  assert.equal(login.status(), 200);
  const response = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId: course.release.releaseId } });
  assert.equal(response.status(), 200);
  const activity = await response.json(), binding = activity.course.components[0]; page = await context.newPage();
  const base = endpoint + '/api/learning/';
  const history = async () => (await context.request.get(base + 'executions/' + activity.activityId + '/history')).json();
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await expect(page.getByRole('button', { name: '运行', exact: true })).toBeEnabled({ timeout: 180000 });
  // Engineering fixture entered in the normal editor; never shipped as student starter or model output.
  const source = "// WP09 实验验收\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout);always_comb begin F=0;Cout=0;if(M)begin if(S==0){Cout,F}={1'b0,A}+{1'b0,B}+Cin;end else case(S)0:F=~A;1:F=A&B;2:F=A|B;3:F=A^B;endcase end endmodule";
  const editor = page.locator('.monaco-editor textarea').first();
  await editor.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(source);
  await page.getByRole('button', { name: '打开对话', exact: true }).click();
  const payload = {
    formatVersion: 1, title: 'ALU 预测比较', display: 'card', hostApiVersion: 1, stateVersion: 1,
    html: '<h2>ALU 教学示意与真实验证</h2><p>本页说明是教学示意；实际输出在宿主运行记录中查看。</p><label>A<input type="number" aria-label="页面 A" min="0" max="15"></label><label>预测 F<input aria-label="页面预测 F"></label><label>预测 Cout<input aria-label="页面预测 Cout"></label><label>理由<textarea aria-label="页面理由"></textarea></label><button id="run">运行页面输入</button><button id="compare">固定预测并比较</button><button id="query">核对原比较</button><button id="newrun">开始一次新运行</button><p role="status"></p>',
    css: 'body{padding:16px}label{display:block;margin-bottom:8px}input,textarea{margin-left:8px}button{margin:8px 8px 0 0}',
    javascript: `(${pageScript.toString()})(${JSON.stringify(binding.key)});`,
    stateShape: { type: 'object', properties: { A: { type: 'number' },
      ...Object.fromEntries(['predictedF', 'predictedCout', 'reason', 'runRequestId', 'comparisonRequestId', 'caseId', 'caseRevision'].map(key => [key, { type: 'string', maxLength: 4000 }])) } },
    initialState: { A: 15, predictedF: '', predictedCout: '', reason: '', runRequestId: '', comparisonRequestId: '', caseId: randomUUID(), caseRevision: randomUUID() },
    semanticFields: ['A', 'predictedF', 'predictedCout', 'reason', 'runRequestId', 'comparisonRequestId', 'caseId', 'caseRevision'].map(key => ({ key, meaning: 'ALU 页面 ' + key })),
    semanticObjects: [], requiredCapabilities: ['workspace.read', 'workspace.change', 'execution.submit', 'observations.read'],
  };
  const published = await context.request.post(base + 'artifacts/' + activity.activityId, { data: { requestId: randomUUID(), payload } });
  assert.equal(published.status(), 200); const receipt = await published.json();
  const card = page.locator(`[data-artifact-id="${receipt.artifactId}"]`).first(), frame = card.frameLocator('iframe');
  await expect(frame.getByRole('button', { name: '运行页面输入', exact: true })).toBeEnabled({ timeout: 30000 });
  assert.equal((await history()).entries.length, 0, 'checks and initial loading must not execute');
  report.cases.push('isolated check/adoption performs zero actual executions');
  await frame.getByRole('button', { name: '运行页面输入', exact: true }).click();
  await expect(frame.getByRole('status')).toHaveText('运行已提交', { timeout: 15000 });
  await expect.poll(async () => (await history()).entries.some(entry => entry.action.execution.operation.operationId === 'run-single'
    && entry.query.output?.output?.f === '0000' && entry.query.output?.output?.cout === '1'), { timeout: 90000 }).toBe(true);
  const run = (await history()).entries.find(entry => entry.action.execution.operation.operationId === 'run-single');
  report.cases.push('generated-page explicit run uses actual Icarus and preserves fixed work/parameters');
  await frame.getByRole('spinbutton', { name: '页面 A', exact: true }).fill('14');
  await frame.getByRole('textbox', { name: '页面预测 F', exact: true }).fill('1111');
  await frame.getByRole('textbox', { name: '页面预测 Cout', exact: true }).fill('0');
  await frame.getByRole('textbox', { name: '页面理由', exact: true }).fill('14 加 1 应仍在四位范围内；先固定预测，再查看结果。');
  let lostAcceptance = false;
  const acceptRoute = base + 'executions/' + activity.activityId;
  await context.route(acceptRoute, async route => {
    if (route.request().method() === 'POST' && !lostAcceptance
      && route.request().postDataJSON()?.action?.execution?.operation?.operationId === 'observe-enabled') {
      const accepted = await route.fetch(); assert.equal(accepted.status(), 200);
      lostAcceptance = true; await route.abort();
    } else await route.continue();
  });
  await frame.getByRole('button', { name: '固定预测并比较', exact: true }).click();
  await expect.poll(async () => (await history()).entries.some(entry => entry.action.execution.operation.operationId === 'observe-enabled'
    && entry.query.output?.output?.f === '1111' && entry.query.output?.output?.cout === '0'), { timeout: 90000 }).toBe(true);
  const comparison = (await history()).entries.find(entry => entry.action.execution.operation.operationId === 'observe-enabled');
  const capture = aluCaseFromAction(comparison.action);
  assert.ok(capture); assert.equal(capture.draft.predictedF, '1111'); assert.equal(capture.inputs.A, 14);
  assert.equal(comparison.action.execution.basis.enabledBy.requestId, run.query.requestId);
  assert.ok(comparison.action.execution.basis.works.some(file => file.name === 'components/artifact-' + receipt.artifactId + '.json'));
  assert.equal(capture.draft.helpReported, true, 'generated-page input must not attest an unaided prediction');
  assert.equal(lostAcceptance, true);
  await context.unroute(acceptRoute);
  await frame.getByRole('button', { name: '固定预测并比较', exact: true }).click();
  assert.equal((await history()).entries.filter(entry => entry.query.requestId === comparison.query.requestId).length, 1);
  report.cases.push('lost real execution acceptance re-queries/re-delivers the original action without a second execution');
  report.cases.push('comparison freezes actual page input and prediction on original successful code, with generated-page assistance provenance');
  await expect(card.getByText('F：1111　Cout：0', { exact: false })).toBeVisible();
  report.cases.push('host-owned result region distinguishes actual output from page teaching illustration');
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await page.getByRole('combobox', { name: '用例记录', exact: true }).selectOption(comparison.query.requestId);
  await expect(page.getByRole('table', { name: '预测与实际比较', exact: true })).toContainText('1111');
  await expect(page.getByRole('button', { name: '结果加入问题', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '结果加入问题', exact: true }).click();
  await expect.poll(async () => (await (await context.request.get(base + 'drafts/' + activity.activityId)).json()).references
    .some(reference => reference.source.requestId === comparison.query.requestId && reference.copy.includes('实际：F=1111，Cout=0'))).toBe(true);
  const reflection = '原预测与本次实际一致；这份解释在看过结果后记录，继续引用原作品和输入。';
  await page.getByRole('textbox', { name: '实验解释', exact: true }).fill(reflection);
  await page.getByRole('button', { name: '保存解释修订', exact: true }).click();
  await expect.poll(async () => (await (await context.request.get(base + 'workspaces/' + activity.activityId)).json()).files
    .some(file => file.mediaType === 'application/vnd.xunjie.alu-reflection+json' && JSON.parse(file.value).text === reflection
      && JSON.parse(file.value).requestId === comparison.query.requestId)).toBe(true);
  report.cases.push('generated-page results enter the existing ALU observation reference and immutable post-observation explanation owners');
  const count = (await history()).entries.length;
  await frame.getByRole('button', { name: '核对原比较', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: '打开对话', exact: true }).click();
  await expect(frame.getByRole('textbox', { name: '页面理由', exact: true })).toHaveValue(capture.draft.reason);
  await expect(card.getByText('F：1111　Cout：0', { exact: false })).toBeVisible();
  assert.equal((await history()).entries.length, count);
  report.cases.push('query/reload retains original results and student reason without rerun');
  // Delay only the genuine IndexedDB result transaction's acknowledgement after it commits.
  // The real WASM still runs; no generated bytes, database value or executor is replaced.
  await page.evaluate(() => { window.wp09HoldResultConfirmation = true; });
  await frame.getByRole('button', { name: '开始一次新运行', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.wp09ResultConfirmations.length), { timeout: 15000 }).toBeGreaterThan(0);
  const runningRecord = card.locator('[data-execution-request-id]').filter({ hasText: '正在执行' }).first();
  await expect(runningRecord).toBeVisible();
  const stoppingRequestId = await runningRecord.getAttribute('data-execution-request-id');
  assert.ok(stoppingRequestId);
  await card.getByRole('button', { name: '在工具区打开', exact: true }).click();
  await page.locator('.teaching-artifact-center').getByRole('button', { name: '关闭页面', exact: true }).click();
  await expect(card.locator(`[data-execution-request-id="${stoppingRequestId}"]`)).toContainText('正在执行');
  await card.locator(`[data-execution-request-id="${stoppingRequestId}"]`).getByRole('button', { name: '停止', exact: true }).click();
  await page.evaluate(() => { window.wp09HoldResultConfirmation = false; for (const resume of window.wp09ResultConfirmations.splice(0)) resume(); });
  await expect.poll(async () => (await history()).entries.find(entry => entry.query.requestId === stoppingRequestId)?.query.state,
    { timeout: 30000 }).toBe('cancelled');
  report.cases.push('closing the generated view preserves a real execution awaiting result confirmation; explicit host stop wins over its delayed result acknowledgement');
  report.identities = { activityId: activity.activityId, artifactId: receipt.artifactId, revisionId: receipt.revisionId,
    runRequestId: run.query.requestId, comparisonRequestId: comparison.query.requestId };
  await captureEvidence(page, { path: join(out, 'generated-page-comparison.png'), fullPage: true });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error instanceof assert.AssertionError ? 'acceptance-assertion' : error?.name ?? 'probe-failed';
  if (page) {
    await captureEvidence(page, { path: join(out, 'failure.png'), fullPage: true }).catch(() => {});
    report.visibleIssues = await page.locator('[role="alert"], .teaching-artifact-note').allTextContents().catch(() => []);
    report.frameStatuses = await Promise.all(page.frames().slice(1).map(frame => frame.locator('[role="status"], [role="alert"]').allTextContents().catch(() => [])));
  }
  throw error;
} finally {
  await browser?.close(); await runtime.stop(); await rm(root, { recursive: true, force: true });
  await writeEvidence(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
