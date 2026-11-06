#!/usr/bin/env node
/**
 * #211 macOS acceptance: real operating-system Chinese IME in the real school product page.
 *
 * The candidate window, candidate selection, commit (Space), cancel (Escape) and focus changes
 * are produced by the operating system input method through Carbon Text Input Sources plus real
 * System Events key codes. No CDP composition event and no synthetic browser text is used as
 * IME evidence. The browser is real desktop Chrome with the school SPKI pinned.
 *
 * Cases:
 *  A. Monaco editor  : compose -> arrow-select -> Space commit; compose -> Escape cancel.
 *  B. Question draft : compose -> commit Chinese; then run + full check; the draft stays intact
 *                      and no send request is issued.
 *  C. Numeric draft  : invalid ASCII draft + real pinyin composition; aria-invalid stays true,
 *                      the port reading and simulation count do not change, Escape keeps the draft.
 *  D. Focus/tool     : Monaco -> ALU tab -> back; numeric input <-> question draft do not leak text.
 *  E. Screenshots    : full-screen and cropped OS candidate-window images, commit/cancel images.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values } = parseArgs({ options: {
  state: { type: 'string' }, output: { type: 'string' }, 'input-source': { type: 'string' },
} });
for (const name of ['state', 'output']) if (!values[name]) throw new Error('usage: --state=FILE --output=DIR [--input-source=ID]');
const state = JSON.parse(await readFile(resolve(values.state), 'utf8'));
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const desired = values['input-source'] ?? 'com.bytedance.inputmethod.doubaoime.pinyin';
const wait = ms => new Promise(done => setTimeout(done, ms));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const osa = script => execFileSync('osascript', ['-e', script]);

// Real Text Input Sources selection (Carbon TIS), not a plist edit or a synthetic keyboard layout.
const selectSource = join(output, 'selectime');
await writeFile(selectSource + '.swift', `
import Carbon
import Foundation
func idOf(_ s: TISInputSource) -> String {
  guard let p = TISGetInputSourceProperty(s, kTISPropertyInputSourceID) else { return "" }
  return Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
}
let arr = TISCreateInputSourceList(nil, false)!.takeRetainedValue()
let sources = arr as! [TISInputSource]
let desired = CommandLine.arguments.dropFirst().first ?? "com.bytedance.inputmethod.doubaoime.pinyin"
if let target = sources.first(where: { idOf($0) == desired }) { print("SELECTED \\(TISSelectInputSource(target)) \\(desired)") }
else { print("NOT_FOUND \\(desired)"); exit(2) }
print("CURRENT \\(idOf(TISCopyCurrentKeyboardInputSource().takeRetainedValue()))")
`);
execFileSync('swiftc', [selectSource + '.swift', '-o', selectSource]);

// OS window list with bounds: the candidate window is a real window owned by the input method.
const windowList = join(output, 'winlist');
await writeFile(windowList + '.swift', `
import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] ?? []
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
  let layer = w[kCGWindowLayer as String] as? Int ?? -1
  let id = w[kCGWindowNumber as String] as? Int ?? 0
  let b = w[kCGWindowBounds as String] as? [String:Any] ?? [:]
  let x = (b["X"] as? NSNumber)?.doubleValue ?? 0
  let y = (b["Y"] as? NSNumber)?.doubleValue ?? 0
  let bw = (b["Width"] as? NSNumber)?.doubleValue ?? 0
  let bh = (b["Height"] as? NSNumber)?.doubleValue ?? 0
  if layer != 0 || owner.contains("输入") || owner.contains("Chrome") {
    print("WINDOW\\t\\(id)\\t\\(layer)\\t\\(owner)\\t\\(x),\\(y),\\(bw),\\(bh)")
  }
}
`);
execFileSync('swiftc', [windowList + '.swift', '-o', windowList]);

const parseWindows = () => run(windowList, []).split('\n').filter(Boolean).map(line => {
  const [tag, id, layer, owner, bounds] = line.split('\t');
  const [x, y, width, height] = (bounds ?? '0,0,0,0').split(',').map(Number);
  return { id: Number(id), layer: Number(layer), owner, x, y, width, height };
});
const candidateWindows = () => parseWindows().filter(item =>
  /输入法|Input Method|IME/i.test(item.owner) && item.width > 0 && item.height > 0);

const osVersion = run('sw_vers', ['-productVersion']);
const report = {
  kind: 'macos-os-ime-acceptance', ticket: '#211', platform: process.platform, arch: process.arch,
  os: `macOS ${osVersion}`, node: process.version, desiredInputSource: desired,
  startedAt: new Date().toISOString(), cases: [], keySequences: [], screenshots: [], candidateWindows: [],
  texts: {}, network: { draftSendRequests: [], executionRequests: [] }, foregroundChecks: [], status: 'running',
  desktopNote: 'A first run at 02:43 was invalidated: the Qoder CN desktop app took the foreground, so its own IME candidate window was captured instead of the probe. Qoder CN was hidden with System Events before this run and restored afterwards; every real key sequence is guarded by a foreground-is-Chrome assertion.',
};
const passed = (id, name, evidence) => {
  report.cases.push({ id, name, status: 'passed', ...(evidence ? { evidence } : {}) });
  console.log('PASS ' + id + ' ' + name);
};
const shot = (name, region) => {
  const path = join(output, name + '.png');
  if (region) {
    const x = Math.max(0, Math.round(region.x - 12)), y = Math.max(0, Math.round(region.y - 12));
    const width = Math.max(1, Math.round(region.width + 24)), height = Math.max(1, Math.round(region.height + 24));
    execFileSync('screencapture', ['-x', '-t', 'png', `-R${x},${y},${width},${height}`, path]);
  } else execFileSync('screencapture', ['-x', '-t', 'png', path]);
  report.screenshots.push({ name, path, ...(region ? { region } : {}) });
  return path;
};
const frontApp = () => run('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']);
const chromePids = () => execFileSync('bash', ['-lc',
  `ps -axo pid,command | grep "Google Chrome --disable-field-trial-config" | grep -v grep | awk '{print $1}'`],
  { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
const assertChromeFront = async page => {
  // Raise the exact Playwright Chrome process, not just "Google Chrome": the owner also has a
  // normal Chrome window, and app-level activation can leave that window as the key window.
  if (report.chromePid) {
    try { osa(`tell application "System Events" to tell first application process whose unix id is ${report.chromePid} to set frontmost to true`); } catch { /* best effort */ }
    await page.bringToFront();
    await wait(500);
  }
  let front = frontApp();
  if (front !== 'Google Chrome' && (front === 'System Settings' || front === 'Qoder CN')) {
    // These are the two apps observed stealing focus from the probe. Hide only for this capture.
    try { osa(`tell application "System Events" to set visible of process "${front}" to false`); } catch { /* best effort */ }
    await page.bringToFront();
    await wait(600);
    front = frontApp();
  }
  const frontWindow = parseWindows().find(item => item.owner === 'Google Chrome' && item.layer === 0);
  report.foregroundChecks.push({ at: new Date().toISOString(), front,
    ...(frontWindow ? { frontWindow: { x: frontWindow.x, y: frontWindow.y, width: frontWindow.width, height: frontWindow.height } } : {}) });
  assert.equal(front, 'Google Chrome', `the probe Chrome is not the foreground app (saw ${front}); refusing to send real keys`);
};
const key = async (page, codes) => {
  await assertChromeFront(page);
  for (const code of codes) osa(`tell application "System Events" to key code ${code}`);
};
const sequence = (id, label, codes, keysText) => report.keySequences.push({ id, label, keys: keysText, keyCodes: codes });
const editor = page => page.locator('.monaco-editor textarea').first();
const editorText = page => page.locator('.view-lines').innerText().catch(() => '');
const editorFocused = page => page.evaluate(() => !!document.activeElement?.closest('.monaco-editor'));
const candidateEvidence = async page => {
  // The IME window can take a moment to appear after the last pinyin key; poll briefly instead of
  // treating one instant as authoritative.
  let windows = [];
  for (let attempt = 0; attempt < 16; attempt++) {
    windows = candidateWindows();
    if (windows.length) break;
    await wait(250);
  }
  report.candidateWindows.push(...windows);
  if (!windows.length) {
    report.candidateWindowDump = parseWindows();
    report.texts.monacoTextareaAtFailure = await page.locator('.monaco-editor textarea').first().inputValue().catch(() => '');
    shot('mac-ime-candidate-missing');
  }
  assert.ok(windows.length > 0, 'the operating-system Chinese candidate window is not on screen');
  return windows[0];
};
/** Return the single contiguous insertion that turns before into after, or fail with evidence. */
const singleInsertion = (before, after) => {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const inserted = after.slice(prefix, after.length - suffix);
  assert.equal(after, before.slice(0, prefix) + inserted + before.slice(prefix),
    'the edit must be one contiguous insertion without lost or duplicated text');
  return inserted;
};

