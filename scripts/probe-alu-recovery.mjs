#!/usr/bin/env node
// #195 actual ALU backup -> isolated read -> takeover. Run on each physical client/path.
// Acquire the shared physical-desktop lock before invoking this headed Chrome probe.
// --host-config=FILE selects a local public product driver; --remote=FILE selects SSH maintenance
// {sshArgs:[...],command:"... alu-recovery-host.mjs PRIVATE_CONFIG"}. HTTPS student traffic is direct.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces, release } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { openAluRecoveryHost } from './alu-recovery-host.mjs';

const { values } = parseArgs({ options: { 'host-config': { type: 'string' }, remote: { type: 'string' },
  output: { type: 'string' }, label: { type: 'string' } } });
assert.ok(Boolean(values['host-config']) !== Boolean(values.remote), 'select local host config or remote maintenance');
const output = resolve(values.output); await mkdir(output, { recursive: true });
const remote = values.remote && JSON.parse(await readFile(values.remote, 'utf8'));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const invoke = remote ? async (operation, input) => new Promise((done, reject) => {
  const child = spawn('ssh', [...remote.sshArgs, remote.command + ' ' + quote(operation)],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 300000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('error', reject); child.on('close', code => {
    if (code !== 0) reject(new Error(`school maintenance ${operation} failed (${code}): ${stderr.slice(0, 500)}`));
    else { try { done(JSON.parse(stdout)); } catch { reject(new Error('invalid maintenance response')); } }
  });
  child.stdin.on('error', reject); child.stdin.end(JSON.stringify(input));
}) : await openAluRecoveryHost(values['host-config']);
const invocationId = randomUUID();
const driver = operation => invoke(operation, { probeId: invocationId });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const CORRECT = `// #195 recovery acceptance fixture; never student starter code
module alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout);
always_comb begin F=0; Cout=0; case({M,S})
3'b000:F=~A; 3'b001:F=A&B; 3'b010:F=A|B; 3'b011:F=A^B;
3'b100:{Cout,F}={1'b0,A}+{1'b0,B}+Cin;
default:begin F=0; Cout=0;end endcase end endmodule\n`;
const QUESTION = '请结合原用例、波形和我的解释讨论进位；保留草稿，不发送。';
const EXPLANATION = '原输入 15 加 1 的低四位归零，第五位保留在 Cout。';
const REVISION = EXPLANATION + ' 修订：逻辑操作的进位还应清零。';
const report = { ticket: 195, label: values.label, platform: process.platform, arch: process.arch, os: release(),
  node: process.version, mode: remote ? 'independent-school-https' : 'local-product', headed: true,
  startedAt: new Date().toISOString(), status: 'running', cases: [], evidence: [], teachingEffect: 'not-evaluated' };
let browser, page, context, setup, activity, before, targetEndpoint, originalPage, originalContext, sourceState;
const errors = [], workers = [], writes = [];
const isolatedWorkers = [];
let recordingIsolationWorkers = false;
const releaseGates = [];
const routeHandlers = new Set();
const trackRoute = handler => async route => {
  let finish; const settled = new Promise(resolve => { finish = resolve; }); routeHandlers.add(settled);
  try { await handler(route); } finally { finish(); routeHandlers.delete(settled); }
};
let recordingIsolation = false;
const pass = (name, detail = {}) => { report.cases.push({ name, ...detail }); console.log('PASS ' + name); };
const tool = () => page.locator('.runtime-tool-full');
const button = name => tool().getByRole('button', { name, exact: true });
const tab = name => page.getByRole('tab', { name, exact: true }).click();
async function snapshot(name, value) {
  const path = name + '.json'; await writeFile(join(output, path), JSON.stringify(value, null, 2) + '\n');
  report.evidence.push({ path, sha256: hash(await readFile(join(output, path))) });
}
async function capture(name) { await page.screenshot({ path: join(output, name + '.png'), fullPage: true }); report.evidence.push({ path: name + '.png' }); }
async function api(route, body, endpoint = new URL(page.url()).origin, headers = {}) {
  const response = await context.request.fetch(endpoint + '/api/learning/' + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-xj-space': 'school', ...headers },
    ...(body === undefined ? {} : { data: body }) });
  assert.equal(response.status(), 200, route + ': ' + await response.text()); return response.json();
}
async function history() {
  const entries = []; let cursor;
  do { const next = await api(`executions/${activity.activityId}/history${cursor ? '/' + cursor : ''}`);
    entries.push(...next.entries); cursor = next.nextCursor; } while (cursor);
  return entries;
}
async function workspace() { return api('workspaces/' + activity.activityId); }
async function currentState() {
  const view = await workspace(); const file = view.files.find(item => item.name === 'components/alu.json');
  return file ? JSON.parse(file.value).content : {};
}
async function waitFor(name, read, predicate, timeout = 180000) {
  let last; await expect.poll(async () => { last = await read(); return Boolean(predicate(last)); },
    { message: name, timeout, intervals: [200, 400, 750, 1000] }).toBe(true); return last;
}
async function editCode(code) {
  if (await page.getByRole('button', { name: '收起对话', exact: true }).isVisible())
    await page.getByRole('button', { name: '收起对话', exact: true }).click();
  await tab('作品'); const editor = page.locator('.monaco-editor textarea').first();
  await editor.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(code);
  await waitFor('code is received by its owner', workspace, view => view.files.some(file => file.name === 'alu.sv' && file.value === code));
  await tab('ALU 实验');
}
async function run(operation, click) {
  const ids = new Set((await history()).map(item => item.query.requestId));
  await click();
  const started = await waitFor('one original command is accepted', history,
    entries => entries.some(item => !ids.has(item.query.requestId) && item.action.execution.operation.operationId === operation));
  const added = started.filter(item => !ids.has(item.query.requestId) && item.action.execution.operation.operationId === operation);
  assert.equal(added.length, 1);
  const result = await waitFor('original operation and resources settle', history, entries => {
    const record = entries.find(item => item.query.requestId === added[0].query.requestId);
    return record?.query.state === 'succeeded' && record.query.statusKnowledge === 'confirmed' && record.query.output;
  });
  const record = result.find(item => item.query.requestId === added[0].query.requestId);
  await waitFor('original result upload is readable', () => api(`executions/${activity.activityId}/${record.query.requestId}/artifact`), value => !!value?.text);
  return record;
}
async function collect({ runtime = true } = {}) {
  const records = await history(), artifacts = [];
  for (const record of records) if (record.query.output) {
    const artifact = await api(`executions/${activity.activityId}/${record.query.requestId}/artifact`);
    assert.equal(hash(artifact.text), record.query.output.artifact.sha256);
    assert.equal(Buffer.byteLength(artifact.text), record.query.output.artifact.byteLength);
    for (const resource of artifact.resources ?? []) {
      assert.equal(hash(resource.text), resource.sha256); assert.equal(Buffer.byteLength(resource.text), resource.byteLength);
    }
    artifacts.push(artifact);
  }
  const materials = [], runtimeResources = [];
  assert.ok(activity.course.materials.length > 0, 'the fixed release must contain readable student materials');
  assert.deepEqual(activity.course.materials.map(({ materialId, sha256, byteLength }) => ({ materialId, sha256, byteLength }))
    .sort((a, b) => a.materialId.localeCompare(b.materialId)),
  [...setup.expected.materials].sort((a, b) => a.materialId.localeCompare(b.materialId)), 'every imported student material is retained');
  for (const material of activity.course.materials) {
    const content = await api(`releases/${activity.course.releaseId}/materials/${material.materialId}`);
    const bytes = Buffer.from(content.contentBase64, 'base64');
    assert.equal(content.materialId, material.materialId);
    assert.equal(hash(bytes), material.sha256); assert.equal(bytes.length, material.byteLength);
    materials.push(content);
  }
  const binding = activity.course.components[0], manifest = binding.definition.manifest;
  assert.deepEqual(manifest, setup.expected.componentManifest, 'the activity pins the exact imported component');
  assert.ok(manifest.runtime.resources.length > 0, 'the fixed component must retain runtime resources');
  const componentEntry = runtime ? await api(`releases/${activity.course.releaseId}/components/${binding.key}`) : null;
  if (runtime) {
    assert.ok(componentEntry, 'the fixed component entry must be readable');
    assert.deepEqual(componentEntry.definition, binding.definition);
    const bytes = Buffer.from(componentEntry.contentBase64, 'base64');
    assert.equal(hash(bytes), manifest.entry.sha256); assert.equal(bytes.length, manifest.entry.byteLength);
  }
  for (const resource of runtime ? manifest.runtime.resources : []) {
    const content = await api(`releases/${activity.course.releaseId}/components/${binding.key}/resources/${resource.path}`);
    assert.equal(hash(Buffer.from(content.contentBase64, 'base64')), resource.sha256);
    runtimeResources.push(content);
  }
  return { activity: await api('activities/' + activity.activityId), workspace: await workspace(),
    draft: await api('drafts/' + activity.activityId), records, artifacts, materials, componentEntry, runtimeResources };
}
function watch(target) {
  target.on('pageerror', error => errors.push(error.message));
  target.on('worker', worker => { workers.push(worker.url()); if (recordingIsolationWorkers) isolatedWorkers.push(worker.url()); });
  target.on('request', request => { if (recordingIsolation && request.method() !== 'GET')
    writes.push({ method: request.method(), path: new URL(request.url()).pathname }); });
}
async function login(endpoint) { await api('login', { loginName: setup.loginName, password: setup.password }, endpoint); }
try {
  setup = await driver('setup');
  report.installation = { platform: setup.platform, arch: setup.arch, node: setup.node, postgresVersion: setup.postgresVersion,
    environment: setup.environment, distributionSha256: setup.distributionSha256, endpoint: setup.endpoint };
  if (remote) {
    const host = new URL(setup.endpoint).hostname;
    const addresses = Object.values(networkInterfaces()).flat().filter(Boolean).map(item => item.address);
    assert.equal(new URL(setup.endpoint).protocol, 'https:');
    assert.ok(!addresses.includes(host) && !/^(localhost|127\.)/.test(host));
  }
  browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      ...(setup.spki ? [`--ignore-certificate-errors-spki-list=${setup.spki}`] : [])] });
  report.chrome = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, ignoreHTTPSErrors: false });
  page = await context.newPage(); watch(page); await page.goto(setup.endpoint); await login(setup.endpoint);
  sourceState = await api('context');
  activity = await api('course-activities', { requestId: randomUUID(), releaseId: setup.releaseId });
  await page.goto(setup.endpoint + '/?space=school&activity=' + activity.activityId);
  await expect(page.locator('#activity-title')).toHaveText(activity.course.taskTitle);
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 180000 });
  await expect(page.getByRole('button', { name: 'alu.sv', exact: true }).first()).toBeVisible();
  await waitFor('the original starter work is received before switching tools', workspace,
    view => view.files.some(file => file.name === 'alu.sv' && file.kind === 'code'));
  await tab('ALU 实验'); await expect(button('运行')).toBeEnabled({ timeout: 300000 });
  pass('formal client opens the fixed ALU release with real preparation', { activityId: activity.activityId });
  await editCode('module alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); initial begin F=0; Cout=0; forever #0 F=~F; end endmodule');
  let releaseTerminal;
  const terminalGate = new Promise(resolve => { releaseTerminal = resolve; });
  releaseGates.push(releaseTerminal);
  let releaseAcceptance;
  const acceptanceGate = new Promise(resolve => { releaseAcceptance = resolve; });
  releaseGates.push(releaseAcceptance);
  let acceptanceLostAtBoundary = false;
  const holdAcceptance = trackRoute(async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 200);
    await acceptanceGate; acceptanceLostAtBoundary = true; await route.abort('connectionreset');
  });
  const holdTerminal = trackRoute(async route => {
    if (['succeeded', 'failed', 'cancelled'].includes(route.request().postDataJSON()?.state)) await terminalGate;
    await route.continue();
  });
  await page.route('**/api/learning/executions/**/report', holdTerminal);
  await page.route('**/api/learning/executions/' + activity.activityId, holdAcceptance);
  await button('运行').click();
  const running = await waitFor('the service has the original unconfirmed browser command', history, entries =>
    entries.some(item => !['succeeded', 'failed', 'cancelled'].includes(item.query.state)));
  const live = running.find(item => !['succeeded', 'failed', 'cancelled'].includes(item.query.state));
  const blocked = await driver('blocked-backup'); assert.equal(blocked.completeBackups, 0);
  await snapshot('live-worker-blocks-backup', blocked);
  assert.equal((await context.request.post(setup.endpoint + '/api/learning/executions/' + activity.activityId, { data: {} })).status(), 503);
  releaseAcceptance(); releaseTerminal();
  await waitFor('the original Worker confirms termination', () => api(`executions/${activity.activityId}/${live.query.requestId}`), item =>
    item?.statusKnowledge === 'confirmed' && ['cancelled', 'failed'].includes(item.state));
  await Promise.all([...routeHandlers]);
  await page.unroute('**/api/learning/executions/**/report', holdTerminal);
  await page.unroute('**/api/learning/executions/' + activity.activityId, holdAcceptance);
  assert.equal(acceptanceLostAtBoundary, true);
  await driver('resume-source');
  pass('lost acceptance during maintenance reconciles the original identity and confirms its boundary without another execution', { requestId: live.query.requestId });
  await editCode(CORRECT);
  const enabled = await run('run-single', () => button('运行').click());
  await waitFor('original work is enabled', currentState, state => JSON.parse(state.enabledBasis || '{}').requestId === enabled.query.requestId);
  await button('新用例').click();
  for (const [label, value] of [['A（无符号 4 位）', 15], ['B（无符号 4 位）', 1], ['M（模式，0/1）', 1], ['S（操作选择，0–3）', 0], ['Cin（进位输入，0/1）', 0]]) {
    const field = tool().locator('.alu-numeric-field').filter({ hasText: label }).locator('input');
    await field.fill(String(value)); await field.press('Tab');
  }
  await tool().getByLabel('用例目的', { exact: true }).selectOption('boundary');
  await tool().getByLabel('预测 F', { exact: true }).fill('0000'); await tool().getByLabel('预测 Cout', { exact: true }).fill('1');
  await tool().getByLabel('选择这组输入的理由', { exact: true }).fill('检查 15 加 1 的进位边界。');
  await button('用例加入问题').click();
  await page.getByLabel('你的问题', { exact: true }).fill(QUESTION);
  const receivedBeforeLoss = new Set((await history()).map(item => item.query.requestId));
  const lost = { acceptance: false, result: false };
  const lossRoute = trackRoute(async route => {
    const path = new URL(route.request().url()).pathname;
    const kind = path === '/api/learning/executions/' + activity.activityId ? 'acceptance' : path.endsWith('/result') ? 'result' : null;
    if (route.request().method() !== 'POST' || !kind || lost[kind]) return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 200);
    lost[kind] = true; await route.abort('connectionreset');
  });
  await page.route('**/api/learning/executions/**', lossRoute);
  const compared = await run('observe-enabled', () => button('运行并比较').click());
  await Promise.all([...routeHandlers]); await page.unroute('**/api/learning/executions/**', lossRoute);
  assert.deepEqual(lost, { acceptance: true, result: true });
  assert.deepEqual((await history()).filter(item => !receivedBeforeLoss.has(item.query.requestId))
    .map(item => item.query.requestId), [compared.query.requestId], 'lost confirmations cannot create a second command identity');
  pass('lost acceptance and retention confirmations reconcile the original request without another observation', lost);
  assert.equal(compared.query.output.output.f, '0000'); assert.equal(compared.query.output.output.cout, '1');
  await button('结果加入问题').click();
  const explanation = tool().getByLabel('实验解释', { exact: true });
  await explanation.fill(EXPLANATION); await button('保存解释修订').click();
  let view = await waitFor('first explanation retained', workspace, view => view.files.some(file =>
    file.mediaType === 'application/vnd.xunjie.alu-reflection+json' && JSON.parse(file.value).text === EXPLANATION));
  const firstNote = view.files.find(file => file.mediaType === 'application/vnd.xunjie.alu-reflection+json');
  const firstView = tool().locator('.alu-reflection').filter({ hasText: EXPLANATION });
  await firstView.getByRole('button', { name: '解释加入问题', exact: true }).click();
  await firstView.getByRole('button', { name: '在此基础上修订', exact: true }).click();
  await explanation.fill(REVISION); await button('保存解释修订').click();
  view = await waitFor('both immutable explanations retained', workspace, view => view.files.filter(file => file.mediaType === 'application/vnd.xunjie.alu-reflection+json').length === 2);
  assert.ok(view.files.some(file => file.mediaType === 'application/vnd.xunjie.alu-reflection+json'
    && JSON.parse(file.value).parentNoteId === firstNote.contentId));
  const wave = tool().getByRole('region', { name: '实验波形', exact: true });
  await expect(wave).toBeVisible();
  const checkbox = wave.getByRole('checkbox').first();
  if (!await checkbox.isVisible()) await wave.locator('.alu-waveform__signals > summary').click();
  await checkbox.check(); await wave.getByLabel('起始 tick', { exact: true }).fill('0');
  await wave.getByRole('button', { name: '查看范围', exact: true }).click();
  await wave.getByRole('button', { name: '引用波形', exact: true }).click();
  await waitFor('all semantic copies received by owner', () => api('drafts/' + activity.activityId), draft =>
    draft.question === QUESTION && ['alu-case', 'alu-observation', 'alu-waveform', 'alu-reflection'].every(type => draft.references.some(ref => ref.range.typeId === type)));
  // Display the fixed case while checking, so an unrelated held candidate cannot suppress the report.
  await tool().getByLabel('用例记录', { exact: true }).selectOption(compared.query.requestId);
  const checked = await run('check-all', () => tool().getByRole('button', { name: /^(检查全部输入|再次检查)$/ }).click());
  await expect(page.getByText('4096 组检查通过', { exact: true })).toBeVisible({ timeout: 240000 });
  await capture('source-before-backup');
  before = await collect();
  assert.deepEqual(before.records.map(item => item.query.requestId).sort(),
    [live, enabled, compared, checked].map(item => item.query.requestId).sort(), 'all four original commands, and no duplicate, are retained');
  assert.ok(before.artifacts.some(item => item.resources?.some(resource => resource.name === 'trace.vcd')));
  assert.ok(before.artifacts.some(item => item.requestId === checked.query.requestId
    && JSON.parse(item.text).kind === 'alu-check'));
  await snapshot('source-received', before);
  pass('source retains code, fixed inputs, predictions, explanation chain, full check, VCD and four semantic references',
    { commands: before.records.length, enabled: enabled.query.requestId, compared: compared.query.requestId, checked: checked.query.requestId,
      materials: before.materials.length, componentEntry: true, runtimeResources: before.runtimeResources.length });
  // Browser-only edit is intentionally blocked from the owner and must remain outside the backup.
  await page.route('**/api/learning/drafts/**', route => route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue());
  await page.getByLabel('你的问题', { exact: true }).fill('仅旧浏览器的未同步问题');
  await page.waitForTimeout(1200);
  assert.equal((await api('drafts/' + activity.activityId)).question, QUESTION);
  const manifest = await driver('backup'); report.backup = manifest;
  assert.ok(manifest.boundary.services.every(item => item.blocking === 0));
  pass('real held backup closes every owner at one confirmed boundary', { backupId: manifest.backupId });
  const negative = await driver('negative'); await snapshot('negative-recovery', negative);
  assert.equal(negative.cases.length, 4); pass('missing and corrupt ALU facts and fixed runtime resources refuse activation and preserve the original backup', negative);
  const restored = await driver('restore'); targetEndpoint = restored.endpoint;
  assert.notEqual(restored.environment.installationId, setup.environment.installationId);
  originalPage = page; originalContext = context;
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, ignoreHTTPSErrors: false });
  page = await context.newPage(); watch(page); recordingIsolationWorkers = true;
  await page.goto(targetEndpoint); await login(targetEndpoint);
  const isolatedContext = await api('context'); assert.equal(isolatedContext.readOnly, true);
  assert.notEqual(isolatedContext.clientNamespace, sourceState.clientNamespace);
  recordingIsolation = true;
  await page.goto(targetEndpoint + '/?space=school&activity=' + activity.activityId);
  await tab('ALU 实验');
  await expect(tool().getByRole('status').filter({ hasText: '作品与历史只读' })).toContainText(/实验(?:尚)?未启用/);
  await expect(button('运行')).toBeDisabled();
  // Isolation intentionally withholds executable toolchain bytes; restore validates them via
  // the course owner's maintenance API. Re-read those same bytes publicly after takeover.
  const recovered = await collect({ runtime: false }); assert.deepEqual(recovered, { ...before, componentEntry: null, runtimeResources: [] });
  await expect(page.getByText(EXPLANATION, { exact: true })).toBeVisible();
  await expect(page.getByText(REVISION, { exact: true })).toBeVisible();
  await expect(page.getByText('4096 组检查通过', { exact: true })).toBeVisible();
  await expect(tool().getByRole('region', { name: '实验波形', exact: true })).toBeVisible();
  // Browsing another restored observation must work without changing the retained selection.
  const savedSelection = await workspace();
  const historyView = tool().locator('.alu-history'); await historyView.locator('summary').click();
  // The visible rows expose the original inputs/time; select the known explicit run by its input.
  const firstRun = historyView.locator('.alu-history-columns > div').first().locator('li').filter({ hasText: '显式运行' }).first();
  await firstRun.getByRole('button', { name: '查看', exact: true }).click();
  await expect(tool().locator('.alu-readout-inputs')).toContainText('原输入');
  assert.deepEqual(await workspace(), savedSelection, 'read-only browsing cannot sync a changed selection');
  await tool().getByLabel('用例记录', { exact: true }).selectOption(compared.query.requestId);
  await expect(page.getByText(EXPLANATION, { exact: true })).toBeVisible();
  await capture('isolated-restored');
  await tool().locator('.alu-case-results').screenshot({ path: join(output, 'isolated-comparison.png') });
  report.evidence.push({ path: 'isolated-comparison.png' });
  await snapshot('isolated-received', recovered);
  assert.deepEqual(writes, []); assert.deepEqual(isolatedWorkers, []); assert.equal(page.workers().length, 0);
  report.isolation = { workerEvents: isolatedWorkers, writes };
  recordingIsolation = false;
  recordingIsolationWorkers = false;
  pass('independent isolated Chrome re-reads exact original identities and bytes with zero writes or Worker execution',
    { oldNamespace: sourceState.clientNamespace, newNamespace: isolatedContext.clientNamespace, writes: 0, workers: 0 });
  const transfer = await driver('takeover'); await snapshot('takeover', transfer);
  assert.equal(transfer.result.backupId, manifest.backupId); assert.equal(transfer.lostConfirmation, true);
  await originalPage.unroute('**/api/learning/drafts/**');
  await originalPage.waitForTimeout(1500);
  const oldDrafts = await originalPage.evaluate(() => new Promise((done, reject) => {
    const opening = indexedDB.open('xunjie-reliable-works-v1');
    opening.onupgradeneeded = () => { opening.transaction.abort(); reject(new Error('Original protected database is absent')); };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => { const db = opening.result, request = db.transaction('drafts', 'readonly').objectStore('drafts').getAll();
      request.onsuccess = () => { db.close(); done(request.result); }; request.onerror = () => { db.close(); reject(request.error); }; };
  }));
  assert.ok(oldDrafts.some(draft => draft.question === '仅旧浏览器的未同步问题' && draft.key.includes(sourceState.clientNamespace)),
    'the old browser-only draft remains in its original namespace');
  await login(targetEndpoint);
  await driver('disable-runtime');
  const fixedRuntime = activity.course.components[0].definition.manifest.runtime.resources[0];
  const unavailable = await context.request.get(targetEndpoint + `/api/learning/releases/${activity.course.releaseId}/components/alu/resources/${fixedRuntime.path}`,
    { headers: { 'x-xj-space': 'school' } });
  assert.equal(unavailable.status(), 503, 'an unavailable fixed version cannot silently select another runtime');
  await page.reload(); await tab('ALU 实验');
  await expect(button('运行')).toBeDisabled();
  await expect(page.getByText(EXPLANATION, { exact: true })).toBeVisible();
  assert.deepEqual(await collect({ runtime: false }), { ...before, componentEntry: null, runtimeResources: [] });
  await capture('fixed-version-unavailable');
  pass('an unavailable fixed component version refuses runtime bytes while original work, explanations and result copies remain readable',
    { status: unavailable.status(), version: activity.course.components[0].definition.manifest.version });
  await driver('enable-runtime');
  await page.reload(); await tab('ALU 实验');
  await expect(button('运行')).toBeEnabled({ timeout: 300000 });
  const oldQueue = await context.request.post(targetEndpoint + '/api/learning/executions/' + activity.activityId,
    { headers: { 'x-xj-space': 'school', 'x-xj-namespace': sourceState.clientNamespace }, data: {} });
  assert.equal(oldQueue.status(), 403);
  const originalRecord = before.records.find(item => item.query.requestId === compared.query.requestId);
  const oldHandler = await context.request.post(targetEndpoint + `/api/learning/executions/${activity.activityId}/${compared.query.requestId}/report`,
    { headers: { 'x-xj-space': 'school', 'x-xj-namespace': sourceState.clientNamespace }, data: originalRecord.query });
  assert.equal(oldHandler.status(), 403);
  const activeFacts = await collect();
  assert.deepEqual(activeFacts, before, 'activation retains every fixed resource and does not replay any old request');
  const newRun = await run('run-single', () => button('运行').click());
  assert.ok(!before.records.some(item => item.query.requestId === newRun.query.requestId));
  const activeHistory = await history();
  assert.deepEqual(activeHistory.map(item => item.query.requestId).sort(),
    [...before.records, newRun].map(item => item.query.requestId).sort(), 'takeover and one explicit run add exactly one command');
  for (const original of before.records) assert.deepEqual(activeHistory.find(item => item.query.requestId === original.query.requestId), original);
  await capture('takeover-active');
  pass('lost takeover confirmation retries the same transfer; retired source, old browser namespace and old handler stay refused',
    { oldQueueStatus: oldQueue.status(), oldHandlerStatus: oldHandler.status(), newRequestId: newRun.query.requestId });
  assert.deepEqual(errors, []); assert.ok(workers.length > 0, 'source ran a real Worker');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack ?? error);
  for (const release of releaseGates) release();
  await Promise.allSettled([...routeHandlers]);
  await page?.unrouteAll({ behavior: 'wait' }).catch(() => {});
  await driver('resume-source').catch(() => {});
  if (page && activity) {
    await snapshot('failure-original-local-facts', await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      if (!databases.some(item => item.name === 'xunjie-reliable-works-v1')) return {};
      const db = await new Promise((done, reject) => { const request = indexedDB.open('xunjie-reliable-works-v1');
        request.onsuccess = () => done(request.result); request.onerror = () => reject(request.error); });
      try { const names = ['executionCommands', 'executionPending', 'executionResults', 'executionSync'].filter(name => db.objectStoreNames.contains(name));
        return await new Promise((done, reject) => { const tx = db.transaction(names, 'readonly'), result = {};
          for (const name of names) { const request = tx.objectStore(name).getAll(); request.onsuccess = () => { result[name] = request.result; }; }
          tx.oncomplete = () => done(result); tx.onabort = () => reject(tx.error); });
      } finally { db.close(); }
    })).catch(() => {});
    await waitFor('failed probe drains only original confirmed outcomes', history, entries => entries.every(item =>
      item.query.statusKnowledge === 'confirmed' && ['succeeded', 'failed', 'cancelled'].includes(item.query.state)), 45000).catch(() => {});
  }
  if (page) await capture('failure').catch(() => {});
  throw error;
} finally {
  // Keep the original browser alive until all its real facts have reached the service.
  await browser?.close().catch(() => {});
  try { report.cleanup = await driver('cleanup'); }
  catch (error) { report.cleanup = { status: 'failed', message: error.message }; report.status = 'failed'; }
  report.browserErrors = errors; report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, cleanup: report.cleanup }));
  if (report.status !== 'passed') process.exitCode = 1;
}
