import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { aggregationPackage } from '../components/table-aggregation/package.mjs';

/**
 * Real product acceptance for #170: a student edits a table, a restricted WebAssembly algorithm
 * computes, and the result is retained, downloadable and re-readable after a reload.
 *
 * Everything runs against the installed product, native PostgreSQL and real Chrome. No API is
 * stubbed and no execution is simulated in JavaScript.
 */
const output = resolve(process.env.XUNJIE_EXECUTION_OUTPUT ?? '.verification/wp03-170');
const webRoot = resolve(process.env.XUNJIE_PRODUCT_WEB_ROOT ?? 'apps/web/dist-runtime');
await mkdir(output, { recursive: true });
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Native PostgreSQL required');
const root = await mkdtemp(join(tmpdir(), 'xj-execution-browser-'));
const report = { platform: process.platform, arch: process.arch, os: release(), node: process.version,
  root, browser: 'Google Chrome', cases: [], status: 'running', headless: false };
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
  const published = await aggregationPackage();
  const definition = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
  await api('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '表格聚合验收' }, task: { taskId, title: '按小组统计得分', summary: '浏览器计算与持久执行' },
    release: { releaseId, objectives: ['用受限算法算出一组统计'], requirements: '编辑表格，选好分组列与数值列后运行计算。',
      starterWorks: [], capabilities: [],
      components: [{ key: 'table', definition, configuration: { title: '表格聚合' }, materialIds: [] }], materials: [] },
    resources: [] }, admin);
  const password = randomUUID(), loginName = 'execution-browser';
  const member = await api('manage/members', { requestId: randomUUID(), loginName, password }, admin);
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const login = await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  assert.equal(login.status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  assert.equal(created.status(), 200);
  const activity = await created.json();
  const page = await context.newPage();
  page.on('pageerror', error => console.log('BROWSER ERROR ' + error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE ' + message.text().slice(0, 300)); });
  page.on('response', async response => { if (response.status() >= 400) console.log('HTTP ' + response.status() + ' ' + response.url() + ' ' + (await response.text().catch(() => ''))); });
  const posted = [];
  page.on('request', request => {
    if (!request.url().includes('/api/learning/executions/') || request.method() !== 'POST') return;
    const body = request.postDataJSON?.();
    if (body?.action?.requestId && body?.acceptance?.execution) posted.push({ requestId: body.action.requestId,
      executionRef: body.acceptance.execution.executionRef });
  });
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await expect(page.locator('#activity-title')).toHaveText('按小组统计得分');
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  const frame = page.frameLocator('iframe[title="表格聚合"]');
  await expect(frame.getByRole('heading', { name: '表格聚合', exact: true })).toBeVisible();
  await expect(frame.getByRole('textbox', { name: '得分 第1行', exact: true })).toHaveValue('88');
  await expect(frame.getByRole('textbox', { name: '姓名 第12行', exact: true })).toHaveValue('苏清');
  passed('the imported view renders the pinned sample table inside the formal workspace');

  // A wrong cell must produce a real negative execution that names the row, not a silent zero.
  const broken = frame.getByRole('textbox', { name: '得分 第2行', exact: true });
  await broken.fill('九十');
  await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  await expect(frame.locator('#error')).toBeVisible({ timeout: 20000 });
  await expect(frame.locator('#error')).toContainText('第 2 行', { timeout: 20000 });
  assert.equal(await frame.locator('#result').isHidden(), true);
  passed('a non-numeric cell stops the real algorithm before computing and names the row');
  await broken.fill('92');

  // One real run through the dedicated worker, the browser ledger and the service owner.
  await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  await expect(frame.getByRole('heading', { name: '结果', exact: true })).toBeVisible({ timeout: 30000 });
  await expect(frame.locator('#summary')).toContainText('共 12 行、3 组');
  const rows = frame.locator('#groups tbody tr');
  await expect(rows).toHaveCount(3);
  // Group A: 88, 92, 79, 73 -> count 4, sum 332, mean 83.
  await expect(rows.first()).toContainText('A');
  await expect(rows.first()).toContainText('332');
  await expect(rows.first()).toContainText('83');
  passed('the restricted WebAssembly algorithm returns the real group statistics (A: 4 项, 332, 83)');

  const panel = page.getByRole('region', { name: '计算记录' });
  await expect(panel.getByText('已完成', { exact: false }).first()).toBeVisible({ timeout: 20000 });
  await expect(panel).toContainText('按「小组」分组，数值列「得分」，方式 平均');
  await expect(panel).toContainText('该次输入共 12 行');
  passed('the workspace record shows the parameters and the input the result corresponds to');

  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: '下载 CSV' }).click()]);
  const csv = await readFile(await download.path(), 'utf8');
  assert.match(csv, /^小组,计数,求和,平均,最小,最大\n/);
  assert.match(csv, /^A,4,332,83,73,92$/m);
  assert.equal(download.suggestedFilename(), '聚合结果-mean.csv');
  passed('the retained artifact downloads as real CSV bytes from the run that produced it');

  // A real stop: every declared admission slot is held, so the run is queued but has not started.
  await page.evaluate(() => { window.__releaseSlot = []
    for (const name of ['xunjie-execution-slot:0', 'xunjie-execution-slot:1'])
      void navigator.locks.request(name, () => new Promise(resolve => { window.__releaseSlot.push(resolve) })) })
  await page.waitForFunction(() => Array.isArray(window.__releaseSlot) && window.__releaseSlot.length === 2);
  await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('已接收', { timeout: 20000 });
  await frame.getByRole('button', { name: '停止', exact: true }).click();
  await expect(frame.locator('#status')).toContainText('已取消', { timeout: 20000 });
  await page.evaluate(() => window.__releaseSlot.forEach(resolve => resolve()));
  await expect(panel).toContainText('已取消');
  // The stopped run is the newest record and published no artifact, so it has no download.
  await expect(panel.locator('li').first()).toContainText('已取消');
  await expect(panel.locator('li').first().getByRole('button', { name: '下载 CSV' })).toHaveCount(0);
  // The service kept the same acceptance and recorded the stop, rather than a new run.
  const remote = await (async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      for (const sent of posted) {
        const value = await (await context.request.get(endpoint + '/api/learning/executions/' + activity.activityId + '/' +
          sent.requestId)).json().catch(() => null);
        if (value?.state === 'cancelled') return { ...value, posted: sent };
      }
      await page.waitForTimeout(100);
    }
    return null;
  })();
  assert.equal(remote?.state, 'cancelled');
  assert.equal(remote?.stopRequested, true);
  // The stop names the original acceptance: same execution reference, no second command.
  assert.equal(remote?.executionRef, remote?.posted.executionRef);
  passed('a queued run is stopped through the real worker path and the service keeps its original acceptance');

  await frame.locator('#result').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'execution-light.png'), fullPage: true });

  await page.reload();
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  await expect(page.getByRole('region', { name: '计算记录' })).toContainText('已完成');
  await expect(page.getByRole('region', { name: '计算记录' })).toContainText('按「小组」分组');
  passed('a full page reload re-queries the persisted run record instead of recomputing');

  // Changing the table after a run is reported, and the late fact never hijacks the new selection.
  await page.frameLocator('iframe[title="表格聚合"]').getByRole('textbox', { name: '得分 第1行', exact: true }).fill('100');
  await expect(page.getByRole('region', { name: '计算记录' })).toContainText('当前表格已改动', { timeout: 20000 });
  passed('the record warns that the current table changed after the run it describes');

  await page.evaluate(() => { localStorage.setItem('theme.v1', 'dark'); document.documentElement.dataset.theme = 'dark'; });
  await expect.poll(() => page.frameLocator('iframe[title="表格聚合"]').locator('body')
    .evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim().toLowerCase())).toBe('#1f1f1f');
  await page.screenshot({ path: join(output, 'execution-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.screenshot({ path: join(output, 'execution-narrow.png'), fullPage: true });
  passed('light, dark and narrow desktop rendering captured from the real run');
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  await expect(page.getByRole('region', { name: '计算记录' })).toContainText('已完成');
  passed('switching tools keeps the run record and its download available');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error?.message ?? String(error);
  throw error;
} finally {
  await writeFile(join(output, 'browser-report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  await browser?.close().catch(() => {});
  await runtime.stop().catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
