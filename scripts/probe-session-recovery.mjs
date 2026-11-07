import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication, resolveCredential } from '@xunjie/product-runtime';
import { SupervisedSession } from '@xunjie/learning-space';
import { accumulatorPackage } from '../components/state-accumulator/package.mjs';

const output = resolve('.verification/wp03-174'), root = await mkdtemp(join(tmpdir(), 'xj174-browser-'));
await mkdir(output, { recursive: true });
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Native PostgreSQL required');
const helper = process.env.XUNJIE_NATIVE_SESSION_HELPER;
const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
  webRoot: resolve('apps/web/dist-runtime'), windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1'),
  ...(helper ? { windowsSessionHelper: helper, windowsSessionHelperSha256: createHash('sha256').update(await readFile(helper)).digest('hex') } : {}) };
const runtime = openProductRuntime({ root, resources });
const measurementStart = performance.now(); let lastCase = measurementStart;
const report = { date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()), platform: process.platform, arch: process.arch, osRelease: release(),
  node: process.version, browser: 'installed Chrome', headless: false, status: 'running', cases: [], timings: [],
  isolation: helper ? 'configured Windows session helper'
    : process.platform === 'darwin' ? 'development native resources; macOS seatbelt enforced for adapter v2; no distribution package claim'
      : 'development native resources; no AppContainer package claim',
  mac: process.platform === 'darwin' ? 'accepted on Apple Silicon arm64' : 'deferred by user', teaching: 'not evaluated', receiver: 'no model calls' };
