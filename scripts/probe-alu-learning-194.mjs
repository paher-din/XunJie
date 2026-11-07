#!/usr/bin/env node
/**
 * #194 real-product acceptance; run separately on each Mac/Windows client and connection path.
 *
 * Product: XUNJIE_ALU_PRODUCT_ROOT=<fresh formal distribution> XUNJIE_ALU_OUTPUT=<evidence dir>
 *          XUNJIE_ALU_PACKAGES=<directory with full component.json and course.json requests>
 * School:  XUNJIE_ALU_REMOTE_CONFIG=<private JSON> XUNJIE_ALU_OUTPUT=<evidence dir>
 * The private JSON contains {endpoint,loginName,password,releaseId,spki?}.
 * Optional: XUNJIE_ALU_SUITE=core|all (default all), XUNJIE_ALU_LABEL=<path label>.
 *
 * Chrome is headed, channel=chrome. No API/Worker/IDB/PG replacements or injected app state.
 * IDB is inspected read-only. Faults either abort one genuine request or fetch its real response
 * and discard that response; subsequent retries can wait at a gate until evidence is captured.
 * Never run this alongside another acceptance owner on the same desktop.
 * These are engineering/browser observations, without a teaching-effect claim.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import tls from 'node:tls';
import { chromium, expect } from '@playwright/test';

const suite = process.env.XUNJIE_ALU_SUITE ?? 'all';
const mode = process.env.XUNJIE_ALU_REMOTE_CONFIG ? 'school-https' : 'product';
const label = process.env.XUNJIE_ALU_LABEL ?? `${process.platform}-${process.arch}-${mode}`;
const output = resolve(process.env.XUNJIE_ALU_OUTPUT ?? `.verification/wp04-194/${label}`);
const T = { ui: 90000, preparation: 300000, execution: 240000, sync: 180000 };
const MEDIA = 'application/vnd.xunjie.alu-reflection+json';
// Probe fixture only. This implementation must never be added to student starter materials.
const CORRECT = `// ALU #194 acceptance fixture, entered through Monaco\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout);
always_comb begin F=0; Cout=0; case({M,S})
3'b000:F=~A; 3'b001:F=A&B; 3'b010:F=A|B; 3'b011:F=A^B;
3'b100:{Cout,F}={1'b0,A}+{1'b0,B}+Cin;
default:begin F=0; Cout=0;end endcase end endmodule\n`;
const BOUNDARY = { A: 15, B: 1, M: 1, S: 0, Cin: 0 };
const OPERATION = { A: 10, B: 12, M: 0, S: 3, Cin: 0 };
const REASON = '选择 15 加 1，检验低四位回到零时进位是否仍被保留。';
const EDITED_REASON = '接收期间的新草稿：接下来要区分 14 加 1，不能改写原来的预测。';
let question = '请结合我保留的预测、实际观察和解释讨论进位；先保留问题，不要发送。';
const definitions = [
  ['setup', '正式包临时产品或独立学校 HTTPS、真实学校成员登录与新活动', 'core'],
  ['enable', 'Monaco 输入工程 fixture，真实运行启用原作品', 'core'],
  ['direct-reflection', '直接观察不重跑即可保存解释，原预测缺项保持缺项', 'core'],
  ['question-code', '中文问题不发送，现有 CodeReferenceSource 加入代码引用', 'core'],
  ['hold', '候选输入与预测不自动 observe，实际值、旧报告与历史不出现在 DOM', 'core'],
  ['candidate-reference', '候选用例加入原问题草稿，本机与服务副本一致', 'core'],
  ['frozen-comparison', '真实边界结果与固定预测；立即编辑保留新草稿，历史仍是原值', 'core'],
  ['reflections', '两次不可变解释修订及原父链，同一问题草稿保留两份引用', 'core'],
  ['waveform', '真实 VCD 信号、原 tick 范围、缩放及固定波形引用', 'core'],
  ['prior-sources', '同作品同输入重跑保留原来源，不作为独立预测', 'core'],
  ['operation', '操作区别用例 A10 XOR B12 实际 0110 / 0', 'core'],
  ['blank', '留空直接观察，缺项保持未填写', 'core'],
  ['restore', '刷新与工具切换恢复输入、预测、解释草稿、波形选择、引用和问题', 'core'],
  ['layout', '浅深主题、1440/1024/900px 真实页面与键盘焦点可操作', 'core'],
  ['accept-loss', '真实接收确认丢失一次；接收中历史快速选择保持原选择', 'fault'],
  ['local-result', '本地完成而服务未保留时，引用待同步；恢复后原请求确认且不重算', 'fault'],
  ['retain-loss', '真实结果已保留但确认丢失一次，仅重试原关联', 'fault'],
  ['final-report-lag', '原结果已到而服务终态滞后，合法引用保持可重试并在终态后确认', 'fault'],
  ['draft-loss', '问题草稿真实提交后丢失回执，核对原 requestId 恢复', 'fault'],
  ['works-loss', '作品真实提交后丢失回执，核对原 requestId 恢复', 'fault'],
  ['four-state', '真实 X 与 Z 结果保留四态，不伪造二值比较', 'fault'],
  ['compile-failure', '真实编译失败不启用失败作品，不伪造 F/Cout', 'fault'],
  ['incomplete', '安全输入启用后，比较期间编辑进入 hold 并停止原执行，保留真实不完整观察', 'fault'],
  ['two-tabs', '双标签真实 workspace 冲突、明确选择原内容并保留双方', 'fault'],
  ['network-unsent', '真实页面来源、Worker、零问题派发与零伪造响应', 'core'],
];
const report = { kind: 'alu-learning-194', issue: 194, label, mode, suite, platform: process.platform, arch: process.arch,
  node: process.version, headed: true, browserChannel: 'chrome', startedAt: new Date().toISOString(), status: 'running',
  acceptanceComplete: false, cases: definitions.map(([id, name, group]) => ({ id, name, group, status: 'not-run', assertions: 0 })),
  evidence: [], traffic: [], faults: [], cleanup: [], limitations: [
    'Each report covers only the current client and endpoint. Run independently on Mac product, Windows product, Mac school HTTPS, and Windows school HTTPS.',
    'No teaching-effect assessment. Remote PostgreSQL placement is not independently inspected by this browser probe.',
  ] };
const secrets = new Set();
let runtime, root, browser, context, page, endpoint, activity, binding, activeCase, firstCase, operationCase, originalWave;
let faultGate;
const origins = new Set(), workerUrls = new Set(), pendingNetwork = new Set();
const questionSends = [], browserErrors = [];
const faultPattern = '**/api/learning/**';
const hash = text => createHash('sha256').update(text).digest('hex');
const controls = state => Object.fromEntries(['A', 'B', 'M', 'S', 'Cin'].map(key => [key, state[key]]));
class SnapshotNotReady extends Error {}
// Read the actual fixed file without a contracts/source-tree dependency in the lightweight client.
function caseCapture(action) {
  if (action?.protocolVersion !== 3 || action.execution.operation.operationId !== 'observe-enabled' || action.execution.instance.stateVersion !== 3) return null;
  const file = action.execution.basis.works.find(item => item.kind === 'state' && item.contentId === action.execution.basis.expected.stateContentId);
  if (!file) return null;
  const state = JSON.parse(file.value);
  if (state.stateVersion !== 3 || state.content.caseRequestId !== action.requestId || state.content.feedbackPolicy !== 'hold') return null;
  return { draft: JSON.parse(state.content.caseDraft), inputs: action.execution.parameters, state, file };
}
function verifyWaveCopy(text, reference, range) {
  equal(reference.range.target, range); check(reference.copy.startsWith('ALU 波形'), 'human-readable waveform copy');
  check(reference.copy.includes(`原始 tick 闭区间：${range.fromTick} 至 ${range.toTick}`), 'copy preserves inclusive original ticks');
  const unit = text.match(/\$timescale\s*(\d+)\s*(s|ms|us|ns|ps|fs)\s*\$end/);
  check(reference.copy.includes(unit ? `时间单位：${unit[1]} ${unit[2]}/tick` : '时间单位：未声明'), 'copy preserves original timescale');
  const declarations = new Map(), scope = [];
  for (const match of text.matchAll(/\$(scope|upscope|var|enddefinitions)\b([\s\S]*?)\$end/g)) {
    const parts = match[2].trim().split(/\s+/);
    if (match[1] === 'scope') scope.push(parts[1]);
    else if (match[1] === 'upscope') scope.pop();
    else if (match[1] === 'enddefinitions') break;
    else declarations.set([...scope, parts[3] + parts.slice(4).join('')].join('.'), { width: Number(parts[1]), code: parts[2] });
  }
  const stream = text.slice(text.indexOf('$enddefinitions') + '$enddefinitions'.length);
  for (const id of range.signalIds) {
    const signal = declarations.get(id); check(signal, 'selected signal is declared in original VCD');
    check(reference.copy.includes(`信号 ${id}（${signal.width} 位）`), 'copy names the actual selected signal');
    let tick = '0'; const changes = [];
    // Icarus writes one digital timestamp/value record per line. This independent evidence scan
    // checks these small probe traces; it does not replace the product's general VCD parser.
    for (const match of stream.matchAll(/^#(\d+)\s*$|^[bB]([01xzXZ]+)\s+(\S+)\s*$|^([01xzXZ])(\S+)\s*$/gm)) {
      if (match[1] !== undefined) { tick = BigInt(match[1]).toString(); continue; }
      const code = match[3] ?? match[5]; if (code !== signal.code) continue;
      const raw = (match[2] ?? match[4]).toUpperCase();
      changes.push({ timeTick: tick, value: raw.padStart(signal.width, /^[XZ]/.test(raw) ? raw[0] : '0') });
    }
    const included = changes.filter(change => BigInt(change.timeTick) >= BigInt(range.fromTick) && BigInt(change.timeTick) <= BigInt(range.toTick));
    const atFrom = changes.filter(change => BigInt(change.timeTick) <= BigInt(range.fromTick)).at(-1) ?? null;
    check(included.length > 0, 'selected port has genuine original events');
    check(reference.copy.includes(atFrom ? `起点：${atFrom.value}（记录于 tick ${atFrom.timeTick}）` : '起点：未取得'), 'copy retains actual starting value');
    for (const event of included) check(reference.copy.includes(`tick ${event.timeTick}：${event.value}`), 'copy retains original event tick and four-state value');
  }
}
const safeError = error => scrub(String(error?.stack ?? error));
function scrub(value) {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
    return result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/password|token|authorization|cookie|secret|credential/i.test(key)).map(([key, item]) => [key, scrub(item)]));
  return value;
}
function check(condition, message) { assert.ok(condition, message); if (activeCase) activeCase.assertions++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); if (activeCase) activeCase.assertions++; }
async function evidence(name, value) {
  const file = `evidence/${name}.json`;
  await writeFile(join(output, file), JSON.stringify(scrub(value), null, 2) + '\n');
  report.evidence.push(file); return file;
}
async function screenshot(name) {
  const file = `screenshots/${name}.png`;
  await page.screenshot({ path: join(output, file), fullPage: true });
  report.evidence.push(file); return file;
}
async function step(id, fn) {
  activeCase = report.cases.find(item => item.id === id);
  activeCase.startedAt = new Date().toISOString();
  try {
    const detail = await fn();
    assert.ok(activeCase.assertions > 0, `${id} has no asserted evidence`);
    activeCase.status = 'passed'; activeCase.detail = detail;
    console.log(`PASS ${id}`);
  } catch (error) {
    activeCase.status = 'failed'; activeCase.error = safeError(error);
    if (page) {
      try { await screenshot(`failure-${id}`); } catch (captureError) { activeCase.captureError = safeError(captureError); }
      if (activity) try { await evidence(`failure-${id}-local`, await local()); } catch { /* Original failure remains authoritative. */ }
    }
    throw error;
  } finally { activeCase.finishedAt = new Date().toISOString(); activeCase = undefined; }
}
async function until(name, read, predicate, timeout = T.sync) {
  let value;
  await expect.poll(async () => {
    try { value = await read(); return Boolean(predicate(value)); }
    catch (error) { if (error instanceof SnapshotNotReady) return false; throw error; }
  }, { message: name, timeout,
    intervals: [100, 200, 400, 750, 1000] }).toBe(true);
  return value;
}
const tool = () => page.locator('.runtime-tool-full.alu-tool');
const button = name => tool().getByRole('button', { name, exact: true });
async function click(locator) { await locator.scrollIntoViewIfNeeded(); await locator.click(); }
async function tab(name) { await click(page.getByRole('tab', { name, exact: true })); }
async function browserApi(path, body) {
  const result = await page.evaluate(async ({ path, body, subject }) => {
    const response = await fetch('/api/learning/' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-xj-space': 'school',
        ...(subject ? { 'x-xj-expected-subject': subject } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let value; try { value = await response.json(); } catch { value = null; }
    return { status: response.status, value };
  }, { path, body, subject: activity ? [activity.identity.environmentId, activity.identity.spaceId, activity.identity.principalId].join('.') : null });
  assert.equal(result.status, 200, `${path}: HTTP ${result.status}, code ${String(result.value?.error ?? 'unreadable')}`);
  return result.value;
}
async function history() {
  const entries = [], cursors = new Set(); let cursor = null;
  do {
    const next = await browserApi(`executions/${activity.activityId}/history${cursor ? '/' + cursor : ''}`);
    entries.push(...next.entries); cursor = next.nextCursor;
    check(!cursor || !cursors.has(cursor), 'history cursor must advance'); if (cursor) cursors.add(cursor);
  } while (cursor);
  return entries;
}
const remoteWorks = () => browserApi(`workspaces/${activity.activityId}`);
const remoteDraft = () => browserApi(`drafts/${activity.activityId}`);
function stateOf(files) {
  const file = files.find(item => item.name === `components/${binding.key}.json`);
  if (!file) throw new SnapshotNotReady('bound component state has not reached IDB yet');
  const parsed = JSON.parse(file.value); assert.equal(parsed.stateVersion, 3); return parsed.content;
}
/** Observe only existing stores. Abort an accidental upgrade rather than creating probe-owned IDB state. */
async function local({ allowMissing = false } = {}) {
  return page.evaluate(async ({ activityId, allowMissing }) => {
    const available = await indexedDB.databases();
    if (!available.some(item => item.name === 'xunjie-reliable-works-v1')) {
      if (allowMissing) return { databaseMissing: true, stores: [], workspaces: [], drafts: [], actions: [], executionCommands: [], executionSync: [], executionResults: [], executionStops: [] };
      throw new Error('Real workspace database is absent');
    }
    const db = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('xunjie-reliable-works-v1');
      opening.onupgradeneeded = () => { opening.transaction.abort(); reject(new Error('Unexpected probe IDB upgrade')); };
      opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
      opening.onblocked = () => reject(new Error('Workspace IDB read blocked'));
    });
    try {
      const names = ['workspaces', 'drafts', 'actions', 'executionCommands', 'executionRequests', 'executionPending', 'executionResults', 'executionSync', 'executionStops', 'candidates', 'draftCandidates']
        .filter(name => db.objectStoreNames.contains(name));
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction(names, 'readonly'), result = {};
        for (const name of names) { const request = tx.objectStore(name).getAll(); request.onsuccess = () => { result[name] = request.result; }; }
        tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
      });
      const belongs = row => row.action?.scope?.activityId === activityId || row.input?.scope?.activityId === activityId
        || [row.key, row.scope].some(value => typeof value === 'string' && value.includes(activityId));
      return { stores: names, ...Object.fromEntries(Object.entries(rows).map(([name, items]) => [name, items.filter(belongs)])) };
    } finally { db.close(); }
  }, { activityId: activity.activityId, allowMissing });
}
const localWork = snapshot => { if (!snapshot.workspaces.length) throw new SnapshotNotReady('workspace has not reached IDB yet'); assert.equal(snapshot.workspaces.length, 1, 'exactly one workspace in the activity scope'); return snapshot.workspaces[0]; };
const localDraft = snapshot => { if (!snapshot.drafts.length) throw new SnapshotNotReady('draft has not reached IDB yet'); assert.equal(snapshot.drafts.length, 1, 'exactly one draft in the activity scope'); return snapshot.drafts[0]; };
const localState = snapshot => stateOf(localWork(snapshot).files);
const ids = snapshot => snapshot.executionCommands.map(item => item.requestId).sort();
const observationIds = snapshot => snapshot.executionCommands.filter(item => item.action.execution.operation.operationId === 'observe-enabled').map(item => item.requestId).sort();
const actionExecutionIds = snapshot => (snapshot.actions ?? []).filter(item => item.input?.execution).map(item => item.input.requestId).sort();
const requestIds = snapshot => (snapshot.executionRequests ?? []).map(item => item.requestId ?? item.action?.requestId ?? item.input?.requestId).sort();
const notes = snapshot => localWork(snapshot).files.filter(file => file.mediaType === MEDIA).map(file => ({ file, note: JSON.parse(file.value) }));
const semantic = (draft, type) => draft.references.filter(ref => ref.range.kind === 'semantic' && ref.range.typeId === type);
const referenceInputs = references => references.map(({ copyDigest: _copyDigest, ...reference }) => reference);
async function numeric(name, value) {
  const labels = { A: 'A（无符号 4 位）', B: 'B（无符号 4 位）', M: 'M（模式，0/1）', S: 'S（操作选择，0–3）', Cin: 'Cin（进位输入，0/1）' };
  const field = tool().locator('.alu-numeric-field').filter({ hasText: labels[name] }).locator('input');
  await field.scrollIntoViewIfNeeded(); await field.fill(String(value)); await field.press('Tab');
  await expect(field).toHaveValue(String(value)); await expect(field).toHaveAttribute('aria-invalid', 'false');
  await until(`numeric ${name} is protected in IDB`, local, snapshot => localState(snapshot)[name] === Number(value));
}
async function input(values) { for (const [key, value] of Object.entries(values)) await numeric(key, value); }
async function newCase(values, prediction = { F: '', Cout: '', reason: '', purpose: 'unspecified' }) {
  await click(button('新用例'));
  await until('new case is protected with feedback hold', local, value => localState(value).feedbackPolicy === 'hold');
  await input(values);
  await tool().getByLabel('用例目的', { exact: true }).selectOption(prediction.purpose);
  await tool().getByLabel('预测 F', { exact: true }).fill(prediction.F);
  await tool().getByLabel('预测 Cout', { exact: true }).fill(prediction.Cout);
  await tool().getByLabel('选择这组输入的理由', { exact: true }).fill(prediction.reason);
  await until('candidate inputs and prediction are durably protected', local, value => {
    const state = localState(value), draft = JSON.parse(state.caseDraft);
    return JSON.stringify(controls(state)) === JSON.stringify(values) && draft.reason === prediction.reason
      && draft.predictedF === prediction.F && draft.predictedCout === prediction.Cout && draft.purpose === prediction.purpose;
  });
}
async function settledRecord(requestId, expected = 'succeeded') {
  const value = await until(`original execution ${requestId} settles`, local,
    snapshot => snapshot.executionCommands.some(item => item.requestId === requestId && item.query.statusKnowledge === 'confirmed'
      && ['succeeded', 'failed', 'cancelled'].includes(item.query.state)), T.execution);
  const record = value.executionCommands.find(item => item.requestId === requestId);
  if (expected) equal(record.query.state, expected, 'genuine execution outcome'); return record;
}
async function nextCommand(before, operation) {
  const value = await until('new real ledger command', local, snapshot => snapshot.executionCommands
    .some(item => !before.includes(item.requestId) && item.action.execution.operation.operationId === operation), T.execution);
  const matches = value.executionCommands.filter(item => !before.includes(item.requestId) && item.action.execution.operation.operationId === operation);
  equal(matches.length, 1, 'one new command for one explicit action'); return matches[0];
}
async function synced(requestId) {
  const value = await until('same local request is confirmed by the owner', async () => {
    const snapshot = await local(), entry = (await history()).find(item => item.action.requestId === requestId);
    return { snapshot, entry, sync: snapshot.executionSync.find(item => item.requestId === requestId) };
  }, value => value.entry && value.sync?.command
    && (!value.snapshot.executionCommands.find(item => item.requestId === requestId)?.query.output || value.sync?.result)
    && value.entry.query.statusKnowledge === 'confirmed' && value.entry.query.state === value.snapshot.executionCommands.find(item => item.requestId === requestId)?.query.state);
  equal(value.entry.action.requestId, requestId); equal(value.entry.query.executionRef,
    value.snapshot.executionCommands.find(item => item.requestId === requestId).executionRef); return value.entry;
}
async function compare({ editImmediately, expected = 'succeeded' } = {}) {
  const before = ids(await local()); await expect(button('运行并比较')).toBeEnabled({ timeout: T.execution });
  await click(button('运行并比较'));
  if (editImmediately) await editImmediately();
  const command = await nextCommand(before, 'observe-enabled');
  check(caseCapture(command.action), 'compare is an original fixed stateVersion3 case');
  return settledRecord(command.requestId, expected);
}
async function chooseCase(requestId) {
  const select = tool().getByLabel('用例记录', { exact: true });
  if (!await select.isVisible()) await click(button('恢复自由观察'));
  await expect(select).toBeVisible({ timeout: T.ui }); await select.selectOption(requestId);
  return until('explicit historical case selection is protected', local, value => {
    const state = localState(value);
    return state.selectedCase === requestId && state.selectedObservation === requestId
      && state.selectedObservationRevision === -1 && state.feedbackPolicy === 'live';
  });
}
async function comparison(record, expected) {
  const table = tool().getByRole('table', { name: '预测与实际比较', exact: true });
  await expect(table).toBeVisible({ timeout: T.execution });
  for (const [index, signal] of ['F', 'Cout'].entries()) {
    const row = table.locator('tbody tr').nth(index); await expect(row.locator('th')).toHaveText(signal);
    await expect(row.locator('td').nth(0)).toHaveText(expected[`predicted${signal}`] || '未填写');
    await expect(row.locator('td').nth(1)).toHaveText(expected[signal]);
  }
  const capture = caseCapture(record.action); check(capture, 'comparison has an original capture');
  equal(capture.draft.reason, expected.reason); await expect(tool().locator('.alu-case-original')).toHaveText(`选择理由：${expected.reason || '未填写'}`);
}
async function draftCopies(name, predicate) {
  const value = await until('both original draft copies contain the selected references', async () => ({
    local: localDraft(await local()), remote: await remoteDraft() }), value => predicate(value.local) && predicate(value.remote));
  equal(value.local.question, question); equal(value.remote.question, question);
  equal(referenceInputs(value.local.references), referenceInputs(value.remote.references), 'owner copy matches original browser references');
  for (const reference of value.remote.references) equal(reference.copyDigest, hash(reference.copy), 'owner verified the original reference bytes');
  for (const reference of value.remote.references.filter(ref => ref.range.kind === 'semantic')) {
    equal(reference.source.activityId, activity.activityId); equal(reference.source.principalId, activity.identity.principalId);
    equal(reference.source.definitionDigest, binding.definition.digest); equal(reference.range.end, reference.copy.length);
  }
  await evidence(`${name}-local`, value.local); await evidence(`${name}-service`, value.remote); return value;
}
async function replaceCode(text) {
  const reopen = await page.getByLabel('你的问题', { exact: true }).isVisible();
  if (reopen) await click(page.getByRole('button', { name: '收起对话', exact: true }));
  await tab('作品'); const editor = page.locator('.monaco-editor textarea').first();
  await expect(editor).toBeVisible({ timeout: T.preparation }); await editor.focus();
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(text);
  await until('editor change is protected by the real workspace', local, value => localWork(value).files.some(file => file.name === 'alu.sv' && file.value === text));
  await tab('ALU 实验');
  if (reopen) await click(page.getByRole('button', { name: '打开对话', exact: true }));
}
async function enable(text = CORRECT, expected = 'succeeded') {
  await replaceCode(text); const before = ids(await local());
  await expect(button('运行')).toBeEnabled({ timeout: T.preparation }); await click(button('运行'));
  const record = await nextCommand(before, 'run-single'), done = await settledRecord(record.requestId, expected);
  if (expected === 'succeeded') await until('original successful work is enabled', local,
    value => JSON.parse(localState(value).enabledBasis || '{}').requestId === record.requestId);
  await synced(record.requestId); return done;
}
async function noAutoObserve(before, duration = 1800) {
  const start = Date.now(); let after;
  do {
    after = await local(); equal(observationIds(after), observationIds(before), 'hold must not accept an automatic observation');
    equal(actionExecutionIds(after), actionExecutionIds(before), 'hold must not create execution action requests');
    equal(requestIds(after), requestIds(before), 'hold must not append executionRequests when that store exists');
    await page.waitForTimeout(200);
  } while (Date.now() - start < duration);
  await expect(tool().locator('.alu-readout-value')).not.toContainText(/F=[01xz]{4}|Cout=[01xz]/i);
  for (const selector of ['table[aria-label="预测与实际比较"]', '.alu-history', '.alu-check', '[aria-label="计算记录"]', '.alu-waveform'])
    await expect(tool().locator(selector)).toHaveCount(0);
  return after;
}
async function verifyPin(url, expected) {
  return new Promise((resolve, reject) => {
    // No application bytes or credentials are sent before the real CA chain and exact allowed
    // key are checked. NODE_EXTRA_CA_CERTS supplies this acceptance school's private CA.
    const socket = tls.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443),
      servername: url.hostname, rejectUnauthorized: true });
    socket.setTimeout(10000, () => socket.destroy(new Error('School TLS inspection timed out')));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      try {
        const certificate = new X509Certificate(socket.getPeerCertificate().raw);
        const actual = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
        if (expected) assert.equal(actual, expected, 'live school SPKI differs from the one allowed to Chrome');
        assert.ok(socket.authorized, 'school certificate chain must be trusted');
        resolve({ protocol: socket.getProtocol(), spki: actual, chainAuthorized: socket.authorized,
          certificatePolicy: expected ? 'strict-chain-and-exact-SPKI' : 'normal-trust', validTo: certificate.validTo });
      } catch (error) { reject(error); } finally { socket.end(); }
    });
  });
}
function watch() {
  context.on('request', request => {
    const url = new URL(request.url()); if (['http:', 'https:'].includes(url.protocol)) origins.add(url.origin);
    if (request.method() === 'POST' && /\/api\/learning\/(?:intents|agent|model-responses)/.test(url.pathname)) {
      let body; try { body = request.postDataJSON(); } catch { return; }
      if (body?.draft && !body.execution && !body.action?.execution) questionSends.push({ path: url.pathname, method: request.method() });
    }
  });
  context.on('response', response => {
    const task = (async () => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/learning/')) report.traffic.push({ path: url.pathname, method: response.request().method(), status: response.status(), step: activeCase?.id ?? 'between-steps' });
      if (url.origin === endpoint && url.pathname === '/') report.pageSecurity = await response.securityDetails();
    })().catch(error => browserErrors.push(safeError(error)));
    pendingNetwork.add(task); void task.finally(() => pendingNetwork.delete(task));
  });
  context.on('page', target => {
    target.on('worker', worker => workerUrls.add(worker.url()));
    target.on('pageerror', error => browserErrors.push(safeError(error)));
  });
}

