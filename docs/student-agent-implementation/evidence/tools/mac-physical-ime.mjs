import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// 物理键盘级中文输入法验收：按键经 CGEvent HID tap 注入，由系统输入法（TIS 选中的真实输入法）处理，
// 页面侧只做只读观测（读工作内容、采集 DOM 事件），不通过 CDP 合成任何输入。
const REPO = '/Users/robertwu/Documents/Projects/AI+教育创新技能大赛/XunJie';
const WORK = '/Users/robertwu/xj-154/ime';
const RESULTS = join(WORK, 'results');
const SHOTS = join(RESULTS, 'screenshots');
const KEYS = join(WORK, 'xjkeys');
const SELECT_IME = join(WORK, 'select_ime');
const IME = 'com.bytedance.inputmethod.doubaoime.pinyin';
const ABC = 'com.apple.keylayout.ABC';

const require = createRequire(join(REPO, 'package.json'));
const { chromium } = require('playwright');

const env = JSON.parse(readFileSync(join(RESULTS, 'env.json'), 'utf8'));
const endpoint = env.personal.endpoint;
const fileName = '系统输入法.txt';
const expectedText = '开始你好世界\n粘贴中文\n结束';
const lightShot = join(SHOTS, 'wp02-works-mac-physical-ime-light.png');
const darkShot = join(SHOTS, 'wp02-works-mac-physical-ime-dark.png');

