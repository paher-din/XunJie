import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, release, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium, expect } from '@playwright/test';

/**
 * #210: macOS system Chinese input method on the WP07 input-control surface.
 *
 * Text reaches Chrome only through WindowServer and the TIS-selected system input method.
 * xjkeys posts HID-level key events; System Events posts the keys xjkeys does not map.
 * Playwright only navigates, clicks non-text controls and reads state; it never fills text.
 */
const product = resolve(process.env.XUNJIE_PRODUCT_PACKAGE ?? '.verification/wp07-210/product-darwin-arm64-full');
const output = resolve(process.env.XUNJIE_INPUT_CONTROL_IME_OUTPUT
  ?? 'docs/student-agent-implementation/evidence/wp07-210');
const helper = resolve(process.env.XUNJIE_IME_TOOLS ?? join(homedir(), 'xj-154/ime'));
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim();
const key = (...args) => run(join(helper, 'xjkeys'), args);
const select = value => run(join(helper, 'select_ime'), [value]);
const systemKey = (code, modifiers = '') => run('/usr/bin/osascript', ['-e',
  `tell application "System Events" to key code ${code}${modifiers ? ` using {${modifiers}}` : ''}`]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(done => setTimeout(done, ms));
const until = async (check, description, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(100); }
  throw new Error(description);
};

assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const desktopOwner = run('/usr/bin/swift', ['-e', 'import AppKit; print(NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown")']);
assert.notEqual(desktopOwner, 'loginwindow', 'Unlock the macOS desktop before physical system IME acceptance.');
assert.equal(key('check'), 'trusted', 'the existing HID helper must already be Accessibility trusted');
await mkdir(output, { recursive: true });
const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
const node = join(product, resources.nodePath);
const cli = (...args) => JSON.parse(run(node, [join(product, 'app/cli.js'), ...args, '--root', root]));
const root = await mkdtemp(join(tmpdir(), 'xj-input-control-ime-'));
const originalIme = select('current');
const chineseIme = 'com.bytedance.inputmethod.doubaoime.pinyin';
const report = {
  kind: 'macos-system-ime-input-control-acceptance',
  ticket: '#210', sourceIssue: '#200',
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
const answer = (response, value) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of [
    { id: 'input-ime', choices: [{ index: 0, delta: { role: 'assistant', content: value.text }, finish_reason: null }] },
    { id: 'input-ime', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(chunk) + '\n\n');
  response.end('data: [DONE]\n\n');
};
const ask = (response, value) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const tool = { role: 'assistant', tool_calls: [{ index: 0, id: 'ime-question', type: 'function',
    function: { name: 'student_ask', arguments: JSON.stringify(value) } }] };
  for (const chunk of [
    { id: 'input-ime', choices: [{ index: 0, delta: tool, finish_reason: null }] },
    { id: 'input-ime', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(chunk) + '\n\n');
  response.end('data: [DONE]\n\n');
};
try {
  cli('install', '--profile', 'local');
  ({ endpoint } = cli('start'));
  report.endpoint = endpoint;

  let releaseGate = () => {};
  const gate = new Promise(done => { releaseGate = done; });
  upstream = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      payloads.push(payload);
      if (payloads.length === 1) { await gate; answer(response, { text: '原回答完成。' }); }
      else if (payloads.length === 2) ask(response, { question: '你预计状态 3 再输入 2 会变成几？',
        source: '当前学习目标与中文回应', options: [], allowText: true, skippable: true });
      else answer(response, { text: '已根据你的中文回应继续。' });
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
    name: '运行中输入法验收', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    path: '/chat/completions', modelId: 'fixture-input-control-ime', dialect: 'standard', parameterMode: 'plain',
    enabled: true, contextWindow: 262144, maxOutputTokens: 2048,
    credential: { action: 'replace', value: 'synthetic-input-control-ime-key' } });
  await api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' });
  const selection = await api('models/selection');
  await api('models/selection', { requestId: randomUUID(), expectedVersion: selection.version,
    source: { kind: 'personal', connectionId, grantId } });
  const activity = await api('activities', { requestId: randomUUID(), goal: '核对运行中补充与中文输入', question: '', references: [] });
  const activityId = activity.activityId;
  const conversation = () => api(`agent/${activityId}/conversation`);

  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-automation', '--window-size=1360,980'] });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1360, height: 940 } });
  page = await context.newPage();
  page.on('pageerror', error => console.log('BROWSER ERROR ' + error.message));
  await page.goto(endpoint + '/?activity=' + activityId);
  const openConversation = page.getByRole('button', { name: '打开对话', exact: true });
  await expect(openConversation).toBeVisible({ timeout: 20000 });
  await openConversation.click();
  const composer = page.getByLabel('你的问题', { exact: true });
  await expect(composer).toBeVisible({ timeout: 20000 });
  await expect(composer).toBeEnabled();

  await page.evaluate(() => {
    window.__imeEvents = [];
    const push = (type, event) => window.__imeEvents.push({ type, at: Math.round(performance.now()),
      trusted: event.isTrusted, key: event.key ?? null, keyCode: event.keyCode ?? null,
      isComposing: event.isComposing ?? null, inputType: event.inputType ?? null, data: event.data ?? null,
      value: event.target && 'value' in event.target ? event.target.value : null });
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown']) {
      document.addEventListener(type, event => { if (event.target instanceof HTMLTextAreaElement) push(type, event); }, true);
    }
  });
  const events = () => page.evaluate(() => window.__imeEvents.slice(0, 2000));
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
  const focusComposer = async () => {
    assert.ok(await activate(), 'the Chrome window must own system focus before any keystroke');
    await composer.click();
    await composer.evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
    await pause(250);
    const state = await page.evaluate(() => ({ active: document.activeElement?.tagName ?? null, hasFocus: document.hasFocus() }));
    assert.equal(state.active, 'TEXTAREA', 'the composer textarea must own focus');
    assert.ok(state.hasFocus, 'the browser window must own system focus');
  };
  const focusResponse = async () => {
    assert.ok(await activate(), 'the Chrome window must own system focus before any keystroke');
    const response = page.getByLabel('你的回应', { exact: true });
    await response.click();
    await response.evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
    await pause(250);
    const state = await page.evaluate(() => ({ active: document.activeElement?.tagName ?? null, hasFocus: document.hasFocus() }));
    assert.equal(state.active, 'TEXTAREA', 'the response textarea must own focus');
    assert.ok(state.hasFocus, 'the browser window must own system focus');
    return response;
  };
  const typeSlow = async pinyin => { for (const letter of pinyin) { key('type', letter); await pause(190); } };
  const captureWindow = async name => {
    try {
      const bounds = run('/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to get bounds of front window'])
        .split(',').map(value => Number(value.trim()));
      assert.equal(bounds.length, 4, 'window bounds must have four values');
      const [x1, y1, x2, y2] = bounds;
      const file = join(output, `${name}.png`);
      execFileSync('/usr/sbin/screencapture', ['-x', `-R${x1},${y1},${x2 - x1},${y2 - y1}`, file]);
      report.screenshots[name] = file;
      return file;
    } catch (error) {
      report.steps.push({ step: 'capture-window', name, error: String(error.message ?? error).slice(0, 200) });
      return null;
    }
  };

  try { select('com.apple.keylayout.ABC'); await pause(700); } catch {}
  report.inputMethod.currentBefore = originalIme;
  report.inputMethod.selected = select(chineseIme);
  await pause(1200);
  report.inputMethod.currentAfter = select('current');
  assert.equal(report.inputMethod.currentAfter, chineseIme, 'the TIS-selected input method must be the Chinese pinyin IME');
  pass('the system Chinese pinyin input method is selected through TIS', report.inputMethod.currentAfter);

  // 1) Real composition and Space candidate commits edit the composer without sending.
  await focusComposer();
  key('key', 'esc');
  await pause(300);
  await typeSlow('nihao');
  await pause(900);
  await captureWindow('ime-candidate-nihao');
  key('key', 'space');
  await pause(1600);
  const hello = await composer.inputValue();
  assert.match(hello, /^[\u4e00-\u9fff]+$/u, 'a Space candidate commit must produce Chinese: ' + hello);
  assert.equal(payloads.length, 0, 'candidate commit must not send a question');
  await typeSlow('ma');
  await pause(900);
  key('key', 'space');
  await pause(1600);
  const questionText = await composer.inputValue();
  assert.ok(questionText.startsWith(hello) && /^[\u4e00-\u9fff]+$/u.test(questionText.slice(hello.length)),
    'a second candidate must append Chinese: ' + questionText);
  assert.equal(payloads.length, 0);
  await captureWindow('ime-composer-chinese');
  pass('system IME composition and Space candidates edit the composer in Chinese without sending', JSON.stringify(questionText));

  // 2) Explicit send starts the real Run; the busy draft keeps focus and reading position.
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await until(() => payloads.length === 1, 'The first real model request starts.');
  await focusComposer();
  await typeSlow('liu');
  await pause(900);
  key('key', 'space');
  await pause(1600);
  const busyDraft = await composer.inputValue();
  assert.match(busyDraft, /^[\u4e00-\u9fff]+$/u, 'the busy draft must contain Chinese: ' + busyDraft);
  assert.equal(payloads.length, 1, 'editing during a Run must not send another question');
  await focusComposer();
  const scroll = await page.evaluate(() => {
    const element = document.querySelector('.teaching-conversation');
    if (element && element.scrollHeight > element.clientHeight) {
      element.scrollTop = Math.min(64, element.scrollHeight - element.clientHeight);
      return { kind: 'conversation', top: element.scrollTop };
    }
    window.scrollTo(0, Math.min(64, document.documentElement.scrollHeight - innerHeight));
    return { kind: 'window', top: window.scrollY };
  });
  report.steps.push({ step: 'background-scroll', scroll });
  releaseGate();
  await expect(page.getByText('原回答完成。', { exact: true })).toBeVisible({ timeout: 30000 });
  const afterResult = await page.evaluate(() => {
    const element = document.querySelector('.teaching-conversation');
    return { value: document.querySelector('.wr-composer textarea')?.value ?? null,
      active: document.activeElement?.tagName ?? null,
      conversationTop: element?.scrollTop ?? null, windowTop: window.scrollY };
  });
  assert.equal(afterResult.value, busyDraft, 'the background result must not overwrite the Chinese draft');
  assert.equal(afterResult.active, 'TEXTAREA', 'the background result must not steal focus');
  assert.equal(scroll.kind === 'conversation' ? afterResult.conversationTop : afterResult.windowTop, scroll.top,
    'the background result must not move the reading position');
  assert.equal(payloads.length, 1, 'the background result must not submit the draft');
  pass('a Chinese busy draft survives result arrival with focus and reading position intact', JSON.stringify(afterResult));

  // 3) The preserved draft sends as the next Run and the real question accepts a Chinese response.
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await until(() => payloads.length === 2, 'The preserved draft starts the next real request.');
  const card = page.getByRole('group', { name: 'Agent 的提问', exact: true });
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText('你预计状态 3 再输入 2 会变成几？');
  const responseEntry = await focusResponse();
  await typeSlow('wo');
  await pause(900);
  await captureWindow('ime-response-candidate');
  key('key', 'space');
  await pause(1600);
  await typeSlow('shi');
  await pause(900);
  key('key', 'space');
  await pause(1600);
  const responseText = await responseEntry.inputValue();
  assert.match(responseText, /^[\u4e00-\u9fff]+$/u, 'the response must contain Chinese: ' + responseText);
  assert.equal(payloads.length, 2, 'editing the response must not submit it');
  await captureWindow('ime-response-chinese');
  await card.getByRole('button', { name: '提交回应', exact: true }).click();
  await expect(page.getByText('已根据你的中文回应继续。', { exact: true })).toBeVisible({ timeout: 30000 });
  const final = await conversation();
  assert.equal(final.questions[0].state, 'answered');
  assert.equal(final.questions[0].response.answer.kind, 'text');
  const requestPayload = JSON.stringify(payloads[2]);
  for (const value of responseText.split('\n')) assert.ok(requestPayload.includes(value), 'the Chinese response must reach the model request');
  assert.equal(payloads.length, 3);
  pass('the Chinese response submits once and continues the original Run', JSON.stringify(responseText));

  // 4) Candidate-confirmation Enter never sends; dark and narrow desktop remain usable.
  await page.setViewportSize({ width: 640, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await pause(400);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'the narrow dark desktop must not overflow horizontally');
  await focusComposer();
  await typeSlow('zhongguo');
  await pause(900);
  await captureWindow('ime-candidate-dark-narrow');
  const beforeEnter = await composer.inputValue();
  const runsBefore = (await conversation()).runs.length;
  key('key', 'return');
  await pause(900);
  const afterEnter = await composer.inputValue();
  const activeAfterEnter = await page.evaluate(() => document.activeElement?.tagName ?? null);
  report.steps.push({ step: 'candidate-enter', beforeEnter, afterEnter, activeAfterEnter, payloads: payloads.length });
  assert.equal(payloads.length, 3, 'candidate-confirmation Enter must not send a question');
  assert.equal((await conversation()).runs.length, runsBefore, 'candidate-confirmation Enter must not start another Run');
  assert.ok(afterEnter.trim().length > 0, 'candidate-confirmation Enter must keep text in the composer');
  assert.equal(activeAfterEnter, 'TEXTAREA', 'candidate-confirmation Enter must keep focus in the composer');
  await page.screenshot({ path: join(output, 'ime-dark-narrow.png'), fullPage: true });
  report.screenshots['ime-dark-narrow'] = join(output, 'ime-dark-narrow.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1360, height: 940 });
  await pause(300);
  await page.screenshot({ path: join(output, 'ime-light.png'), fullPage: true });
  report.screenshots['ime-light'] = join(output, 'ime-light.png');
  pass('candidate-confirmation Enter keeps text in the composer and sends nothing on the dark narrow desktop',
    JSON.stringify({ beforeEnter, afterEnter }));

  const observed = await events();
  const starts = observed.filter(event => event.type === 'compositionstart');
  const updates = observed.filter(event => event.type === 'compositionupdate');
  const ends = observed.filter(event => event.type === 'compositionend');
  const composingKeydowns = observed.filter(event => event.type === 'keydown' && (event.isComposing || event.keyCode === 229));
  const commits = observed.filter(event => event.type === 'beforeinput' && event.inputType === 'insertCompositionText'
    && /[\u4e00-\u9fff]/.test(String(event.data ?? '')));
  report.signals = { compositionStarts: starts.length, compositionUpdates: updates.length, compositionEnds: ends.length,
    composingKeydowns: composingKeydowns.length, chineseCompositionCommits: commits.slice(0, 20).map(event => event.data),
    trustedKeydowns: observed.filter(event => event.type === 'keydown' && event.trusted).length };
  assert.ok(report.signals.compositionStarts >= 3, 'each composition must open with compositionstart');
  assert.ok(report.signals.composingKeydowns >= 8, 'IME composition must produce VK_PROCESSKEY keydowns');
  assert.equal(modelErrors.length, 0);
  pass('the page records trusted composition signals rather than synthetic text input', JSON.stringify(report.signals));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error?.message ?? String(error);
  if (page) {
    report.failureView = await page.locator('body').innerText().catch(() => null);
    await page.screenshot({ path: join(output, 'ime-failure.png'), fullPage: true }).catch(() => {});
  }
  console.error('FAIL', report.error);
  process.exitCode = 1;
} finally {
  try { select('com.apple.keylayout.ABC'); report.inputMethod.restoredTo = select('current'); } catch {}
  await browser?.close().catch(() => {});
  if (upstream) { upstream.closeAllConnections?.(); await new Promise(done => upstream.close(done)).catch(() => {}); }
  try { cli('stop'); } catch (error) { report.steps.push({ step: 'cli-stop', error: String(error.message ?? error).slice(0, 200) }); }
  try { cli('uninstall'); } catch (error) { report.steps.push({ step: 'cli-uninstall', error: String(error.message ?? error).slice(0, 200) }); }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'input-control-ime.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(root, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, signals: report.signals, error: report.error ?? null }));
}