await mkdir(join(output, 'evidence'), { recursive: true });
await mkdir(join(output, 'screenshots'), { recursive: true });
try {
  check(['core', 'all'].includes(suite), 'XUNJIE_ALU_SUITE must be core or all');
  check(Boolean(process.env.XUNJIE_ALU_PRODUCT_ROOT) !== Boolean(process.env.XUNJIE_ALU_REMOTE_CONFIG), 'select exactly one product root or remote config');
  await step('setup', async () => {
    let loginName, password, releaseId, spki;
    if (mode === 'product') {
      const packageRoot = resolve(process.env.XUNJIE_ALU_PRODUCT_ROOT);
      const declared = JSON.parse(await readFile(join(packageRoot, 'resources.json'), 'utf8'));
      const resources = { ...declared };
      for (const key of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper'])
        if (declared[key]) resources[key] = resolve(packageRoot, declared[key]);
      const bundled = await import(pathToFileURL(join(packageRoot, 'app/product-runtime.js')).href);
      root = await mkdtemp(join(tmpdir(), 'xj-alu-learning-194-'));
      runtime = bundled.openProductRuntime({ root, resources });
      await runtime.install({ profile: 'local' }); endpoint = (await runtime.start()).endpoint;
      endpoint = new URL(endpoint).origin;
      const control = await bundled.resolveCredential(root, 'control'); secrets.add(control);
      const manage = async (path, body) => {
        const response = await fetch(new URL('/api/learning/' + path, endpoint), { method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${control}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        equal(response.status, 200, `real manage ${path}`); return response.json();
      };
      let component, course;
      if (process.env.XUNJIE_ALU_PACKAGES) {
        const packages = resolve(process.env.XUNJIE_ALU_PACKAGES);
        component = JSON.parse(await readFile(join(packages, 'component.json'), 'utf8'));
        course = JSON.parse(await readFile(join(packages, 'course.json'), 'utf8'));
      } else {
        const { aluPackage, aluCoursePackage } = await import('../components/alu-experiment/package.mjs');
        component = await aluPackage(); course = await aluCoursePackage();
      }
      check(component?.manifest && typeof component.contentBase64 === 'string' && course?.release?.components,
        'component.json/course.json contain full API requests, not CLI file manifests');
      equal(component.manifest.stateVersion, 3, 'new v3 component');
      const definition = await manage('manage/component-import', component);
      course.release.components[0].definition = definition; await manage('manage/course-import', course);
      loginName = 'alu194-' + randomUUID().slice(0, 8); password = randomUUID(); secrets.add(password);
      const member = await manage('manage/members', { requestId: randomUUID(), loginName, password });
      await manage('manage/course-access', { requestId: randomUUID(), courseId: course.course.courseId, principalId: member.principalId, active: true });
      releaseId = course.release.releaseId;
      report.product = { packageRoot, resourcesManifestSha256: hash(JSON.stringify(declared)), temporaryRoot: root, newMember: true,
        environmentId: (await runtime.status()).environment.environmentId };
    } else {
      const config = JSON.parse(await readFile(resolve(process.env.XUNJIE_ALU_REMOTE_CONFIG), 'utf8'));
      ({ loginName, password, releaseId, spki } = config); secrets.add(password);
      check(typeof loginName === 'string' && typeof password === 'string' && typeof releaseId === 'string', 'private school config has required fields');
      const url = new URL(config.endpoint);
      check(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'school endpoint must be a plain origin');
      equal(url.protocol, 'https:'); endpoint = url.origin;
      check(!/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/i.test(url.hostname), 'independent school endpoint cannot be loopback');
      const addresses = (await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })).map(item => item.address);
      const localAddresses = Object.values(networkInterfaces()).flat().filter(Boolean).map(item => item.address);
      check(addresses.length > 0 && addresses.every(address => !localAddresses.includes(address) && !/^(127\.|::1$)/.test(address)), 'school resolves outside this client');
      if (spki) check(/^[A-Za-z0-9+/]{43}=$/.test(spki), 'one exact SHA-256 SPKI pin');
      report.tls = await verifyPin(url, spki); report.remote = { endpoint, resolvedAddresses: addresses, clientLocalProduct: false };
    }
    report.endpoint = endpoint;
    browser = await chromium.launch({ channel: 'chrome', headless: false,
      args: spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : [] });
    report.browser = browser.version();
    context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, ignoreHTTPSErrors: false }); watch();
    page = await context.newPage(); page.setDefaultTimeout(T.ui); await page.goto(endpoint, { waitUntil: 'domcontentloaded', timeout: T.ui });
    const entry = await browserApi('context');
    if (mode === 'school-https') equal(entry.profile, 'school', 'external node serves the real school entry');
    // The local profile exposes its school login through the same real API; the external school
    // profile has a visible login form. Both establish the browser's genuine same-origin cookie.
    if (mode === 'school-https') {
      await page.getByLabel('学校账号', { exact: true }).fill(loginName);
      await page.getByLabel('密码', { exact: true }).fill(password);
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/learning/login' && response.request().method() === 'POST');
      await page.getByRole('button', { name: '登录此学校', exact: true }).click();
      equal((await response).status(), 200, 'real school form login');
    } else {
      const logged = await browserApi('login', { loginName, password }); equal(logged.identity.kind, 'school');
    }
    activity = await browserApi('course-activities', { requestId: randomUUID(), releaseId });
    equal(activity.course.releaseId, releaseId); equal(activity.identity.kind, 'school');
    binding = activity.course.components.find(item => item.definition.manifest.runtime?.adapterId === 'icarus-alu');
    check(binding, 'fixed release contains ALU'); equal(binding.definition.manifest.stateVersion, 3, 'activity binds v3');
    report.activityId = activity.activityId; report.releaseId = releaseId; report.binding = { key: binding.key, definitionDigest: binding.definition.digest };
    await page.goto(`${endpoint}/?space=school&activity=${activity.activityId}`, { waitUntil: 'domcontentloaded', timeout: T.ui });
    await expect(page.locator('#activity-title')).toHaveText(activity.course.taskTitle, { timeout: T.ui });
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: T.preparation });
    await expect(page.getByRole('button', { name: 'alu.sv', exact: true }).first()).toBeVisible({ timeout: T.ui });
    await tab('ALU 实验'); await expect(button('运行')).toBeEnabled({ timeout: T.preparation });
    check((await local()).stores.includes('executionCommands'), 'real product IDB is available'); await screenshot('initial');
    return { activityId: activity.activityId, stateVersion: 3, endpoint, clientPath: `${process.platform}-${mode}` };
  });
  await step('enable', async () => {
    const record = await enable();
    check(record.action.execution.basis.works.some(file => file.kind === 'code' && file.value === CORRECT), 'run fixes the code typed through Monaco');
    const original = await browserApi(`executions/${activity.activityId}/${record.requestId}/artifact`);
    equal(original.requestId, record.requestId); check(original.resources?.some(item => item.name === 'trace.vcd'), 'real simulation retains VCD');
    await evidence('enabled-action', record.action); await screenshot('enabled'); return { requestId: record.requestId, executionRef: record.executionRef };
  });
  await step('direct-reflection', async () => {
    const before = await local(), record = before.executionCommands.find(item => item.action.execution.operation.operationId === 'run-single');
    check(record && !caseCapture(record.action), 'direct run has no invented fixed prediction');
    const text = '这是直接观察之后的解释：先前没有记录预测，接下来用边界用例核对进位。';
    const explanation = tool().getByLabel('实验解释', { exact: true });
    await expect(explanation).toBeVisible({ timeout: T.ui }); await explanation.fill(text); await click(button('保存解释修订'));
    const saved = await until('direct observation explanation is protected', local, value => notes(value).some(item => item.note.text === text));
    const note = notes(saved).find(item => item.note.text === text);
    equal(note.note.requestId, record.requestId); equal(note.note.parentNoteId, null); equal(ids(saved), ids(before));
    equal(localState(saved).caseDraft, '', 'explaining afterwards never fills a prior prediction');
    const received = await until('original owner keeps the direct observation explanation', remoteWorks,
      value => value.files.some(file => file.contentId === note.file.contentId && file.value === note.file.value));
    await evidence('direct-explanation-owner', received); await screenshot('direct-observation-explanation');
    return { requestId: record.requestId, noteId: note.note.noteId, newExecutions: 0 };
  });
  await step('question-code', async () => {
    if (!await page.getByLabel('你的问题', { exact: true }).isVisible()) await click(page.getByRole('button', { name: '打开对话', exact: true }));
    await page.getByLabel('你的问题', { exact: true }).fill(question);
    await tab('作品'); const editor = page.locator('.monaco-editor textarea').first(); await editor.focus();
    await page.keyboard.press('ControlOrMeta+A');
    const copies = await draftCopies('question-code', draft => draft.references.some(ref => ref.range.kind === 'code' && ref.source.kind === 'work' && ref.copy.includes('module alu')));
    equal(questionSends, [], 'no question action is dispatched by selection');
    await tab('ALU 实验'); return { codeReferenceId: copies.local.references.find(ref => ref.range.kind === 'code').referenceId };
  });
  await step('hold', async () => {
    await click(button('新用例'));
    await until('hold precedes numeric editing', local, value => localState(value).feedbackPolicy === 'hold');
    const before = await local();
    await input(BOUNDARY);
    await tool().getByLabel('用例目的', { exact: true }).selectOption('boundary');
    await tool().getByLabel('预测 F', { exact: true }).fill('0000');
    await tool().getByLabel('预测 Cout', { exact: true }).fill('1');
    await tool().getByLabel('选择这组输入的理由', { exact: true }).fill(REASON);
    await noAutoObserve(before);
    const after = await until('held inputs and prediction are protected together', local, value => {
      const state = localState(value), draft = JSON.parse(state.caseDraft);
      return JSON.stringify(controls(state)) === JSON.stringify(BOUNDARY) && draft.reason === REASON
        && draft.purpose === 'boundary' && draft.predictedF === '0000' && draft.predictedCout === '1';
    });
    equal(controls(localState(after)), BOUNDARY); equal(JSON.parse(localState(after).caseDraft).reason, REASON);
    await evidence('hold-before', before); await evidence('hold-after', after); await screenshot('candidate-hold');
    return { observationCommandsBefore: observationIds(before), observationCommandsAfter: observationIds(after), executionRequestsStore: before.stores.includes('executionRequests') };
  });
  await step('candidate-reference', async () => {
    await click(button('用例加入问题'));
    const copies = await draftCopies('candidate', draft => semantic(draft, 'alu-case').some(ref => {
      return ref.copy.startsWith('ALU 用例') && ref.copy.includes(REASON) && ref.copy.includes('目的：进位或边界');
    }));
    const copy = semantic(copies.local, 'alu-case').at(-1).copy;
    for (const [name, value] of Object.entries(BOUNDARY)) check(copy.includes(`${name}=${value}`), 'copy retains candidate input');
    check(copy.includes('F=0000') && copy.includes('Cout=1'), 'copy retains prediction text');
    return { references: copies.local.references.map(ref => ref.referenceId) };
  });
  await step('frozen-comparison', async () => {
    firstCase = await compare({ editImmediately: async () => {
      await tool().getByLabel('选择这组输入的理由', { exact: true }).fill(EDITED_REASON); await numeric('A', 14);
    } });
    const capture = caseCapture(firstCase.action);
    equal(capture.inputs, BOUNDARY); equal(capture.draft.reason, REASON); equal(capture.draft.purpose, 'boundary');
    equal(firstCase.query.output.output.f, '0000'); equal(firstCase.query.output.output.cout, '1');
    const after = await until('edited A14 and reason are protected in the same snapshot', local, value => {
      const state = localState(value);
      return state.A === 14 && JSON.parse(state.caseDraft).reason === EDITED_REASON;
    });
    equal(JSON.parse(localState(after).caseDraft).reason, EDITED_REASON); equal(localState(after).A, 14);
    await chooseCase(firstCase.requestId);
    await comparison(firstCase, { F: '0000', Cout: '1', predictedF: '0000', predictedCout: '1', reason: REASON });
    const selected = await until('history selection and the newer draft are protected together', local, value => {
      const state = localState(value);
      return state.selectedCase === firstCase.requestId && state.selectedObservation === firstCase.requestId
        && state.selectedObservationRevision === -1 && state.A === 14 && JSON.parse(state.caseDraft).reason === EDITED_REASON;
    });
    equal(JSON.parse(localState(selected).caseDraft).reason, EDITED_REASON, 'history selection leaves the new draft intact');
    const service = await synced(firstCase.requestId); equal(service.action, firstCase.action);
    await click(button('结果加入问题'));
    await draftCopies('boundary-result', draft => semantic(draft, 'alu-observation').some(ref => ref.source.requestId === firstCase.requestId
      && ref.source.executionRef === firstCase.executionRef && ref.copy.includes('实际：F=0000，Cout=1')));
    await evidence('boundary-action', firstCase.action); await screenshot('boundary-frozen'); return { requestId: firstCase.requestId, originalReason: REASON, newDraftReason: EDITED_REASON };
  });
  await step('reflections', async () => {
    const firstText = '15 加 1 的低四位是 0000，Cout 保留第五位；还要检查逻辑操作是否清零进位。';
    const secondText = firstText + ' 修订：我将再用 XOR 用例区分操作选择，并保留这次边界用例。';
    const reflection = tool().getByLabel('实验解释', { exact: true });
    await reflection.fill(firstText); await click(button('保存解释修订'));
    const first = await until('first immutable explanation is protected', local, snapshot => notes(snapshot).some(item => item.note.text === firstText));
    const original = notes(first).find(item => item.note.text === firstText);
    equal(original.note.requestId, firstCase.requestId); equal(original.note.parentNoteId, null);
    const firstView = tool().locator('.alu-reflection').filter({ has: page.getByText(firstText, { exact: true }) });
    await click(firstView.getByRole('button', { name: '解释加入问题', exact: true }));
    await click(firstView.getByRole('button', { name: '在此基础上修订', exact: true }));
    await expect(reflection).toHaveValue(firstText); await reflection.fill(secondText); await click(button('保存解释修订'));
    const second = await until('second immutable explanation is protected', local, snapshot => notes(snapshot).some(item => item.note.text === secondText));
    const revised = notes(second).find(item => item.note.text === secondText);
    equal(revised.note.parentNoteId, original.note.noteId); equal(revised.note.requestId, firstCase.requestId);
    check(revised.note.noteId !== original.note.noteId, 'revision appends a new immutable note');
    equal(notes(second).find(item => item.note.noteId === original.note.noteId).file, original.file, 'first revision bytes are unchanged');
    for (const item of [original, revised]) { equal(item.file.objectId, item.note.noteId); equal(item.file.contentId, item.note.noteId); }
    const service = await until('both notes are retained by original works owner', remoteWorks,
      view => [original, revised].every(item => view.files.some(file => file.contentId === item.file.contentId && file.value === item.file.value)));
    await click(tool().locator('.alu-reflection').filter({ has: page.getByText(secondText, { exact: true }) }).getByRole('button', { name: '解释加入问题', exact: true }));
    await draftCopies('reflections', draft => semantic(draft, 'alu-reflection').filter(ref => [original.note.noteId, revised.note.noteId].includes(ref.source.objectId)
      && ref.copy.startsWith('ALU 解释修订') && ref.copy.includes(firstText)).length === 2);
    // Revisiting the earlier note must branch from that selected note, even though a newer
    // revision exists. The original two notes and their already-selected copies remain fixed.
    const branchText = firstText + ' 从第一次解释继续：这次明确保留原来的选择依据。';
    await click(firstView.getByRole('button', { name: '在此基础上修订', exact: true }));
    await reflection.fill('');
    await reflection.fill(branchText); await click(button('保存解释修订'));
    const branched = await until('selected earlier explanation establishes its own parent', local,
      value => notes(value).some(item => item.note.text === branchText));
    const branch = notes(branched).find(item => item.note.text === branchText);
    equal(branch.note.parentNoteId, original.note.noteId, 'the selected earlier parent is not replaced by the newest note');
    equal(notes(branched).find(item => item.note.noteId === revised.note.noteId).file, revised.file);
    await until('branched explanation is retained by its owner', remoteWorks,
      value => value.files.some(file => file.contentId === branch.file.contentId && file.value === branch.file.value));
    await evidence('immutable-reflections-service', service); await screenshot('explanation-revisions'); return { originalNoteId: original.note.noteId, revisedNoteId: revised.note.noteId };
  });
  await step('waveform', async () => {
    const artifact = await browserApi(`executions/${activity.activityId}/${firstCase.requestId}/artifact`);
    const trace = artifact.resources.filter(item => item.name === 'trace.vcd'); equal(trace.length, 1);
    equal(hash(trace[0].text), trace[0].sha256); equal(Buffer.byteLength(trace[0].text), trace[0].byteLength);
    check(trace[0].text.includes('$enddefinitions'), 'original VCD has declarations');
    const rawTicks = [...trace[0].text.matchAll(/^#(\d+)\s*$/gm)].map(match => BigInt(match[1]));
    check(rawTicks.length > 0, 'real VCD contains timestamps');
    const lastTick = rawTicks.reduce((max, tick) => tick > max ? tick : max, 0n).toString();
    const wave = tool().getByRole('region', { name: '实验波形', exact: true }); await expect(wave).toBeVisible({ timeout: T.ui });
    const names = await wave.getByRole('checkbox').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label').replace(/^选择 /, '')));
    const signalIds = ['F', 'Cout'].map(name => names.find(id => id.split('.').at(-1).replace(/\[[^\]]+\]$/, '') === name)).filter(Boolean);
    check(signalIds.length >= 1, 'real F or Cout signal exists');
    for (const id of signalIds) {
      const checkbox = wave.getByRole('checkbox', { name: `选择 ${id}`, exact: true });
      if (!await checkbox.isVisible()) await click(wave.locator('.alu-waveform__signals > summary'));
      await checkbox.check();
    }
    await wave.getByLabel('起始 tick', { exact: true }).fill('0'); await wave.getByLabel('结束 tick', { exact: true }).fill(lastTick);
    await click(wave.getByRole('button', { name: '查看范围', exact: true }));
    originalWave = { requestId: firstCase.requestId, range: { signalIds: signalIds.sort(), fromTick: '0', toTick: lastTick } };
    await until('exact waveform selection is protected', local, value => {
      const saved = localState(value).waveSelection;
      return Boolean(saved) && JSON.stringify(JSON.parse(saved)) === JSON.stringify(originalWave);
    });
    const bounds = await wave.locator('.alu-waveform__bounds').innerText();
    await wave.getByLabel('显示缩放', { exact: true }).selectOption('4');
    equal(await wave.locator('.alu-waveform__bounds').innerText(), bounds, 'display scaling preserves original ticks');
    equal(JSON.parse(localState(await local()).waveSelection), originalWave);
    await click(wave.getByRole('button', { name: '引用波形', exact: true }));
    const copies = await draftCopies('waveform', draft => semantic(draft, 'alu-waveform').some(ref => ref.source.requestId === firstCase.requestId));
    verifyWaveCopy(trace[0].text, semantic(copies.local, 'alu-waveform').at(-1), originalWave.range);
    await writeFile(join(output, 'evidence', 'original-trace.vcd'), trace[0].text); report.evidence.push('evidence/original-trace.vcd');
    await screenshot('selected-real-waveform'); return { ...originalWave, sha256: trace[0].sha256, byteLength: trace[0].byteLength };
  });
  await step('prior-sources', async () => {
    await newCase(BOUNDARY, { F: '0000', Cout: '1', reason: '再次使用同一作品与输入；已见原观察，保留来源。', purpose: 'boundary' });
    const repeated = await compare(), capture = caseCapture(repeated.action);
    check(capture.draft.priorSources.some(source => source.requestId === firstCase.requestId && source.inputDigest === firstCase.inputDigest
      && source.executionRef === firstCase.executionRef && source.kind === 'same-input-observation'), 'repeat names the real original observation');
    await expect(tool().getByText(/不作为独立预测/, { exact: false }).last()).toBeVisible();
    await synced(repeated.requestId); await evidence('repeated-case-action', repeated.action); return { requestId: repeated.requestId, priorSources: capture.draft.priorSources };
  });
  await step('operation', async () => {
    const reason = 'XOR 应突出 A 与 B 不同的位，能与 AND 或 OR 区分。';
    await newCase(OPERATION, { F: '0110', Cout: '0', reason, purpose: 'operation' }); operationCase = await compare();
    equal(operationCase.query.output.output.f, '0110'); equal(operationCase.query.output.output.cout, '0');
    equal(caseCapture(operationCase.action).draft.purpose, 'operation');
    await comparison(operationCase, { F: '0110', Cout: '0', predictedF: '0110', predictedCout: '0', reason });
    await synced(operationCase.requestId); await screenshot('operation-distinction'); return { requestId: operationCase.requestId };
  });
  await step('blank', async () => {
    await newCase({ A: 8, B: 2, M: 0, S: 1, Cin: 0 }); const blank = await compare(), capture = caseCapture(blank.action);
    equal(capture.draft.predictedF, ''); equal(capture.draft.predictedCout, ''); equal(capture.draft.reason, '');
    equal(blank.query.output.output.f, '0000'); equal(blank.query.output.output.cout, '0');
    await comparison(blank, { F: '0000', Cout: '0', predictedF: '', predictedCout: '', reason: '' });
    await expect(tool().getByRole('table', { name: '预测与实际比较' })).toContainText('未填写预测');
    await synced(blank.requestId); await screenshot('blank-prediction'); return { requestId: blank.requestId, missingFields: ['predictedF', 'predictedCout', 'reason'] };
  });
  await step('restore', async () => {
    await chooseCase(firstCase.requestId);
    await tool().getByLabel('实验解释', { exact: true }).fill('未保存的解释草稿：下一步核对不同输入与进位的关系。');
    await until('reflection draft is protected before changing the candidate', local,
      value => localState(value).reflectionDraft === '未保存的解释草稿：下一步核对不同输入与进位的关系。');
    await newCase({ A: 7, B: 2, M: 1, S: 0, Cin: 0 }, { F: '1001', Cout: '0', reason: '刷新后继续核对的新预测草稿。', purpose: 'custom' });
    const before = await until('all restore fields are locally protected', local, value => localState(value).reflectionDraft.includes('未保存的解释草稿'));
    const pick = snapshot => { const state = localState(snapshot); return { ...controls(state), caseDraft: JSON.parse(state.caseDraft),
      reflectionDraft: state.reflectionDraft, reflectionFor: state.reflectionFor, waveSelection: JSON.parse(state.waveSelection) }; };
    const expected = pick(before); const draftBefore = localDraft(before);
    equal(expected.waveSelection, originalWave);
    await until('candidate state reaches original works owner', remoteWorks, view => stateOf(view.files).caseDraft === localState(before).caseDraft);
    await draftCopies('before-refresh', draft => draft.references.length === draftBefore.references.length);
    await tab('作品'); await tab('ALU 实验'); equal(pick(await local()), expected, 'tool switching preserves every protected draft');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: T.ui });
    await expect(page.locator('#activity-title')).toHaveText(activity.course.taskTitle, { timeout: T.ui });
    await tab('ALU 实验'); await expect(button('新用例')).toBeEnabled({ timeout: T.preparation });
    const after = await until('reopened workspace restores candidate state', local, snapshot => localState(snapshot).caseDraft === localState(before).caseDraft);
    equal(pick(after), expected); equal(localDraft(after).references, draftBefore.references); equal(localDraft(after).question, question);
    await expect(tool().getByLabel('预测 F', { exact: true })).toHaveValue('1001');
    await expect(tool().getByLabel('选择这组输入的理由', { exact: true })).toHaveValue(expected.caseDraft.reason);
    await noAutoObserve(after); equal(ids(await local()), ids(before), 'reload and tool switching do not create executions');
    await chooseCase(firstCase.requestId);
    await expect(tool().getByLabel('实验解释', { exact: true })).toHaveValue(expected.reflectionDraft);
    await expect(tool().getByLabel('起始 tick', { exact: true })).toHaveValue('0');
    await expect(tool().getByLabel('结束 tick', { exact: true })).toHaveValue(originalWave.range.toTick);
    equal(JSON.parse(localState(await local()).waveSelection), originalWave);
    await evidence('restore-before', before); await evidence('restore-after', after); await screenshot('restored-drafts');
    return { preserved: ['inputs', 'prediction', 'reflectionDraft', 'waveSelection', 'references', 'question'], executionsBefore: ids(before), executionsAfter: ids(after) };
  });

  await step('layout', async () => {
    const before = await local(), originalDraft = localDraft(before), measurements = [];
    const materials = page.getByRole('button', { name: '目标与材料', exact: true });
    if (await materials.getAttribute('aria-expanded') === 'true') await click(materials);
    try {
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme, { timeout: T.ui });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await tool().getByRole('heading', { name: '比较与解释', exact: true }).scrollIntoViewIfNeeded();
        await screenshot(`theme-${scheme}-1440`);
        measurements.push(await page.evaluate(() => ({ width: innerWidth, theme: document.documentElement.dataset.theme,
          ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
          paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() })));
      }
      for (const width of [1024, 900]) {
        await page.setViewportSize({ width, height: 1000 });
        const prediction = tool().getByLabel('预测 F', { exact: true }); await prediction.focus(); await page.keyboard.press('Tab');
        await expect(tool().getByLabel('预测 Cout', { exact: true })).toBeFocused();
        const focused = await page.evaluate(() => { const value = getComputedStyle(document.activeElement);
          return { label: document.activeElement.getAttribute('aria-label'), outlineStyle: value.outlineStyle, outlineWidth: value.outlineWidth }; });
        check(focused.outlineStyle !== 'none' && parseFloat(focused.outlineWidth) > 0, 'keyboard focus remains visibly outlined');
        await screenshot(`keyboard-and-prediction-${width}`);
        await tool().getByRole('heading', { name: '比较与解释', exact: true }).scrollIntoViewIfNeeded();
        await expect(tool().getByLabel('用例记录', { exact: true })).toBeVisible();
        await screenshot(`comparison-and-waveform-${width}`); measurements.push({ width, focused });
      }
      const after = await local(); equal(ids(after), ids(before), 'theme/layout/keyboard navigation does not execute experiments');
      equal(referenceInputs(localDraft(after).references), referenceInputs(originalDraft.references)); equal(localDraft(after).question, originalDraft.question);
      await evidence('layout-measurements', measurements); return { measurements, systemColorSchemeEmulated: true };
    } finally { await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 1440, height: 1000 }); }
  });

  // Fault extensions below use this same real browser, workspace, Worker and endpoint.
  if (suite === 'all') await runFaults();

  await step('network-unsent', async () => {
    const snapshot = await local();
    equal(questionSends, [], 'no question dispatch HTTP request');
    equal((snapshot.actions ?? []).filter(item => !item.input?.execution), [], 'no question action was silently created');
    equal([...origins].sort(), [endpoint], 'browser HTTP traffic uses the real selected origin only');
    check(workerUrls.size > 0, 'real browser Workers were observed');
    equal(faultGate, undefined, 'no fault gate remains armed');
    equal(localDraft(snapshot).question, question); equal(browserErrors, [], 'page has no uncaught execution or reference errors');
    await draftCopies('final-draft', draft => semantic(draft, 'alu-case').length > 0 && semantic(draft, 'alu-observation').length > 0
      && semantic(draft, 'alu-reflection').length >= 2 && semantic(draft, 'alu-waveform').length > 0 && draft.references.some(ref => ref.range.kind === 'code'));
    return { origins: [...origins], workers: [...workerUrls], questionSends: 0, questionActions: 0 };
  });
} catch (error) { report.status = 'failed'; report.error = safeError(error); }
finally {
  if (faultGate) try { await faultGate.release(); } catch (error) { report.cleanup.push({ stage: 'fault-release', status: 'failed', error: safeError(error) }); }
  let drained = true;
  if (page && activity) {
    try {
      const detail = await drainOriginalExecutions(Boolean(report.error));
      report.cleanup.push({ stage: 'execution-and-sync-drain', status: 'passed', ...detail });
    } catch (error) {
      drained = false;
      report.cleanup.push({ stage: 'execution-and-sync-drain', status: 'failed', error: safeError(error) });
      report.recovery = { browserKeptOpen: true, runtimeKeptRunning: Boolean(runtime), temporaryRoot: root,
        reason: 'Original local execution or owner synchronization is not confirmed. Browser/Worker/IDB are retained for recovery; no forced close or environment removal.' };
      try { await evidence('cleanup-drain-blocked', await local({ allowMissing: true })); await screenshot('cleanup-drain-blocked'); }
      catch (captureError) { report.cleanup.push({ stage: 'cleanup-evidence', status: 'failed', error: safeError(captureError) }); }
    }
  }
  if (drained) try { await browser?.close(); } catch (error) { report.cleanup.push({ stage: 'browser-close', status: 'failed', error: safeError(error) }); }
  await Promise.allSettled([...pendingNetwork]);
  if (runtime && drained) {
    try { await runtime.stop(); report.cleanup.push({ stage: 'runtime.stop', status: 'passed' }); }
    catch (error) { report.cleanup.push({ stage: 'runtime.stop', status: 'failed', error: safeError(error) }); }
    let environmentId;
    try { environmentId = (await runtime.status()).environment.environmentId; }
    catch (error) {
      // Installation persists its owner identity before native database preparation. Keep using
      // that identity for a partial install; never rm a runtime environment behind its owner.
      try { environmentId = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8')).environmentId; }
      catch { report.cleanup.push({ stage: 'partial-install-identity', status: 'failed', error: safeError(error) }); }
    }
    if (environmentId) {
      try { await runtime.deleteEnvironment({ environmentId }); report.cleanup.push({ stage: 'runtime.deleteEnvironment', status: 'passed', environmentId }); }
      catch (error) { report.cleanup.push({ stage: 'runtime.deleteEnvironment', status: 'failed', environmentId, error: safeError(error) }); }
    }
  }
  for (const item of report.cases) if (item.status === 'not-run') item.reason = item.group === 'fault' && suite === 'core'
    ? 'Fault suite not selected (XUNJIE_ALU_SUITE=core).' : 'A preceding step failed before this assertion could run.';
  report.summary = Object.fromEntries(['passed', 'failed', 'not-run'].map(status => [status, report.cases.filter(item => item.status === status).length]));
  report.cleanupError = report.cleanup.filter(item => item.status === 'failed');
  report.corePassed = report.cases.filter(item => item.group === 'core').every(item => item.status === 'passed');
  report.acceptanceComplete = report.cases.every(item => item.status === 'passed') && report.cleanupError.length === 0;
  report.status = report.error || report.summary.failed || report.cleanupError.length ? 'failed' : report.acceptanceComplete ? 'passed' : 'partial';
  report.finishedAt = new Date().toISOString(); report.origins = [...origins]; report.workers = [...workerUrls];
  await writeFile(join(output, 'report.json'), JSON.stringify(scrub(report), null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, corePassed: report.corePassed, cases: report.summary, report: join(output, 'report.json') }));
  process.exitCode = report.status === 'failed' ? 1 : report.acceptanceComplete ? 0 : 2;
}

