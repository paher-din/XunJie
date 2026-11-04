import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication, resolveCredential } from '@xunjie/product-runtime';
import { controlledActionReceiver } from '../apps/server/tests/support/action-receiver.mjs';
import { annotationPackage } from '../components/material-annotation/package.mjs';
import { accumulatorPackage } from '../components/state-accumulator/package.mjs';

/**
 * #187 checklist item: real macOS pinyin candidate keys must not send a question or trigger a
 * native-session action, and the Chinese question plus its fixed reference must survive focus
 * changes and reload.
 *
 * Keys are posted with xjkeys through CGEventPost(.hidSystemState), passing WindowServer and the
 * TIS-selected input method. Playwright only navigates, clicks non-text controls and reads; it never
 * fills the question or synthesizes composition events.
 *
 * Requires: XUNJIE_IME_TOOLS (xjkeys + select_ime, Accessibility trusted), an installed Chinese
 * pinyin input method, desktop Google Chrome and XUNJIE_PRODUCT_POSTGRES_BIN.
 */
const output = resolve(process.env.XUNJIE_SESSION_IME_OUTPUT ?? '.verification/wp03-187-ime');
await mkdir(output, { recursive: true });
const shots = join(output, 'shots');
await mkdir(shots, { recursive: true });
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Native PostgreSQL required (set XUNJIE_PRODUCT_POSTGRES_BIN).');
const postgresVersion = /(\d+\.\d+)/.exec(execFileSync(join(postgresBin, 'postgres'), ['--version'], { encoding: 'utf8' }))[1];
const IME_TOOLS = process.env.XUNJIE_IME_TOOLS;
if (!IME_TOOLS) throw new Error('Key-injection helpers required (set XUNJIE_IME_TOOLS to the directory holding xjkeys and select_ime).');
const KEYS = join(IME_TOOLS, 'xjkeys'), SELECT_IME = join(IME_TOOLS, 'select_ime');
const IME = process.env.XUNJIE_IME_ID ?? 'com.bytedance.inputmethod.doubaoime.pinyin';
const keys = (...args) => execFileSync(KEYS, args, { encoding: 'utf8' }).trim();
const arrow = name => execFileSync('/usr/bin/osascript', ['-e', `tell application "System Events" to key code ${name === 'down' ? 125 : 126}`], { encoding: 'utf8' });
const erase = () => execFileSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to key code 51'], { encoding: 'utf8' });
const ime = (...args) => execFileSync(SELECT_IME, args, { encoding: 'utf8' }).trim();
const sleep = ms => new Promise(done => setTimeout(done, ms));
if (keys('check') !== 'trusted') throw new Error('xjkeys is not Accessibility-trusted; grant it and retry.');

const root = await mkdtemp(join(tmpdir(), 'xj187-ime-'));
const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
  postgresBin, postgresVersion, webRoot: resolve('apps/web/dist-runtime'),
  windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') } });
const report = { kind: 'macos-system-ime-session-acceptance', ticket: '#187', parent: '#174',
  date: new Date().toISOString().slice(0, 10), codeSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  platform: process.platform, arch: process.arch, os: release(), node: process.version, postgres: postgresVersion,
  injection: { tool: 'xjkeys', mechanism: 'CGEventPost(.hidSystemState)', source: 'OS WindowServer', accessibilityTrusted: true },
  inputMethod: { requested: IME, currentBefore: null, selected: null, currentAfter: null },
  steps: [], cases: [], signals: null, screenshots: {}, teaching: 'not evaluated', status: 'running' };
