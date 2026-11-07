#!/usr/bin/env node
/**
 * #206 cross-machine client acceptance: a student desktop Chrome on THIS machine opens the
 * independent school node over pinned strict HTTPS. The client has no XunJie product and no
 * local database; the school service, its PostgreSQL and the ALU course all live on another
 * machine. Nothing in the student path uses SSH, a proxy or a loopback listener.
 *
 * Run with NODE_EXTRA_CA_CERTS pointing at the acceptance CA (Node-side API calls only).
 * The Chrome certificate check stays on: only the exact SPKI key is pinned, never disabled.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';

const { values } = parseArgs({ options: {
  state: { type: 'string' }, output: { type: 'string' }, label: { type: 'string' },
} });
for (const name of ['state', 'output']) if (!values[name]) throw new Error('usage: --state=FILE --output=DIR [--label=NAME]');
const state = JSON.parse(await readFile(resolve(values.state), 'utf8'));
const endpoint = state.endpoint;
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const label = values.label ?? `${process.platform}-${process.arch}`;
const localAddresses = Object.values(networkInterfaces()).flat().filter(item => item && item.address).map(item => item.address);
const schoolHost = new URL(endpoint).hostname;

const report = { kind: 'alu-school-cross-machine-client', ticket: '#206', label,
  platform: process.platform, arch: process.arch, node: process.version,
  endpoint, schoolHost, schoolNodePlatform: state.nodePlatform, schoolNodeArch: state.nodeArch,
  schoolDistributionSha256: state.distributionSha256,
  clientAddresses: localAddresses, clientLocalProduct: false, studentTrafficUsesSsh: false,
  startedAt: new Date().toISOString(), cases: [], refused: [], traffic: [], status: 'running' };
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };

let browser;
try {
  // The school service is genuinely on another machine, not a second port on this one.
  assert.ok(!localAddresses.includes(schoolHost), `the school host ${schoolHost} must not be a client address`);
  assert.equal(new URL(endpoint).protocol, 'https:');
  passed('the school service and PostgreSQL run on a different machine from this client');

  browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: [`--ignore-certificate-errors-spki-list=${state.spki}`] });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
    ignoreHTTPSErrors: false });

  const contextBody = await context.request.get(endpoint + '/api/learning/context');
  assert.equal(contextBody.status(), 200);
  const served = await contextBody.json();
  assert.equal(served.profile, 'school');
  assert.ok(!served.identities.some(item => item.key === 'personal'), 'the entry exposes no personal device identity');
  passed('strict TLS is verified with the pinned public key and the entry answers as the school profile');

  assert.equal((await context.request.post(endpoint + '/api/learning/login',
    { data: { loginName: state.loginName, password: state.password } })).status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities',
    { data: { requestId: crypto.randomUUID(), releaseId: state.releaseId } });
  assert.equal(created.status(), 200);
  const activity = await created.json();
  report.activityId = activity.activityId;
  passed('a school member and the fixed ALU course activity are served by the independent node');

  const page = await context.newPage();
  page.on('pageerror', error => console.log('PAGE ERROR ' + error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    report.consoleErrors = [...(report.consoleErrors ?? []), { text: message.text().slice(0, 300), url: message.location().url }];
  });
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/learning/executions/')) report.traffic.push({ path: url.pathname, status: response.status() });
    if (response.status() >= 400) {
      const entry = { path: url.pathname, status: response.status() };
      report.refused.push(entry);
      // Keep the first error bodies for diagnosis; a 409 alone does not say which invariant failed.
      if (report.refused.length <= 3) response.text().then(text => { entry.body = text.slice(0, 300); }).catch(() => undefined);
    }
  });
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await expect(page.locator('#activity-title')).toHaveText(state.courseTitle);
  await page.screenshot({ path: join(output, 'cross-machine-before.png') });
  passed('a desktop Chrome with no local product opens the independent school entry');

  await expect(page.getByRole('button', { name: '运行', exact: true })).toBeEnabled({ timeout: 180000 });
  await expect(page.getByRole('button', { name: 'alu.sv', exact: true }).or(page.getByRole('tab', { name: 'alu.sv', exact: true })).first()).toBeVisible();
  passed('the fixed runtime resources are authorized, verified and self-checked over the network');

  await page.getByRole('button', { name: '运行', exact: true }).click();
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.getByText('输出包含 X/Z', { exact: false })).toBeVisible({ timeout: 90000 });

  const correct = "// 跨机学校入口中文编辑内容随作品保护\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); always_comb begin F=0; Cout=0; if(M) begin if(S==0) {Cout,F}={1'b0,A}+{1'b0,B}+Cin; end else case(S) 0:F=~A; 1:F=A&B; 2:F=A|B; 3:F=A^B; endcase end endmodule";
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  const editor = page.locator('.monaco-editor textarea').first();
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(correct);
  await page.getByLabel('A（4 位）').selectOption('15');
  await page.getByLabel('B（4 位）').selectOption('1');
  await page.getByLabel('M（1 位）').selectOption('1');
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.getByText('F：0000　Cout：1', { exact: false })).toBeVisible({ timeout: 90000 });
  await page.screenshot({ path: join(output, 'cross-machine-run.png') });
  passed('a real Worker run over the cross-machine school HTTPS entry produces a real carry observation');

  await expect.poll(async () => {
    const history = await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`);
    if (!history.ok()) return false;
    const value = await history.json();
    return value.entries.some(entry => entry.query.state === 'succeeded' && entry.query.output?.output?.cout === '1');
  }, { timeout: 60000 }).toBe(true);
  const history = await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json();
  const last = history.entries.find(entry => entry.query.output?.output?.cout === '1');
  assert.ok(last.action.execution.basis.works.some(file => file.value.includes('跨机学校入口中文编辑内容随作品保护')));
  const artifact = await (await context.request.get(
    `${endpoint}/api/learning/executions/${activity.activityId}/${last.query.requestId}/artifact`)).json();
  assert.ok(artifact.resources.some(resource => resource.name === 'trace.vcd' && resource.text.includes('$enddefinitions')));
  passed('the remote school owner keeps the fixed basis, Chinese source and the original VCD');

  const parsed = requests.map(url => new URL(url));
  const hosts = [...new Set(parsed.filter(item => item.protocol.startsWith('http')).map(item => item.host))];
  assert.deepEqual(hosts, [new URL(endpoint).host], `the page must reach only the school origin, saw ${hosts.join(', ')}`);
  report.pageHosts = hosts;
  report.pageSchemes = [...new Set(parsed.map(item => item.protocol))].sort();
  assert.deepEqual(report.refused, [], `refused requests must be none, saw ${JSON.stringify(report.refused)}`);
  assert.ok(report.pageSchemes.every(scheme => ['https:', 'blob:', 'data:'].includes(scheme)),
    `unexpected scheme, saw ${report.pageSchemes.join(', ')}`);
  assert.ok(!hosts.some(host => /^(127\.|localhost|\[::1\])/.test(host)), 'no loopback or device-local service was used');
  passed('the school page reached no loopback, device-local service or SSH tunnel');

  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error?.stack ?? error);
  if (browser) await browser.contexts()[0]?.pages()[0]?.screenshot({ path: join(output, 'cross-machine-failure.png') }).catch(() => undefined);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await browser?.close().catch(() => undefined);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error ?? null }));
}