async function runFaults() {
  await step('accept-loss', async () => {
    await newCase(OPERATION, { F: '0110', Cout: '0', reason: '接收确认未知期间只切换历史，不改挂新结果。', purpose: 'operation' });
    const before = await local(), gate = await armFault({ id: 'accept-loss', kind: 'accept', after: true, exclude: ids(before) });
    try {
      const record = await compare(); await gate.hit(); equal(gate.data.requestId, record.requestId);
      check((await history()).some(entry => entry.action.requestId === record.requestId), 'real owner received command before its reply was lost');
      // Select genuine, already retained cases rapidly while the original service ACK is unknown.
      await chooseCase(firstCase.requestId); await chooseCase(operationCase.requestId); await chooseCase(firstCase.requestId);
      const selected = localState(await local()).selectedCase; equal(selected, firstCase.requestId);
      const acceptedIds = ids(await local()); equal(acceptedIds.length, ids(before).length + 1);
      await gate.release(); await synced(record.requestId); await page.waitForTimeout(1600);
      equal(ids(await local()), acceptedIds, 'lost accept ACK must not create another local command');
      equal(localState(await local()).selectedCase, selected, 'late acceptance must not replace the explicit latest history selection');
      await evidence('accept-loss-local', await local()); await screenshot('accept-loss-history'); return gate.data;
    } finally { await gate.release(); }
  });
  await step('local-result', async () => {
    await newCase(BOUNDARY, { F: '0000', Cout: '1', reason: '服务结果暂未收到时保留本机观察与引用。', purpose: 'boundary' });
    const before = await local(), gate = await armFault({ id: 'local-result', kind: 'result', after: false, exclude: ids(before) });
    try {
      const record = await compare(); await gate.hit(); equal(gate.data.requestId, record.requestId);
      const localBefore = await local(), sync = localBefore.executionSync.find(item => item.requestId === record.requestId);
      check(!sync?.result, 'service result is still unconfirmed');
      check(localBefore.executionResults.some(item => item.requestId === record.requestId && item.executionRef === record.executionRef), 'real result bytes already exist in local IDB');
      const service = await browserApi(`executions/${activity.activityId}/${record.requestId}`);
      check(!service?.output, 'school/product owner has not received this result');
      await click(button('结果加入问题'));
      const protectedDraft = await until('local result reference waits in the original draft partition', local, value => {
        const draft = localDraft(value); return semantic(draft, 'alu-observation').some(ref => ref.source.requestId === record.requestId)
          && draft.pending && !draft.pendingRejected;
      });
      const reference = semantic(localDraft(protectedDraft), 'alu-observation').find(ref => ref.source.requestId === record.requestId);
      equal(reference.source.executionRef, record.executionRef); equal(reference.source.contentId, record.query.output.contentId);
      check(reference.copy.includes('实际：F=0000，Cout=1'), 'pending copy contains genuine local result');
      check(!semantic(await remoteDraft(), 'alu-observation').some(ref => ref.source.requestId === record.requestId), 'server has not falsely confirmed the local-only reference');
      await evidence('local-result-pending', protectedDraft); await screenshot('local-result-pending');
      const acceptedIds = ids(protectedDraft), startedAt = record.startedAt;
      await gate.release(); const confirmed = await synced(record.requestId);
      await draftCopies('local-result-confirmed', draft => semantic(draft, 'alu-observation').some(ref => ref.source.requestId === record.requestId));
      await page.waitForTimeout(1500); const after = await local(); equal(ids(after), acceptedIds, 'result synchronization never creates another computation');
      equal(after.executionCommands.find(item => item.requestId === record.requestId).startedAt, startedAt, 'same local execution claim');
      equal((await history()).filter(item => item.action.requestId === record.requestId).length, 1, 'one original owner command');
      equal(confirmed.query.output.contentId, record.query.output.contentId); await evidence('local-result-confirmed', after);
      return { ...gate.data, requestId: record.requestId, executionRef: record.executionRef, contentId: record.query.output.contentId };
    } finally { await gate.release(); }
  });
  await step('retain-loss', async () => {
    await newCase(OPERATION, { F: '0110', Cout: '0', reason: '保留确认丢失后只核对原结果，不重新仿真。', purpose: 'operation' });
    const before = await local(), gate = await armFault({ id: 'retain-loss', kind: 'result', after: true, exclude: ids(before) });
    try {
      const record = await compare(); await gate.hit(); equal(gate.data.requestId, record.requestId);
      const retained = await browserApi(`executions/${activity.activityId}/${record.requestId}/artifact`);
      equal(retained.requestId, record.requestId); equal(retained.executionRef, record.executionRef);
      equal(retained.sha256, record.query.output.artifact.sha256); equal(hash(retained.text), retained.sha256);
      const accepted = await local(), original = accepted.executionCommands.find(item => item.requestId === record.requestId);
      check(!accepted.executionSync.find(item => item.requestId === record.requestId)?.result, 'local ledger has no fabricated retention confirmation');
      await evidence('retain-loss-before-confirmation', accepted);
      await gate.release(); await synced(record.requestId); await page.waitForTimeout(1500);
      const after = await local(), recovered = after.executionCommands.find(item => item.requestId === record.requestId);
      equal(ids(after), ids(accepted)); equal(recovered.startedAt, original.startedAt); equal(recovered.stoppedAt, original.stoppedAt);
      equal(recovered.query.output.contentId, original.query.output.contentId, 'retry retains the original output identity');
      equal(gate.data.aborts, 1); await screenshot('retention-confirmation-recovered'); return gate.data;
    } finally { await gate.release(); }
  });
  await step('final-report-lag', async () => {
    await newCase(BOUNDARY, { F: '0000', Cout: '1', reason: '结果先到而服务终态滞后，引用继续等待原确认。', purpose: 'boundary' });
    const before = await local(), gate = await armFault({ id: 'final-report-lag', kind: 'report', after: false,
      exclude: ids(before), predicate: body => body?.state === 'succeeded' });
    try {
      const record = await compare(); await gate.hit(); equal(gate.data.requestId, record.requestId);
      const retained = await browserApi(`executions/${activity.activityId}/${record.requestId}/artifact`);
      equal(retained.sha256, record.query.output.artifact.sha256);
      const serviceBefore = await browserApi(`executions/${activity.activityId}/${record.requestId}`);
      check(!['succeeded', 'failed', 'cancelled'].includes(serviceBefore.state), 'service terminal fact is genuinely still blocked');
      const attempted = page.waitForResponse(response => {
        const request = response.request();
        if (request.method() !== 'POST' || new URL(response.url()).pathname !== `/api/learning/drafts/${activity.activityId}`) return false;
        try { return request.postDataJSON().references?.some(ref => ref.range?.typeId === 'alu-observation' && ref.source?.requestId === record.requestId); }
        catch { return false; }
      }, { timeout: T.sync });
      await click(button('结果加入问题'));
      const rejectedTemporarily = await attempted;
      equal(rejectedTemporarily.status(), 503, 'the real owner attempts validation before the terminal gate is released');
      equal((await rejectedTemporarily.json()).error, 'unavailable', 'valid local source remains explicitly retryable');
      const waiting = await until('valid local copy remains retryable while the owner awaits the terminal report', local,
        value => semantic(localDraft(value), 'alu-observation').some(ref => ref.source.requestId === record.requestId)
          && localDraft(value).pending && !localDraft(value).pendingRejected);
      check(!semantic(await remoteDraft(), 'alu-observation').some(ref => ref.source.requestId === record.requestId), 'no false remote confirmation');
      await evidence('terminal-report-pending-local', waiting); await evidence('terminal-report-pending-owner', serviceBefore);
      const originalIds = ids(waiting); await gate.release(); await synced(record.requestId);
      await draftCopies('terminal-report-confirmed', draft => semantic(draft, 'alu-observation').some(ref => ref.source.requestId === record.requestId));
      equal(ids(await local()), originalIds, 'terminal report recovery does not run the simulator again'); return gate.data;
    } finally { await gate.release(); }
  });
  await step('draft-loss', async () => {
    const nextQuestion = question + '\n故障验收：只核对原草稿回执，不发送。';
    const before = await local(), gate = await armFault({ id: 'draft-loss', kind: 'drafts', after: true,
      predicate: body => body.question === nextQuestion });
    try {
      await page.getByLabel('你的问题', { exact: true }).fill(nextQuestion); await gate.hit(); question = nextQuestion;
      const saved = await remoteDraft(); equal(saved.question, nextQuestion, 'real draft was committed before its response was aborted');
      const waiting = await local(); equal(localDraft(waiting).question, nextQuestion);
      equal(localDraft(waiting).pending?.requestId, gate.data.requestId, 'unknown confirmation keeps the original draft request');
      await evidence('draft-ack-lost', waiting); await gate.release();
      await until('original draft receipt settles', local, value => !localDraft(value).pending && localDraft(value).question === nextQuestion);
      const receipt = await browserApi(`drafts/${activity.activityId}/receipts/${gate.data.requestId}`);
      equal(receipt.revision, gate.data.baseRevision + 1); equal(receipt.question, nextQuestion);
      equal((await remoteDraft()).revision, receipt.revision, 'reconciliation does not append a duplicate draft revision');
      equal(ids(await local()), ids(before), 'draft confirmation cannot run the simulator');
      await draftCopies('draft-ack-recovered', draft => draft.references.length === saved.references.length); return gate.data;
    } finally { await gate.release(); }
  });
  await step('works-loss', async () => {
    await chooseCase(firstCase.requestId);
    const text = '作品回执丢失期间的解释草稿：仍属于原用例，等待同一同步身份确认。';
    const before = await local(), gate = await armFault({ id: 'works-loss', kind: 'workspaces', after: true,
      predicate: body => stateOf(body.files).reflectionDraft === text });
    try {
      await tool().getByLabel('实验解释', { exact: true }).fill(text); await gate.hit();
      equal(stateOf((await remoteWorks()).files).reflectionDraft, text, 'real workspace commit preceded the lost response');
      const waiting = await local(); equal(localWork(waiting).pending?.requestId, gate.data.requestId);
      equal(localState(waiting).reflectionDraft, text); await evidence('works-ack-lost', waiting);
      await gate.release(); await until('original workspace receipt settles', local, value => !localWork(value).pending && localState(value).reflectionDraft === text);
      const receipt = await browserApi(`workspaces/${activity.activityId}/receipts/${gate.data.requestId}`);
      equal(receipt.revision, gate.data.baseRevision + 1); equal(stateOf(receipt.files).reflectionDraft, text);
      equal(ids(await local()), ids(before), 'workspace receipt recovery does not compile or run');
      await screenshot('works-confirmation-recovered'); return gate.data;
    } finally { await gate.release(); }
  });
  await step('four-state', async () => {
    const source = `// #194 probe four-state fixture\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output wire [3:0] F,output wire Cout); assign F=A[0]?4'bzzzz:4'bxxxx; assign Cout=A[0]?1'bz:1'bx; endmodule\n`;
    await newCase({ A: 0, B: 0, M: 0, S: 0, Cin: 0 }); await enable(source);
    const records = [];
    for (const [A, f, cout] of [[0, 'xxxx', 'x'], [1, 'zzzz', 'z']]) {
      const reason = `保留真实 ${A ? 'Z 高阻' : 'X 未知'}，不把它当零。`;
      await newCase({ A, B: 0, M: 0, S: 0, Cin: 0 }, { F: '0000', Cout: '0', reason, purpose: 'custom' });
      const record = await compare(); equal(record.query.output.output.f.toLowerCase(), f); equal(record.query.output.output.cout.toLowerCase(), cout);
      equal(record.query.output.output.observationState, 'complete-with-unknown');
      await comparison(record, { F: record.query.output.output.f, Cout: record.query.output.output.cout, predictedF: '0000', predictedCout: '0', reason });
      await expect(tool().getByRole('table', { name: '预测与实际比较' })).toContainText('不能作二值比较');
      await synced(record.requestId); records.push({ requestId: record.requestId, f, cout });
    }
    await screenshot('real-x-z'); return { records };
  });
  await step('compile-failure', async () => {
    await newCase({ A: 0, B: 0, M: 0, S: 0, Cin: 0 });
    const before = JSON.parse(localState(await local()).enabledBasis);
    const broken = `// #194 intentionally invalid compiler fixture\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); this is deliberately invalid SystemVerilog; endmodule\n`;
    const record = await enable(broken, 'failed');
    check(record.query.reason, 'real compiler failure has a reason');
    equal(JSON.parse(localState(await local()).enabledBasis), before, 'failed compile cannot become the enabled work');
    check(!/^[01]{4}$/.test(record.query.output?.output?.f ?? ''), 'failed compilation does not publish fabricated binary F');
    await expect(tool().locator('.alu-readout-value')).not.toContainText(/F=[01]{4}|Cout=[01]/);
    await evidence('real-compile-failure', record); await screenshot('real-compile-failure'); return { requestId: record.requestId, reason: record.query.reason };
  });
  await step('incomplete', async () => {
    // Safe A=0 really enables this work. Only a later A=15 compare enters the bounded Worker
    // failure, so the result cannot accidentally come from the previous enabled fixture.
    const conditional = `// #194 safe enable, conditional zero-time simulation failure\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); always @* begin F=0;Cout=0; if(A==4'hf) begin forever begin F=~F; end end else begin {Cout,F}={1'b0,A}+{1'b0,B}+Cin; end end endmodule\n`;
    await newCase({ A: 0, B: 0, M: 1, S: 0, Cin: 0 }); const enabled = await enable(conditional);
    equal(enabled.query.output.output.f, '0000');
    const originalReason = '让已启用作品在此输入暴露执行未完成，不得以旧观察冒充。';
    await newCase(BOUNDARY, { F: '0000', Cout: '1', reason: originalReason, purpose: 'boundary' });
    const before = ids(await local()); await expect(button('运行并比较')).toBeEnabled({ timeout: T.execution });
    await click(button('运行并比较')); const command = await nextCommand(before, 'observe-enabled');
    await until('original incomplete execution actually starts', local, value => value.executionCommands.some(item => item.requestId === command.requestId
      && item.startedAt !== null && item.query.state === 'running'));
    const editedReason = '执行期间的新理由草稿：先停止原执行再检查；不覆盖原固定理由。';
    await tool().getByLabel('选择这组输入的理由', { exact: true }).fill(editedReason);
    await until('editing suppresses output while keeping the original execution accessible', local,
      value => localState(value).feedbackPolicy === 'hold' && JSON.parse(localState(value).caseDraft).reason === editedReason);
    await expect(button('停止原执行')).toBeVisible({ timeout: T.ui });
    await click(button('核对原执行')); await click(button('停止原执行'));
    const record = await settledRecord(command.requestId, 'cancelled');
    check(record.query.stopRequested, 'real controller recorded stop for the original request');
    check(record.query.reason, 'incomplete observation has its original stop reason');
    equal(caseCapture(record.action).draft.reason, originalReason);
    equal(JSON.parse(localState(await local()).caseDraft).reason, editedReason, 'stopping preserves the newer reason draft');
    equal(record.action.execution.basis.enabledBy.requestId, enabled.requestId, 'failed compare cites the safe run of this exact work');
    check(!/^[01]{4}$/.test(record.query.output?.output?.f ?? ''), 'failed execution never supplies a binary actual');
    await noAutoObserve(await local(), 800);
    // Keep the candidate safe before exposing the stopped historical case; selecting it remains
    // a history read and never feeds its A=15 back into the actual controls.
    await numeric('A', 0); await chooseCase(record.requestId);
    const table = tool().getByRole('table', { name: '预测与实际比较' }); await expect(table).toBeVisible({ timeout: T.ui });
    await expect(table.locator('tbody tr').nth(0).locator('td').nth(1)).toHaveText('未取得');
    await expect(table.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText('未取得');
    await expect(tool().locator('.alu-readout-value')).not.toContainText(/F=[01]{4}|Cout=[01]/);
    await synced(record.requestId); await evidence('real-incomplete-comparison', record); await screenshot('real-incomplete-comparison');
    // Leave the isolated probe activity usable without changing any retained note/reference.
    await newCase({ A: 0, B: 0, M: 1, S: 0, Cin: 0 }); await enable(CORRECT);
    return { requestId: record.requestId, enabledFrom: enabled.requestId, reason: record.query.reason, heldStopUi: true };
  });
  await step('two-tabs', async () => {
    const before = await local(), draft = await remoteDraft();
    const { probeAluLearningTwoTabs } = await import('./lib/alu-learning-two-tabs.mjs');
    const detail = await probeAluLearningTwoTabs({ page, context, activityId: activity.activityId, output });
    equal(detail.passed, true, 'independent helper completed its real CAS and UI assertions');
    // The helper owns the genuine CAS conflict and explicit selection assertions. These independent
    // postconditions also keep this probe's question and execution accounting in the same scope.
    const after = await local(), remote = await remoteDraft();
    equal(remote.question, draft.question); equal(remote.question, question);
    equal(referenceInputs(remote.references), referenceInputs(draft.references));
    equal(ids(after), ids(before), 'workspace conflict must not create an execution');
    equal(questionSends, []); await evidence('two-tabs-after', after);
    return { helper: 'scripts/lib/alu-learning-two-tabs.mjs', detail: detail ?? null };
  });
}

/** Intercept one exact owner's real request. No route.fulfill, synthetic response, or IDB write. */
async function armFault({ id, kind, after, exclude = [], predicate = () => true }) {
  check(!faultGate, 'faults cannot overlap');
  let started = false, released = false, releaseWait;
  const waiting = new Promise(resolve => { releaseWait = resolve; });
  const data = { id, kind, position: after ? 'after-real-owner-response' : 'before-owner-receives', aborts: 0, heldRetries: 0, status: 'armed' };
  report.faults.push(data);
  const inFlight = new Set();
  const handler = async route => {
    const task = (async () => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const execution = `/api/learning/executions/${activity.activityId}`;
      const base = ['accept', 'result', 'report'].includes(kind) ? execution : `/api/learning/${kind}/${activity.activityId}`;
      let body; try { body = request.postDataJSON(); } catch { /* GET has no JSON payload. */ }
      let requestId;
      if (kind === 'accept' && url.pathname === base && method === 'POST') requestId = body?.action?.requestId;
      if (kind === 'result' && url.pathname.startsWith(base + '/') && url.pathname.endsWith('/result') && method === 'POST')
        requestId = url.pathname.slice(base.length + 1).split('/')[0];
      if (kind === 'report' && url.pathname.startsWith(base + '/') && url.pathname.endsWith('/report') && method === 'POST')
        requestId = url.pathname.slice(base.length + 1).split('/')[0];
      if (['drafts', 'workspaces'].includes(kind) && url.pathname === base && method === 'POST') requestId = body?.requestId;
      const receipt = started && method === 'GET' && url.pathname === `${base}/receipts/${data.requestId}`;
      if (!started && requestId && !exclude.includes(requestId) && predicate(body, url)) {
        started = true; data.requestId = requestId; data.baseRevision = body?.baseRevision;
      } else if (started && (requestId === data.requestId || receipt)) {
        data.heldRetries++; await waiting; await route.continue(); return;
      } else { await route.continue(); return; }
      try {
        if (after) {
          const upstream = await route.fetch({ maxRedirects: 0, timeout: T.sync });
          data.upstreamStatus = upstream.status(); assert.equal(upstream.status(), 200, 'fault must discard a real successful owner response');
          // The actual owner response is discarded, never replaced by a fabricated success.
          await upstream.dispose();
        }
        await route.abort('failed'); data.aborts++; data.status = 'aborted-once';
      } catch (error) {
        data.error = safeError(error); data.status = 'failed';
        await route.abort('failed').catch(() => {});
      }
    })();
    inFlight.add(task);
    try { await task; } catch (error) { data.error = safeError(error); data.status = 'failed'; }
    finally { inFlight.delete(task); }
  };
  const gate = {
    data,
    async hit() {
      await until(`precise ${id} fault is reached`, async () => data, value => value.aborts === 1 || value.error);
      check(!data.error, `fault injector failed: ${data.error ?? ''}`); equal(data.aborts, 1);
      if (after) equal(data.upstreamStatus, 200);
    },
    async release() {
      if (released) return;
      released = true; releaseWait();
      // This isolated context has only this gate's route. Let held handlers finish their
      // real continuation before removing it; unroute() alone can auto-handle them twice.
      await context.unrouteAll({ behavior: 'wait' }); await Promise.allSettled([...inFlight]);
      if (faultGate === gate) faultGate = undefined;
      if (data.error) throw new Error(data.error);
      data.status = data.aborts === 1 ? 'released-after-one-abort' : 'released-before-hit';
    },
  };
  await context.route(faultPattern, handler); faultGate = gate; return gate;
}

