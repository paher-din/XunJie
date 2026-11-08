import { probeEvidenceDirectory, writeEvidence, captureEvidence, mkdtemp } from './lib/probe-evidence.mjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { annotationPackage } from '../components/material-annotation/package.mjs';
import { aggregationPackage } from '../components/table-aggregation/package.mjs';
import { accumulatorPackage } from '../components/state-accumulator/package.mjs';

// Uses the actual candidate's runtime, web, PostgreSQL, and native adapter. No API or calculation mock.
if (!process.argv[2] || process.argv[2].startsWith('--')) throw new Error('Usage: node scripts/probe-execution-recovery.mjs PRODUCT_DIR [OUTPUT_DIR]');
const product = resolve(process.argv[2]);
const output = probeEvidenceDirectory(process.argv[3]);
await mkdir(output, { recursive: true });
const runtime = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const resourcePaths = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
const resources = { ...resourcePaths };
for (const name of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper'])
  if (resources[name]) resources[name] = resolve(product, resources[name]);
const root = await mkdtemp(join(tmpdir(), 'xunjie-176-browser-'));
const sourceRoot = join(root, 'source'), targetRoot = join(root, 'target');
const source = runtime.openProductRuntime({ root: sourceRoot, resources });
const target = runtime.openProductRuntime({ root: targetRoot, resources });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { platform: process.platform, arch: process.arch, os: release(), node: process.version,
  product, packageSha256: hash(await readFile(join(product, 'distribution.json'))), cases: [], status: 'running', headless: false };
const pass = name => { report.cases.push(name); console.log('PASS ' + name); };
let browser, restored, page, targetCreated = false;
async function api(endpoint, route, body, headers = {}) {
  const response = await fetch(new URL('/api/learning/' + route, endpoint), {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, 200, `${route}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function browserDrafts(page) {
  return page.evaluate(async () => {
    const database = await new Promise((done, reject) => {
      const request = indexedDB.open('xunjie-reliable-works-v1');
      request.onsuccess = () => done(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((done, reject) => {
        const request = database.transaction('drafts', 'readonly').objectStore('drafts').getAll();
        request.onsuccess = () => done(request.result); request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  });
}
try {
  await source.install({ profile: 'local' });
  const { endpoint } = await source.start();
  const admin = { authorization: `Bearer ${await runtime.resolveCredential(sourceRoot, 'control')}` };
  const definitions = [];
  for (const input of [await annotationPackage(), await aggregationPackage(), await accumulatorPackage()])
    definitions.push(await api(endpoint, 'manage/component-import', { requestId: randomUUID(), ...input }, admin));
  report.components = definitions.map(definition => ({ componentId: definition.manifest.componentId,
    version: definition.manifest.version, digest: definition.digest }));
  report.postgresVersion = resources.postgresVersion;
  const materialId = randomUUID(), courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
  const bytes = Buffer.from('先区分观察到的事实与自己的解释。保留原始记录，再根据新的证据修订理解。');
  await api(endpoint, 'manage/course-import', { formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '组件与执行恢复验收' }, task: { taskId, title: '重开原作品与实验记录', summary: '真实备份、隔离与接管' },
    release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['保持原作品、输入与执行身份'], requirements: '标注材料、计算固定表格，并为真实会话保存检查点。',
      starterWorks: [], capabilities: [], components: [
        { key: 'annotation', definition: definitions[0], configuration: { title: '材料标注' }, materialIds: [materialId] },
        { key: 'table', definition: definitions[1], configuration: { title: '表格聚合' }, materialIds: [] },
        { key: 'accumulator', definition: definitions[2], configuration: { title: '四态累加模拟' }, materialIds: [] },
      ], materials: [{ materialId, title: '阅读材料', path: 'material.txt', mediaType: 'text/plain', access: 'student',
        byteLength: bytes.length, sha256: hash(bytes) }] }, resources: [{ path: 'material.txt', contentBase64: bytes.toString('base64') }] }, admin);
  const loginName = 'recovery-reader', password = randomUUID();
  const identity = await api(endpoint, 'manage/members', { requestId: randomUUID(), loginName, password }, admin);
  await api(endpoint, 'manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: true }, admin);
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const login = await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  assert.equal(login.status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  assert.equal(created.status(), 200); const activity = await created.json();
  page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', error => { browserErrors.push(error.message); });
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await expect(page.locator('#activity-title')).toHaveText('重开原作品与实验记录');
  await page.getByRole('tab', { name: '材料标注', exact: true }).click();
  let frame = page.frameLocator('iframe[title="材料标注"]');
  await expect(frame.locator('#materials p')).toBeVisible();
  await frame.locator('#materials p').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await frame.getByRole('button', { name: '标注选中文字', exact: true }).click();
  await frame.getByLabel('标注内容', { exact: true }).fill('备份中保留的标注');
  await page.getByRole('button', { name: '打开对话', exact: true }).click();
  await frame.getByRole('button', { name: '选择此标注', exact: true }).click();
  await page.getByLabel('你的问题', { exact: true }).fill('请核对这条原始标注。');
  await expect(page.getByRole('region', { name: '上下文引用' }).getByText('备份中保留的标注', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '问题与引用', exact: true }).click();
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  frame = page.frameLocator('iframe[title="表格聚合"]');
  await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  await expect(page.getByRole('region', { name: '计算记录' }).getByText('已完成', { exact: false })).toBeVisible({ timeout: 30000 });
  await page.getByRole('tab', { name: '四态累加模拟', exact: true }).click();
  await page.getByRole('button', { name: '启动本机会话', exact: true }).click();
  await expect(page.locator('.native-session-observation strong')).toHaveText('0', { timeout: 30000 });
  for (const [value, expected] of [[1, '1'], [2, '3']]) {
    await page.getByLabel('输入整数（0–99）').fill(String(value));
    await page.getByRole('button', { name: '输入', exact: true }).click();
    await expect(page.locator('.native-session-observation strong')).toHaveText(expected);
  }
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  let lostCheckpointReply = false;
  await page.route('**/api/learning/executions/**/control', async route => {
    if (!lostCheckpointReply && route.request().postDataJSON()?.effect === 'checkpoint') {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      lostCheckpointReply = true;
      await route.abort('connectionreset');
    } else await route.continue();
  });
  await page.getByRole('button', { name: '保存检查点', exact: true }).click();
  await expect(page.getByLabel('恢复检查点')).toBeVisible({ timeout: 30000 });
  assert.equal(lostCheckpointReply, true);
  report.lostCheckpointReply = true;
  await captureEvidence(page, { path: join(output, 'source-before.png'), fullPage: true });
  pass('formal product creates annotation, semantic reference, question draft, real Worker result and native checkpoint');
  const sourceContext = await context.request.get(endpoint + '/api/learning/context').then(response => response.json());
  const sourcePage = page;
  // Keep an unsynced edit in the original namespace. The service backup must retain the
  // previous received draft, and restoration must not read or replay this browser-only input.
  await expect.poll(async () => (await context.request.get(endpoint + `/api/learning/drafts/${activity.activityId}`,
    { headers: { 'x-xj-space': 'school' } }).then(response => response.json())).question).toBe('请核对这条原始标注。');
  await sourcePage.route('**/api/learning/drafts/**', route => route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue());
  await sourcePage.getByRole('button', { name: '打开对话', exact: true }).click();
  await sourcePage.getByLabel('你的问题', { exact: true }).fill('浏览器独有未同步草稿');
  await expect.poll(async () => (await browserDrafts(sourcePage)).some(draft =>
    draft.question === '浏览器独有未同步草稿' && draft.key.includes(sourceContext.clientNamespace))).toBe(true);
  await sourcePage.getByRole('button', { name: '问题与引用', exact: true }).click();
  const sourceSessions = await context.request.get(endpoint + `/api/learning/executions/${activity.activityId}/sessions`,
    { headers: { 'x-xj-space': 'school' } }).then(response => response.json());
  const originalSession = sourceSessions[0];
  report.originalSession = { requestId: originalSession.requestId, inputDigest: originalSession.inputDigest,
    executionRef: originalSession.executionRef, nodeId: originalSession.session.nodeId,
    executorInstanceId: originalSession.session.executorInstanceId };
  const sourceHistory = await context.request.get(endpoint + `/api/learning/executions/${activity.activityId}/history`,
    { headers: { 'x-xj-space': 'school' } }).then(response => response.json());
  const job = sourceHistory.entries.find(item => item.action.execution.instance.key === 'table');
  assert.ok(job?.query.output?.artifact);
  report.browserJob = { requestId: job.query.requestId, inputDigest: job.query.inputDigest,
    executionRef: job.query.executionRef, artifactSha256: job.query.output.artifact.sha256,
    artifactByteLength: job.query.output.artifact.byteLength };
  const key = randomBytes(32);
  await source.setCredential('recovery-test-key', key.toString('base64'));
  const manifest = await source.recovery.backup({ directory: join(root, 'backups'), recoveryKeyRef: 'recovery-test-key', leaveClosed: true });
  report.backupId = manifest.backupId;
  restored = await runtime.restoreProductRecovery({ root: targetRoot, backupDirectory: join(root, 'backups', manifest.backupId), key, resources });
  targetCreated = true;
  for (const owner of restored.owners) await owner.close?.();
  restored = undefined;
  const isolated = await target.start();
  assert.equal(isolated.state, 'maintenance');
  const targetContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  assert.equal((await targetContext.request.post(isolated.endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
  const targetState = await targetContext.request.get(isolated.endpoint + '/api/learning/context').then(response => response.json());
  assert.equal(targetState.readOnly, true);
  assert.notEqual(targetState.clientNamespace, sourceContext.clientNamespace);
  const targetPage = await targetContext.newPage(); page = targetPage;
  const writes = [];
  targetPage.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname); });
  targetPage.on('pageerror', error => { browserErrors.push(error.message); });
  await targetPage.goto(isolated.endpoint + '?space=school&activity=' + activity.activityId);
  await expect(targetPage.getByText('这是还原校验环境，作品与历史只读，实验尚未启用。')).toBeVisible();
  await targetPage.getByRole('tab', { name: '材料标注', exact: true }).click();
  frame = targetPage.frameLocator('iframe[title="材料标注"]');
  await expect(frame.getByLabel('标注内容', { exact: true })).toHaveValue('备份中保留的标注');
  assert.equal(await frame.getByLabel('标注内容', { exact: true }).evaluate(element => element.readOnly), true);
  await targetPage.getByRole('button', { name: '打开对话', exact: true }).click();
  await expect(targetPage.getByLabel('你的问题', { exact: true })).toHaveValue('请核对这条原始标注。');
  await expect(targetPage.getByRole('region', { name: '上下文引用' }).getByText('备份中保留的标注', { exact: false })).toBeVisible();
  await captureEvidence(targetPage, { path: join(output, 'isolated-annotation.png'), fullPage: true });
  await targetPage.getByRole('button', { name: '问题与引用', exact: true }).click();
  await targetPage.getByRole('tab', { name: '表格聚合', exact: true }).click();
  await expect(targetPage.getByRole('region', { name: '计算记录' }).getByText('已完成', { exact: false })).toBeVisible();
  const downloaded = targetPage.waitForEvent('download');
  await targetPage.getByRole('button', { name: '下载 CSV', exact: true }).click();
  const download = await downloaded; const artifact = await readFile(await download.path(), 'utf8');
  assert.match(artifact, /A,4,332,83/);
  assert.equal(hash(Buffer.from(artifact)), report.browserJob.artifactSha256);
  assert.equal(Buffer.byteLength(artifact), report.browserJob.artifactByteLength);
  await targetPage.getByRole('tab', { name: '四态累加模拟', exact: true }).click();
  await expect(targetPage.locator('.native-session-observation strong')).toHaveText('3');
  await expect(targetPage.getByRole('button', { name: '从检查点建立恢复会话', exact: true })).toBeDisabled();
  await captureEvidence(targetPage, { path: join(output, 'isolated-native-light.png'), fullPage: true });
  await targetPage.emulateMedia({ colorScheme: 'dark' });
  await expect(targetPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  await captureEvidence(targetPage, { path: join(output, 'isolated-native-dark.png'), fullPage: true });
  await targetPage.setViewportSize({ width: 1000, height: 900 });
  await captureEvidence(targetPage, { path: join(output, 'isolated-native-narrow.png'), fullPage: true });
  assert.deepEqual(writes, [], 'isolated views must not dispatch, sync, report, or run self-tests');
  assert.ok((await browserDrafts(sourcePage)).some(draft =>
    draft.question === '浏览器独有未同步草稿' && draft.key.includes(sourceContext.clientNamespace)));
  pass('fresh Chrome reads original components, fixed result bytes, references, question and checkpoint without a write');
  const originalFetch = globalThis.fetch;
  let lostTakeoverReply = false;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const body = args[1]?.body;
    if (!lostTakeoverReply && typeof body === 'string' && body.includes('"action":"takeover"') && response.ok) {
      await response.arrayBuffer();
      lostTakeoverReply = true;
      throw new TypeError('Injected loss of the already completed takeover reply.');
    }
    return response;
  };
  try { await assert.rejects(target.recovery.takeover({ sourceRoot, receivers: [] })); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(lostTakeoverReply, true);
  const takeover = await target.recovery.takeover({ sourceRoot, receivers: [] });
  assert.equal(takeover.backupId, manifest.backupId);
  assert.equal(takeover.phase, 'active');
  report.lostTakeoverReply = true;
  await assert.rejects(source.recovery.resume(), { code: 'source-retired' });
  assert.equal((await targetContext.request.post(isolated.endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
  await targetPage.setViewportSize({ width: 1440, height: 1000 });
  await targetPage.emulateMedia({ colorScheme: 'light' });
  await targetPage.reload();
  await expect(targetPage.getByText('这是还原校验环境，作品与历史只读，实验尚未启用。')).toHaveCount(0);
  await targetPage.getByRole('tab', { name: '材料标注', exact: true }).click();
  frame = targetPage.frameLocator('iframe[title="材料标注"]');
  await frame.getByLabel('标注内容', { exact: true }).fill('接管后的新编辑');
  await targetPage.getByRole('tab', { name: '四态累加模拟', exact: true }).click();
  await targetPage.getByRole('button', { name: '从检查点建立恢复会话', exact: true }).click();
  await expect(targetPage.locator('.native-session-observation strong')).toHaveText('3', { timeout: 30000 });
  await targetPage.getByLabel('输入整数（0–99）').fill('2');
  // A checkpoint preserves the paused mode; one explicit step proves internal state recovery.
  await targetPage.getByRole('button', { name: '单步', exact: true }).click();
  await expect(targetPage.locator('.native-session-observation strong')).toHaveText('1');
  const after = await targetContext.request.get(isolated.endpoint + `/api/learning/executions/${activity.activityId}/sessions`,
    { headers: { 'x-xj-space': 'school' } }).then(response => response.json());
  assert.ok(after.some(query => query.requestId === originalSession.requestId && query.executionRef === originalSession.executionRef));
  assert.ok(after.some(query => query.requestId !== originalSession.requestId && query.executionRef !== originalSession.executionRef));
  const resumed = after.find(query => query.requestId !== originalSession.requestId);
  report.recoveredSession = { requestId: resumed.requestId, inputDigest: resumed.inputDigest, executionRef: resumed.executionRef,
    nodeId: resumed.session.nodeId, executorInstanceId: resumed.session.executorInstanceId,
    restoredFrom: resumed.session.restoredFrom, nextObservation: resumed.session.observation };
  const oldQueue = await targetContext.request.post(isolated.endpoint + `/api/learning/executions/${activity.activityId}`, {
    headers: { 'x-xj-space': 'school', 'x-xj-namespace': sourceContext.clientNamespace }, data: {},
  });
  assert.equal(oldQueue.status(), 403);
  assert.ok((await browserDrafts(sourcePage)).some(draft =>
    draft.question === '浏览器独有未同步草稿' && draft.key.includes(sourceContext.clientNamespace)));
  await captureEvidence(targetPage, { path: join(output, 'takeover-recovered.png'), fullPage: true });
  pass('takeover permits new edits and a distinct checkpoint instance whose real next result is 1; old namespace is rejected');
  assert.deepEqual(browserErrors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  await captureEvidence(page, { path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const owner of restored?.owners ?? []) await owner.close?.();
  const stopped = await Promise.allSettled([source.stop(), ...(targetCreated ? [target.stop()] : [])]);
  report.cleanup = stopped.map(value => value.status);
  // Delete only this invocation's verified absolute temporary root after its owners stopped.
  if (stopped.every(value => value.status === 'fulfilled')) {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); report.temporaryRootRemoved = true;
    } catch (error) { report.temporaryRootRemoved = false; report.retainedRoot = root; report.cleanupError = error.code; }
  } else { report.temporaryRootRemoved = false; report.retainedRoot = root; }
  await writeEvidence(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
