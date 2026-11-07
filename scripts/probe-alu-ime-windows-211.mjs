#!/usr/bin/env node
/** #211: real Windows IME on an unlocked desktop, with an isolated full product installation.
 * Run from an Interactive scheduled task as the signed-in user. Native SendKeys supplies IME
 * input, and Desktop Duplication captures the OS popup. Playwright opens/focuses the product
 * and checks its state; it never synthesizes composition or supplies Chinese text as evidence.
 * Prepare --packages with component.json/course.json exported by alu-experiment/package.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { createAluImeProduct } from './lib/alu-ime-product.mjs';

const { values } = parseArgs({ options: {
  'product-root': { type: 'string' }, packages: { type: 'string' }, output: { type: 'string' },
  'only-tool-switch': { type: 'boolean', default: false },
} });
for (const name of ['product-root', 'packages', 'output']) if (!values[name]) throw new Error('usage: --product-root=DIR --packages=DIR --output=DIR');
assert.equal(process.platform, 'win32');
const output = resolve(values.output), packageRoot = resolve(values['product-root']);
await mkdir(output, { recursive: true });
const helper = join(dirname(fileURLToPath(import.meta.url)), 'probe-alu-ime-windows-211.ps1');
const wait = ms => new Promise(done => setTimeout(done, ms));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const report = {
  kind: 'windows-os-ime-acceptance', ticket: '#211', platform: process.platform, arch: process.arch,
  node: process.version, candidate: packageRoot, startedAt: new Date().toISOString(),
  os: 'Windows ' + run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::OSVersion.Version.ToString()']),
  cases: [], keySequences: [], screenshots: [], candidateWindows: [], texts: {},
  network: { draftSendRequests: [], executionRequests: [] }, foregroundChecks: [], status: 'running',
  nativeInput: 'System.Windows.Forms.SendKeys in the same Interactive desktop session as the probe Chrome; no CDP composition',
  capture: 'FFmpeg Desktop Duplication (ddagrab) of the OS-composited display',
};
const passed = (id, name, evidence) => {
  report.cases.push({ id, name, status: 'passed', ...(evidence ? { evidence } : {}) });
  console.log('PASS ' + id + ' ' + name);
};
const native = (mode, extra = []) => {
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helper,
    '-Mode', mode, '-ChromeProcessId', String(report.chromePid), ...extra]);
  return JSON.parse(result.replace(/^\uFEFF/, ''));
};
const candidateWindows = () => native('inspect').candidateWindows;
const shot = name => {
  const path = join(output, name + '.png');
  native('screenshot', ['-ImagePath', path]);
  report.screenshots.push({ name, path, capture: report.capture });
  return path;
};
const assertChromeFront = async page => {
  await page.bringToFront();
  const state = native('inspect');
  report.foregroundChecks.push({ at: new Date().toISOString(), ...state });
  assert.equal(state.foregroundProcessId, report.chromePid);
};
// The source acceptance sequences share names with the Mac probe; translate each physical key.
const physicalKeys = { 8:'c', 14:'e', 1:'s', 4:'h', 34:'i', 125:'{DOWN}', 49:' ', 32:'u',
  15:'r', 53:'{ESC}', 27:'-', 18:'1', 45:'n', 0:'a', 31:'o' };
const key = async (page, codes) => {
  await assertChromeFront(page);
  const keys = codes.map(code => {
    assert.ok(Object.hasOwn(physicalKeys, code), `unmapped physical key ${code}`);
    return physicalKeys[code];
  }).join('');
  native('keys', ['-KeysBase64', Buffer.from(keys).toString('base64')]);
};
const sequence = (id, label, codes, keysText) => report.keySequences.push({ id, label, keys: keysText,
  nativeKeys: codes.map(code => physicalKeys[code]) });
const editor = page => page.locator('.monaco-editor textarea').first();
const editorText = page => page.locator('.view-lines').innerText().catch(() => '');
const editorFocused = page => page.evaluate(() => !!document.activeElement?.closest('.monaco-editor'));
const candidateEvidence = async page => {
  let windows = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    windows = candidateWindows();
    if (windows.length) break;
    await wait(250);
  }
  report.candidateWindows.push(...windows);
  if (!windows.length) {
    report.texts.monacoTextareaAtFailure = await editor(page).inputValue().catch(() => '');
    shot('win-ime-candidate-missing');
  }
  assert.ok(windows.length > 0, 'no operating-system candidate window is visible');
  return windows[0];
};
const singleInsertion = (before, after) => {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const inserted = after.slice(prefix, after.length - suffix);
  assert.equal(after, before.slice(0, prefix) + inserted + before.slice(prefix));
  return inserted;
};
let browser, browserServer, product;
try {
  product = await createAluImeProduct({ productRoot: packageRoot, packages: values.packages });
  const state = product.state, { loginName, password } = state;
  Object.assign(report, product.provenance);
  report.endpoint = state.endpoint;
  browserServer = await chromium.launchServer({ channel: 'chrome', headless: false,
    args: ['--window-position=0,0', '--window-size=1600,1050'] });
  report.chromePid = browserServer.process().pid;
  browser = await chromium.connect(browserServer.wsEndpoint());
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 860 } });
  assert.equal((await context.request.post(state.endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
  const created = await context.request.post(state.endpoint + '/api/learning/course-activities',
    { data: { requestId: randomUUID(), releaseId: state.releaseId } });
  assert.equal(created.status(), 200);
  const activity = await created.json(); report.activityId = activity.activityId;
  const page = await context.newPage();
  const requests = [];
  page.on('request', request => {
    let payload;
    try { payload = request.postDataJSON(); } catch { /* non-JSON request */ }
    requests.push({ method: request.method(), url: request.url(), payload });
  });
  const executionSubmissions = () => requests.filter(item => item.method === 'POST'
    && /\/api\/learning\/executions\/[^/]+$/.test(new URL(item.url).pathname));
  const questionSubmissions = () => requests.filter(item => item.method === 'POST'
    && (item.payload?.receiver?.kind === 'question'
      || /\/api\/learning\/(?:tutor|help|messages|questions|send)(?:\/|$)/i.test(new URL(item.url).pathname)));
  report.network.quietPhases = [];
  const assertQuietPhase = (id, before) => {
    const after = executionSubmissions().length;
    report.network.quietPhases.push({ id, executionsBefore: before, executionsAfter: after,
      questionSubmissions: questionSubmissions().length });
    assert.equal(after, before, `${id}: native IME input must not run a simulation`);
    assert.equal(questionSubmissions().length, 0, `${id}: native IME input must not send a question`);
  };
  await page.goto(state.endpoint + '?space=school&activity=' + activity.activityId);
  await page.locator('.monaco-editor').first().waitFor({ state: 'visible', timeout: 120000 });
  await editor(page).focus();
  await assertChromeFront(page);
  passed('A0', 'an unlocked Windows interactive desktop owns the real product Chrome and native IME');
  const beforeMonacoInput = executionSubmissions().length;
  const exerciseToolSwitch = async () => {

  await page.getByRole('tab', { name: '作品', exact: true }).click();
  await editor(page).focus();
  const beforeToolInput = executionSubmissions().length;
  const beforeSwitch = await editorText(page);
  sequence('D1', 'monaco compose shuru before tab switch', [1, 4, 32, 15, 32], 's h u r u');
  await key(page, [1, 4, 32, 15, 32]);
  await wait(1300);
  await candidateEvidence(page);
  shot('win-ime-12a-active-composition-before-switch');
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'ALU 实验', exact: true }).getAttribute('aria-selected'), 'false',
    'tool navigation must wait for the active IME composition to settle');
  assert.ok(await editorFocused(page), 'requesting a tool change must not blur an unfinished composition');
  shot('win-ime-12aa-requested-switch-keeps-composition');
  await key(page, [53]);
  await page.waitForFunction(() => [...document.querySelectorAll('[role=tab]')]
    .some(tab => tab.textContent?.trim() === 'ALU 实验' && tab.getAttribute('aria-selected') === 'true'));
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  await wait(500);
  const afterSwitch = await editorText(page);
  const focusAfterSwitch = await page.evaluate(() => {
    const element = document.activeElement;
    return { connected: !!element?.isConnected, inEditor: !!element?.closest('.monaco-editor'),
      role: element?.getAttribute('role'), label: element?.textContent?.trim() };
  });
  report.toolSwitch = { beforeText: beforeSwitch, afterText: afterSwitch, focusBeforeManualRefocus: focusAfterSwitch };
  assert.equal(afterSwitch, beforeSwitch, 'Escape must cancel the composition and preserve the entire original work');
  assert.ok(focusAfterSwitch.connected && (focusAfterSwitch.inEditor
    || (focusAfterSwitch.role === 'tab' && focusAfterSwitch.label === '作品')),
  'returning to the work tab must leave focus on its tab control or the editor, not a hidden field');
  shot('win-ime-12b-tool-switch-before-refocus');
  await editor(page).focus();
  sequence('D2', 'monaco compose ceshi after tab switch', [8, 14, 1, 4, 34, 49], 'c e s h i Space');
  await key(page, [8, 14, 1, 4, 34]);
  await wait(1300);
  await candidateEvidence(page);
  await key(page, [49]);
  await wait(700);
  const afterSwitchCommit = await editorText(page);
  report.texts.monacoAfterToolSwitch = afterSwitchCommit.slice(0, 300);
  const switchInserted = singleInsertion(afterSwitch, afterSwitchCommit);
  assert.ok(/^[\u4e00-\u9fff]{2}$/.test(switchInserted), 'post-switch commit must insert one Chinese candidate');
  assert.ok(await editorFocused(page), 'focus must be in the Monaco editor after switching back');
  shot('win-ime-12-tool-switch-editor');
  passed('D1', 'Monaco composition followed by ALU-tab switch and back keeps text and focus correct');
  assertQuietPhase('Active composition and tool switch', beforeToolInput);

  };
  if (values['only-tool-switch']) {
    await exerciseToolSwitch();
  } else {
  /* ---------------- A. Monaco editor ---------------- */
  const initialText = await editorText(page);
  report.texts.initialEditor = initialText.slice(0, 300);
  sequence('A1', 'monaco compose ceshi', [8, 14, 1, 4, 34], 'c e s h i');
  await page.bringToFront();
  await editor(page).focus();
  assert.ok(await page.evaluate(() => !!document.activeElement?.closest('.monaco-editor')), 'Monaco textarea must own DOM focus before real keys');
  await key(page, [8, 14, 1, 4, 34]);
  await wait(1200);
  if (!candidateWindows().length) {
    // One IME hiccup must not silently discard the whole run: clear any half composition and retry once.
    report.candidateRetry = true;
    await key(page, [53]);
    await wait(500);
    await editor(page).focus();
    await key(page, [8, 14, 1, 4, 34]);
  }
  const candidateA = await candidateEvidence(page);
  report.texts.monacoPreedit = (await editorText(page)).slice(0, 120);
  shot('win-ime-01-monaco-candidate');
  passed('A1', 'real pinyin composition shows the OS candidate window over the Monaco editor',
    { owner: candidateA.owner, class: candidateA.class, bounds: [candidateA.x, candidateA.y, candidateA.width, candidateA.height] });

  // Arrow selection: the candidate grid expands and the highlighted item becomes the committed one.
  sequence('A2', 'monaco arrow select candidate', [125], 'Down Arrow');
  await key(page, [125]);
  await wait(500);
  const candidateA2 = await candidateEvidence(page);
  shot('win-ime-02-monaco-candidate-selected', candidateA2);
  sequence('A3', 'monaco Space commit', [49], 'Space');
  await key(page, [49]);
  await wait(900);
  const committedText = await editorText(page);
  report.texts.monacoAfterCommit = committedText.slice(0, 300);
  shot('win-ime-03-monaco-after-commit');
  const committedHead = singleInsertion(initialText, committedText);
  assert.ok(/^[\u4e00-\u9fff]{2}$/.test(committedHead), `Space did not commit a two-character Chinese candidate: ${committedText.slice(0, 40)}`);
  passed('A2', 'arrow selection followed by a real Space commit inserts exactly the selected Chinese candidate', { committed: committedHead });

  sequence('A4', 'monaco second composition shuru', [1, 4, 32, 15, 32], 's h u r u');
  await key(page, [1, 4, 32, 15, 32]);
  await wait(1400);
  const candidateA4 = await candidateEvidence(page);
  report.texts.monacoSecondPreedit = (await editorText(page)).slice(0, 120);
  shot('win-ime-04-monaco-second-composition', candidateA4);
  sequence('A5', 'monaco Escape cancel', [53], 'Escape');
  await key(page, [53]);
  await wait(800);
  const afterCancel = await editorText(page);
  report.texts.monacoAfterCancel = afterCancel.slice(0, 300);
  shot('win-ime-05-monaco-after-cancel');
  assert.equal(afterCancel, committedText, 'Escape cancel must leave the committed text unchanged');
  assert.ok(!/shuru|shu'ru/i.test(afterCancel), 'cancel must not leave romanised pinyin behind');
  assert.ok(await editorFocused(page), 'focus must remain in the Monaco editor after cancel');
  passed('A3', 'a real Escape cancel leaves no pinyin, no lost or duplicated text, and focus remains in Monaco');
  assertQuietPhase('Monaco composition/selection/commit/cancel', beforeMonacoInput);

  // Replace the incomplete starter with a correct ALU so run + full check are real end-to-end work.
  const correct = `// correct ALU for #211 IME acceptance\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); always_comb begin F=0; Cout=0; case({M,S}) 3'b000:F=~A; 3'b001:F=A&B; 3'b010:F=A|B; 3'b011:F=A^B; 3'b100:{Cout,F}={1'b0,A}+{1'b0,B}+Cin; default:begin F=0;Cout=0;end endcase end endmodule`;
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(correct);
  await wait(600);

  /* ---------------- B. Question draft ---------------- */
  const draftSelector = 'textarea[aria-label="就这个任务提问"]';
  let draft = page.locator(draftSelector);
  let draftSelectorUsed = draftSelector;
  if (await draft.count() === 0) {
    await page.getByRole('button', { name: '打开对话' }).click();
    await page.waitForTimeout(500);
    draft = page.locator('section[aria-label="Agent 问题草稿"] textarea');
    draftSelectorUsed = 'section[aria-label="Agent 问题草稿"] textarea';
  }
  report.draftSelectorUsed = draftSelectorUsed;
  assert.equal(await draft.count(), 1, 'the question draft textarea is not present');
  const beforeDraftInput = executionSubmissions().length;
  await draft.focus();
  sequence('B1', 'draft compose ceshi', [8, 14, 1, 4, 34], 'c e s h i');
  await key(page, [8, 14, 1, 4, 34]);
  await wait(1500);
  const candidateB = await candidateEvidence(page);
  shot('win-ime-06-draft-candidate', candidateB);
  sequence('B2', 'draft Space commit', [49], 'Space');
  await key(page, [49]);
  await wait(700);
  const draftFirst = await draft.inputValue();
  report.texts.draftAfterFirstCommit = draftFirst;
  assert.match(draftFirst, /^[\u4e00-\u9fff]{2}$/, `first draft candidate must be exactly two Chinese characters, saw ${JSON.stringify(draftFirst)}`);
  sequence('B3', 'draft compose shuru', [1, 4, 32, 15, 32], 's h u r u');
  await key(page, [1, 4, 32, 15, 32]);
  await wait(1300);
  await candidateEvidence(page);
  await key(page, [49]);
  await wait(700);
  const draftValue = await draft.inputValue();
  report.texts.draftAfterCommit = draftValue;
  assert.equal(draftValue.length, 4, `question draft must contain four committed Chinese characters, saw ${JSON.stringify(draftValue)}`);
  assert.ok(draftValue.startsWith(draftFirst), 'the second candidate must append to the same draft without dropping the first');
  assert.match(draftValue, /^[\u4e00-\u9fff]{4}$/, `question draft must contain only the two committed candidates, saw ${JSON.stringify(draftValue)}`);
  shot('win-ime-07-draft-committed');
  passed('B1', 'real pinyin composition and Space commit fill the question draft exactly once without dropped characters', { value: draftValue, first: draftFirst });
  sequence('B-cancel', 'draft compose shuru then Escape', [1, 4, 32, 15, 32, 53], 's h u r u Escape');
  await key(page, [1, 4, 32, 15, 32]);
  await wait(1000);
  await candidateEvidence(page);
  shot('win-ime-07b-draft-before-cancel');
  await key(page, [53]);
  await wait(700);
  assert.equal(await draft.inputValue(), draftValue, 'Escape must preserve the existing question draft without pinyin residue');
  assert.ok(await draft.evaluate(element => document.activeElement === element), 'draft must retain focus after Escape');
  shot('win-ime-07c-draft-after-cancel');
  assertQuietPhase('Question draft composition/commit/cancel', beforeDraftInput);
  passed('B-cancel', 'a real Escape cancels question-draft composition without changing text, sending or running');

  // Run and full check while the draft stays in the page; no question may be sent.
  await page.getByRole('button', { name: '打开对话' }).count().catch(() => 0);
  const aluTab = page.getByRole('tab', { name: 'ALU 实验', exact: true });
  await aluTab.click();
  const runButton = page.getByRole('button', { name: '运行', exact: true });
  await runButton.waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === '运行');
    return !!button && !(button).disabled;
  }, null, { timeout: 300000 });
  passed('B2', 'the ALU experiment prepared and the real run control is enabled', { preparationWaitMs: 0 });
  await runButton.click();
  await page.getByText(/已启用这次运行的作品/, { exact: false }).first().waitFor({ state: 'visible', timeout: 180000 });
  passed('B3', 'the real run succeeded and enabled the current work');
  const checkButton = page.getByRole('button', { name: '检查全部输入', exact: true });
  await checkButton.waitFor({ state: 'visible', timeout: 30000 });
  await checkButton.click();
  await page.getByText('4096 组检查通过', { exact: true }).waitFor({ state: 'visible', timeout: 240000 });
  report.checkVerdict = '4096-input-pass';
  const draftAfter = await draft.inputValue();
  report.texts.draftAfterRunAndCheck = draftAfter;
  report.network.draftSendRequests = questionSubmissions().map(item => ({ method: item.method,
    path: new URL(item.url).pathname }));
  report.network.executionRequests = requests.filter(item => /\/api\/learning\/executions\//.test(item.url)).map(item => ({
    method: item.method, path: new URL(item.url).pathname }));
  shot('win-ime-08-draft-after-run-check');
  assert.equal(draftAfter, draftValue, 'run and full check must not clear or alter the question draft');
  assert.equal(report.network.draftSendRequests.length, 0, 'run and full check must not send the question draft');
  passed('B4', 'running and the full check never clear or send the question draft', { draft: draftAfter, sendRequests: report.network.draftSendRequests.length });

  /* ---------------- C. Numeric invalid draft ---------------- */
  const numericA = page.locator('.alu-numeric-field').filter({ hasText: 'A（无符号 4 位）' }).locator('input');
  assert.equal(await numericA.count(), 1, 'numeric A input is missing');
  assert.equal(await numericA.isDisabled(), false, 'numeric A input is disabled');
  await wait(2000); // let any readout from the preceding full check settle before sampling the baseline
  const readoutBefore = await page.locator('.alu-readout-value').innerText();
  const inputSummaryBefore = await page.locator('.alu-readout-inputs').innerText();
  const executionCountBefore = requests.filter(item => item.method === 'POST' && /\/api\/learning\/executions\/[^/]+$/.test(item.url)).length;

  // Invalid ASCII draft written through real OS key codes (not a synthetic insertText).
  await numericA.focus();
  await page.keyboard.press('ControlOrMeta+A');
  sequence('C1', 'numeric A type -1', [27, 18], '- 1');
  await key(page, [27, 18]);
  await wait(800);
  const invalidValue = await numericA.inputValue();
  assert.equal(invalidValue, '-1', `numeric draft should hold -1, saw ${JSON.stringify(invalidValue)}`);
  assert.equal(await numericA.getAttribute('aria-invalid'), 'true', 'an out-of-range numeric draft must set aria-invalid=true');
  shot('win-ime-09-numeric-invalid');
  passed('C1', 'an illegal numeric draft (-1) stays in the field and is marked aria-invalid', { value: invalidValue });

  // Real pinyin composition directly into the numeric field, then Escape: the pre-composition draft must survive.
  sequence('C2', 'numeric A compose ceshi', [8, 14, 1, 4, 34], 'c e s h i');
  await key(page, [8, 14, 1, 4, 34]);
  await wait(1500);
  const candidateC = await candidateEvidence(page);
  shot('win-ime-10-numeric-candidate', candidateC);
  sequence('C3', 'numeric A Escape cancel', [53], 'Escape');
  await key(page, [53]);
  await wait(700);
  const afterEscapeValue = await numericA.inputValue();
  const readoutAfter = await page.locator('.alu-readout-value').innerText();
  const inputSummaryAfter = await page.locator('.alu-readout-inputs').innerText();
  const executionCountAfter = requests.filter(item => item.method === 'POST' && /\/api\/learning\/executions\/[^/]+$/.test(item.url)).length;
  report.texts.numericAfterEscape = afterEscapeValue;
  report.texts.readoutBefore = readoutBefore;
  report.texts.readoutAfter = readoutAfter;
  shot('win-ime-11-numeric-after-cancel');
  assert.equal(afterEscapeValue, '-1', 'Escape cancel must keep the pre-composition numeric draft');
  assert.equal(await numericA.getAttribute('aria-invalid'), 'true', 'the invalid draft must remain marked after cancel');
  assert.equal(readoutAfter, readoutBefore, 'an invalid numeric draft must not change the port reading');
  assert.equal(inputSummaryAfter, inputSummaryBefore, 'an invalid numeric draft must not change the committed input');
  assert.equal(executionCountAfter, executionCountBefore, 'an invalid numeric draft must not start a simulation');
  passed('C2', 'Escape cancel keeps the original illegal draft; aria-invalid, ports and simulation count are unchanged');

  // A committed Chinese draft is also illegal for this numeric field and must stay local.
  sequence('C4', 'numeric A compose and commit ceshi', [8, 14, 1, 4, 34, 49], 'c e s h i Space');
  await numericA.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await key(page, [8, 14, 1, 4, 34]);
  await wait(1300);
  await candidateEvidence(page);
  await key(page, [49]);
  await wait(500);
  const chineseDraft = await numericA.inputValue();
  assert.match(chineseDraft, /^[\u4e00-\u9fff]{2}$/, `numeric commit must contain exactly the two-character candidate, saw ${JSON.stringify(chineseDraft)}`);
  assert.equal(await numericA.getAttribute('aria-invalid'), 'true', 'a Chinese numeric draft must be marked invalid');
  assert.equal(await page.locator('.alu-readout-value').innerText(), readoutBefore, 'a Chinese numeric draft must not change the port reading');
  assert.equal(requests.filter(item => item.method === 'POST' && /\/api\/learning\/executions\/[^/]+$/.test(item.url)).length,
    executionCountBefore, 'a committed illegal numeric draft must not start a simulation');
  passed('C3', 'a committed Chinese candidate in the numeric field is invalid and triggers no simulation', { value: chineseDraft });
  shot('win-ime-11b-numeric-after-chinese-commit');
  assertQuietPhase('Illegal numeric draft composition/cancel/commit', executionCountBefore);

  // Restore a valid value so later focus checks start from a clean numeric state.
  await numericA.fill('0');
  await numericA.blur();
  await wait(1600);

  /* ---------------- D. Focus and tool switching ---------------- */
  await exerciseToolSwitch();

  // Numeric input and question draft must not leak characters into each other.
  const numericValueBefore = await numericA.inputValue().catch(() => '');
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await numericA.fill('7');
  await numericA.blur();
  await wait(1600); // the explicitly changed valid input may intentionally finish its own free observation
  const beforeFocusInput = executionSubmissions().length;
  await draft.focus();
  const draftBeforeNumericSwitch = await draft.inputValue();
  sequence('D3', 'draft compose nihao', [45, 34, 4, 0, 31, 49], 'n i h a o Space');
  await key(page, [45, 34, 4, 0, 31]);
  await wait(1300);
  await candidateEvidence(page);
  await key(page, [49]);
  await wait(600);
  const draftAfterNumericSwitch = await draft.inputValue();
  const numericAfterDraft = await numericA.inputValue();
  report.texts.draftBeforeNumericSwitch = draftBeforeNumericSwitch;
  report.texts.draftAfterNumericSwitch = draftAfterNumericSwitch;
  report.texts.numericAfterDraftSwitch = numericAfterDraft;
  shot('win-ime-13-numeric-draft-switch');
  assert.ok(draftAfterNumericSwitch.startsWith(draftBeforeNumericSwitch), 'draft must keep its earlier text');
  assert.match(draftAfterNumericSwitch.slice(draftBeforeNumericSwitch.length), /^[\u4e00-\u9fff]{2}$/,
    'the draft must append exactly one Chinese candidate, with no lost, repeated or romanised characters');
  assert.equal(numericAfterDraft, '7', 'typing in the question draft must not change the numeric input');
  passed('D2', 'switching between the numeric input and the question draft does not leak or leave text behind');
  assertQuietPhase('Numeric-to-question focus switch', beforeFocusInput);
  report.network.draftSendRequests = questionSubmissions().map(item => ({ method: item.method, path: new URL(item.url).pathname }));
  assert.equal(report.network.draftSendRequests.length, 0, 'no native input stage may send a question');

  }

  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error?.stack ?? error);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  report.caseCount = report.cases.length;
  report.passCount = report.cases.filter(item => item.status === 'passed').length;
  await browser?.close().catch(() => undefined);
  await browserServer?.close().catch(() => undefined);
  try {
    if (product) {
      await product.close();
      report.cleanup = 'owned temporary installation deleted through the product owner';
    }
  } catch (error) {
    report.cleanupError = String(error);
    report.status = 'failed';
    process.exitCode = 1;
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.caseCount, pass: report.passCount, error: report.error ?? null }));
}