/** Keep the original executor alive until genuine terminal facts and their original owner copies agree. */
async function drainOriginalExecutions(stopOnFailure) {
  const started = Date.now(), stopped = new Set(), replayed = new Set(); let stableSince = Date.now(), previousIds = '', last;
  const recoveryDelay = mode === 'school-https' ? 30000 : 15000;
  const terminal = record => record.query.statusKnowledge === 'confirmed' && ['succeeded', 'failed', 'cancelled'].includes(record.query.state);
  const drained = await until('original local executions and owner synchronization drain before closing Chrome', async () => {
    const snapshot = await local({ allowMissing: true }), remote = await history();
    const commands = snapshot.executionCommands ?? [];
    const currentIds = JSON.stringify(commands.map(record => record.requestId).sort());
    if (currentIds !== previousIds) { previousIds = currentIds; stableSince = Date.now(); }
    const active = commands.filter(record => !terminal(record));
    if (stopOnFailure && active.length && Date.now() - started > 3000) {
      // Both controls invoke the original controller.stop. Never flip hold to live merely to
      // expose a stop control; that could create an unwanted automatic observation.
      const heldStop = button('停止原执行');
      if (await heldStop.isVisible() && await heldStop.isEnabled()) {
        for (const record of active) stopped.add(record.requestId);
        await click(heldStop);
      }
      const panel = tool().getByRole('region', { name: '计算记录', exact: true });
      if (await panel.isVisible()) {
        const stops = panel.getByRole('button', { name: '停止', exact: true });
        for (let index = await stops.count() - 1; index >= 0; index--) {
          const locator = stops.nth(index);
          if (await locator.isVisible() && await locator.isEnabled()) {
            for (const record of active) stopped.add(record.requestId);
            await click(locator);
          }
        }
      }
    }
    const waiting = [];
    for (const record of commands) {
      const original = remote.find(item => item.action.requestId === record.requestId);
      const sync = snapshot.executionSync.find(item => item.requestId === record.requestId);
      const stopIds = (snapshot.executionStops ?? []).filter(stop => stop.requestId === record.requestId).map(stop => stop.stopId);
      if (!terminal(record)) { waiting.push({ requestId: record.requestId, reason: 'local-not-terminal' }); continue; }
      if (!original || !sync?.command || record.query.output && !sync.result || sync.factSeq < record.query.confirmedSeq
        || original.query.confirmedSeq < record.query.confirmedSeq || stopIds.some(id => !sync.stopIds?.includes(id))) {
        if (Date.now() - started > recoveryDelay && !replayed.has(record.requestId)) {
          // Recovery is an idempotent retransmission of actual IDB material through the genuine
          // HTTP owner. The existing controller then confirms its own sync journal on retry.
          await restoreOriginalAssociation(snapshot, record); replayed.add(record.requestId);
        }
        waiting.push({ requestId: record.requestId, reason: 'owner-sync-pending' }); continue;
      }
      assert.equal(original.query.inputDigest, record.inputDigest, 'drain retains original command digest');
      assert.equal(original.query.executionRef, record.executionRef, 'drain retains original execution identity');
      assert.equal(original.query.state, record.query.state, 'owner has the actual local terminal outcome');
      assert.equal(original.query.statusKnowledge, 'confirmed', 'owner terminal outcome is confirmed');
      if (record.query.output) assert.equal(original.query.output?.contentId, record.query.output.contentId, 'owner retains original result identity');
    }
    const unreceived = (snapshot.actions ?? []).filter(item => item.input?.execution
      && !['accepted', 'cancelled', 'failed'].includes(item.phase) && !commands.some(record => record.requestId === item.input.requestId));
    waiting.push(...unreceived.map(item => ({ requestId: item.input.requestId, reason: 'original-action-not-settled' })));
    waiting.push(...remote.filter(item => item.query.statusKnowledge !== 'confirmed'
      || !['succeeded', 'failed', 'cancelled'].includes(item.query.state)).map(item => ({ requestId: item.action.requestId, reason: 'owner-not-terminal' })));
    for (const record of snapshot.workspaces ?? []) if (record.pending) waiting.push({ requestId: record.pending.requestId, reason: 'workspace-sync-pending' });
    for (const record of snapshot.drafts ?? []) if (record.pending) waiting.push({ requestId: record.pending.requestId, reason: 'draft-sync-pending' });
    last = { snapshot, remote, waiting };
    return { snapshot, remote, waiting, quiet: Date.now() - stableSince >= 1800 };
  }, value => !value.waiting.length && value.quiet, T.execution + T.sync).catch(error => {
    report.drainWaiting = last?.waiting ?? []; throw error;
  });
  for (const record of drained.snapshot.executionCommands) if (record.query.output) {
    const artifact = await browserApi(`executions/${activity.activityId}/${record.requestId}/artifact`);
    assert.ok(artifact, 'confirmed original result must remain readable before browser close');
    assert.equal(artifact.requestId, record.requestId); assert.equal(artifact.executionRef, record.executionRef);
    assert.equal(hash(artifact.text), record.query.output.artifact.sha256);
    for (const resource of artifact.resources ?? []) { assert.equal(hash(resource.text), resource.sha256); assert.equal(Buffer.byteLength(resource.text), resource.byteLength); }
  }
  await evidence('cleanup-drained-originals', { commands: drained.snapshot.executionCommands,
    sync: drained.snapshot.executionSync, service: drained.remote });
  return { requestIds: ids(drained.snapshot), stopRequestedThroughExistingUi: [...stopped], localDatabaseAbsent: Boolean(drained.snapshot.databaseMissing),
    originalAssociationsRetransmitted: [...replayed], durationMs: Date.now() - started };
}