const keys = (...args) => execFileSync(KEYS, args, { encoding: 'utf8' }).trim();
const ime = (...args) => execFileSync(SELECT_IME, args, { encoding: 'utf8' }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const report = { kind: 'physical-keyboard-ime', startedAt: new Date().toISOString(),
  injection: { tool: 'xjkeys', mechanism: 'CGEventPost(.cghidEventTap, .hidSystemState)', source: 'OS WindowServer' },
  inputMethod: { requested: IME, selected: null, currentBefore: null, currentAfter: null },
  events: null, steps: [], text: null, passed: false };

const trust = keys('check');
report.injection.accessibilityTrusted = trust === 'trusted';
if (trust !== 'trusted') {
  writeFileSync('/tmp/xj-ime-physical.json', JSON.stringify({ ...report, error: 'accessibility-untrusted' }, null, 2));
  console.log('ACCESSIBILITY_UNTRUSTED');
  process.exit(3);
}

report.inputMethod.currentBefore = ime('current');

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=1280,940'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
await page.bringToFront();

await page.goto(endpoint + '/');
await page.getByRole('heading', { name: '个人学习空间', exact: true }).waitFor({ timeout: 20000 });
const goal = '物理输入法验收-' + Date.now();
await page.getByLabel('学习目标', { exact: true }).fill(goal);
await page.getByRole('button', { name: '建立学习活动', exact: true }).click();
await page.getByRole('heading', { name: goal, exact: true }).waitFor({ timeout: 15000 });
const activityId = new URL(page.url()).searchParams.get('activity');

await page.getByLabel('文件名', { exact: true }).fill(fileName);
await page.getByRole('button', { name: '新建文件', exact: true }).click();
await page.locator('.monaco-editor').waitFor({ timeout: 20000 });
await page.getByRole('button', { name: fileName, exact: true }).click();
await page.locator('.monaco-editor textarea').focus();
await page.waitForTimeout(600);

// 只读观测：采集真实输入法在页面里产生的 DOM 事件（含 isTrusted、keyCode、isComposing）
await page.evaluate(() => {
  window.__imeEvents = [];
  const push = (type, extra) => window.__imeEvents.push({ type, at: Math.round(performance.now()), ...extra });
  document.addEventListener('compositionstart', event => push('compositionstart', { data: event.data, trusted: event.isTrusted }), true);
  document.addEventListener('compositionupdate', event => push('compositionupdate', { data: event.data, trusted: event.isTrusted }), true);
  document.addEventListener('compositionend', event => push('compositionend', { data: event.data, trusted: event.isTrusted }), true);
  document.addEventListener('keydown', event => push('keydown', { key: event.key, code: event.code,
    keyCode: event.keyCode, isComposing: event.isComposing, trusted: event.isTrusted }), true);
  document.addEventListener('paste', event => push('paste', { trusted: event.isTrusted,
    length: event.clipboardData ? event.clipboardData.getData('text').length : 0 }), true);
  document.addEventListener('focus', () => push('focus', { trusted: true }), true);
  document.addEventListener('blur', () => push('blur', { trusted: true }), true);
});

async function focusState() {
  return page.evaluate(() => ({
    window: document.hasFocus(),
    editor: Boolean(document.activeElement && document.activeElement.closest('.monaco-editor')),
    activeTag: document.activeElement ? document.activeElement.tagName : ''
  }));
}

// 每次注入前把 Chrome 拉回前台并把焦点放回编辑器；这是注入能否落到被测页面的前提。
async function arm() {
  await page.bringToFront();
  const state = await focusState();
  if (!state.editor) {
    await page.locator('.monaco-editor textarea').focus();
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(250);
  return focusState();
}

async function readText() {
  return page.evaluate(async ({ id, name }) => {
    const response = await fetch('/api/learning/workspaces/' + id, { headers: { 'x-xj-space': 'personal' } });
    if (!response.ok) return { status: response.status, text: null };
    const body = await response.json();
    return { status: response.status, text: body.files?.find(file => file.name === name)?.value ?? '' };
  }, { id: activityId, name: fileName });
}

async function waitText(predicate, timeout = 20000) {
  const started = Date.now();
  let last = { status: 0, text: '' };
  while (Date.now() - started < timeout) {
    const read = await readText().catch(error => ({ status: 0, text: null, error: String(error) }));
    last = read;
    if (typeof read.text === 'string' && predicate(read.text)) return { ok: true, ...read };
    await sleep(400);
  }
  return { ok: false, ...last };
}

// 逐字母注入：每次一个独立进程，间隔由这里控制，避免进程启动抖动让输入法提前分词
const typeSlow = async pinyin => {
  for (const letter of pinyin) {
    keys('type', letter);
    await sleep(130);
  }
};

const compose = async (pinyin, label) => {
  const armed = await arm();
  await typeSlow(pinyin);
  await page.waitForTimeout(600);
  keys('key', 'space');
  await page.waitForTimeout(900);
  report.steps.push({ step: 'compose', label, pinyin, focus: armed });
};

// 段一：三段拼音组合上屏 + 真实回车换行 + 真实 Cmd+V 粘贴
report.inputMethod.selected = ime(IME);
report.inputMethod.currentAfter = ime('current');
// 首词预热：macOS 会把窗口激活后的第一次按键用于激活，先发一个 Esc 吃掉这次吞键
await arm();
keys('key', 'esc');
await page.waitForTimeout(500);
await compose('kaishi', '开始');
await compose('nihao', '你好');
await compose('shijie', '世界');
await arm();
keys('key', 'return');
await page.waitForTimeout(500);
execFileSync('/usr/bin/osascript', ['-e', 'set the clipboard to "粘贴中文"']);
await sleep(300);
await arm();
keys('paste');
await page.waitForTimeout(1400);
const stage1 = await waitText(text => text.includes('粘贴中文') && text.includes('\n'));

// 焦点往返：切走再回来，确认输入法组合仍可用
await execFileSync('/usr/bin/osascript', ['-e', 'tell application "Finder" to activate']);
await page.waitForTimeout(1200);
const away = await page.evaluate(() => document.hasFocus());
const back = await arm();
report.steps.push({ step: 'focus-round-trip', awayFocused: away, backFocused: back });

// 段二：Meta 边界（Cmd+← / Cmd+→ 不被编辑器吞掉，文本不变）+ 换行 + 结束
keys('key', 'left', 'cmd');
await page.waitForTimeout(400);
keys('key', 'right', 'cmd');
await page.waitForTimeout(400);
const afterMeta = await readText();
report.steps.push({ step: 'meta-boundary', textUnchanged: afterMeta.text === stage1.text });
await arm();
keys('key', 'return');
await page.waitForTimeout(500);
await compose('jieshu', '结束');

const final = await waitText(text => text === expectedText, 25000);
report.text = final.text;
report.textStatus = final.status;
report.passed = final.ok;
report.events = await page.evaluate(() => window.__imeEvents.slice(0, 400));

// 截图走 CDP，不依赖屏幕录制权限
await page.emulateMedia({ colorScheme: 'light' });
await page.waitForTimeout(400);
await page.screenshot({ path: lightShot, fullPage: true }).catch(() => {});
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(500);
await page.screenshot({ path: darkShot, fullPage: true }).catch(() => {});
await page.emulateMedia({ colorScheme: 'light' });

execFileSync(SELECT_IME, [ABC], { encoding: 'utf8' }).trim();
report.finishedAt = new Date().toISOString();
report.activityId = activityId;
report.endpoint = endpoint;
report.fileName = fileName;
report.expectedText = expectedText;
report.screenshots = { light: lightShot, dark: darkShot };

const trustedKeydowns = (report.events ?? []).filter(event => event.type === 'keydown' && event.trusted);
const composingKeydowns = trustedKeydowns.filter(event => event.isComposing || event.keyCode === 229);
const compositions = (report.events ?? []).filter(event => event.type === 'compositionstart' && event.trusted);
const pastes = (report.events ?? []).filter(event => event.type === 'paste' && event.trusted);
report.signals = { keydowns: trustedKeydowns.length, composingKeydowns: composingKeydowns.length,
  compositionStarts: compositions.length, trustedPastes: pastes.length,
  sampleComposition: compositions[0] ?? null,
  sampleComposingKeydown: composingKeydowns[0] ?? null };

writeFileSync('/tmp/xj-ime-physical.json', JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(RESULTS, 'wp02-works-mac-physical-ime.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, text: report.text, signals: report.signals }));
await browser.close();
if (!report.passed) process.exitCode = 1;