const passed = name => { const now = performance.now(); report.cases.push(name); report.timings.push({ name, elapsedMs: Math.round(now - lastCase) }); lastCase = now; console.log('PASS ' + name); };
// Test-only fault injection: retain exactly the children this owner creates, so a forced exit
// targets a verified test executor, never an unrelated Node process or an added product route.
const processes = new Map(), create = SupervisedSession.create;
SupervisedSession.create = async function (options) {
  const session = await create.call(this, options); processes.set(session.instanceId, session); return session;
};
let host, browser, page;
try {
 await runtime.install({ profile: 'local' });
 host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context) });
 const endpoint = host.endpoint, admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
 const api = async (route, body, headers = admin) => {
  const response = await fetch(endpoint + '/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
   headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, 200, route + ': ' + (response.status === 200 ? '' : await response.text())); return response.json();
 };
 const legacy = await api('manage/component-import', { requestId: randomUUID(), ...await accumulatorPackage({ version: 1 }) });
 const modern = await api('manage/component-import', { requestId: randomUUID(), ...await accumulatorPackage() });
 const courseId = randomUUID(), releaseId = randomUUID();
 await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '会话控制与恢复验收' },
  task: { taskId: randomUUID(), title: '观察四态累加与检查点恢复', summary: '' }, release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId,
   objectives: ['核对真实内部状态恢复'], requirements: '输入、暂停、单步并保存检查点，原进程丢失后核对恢复实例。',
   starterWorks: [], capabilities: [], materials: [], components: [
    { key: 'legacy', definition: legacy, configuration: { title: '原版累加器' }, materialIds: [] },
    { key: 'accumulator', definition: modern, configuration: { title: '恢复累加器' }, materialIds: [] }] }, resources: [] });
 const password = randomUUID(), loginName = 'session-recovery-student';
 const member = await api('manage/members', { requestId: randomUUID(), loginName, password });
 await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true });
 browser = await chromium.launch({ channel: 'chrome', headless: false }); report.browserVersion = browser.version();
 const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
 assert.equal((await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
 const activity = await (await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } })).json();
 const contextValue = await (await context.request.get(endpoint + '/api/learning/context')).json();
 const spaceKey = contextValue.identities.find(item => item.identity.kind === 'school')?.key ?? contextValue.identities[0].key;
 const records = async () => (await context.request.get(endpoint + '/api/learning/executions/' + activity.activityId + '/sessions')).json();
 const current = async () => (await records()).find(item => item.session.instanceKey === 'accumulator');
 const draft = async () => (await context.request.get(endpoint + '/api/learning/drafts/' + activity.activityId)).json();
 page = await context.newPage(); const pageErrors = [], posts = [];
 page.on('pageerror', error => pageErrors.push(error.message));
 page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/learning/executions/')) posts.push(request.postDataJSON()); });
 await page.goto(endpoint + '?space=' + encodeURIComponent(spaceKey) + '&activity=' + activity.activityId);
 await page.getByRole('tab', { name: '原版累加器', exact: true }).click();
 const panel = page.getByRole('region', { name: '本机会话', exact: true });
 await panel.getByRole('button', { name: '启动本机会话', exact: true }).click();
 await expect(panel.getByRole('button', { name: '输入', exact: true })).toBeDisabled();
 assert.equal(await panel.getByRole('button', { name: '暂停', exact: true }).count(), 0);
 await page.screenshot({ path: join(output, 'session-before.png'), fullPage: true });
 await panel.getByRole('button', { name: '停止会话', exact: true }).click();
 await expect(panel).toContainText('已取消'); passed('legacy component remains usable without unsupported controls; before view captured');
 await page.getByRole('tab', { name: '恢复累加器', exact: true }).click();
 await panel.getByRole('button', { name: '启动本机会话', exact: true }).click();
 await expect(panel.getByRole('button', { name: '暂停', exact: true })).toBeEnabled();
 const original = await current(), executor = original.session.executorInstanceId;
 await page.getByRole('button', { name: '打开对话', exact: true }).click();
 const question = '恢复实验时，我的问题和已保存作品不能被改写。';
 await page.getByRole('textbox', { name: '你的问题', exact: true }).fill(question);
 await expect.poll(async () => (await draft()).question).toBe(question);
 const amount = panel.getByRole('spinbutton', { name: '输入整数（0–99）', exact: true });
 await amount.fill('1'); await panel.getByRole('button', { name: '输入', exact: true }).click();
 await expect.poll(async () => (await current()).session.observation.value).toBe(1);
 await panel.getByRole('button', { name: '暂停', exact: true }).click();
 await expect(panel.getByRole('button', { name: '恢复推进', exact: true })).toBeEnabled();
 await amount.fill('2'); await expect(panel.getByRole('button', { name: '输入', exact: true })).toBeDisabled();
 await panel.getByRole('button', { name: '单步', exact: true }).click();
 await expect.poll(async () => (await current()).session.observation.value).toBe(3);
 assert.equal((await current()).state, 'paused'); assert.equal((await current()).session.executorInstanceId, executor);
 passed('pause and one real step retain the same executor and paused mode');
 await page.getByRole('tab', { name: '作品', exact: true }).click();
 await page.getByRole('tab', { name: '恢复累加器', exact: true }).click(); await expect(amount).toHaveValue('2');
 const beforeReload = posts.length; await page.reload();
 await page.getByRole('tab', { name: '恢复累加器', exact: true }).click(); await expect(amount).toHaveValue('2');
 assert.equal((await current()).session.executorInstanceId, executor); assert.equal(posts.length, beforeReload);
 assert.equal((await draft()).question, question); passed('tool switch and refresh protect explicit input and only query the original session');
 let dropped = false;
 await context.route('**/api/learning/executions/' + activity.activityId + '/' + original.requestId + '/control', async route => {
  if (!dropped && route.request().postDataJSON().effect === 'checkpoint') {
   const response = await route.fetch(); assert.equal(response.status(), 200); dropped = true; await route.abort('failed');
  } else await route.continue();
 });
 await panel.getByRole('button', { name: '保存检查点', exact: true }).click();
 await expect.poll(async () => (await current()).session.checkpoints.length).toBe(1);
 await expect(panel.getByRole('combobox', { name: '恢复检查点', exact: true })).toBeVisible();
 await expect.poll(() => posts.filter(item => item.effect === 'checkpoint').length).toBe(1);
 await page.reload(); await page.getByRole('tab', { name: '恢复累加器', exact: true }).click();
 await expect(panel.getByRole('button', { name: '单步', exact: true })).toBeEnabled();
 assert.equal(posts.filter(item => item.effect === 'checkpoint').length, 1);
 const checkpoint = (await current()).session.checkpoints[0]; assert.ok(checkpoint.sha256);
 passed('a lost checkpoint response survives IndexedDB reload and is reconciled without another checkpoint control');
 await amount.fill('2'); await panel.getByRole('button', { name: '单步', exact: true }).click();
 await expect.poll(async () => (await current()).session.observation.value).toBe(1);
 const baseline = (await current()).session.observation;
 const owned = processes.get(executor); assert.ok(owned && owned.instanceId === executor);
 owned.child.kill('SIGKILL');
 await expect.poll(async () => (await current()).state).toBe('failed');
 await expect(panel).toContainText('未完成', { timeout: 15000 });
 assert.equal((await current()).session.observation.value, baseline.value);
 const protectedWorks = await (await context.request.get(endpoint + '/api/learning/workspaces/' + activity.activityId)).json();
 await panel.getByRole('button', { name: '从检查点建立恢复会话', exact: true }).click();
 await expect(panel).toContainText('这是从检查点建立的新恢复实例');
 const restored = await current(); assert.notEqual(restored.executionRef, original.executionRef);
 assert.notEqual(restored.session.executorInstanceId, executor); assert.equal(restored.session.restoredFrom.checkpointId, checkpoint.checkpointId);
 assert.equal(restored.session.observation.value, 3); assert.equal(restored.state, 'paused');
 await expect(amount).toHaveValue('2');
 assert.deepEqual((await (await context.request.get(endpoint + '/api/learning/workspaces/' + activity.activityId)).json()).files, protectedWorks.files);
 await amount.fill('2'); await panel.getByRole('button', { name: '单步', exact: true }).click();
 await expect.poll(async () => (await current()).session.observation).toEqual(baseline);
 assert.equal((await draft()).question, question); passed('forced process exit restores a new related executor; its next step equals the real baseline without replay');
 await panel.locator('summary').click();
 await panel.getByRole('button', { name: '查看这次会话', exact: true }).click();
 await expect(panel.locator('.execution-title')).toContainText('未完成');
 if (!await panel.locator('details').evaluate(element => element.open)) await panel.locator('summary').click();
 await panel.getByRole('button', { name: '查看这次会话', exact: true }).click();
 await expect(panel).toContainText('这是从检查点建立的新恢复实例');
 await panel.getByRole('button', { name: '复位', exact: true }).click();
 await expect.poll(async () => (await current()).session.observation).toEqual({ value: 0, total: 0, applied: 0 });
 await panel.getByRole('button', { name: '恢复推进', exact: true }).click();
 await expect(panel.getByRole('button', { name: '暂停', exact: true })).toBeEnabled();
 assert.equal((await current()).session.executorInstanceId, restored.session.executorInstanceId);
 await panel.getByRole('button', { name: '暂停', exact: true }).click();
 await expect(panel.getByRole('button', { name: '恢复推进', exact: true })).toBeEnabled();
 passed('reset and resume operate on the current process rather than replacing it');
 await page.screenshot({ path: join(output, 'session-after-light.png'), fullPage: true });
 await page.locator('html').evaluate(element => element.dataset.theme = 'dark');
 await expect(page.frameLocator('iframe[title="恢复累加器"]').locator('body')).toHaveCSS('color', await panel.evaluate(element => getComputedStyle(element).color));
 await page.screenshot({ path: join(output, 'session-after-dark.png'), fullPage: true });
 await page.setViewportSize({ width: 1000, height: 800 });
 await panel.getByRole('button', { name: '保存检查点', exact: true }).focus();
 await expect(panel.getByRole('button', { name: '保存检查点', exact: true })).toBeFocused();
 await page.screenshot({ path: join(output, 'session-after-narrow.png'), fullPage: true });
 assert.deepEqual(pageErrors, []); passed('existing workspace controls retain keyboard focus and light/dark/narrow desktop presentation');
 const boundary = await host.maintenance.enter('backup'); assert.equal(boundary.safeToStop, true);
 assert.equal(processes.get(restored.session.executorInstanceId).exitFact?.confirmed, true);
 await host.maintenance.resume();
 await expect.poll(async () => (await current()).state).toBe('cancelled');
 await panel.getByRole('button', { name: '从检查点建立恢复会话', exact: true }).click();
 await expect.poll(async () => (await current()).session.executorInstanceId).not.toBe(restored.session.executorInstanceId);
 await expect.poll(async () => (await current()).state).toBe('paused');
 const afterMaintenance = await current(); assert.equal(afterMaintenance.session.observation.value, 3);
 assert.notEqual(afterMaintenance.session.installGeneration, restored.session.installGeneration);
 passed('maintenance records the real exit before closing writes; resumed gates permit an explicit checkpoint recovery in the new generation');
 await panel.getByRole('button', { name: '停止会话', exact: true }).click();
 await expect.poll(async () => (await current()).state).toBe('cancelled');
 await host.stop(); host = undefined; await runtime.start(); await runtime.stop();
 passed('actual stop and ordinary owner restart validate checkpoint and recovery retention');
 report.status = 'passed';
} catch (error) {
 report.status = 'failed'; report.error = error.message;
 if (page) { report.failureView = await page.locator('body').innerText().catch(() => null); await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
 throw error;
} finally {
 SupervisedSession.create = create;
 await browser?.close(); await host?.stop().catch(() => {}); await runtime.stop().catch(() => {});
 report.totalElapsedMs = Math.round(performance.now() - measurementStart);
 report.nodeHostRssBytes = process.memoryUsage().rss; report.spawnedExecutors = processes.size;
 report.measurementNote = 'Case timings include setup/validation; host RSS excludes PostgreSQL, Chrome and executor peaks.';
 await writeFile(join(output, 'browser-report.json'), JSON.stringify(report, null, 2));
}