async function restoreOriginalAssociation(snapshot, record) {
  const before = ids(snapshot), requestId = record.requestId, path = `executions/${activity.activityId}`;
  assert.equal(record.action.requestId, requestId); assert.equal(hash(JSON.stringify(record.action)), record.inputDigest);
  assert.equal(record.acceptance.receipt.inputDigest, record.inputDigest);
  assert.equal(record.acceptance.execution.executionRef, record.executionRef);
  assert.equal(record.query.statusKnowledge, 'confirmed');
  assert.ok(['succeeded', 'failed', 'cancelled'].includes(record.query.state), 'cannot invent a terminal outcome while restoring');
  const facts = (snapshot.executionPending ?? []).filter(item => item.requestId === requestId).map(item => item.query);
  if (!facts.some(query => query.confirmedSeq === record.query.confirmedSeq)) facts.push(record.query);
  facts.sort((left, right) => left.confirmedSeq - right.confirmedSeq);
  for (const query of facts) {
    assert.equal(query.requestId, requestId); assert.equal(query.inputDigest, record.inputDigest); assert.equal(query.executionRef, record.executionRef);
  }
  await evidence(`cleanup-original-${requestId}`, { record, facts,
    result: snapshot.executionResults.find(item => item.requestId === requestId && item.executionRef === record.executionRef) ?? null });
  const accepted = await browserApi(path, { action: record.action, acceptance: record.acceptance });
  assert.equal(accepted.executionRef, record.executionRef); assert.equal(accepted.inputDigest, record.inputDigest);
  for (const stop of (snapshot.executionStops ?? []).filter(item => item.requestId === requestId)) {
    assert.equal(stop.inputDigest, record.inputDigest);
    await browserApi(`${path}/${requestId}/stop`, { stopId: stop.stopId, reason: stop.reason });
  }
  const isTerminal = query => ['succeeded', 'failed', 'cancelled'].includes(query.state);
  // Reuse only recorded facts. In particular, never manufacture a running seq or stop fact.
  for (const query of facts.filter(query => !isTerminal(query))) await browserApi(`${path}/${requestId}/report`, query);
  if (record.query.output) {
    const result = snapshot.executionResults.find(item => item.requestId === requestId && item.executionRef === record.executionRef);
    assert.ok(result, 'original result bytes must exist for recovery');
    assert.equal(hash(result.text), result.sha256); assert.equal(Buffer.byteLength(result.text), result.byteLength);
    assert.equal(result.sha256, record.query.output.artifact.sha256);
    for (const resource of result.resources ?? []) { assert.equal(hash(resource.text), resource.sha256); assert.equal(Buffer.byteLength(resource.text), resource.byteLength); }
    await browserApi(`${path}/${requestId}/result`, { contentId: record.query.output.contentId, output: result.output,
      text: result.text, name: result.name, mediaType: result.mediaType, sha256: result.sha256, byteLength: result.byteLength,
      ...(result.resources?.length ? { resources: result.resources } : {}) });
  }
  for (const query of facts.filter(isTerminal)) await browserApi(`${path}/${requestId}/report`, query);
  const confirmed = await browserApi(`${path}/${requestId}`);
  assert.equal(confirmed.state, record.query.state); assert.equal(confirmed.statusKnowledge, 'confirmed');
  assert.equal(confirmed.executionRef, record.executionRef); assert.equal(confirmed.inputDigest, record.inputDigest);
  assert.equal(confirmed.output?.contentId, record.query.output?.contentId);
  assert.deepEqual(ids(await local()), before, 'recovery reuses the original command, with zero reruns');
  report.cleanup.push({ stage: 'restore-original-association', status: 'passed', requestId, executionRef: record.executionRef,
    confirmedSeqs: facts.map(query => query.confirmedSeq), reruns: 0 });
}
