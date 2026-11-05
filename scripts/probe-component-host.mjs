import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { annotationPackage } from '../components/material-annotation/package.mjs';

const output = resolve(process.env.XUNJIE_COMPONENT_REPORT_DIR ?? '.verification/wp03-169');
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
  browser: 'Google Chrome', node: process.version, mac: process.platform === 'darwin' && process.arch === 'arm64' ? 'running' : 'not-run', teachingOutcome: 'not-evaluated' };
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
  // Observe the real capability transfer inside the test browser; business traffic remains unmodified.
  await context.addInitScript(() => {
    if (window === parent) return;
    window.addEventListener('message', event => {
      if (event.source !== parent || event.data?.method !== 'host.initialize' || !event.ports[0]) return;
      const port = event.ports[0], binding = event.data;
      const pending = new Map();
      port.addEventListener('message', event => {
        if (!window.XunJieComponentProtocol.componentHostMessageSchema.safeParse(event.data).success) window.__componentProbe.protocolErrors++;
        const finish = pending.get(event.data?.replyTo);
        if (finish) { pending.delete(event.data.replyTo); finish(event.data); }
      });
      window.__componentProbe = { connectionId: binding.connectionId, instanceId: binding.instanceId, protocolErrors: 0,
        initializeValid: window.XunJieComponentProtocol.componentHostMessageSchema.safeParse(binding).success,
        request: (method, payload, connectionId = binding.connectionId) => new Promise((resolve, reject) => {
          const messageId = crypto.randomUUID();
          const timer = setTimeout(() => { pending.delete(messageId); reject(new Error('Probe response timeout')); }, 10000);
          pending.set(messageId, value => { clearTimeout(timer); resolve(value); });
          port.postMessage({ hostApiVersion: 1, connectionId, instanceId: binding.instanceId, messageId, method, payload });
        }) };
    });
  });
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
  assert.equal(await frame.locator('body').evaluate(() => window.__componentProbe.initializeValid), true);
  const metrics = await frame.getByRole('button', { name: '标注选中文字' }).evaluate(button => ({
    height: button.getBoundingClientRect().height, size: getComputedStyle(button).fontSize,
    titleFont: getComputedStyle(document.querySelector('h1')).fontFamily, loaded: document.fonts.check('17px XunJieTitle') }));
  assert.equal(metrics.height, 32); assert.equal(metrics.size, '13px'); assert.equal(metrics.loaded, true);
  assert.match(metrics.titleFont, /XunJieTitle/);
  passed('shared isolated controls follow DESIGN and load the verified title font without network access');
  await frame.locator('#materials p').click();
  await frame.locator('#materials p').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await frame.getByRole('button', { name: '标注选中文字' }).click();
  const note = frame.getByRole('textbox', { name: '标注内容', exact: true });
  const original = '先确认观察，再讨论解释。\n你好世界，保留我的疑问。';
  await note.fill(original);
  await note.focus(); await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await expect(frame.getByRole('button', { name: '选择此标注' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(frame.getByRole('button', { name: '移除此标注' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(frame.getByRole('button', { name: '选择此标注' })).toBeFocused();
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
  const protocol = await page.frameLocator('iframe[title="材料标注"]').locator('body').evaluate(async () => {
    const probe = window.__componentProbe;
    const invalid = await probe.request('workspace.change', {});
    if (invalid.error?.code !== 'invalid-input') throw new Error('Payload validation error misclassified');
    const read = await probe.request('workspace.read', {});
    let expected = read.payload.contentId, first, receipt;
    for (let i = 0; i < 257; i++) {
      const input = { operationId: crypto.randomUUID(), expectedContentId: expected, contentId: crypto.randomUUID(), content: read.payload.content };
      const result = await probe.request('workspace.change', input);
      if (result.error) throw new Error('Operation failed: ' + result.error.code);
      if (i === 0) { first = input; receipt = result.payload; }
      expected = input.contentId;
    }
    const replay = await probe.request('workspace.change', first);
    if (JSON.stringify(replay.payload) !== JSON.stringify(receipt)) throw new Error('Old operation receipt changed');
    const changed = await probe.request('workspace.change', { ...first, content: { annotations: [] } });
    if (changed.error?.code !== 'conflict') throw new Error('Changed operation identity accepted');
    const burst = [];
    for (let i = 0; i < 12; i++) {
      const input = { operationId: crypto.randomUUID(), expectedContentId: expected, contentId: crypto.randomUUID(), content: read.payload.content };
      burst.push(probe.request('workspace.change', input)); expected = input.contentId;
    }
    if ((await Promise.all(burst)).some(reply => reply.error)) throw new Error('Burst input lost its acceptance order');
    return { first, receipt, latest: expected, connectionId: probe.connectionId };
  });
  passed('257 real IndexedDB operations replay their original receipt and reject altered input');
  await page.locator('iframe[title="材料标注"]').evaluate(element => { element.src = element.src; });
  await expect.poll(async () => { try { const id = await page.frameLocator('iframe[title="材料标注"]').locator('body').evaluate(() => window.__componentProbe?.connectionId);
    return typeof id === 'string' && id !== protocol.connectionId; } catch { return false; } }).toBe(true);
  await expect(page.frameLocator('iframe[title="材料标注"]').getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue(original);
  const reloaded = await page.frameLocator('iframe[title="材料标注"]').locator('body').evaluate(async (_, old) => {
    const probe = window.__componentProbe;
    const stale = await probe.request('workspace.change', { operationId: crypto.randomUUID(), expectedContentId: old.latest,
      contentId: crypto.randomUUID(), content: { annotations: [] } }, old.connectionId);
    const replay = await probe.request('workspace.change', old.first);
    const current = await probe.request('workspace.read', {});
    return { connectionId: probe.connectionId, stale: stale.error?.code, receipt: replay.payload, latest: current.payload.contentId };
  }, protocol);
  assert.notEqual(reloaded.connectionId, protocol.connectionId);
  assert.equal(reloaded.stale, 'stale-connection');
  assert.deepEqual(reloaded.receipt, protocol.receipt); assert.equal(reloaded.latest, protocol.latest);
  passed('iframe reload rotates its private port/connection, rejects old identity and replays durable receipts');
  await page.reload();
  await page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(page.frameLocator('iframe[title="材料标注"]').getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue(original);
  const replayAfterPageReload = await page.frameLocator('iframe[title="材料标注"]').locator('body').evaluate(async (_, old) =>
    (await window.__componentProbe.request('workspace.change', old)).payload, protocol.first);
  assert.deepEqual(replayAfterPageReload, protocol.receipt);
  passed('a full page restart recovers operation receipts from the existing workspace database');
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
  // Separate browser storage partitions reproduce independent first-state object identities.
  const competing = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  const competingId = (await competing.json()).activityId;
  const competingContext = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 1440, height: 1000 } });
  let releaseReads;
  const heldReads = new Promise(resolve => { releaseReads = resolve; });
  try {
    const first = await context.newPage(), other = await competingContext.newPage();
    const url = endpoint + '?space=school&activity=' + competingId;
    for (const target of [first, other]) {
      await target.goto(url); await target.getByRole('tab', { name: '材料标注', exact: true }).click();
      await expect(target.frameLocator('iframe[title="材料标注"]').getByRole('button', { name: '标注选中文字' })).toBeEnabled();
    }
    // Delay real reads, rather than returning invented workspace facts.
    await other.route('**/api/learning/workspaces/' + competingId, async route => {
      if (route.request().method() === 'GET') await heldReads;
      await route.continue();
    });
    const add = async (target, text) => {
      const view = target.frameLocator('iframe[title="材料标注"]');
      await view.locator('#materials p').click();
      await view.locator('#materials p').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
      await view.getByRole('button', { name: '标注选中文字' }).click();
      await view.getByRole('textbox', { name: '标注内容', exact: true }).fill(text);
    };
    await add(first, '另一客户端的首次标注');
    const remoteWorks = async () => (await context.request.get(endpoint + '/api/learning/workspaces/' + competingId)).json();
    await expect.poll(async () => JSON.parse((await remoteWorks()).files[0]?.value ?? '{}').content?.annotations?.[0]?.note).toBe('另一客户端的首次标注');
    const remoteFile = (await remoteWorks()).files[0];
    await add(other, '本页独立创建的首次标注');
    await expect.poll(() => other.evaluate(id => new Promise((resolve, reject) => {
      const request = indexedDB.open('xunjie-reliable-works-v1');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result, tx = db.transaction('workspaces', 'readonly');
        const rows = tx.objectStore('workspaces').getAll();
        tx.oncomplete = () => { const file = rows.result.find(row => row.key.includes(id))?.files?.[0]; db.close(); resolve(file); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), competingId)).toMatchObject({ objectId: expect.not.stringMatching(remoteFile.objectId), name: 'components/annotation.json', value: expect.stringContaining('本页独立创建的首次标注') });
    releaseReads();
    await other.getByRole('tab', { name: '作品', exact: true }).click();
    await expect(other.getByRole('heading', { name: '作品存在分歧', exact: true })).toBeVisible();
    await other.getByRole('button', { name: '采用另一版本', exact: true }).click();
    await expect(other.getByRole('heading', { name: '作品存在分歧', exact: true })).toHaveCount(0);
    await expect.poll(async () => (await remoteWorks()).files[0]).toEqual(remoteFile);
    await other.reload(); await other.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect(other.frameLocator('iframe[title="材料标注"]').getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue('另一客户端的首次标注');
    passed('independent first component states can adopt the other client through the real conflict UI and recover after reload');
    await first.close();
  } finally { releaseReads(); await competingContext.close(); }
  const failingActivity = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  const failingId = (await failingActivity.json()).activityId;
  const failing = await context.newPage();
  await failing.goto(endpoint + '?space=school&activity=' + failingId);
  await failing.getByRole('tab', { name: '材料标注', exact: true }).click();
  const failingFrame = failing.frameLocator('iframe[title="材料标注"]');
  await expect(failingFrame.getByRole('button', { name: '标注选中文字' })).toBeEnabled();
  await failingFrame.locator('#materials p').click();
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
  const unknownActivity = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  const unknownPage = await context.newPage();
  await unknownPage.goto(endpoint + '?space=school&activity=' + (await unknownActivity.json()).activityId);
  await unknownPage.getByRole('tab', { name: '材料标注', exact: true }).click();
  const unknownFrame = unknownPage.frameLocator('iframe[title="材料标注"]');
  await expect(unknownFrame.getByRole('button', { name: '标注选中文字' })).toBeEnabled();
  await unknownPage.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, options) {
      if (mode === 'readonly' && (typeof stores === 'string' ? [stores] : [...stores]).includes('workOperations'))
        throw new DOMException('Injected receipt read failure', 'UnknownError');
      return original.call(this, stores, mode, options);
    };
  });
  const unknown = await unknownFrame.locator('body').evaluate(async () => window.__componentProbe.request('workspace.change', {
    operationId: crypto.randomUUID(), expectedContentId: null, contentId: crypto.randomUUID(),
    content: { annotations: [{ id: crypto.randomUUID(), quote: '保留来源', note: '回执无法查询时保留我的输入' }] }
  }));
  assert.equal(unknown.error?.code, 'outcome-unknown');
  await unknownPage.getByRole('tab', { name: '作品', exact: true }).click();
  await expect(unknownPage.getByRole('heading', { name: '作品存在分歧', exact: true })).toBeVisible();
  await expect(unknownPage.getByText('回执无法查询时保留我的输入', { exact: false }).first()).toBeVisible();
  passed('receipt read failure reports outcome-unknown and protects input as an exportable workspace candidate');
  const delayedActivity = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  const delayedPage = await context.newPage();
  await delayedPage.goto(endpoint + '?space=school&activity=' + (await delayedActivity.json()).activityId);
  await delayedPage.getByRole('tab', { name: '材料标注', exact: true }).click();
  const delayedFrame = delayedPage.frameLocator('iframe[title="材料标注"]');
  await expect(delayedFrame.getByRole('button', { name: '标注选中文字' })).toBeEnabled();
  await delayedPage.evaluate(() => {
    const original = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = async (...args) => {
      await new Promise(resolve => { window.releaseOperation = resolve; });
      return original(...args);
    };
  });
  await delayedFrame.locator('body').evaluate(() => {
    window.pendingProbe = window.__componentProbe.request('workspace.change', { operationId: crypto.randomUUID(), expectedContentId: null,
      contentId: crypto.randomUUID(), content: { annotations: [{ id: crypto.randomUUID(), quote: '异步读取', note: '查询期间不能卸载' }] } });
  });
  await expect.poll(() => delayedPage.evaluate(() => typeof window.releaseOperation)).toBe('function');
  await delayedPage.getByRole('tab', { name: '作品', exact: true }).click();
  await expect(delayedPage.getByRole('tab', { name: '材料标注', exact: true })).toHaveAttribute('aria-selected', 'true');
  await delayedPage.evaluate(() => window.releaseOperation());
  await expect(delayedPage.getByRole('tab', { name: '作品', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(delayedPage.getByText('查询期间不能卸载', { exact: false }).first()).toBeVisible();
  passed('tool navigation waits for an in-flight operation before unmounting the component');
  const upgradeContext = await browser.newContext();
  await upgradeContext.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  const upgradePage = await upgradeContext.newPage();
  await upgradePage.goto(endpoint + '/api/learning/context');
  await upgradePage.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('xunjie-reliable-works-v1', 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('workspaces', { keyPath: 'key' });
      db.createObjectStore('candidates', { keyPath: 'id' }).createIndex('scope', 'scope');
      db.createObjectStore('drafts', { keyPath: 'key' });
      db.createObjectStore('draftCandidates', { keyPath: 'id' }).createIndex('scope', 'scope');
      db.createObjectStore('actions', { keyPath: 'key' }).createIndex('scope', 'scope');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('workspaces', 'readwrite');
      tx.objectStore('workspaces').put({ key: 'upgrade-sentinel', text: '已有中文作品不得丢失' });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
    };
  }));
  await upgradePage.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await upgradePage.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(upgradePage.frameLocator('iframe[title="材料标注"]').getByRole('textbox', { name: '标注内容', exact: true })).toBeVisible();
  const upgrade = await upgradePage.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('xunjie-reliable-works-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('workspaces', 'readonly');
      const value = tx.objectStore('workspaces').get('upgrade-sentinel');
      tx.oncomplete = () => { resolve({ version: db.version, operations: db.objectStoreNames.contains('workOperations'), text: value.result.text }); db.close(); };
      tx.onabort = () => reject(tx.error);
    };
  }));
  assert.deepEqual(upgrade, { version: 5, operations: true, text: '已有中文作品不得丢失' });
  await upgradeContext.close();
  passed('the real v3 IndexedDB upgrades additively to v5 without losing existing workspace data');
  const openSample = async () => {
    const response = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
    const id = (await response.json()).activityId, page = await context.newPage();
    await page.goto(endpoint + '?space=personal');
    await page.getByRole('button', { name: '学校空间', exact: true }).click();
    await page.locator(`[data-activity-id="${id}"]`).click();
    await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    const frame = page.frameLocator('iframe[title="材料标注"]');
    await expect(frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled();
    return { id, page, frame, works: async () => (await context.request.get(endpoint + '/api/learning/workspaces/' + id)).json() };
  };
  const addNote = async (sample, text) => {
    await sample.frame.locator('#materials p').click();
    await sample.frame.locator('#materials p').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
    await sample.frame.getByRole('button', { name: '标注选中文字' }).click();
    await sample.frame.getByRole('textbox', { name: '标注内容', exact: true }).fill(text);
    await expect.poll(async () => JSON.parse((await sample.works()).files[0]?.value ?? '{}').content?.annotations?.[0]?.note).toBe(text);
  };
  const navigation = await openSample();
  await addNote(navigation, '导航前已经确认');
  await navigation.page.goBack();
  await expect(navigation.page.locator('#activity-title')).toHaveCount(0);
  await navigation.page.goForward();
  await expect(navigation.page.locator('#activity-title')).toBeVisible();
  await navigation.page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(navigation.frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue('导航前已经确认');
  passed('component-only workspace can navigate back/forward without a mounted editor ref');
  await navigation.page.getByRole('button', { name: '打开对话', exact: true }).click();
  await navigation.page.evaluate(() => {
    window.componentWriteFault = true;
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, options) {
      if (mode === 'readwrite' && window.componentWriteFault) throw new DOMException('Controlled storage refusal', 'QuotaExceededError');
      return original.call(this, stores, mode, options);
    };
  });
  await navigation.page.getByRole('textbox', { name: '你的问题', exact: true }).fill('组件旁边尚未保护的问题草稿');
  await navigation.frame.getByRole('textbox', { name: '标注内容', exact: true }).fill('存储失败时返回也不能丢失');
  await expect(navigation.frame.getByRole('alert')).toBeVisible();
  const marker = randomUUID();
  await navigation.frame.locator('body').evaluate((_, marker) => { window.documentMarker = marker; }, marker);
  await navigation.page.getByRole('button', { name: '返回活动列表', exact: true }).click();
  await expect(navigation.page.locator('.product-workspace-notice [role="alert"]').first()).toBeVisible();
  await expect(navigation.frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue('存储失败时返回也不能丢失');
  assert.equal(await navigation.frame.locator('body').evaluate(() => window.documentMarker), marker);
  await navigation.page.evaluate(() => history.go(-2));
  await expect(navigation.page.locator('.product-workspace-notice [role="alert"]').first()).toBeVisible();
  await expect(navigation.page.locator('#activity-title')).toBeVisible();
  assert.equal(await navigation.frame.locator('body').evaluate(() => window.documentMarker), marker);
  await navigation.frame.getByRole('button', { name: '导出当前标注' }).click();
  assert.match(await navigation.frame.getByRole('textbox', { name: '可复制的标注备份' }).inputValue(), /存储失败时返回也不能丢失/);
  await expect(navigation.page.getByRole('textbox', { name: '你的问题', exact: true })).toHaveValue('组件旁边尚未保护的问题草稿');
  await navigation.page.evaluate(() => { window.componentWriteFault = false; });
  await navigation.page.getByRole('button', { name: '返回活动列表', exact: true }).click();
  await expect(navigation.page.locator('#activity-title')).toHaveCount(0);
  await navigation.page.locator(`[data-activity-id="${navigation.id}"]`).click();
  await navigation.page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(navigation.frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue('存储失败时返回也不能丢失');
  await navigation.page.getByRole('button', { name: '打开对话', exact: true }).click();
  await expect(navigation.page.getByRole('textbox', { name: '你的问题', exact: true })).toHaveValue('组件旁边尚未保护的问题草稿');
  passed('failed return/history preserves the same component, exportable input and draft, then recovery permits leaving');
  const renaming = await openSample();
  await addNote(renaming, '状态位置不可随意改变');
  await renaming.page.getByRole('tab', { name: '作品', exact: true }).click();
  await renaming.page.getByRole('button', { name: '文件', exact: true }).click();
  await expect(renaming.page.getByRole('button', { name: '重命名', exact: true })).toHaveCount(0);
  await renaming.page.getByLabel('文件名', { exact: true }).fill('components/annotation.json');
  await renaming.page.getByRole('button', { name: '新建文件', exact: true }).click();
  await expect(renaming.page.getByRole('alert').filter({ hasText: '操作未完成' }).first()).toBeVisible();
  await renaming.page.keyboard.press('Escape');
  assert.equal((await renaming.works()).files.length, 1);
  await renaming.page.getByRole('button', { name: '返回活动列表', exact: true }).click();
  await expect(renaming.page.locator('#activity-title')).toHaveCount(0);
  const remote = await renaming.works(), invalidId = randomUUID();
  const invalidFiles = remote.files.map(file => ({ ...file, name: 'renamed-annotation.json' }));
  const invalidPending = { requestId: invalidId, baseRevision: remote.revision, files: invalidFiles };
  assert.equal((await context.request.post(endpoint + '/api/learning/workspaces/' + renaming.id, { data: invalidPending })).status(), 400);
  assert.equal(await (await context.request.get(endpoint + `/api/learning/workspaces/${renaming.id}/receipts/${invalidId}`)).json(), null);
  // Represent the persisted shape left by the old product, including its original rejected request identity.
  await renaming.page.evaluate(async ({ id, files, pending, confirmed }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('xunjie-reliable-works-v1');
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('workspaces', 'readwrite'), store = tx.objectStore('workspaces'), all = store.getAll();
      all.onsuccess = () => {
        const row = all.result.find(row => JSON.parse(row.key)[4] === id);
        if (!row) { tx.abort(); return; }
        store.put({ ...row, localRevision: row.localRevision + 1, remoteRevision: pending.baseRevision, confirmedFiles: confirmed, files, pending, pendingRejected: undefined });
      };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error ?? new Error('legacy row missing'));
    }; request.onerror = () => reject(request.error);
  }), { id: renaming.id, files: invalidFiles, pending: invalidPending, confirmed: remote.files });
  await renaming.page.locator(`[data-activity-id="${renaming.id}"]`).click();
  await renaming.page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(renaming.frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue('状态位置不可随意改变');
  await expect.poll(async () => (await renaming.works()).revision).toBeGreaterThan(remote.revision);
  assert.deepEqual((await renaming.works()).files.map(file => file.name), ['components/annotation.json']);
  await renaming.page.getByRole('tab', { name: '作品', exact: true }).click();
  await renaming.page.getByRole('button', { name: '文件', exact: true }).click();
  await renaming.page.getByLabel('文件名', { exact: true }).fill('after-rename.txt');
  await renaming.page.getByRole('button', { name: '新建文件', exact: true }).click();
  await renaming.page.keyboard.press('Escape');
  await renaming.page.locator('.monaco-editor textarea').focus(); await renaming.page.keyboard.insertText('恢复后普通作品继续同步');
  await expect.poll(async () => (await renaming.works()).files.find(file => file.name === 'after-rename.txt')?.value).toBe('恢复后普通作品继续同步');
  await renaming.page.reload();
  await renaming.page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(renaming.frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue('状态位置不可随意改变');
  passed('protected state paths and legacy invalid pending recovery preserve data and resume ordinary synchronization');
  const awaiting = await openSample();
  await awaiting.page.evaluate(() => {
    const original = navigator.locks.request.bind(navigator.locks); let first = true;
    navigator.locks.request = async (...args) => {
      if (first) { first = false; await new Promise(resolve => { window.releaseActivityInput = resolve; }); }
      return original(...args);
    };
  });
  await awaiting.frame.locator('body').evaluate(() => {
    window.oldRequest = window.__componentProbe.request('workspace.change', { operationId: crypto.randomUUID(), expectedContentId: null,
      contentId: crypto.randomUUID(), content: { annotations: [{ id: crypto.randomUUID(), quote: '准入等待', note: '活动返回必须等待这份输入' }] } });
  });
  await expect.poll(() => awaiting.page.evaluate(() => typeof window.releaseActivityInput)).toBe('function');
  await awaiting.page.getByRole('button', { name: '返回活动列表', exact: true }).click();
  await expect(awaiting.page.locator('iframe[title="材料标注"]')).toBeVisible();
  await awaiting.page.evaluate(() => window.releaseActivityInput());
  await expect(awaiting.page.locator('#activity-title')).toHaveCount(0);
  await awaiting.page.locator(`[data-activity-id="${awaiting.id}"]`).click();
  await awaiting.page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(awaiting.frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue('活动返回必须等待这份输入');
  passed('activity return waits for asynchronous component admission before disposing its session');
  const replaced = await openSample();
  const oldConnection = await replaced.frame.locator('body').evaluate(() => window.__componentProbe.connectionId);
  await replaced.page.evaluate(() => {
    const lock = navigator.locks.request.bind(navigator.locks), transaction = IDBDatabase.prototype.transaction; let first = true;
    navigator.locks.request = async (...args) => { if (first) { first = false; await new Promise(resolve => { window.releaseRetiredInput = resolve; }); } return lock(...args); };
    IDBDatabase.prototype.transaction = function(stores, mode, options) {
      if (window.failRetiredLookup && mode === 'readonly' && (typeof stores === 'string' ? [stores] : [...stores]).includes('workOperations')) {
        window.failRetiredLookup = false; window.retiredLookupFailed = true; throw new DOMException('Controlled late receipt read failure', 'UnknownError');
      }
      return transaction.call(this, stores, mode, options);
    };
  });
  await replaced.frame.locator('body').evaluate(() => {
    window.retiredRequest = window.__componentProbe.request('workspace.change', { operationId: crypto.randomUUID(), expectedContentId: null,
      contentId: crypto.randomUUID(), content: { annotations: [{ id: crypto.randomUUID(), quote: '退休连接', note: 'RETIRED INPUT' }] } });
  });
  await expect.poll(() => replaced.page.evaluate(() => typeof window.releaseRetiredInput)).toBe('function');
  await replaced.page.locator('iframe[title="材料标注"]').evaluate(element => { element.src = element.src; });
  await expect.poll(async () => { try { const id = await replaced.frame.locator('body').evaluate(() => window.__componentProbe?.connectionId); return typeof id === 'string' && id !== oldConnection; } catch { return false; } }).toBe(true);
  await expect(replaced.frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled();
  await addNote(replaced, '后继连接的当前内容');
  await replaced.page.evaluate(() => { window.failRetiredLookup = true; window.releaseRetiredInput(); });
  await expect.poll(() => replaced.page.evaluate(() => window.retiredLookupFailed)).toBe(true);
  await replaced.page.getByRole('tab', { name: '作品', exact: true }).click();
  await expect(replaced.page.getByRole('heading', { name: '作品存在分歧', exact: true })).toHaveCount(0);
  await expect(replaced.page.getByText('后继连接的当前内容', { exact: false }).first()).toBeVisible();
  await expect(replaced.page.getByText('RETIRED INPUT', { exact: false })).toHaveCount(0);
  passed('a real iframe replacement followed by late receipt failure cannot mutate the successor workspace');
  const eventSample = await openSample();
  let dispatched = 0;
  const observe = request => { if (request.method() === 'POST' && /\/(?:intents|models|gateway)(?:\/|$)/.test(new URL(request.url()).pathname)) dispatched++; };
  eventSample.page.on('request', observe);
  const eventResults = await eventSample.frame.locator('body').evaluate(async () => {
    const values = [{ kind: 'control-change', controlId: 'selection', value: '中文' }, { kind: 'answer', promptId: 'reading', value: '我的回答' },
      { kind: 'prediction', promptId: 'reading', value: '我的预测' }, { kind: 'confirmation', targetId: 'selection', confirmed: true }];
    const results = [];
    for (const [index, value] of values.entries()) {
      const event = { formatVersion: 1, eventId: crypto.randomUUID(), sequence: index + 1, ...value };
      const first = await window.__componentProbe.request('component.event', event), repeated = await window.__componentProbe.request('component.event', event);
      results.push({ first, repeated });
    }
    return results;
  });
  for (const { first, repeated } of eventResults) { assert.equal(first.payload.received, true); assert.deepEqual(first.payload, repeated.payload); }
  assert.equal(dispatched, 0); assert.deepEqual((await eventSample.works()).files, []);
  passed('compatible component sends four typed events with stable receipts and no model/question dispatch');
  const revokedActivity = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  const revokedPage = await context.newPage();
  await revokedPage.goto(endpoint + '?space=school&activity=' + (await revokedActivity.json()).activityId);
  await revokedPage.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(revokedPage.frameLocator('iframe[title="材料标注"]').getByRole('button', { name: '标注选中文字' })).toBeEnabled();
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: false }, admin);
  await expect.poll(async () => revokedPage.frameLocator('iframe[title="材料标注"]').locator('body').evaluate(async () =>
    (await window.__componentProbe.request('workspace.read', {})).error?.code), { timeout: 15000 }).toBe('forbidden');
  passed('known course revocation is reported as forbidden by the real mounted host');
  assert.equal(await artifactDigest(webRoot), assetsBefore);
  report.frontendSha256 = assetsBefore;
  passed('component import and use leave the main frontend artifact unchanged');
  for (const document of context.pages()) for (const frame of document.frames()) {
    if (frame === document.mainFrame()) continue;
    const errors = await frame.evaluate(() => window.__componentProbe?.protocolErrors ?? 0);
    assert.equal(errors, 0, 'every observed host response must pass the shared strict v1 validator');
  }
  passed('strict public v1 validator accepts all observed initialization, success and error messages');
  report.status = 'passed';
  }
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); throw error;
} finally {
  if (process.platform === 'darwin' && process.arch === 'arm64') report.mac = report.status;
  await browser?.close();
  try { await runtime.stop(); report.cleanup = 'owned product stopped'; } catch (error) { report.cleanup = String(error); }
  await writeFile(join(output, process.env.XUNJIE_COMPONENT_BASELINE_WEB ? 'baseline-browser-report.json' : 'browser-report.json'), JSON.stringify(report, null, 2));
}
