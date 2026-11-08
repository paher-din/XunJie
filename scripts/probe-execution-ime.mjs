import { probeEvidenceDirectory, writeEvidence, captureEvidence, mkdtemp, hasProbeEvidence } from './lib/probe-evidence.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { aggregationPackage } from '../components/table-aggregation/package.mjs';

/**
 * Physical keyboard-level system Chinese IME candidate acceptance for #170.
 *
 * Keys are posted with xjkeys via CGEventPost(.cghidEventTap, .hidSystemState), so they pass
 * WindowServer and the TIS-selected system input method (Doubao Pinyin) before Chrome sees them.
 * Playwright only navigates, clicks non-text controls and reads the page; it never synthesizes
 * text input or composition. Candidate commits are real Space / digit keys consumed by the IME.
 *
 * Requires: /Users/robertwu/xj-154/ime/{xjkeys,select_ime} (ad-hoc signed, Accessibility trusted),
 * installed Doubao Pinyin, desktop Google Chrome, XUNJIE_PRODUCT_POSTGRES_BIN.
 */
const output = probeEvidenceDirectory(process.env.XUNJIE_EXECUTION_OUTPUT);
const webRoot = resolve(process.env.XUNJIE_PRODUCT_WEB_ROOT ?? 'apps/web/dist-runtime');
const IME_TOOLS = process.env.XUNJIE_IME_TOOLS ?? '/Users/robertwu/xj-154/ime';
const KEYS = join(IME_TOOLS, 'xjkeys');
const SELECT_IME = join(IME_TOOLS, 'select_ime');
const IME = 'com.bytedance.inputmethod.doubaoime.pinyin';
const ABC = 'com.apple.keylayout.ABC';
await mkdir(output, { recursive: true });
const shots = join(output, 'ime-shots');
await mkdir(shots, { recursive: true });
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Native PostgreSQL required');

const keys = (...args) => execFileSync(KEYS, args, { encoding: 'utf8' }).trim();
const ime = (...args) => execFileSync(SELECT_IME, args, { encoding: 'utf8' }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const trust = keys('check');
if (trust !== 'trusted') throw new Error('xjkeys accessibility-untrusted: grant Accessibility and retry');

const root = await mkdtemp(join(tmpdir(), 'xj-execution-ime-'));
const report = {
  kind: 'system-ime-candidate-acceptance',
  ticket: '#170',
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  os: release(),
  node: process.version,
  injection: { tool: 'xjkeys', mechanism: 'CGEventPost(.cghidEventTap, .hidSystemState)', source: 'OS WindowServer', accessibilityTrusted: true },
  inputMethod: { requested: IME, selected: null, currentBefore: null, currentAfter: null, restoredTo: null },
  cases: [],
  steps: [],
  events: null,
  signals: null,
  screenshots: {},
  status: 'running',
};
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };

report.inputMethod.currentBefore = ime('current');

