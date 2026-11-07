#!/usr/bin/env node
/**
 * #206 X4: native macOS Chinese IME candidate-window evidence in the real product page.
 *
 * Switches the OS input source with Carbon TISSelectInputSource, sends real key codes through
 * System Events (Accessibility), and captures the OS-drawn candidate window with screencapture.
 * No CDP composition events and no synthetic browser text: the candidates, commit (Space) and
 * cancel (Escape) are produced by the operating system's input method.
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
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const osa = script => execFileSync('osascript', ['-e', script]);
const wait = ms => new Promise(done => setTimeout(done, ms));
const shot = name => execFileSync('screencapture', ['-x', '-t', 'png', join(output, name + '.png')]);

// Swift helper: real Text Input Sources API, not a plist edit.
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
const windowList = join(output, 'winlist');
await writeFile(windowList + '.swift', `
import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String:Any]] ?? []
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
  let layer = w[kCGWindowLayer as String] as? Int ?? -1
  let id = w[kCGWindowNumber as String] as? Int ?? 0
  if layer != 0 || owner.contains("输入") || owner.contains("Chrome") { print("WINDOW \\(id) layer=\\(layer) owner=\\(owner)") }
}
`);
execFileSync('swiftc', [windowList + '.swift', '-o', windowList]);

const report = { kind: 'macos-os-ime-candidate-window', ticket: '#206', item: 'X4',
  platform: process.platform, arch: process.arch, node: process.version,
  desiredInputSource: desired, startedAt: new Date().toISOString(), cases: [], status: 'running' };
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };

let browser;
try {
  // Keep the display awake: a sleeping display makes screencapture return a black image.
  const wake = spawn('caffeinate', ['-u', '-t', '300'], { detached: true, stdio: 'ignore' });
  wake.unref();
  await wait(1000);

  browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: [`--ignore-certificate-errors-spki-list=${state.spki}`] });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false });
  assert.equal((await context.request.post(state.endpoint + '/api/learning/login',
    { data: { loginName: state.loginName, password: state.password } })).status(), 200);
  const created = await context.request.post(state.endpoint + '/api/learning/course-activities',
    { data: { requestId: crypto.randomUUID(), releaseId: state.releaseId } });
  const activity = await created.json();
  const page = await context.newPage();
  await page.goto(state.endpoint + '?space=school&activity=' + activity.activityId);
  await page.bringToFront();
  const editor = page.locator('.monaco-editor textarea').first();
  await editor.focus();
  await wait(800);
  report.pageUrl = state.endpoint;
  passed('a real product editor is focused in desktop Chrome');

  const selection = run(selectSource, [desired]);
  report.inputSourceSelection = selection;
  assert.ok(selection.includes('CURRENT ' + desired), `input source not active: ${selection}`);
  await wait(1200);
  report.activeInputSource = desired;
  passed('the operating system Chinese input method is selected through Text Input Sources');

  // Real key codes (c e s h i) travel through the OS IME, not a browser insertText.
  for (const code of [8, 14, 1, 4, 34]) osa(`tell application "System Events" to key code ${code}`);
  await wait(1600);
  const windows = run(windowList, []);
  report.candidateWindow = windows.split('\n').filter(line => /输入|Input/i.test(line));
  assert.ok(report.candidateWindow.length > 0, 'no OS input-method window is on screen');
  shot('mac-ime-candidate-window');
  report.compositionVisible = true;
  passed('the operating system draws the Chinese candidate window over the product editor');

  osa('tell application "System Events" to key code 49'); // Space commits the first candidate
  await wait(900);
  shot('mac-ime-after-commit');
  const committed = await page.locator('.view-lines').innerText().catch(() => '');
  report.committedText = committed.slice(0, 200);
  assert.ok(committed.includes('测试'), `candidate was not committed, saw ${committed.slice(0, 80)}`);
  passed('a real Space shortcut commits the selected Chinese candidate into the editor');

  for (const code of [1, 4, 32, 3, 34]) osa(`tell application "System Events" to key code ${code}`); // s h u r u
  await wait(1200);
  shot('mac-ime-second-composition');
  osa('tell application "System Events" to key code 53'); // Escape cancels the composition
  await wait(800);
  const afterCancel = await page.locator('.view-lines').innerText().catch(() => '');
  report.afterCancelText = afterCancel.slice(0, 200);
  assert.equal(afterCancel, committed, 'cancel must leave the protected text unchanged');
  shot('mac-ime-after-cancel');
  passed('a real Escape shortcut cancels composition without changing the protected text');

  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error?.stack ?? error);
  throw error;
} finally {
  // Restore ABC so the probe does not leave the owner's keyboard in Chinese mode.
  try { run(selectSource, ['com.apple.keylayout.ABC']); } catch { /* best effort */ }
  report.finishedAt = new Date().toISOString();
  await browser?.close().catch(() => undefined);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error ?? null }));
}
