import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { annotationPackage, preparedAnnotationPackage } from '../components/material-annotation/package.mjs';

// Text reaches Chrome only through WindowServer and the selected system IME.
// Playwright selects material, clicks controls and observes; it never supplies text.
const product = resolve(process.env.XUNJIE_PRODUCT_PACKAGE ?? 'dist/product-darwin-arm64');
const output = resolve(process.env.XUNJIE_COMPONENT_IME_REPORT_DIR ?? '.verification/wp03-179-181/ime');
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
      release: { releaseId, objectives: ['保留系统输入法确认后的原文'], requirements: '标注阅读材料。', starterWorks: [], capabilities: [],
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
    await frame.locator('body').evaluate(() => {
      window.__imeEvents = [];
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown']) {
        document.addEventListener(type, event => window.__imeEvents.push({ type, trusted: event.isTrusted,
          key: event.key ?? null, code: event.code ?? null, data: event.data ?? null,
          inputType: event.inputType ?? null, composing: event.isComposing ?? false,
          value: event.target?.value ?? null }), true);
      }
    });
    await page.bringToFront();
    run('/usr/bin/swift', ['-e', `import AppKit; _ = NSRunningApplication(processIdentifier: ${browserPid})?.activate(options: [.activateAllWindows])`]);
    await note.click(); select(chineseIme); await pause(350);
    if (process.env.XUNJIE_IME_FOCUS_PAUSE) {
      console.log('IME focus pause, browser PID ' + browserPid);
      await pause(Number(process.env.XUNJIE_IME_FOCUS_PAUSE));
    }
    assert.equal(await note.evaluate(element => document.hasFocus() && document.activeElement === element), true, 'the actual test process must own OS focus');
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
    run('/usr/sbin/screencapture', ['-x', '-R', bounds, join(output, variant + '-candidate.png')]);
    key('key', 'space'); await expect(note).toHaveValue('你好');
    await compose('shijie', '1'); await expect(note).toHaveValue('你好世界');
    passed(variant + ': system candidate Space and digit selection commit Chinese once');
    await type('zhongguo'); key('key', 'esc'); await pause(500);
    await expect(note).toHaveValue('你好世界');
    passed(variant + ': Escape cancels the live composition and preserves committed text');
    select('com.apple.keylayout.ABC'); key('key', 'return'); await type('abc');
    select(chineseIme); await compose('shanghai', 'space');
    const expected = '你好世界\nabc上海';
    await expect(note).toHaveValue(expected);
    // Tab and Meta shortcuts are OS keys, not Playwright keyboard events.
    systemKey(0, 'command down'); systemKey(124); // select all, collapse at the end
    systemKey(48); await pause(250);
    assert.notEqual(await frame.locator('body').evaluate(() => document.activeElement?.getAttribute('aria-label')), '标注内容');
    await note.click(); await expect(note).toHaveValue(expected);
    systemKey(125, 'command down');
    passed(variant + ': language switch, newline, Tab and Meta editing retain exact text');
    await type('beijing'); await page.locator('#activity-title').click();
    await pause(500);
    const afterBlur = await note.inputValue();
    assert.ok(afterBlur.startsWith(expected));
    assert.ok(['', '北京'].includes(afterBlur.slice(expected.length)), 'blur may confirm or cancel composition, never duplicate pinyin');
    const observedEvents = await frame.locator('body').evaluate(() => window.__imeEvents);
    await note.click(); systemKey(125, 'command down'); await type('hangzhou');
    await page.getByRole('tab', { name: '作品', exact: true }).click();
    await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect(note).toBeVisible();
    const confirmed = await note.inputValue();
    assert.ok(confirmed.startsWith(afterBlur));
    assert.ok(['', '杭州'].includes(confirmed.slice(afterBlur.length)), 'tool change may confirm or cancel composition, not lose protected text');
    passed(variant + ': switching tools during composition retains the previously protected note');
    const workspace = async () => {
      const response = await context.request.get(endpoint + '/api/learning/workspaces/' + activity.activityId);
      assert.equal(response.status(), 200); return response.json();
    };
    const savedNote = async () => JSON.parse((await workspace()).files.find(file => file.kind === 'state')?.value ?? '{}').content?.annotations?.[0]?.note;
    await expect.poll(savedNote).toBe(confirmed);
    passed(variant + ': moving focus during composition preserves all previously confirmed bytes');
    const events = observedEvents;
    const starts = events.filter(event => event.type === 'compositionstart');
    const commits = events.filter(event => event.type === 'compositionend');
    assert.ok(starts.length >= 5 && commits.length >= 5, 'actual system composition must be observed');
    assert.ok(events.every(event => event.trusted), 'all observed keyboard/input/composition events must be trusted');
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
      await page.screenshot({ path: join(output, variant + '-' + scheme + '.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 980, height: 850 });
    await page.screenshot({ path: join(output, variant + '-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1320, height: 920 });
  }
  const next = await preparedAnnotationPackage();
  next.manifest.version = 4; next.manifest.entry.resourceId = randomUUID();
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
  await writeFile(join(output, 'component-ime-report.json'), JSON.stringify(report, null, 2) + '\n');
}