let browser, page, context, endpoint, host;
const pass = (name, detail) => { report.cases.push({ name, detail }); console.log('PASS ' + name); };
try {
  await runtime.install({ profile: 'local' });
  const receiver = controlledActionReceiver('session-ime-receiver');
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context, { receivers: [receiver] }) });
  endpoint = host.endpoint;
  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const api = async (route, body, headers = admin) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, `API ${route} ${response.status}`);
    return response.json();
  };
  const annotation = await api('manage/component-import', { requestId: randomUUID(), ...await annotationPackage() });
  const accumulator = await api('manage/component-import', { requestId: randomUUID(), ...await accumulatorPackage() });
  const materialId = randomUUID(), text = '观察与解释：先记录事实，再核对证据。', bytes = Buffer.from(text);
  const courseId = randomUUID(), releaseId = randomUUID();
  await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '系统输入法与恢复会话验收' },
    task: { taskId: randomUUID(), title: '系统拼音候选与真实会话', summary: '' },
    release: { releaseId, objectives: ['系统输入法候选不误触发发送或会话操作'], requirements: '用系统中文输入法写问题并保留引用。', starterWorks: [], capabilities: [],
      components: [
        { key: 'annotation', definition: annotation, configuration: { title: '材料标注' }, materialIds: [materialId] },
        { key: 'accumulator', definition: accumulator, configuration: { title: '恢复累加器' }, materialIds: [] }],
      materials: [{ materialId, title: '阅读材料', path: 'material.txt', mediaType: 'text/plain', access: 'student',
        byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] },
    resources: [{ path: 'material.txt', contentBase64: bytes.toString('base64') }] });
  const password = randomUUID(), loginName = 'session-ime';
  const member = await api('manage/members', { requestId: randomUUID(), loginName, password });
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true });

  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=1400,980'] });
  report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1400, height: 940 } });
  assert.equal((await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  assert.equal(created.status(), 200);
  const activity = await created.json();
  const contextValue = await (await context.request.get(endpoint + '/api/learning/context')).json();
  const spaceKey = contextValue.identities.find(item => item.identity.kind === 'school')?.key ?? contextValue.identities[0].key;
  const intents = async () => (await context.request.get(endpoint + '/api/learning/intents/' + activity.activityId)).json();
  const draft = async () => (await context.request.get(endpoint + '/api/learning/drafts/' + activity.activityId)).json();
  const sessions = async () => (await context.request.get(endpoint + '/api/learning/executions/' + activity.activityId + '/sessions')).json();

  page = await context.newPage();
  page.on('pageerror', error => console.log('BROWSER ERROR ' + error.message));
  await page.goto(endpoint + '?space=' + encodeURIComponent(spaceKey) + '&activity=' + activity.activityId);
  await expect(page.locator('#activity-title')).toHaveText('系统拼音候选与真实会话');

  await page.getByRole('tab', { name: '材料标注', exact: true }).click();
  const frame = page.frameLocator('iframe[title="材料标注"]');
  await expect(frame.getByRole('button', { name: '标注选中文字', exact: true })).toBeEnabled();
  await frame.locator('#materials p').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  await frame.getByRole('button', { name: '标注选中文字', exact: true }).click();
  await frame.getByRole('textbox', { name: '标注内容', exact: true }).fill('输入法验收的标注');
  await frame.getByRole('button', { name: '选择此标注', exact: true }).click();
  await page.getByRole('button', { name: '询问 Agent', exact: true }).last().click();
  const refs = page.getByRole('region', { name: '上下文引用' });
  const question = page.getByRole('textbox', { name: '你的问题', exact: true });
  await expect(refs.locator('li')).toHaveCount(1);
  await expect(question).toBeVisible();
  assert.deepEqual(await intents(), []);
  pass('composer holds one annotation reference before any typing', 'reference area ready, no intent');

  // Start a real v2 session before the IME pass, then only query it while composing.
  const executionPosts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/api/learning/executions/')) executionPosts.push(request.url());
  });
  await page.getByRole('tab', { name: '恢复累加器', exact: true }).click();
  const panel = page.getByRole('region', { name: '本机会话', exact: true });
  await panel.getByRole('button', { name: '启动本机会话', exact: true }).click();
  await expect(panel.locator('.native-session-observation')).toContainText('当前状态');
  await expect(panel.locator('.native-session-observation strong')).toHaveText('0');
  await expect(panel.getByRole('button', { name: '暂停', exact: true })).toBeEnabled();
  const postsAfterStart = executionPosts.length;
  assert.ok(postsAfterStart >= 1, 'the session start must be a real owner request');
  await expect(question).toBeVisible();
  pass('a real session is running while the composer stays available', `${postsAfterStart} execution POST(s) for start`);

  await page.evaluate(() => {
    window.__imeEvents = [];
    const push = (type, event) => window.__imeEvents.push({ type, at: Math.round(performance.now()), trusted: event.isTrusted,
      key: event.key ?? null, keyCode: event.keyCode ?? null, isComposing: event.isComposing ?? null,
      inputType: event.inputType ?? null, data: event.data ?? null, value: event.target && 'value' in event.target ? event.target.value : null });
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown']) {
      document.addEventListener(type, event => { if (event.target === document.querySelector('textarea')) push(type, event); }, true);
    }
  });
  const events = () => page.evaluate(() => window.__imeEvents.slice(0, 800));

  const activate = async () => {
    await page.bringToFront();
    try { execFileSync('/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to activate'], { encoding: 'utf8' }); }
    catch (error) { report.steps.push({ step: 'activate', error: String(error.message ?? error).slice(0, 200) }); }
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await page.evaluate(() => document.hasFocus())) return true;
      await sleep(200);
    }
    return false;
  };
  const focusQuestion = async () => {
    assert.ok(await activate(), 'the Chrome window must own system focus before any keystroke');
    await question.click();
    await question.evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
    await sleep(250);
    const state = await page.evaluate(() => ({ active: document.activeElement?.tagName ?? null, hasFocus: document.hasFocus() }));
    assert.equal(state.active, 'TEXTAREA', 'the question textarea must own focus');
    assert.ok(state.hasFocus, 'the browser window must own system focus');
  };
  const typeSlow = async pinyin => { for (const letter of pinyin) { keys('type', letter); await sleep(140); } };
  const capture = async name => {
    const file = join(shots, `${name}.png`);
    try {
      execFileSync('/usr/sbin/screencapture', ['-x', file]);
      report.screenshots[name] = file.slice(process.cwd().length + 1);
      return file;
    } catch (error) {
      report.steps.push({ step: 'screencapture', name, error: String(error.message ?? error).slice(0, 200) });
      return null;
    }
  };

  report.inputMethod.currentBefore = ime('current');
  report.inputMethod.selected = ime(IME);
  report.inputMethod.currentAfter = ime('current');
  assert.equal(report.inputMethod.currentAfter, IME, 'the TIS-selected input method must be the Chinese pinyin IME');
  pass('the system Chinese pinyin input method is selected through TIS', report.inputMethod.currentAfter);

  await focusQuestion();
  keys('key', 'esc');
  await sleep(300);

  // 0) One Chinese question first, so the send path is live while candidate keys are pressed.
  await typeSlow('weishenme');
  await sleep(600);
  keys('key', 'space');
  await sleep(800);
  const firstText = await question.inputValue();
  assert.match(firstText, /^[\u4e00-\u9fff]+$/u, 'the first composition must commit Chinese only: ' + firstText);
  await expect(page.getByRole('button', { name: '发送问题', exact: true })).toBeEnabled();
  assert.deepEqual(await intents(), [], 'committing a candidate must not send');
  pass('a first Chinese question makes the send path live', JSON.stringify(firstText));

  // 1) Enter while the system candidate window is open must not send, insert a newline or pause.
  await typeSlow('nihao');
  await sleep(600);
  await capture('candidate-enter');
  const beforeEnter = await question.inputValue();
  keys('key', 'return');
  await sleep(800);
  const afterEnter = await question.inputValue();
  const enterEvents = (await events()).filter(event => event.type === 'keydown' && event.key === 'Enter');
  report.steps.push({ step: 'enter-during-candidates', before: beforeEnter, after: afterEnter,
    keydowns: enterEvents.map(event => ({ trusted: event.trusted, keyCode: event.keyCode, isComposing: event.isComposing })) });
  assert.ok(enterEvents.length >= 1, 'the Enter key must reach the page');
  assert.ok(enterEvents.every(event => event.trusted), 'the Enter key must be a trusted OS event');
  assert.ok(!afterEnter.includes('\n'), 'Enter during composition must not insert a line break');
  assert.deepEqual(await intents(), [], 'Enter during composition must not send the question');
  assert.equal(executionPosts.length, postsAfterStart, 'Enter during composition must not control the session');
  assert.ok(afterEnter.startsWith(firstText), 'Enter must not replace the existing question');
  await expect(panel.getByRole('button', { name: '暂停', exact: true })).toBeEnabled();
  pass('Enter during the candidate window neither sends nor controls the session',
    `isComposing=${enterEvents.map(event => event.isComposing).join(',')} keyCode=${enterEvents.map(event => event.keyCode).join(',')}`);

  const appended = afterEnter.startsWith(firstText) ? afterEnter.slice(firstText.length).length : 0;
  for (let index = 0; index < appended; index++) { erase(); await sleep(60); }
  await sleep(400);
  assert.equal(await question.inputValue(), firstText, 'the raw pinyin committed by Enter must be removable');
  pass('the raw pinyin committed by Enter is separate from the question', `deleted ${appended} characters`);

  // 2) Escape during composition cancels the composition, not the composer or the session.
  await focusQuestion();
  await typeSlow('shijie');
  await sleep(500);
  keys('key', 'esc');
  await sleep(500);
  await expect(refs).toBeVisible();
  assert.equal(await refs.locator('li').count(), 1, 'Escape must not remove the reference');
  assert.equal(await question.inputValue(), firstText, 'Escape must leave the question untouched');
  assert.deepEqual(await intents(), [], 'Escape during composition must not send');
  assert.equal(executionPosts.length, postsAfterStart, 'Escape during composition must not control the session');
  pass('Escape during the candidate window cancels the composition only', 'composer, question, reference and session stay intact');

  // 3) A digit key picks a candidate and commits Chinese without sending or controlling.
  await typeSlow('shijie');
  await sleep(500);
  await capture('candidate-digit');
  const beforeDigit = await question.inputValue();
  keys('type', '1');
  await sleep(800);
  const afterDigit = await question.inputValue();
  report.steps.push({ step: 'digit-candidate', before: beforeDigit, after: afterDigit });
  assert.ok(afterDigit.startsWith(firstText), 'the digit commit must append to the question');
  assert.match(afterDigit.slice(firstText.length), /^[\u4e00-\u9fff]+$/u, 'a digit key must commit Chinese only: ' + afterDigit);
  assert.deepEqual(await intents(), [], 'candidate keys must not send');
  assert.equal(executionPosts.length, postsAfterStart, 'candidate keys must not control the session');
  pass('a digit key picks a system candidate and commits Chinese', JSON.stringify(afterDigit));

  // 4) Arrow keys move inside the candidate window; Space commits the highlighted candidate.
  await typeSlow('zhongguo');
  await sleep(500);
  arrow('down');
  await sleep(300);
  await capture('candidate-arrow');
  keys('key', 'space');
  await sleep(800);
  const afterArrow = await question.inputValue();
  report.steps.push({ step: 'arrow-candidate', after: afterArrow });
  assert.ok(afterArrow.length > afterDigit.length, 'the arrow selection must append another candidate');
  assert.match(afterArrow.slice(afterDigit.length), /^[\u4e00-\u9fff]+$/u, 'arrow + Space must commit Chinese');
  assert.deepEqual(await intents(), [], 'arrow keys must not send');
  assert.equal(executionPosts.length, postsAfterStart, 'arrow keys must not control the session');
  pass('arrow keys and Space pick a candidate without triggering anything else', JSON.stringify(afterArrow));

  // 5) Continue editing in the same composer, then move focus away from the text field.
  await typeSlow('butong');
  await sleep(800);
  keys('type', '1');
  await sleep(800);
  const finalText = await question.inputValue();
  assert.ok(finalText.length > afterArrow.length, 'continued editing must extend the question');
  assert.match(finalText.slice(afterArrow.length), /^[\u4e00-\u9fff]+$/u, 'continued editing must commit Chinese');
  await expect.poll(async () => (await draft()).question).toBe(finalText);
  await panel.getByRole('button', { name: '核对状态', exact: true }).click();
  await expect(panel.locator('.native-session-observation strong')).toHaveText('0');
  assert.equal(await question.inputValue(), finalText, 'switching focus must not change the composed question');
  assert.equal(await refs.locator('li').count(), 1, 'switching focus must not drop the reference');
  assert.deepEqual(await intents(), [], 'no send happened during the whole IME pass');
  assert.equal(executionPosts.length, postsAfterStart, 'focus changes must not control the session');
  const composed = (await events()).filter(event => event.type === 'compositionend');
  report.signals = { compositionStarts: (await events()).filter(event => event.type === 'compositionstart').length,
    compositionEnds: composed.length, commits: composed.map(event => event.data).filter(Boolean),
    enterWhileComposing: enterEvents.filter(event => event.isComposing || event.keyCode === 229).length,
    executionPostsDuringIme: executionPosts.length - postsAfterStart };
  assert.ok(report.signals.compositionStarts >= 4, 'each composition must open with compositionstart');
  assert.ok(report.signals.compositionEnds >= 4, 'each composition must close with compositionend');
  pass('continued editing commits through the system IME and focus switching is safe', JSON.stringify(finalText));

  // 6) The running session still accepts an explicit control after the IME pass.
  await panel.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(panel.getByRole('button', { name: '恢复推进', exact: true })).toBeEnabled();
  assert.equal((await sessions())[0].state, 'paused');
  await panel.getByRole('button', { name: '恢复推进', exact: true }).click();
  await expect(panel.getByRole('button', { name: '暂停', exact: true })).toBeEnabled();
  pass('the running session still accepts explicit pause and resume after the IME pass', `${executionPosts.length} execution POST(s) total`);

  // 7) Reload: the Chinese question and the reference come back from the business API.
  await page.reload();
  await expect(page.getByRole('button', { name: '打开对话', exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '打开对话', exact: true }).click();
  await expect(page.getByRole('region', { name: '上下文引用' }).locator('li')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: '你的问题', exact: true })).toHaveValue(finalText);
  await expect(page.getByRole('region', { name: '上下文引用' })).toContainText('输入法验收的标注');
  assert.deepEqual(await intents(), [], 'reload must not invent a send');
  pass('reload restores the Chinese question and the reference', JSON.stringify(finalText));

  await page.getByRole('tab', { name: '恢复累加器', exact: true }).click();
  await expect(page.getByRole('region', { name: '本机会话', exact: true })).toBeVisible();
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(300);
  await page.screenshot({ path: join(output, 'ime-light.png'), fullPage: true });
  report.screenshots['ime-light'] = join(output, 'ime-light.png').slice(process.cwd().length + 1);
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(400);
  await page.screenshot({ path: join(output, 'ime-dark.png'), fullPage: true });
  report.screenshots['ime-dark'] = join(output, 'ime-dark.png').slice(process.cwd().length + 1);
  await page.emulateMedia({ colorScheme: 'light' });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  if (page) {
    report.failureView = await page.locator('body').innerText().catch(() => null);
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await host?.stop().catch(() => {});
  await runtime.stop().catch(() => {});
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
