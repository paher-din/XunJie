import { probeEvidenceDirectory, writeEvidence, captureEvidence, mkdtemp, hasProbeEvidence } from './lib/probe-evidence.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir, release, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

/**
 * #199 / #209: macOS system Chinese input method in the fixed student-response card.
 *
 * Text reaches Chrome only through WindowServer and the TIS-selected system input method.
 * xjkeys posts HID-level key events with CGEventPost(.cghidEventTap, .hidSystemState); System
 * Events posts the keys xjkeys does not map (Tab, Shift+Tab, Command+A). Playwright only
 * navigates, clicks non-text controls and reads state; it never fills or synthesises text.
 *
 * Requires: an installed full product package (darwin-arm64), an Accessibility-trusted
 * xjkeys, the Doubao Pinyin input method, desktop Google Chrome and an unlocked desktop.
 */
const product = resolve(process.env.XUNJIE_PRODUCT_PACKAGE ?? 'dist/product-darwin-arm64');
const output = probeEvidenceDirectory(process.env.XUNJIE_STUDENT_ASK_IME_OUTPUT);
const helper = resolve(process.env.XUNJIE_IME_TOOLS ?? join(homedir(), 'xj-154/ime'));
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim();
const key = (...args) => run(join(helper, 'xjkeys'), args);
const select = value => run(join(helper, 'select_ime'), [value]);
const systemKey = (code, modifiers = '') => run('/usr/bin/osascript', ['-e',
  `tell application "System Events" to key code ${code}${modifiers ? ` using {${modifiers}}` : ''}`]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(done => setTimeout(done, ms));

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const desktopOwner = run('/usr/bin/swift', ['-e', 'import AppKit; print(NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown")']);
assert.notEqual(desktopOwner, 'loginwindow', 'Unlock the macOS desktop before physical system IME acceptance.');
assert.equal(key('check'), 'trusted', 'the existing HID helper must already be Accessibility trusted');
await mkdir(output, { recursive: true });
const shots = join(output, 'shots');
await mkdir(shots, { recursive: true });
const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
const node = join(product, resources.nodePath);
const root = await mkdtemp(join(tmpdir(), 'xj-student-ask-ime-'));
const cli = (...args) => JSON.parse(run(node, [join(product, 'app/cli.js'), ...args, '--root', root]));
const originalIme = select('current');
const chineseIme = 'com.bytedance.inputmethod.doubaoime.pinyin';
const report = {
  kind: 'macos-system-ime-student-response-acceptance',
  ticket: '#209', sourceIssue: '#199',
  startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  os: release(), osBuild: run('/usr/bin/sw_vers', ['-buildVersion']),
  sourceRevision: run('git', ['rev-parse', 'HEAD']),
  product: { path: product, distributionSha256: sha(await readFile(join(product, 'distribution.json'))) },
  probeSha256: sha(await readFile(new URL(import.meta.url))),
  node: run(node, ['--version']), postgres: run(join(product, resources.postgresBin, 'postgres'), ['--version']),
  browser: 'Google Chrome', inputMethod: { requested: chineseIme, currentBefore: null, selected: null, currentAfter: null, restoredTo: null },
  injection: { tool: 'xjkeys + System Events', mechanism: 'CGEventPost(.cghidEventTap, .hidSystemState) and System Events physical key codes',
    accessibilityTrusted: true, syntheticText: false },
  cases: [], steps: [], signals: null, screenshots: {}, status: 'running', teaching: 'not-evaluated',
};
const pass = (name, detail) => { report.cases.push({ name, detail }); console.log('PASS ' + name); };
let browser, context, page, endpoint, upstream;
let payloads = [], modelErrors = [];
let answer = (response, value) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of [
    { id: 'student-ime', choices: [{ index: 0, delta: { role: 'assistant', content: value.text },
      finish_reason: null }] },
    { id: 'student-ime', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(chunk) + '\n\n');
  response.end('data: [DONE]\n\n');
};

try {
  // A production full package CLI installs and starts its own native PostgreSQL and app.
  cli('install', '--profile', 'local');
  ({ endpoint } = cli('start'));
  report.endpoint = endpoint;

  // The model upstream is a controlled SSE fixture; only the model provider is simulated.
  const { createServer } = await import('node:http');
  upstream = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      payloads.push(payload);
      if (payloads.length === 1) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const tool = { role: 'assistant', tool_calls: [{ index: 0, id: 'ask-ime', type: 'function',
          function: { name: 'student_ask', arguments: JSON.stringify({ question: '你预计状态 3 再输入 2 会变成几？',
            source: '当前四态累加活动的先验预测', options: [], allowText: true, skippable: true }) } }] };
        for (const chunk of [
          { id: 'student-ime', choices: [{ index: 0, delta: tool, finish_reason: null }] },
          { id: 'student-ime', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
        ]) response.write('data: ' + JSON.stringify(chunk) + '\n\n');
        response.end('data: [DONE]\n\n');
      } else {
        answer(response, { text: '已根据你保留的中文回应继续：先列出状态与输入，再对 4 取余。' });
      }
    } catch (error) { modelErrors.push(String(error)); response.destroy(); }
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));

  const api = async (route, body) => {
    const response = await fetch(endpoint + '/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, 200, route + ': ' + JSON.stringify(value));
    return value;
  };
  const connectionId = randomUUID(), grantId = randomUUID();
  await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
    name: '学生回应输入法验收', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    path: '/chat/completions', modelId: 'fixture-student-ask-ime', dialect: 'standard', parameterMode: 'plain',
    enabled: true, contextWindow: 262144, maxOutputTokens: 2048,
    credential: { action: 'replace', value: 'synthetic-student-ask-ime-key' } });
  await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
  const selection = await api('models/selection');
  await api('models/selection', { requestId: randomUUID(), expectedVersion: selection.version,
    source: { kind: 'personal', connectionId, grantId } });

  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-automation', '--window-size=1360,980'] });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1360, height: 940 } });
  page = await context.newPage();
  page.on('pageerror', error => console.log('BROWSER ERROR ' + error.message));
  await page.goto(endpoint);
  await page.getByLabel('学习目标', { exact: true }).fill('理解四态累加的先验预测');
  await page.getByLabel('起始问题', { exact: true }).fill('先问我的预测，再结合我的回答解释。');
  await page.getByRole('button', { name: '建立并开始对话', exact: true }).click();
  await expect(page).toHaveURL(/[?&]activity=[0-9a-f-]+/);
  const activityId = new URL(page.url()).searchParams.get('activity');
  const card = page.getByRole('group', { name: 'Agent 的提问', exact: true });
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText('你预计状态 3 再输入 2 会变成几？');
  const entry = card.getByLabel('你的回应', { exact: true });
  await expect(entry).toBeVisible();
  await expect(entry).toBeEnabled();
  const conversation = async () => api(`agent/${activityId}/conversation`);
  assert.equal((await conversation()).questions.length, 1);
  assert.equal((await conversation()).questions[0].state, 'pending');
  assert.equal(payloads.length, 1);
  pass('an existing conversation presents a pending fixed question before any input', 'one pending question, one model request');

  // Observe only what the page actually receives from the OS input pipeline.
  await page.evaluate(() => {
    window.__imeEvents = [];
    const push = (type, event) => window.__imeEvents.push({ type, at: Math.round(performance.now()),
      trusted: event.isTrusted, key: event.key ?? null, keyCode: event.keyCode ?? null,
      isComposing: event.isComposing ?? null, inputType: event.inputType ?? null, data: event.data ?? null,
      value: event.target && 'value' in event.target ? event.target.value : null });
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown']) {
      document.addEventListener(type, event => { if (event.target === document.querySelector('textarea')) push(type, event); }, true);
    }
  });
  const events = () => page.evaluate(() => window.__imeEvents.slice(0, 1200));
  const activate = async () => {
    await page.bringToFront();
    try { execFileSync('/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to activate'], { encoding: 'utf8' }); }
    catch (error) { report.steps.push({ step: 'activate', error: String(error.message ?? error).slice(0, 200) }); }
    for (let attempt = 0; attempt < 15; attempt++) {
      if (await page.evaluate(() => document.hasFocus())) return true;
      await pause(200);
    }
    return false;
  };
  const focusEntry = async () => {
    assert.ok(await activate(), 'the Chrome window must own system focus before any keystroke');
    await entry.click();
    await entry.evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
    await pause(250);
    const state = await page.evaluate(() => ({ active: document.activeElement?.tagName ?? null, hasFocus: document.hasFocus() }));
    assert.equal(state.active, 'TEXTAREA', 'the response textarea must own focus');
    assert.ok(state.hasFocus, 'the browser window must own system focus');
  };
  const typeSlow = async pinyin => { for (const letter of pinyin) { key('type', letter); await pause(130); } };
  const capture = async name => {
    if (!hasProbeEvidence(output)) return null;
    const file = join(shots, `${name}.png`);
    try {
      execFileSync('/usr/sbin/screencapture', ['-x', file]);
      report.screenshots[name] = file;
      return file;
    } catch (error) {
      report.steps.push({ step: 'screencapture', name, error: String(error.message ?? error).slice(0, 200) });
      return null;
    }
  };

  report.inputMethod = { requested: chineseIme, currentBefore: originalIme, selected: null, currentAfter: null, restoredTo: null };
  report.inputMethod.selected = select(chineseIme);
  report.inputMethod.currentAfter = select('current');
  assert.equal(report.inputMethod.currentAfter, chineseIme, 'the TIS-selected input method must be the Chinese pinyin IME');
  pass('the system Chinese pinyin input method is selected through TIS', report.inputMethod.currentAfter);

  await focusEntry();
  key('key', 'esc');
  await pause(300);

  // 1) Composition + real Space candidate commit.
  await typeSlow('nihao');
  await pause(600);
  await capture('candidate-nihao');
  key('key', 'space');
  await pause(900);
  const afterSpace = await entry.inputValue();
  assert.match(afterSpace, /^[\u4e00-\u9fff]+$/u, 'a Space candidate commit must produce Chinese: ' + afterSpace);
  assert.deepEqual(await conversation().then(value => value.questions[0].state), 'pending');
  assert.equal(payloads.length, 1, 'candidate commit must not answer or advance the Run');
  pass('pinyin composition and a real Space candidate commit enter Chinese into the response', JSON.stringify(afterSpace));

  // 2) Digit-key candidate selection.
  await typeSlow('shijie');
  await pause(500);
  await capture('candidate-digit');
  key('type', '1');
  await pause(900);
  const afterDigit = await entry.inputValue();
  assert.ok(afterDigit.startsWith(afterSpace) && /^[\u4e00-\u9fff]+$/u.test(afterDigit.slice(afterSpace.length)),
    'a digit key must append a Chinese candidate: ' + afterDigit);
  assert.equal(payloads.length, 1);
  pass('a real digit key selects a system candidate and appends Chinese', JSON.stringify(afterDigit));

  // 3) Enter during composition must not submit the response.
  await typeSlow('zhongguo');
  await pause(500);
  const beforeEnter = await entry.inputValue();
  key('key', 'return');
  await pause(800);
  const afterEnter = await entry.inputValue();
  const enterEvents = (await events()).filter(event => event.type === 'keydown' && event.key === 'Enter');
  assert.ok(enterEvents.length >= 1 && enterEvents.every(event => event.trusted), 'Enter must arrive as a trusted OS event');
  assert.equal(payloads.length, 1, 'Enter during composition must not submit the response');
  assert.equal((await conversation()).questions[0].state, 'pending');
  report.steps.push({ step: 'enter-during-composition', before: beforeEnter, after: afterEnter,
    keydowns: enterEvents.map(event => ({ trusted: event.trusted, keyCode: event.keyCode, isComposing: event.isComposing })) });
  pass('Enter during the candidate window neither submits the response nor advances the Run', JSON.stringify(afterEnter));

  // Enter committed the pending raw pinyin (the IME removed its syllable apostrophe).
  // Keep that actual value as the new baseline; nothing was submitted.
  const baseline = await entry.inputValue();
  assert.ok(baseline.startsWith(afterSpace), 'the committed composition must retain the earlier Chinese');

  // 4) Return outside composition inserts a real newline and keeps the textarea editable.
  key('key', 'return');
  await pause(500);
  const withNewline = await entry.inputValue();
  assert.equal(withNewline, baseline + '\n', 'Return outside composition must insert one newline: ' + JSON.stringify(withNewline));
  await typeSlow('shanghai');
  await pause(500);
  key('key', 'space');
  await pause(800);
  const multiline = await entry.inputValue();
  assert.ok(multiline.startsWith(baseline + '\n') && multiline.length > baseline.length + 1,
    'Chinese must continue on the new line: ' + JSON.stringify(multiline));
  assert.equal(payloads.length, 1);
  pass('Return inserts a real newline and system-IME Chinese continues on the next line', JSON.stringify(multiline));

  // 5) Tab leaves the textarea without submitting; Shift+Tab returns and the value stays.
  await focusEntry();
  systemKey(48);
  await pause(500);
  const afterTab = await page.evaluate(() => ({ active: document.activeElement?.tagName ?? null,
    text: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 20) ?? null,
    value: document.querySelector('.student-question textarea')?.value ?? null, hasFocus: document.hasFocus() }));
  assert.notEqual(afterTab.active, 'TEXTAREA', 'Tab must move focus away from the response textarea');
  assert.equal(afterTab.value, multiline, 'Tab must not change the composed response');
  assert.equal(payloads.length, 1, 'Tab must not submit the response');
  systemKey(48, 'shift down');
  await pause(400);
  const afterShiftTab = await page.evaluate(() => document.activeElement?.tagName ?? null);
  assert.equal(afterShiftTab, 'TEXTAREA', 'Shift+Tab must return focus to the response textarea');
  assert.equal(await entry.inputValue(), multiline);
  report.steps.push({ step: 'tab', afterTab, afterShiftTab });
  pass('Tab and Shift+Tab move focus without submitting or changing the response', JSON.stringify(afterTab));

  // 6) Escape cancels the composition only.
  await focusEntry();
  await typeSlow('beijing');
  await pause(500);
  key('key', 'esc');
  await pause(500);
  assert.equal(await entry.inputValue(), multiline, 'Escape must leave the committed response untouched');
  assert.equal(payloads.length, 1, 'Escape must not submit the response');
  assert.equal((await conversation()).questions[0].state, 'pending');
  pass('Escape cancels the candidate composition without submitting or clearing the response', JSON.stringify(multiline));

  // 7) Command+A is a real Meta shortcut: it selects the response without submitting or losing it.
  await focusEntry();
  systemKey(0, 'command down');
  await pause(400);
  const selected = await entry.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, length: element.value.length }));
  assert.deepEqual([selected.start, selected.end], [0, selected.length], 'Command+A must select the whole response');
  assert.equal(await entry.inputValue(), multiline);
  assert.equal(payloads.length, 1);
  systemKey(124);
  pass('Command+A selects the response through a real Meta shortcut without submitting', JSON.stringify(selected));

  // 8) Scrolling keeps focus and the composed value.
  await focusEntry();
  await page.mouse.wheel(0, 480);
  await pause(500);
  const afterScroll = await page.evaluate(() => ({ active: document.activeElement?.tagName ?? null,
    value: document.querySelector('.student-question textarea')?.value ?? null, hasFocus: document.hasFocus() }));
  assert.equal(afterScroll.active, 'TEXTAREA', 'scrolling must keep focus in the response textarea');
  assert.equal(afterScroll.value, multiline, 'scrolling must keep the composed response');
  pass('scrolling keeps textarea focus and the composed response', JSON.stringify(afterScroll));

  // Capture the real DOM signals before this page is closed; the reopened page starts a new window.
  const observedEvents = await events();

  // 9) Close the page and reopen it: the unaccepted response is still there and nothing was answered.
  await page.close();
  await pause(1000);
  page = await context.newPage();
  page.on('pageerror', error => console.log('BROWSER ERROR ' + error.message));
  await page.goto(endpoint + '?activity=' + activityId);
  if (await page.getByRole('button', { name: '打开对话', exact: true }).count()) {
    await page.getByRole('button', { name: '打开对话', exact: true }).click();
  }
  const reopenedCard = page.getByRole('group', { name: 'Agent 的提问', exact: true });
  await expect(reopenedCard).toBeVisible({ timeout: 20000 });
  const reopenedEntry = reopenedCard.getByLabel('你的回应', { exact: true });
  await expect(reopenedEntry).toHaveValue(multiline, { timeout: 15000 });
  assert.equal((await conversation()).questions[0].state, 'pending');
  assert.equal(payloads.length, 1, 'reopening the page must not answer the question');
  pass('closing and reopening the page preserves the unaccepted Chinese response', JSON.stringify(multiline));

  // 10) The preserved response submitted through the explicit button continues the original Run.
  await reopenedCard.getByRole('button', { name: '提交回应', exact: true }).click();
  await expect(page.getByText('已根据你保留的中文回应继续：先列出状态与输入，再对 4 取余。', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(reopenedCard).toContainText('回应已接收');
  assert.equal(payloads.length, 2, 'the explicit submission must continue the original Run once');
  const responsePayload = JSON.stringify(payloads[1]);
  assert.ok(responsePayload.includes(JSON.stringify(multiline).slice(1, -1).split('\\n')[0]), 'the model request must contain the response');
  for (const value of multiline.split('\n')) assert.ok(responsePayload.includes(value), 'each response line must reach the model request');
  const finalConversation = await conversation();
  assert.equal(finalConversation.questions[0].response.answer.kind, 'text');
  assert.equal(finalConversation.questions[0].response.answer.text, multiline);
  assert.equal(modelErrors.length, 0);
  pass('the preserved response submits once and continues the original Run to completion', '2 model requests, 1 response');

  const finalEvents = observedEvents;
  const starts = finalEvents.filter(event => event.type === 'compositionstart');
  const updates = finalEvents.filter(event => event.type === 'compositionupdate');
  const ends = finalEvents.filter(event => event.type === 'compositionend');
  const composingKeydowns = finalEvents.filter(event => event.type === 'keydown' && (event.isComposing || event.keyCode === 229));
  const commits = finalEvents.filter(event => event.type === 'beforeinput' && event.inputType === 'insertCompositionText'
    && /[\u4e00-\u9fff]/.test(String(event.data ?? '')));
  report.signals = { compositionStarts: starts.length, compositionUpdates: updates.length, compositionEnds: ends.length,
    composingKeydowns: composingKeydowns.length, chineseCompositionCommits: commits.map(event => event.data),
    trustedKeydowns: finalEvents.filter(event => event.type === 'keydown' && event.trusted).length };
  assert.ok(report.signals.compositionStarts >= 4, 'each composition must open with compositionstart');
  assert.ok(report.signals.composingKeydowns >= 8, 'IME composition must produce VK_PROCESSKEY keydowns');
  pass('the page records trusted composition signals rather than synthetic text input', JSON.stringify(report.signals));

  // Light/dark and narrow desktop screenshots from the real run.
  await page.emulateMedia({ colorScheme: 'light' });
  await pause(300);
  await captureEvidence(page, { path: join(output, 'student-ask-ime-light.png'), fullPage: true });
  report.screenshots.light = join(output, 'student-ask-ime-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await pause(400);
  await captureEvidence(page, { path: join(output, 'student-ask-ime-dark.png'), fullPage: true });
  report.screenshots.dark = join(output, 'student-ask-ime-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1000, height: 760 });
  await pause(300);
  await captureEvidence(page, { path: join(output, 'student-ask-ime-narrow.png'), fullPage: true });
  report.screenshots.narrow = join(output, 'student-ask-ime-narrow.png');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error?.message ?? String(error);
  if (page) {
    report.failureView = await page.locator('body').innerText().catch(() => null);
    await captureEvidence(page, { path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
  console.error('FAIL', report.error);
  process.exitCode = 1;
} finally {
  try { report.inputMethod.restoredTo = select('com.apple.keylayout.ABC'); } catch {}
  if (originalIme) { try { select(originalIme); report.inputMethod.restoredTo = select('current'); } catch {} }
  await browser?.close().catch(() => {});
  if (upstream) { upstream.closeAllConnections?.(); await new Promise(done => upstream.close(done)).catch(() => {}); }
  try { cli('stop'); } catch (error) { report.steps.push({ step: 'cli-stop', error: String(error.message ?? error).slice(0, 200) }); }
  try { cli('uninstall'); } catch (error) { report.steps.push({ step: 'cli-uninstall', error: String(error.message ?? error).slice(0, 200) }); }
  await writeEvidence(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, signals: report.signals, error: report.error ?? null }));
}
