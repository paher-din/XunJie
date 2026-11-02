import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { annotationPackage } from '../components/material-annotation/package.mjs';

const output = resolve('.verification/wp03-169');
const webRoot = resolve(process.env.XUNJIE_COMPONENT_BASELINE_WEB ?? process.env.XUNJIE_PRODUCT_WEB_ROOT ?? 'apps/web/dist-runtime');
async function artifactDigest(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const digests = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    digests.push([entry.name, entry.isDirectory() ? await artifactDigest(path) : createHash('sha256').update(await readFile(path)).digest('hex')]);
  }
  return createHash('sha256').update(JSON.stringify(digests)).digest('hex');
}
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'xj-component-browser-'));
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Native PostgreSQL required');
const report = { platform: process.platform, arch: process.arch, os: release(), root, cases: [], status: 'running',
  browser: 'Google Chrome', node: process.version, mac: 'not-run', teachingOutcome: 'not-evaluated' };
const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
  postgresVersion: '18.6', webRoot, windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') } });
let browser;
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };
try {
  await runtime.install({ profile: 'local' });
  const { endpoint } = await runtime.start();
  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const api = async (route, body, headers = {}) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, `API ${route} ${response.status}`); return response.json();
  };
  const assetsBefore = await artifactDigest(webRoot);
  const definition = await api('manage/component-import', { requestId: randomUUID(), ...await annotationPackage() }, admin);
  assert.equal(await artifactDigest(webRoot), assetsBefore);
  const materialId = randomUUID(), courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
  const text = '观察与解释\n\n阅读材料时，先区分观察到的事实与自己的解释。记录问题，再寻找可以核对的依据。\n\n当新的证据出现时，可以修改原来的理解，同时保留探索的过程。';
  const bytes = Buffer.from(text);
  await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '材料标注验收' },
    task: { taskId, title: '阅读材料，记录你的理解', summary: '材料标注组件验收样例' },
    release: { releaseId, objectives: ['区分事实与解释'], requirements: '阅读开放材料，选择文字并记下理解或疑问。', starterWorks: [], capabilities: [],
      components: [{ key: 'annotation', definition, configuration: { title: '材料标注' }, materialIds: [materialId] }],
      materials: [{ materialId, title: '阅读材料', path: 'material.txt', mediaType: 'text/plain', access: 'student',
        byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] },
    resources: [{ path: 'material.txt', contentBase64: bytes.toString('base64') }] }, admin);
  const password = randomUUID(), loginName = 'component-browser';
  const identity = await api('manage/members', { requestId: randomUUID(), loginName, password }, admin);
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: true }, admin);
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  report.browserVersion = browser.version(); report.headless = false;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const login = await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  assert.equal(login.status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  assert.equal(created.status(), 200); const activity = await created.json();
  const page = await context.newPage();
  page.on('pageerror', error => console.log('BROWSER ERROR ' + error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE ' + message.text().slice(0, 350)); });
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  if (process.env.XUNJIE_COMPONENT_BASELINE_WEB) {
    await expect(page.locator('#activity-title')).toHaveText('阅读材料，记录你的理解');
    await expect(page.getByRole('tab', { name: '代码', exact: true })).toBeVisible();
    await expect(page.getByText('从一个文本或代码文件开始。', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(output, 'implementation-before.png'), fullPage: true });
    passed('baseline f0979d5 formal product UI captured with the same course requirements and materials');
    report.status = 'passed';
  } else {
  await expect(page.getByRole('tab', { name: '材料标注', exact: true })).toBeVisible();
  await page.screenshot({ path: join(output, 'work-area-before-opening-component.png'), fullPage: true });
  await page.getByRole('tab', { name: '材料标注', exact: true }).click();
  const frame = page.frameLocator('iframe[title="材料标注"]');
  await expect(frame.getByRole('heading', { name: '我的标注', exact: true })).toBeVisible();
  try { await expect(frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled(); }
  catch (error) { console.log(await frame.locator('body').innerText()); throw error; }
  passed('dynamic imported HTML is mounted by the formal product workspace');
  await frame.locator('#materials p').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await frame.getByRole('button', { name: '标注选中文字' }).click();
  const note = frame.getByRole('textbox', { name: '标注内容', exact: true });
  const original = '先确认观察，再讨论解释。\n你好世界，保留我的疑问。';
  await note.fill(original);
  await note.focus(); await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await expect(frame.getByRole('button', { name: '移除此标注' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(note).toBeFocused();
  passed('annotation controls support keyboard focus and Chinese multiline text (system IME not exercised)');
  const works = async () => (await context.request.get(endpoint + '/api/learning/workspaces/' + activity.activityId)).json();
  await expect.poll(async () => JSON.parse((await works()).files[0]?.value ?? '{}').content?.annotations?.[0]?.note).toBe(original);
  passed('real iframe input persists through IndexedDB and production API to PostgreSQL/resources');
  const isolated = await frame.locator('body').evaluate(async () => {
    const denied = { storage: false, parent: false, fetch: false };
    try { localStorage.setItem('probe', 'blocked'); } catch { denied.storage = true; }
    try { void parent.document.cookie; } catch { denied.parent = true; }
    try { await fetch('/api/learning/context'); } catch { denied.fetch = true; }
    return denied;
  });
  assert.deepEqual(isolated, { storage: true, parent: true, fetch: true });
  passed('opaque frame and CSP reject host storage, parent access and direct business fetch');
  await page.screenshot({ path: join(output, 'annotation-light.png'), fullPage: true });
  await page.evaluate(() => { localStorage.setItem('theme.v1', 'dark'); document.documentElement.dataset.theme = 'dark'; });
  await expect.poll(() => frame.locator('body').evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim())).not.toBe('');
  await page.screenshot({ path: join(output, 'annotation-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.screenshot({ path: join(output, 'annotation-narrow.png'), fullPage: true });
  passed('light/dark theme and narrow desktop rendering captured');
  await page.reload();
  await page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(page.frameLocator('iframe[title="材料标注"]').getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue(original);
  passed('reload recovers confirmed component state without any execution');
  const second = await context.newPage(); await second.goto(page.url());
  await second.getByRole('tab', { name: '材料标注', exact: true }).click();
  const secondNote = second.frameLocator('iframe[title="材料标注"]').getByRole('textbox', { name: '标注内容', exact: true });
  await expect(secondNote).toHaveValue(original);
  await secondNote.fill('另一页面的新解释');
  await expect.poll(async () => JSON.parse((await works()).files[0].value).content.annotations[0].note).toBe('另一页面的新解释');
  passed('a second valid mount reads the same owner and persists its conditional update');
  await page.frameLocator('iframe[title="材料标注"]').getByRole('textbox', { name: '标注内容', exact: true }).fill('本页保留的冲突候选');
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  await expect(page.getByRole('heading', { name: '作品存在分歧', exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('本页保留的冲突候选', { exact: false }).first()).toBeVisible();
  passed('a stale component edit is protected as a conflict candidate before unmounting');
  const failingActivity = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  const failingId = (await failingActivity.json()).activityId;
  const failing = await context.newPage();
  await failing.goto(endpoint + '?space=school&activity=' + failingId);
  await failing.getByRole('tab', { name: '材料标注', exact: true }).click();
  const failingFrame = failing.frameLocator('iframe[title="材料标注"]');
  await expect(failingFrame.getByRole('button', { name: '标注选中文字' })).toBeEnabled();
  await failingFrame.locator('#materials p').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await failingFrame.getByRole('button', { name: '标注选中文字' }).click();
  await expect.poll(async () => JSON.parse((await (await context.request.get(endpoint + '/api/learning/workspaces/' + failingId)).json()).files[0]?.value ?? '{}').content?.annotations?.length).toBe(1);
  // Fault the real browser's write boundary, while reads and all business APIs stay real.
  await failing.evaluate(() => { const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, options) {
      if (mode === 'readwrite') throw new DOMException('Injected storage failure', 'QuotaExceededError');
      return original.call(this, stores, mode, options);
    }; });
  await failingFrame.getByRole('textbox', { name: '标注内容', exact: true }).fill('存储失败时保留这份中文输入');
  await expect(failingFrame.getByRole('alert')).toBeVisible();
  await failing.getByRole('tab', { name: '作品', exact: true }).click();
  await expect(failingFrame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue('存储失败时保留这份中文输入');
  await failingFrame.getByRole('button', { name: '导出当前标注' }).click();
  assert.match(await failingFrame.getByRole('textbox', { name: '可复制的标注备份' }).inputValue(), /存储失败时保留这份中文输入/);
  passed('real IndexedDB write failure blocks unmount and retains input with a copyable export');
  assert.equal(await artifactDigest(webRoot), assetsBefore);
  report.frontendSha256 = assetsBefore;
  passed('component import and use leave the main frontend artifact unchanged');
  report.status = 'passed';
  }
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); throw error;
} finally {
  await browser?.close();
  try { await runtime.stop(); report.cleanup = 'owned product stopped'; } catch (error) { report.cleanup = String(error); }
  await writeFile(join(output, process.env.XUNJIE_COMPONENT_BASELINE_WEB ? 'baseline-browser-report.json' : 'browser-report.json'), JSON.stringify(report, null, 2));
}
