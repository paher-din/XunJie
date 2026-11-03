import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { aggregationPackage } from '../components/table-aggregation/package.mjs';

/**
 * Real school-web acceptance for #170: a student opens the school web entry with no local
 * product/database, a school-shared member (no device target) runs the restricted browser
 * Worker/WASM computation, and the execution facts land on the school learning-data owner.
 *
 * Distinguished from the local-package path (probe-execution.mjs) and from cross-machine
 * remote execution (#175): this is the school page access path for browser-local execution.
 */
const output = resolve(process.env.XUNJIE_EXECUTION_OUTPUT ?? '.verification/wp03-170');
const webRoot = resolve(process.env.XUNJIE_PRODUCT_WEB_ROOT ?? 'apps/web/dist-runtime');
await mkdir(output, { recursive: true });
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Native PostgreSQL required');
const root = await mkdtemp(join(tmpdir(), 'xj-school-web-'));
const report = {
  kind: 'school-web-execution-path',
  ticket: '#170',
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  os: release(),
  node: process.version,
  root,
  browser: 'Google Chrome',
  cases: [],
  traffic: [],
  status: 'running',
  headless: false,
};
const runtime = openProductRuntime({ root, resources: {
  nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
  postgresVersion: '18.6', webRoot, windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1'),
} });
let browser;
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };
try {
  // School profile: this deployment IS the school host. No personal space, no device client.
  await runtime.install({ profile: 'school' });
  const status = await runtime.start();
  const endpoint = status.endpoint;
  report.endpoint = endpoint;
  report.environment = { profile: status.environment.profile, clientNamespace: status.environment.clientNamespace,
    services: status.environment.services.map(item => ({ unit: item.unit, serviceId: item.serviceId })) };
  assert.equal(status.environment.profile, 'school', 'the deployment must be the school host');

  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const api = async (route, body, headers = {}) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, 200, `API ${route} ${response.status}`); return response.json();
  };

  // School-shared member: no device target, so learning data stays on the school host.
  const published = await aggregationPackage();
  const definition = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
  await api('manage/course-import', {
    formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '学校网页执行验收' },
    task: { taskId, title: '学校入口浏览器计算', summary: '不装本机库，直接在学校网页上计算' },
    release: {
      releaseId, objectives: ['学校网页完成浏览器计算'], requirements: '在学校入口编辑表格并运行计算。',
      starterWorks: [], capabilities: [],
      components: [{ key: 'table', definition, configuration: { title: '表格聚合' }, materialIds: [] }],
      materials: [],
    },
    resources: [],
  }, admin);
  const password = randomUUID(), loginName = 'school-web-170';
  // Explicitly omit `target`: the member is school-shared, not bound to a student device.
  const member = await api('manage/members', { requestId: randomUUID(), loginName, password }, admin);
  assert.ok(member.principalId, 'school-shared member is created');
  assert.equal(member.target, undefined, 'the member must not carry a device target');
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin);
  passed('a school-shared member without a device target is enrolled on the school host');

  browser = await chromium.launch({ channel: 'chrome', headless: false });
  report.browserVersion = browser.version();
  // The "student device": only Chrome, no product install, no local database.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const login = await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  assert.equal(login.status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  assert.equal(created.status(), 200);
  const activity = await created.json();
  report.activityId = activity.activityId;

  const page = await context.newPage();
  page.on('pageerror', error => console.log('BROWSER ERROR ' + error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE ' + message.text().slice(0, 300)); });
  const posted = [];
  let phase = 'setup';
  const classify = request => {
    const url = request.url();
    if (!url.includes('/api/learning/executions/') || request.method() !== 'POST') return null;
    const path = new URL(url).pathname.split('/api/learning/executions/')[1].split('/');
    const kind = path[2] === 'report' ? 'report' : path[2] === 'result' ? 'result' : 'accept';
    const body = request.postDataJSON?.() ?? {};
    return { kind, requestId: body.action?.requestId ?? body.requestId ?? path[1] ?? null };
  };
  page.on('request', request => {
    const kind = classify(request);
    if (!kind) return;
    report.traffic.push({ phase, ...kind, event: 'attempt' });
    const body = request.postDataJSON?.();
    if (body?.action?.requestId && body?.acceptance?.execution) {
      posted.push({ requestId: body.action.requestId, executionRef: body.acceptance.execution.executionRef });
    }
  });
  page.on('response', response => {
    const kind = classify(response.request());
    if (!kind) return;
    report.traffic.push({ phase, ...kind, event: response.ok() ? 'ok' : 'error' });
  });

  // The school web entry itself.
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  const contextBody = await context.request.get(endpoint + '/api/learning/context');
  assert.equal(contextBody.status(), 200);
  const contextJson = await contextBody.json();
  assert.equal(contextJson.profile, 'school', 'the page context must be the school profile');
  assert.ok(!contextJson.identities.some(item => item.key === 'personal'),
    'the school web path must not expose a personal device identity');
  report.context = contextJson;
  passed('the school web entry loads for a browser with no local product or database');

  await expect(page.locator('#activity-title')).toHaveText('学校入口浏览器计算');
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  const frame = page.frameLocator('iframe[title="表格聚合"]');
  await expect(frame.getByRole('heading', { name: '表格聚合', exact: true })).toBeVisible();
  await expect(frame.getByRole('textbox', { name: '得分 第1行', exact: true })).toHaveValue('88');
  passed('the component view renders inside the school web workspace');

  // A real negative: the restricted algorithm names the bad row instead of inventing a zero.
  const broken = frame.getByRole('textbox', { name: '得分 第2行', exact: true });
  await broken.fill('九十');
  await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  await expect(frame.locator('#error')).toContainText('第 2 行', { timeout: 20000 });
  await broken.fill('92');

  // One real run through the dedicated worker; facts are posted to the school owner.
  phase = 'school-run';
  await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  await expect(frame.locator('#summary')).toContainText('共 12 行、3 组', { timeout: 30000 });
  await expect(frame.locator('#groups')).toContainText('332');
  const panel = page.getByRole('region', { name: '计算记录' });
  await expect(panel).toContainText('已完成', { timeout: 20000 });
  await expect(panel).toContainText('该次输入共 12 行');
  passed('the restricted Worker/WASM algorithm computes inside the school web page');

  const schoolRead = async requestId => {
    const response = await context.request.get(endpoint + '/api/learning/executions/' + activity.activityId + '/' + requestId);
    return response.ok() ? response.json() : null;
  };
  await expect.poll(async () => {
    for (const sent of posted) {
      const value = await schoolRead(sent.requestId);
      if (value?.state === 'succeeded') return value;
    }
    return null;
  }, { timeout: 20000 }).toBeTruthy();
  const succeeded = [];
  for (const sent of posted) {
    const value = await schoolRead(sent.requestId);
    if (value?.state === 'succeeded') succeeded.push({ sent, value });
  }
  assert.equal(succeeded.length, 1, `exactly one succeeded run expected, got ${succeeded.length}`);
  const remote = succeeded[0].value;
  assert.equal(remote.state, 'succeeded');
  assert.ok(remote.output?.contentId, 'the school owner kept the result reference');
  assert.equal(remote.executionRef, succeeded[0].sent.executionRef, 'the school record names the browser acceptance');
  const acceptCount = report.traffic.filter(item => item.phase === 'school-run' && item.kind === 'accept' && item.event === 'ok').length;
  const reportCount = report.traffic.filter(item => item.phase === 'school-run' && item.kind === 'report' && item.event === 'ok').length;
  const resultCount = report.traffic.filter(item => item.phase === 'school-run' && item.kind === 'result' && item.event === 'ok').length;
  report.schoolTraffic = { acceptCount, reportCount, resultCount, remote: { state: remote.state, contentId: remote.output?.contentId } };
  assert.ok(acceptCount >= 1 && reportCount >= 1 && resultCount >= 1,
    `school owner must receive accept/report/result, got ${acceptCount}/${reportCount}/${resultCount}`);
  passed('execution accept, facts and result are readable from the school learning-data owner');

  // Reload is the page's own re-read: the school keeps the same single result.
  await page.reload();
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  await expect(page.getByRole('region', { name: '计算记录' })).toContainText('已完成', { timeout: 20000 });
  const again = await schoolRead(succeeded[0].sent.requestId);
  assert.equal(again.output.contentId, remote.output.contentId, 'the school keeps one result');
  passed('a reload re-queries the school owner instead of recomputing');

  await page.screenshot({ path: join(output, 'execution-school-web-light.png'), fullPage: true });
  report.screenshots = { light: join(output, 'execution-school-web-light.png') };
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(output, 'execution-school-web-dark.png'), fullPage: true });
  report.screenshots.dark = join(output, 'execution-school-web-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  passed('school web execution screenshots captured from the real run');

  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error?.message ?? String(error);
  console.error('FAIL', report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'execution-school-web.json'), JSON.stringify(report, null, 2) + '\n').catch(() => {});
  await writeFile('/tmp/xj-school-web.json', JSON.stringify(report, null, 2) + '\n').catch(() => {});
  await browser?.close().catch(() => {});
  await runtime.stop().catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify({ status: report.status, cases: report.cases, schoolTraffic: report.schoolTraffic, error: report.error ?? null }));
}