const runtime = openProductRuntime({ root, resources: {
  nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
  postgresVersion: '18.6', webRoot, windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1'),
} });
let browser;
try {
  await runtime.install({ profile: 'local' });
  const { endpoint } = await runtime.start();
  report.endpoint = endpoint;
  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const api = async (route, body, headers = {}) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200, `API ${route} ${response.status}`);
    return response.json();
  };
  const published = await aggregationPackage();
  const definition = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
  await api('manage/course-import', {
    formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '输入法候选验收' },
    task: { taskId, title: '系统中文输入法候选', summary: '物理键击组字并选择候选后计算' },
    release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
      releaseId, objectives: ['系统输入法候选上屏进入计算'], requirements: '用系统中文输入法填写表格后运行计算。',
      starterWorks: [], capabilities: [],
      components: [{ key: 'table', definition, configuration: { title: '表格聚合' }, materialIds: [] }],
      materials: [],
    },
    resources: [],
  }, admin);
  const password = randomUUID(), loginName = 'execution-ime';
  const member = await api('manage/members', { requestId: randomUUID(), loginName, password }, admin);
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);

  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=1280,940'] });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const login = await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  assert.equal(login.status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  assert.equal(created.status(), 200);
  const activity = await created.json();
  report.activityId = activity.activityId;

  const page = await context.newPage();
  page.on('pageerror', error => console.log('BROWSER ERROR ' + error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE ' + message.text().slice(0, 300)); });
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await expect(page.locator('#activity-title')).toHaveText('系统中文输入法候选');
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  const frame = page.frameLocator('iframe[title="表格聚合"]');
  await expect(frame.getByRole('heading', { name: '表格聚合', exact: true })).toBeVisible();

  // Read-only observer inside the component frame. It records real DOM events only.
  await frame.locator('body').evaluate(() => {
    window.__imeEvents = [];
    const push = (type, extra) => window.__imeEvents.push({ type, at: Math.round(performance.now()), ...extra });
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown', 'keyup']) {
      document.addEventListener(type, event => {
        push(type, {
          trusted: event.isTrusted,
          key: event.key ?? null,
          code: event.code ?? null,
          keyCode: event.keyCode ?? null,
          isComposing: event.isComposing ?? null,
          inputType: event.inputType ?? null,
          data: event.data ?? null,
          field: event.target instanceof Element ? (event.target.getAttribute('aria-label') ?? event.target.tagName) : null,
          value: event.target && 'value' in event.target ? event.target.value : null,
        });
      }, true);
    }
  });

  const frameBody = () => frame.locator('body');
  const readEvents = () => frameBody().evaluate(() => window.__imeEvents.slice(0, 600));
  const cell = (column, row) => frame.getByRole('textbox', { name: `${column} 第${row}行`, exact: true });

  async function arm() {
    await page.bringToFront();
    await sleep(250);
    const focused = await frameBody().evaluate(() => {
      const el = document.activeElement;
      return { tag: el ? el.tagName : null, label: el && el.getAttribute ? el.getAttribute('aria-label') : null, window: document.hasFocus() };
    });
    return focused;
  }

  async function focusCell(column, row) {
    await arm();
    const locator = cell(column, row);
    await locator.click();
    await locator.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await sleep(300);
    const focused = await arm();
    assert.equal(focused.label, `${column} 第${row}行`, `focus must sit on ${column} 第${row}行`);
    return focused;
  }

  const typeSlow = async pinyin => {
    for (const letter of pinyin) {
      keys('type', letter);
      await sleep(140);
    }
  };

  // Capture the candidate overlay: full screen first (system windows), then the front window.
  async function captureWindow(name) {
    if (!hasProbeEvidence(output)) return { ok: false };
    const base = name.replace(/\.png$/, '');
    const full = join(shots, base + '-fullscreen.png');
    const win = join(shots, base + '-window.png');
    try {
      execFileSync('/usr/sbin/screencapture', ['-x', full]);
      report.screenshots[base + '-fullscreen.png'] = full;
    } catch (error) {
      report.steps.push({ step: 'screencapture-full', name, error: String(error.message ?? error).slice(0, 200) });
    }
    try {
      const bounds = execFileSync('/usr/bin/osascript', ['-e',
        'tell application "System Events" to tell (first application process whose frontmost is true)\n' +
        'set p to position of front window\nset s to size of front window\n' +
        'return (item 1 of p as string) & "," & (item 2 of p as string) & "," & (item 1 of s as string) & "," & (item 2 of s as string)\nend tell'],
        { encoding: 'utf8' }).trim();
      const [x, y, w, h] = bounds.split(',').map(Number);
      if ([x, y, w, h].some(value => !Number.isFinite(value)) || w < 400 || h < 300) {
        report.steps.push({ step: 'screencapture-window', name, bounds, skipped: 'untrusted-bounds' });
      } else {
        execFileSync('/usr/sbin/screencapture', ['-x', '-R', `${x},${y},${w},${h + 160}`, win]);
        report.screenshots[base + '-window.png'] = win;
        report.steps.push({ step: 'screencapture-window', name, bounds, path: win });
      }
    } catch (error) {
      report.steps.push({ step: 'screencapture-window', name, error: String(error.message ?? error).slice(0, 200) });
    }
    return { ok: true, full, win };
  }

  // One composition: pinyin letters → system candidate list → commit key (space or a digit).
  async function compose({ pinyin, commit, label, column, row, capture }) {
    const armed = await focusCell(column, row);
    const before = await cell(column, row).inputValue();
    if (capture !== false) {
      await typeSlow(pinyin);
      await sleep(500);
      const shot = await captureWindow(capture ?? `candidate-${label}.png`);
      report.steps.push({ step: 'compose', label, pinyin, commit, focus: armed, before, candidateShot: shot.ok ? shot.path : null });
    } else {
      await typeSlow(pinyin);
      await sleep(500);
      report.steps.push({ step: 'compose', label, pinyin, commit, focus: armed, before });
    }
    if (commit === 'space') keys('key', 'space');
    else if (/^[1-9]$/.test(commit)) keys('type', commit);
    else throw new Error('commit must be space or a digit');
    await sleep(1000);
    const after = await cell(column, row).inputValue();
    report.steps.push({ step: 'commit', label, commit, after });
    return after;
  }

  // Switch to the installed system IME. This is the real TIS selection a user performs with the input menu.
  report.inputMethod.selected = ime(IME);
  report.inputMethod.currentAfter = ime('current');
  assert.equal(report.inputMethod.currentAfter, IME, 'the system input method must be the requested Chinese IME');

  await arm();
  keys('key', 'esc');
  await sleep(400);
  passed('the system Chinese input method is selected through TIS before any text is typed');

  // Two new rows so nothing has to be erased with synthetic fills.
  await frame.getByRole('button', { name: '添加一行', exact: true }).click();
  await frame.getByRole('button', { name: '添加一行', exact: true }).click();
  await expect(cell('姓名', 13)).toHaveValue('');
  await expect(cell('姓名', 14)).toHaveValue('');

  // Row 13: name by first-candidate Space commit, group by a digit-key candidate pick.
  const name13 = await compose({ pinyin: 'nihao', commit: 'space', label: 'nihao-space', column: '姓名', row: 13, capture: 'candidate-nihao-space.png' });
  assert.equal(name13, '你好', `candidate commit must yield 你好, got ${JSON.stringify(name13)}`);
  passed('pinyin nihao plus the system candidate window commits 你好 with a real Space key');

  const group13 = await compose({ pinyin: 'shanghai', commit: '1', label: 'shanghai-digit', column: '小组', row: 13, capture: 'candidate-shanghai-digit.png' });
  assert.equal(group13, '上海', `digit-key candidate pick must yield 上海, got ${JSON.stringify(group13)}`);
  passed('pinyin shanghai picks a candidate with a real digit key and commits 上海');

  await focusCell('得分', 13);
  await typeSlow('90');
  await sleep(400);
  assert.equal(await cell('得分', 13).inputValue(), '90');

  // Row 14: second pair of compositions, including a longer pinyin string.
  const name14 = await compose({ pinyin: 'shijie', commit: 'space', label: 'shijie-space', column: '姓名', row: 14, capture: 'candidate-shijie-space.png' });
  assert.equal(name14, '世界', `candidate commit must yield 世界, got ${JSON.stringify(name14)}`);
  passed('pinyin shijie plus the system candidate window commits 世界 with a real Space key');

  const group14 = await compose({ pinyin: 'zhongguo', commit: 'space', label: 'zhongguo-space', column: '小组', row: 14, capture: 'candidate-zhongguo-space.png' });
  assert.equal(group14, '中国', `candidate commit must yield 中国, got ${JSON.stringify(group14)}`);
  passed('pinyin zhongguo plus the system candidate window commits 中国 with a real Space key');

  await focusCell('得分', 14);
  await typeSlow('80');
  await sleep(400);
  assert.equal(await cell('得分', 14).inputValue(), '80');

  // DOM signals: real IME composition, not synthetic input.
  const events = await readEvents();
  report.events = events;
  const trustedKeydowns = events.filter(event => event.type === 'keydown' && event.trusted);
  const composingKeydowns = trustedKeydowns.filter(event => event.isComposing || event.keyCode === 229);
  const starts = events.filter(event => event.type === 'compositionstart');
  const updates = events.filter(event => event.type === 'compositionupdate');
  const ends = events.filter(event => event.type === 'compositionend');
  const beforeInputs = events.filter(event => event.type === 'beforeinput' && event.trusted);
  const compositionInserts = beforeInputs.filter(event => event.inputType === 'insertCompositionText');
  const chineseCommits = compositionInserts.filter(event => /[\u4e00-\u9fff]/.test(String(event.data ?? '')));
  const rawInserts = beforeInputs.filter(event => event.inputType === 'insertText');
  report.signals = {
    keydowns: trustedKeydowns.length,
    composingKeydowns: composingKeydowns.length,
    compositionStarts: starts.length,
    compositionUpdates: updates.length,
    compositionEnds: ends.length,
    insertCompositionText: compositionInserts.length,
    chineseCommits: chineseCommits.map(event => event.data),
    rawInsertText: rawInserts.map(event => event.data),
    sampleComposingKeydown: composingKeydowns[0] ?? null,
    sampleCompositionStart: starts[0] ?? null,
    sampleCompositionUpdate: updates.find(event => typeof event.data === 'string' && event.data.length > 1) ?? updates[0] ?? null,
  };
  assert.ok(composingKeydowns.length >= 8, 'IME composition must produce VK_PROCESSKEY (229) keydowns');
  assert.ok(starts.length >= 4, 'each composition must open with compositionstart');
  assert.ok(updates.length >= 8, 'compositionupdate must grow while pinyin is typed');
  assert.ok(ends.length >= 4, 'each composition must close with compositionend');
  assert.ok(chineseCommits.length >= 4, 'Chinese words must be committed through insertCompositionText');
  assert.ok(rawInserts.every(event => /^\d$/.test(String(event.data))),
    'the only non-composition insertText may be the score digits typed as ASCII');
  passed('the frame records trusted composition events and VK_PROCESSKEY keydowns, with no synthetic text path');

  // The Chinese cells entered through the IME run through the real restricted algorithm.
  await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  await expect(frame.locator('#summary')).toContainText('共 14 行', { timeout: 30000 });
  await expect(frame.locator('#groups')).toContainText('上海');
  await expect(frame.locator('#groups')).toContainText('中国');
  const summary = await frame.locator('#summary').textContent();
  const groupText = await frame.locator('#groups').textContent();
  report.computation = { summary, groups: groupText };
  assert.match(summary ?? '', /共 14 行/);
  assert.match(groupText ?? '', /上海/);
  assert.match(groupText ?? '', /中国/);
  passed('the IME-authored Chinese group keys flow through the real worker computation into the result');

  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(300);
  const light = join(output, 'execution-system-ime-light.png');
  await captureEvidence(page, { path: light, fullPage: true });
  report.screenshots.light = light;
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(400);
  const dark = join(output, 'execution-system-ime-dark.png');
  await captureEvidence(page, { path: dark, fullPage: true });
  report.screenshots.dark = dark;
  await page.emulateMedia({ colorScheme: 'light' });
  passed('light and dark views exercised with IME-authored cells');

  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error?.message ?? String(error);
  console.error('FAIL', report.error);
  process.exitCode = 1;
} finally {
  report.inputMethod.restoredTo = ime(ABC).includes('ABC') || ime('current') === ABC ? ABC : ime('current');
  try { ime(ABC); report.inputMethod.restoredTo = ime('current'); } catch {}
  report.finishedAt = new Date().toISOString();
  await writeEvidence(join(output, 'execution-system-ime.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
  await browser?.close().catch(() => {});
  await runtime.stop().catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify({ status: report.status, cases: report.cases, signals: report.signals, error: report.error ?? null }));
}
