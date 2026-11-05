import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { legacyAnnotationPackage, preparedAnnotationPackage, selfTestMaterial } from '../components/material-annotation/package.mjs';

const output = resolve(process.env.XUNJIE_PREPARATION_REPORT_DIR ?? '.verification/wp03-171');
const webRoot = resolve(process.env.XUNJIE_PRODUCT_WEB_ROOT ?? 'apps/web/dist-runtime');
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
const root = await mkdtemp(join(tmpdir(), 'xj-preparation-'));
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Native PostgreSQL required');
const report = { platform: process.platform, arch: process.arch, os: release(), root, cases: [], status: 'running',
  browser: 'Google Chrome', node: process.version, mac: process.platform === 'darwin' && process.arch === 'arm64' ? 'running' : 'not-run',
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDirty: !!execFileSync('git', ['status', '--porcelain', '--', 'apps/web/src/component-host', 'apps/web/src/component-preparation',
    'scripts/probe-component-preparation.mjs'], { encoding: 'utf8' }).trim(),
  preparationSourceSha256: await artifactDigest(resolve('apps/web/src/component-preparation')),
  hostSourceSha256: createHash('sha256').update(await readFile(resolve('apps/web/src/component-host/ComponentView.tsx'))).digest('hex'),
  teachingOutcome: 'not-evaluated' };
const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
  postgresVersion: '18.6', webRoot, windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') } });
let browser;
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };
/** Reads the browser-local preparation facts; the store is device state, never student work. */
const preparationFacts = page => page.evaluate(() => new Promise((resolveFacts, reject) => {
  // Same schema as the app, so observing before the first preparation cannot create an empty database.
  const request = indexedDB.open('xunjie-component-preparation-v1', 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('preparations')) db.createObjectStore('preparations', { keyPath: 'preparationId' }).createIndex('scope', 'scopeKey');
    if (!db.objectStoreNames.contains('checks')) db.createObjectStore('checks', { keyPath: 'fingerprint' });
    if (!db.objectStoreNames.contains('resources')) db.createObjectStore('resources', { keyPath: 'sha256' });
    if (!db.objectStoreNames.contains('environments')) db.createObjectStore('environments', { keyPath: 'scopeKey' });
  };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('preparations')) { db.close(); resolveFacts({ preparations: [], resources: [], environments: [] }); return; }
    const tx = db.transaction(['preparations', 'resources', 'environments'], 'readonly');
    const preparations = tx.objectStore('preparations').getAll();
    const resources = tx.objectStore('resources').getAll();
    const environments = tx.objectStore('environments').getAll();
    tx.oncomplete = () => {
      const pick = value => ({ preparationId: value.preparationId, status: value.status, stage: value.stage, reason: value.reason,
        environmentId: value.environmentId, cacheHit: value.cacheHit, resourceBytes: value.resourceBytes,
        durationMs: value.durationMs,
        reportSubmitted: value.reportSubmitted, diagnostics: value.diagnostics.map(item => `${item.stage}/${item.reason}: ${item.detail}`),
        checks: value.checks.map(item => ({ checkId: item.checkId, verification: item.verification, reason: item.reason })),
        capabilities: Object.fromEntries(value.capabilities.map(item => [item.capability, item.availability])) });
      resolveFacts({ preparations: preparations.result.map(pick), resources: resources.result.map(item =>
        ({ sha256: item.sha256, byteLength: item.byteLength, mediaType: item.mediaType })),
        environments: environments.result.map(item => ({ scopeKey: item.scopeKey, environmentId: item.environmentId,
          version: item.version, definitionDigest: item.definitionDigest })) });
      db.close();
    };
    tx.onabort = () => reject(tx.error);
  };
}));

