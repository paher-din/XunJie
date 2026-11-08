import { probeEvidenceDirectory, writeEvidence, captureEvidence, mkdtemp, hasProbeEvidence } from './lib/probe-evidence.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { annotationPackage, preparedAnnotationPackage } from '../components/material-annotation/package.mjs';

// Text reaches Chrome only through WindowServer and the selected system IME.
// Playwright selects material, clicks controls and observes; it never supplies text.
const product = resolve(process.env.XUNJIE_PRODUCT_PACKAGE ?? 'dist/product-darwin-arm64');
const output = probeEvidenceDirectory(process.env.XUNJIE_COMPONENT_IME_REPORT_DIR);
const helper = resolve(process.env.XUNJIE_IME_TOOLS ?? '/Users/robertwu/xj-154/ime');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim();
const key = (...args) => run(join(helper, 'xjkeys'), args);
const select = value => run(join(helper, 'select_ime'), [value]);
const systemKey = (code, modifiers = '') => run('/usr/bin/osascript', ['-e',
  `tell application "System Events" to key code ${code}${modifiers ? ` using {${modifiers}}` : ''}`]);
const pause = ms => new Promise(done => setTimeout(done, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function tree(directory) {
  const files = await readdir(directory, { withFileTypes: true });
  const entries = [];
  for (const item of files.sort((a, b) => a.name.localeCompare(b.name))) {
    entries.push([item.name, item.isDirectory() ? await tree(join(directory, item.name)) : sha(await readFile(join(directory, item.name)))]);
  }
  return sha(JSON.stringify(entries));
}
assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
const desktopOwner = run('/usr/bin/swift', ['-e', 'import AppKit; print(NSWorkspace.shared.frontmostApplication?.localizedName ?? "unknown")']);
assert.notEqual(desktopOwner, 'loginwindow', 'Unlock the macOS desktop before physical system IME acceptance.');
assert.equal(key('check'), 'trusted', 'the existing HID helper must already be Accessibility trusted');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'xj-component-system-ime-'));
const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
const node = join(product, resources.nodePath);
const cli = (...args) => JSON.parse(run(node, [join(product, 'app/cli.js'), ...args, '--root', root]));
const imports = await mkdtemp(join(tmpdir(), 'xj-component-ime-import-'));
const importComponent = async (input, name) => {
  const directory = join(imports, name); await mkdir(directory);
  await writeFile(join(directory, 'view.html'), Buffer.from(input.contentBase64, 'base64'));
  const dependencies = [];
  for (const [index, resource] of (input.dependencies ?? []).entries()) {
    const path = `dependency-${index}.js`;
    await writeFile(join(directory, path), Buffer.from(resource.contentBase64, 'base64'));
    dependencies.push({ path, dependencyId: input.manifest.dependencies.find(item => item.resourceId === resource.resourceId).dependencyId });
  }
  const file = join(directory, 'component.json');
  await writeFile(file, JSON.stringify({ requestId: randomUUID(), manifest: input.manifest, path: 'view.html',
    ...(dependencies.length ? { dependencies } : {}) }));
  return cli('component-import', '--file', file);
};
const { resolveCredential } = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const originalIme = select('current');
const chineseIme = 'com.bytedance.inputmethod.doubaoime.pinyin';
const report = { ticket: ['#179', '#181'], startedAt: new Date().toISOString(), platform: process.platform,
  arch: process.arch, os: release(), osBuild: run('/usr/bin/sw_vers', ['-buildVersion']),
  sourceRevision: run('git', ['rev-parse', 'HEAD']),
  sourceDirty: !!run('git', ['status', '--porcelain', '--', 'apps', 'packages', 'components', 'package-lock.json']),
  probeSha256: sha(await readFile(new URL(import.meta.url))),
  productDistributionSha256: sha(await readFile(join(product, 'distribution.json'))),
  frontendBefore: await tree(join(product, resources.webRoot)),
  node: run(node, ['--version']), postgres: run(join(product, resources.postgresBin, 'postgres'), ['--version']),
  browser: 'Google Chrome', inputMethod: chineseIme, injection: 'CGEventPost HID and System Events physical key codes',
  syntheticText: false, cases: [], variants: [], status: 'running', teachingOutcome: 'not-evaluated' };
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };
let browser;
try {
  cli('install', '--profile', 'local');
  const { endpoint } = cli('start');
  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const api = async (route, body, headers = {}) => {
    const response = await fetch(endpoint + '/api/learning/' + route, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, route); return response.json();
  };
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-automation', '--window-size=1360,980'] });
  report.browserVersion = browser.version();
  const browserSession = await browser.newBrowserCDPSession();
  report.browserArguments = (await browserSession.send('Browser.getBrowserCommandLine')).arguments;
  const browserPid = (await browserSession.send('SystemInfo.getProcessInfo')).processInfo.find(item => item.type === 'browser').id;
  assert.equal(report.browserArguments.some(arg => arg.startsWith('--headless')), false);
  report.headless = false;
  const context = await browser.newContext({ viewport: { width: 1320, height: 920 } });
  const password = randomUUID(), loginName = 'component-ime-' + randomUUID();
  const member = await api('manage/members', { requestId: randomUUID(), loginName, password }, admin);
  assert.equal((await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
  const page = await context.newPage();
  const retained = [];
  const open = async activityId => {
    await page.goto(endpoint + '?space=school&activity=' + activityId);
    await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect(page.frameLocator('iframe[title="材料标注"]').getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 30000 });
  };
  for (const [variant, pack] of [['host-v3', annotationPackage], ['prepared-v2', preparedAnnotationPackage]]) {
    const input = await pack();
    const definition = await importComponent(input, variant);
    const courseId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID();
    const material = Buffer.from('先区分观察到的事实，再讨论解释。\n再次核对：先区分观察到的事实。');
    const course = { formatVersion: 1, requestId: randomUUID(),
      course: { courseId, name: '系统输入法专项 ' + variant },
      task: { taskId: randomUUID(), title: '真实中文候选与标注保护', summary: '' },
      release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['保留系统输入法确认后的原文'], requirements: '标注阅读材料。', starterWorks: [], capabilities: [],
        components: [{ key: 'annotation', definition, configuration: { title: '材料标注' }, materialIds: [materialId] }],
        materials: [{ materialId, title: '阅读材料', path: 'material.txt', mediaType: 'text/plain', access: 'student', byteLength: material.length, sha256: sha(material) }] },
    };
    const courseFile = join(imports, variant, 'course.json');
    await writeFile(join(imports, variant, 'material.txt'), material);
    await writeFile(courseFile, JSON.stringify(course));
    cli('course-import', '--file', courseFile);
    await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);
    const created = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
    assert.equal(created.status(), 200); const activity = await created.json();
    await open(activity.activityId);
    const frame = page.frameLocator('iframe[title="材料标注"]');
    await frame.locator('#materials p').click();
    await frame.locator('#materials p').evaluate(element => {
      const range = document.createRange(); range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, 9);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await frame.getByRole('button', { name: '标注选中文字', exact: true }).click();
    const note = frame.getByRole('textbox', { name: '标注内容', exact: true });
    const workspace = async () => {
      const response = await context.request.get(endpoint + '/api/learning/workspaces/' + activity.activityId);
      assert.equal(response.status(), 200); return response.json();
    };
    const savedNote = async () => JSON.parse((await workspace()).files.find(file => file.kind === 'state')?.value ?? '{}').content?.annotations?.[0]?.note;
    await frame.locator('body').evaluate(() => {
      window.__imeEvents = [];
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown']) {
        document.addEventListener(type, event => window.__imeEvents.push({ type, trusted: event.isTrusted,
          key: event.key ?? null, code: event.code ?? null, data: event.data ?? null,
          inputType: event.inputType ?? null, composing: event.isComposing ?? false,
          value: event.target?.value ?? null }), true);
      }
    });
    const arm = async () => {
      await page.bringToFront();
      run('/usr/bin/osascript', ['-e', `tell application "System Events" to tell (first process whose unix id is ${browserPid})
set frontmost to true
perform action "AXRaise" of front window
end tell`]);
      await note.focus(); await pause(250);
    };
    select(chineseIme); await arm();
    const focus = { browserPid, systemPid: Number(run('/usr/bin/osascript', ['-e', 'tell application "System Events" to get unix id of first application process whose frontmost is true'])),
      frame: await note.evaluate(element => ({ focused: document.hasFocus(), active: document.activeElement === element,
        tag: document.activeElement?.tagName })), page: await page.evaluate(() => document.hasFocus()) };
    report.focusDiagnostics ??= []; report.focusDiagnostics.push(focus); console.log('IME focus ' + JSON.stringify(focus));
    if (process.env.XUNJIE_IME_FOCUS_PAUSE) {
      console.log('IME focus pause, browser PID ' + browserPid);
      await pause(Number(process.env.XUNJIE_IME_FOCUS_PAUSE));
    }
    assert.equal(focus.systemPid, browserPid, 'the actual test process must own OS focus');
    assert.equal(focus.frame.active, true, 'the component text field must own the caret');
    assert.equal(select('current'), chineseIme);
    const type = async text => { for (const letter of text) { key('type', letter); await pause(100); } };
    const compose = async (pinyin, commit) => {
      await type(pinyin); await pause(350);
      if (commit === 'space') key('key', 'space'); else key('type', commit);
      await pause(500);
    };
    await type('nihao'); await pause(450);
    const bounds = run('/usr/bin/osascript', ['-e', 'tell application "System Events" to tell (first application process whose frontmost is true)\nset p to position of front window\nset s to size of front window\nreturn (item 1 of p as string) & "," & (item 2 of p as string) & "," & (item 1 of s as string) & "," & (item 2 of s as string)\nend tell']);
    assert.match(bounds, /^\d+,\d+,\d+,\d+$/);
    if (hasProbeEvidence(output)) run('/usr/sbin/screencapture', ['-x', '-R', bounds, join(output, variant + '-candidate.png')]);
    key('key', 'space'); await expect(note).toHaveValue('你好');
    await compose('shijie', '1'); await expect(note).toHaveValue('你好世界');
    passed(variant + ': system candidate Space and digit selection commit Chinese once');
    await type('zhongguo'); key('key', 'esc'); await pause(500);
    await expect(note).toHaveValue('你好世界');
    passed(variant + ': Escape cancels the live composition and preserves committed text');
    select('com.apple.keylayout.ABC'); await arm(); key('key', 'return'); await type('abc');
    select(chineseIme); await arm(); await compose('shanghai', 'space');
    const expected = '你好世界\nabc上海';
    await expect(note).toHaveValue(expected);
    // Tab and Meta shortcuts are OS keys, not Playwright keyboard events.
    systemKey(0, 'command down'); systemKey(124); // select all, collapse at the end
    systemKey(48); await pause(250);
    assert.notEqual(await frame.locator('body').evaluate(() => document.activeElement?.getAttribute('aria-label')), '标注内容');
    await note.click(); await expect(note).toHaveValue(expected);
    systemKey(125, 'command down');
    passed(variant + ': language switch, newline, Tab and Meta editing retain exact text');
    await type('beijing');
    await expect.poll(async () => (await note.inputValue()).slice(expected.length).replaceAll("'", '')).toBe('beijing');
    const beforeBlur = await note.inputValue();
    await page.locator('#activity-title').click();
    await pause(500);
    const afterBlur = await note.inputValue();
    report.compositionTransitions ??= [];
    const transition = { variant, confirmedPrefix: expected, beforeBlur, afterBlur };
    report.compositionTransitions.push(transition);
    assert.ok(afterBlur.startsWith(expected), 'blur must retain the previously confirmed bytes');
    assert.ok([expected, beforeBlur, expected + '北京'].includes(afterBlur),
      'blur may cancel, retain the exact unconfirmed composition, or commit its candidate once');
    await expect.poll(savedNote).toBe(afterBlur);
    const observedEvents = await frame.locator('body').evaluate(() => window.__imeEvents);
    await note.click(); systemKey(125, 'command down'); await type('hangzhou');
    await expect.poll(async () => (await note.inputValue()).slice(afterBlur.length).replaceAll("'", '')).toBe('hangzhou');
    const beforeToolChange = await note.inputValue();
    await page.getByRole('tab', { name: '作品', exact: true }).click();
    await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect(note).toBeVisible();
    const confirmed = await note.inputValue();
    assert.ok(confirmed.startsWith(afterBlur));
    Object.assign(transition, { beforeToolChange, afterToolChange: confirmed });
    assert.ok([afterBlur, beforeToolChange, afterBlur + '杭州'].includes(confirmed),
      'tool change may cancel, retain the exact unconfirmed composition, or commit its candidate once');
    passed(variant + ': switching tools during composition retains the previously protected note');
    await expect.poll(savedNote).toBe(confirmed);
    passed(variant + ': moving focus during composition preserves all previously confirmed bytes');
    const events = observedEvents;
    const starts = events.filter(event => event.type === 'compositionstart');
    const commits = events.filter(event => event.type === 'compositionend');
    report.eventObservations ??= [];
    const nativeTypes = ['keydown', 'compositionstart', 'compositionupdate', 'beforeinput', 'input'];
    const nativeEvents = events.filter(event => nativeTypes.includes(event.type));
    report.eventObservations.push({ variant, starts: starts.length, ends: commits.length, events,
      nativeEventTypes: nativeTypes, nativeEventsTrusted: nativeEvents.every(event => event.trusted),
      compositionEndTrust: commits.map(event => ({ data: event.data, trusted: event.trusted })) });
    assert.ok(starts.length >= 5 && commits.length >= 4,
      'three confirmed words and the cancelled composition must finish; the blurred composition may remain unconfirmed');
    for (const word of ['你好', '世界', '上海']) assert.ok(commits.some(event => event.data === word),
      'each confirmed Chinese word must finish through the system composition pipeline');
    // This Chrome/IME pair exposes compositionend with isTrusted=false. Record
    // that flag without using it as proof of native input; candidate commits
    // must instead have trusted beforeinput AND input events with Chinese data.
    assert.ok(nativeEvents.every(event => event.trusted), 'native keyboard, composition and text input must be trusted');
    for (const word of ['你好', '世界', '上海']) {
      for (const type of ['beforeinput', 'input']) assert.ok(events.some(event =>
        event.type === type && event.trusted && event.data === word && event.inputType === 'insertCompositionText'),
      `${word} must reach the field through trusted ${type}`);
    }
    assert.ok(events.some(event => event.type === 'keydown' && event.composing));
    passed(variant + ': trusted composition events prove the system IME path independently of final strings');
    if (variant === 'prepared-v2') {
      await frame.getByRole('button', { name: '在材料中高亮', exact: true }).click();
      await expect(frame.locator('mark.xj-mark')).toHaveCount(2);
      await expect(note).toHaveValue(confirmed);
      await frame.getByRole('button', { name: '取消高亮', exact: true }).click();
      await expect(note).toHaveValue(confirmed);
      // Lose only dependency cache bytes, never erase preparation or student state.
      await page.evaluate(() => new Promise((done, reject) => {
        const request = indexedDB.open('xunjie-component-preparation-v1', 1);
        request.onsuccess = () => { const db = request.result; const tx = db.transaction('resources', 'readwrite');
          tx.objectStore('resources').clear(); tx.oncomplete = () => { db.close(); done(); }; tx.onabort = () => reject(tx.error); };
        request.onerror = () => reject(request.error);
      }));
      await page.reload(); await page.getByRole('tab', { name: '材料标注', exact: true }).click();
      await expect(note).toHaveValue(confirmed, { timeout: 30000 });
      passed('prepared-v2: highlighting and actual dependency-cache recovery retain IME-authored notes');
    }
    await page.getByRole('tab', { name: '作品', exact: true }).click();
    await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect(note).toHaveValue(confirmed);
    await page.reload(); await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect(note).toHaveValue(confirmed); assert.equal(await savedNote(), confirmed);
    passed(variant + ': tool switch, refresh and PostgreSQL reread preserve UTF-8 bytes and newlines');
    const variantReport = { variant, component: definition, finalText: confirmed, utf8Sha256: sha(Buffer.from(confirmed)),
      byteLength: Buffer.byteLength(confirmed), newlineCount: confirmed.split('\n').length - 1, events };
    report.variants.push(variantReport);
    retained.push({ activityId: activity.activityId, confirmed, definition, releaseId });
    for (const scheme of ['light', 'dark']) {
      await page.evaluate(scheme => { localStorage.setItem('theme.v1', scheme); document.documentElement.dataset.theme = scheme; }, scheme);
      await pause(250);
      await captureEvidence(page, { path: join(output, variant + '-' + scheme + '.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 980, height: 850 });
    await captureEvidence(page, { path: join(output, variant + '-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1320, height: 920 });
  }
  const next = await preparedAnnotationPackage();
  next.manifest.version = 4; next.manifest.entry.resourceId = randomUUID();
  for (const dependency of next.manifest.dependencies) {
    const resource = next.dependencies.find(item => item.resourceId === dependency.resourceId);
    assert.ok(resource);
    resource.resourceId = dependency.resourceId = randomUUID();
  }
  const nextDefinition = await importComponent(next, 'later-v4');
  assert.equal(nextDefinition.manifest.version, 4);
  for (const original of retained) {
    await open(original.activityId);
    await expect(page.frameLocator('iframe[title="材料标注"]').getByRole('textbox', { name: '标注内容', exact: true }))
      .toHaveValue(original.confirmed);
    const response = await context.request.get(endpoint + '/api/learning/activities/' + original.activityId);
    assert.equal(response.status(), 200);
    const value = JSON.stringify(await response.json());
    assert.ok(value.includes(original.releaseId), 'the activity keeps its original release');
    assert.ok(value.includes(original.definition.digest), 'the activity keeps its original definition digest');
  }
  passed('importing a later prepared version preserves both pinned activities and their original IME annotations');
  report.frontendAfter = await tree(join(product, resources.webRoot));
  assert.equal(report.frontendAfter, report.frontendBefore);
  passed('full product CLI install/start/import/use leaves the entire packaged Web tree unchanged');
  cli('stop');
  const restarted = cli('start'); assert.ok(['ready', 'degraded'].includes(restarted.state));
  passed('the complete packaged CLI stops and restarts its owned environment normally');
  report.status = 'passed'; report.mac = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error); throw error;
} finally {
  select(originalIme);
  await browser?.close();
  try { cli('stop'); report.cleanup = 'owned product stopped'; }
  catch { report.cleanup = 'stop failed'; report.status = 'failed'; report.mac = 'failed'; }
  await rm(imports, { recursive: true, force: true });
  if (report.status === 'passed' && report.cleanup === 'owned product stopped') {
    await rm(root, { recursive: true, force: true }); report.privateRoot = 'removed';
  }
  report.finishedAt = new Date().toISOString();
  await writeEvidence(join(output, 'component-ime-report.json'), JSON.stringify(report, null, 2) + '\n');
}