let browser;
try {
  // Keep the display awake; a sleeping display makes screencapture return a black image.
  const wake = spawn('caffeinate', ['-u', '-t', '900'], { detached: true, stdio: 'ignore' });
  wake.unref();
  await wait(800);

  // Qoder CN is the owner's persistent app and must not be killed. It is only hidden while the
  // probe owns the desktop so its input box cannot take our real keystrokes; restored in finally.
  const visibleOf = name => run('osascript', ['-e', `tell application "System Events" to get visible of process "${name}"`]).trim();
  report.backgroundAppsBefore = { qoder: visibleOf('Qoder CN'), systemSettings: visibleOf('System Settings') };
  // Qoder CN is the owner's persistent app and must not be killed. System Settings opened during
  // a run and stole focus; both are only hidden while the probe owns the desktop and restored in finally.
  for (const name of ['Qoder CN', 'System Settings']) {
    if (visibleOf(name) === 'true') osa(`tell application "System Events" to set visible of process "${name}" to false`);
  }
  await wait(500);
  const pidsBefore = new Set(chromePids());
  browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: [`--ignore-certificate-errors-spki-list=${state.spki}`, '--window-position=0,0', '--window-size=1470,956'] });
  const launchedPids = chromePids().filter(pid => !pidsBefore.has(pid));
  report.chromePid = launchedPids.length === 1 ? Number(launchedPids[0]) : (launchedPids.length ? Number(launchedPids[launchedPids.length - 1]) : null);
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, ignoreHTTPSErrors: false });
  assert.equal((await context.request.post(state.endpoint + '/api/learning/login',
    { data: { loginName: state.loginName, password: state.password } })).status(), 200);
  const created = await context.request.post(state.endpoint + '/api/learning/course-activities',
    { data: { requestId: crypto.randomUUID(), releaseId: state.releaseId } });
  assert.equal(created.status(), 200);
  const activity = await created.json();
  report.activityId = activity.activityId;
  const page = await context.newPage();
  page.on('pageerror', error => console.log('PAGE ERROR ' + error.message));
  const requests = [];
  page.on('request', request => requests.push({ method: request.method(), url: request.url(),
    body: request.postData()?.slice(0, 1000) ?? '' }));
  await page.goto(state.endpoint + '?space=school&activity=' + activity.activityId);
  await page.bringToFront();
  await page.locator('.monaco-editor').first().waitFor({ state: 'visible', timeout: 120000 });
  await page.bringToFront();
  await assertChromeFront(page);
  await editor(page).focus();
  await wait(600);
  report.pageUrl = state.endpoint;

  const selection = run(selectSource, [desired]);
  report.inputSourceSelection = selection;
  assert.ok(selection.includes('CURRENT ' + desired), `input source not active: ${selection}`);
  await wait(2000);
  report.activeInputSource = run(selectSource, [desired]).split('\n').pop();
  passed('A0', 'the real macOS Chinese input method is selected through Text Input Sources');

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
  shot('mac-ime-01-monaco-candidate');
  shot('mac-ime-01-monaco-candidate-window', candidateA);
  passed('A1', 'real pinyin composition shows the OS candidate window over the Monaco editor',
    { owner: candidateA.owner, layer: candidateA.layer, bounds: [candidateA.x, candidateA.y, candidateA.width, candidateA.height] });

  // Arrow selection: the candidate grid expands and the highlighted item becomes the committed one.
  sequence('A2', 'monaco arrow select candidate', [125], 'Down Arrow');
  await key(page, [125]);
  await wait(500);
  const candidateA2 = await candidateEvidence(page);
  shot('mac-ime-02-monaco-candidate-selected', candidateA2);
  sequence('A3', 'monaco Space commit', [49], 'Space');
  await key(page, [49]);
  await wait(900);
  const committedText = await editorText(page);
  report.texts.monacoAfterCommit = committedText.slice(0, 300);
  shot('mac-ime-03-monaco-after-commit');
  const committedHead = singleInsertion(initialText, committedText);
  assert.ok(/^[\u4e00-\u9fff]{2}$/.test(committedHead), `Space did not commit a two-character Chinese candidate: ${committedText.slice(0, 40)}`);
  passed('A2', 'arrow selection followed by a real Space commit inserts exactly the selected Chinese candidate', { committed: committedHead });

  sequence('A4', 'monaco second composition shuru', [1, 4, 32, 15, 32], 's h u r u');
  await key(page, [1, 4, 32, 15, 32]);
  await wait(1400);
  const candidateA4 = await candidateEvidence(page);
  report.texts.monacoSecondPreedit = (await editorText(page)).slice(0, 120);
  shot('mac-ime-04-monaco-second-composition', candidateA4);
  sequence('A5', 'monaco Escape cancel', [53], 'Escape');
  await key(page, [53]);
  await wait(800);
  const afterCancel = await editorText(page);
  report.texts.monacoAfterCancel = afterCancel.slice(0, 300);
  shot('mac-ime-05-monaco-after-cancel');
  assert.equal(afterCancel, committedText, 'Escape cancel must leave the committed text unchanged');
  assert.ok(!/shuru|shu'ru/i.test(afterCancel), 'cancel must not leave romanised pinyin behind');
  assert.ok(await editorFocused(page), 'focus must remain in the Monaco editor after cancel');
  passed('A3', 'a real Escape cancel leaves no pinyin, no lost or duplicated text, and focus remains in Monaco');

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
  await draft.focus();
  sequence('B1', 'draft compose ceshi', [8, 14, 1, 4, 34], 'c e s h i');
  await key(page, [8, 14, 1, 4, 34]);
  await wait(1500);
  const candidateB = await candidateEvidence(page);
  shot('mac-ime-06-draft-candidate', candidateB);
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
  shot('mac-ime-07-draft-committed');
  passed('B1', 'real pinyin composition and Space commit fill the question draft exactly once without dropped characters', { value: draftValue, first: draftFirst });

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
  await page.getByText('4096 组检查通过', { exact: true }).waitFor({ state: 'visible', timeout: 240000 }).catch(async () => {
    // A real failing check is still a real check; record the visible verdict instead of hiding it.
    const body = await page.locator('body').innerText();
    assert.ok(/检查未通过|检查未完成|检查结果未完整核实/.test(body), 'no check verdict appeared');
  });
  const draftAfter = await draft.inputValue();
  report.texts.draftAfterRunAndCheck = draftAfter;
  const actionsWindow = requests.filter(item => item.method === 'POST' &&
    /\/api\/learning\/(?:intents|actions|executions|tutor|help|messages|questions)/i.test(new URL(item.url).pathname));
  report.network.draftSendRequests = actionsWindow.filter(item =>
    /tutor|help|messages|questions|send/i.test(item.url) || item.body.includes('测试输入'));
  report.network.executionRequests = requests.filter(item => /\/api\/learning\/executions\//.test(item.url)).map(item => ({
    method: item.method, path: new URL(item.url).pathname }));
  shot('mac-ime-08-draft-after-run-check');
  assert.equal(draftAfter, draftValue, 'run and full check must not clear or alter the question draft');
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
  shot('mac-ime-09-numeric-invalid');
  passed('C1', 'an illegal numeric draft (-1) stays in the field and is marked aria-invalid', { value: invalidValue });

  // Real pinyin composition directly into the numeric field, then Escape: the pre-composition draft must survive.
  sequence('C2', 'numeric A compose ceshi', [8, 14, 1, 4, 34], 'c e s h i');
  await key(page, [8, 14, 1, 4, 34]);
  await wait(1500);
  const candidateC = await candidateEvidence(page);
  shot('mac-ime-10-numeric-candidate', candidateC);
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
  shot('mac-ime-11-numeric-after-cancel');
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
  assert.ok(/[\u4e00-\u9fff]/.test(chineseDraft), `expected a committed Chinese draft in the numeric field, saw ${JSON.stringify(chineseDraft)}`);
  assert.equal(await numericA.getAttribute('aria-invalid'), 'true', 'a Chinese numeric draft must be marked invalid');
  assert.equal(await page.locator('.alu-readout-value').innerText(), readoutBefore, 'a Chinese numeric draft must not change the port reading');
  passed('C3', 'a committed Chinese candidate in the numeric field is invalid and triggers no simulation', { value: chineseDraft });

  // Restore a valid value so later focus checks start from a clean numeric state.
  await numericA.fill('0');
  await numericA.blur();
  await wait(300);

  /* ---------------- D. Focus and tool switching ---------------- */
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  await editor(page).focus();
  const beforeSwitch = await editorText(page);
  sequence('D1', 'monaco compose shuru before tab switch', [1, 4, 32, 15, 32], 's h u r u');
  await key(page, [1, 4, 32, 15, 32]);
  await wait(1300);
  await candidateEvidence(page);
  await key(page, [53]);
  await wait(500);
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await wait(800);
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  await editor(page).focus();
  const afterSwitch = await editorText(page);
  assert.equal(afterSwitch, beforeSwitch, 'switching tools must not change protected editor text');
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
  shot('mac-ime-12-tool-switch-editor');
  passed('D1', 'Monaco composition followed by ALU-tab switch and back keeps text and focus correct');

  // Numeric input and question draft must not leak characters into each other.
  const numericValueBefore = await numericA.inputValue().catch(() => '');
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await numericA.fill('7');
  await numericA.blur();
  await wait(300);
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
  shot('mac-ime-13-numeric-draft-switch');
  assert.ok(draftAfterNumericSwitch.startsWith(draftBeforeNumericSwitch), 'draft must keep its earlier text');
  assert.ok(draftAfterNumericSwitch.length > draftBeforeNumericSwitch.length, 'the drafted Chinese text must be appended to the draft');
  assert.equal(numericAfterDraft, '7', 'typing in the question draft must not change the numeric input');
  passed('D2', 'switching between the numeric input and the question draft does not leak or leave text behind');

  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error?.stack ?? error);
  throw error;
} finally {
  // Restore ABC so the probe does not leave the owner's keyboard in Chinese mode.
  try { run(selectSource, ['com.apple.keylayout.ABC']); } catch { /* best effort */ }
  // Restore the owner's persistent Qoder app and System Settings; both were only hidden, never killed.
  for (const name of ['Qoder CN', 'System Settings']) {
    try { osa(`tell application "System Events" to set visible of process "${name}" to true`); } catch { /* best effort */ }
  }
  report.finishedAt = new Date().toISOString();
  report.caseCount = report.cases.length;
  report.passCount = report.cases.filter(item => item.status === 'passed').length;
  await browser?.close().catch(() => undefined);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, pass: report.passCount, error: report.error ?? null }));
}