try {
  await runtime.install({ profile: 'local' });
  const { endpoint } = await runtime.start();
  report.endpointProfile = 'local';
  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const api = async (route, body, headers = {}) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, `API ${route} ${response.status}`);
    return response.json();
  };
  const assetsBefore = await artifactDigest(webRoot);
  const preparedImport = { requestId: randomUUID(), ...await preparedAnnotationPackage() };
  const legacyImport = { requestId: randomUUID(), ...await legacyAnnotationPackage() };
  const preparedDefinition = await api('manage/component-import', preparedImport, admin);
  const legacyDefinition = await api('manage/component-import', legacyImport, admin);
  assert.equal(preparedDefinition.manifest.formatVersion, 2);
  assert.equal(legacyDefinition.manifest.formatVersion, 1);
  assert.equal(await artifactDigest(webRoot), assetsBefore);
  report.frontendSha256 = assetsBefore;
  passed('importing a prepared component version and its locked dependency leaves the main frontend artifact unchanged');

  const dependency = preparedDefinition.manifest.dependencies[0];
  const materialId = randomUUID(), courseId = randomUUID(), taskId = randomUUID();
  const preparedReleaseId = randomUUID(), legacyReleaseId = randomUUID();
  // Real open material with a phrase that occurs twice, so a highlight count can only come from the real DOM.
  const text = '观察与解释\n\n阅读材料时，先区分观察到的事实与自己的解释。\n记录问题，再寻找可以核对的依据。\n\n再次核对时，先区分观察到的事实与新的解释。';
  const repeated = '先区分观察到的事实';
  assert.equal(text.split(repeated).length - 1, 2);
  const bytes = Buffer.from(text);
  const material = { materialId, title: '阅读材料', path: 'material.txt', mediaType: 'text/plain', access: 'student',
    byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const resources = [{ path: 'material.txt', contentBase64: bytes.toString('base64') }];
  const importCourse = releaseId => ({ formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '依赖准备验收' },
    task: { taskId, title: '阅读材料，记录你的理解', summary: '组件依赖准备与自检样例' },
    release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['区分事实与解释'], requirements: '阅读开放材料，选择文字并记下理解或疑问。', starterWorks: [], capabilities: [],
      components: [], materials: [material] }, resources });
  const preparedCourse = importCourse(preparedReleaseId);
  preparedCourse.release.components = [{ key: 'annotation', definition: preparedDefinition, configuration: { title: '材料标注' }, materialIds: [materialId] }];
  await api('manage/course-import', preparedCourse, admin);
  const legacyCourse = importCourse(legacyReleaseId);
  legacyCourse.release.components = [{ key: 'annotation', definition: legacyDefinition, configuration: { title: '材料标注' }, materialIds: [materialId] }];
  await api('manage/course-import', legacyCourse, admin);
  const password = randomUUID(), loginName = 'preparation-student';
  const identity = await api('manage/members', { requestId: randomUUID(), loginName, password }, admin);
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: true }, admin);

  browser = await chromium.launch({ channel: 'chrome', headless: false });
  report.browserVersion = browser.version(); report.headless = false;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  const openActivity = async (releaseId, target) => {
    const created = await target.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
    assert.equal(created.status(), 200);
    const activity = await created.json();
    const page = await target.newPage();
    await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
    return { activity, page };
  };

  // ---- cold preparation on the real product resource path ----
  const views = [], dependencyFetches = [];
  const { activity, page } = await openActivity(preparedReleaseId, context);
  page.on('request', request => {
    if (request.url().includes(`/components/annotation/view`)) views.push(request.url());
    if (request.url().includes('/components/annotation/dependencies/')) dependencyFetches.push(request.url());
  });
  await expect(page.getByRole('tab', { name: '材料标注', exact: true })).toBeVisible();
  await page.screenshot({ path: join(output, 'prepared-before-open-light.png'), fullPage: true });
  await page.getByRole('tab', { name: '材料标注', exact: true }).click();
  const frame = page.frameLocator('iframe[title="材料标注"]');
  await expect(frame.getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 30000 });
  const cold = await preparationFacts(page);
  if (cold.preparations[0]?.status !== 'ready') console.log('PREPARATION ' + JSON.stringify(cold.preparations[0], null, 2));
  assert.equal(cold.preparations.length, 1, JSON.stringify(cold.preparations));
  assert.equal(cold.preparations[0].status, 'ready');
  assert.equal(cold.preparations[0].stage, 'activate');
  assert.equal(cold.preparations[0].cacheHit, false, 'a cold open downloads the dependency');
  assert.equal(cold.preparations[0].resourceBytes, dependency.byteLength);
  assert.deepEqual(cold.preparations[0].capabilities,
    { 'workspace.read': 'available', 'workspace.change': 'available', 'material.highlight': 'available' });
  assert.equal(cold.preparations[0].reportSubmitted, true);
  assert.deepEqual(cold.resources, [{ sha256: dependency.sha256, byteLength: dependency.byteLength, mediaType: 'text/javascript' }]);
  assert.equal(cold.environments.length, 1);
  assert.equal(dependencyFetches.length, 1, 'the dependency came from the registered owner over the production route');
  assert.equal(views.length, 2, 'one isolated self-test instance plus the production instance');
  report.cold = { dependencyFetches: dependencyFetches.length, viewLoads: views.length,
    resourceBytes: cold.preparations[0].resourceBytes, durationMs: cold.preparations[0].durationMs,
    environmentId: cold.environments[0].environmentId };
  passed('cold preparation fetched, digest-verified, self-tested in an isolated instance and activated one environment');

  // ---- the self-test wrote no student work ----
  const works = async id => (await context.request.get(endpoint + '/api/learning/workspaces/' + id)).json();
  assert.deepEqual((await works(activity.activityId)).files, [], 'the isolated self-test must not create student work');
  report.selfTestMaterial = selfTestMaterial.title;
  passed('the isolated self-test instance produced no student work, session or learning evidence');

  // ---- the production frame really executes the locked dependency ----
  const loaded = await frame.locator('body').evaluate(() => ({
    mark: typeof window.Mark,
    scripts: [...document.head.querySelectorAll('script[data-dependency]')].map(item => item.getAttribute('data-dependency')),
    note: document.querySelector('#highlight-note')?.textContent ?? null,
    noteHidden: document.querySelector('#highlight-note')?.hidden ?? null,
  }));
  if (loaded.mark !== 'function') {
    console.log('LOAD ' + JSON.stringify(loaded, null, 2));
    console.log('FACTS ' + JSON.stringify(cold.preparations[0], null, 2));
  }
  assert.equal(loaded.mark, 'function', 'the delivered bytes really defined the declared global');
  assert.deepEqual(loaded.scripts, [dependency.dependencyId]);
  assert.equal(loaded.noteHidden, true, 'no standing preparation badge once the capability is available');
  passed('the production frame executes the delivered dependency bytes as a script and defines the declared global');

  // ---- real highlighting over Chinese material, counted from the real DOM ----
  await frame.locator('#materials p').evaluate((element, phrase) => {
    const start = element.textContent.indexOf(phrase);
    const range = document.createRange();
    range.setStart(element.firstChild, start); range.setEnd(element.firstChild, start + phrase.length);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }, repeated);
  await frame.getByRole('button', { name: '标注选中文字' }).click();
  const note = frame.getByRole('textbox', { name: '标注内容', exact: true });
  await note.fill('先确认观察，再讨论解释。');
  await expect.poll(async () => JSON.parse((await works(activity.activityId)).files[0]?.value ?? '{}').content?.annotations?.[0]?.note)
    .toBe('先确认观察，再讨论解释。');
  await frame.getByRole('button', { name: '在材料中高亮' }).click();
  await expect(frame.locator('mark.xj-mark')).toHaveCount(2);
  assert.deepEqual(await frame.locator('mark.xj-mark').allTextContents(), [repeated, repeated]);
  await expect(frame.locator('#highlight-note')).toContainText('材料中 2 处匹配');
  await expect(frame.locator('#highlight-note')).toContainText('不代表原选区位置');
  await page.screenshot({ path: join(output, 'prepared-highlighted-light.png'), fullPage: true });
  await frame.getByRole('button', { name: '取消高亮' }).click();
  await expect(frame.locator('mark.xj-mark')).toHaveCount(0);
  assert.equal(await frame.locator('#materials p').textContent(), text, 'releasing the highlight preserves the material body');
  passed('real mark.js highlights a repeated Chinese phrase, reports both matches and restores the body text');

  // ---- hot reopen reuses the record, the cache and the check results ----
  views.length = 0; dependencyFetches.length = 0;
  await page.reload();
  await page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue('先确认观察，再讨论解释。', { timeout: 30000 });
  const hot = await preparationFacts(page);
  assert.equal(hot.preparations.length, 1, 'a warm open reuses the original preparation identity');
  assert.equal(hot.preparations[0].preparationId, cold.preparations[0].preparationId);
  assert.equal(hot.preparations[0].cacheHit, true);
  assert.equal(hot.preparations[0].status, 'ready');
  assert.equal(dependencyFetches.length, 0, 'a warm open does not download the dependency again');
  assert.equal(views.length, 1, 'a warm open does not repeat the isolated self-test');
  report.hot = { dependencyFetches: dependencyFetches.length, viewLoads: views.length };
  passed('hot reopen reused the persistent record and cached bytes, and skipped the repeated self-test');

  // ---- the submitted report names the device that actually observed it ----
  const reports = await api(`releases/${preparedReleaseId}/components/annotation/preparation-reports`, undefined,
    { cookie: (await context.storageState()).cookies.map(item => `${item.name}=${item.value}`).join('; ') });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'ready');
  assert.equal(reports[0].preview, false);
  assert.equal(reports[0].definitionDigest, preparedDefinition.digest);
  assert.equal(reports[0].device.browser, 'chrome');
  assert.equal(reports[0].device.preparationImplementationVersion, 2);
  assert.ok(reports[0].device.features.includes('indexeddb'));
  assert.match(reports[0].memoryNote, /未测量浏览器进程内存/);
  report.report = { browserVersion: reports[0].device.browserVersion, platform: reports[0].device.platform,
    durationMs: reports[0].durationMs, resourceBytes: reports[0].resourceBytes };
  passed('the preparation report reached PostgreSQL over the production route and names the real device, not a claim for others');

  // Missing and corrupt cache bytes must be repaired on the original identity without losing student notes.
  for (const corrupt of [false, true]) {
    await page.evaluate(corrupt => new Promise((resolve, reject) => {
      const request = indexedDB.open('xunjie-component-preparation-v1', 1);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('resources', 'readwrite'), store = tx.objectStore('resources');
        const all = store.getAll();
        all.onsuccess = () => { for (const item of all.result) {
          if (corrupt) { item.bytes = new Uint8Array(item.byteLength); store.put(item); }
          else store.delete(item.sha256);
        } };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    }), corrupt);
    await page.reload();
    await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect(frame.getByRole('textbox', { name: '标注内容', exact: true })).toHaveValue('先确认观察，再讨论解释。', { timeout: 30000 });
    await expect.poll(() => frame.locator('body').evaluate(() => typeof window.Mark)).toBe('function');
    assert.equal((await preparationFacts(page)).preparations[0].preparationId, cold.preparations[0].preparationId);
  }
  passed('missing and corrupt warm-cache bytes were reacquired under the original identity and kept confirmed annotations');

  // Two cold tabs of the same browser race at the actual persistent identity boundary.
  const parallelContext = await browser.newContext();
  await parallelContext.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  const parallel = await Promise.all([openActivity(preparedReleaseId, parallelContext), openActivity(preparedReleaseId, parallelContext)]);
  await Promise.all(parallel.map(async ({ page }) => {
    await page.getByRole('tab', { name: '材料标注', exact: true }).click();
    await expect(page.frameLocator('iframe[title="材料标注"]').getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 30000 });
  }));
  const parallelFacts = await preparationFacts(parallel[0].page);
  assert.equal(parallelFacts.preparations.length, 1);
  assert.equal(parallelFacts.environments.length, 1);
  await parallelContext.close();
  passed('simultaneous cold tabs shared one durable preparation identity and one environment');

  // A real /view response is held before iframe load; the declared self-test budget still expires.
  const timeoutImport = { requestId: randomUUID(), ...await preparedAnnotationPackage() };
  timeoutImport.manifest.version = 3;
  timeoutImport.manifest.entry.resourceId = randomUUID();
  timeoutImport.manifest.budget.selfTestTimeoutMs = 1000;
  timeoutImport.manifest.dependencies[0].resourceId = randomUUID();
  timeoutImport.dependencies[0].resourceId = timeoutImport.manifest.dependencies[0].resourceId;
  const timeoutDefinition = await api('manage/component-import', timeoutImport, admin);
  const timeoutRelease = randomUUID(), timeoutCourse = importCourse(timeoutRelease);
  timeoutCourse.release.components = [{ key: 'annotation', definition: timeoutDefinition, configuration: { title: '材料标注' }, materialIds: [materialId] }];
  await api('manage/course-import', timeoutCourse, admin);
  const timeoutContext = await browser.newContext();
  await timeoutContext.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  const timed = await openActivity(timeoutRelease, timeoutContext);
  await timed.page.route('**/components/annotation/view?**', () => {});
  await timed.page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(timed.page.locator('.component-view [role="alert"]')).toContainText('自检被中断', { timeout: 15000 });
  const timedFacts = await preparationFacts(timed.page);
  assert.equal(timedFacts.environments.length, 0);
  assert.equal(await timed.page.locator('iframe[title$="准备自检"]').count(), 0);
  await timed.page.unroute('**/components/annotation/view?**');
  await timed.page.getByRole('button', { name: '按原准备身份继续' }).click();
  await expect(timed.page.frameLocator('iframe[title="材料标注"]').getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 15000 });
  assert.equal((await preparationFacts(timed.page)).preparations[0].preparationId, timedFacts.preparations[0].preparationId);
  await timeoutContext.close();
  passed('stalled self-test iframe load timed out, retired the frame and resumed with its original preparation identity');

  // Inject an actual transport error after the production instance receives the locked bytes.
  const loadFailureContext = await browser.newContext();
  await loadFailureContext.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  await loadFailureContext.addInitScript(() => {
    let production = false;
    window.addEventListener('message', event => {
      if (event.data?.method === 'host.initialize') production = event.data.payload?.preparation?.mode === 'production';
    });
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, ...args) {
      if (production && message?.preparationProtocolVersion === 1 && message.replyTo)
        message = { preparationProtocolVersion: 1, connectionId: message.connectionId, instanceId: message.instanceId,
          replyTo: message.replyTo, error: { code: 'resource-unavailable' } };
      return send.call(this, message, ...args);
    };
  });
  const loadFailed = await openActivity(preparedReleaseId, loadFailureContext);
  await loadFailed.page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(loadFailed.page.locator('.component-view-note')).toContainText('原文高亮暂不可用', { timeout: 30000 });
  await expect(loadFailed.page.frameLocator('iframe[title="材料标注"]').getByRole('button', { name: '标注选中文字' })).toBeEnabled();
  await loadFailed.page.screenshot({ path: join(output, 'production-load-failure-light.png'), fullPage: true });
  await loadFailureContext.close();
  passed('production dependency delivery error disabled the affected capability visibly while leaving base annotation available');

  const activationContext = await browser.newContext();
  await activationContext.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  await activationContext.addInitScript(() => {
    let once = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (once && this.name === 'preparations' && value?.stage === 'activate' && value.environmentId) {
        once = false; this.transaction.abort(); throw new DOMException('Injected activation write failure', 'AbortError');
      }
      return put.call(this, value, ...args);
    };
  });
  const activationFailed = await openActivity(preparedReleaseId, activationContext);
  await activationFailed.page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(activationFailed.page.locator('.component-view [role="alert"]')).toContainText('浏览器准备存储不可用', { timeout: 30000 });
  const activationFacts = await preparationFacts(activationFailed.page);
  assert.equal(activationFacts.environments.length, 0);
  assert.equal(activationFacts.preparations[0].environmentId, null);
  assert.equal(await activationFailed.page.locator('iframe[title="材料标注"]').count(), 0);
  await activationFailed.page.getByRole('button', { name: '按原准备身份继续' }).click();
  await expect(activationFailed.page.frameLocator('iframe[title="材料标注"]').getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 30000 });
  assert.equal((await preparationFacts(activationFailed.page)).preparations[0].preparationId, activationFacts.preparations[0].preparationId);
  await activationContext.close();
  passed('aborted activation atomically preserved both preparation and environment facts and allowed retry without mounting prematurely');

  // ---- interruption continues under the original preparation identity ----
  // A dedicated context, so this preparation really starts cold and the same browser store sees both halves.
  const interruptedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await interruptedContext.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  const interruptedActivity = await openActivity(preparedReleaseId, interruptedContext);
  await interruptedActivity.page.route('**/components/annotation/dependencies/**', () => { /* hold the real fetch open */ });
  await interruptedActivity.page.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect.poll(async () => (await preparationFacts(interruptedActivity.page)).preparations[0]?.stage, { timeout: 20000 }).toBe('fetch');
  const interruptedRecord = (await preparationFacts(interruptedActivity.page)).preparations[0];
  assert.equal(interruptedRecord.status, 'preparing', 'the confirmed stage was persisted before the fetch began');
  await interruptedActivity.page.close();
  const resumed = await interruptedContext.newPage();
  await resumed.goto(endpoint + '?space=school&activity=' + interruptedActivity.activity.activityId);
  await resumed.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(resumed.frameLocator('iframe[title="材料标注"]').getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 30000 });
  const continued = await preparationFacts(resumed);
  assert.equal(continued.preparations.length, 1);
  assert.equal(continued.preparations[0].preparationId, interruptedRecord.preparationId,
    'the interrupted preparation continued under its own identity');
  assert.equal(continued.preparations[0].status, 'ready');
  assert.ok(continued.preparations[0].environmentId, 'the resumed run activated an environment');
  assert.deepEqual((await works(interruptedActivity.activity.activityId)).files, [],
    'neither the interrupted nor the resumed preparation wrote student work');
  await resumed.close(); await interruptedContext.close();
  passed('an interrupted fetch continued under the original preparationId instead of starting a second preparation');

  // ---- a dependency that cannot be fetched closes only the gated capability ----
  const degradedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await degradedContext.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  const degraded = await openActivity(preparedReleaseId, degradedContext);
  await degraded.page.route('**/components/annotation/dependencies/**', route => route.abort());
  await degraded.page.getByRole('tab', { name: '材料标注', exact: true }).click();
  const degradedFrame = degraded.page.frameLocator('iframe[title="材料标注"]');
  await expect(degradedFrame.getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 30000 });
  await expect(degraded.page.locator('.component-view-note')).toContainText('原文高亮暂不可用');
  await expect(degraded.page.locator('.component-view-note')).toContainText('依赖资源暂时取不到');
  await expect(degradedFrame.locator('#highlight-note')).toContainText('原文高亮暂不可用');
  const degradedFacts = await preparationFacts(degraded.page);
  assert.equal(degradedFacts.preparations[0].status, 'repairable');
  assert.equal(degradedFacts.preparations[0].reason, 'resource-missing');
  assert.deepEqual(degradedFacts.preparations[0].capabilities,
    { 'workspace.read': 'available', 'workspace.change': 'available', 'material.highlight': 'unavailable' });
  assert.deepEqual(degradedFacts.resources, [], 'nothing unverified was cached');
  await degradedFrame.locator('#materials p').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await degradedFrame.getByRole('button', { name: '标注选中文字' }).click();
  await degradedFrame.getByRole('textbox', { name: '标注内容', exact: true }).fill('依赖取不到时仍可记录');
  await expect.poll(async () => JSON.parse((await works(degraded.activity.activityId)).files[0]?.value ?? '{}')
    .content?.annotations?.[0]?.note).toBe('依赖取不到时仍可记录');
  await expect(degradedFrame.getByRole('button', { name: '移除此标注' })).toBeVisible();
  await expect(degradedFrame.getByRole('button', { name: '在材料中高亮' })).toHaveCount(0, 'no highlight affordance without the library');
  await degraded.page.screenshot({ path: join(output, 'prepared-degraded-light.png'), fullPage: true });
  passed('an unfetchable dependency closed only highlighting; annotation and persistence kept working with a nearby reason');

  // ---- preparation storage failure: no mount, no claimed readiness, existing work preserved ----
  const storeFailureContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await storeFailureContext.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  const storeFailure = await storeFailureContext.newPage();
  // Only the preparation database is faulted; the reliable workspace database and every business API stay real.
  await storeFailureContext.addInitScript(() => {
    const original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name, ...rest) {
      if (name === 'xunjie-component-preparation-v1') throw new DOMException('Injected preparation storage failure', 'UnknownError');
      return original.call(this, name, ...rest);
    };
  });
  await storeFailure.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await storeFailure.getByRole('tab', { name: '材料标注', exact: true }).click();
  await expect(storeFailure.locator('.component-view [role="alert"]')).toContainText('浏览器准备存储不可用', { timeout: 30000 });
  await expect(storeFailure.locator('.component-view [role="alert"]')).toContainText('已有标注仍保留');
  assert.equal(await storeFailure.locator('iframe[title="材料标注"]').count(), 0, 'no environment is activated without a persisted record');
  assert.equal(JSON.parse((await works(activity.activityId)).files[0].value).content.annotations[0].note, '先确认观察，再讨论解释。',
    'a preparation storage failure cannot touch confirmed student work');
  await storeFailure.screenshot({ path: join(output, 'prepared-storage-failure-light.png'), fullPage: true });
  await storeFailureContext.close();
  passed('preparation storage failure refused to mount or claim readiness, named the blocker and left confirmed work intact');

  // ---- the format 1 release keeps the original path with no preparation UI ----
  const legacy = await openActivity(legacyReleaseId, context);
  await legacy.page.getByRole('tab', { name: '材料标注', exact: true }).click();
  const legacyFrame = legacy.page.frameLocator('iframe[title="材料标注"]');
  await expect(legacyFrame.getByRole('button', { name: '标注选中文字' })).toBeEnabled({ timeout: 30000 });
  assert.equal(await legacy.page.locator('.component-view-note').count(), 0);
  assert.equal(await legacyFrame.locator('#highlight-note').count(), 0, 'the format 1 view declares no preparation protocol');
  await legacy.page.screenshot({ path: join(output, 'legacy-component-light.png'), fullPage: true });
  const legacyFacts = await preparationFacts(legacy.page);
  assert.equal(legacyFacts.environments.length, 1, 'a format 1 binding creates no preparation environment');
  passed('the format 1 release still opens through its original path with no preparation step and no new environment');

  // ---- theme and narrow desktop ----
  await page.bringToFront();
  await page.evaluate(() => { localStorage.setItem('theme.v1', 'dark'); document.documentElement.dataset.theme = 'dark'; });
  await expect.poll(() => frame.locator('body').evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim())).not.toBe('');
  await frame.getByRole('button', { name: '在材料中高亮' }).click();
  await expect(frame.locator('mark.xj-mark')).toHaveCount(2);
  await page.screenshot({ path: join(output, 'prepared-highlighted-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.screenshot({ path: join(output, 'prepared-highlighted-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { localStorage.setItem('theme.v1', 'light'); document.documentElement.dataset.theme = 'light'; });
  passed('highlight rendering captured in dark theme and at a narrow desktop width');

  // ---- revocation stops the dependency route too ----
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: false }, admin);
  const revoked = await context.request.get(endpoint + `/api/learning/releases/${preparedReleaseId}/components/annotation/dependencies/${dependency.dependencyId}`);
  assert.equal(revoked.status(), 403, 'a revoked member cannot read dependency bytes');
  passed('course revocation stops the fixed dependency route with the existing eligibility check');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); throw error;
} finally {
  if (process.platform === 'darwin' && process.arch === 'arm64') report.mac = report.status;
  await browser?.close();
  try { await runtime.stop(); report.cleanup = 'owned product stopped'; } catch (error) { report.cleanup = String(error); }
  await writeFile(join(output, 'preparation-report.json'), JSON.stringify(report, null, 2));
}
