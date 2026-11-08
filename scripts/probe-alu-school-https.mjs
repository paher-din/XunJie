import { probeEvidenceDirectory, writeEvidence, captureEvidence, mkdtemp } from './lib/probe-evidence.mjs';
// Windows standalone-school HTTPS acceptance for #192.
//
// The platform path the Windows delivery did not cover: a school-profile deployment listens on a
// non-loopback address over strict TLS, and a desktop Chrome with no product install and no local
// database opens that school entry, prepares the fixed ALU runtime and runs a real Worker experiment.
// The certificate is pinned by public-key hash instead of disabling verification, and this Node
// process trusts the disposable probe CA through NODE_EXTRA_CA_CERTS only.
//
// This is still one machine. It is evidence for the Windows HTTPS school entry, not for a
// cross-machine school deployment and not for teaching effect.
import assert from 'node:assert/strict';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime';
import { aluPackage, aluCoursePackage } from '../components/alu-experiment/package.mjs';

const output = probeEvidenceDirectory(process.env.XUNJIE_ALU_SCHOOL_OUTPUT);
await mkdir(output, { recursive: true });
const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN;
if (!postgresBin) throw new Error('Native PostgreSQL required (set XUNJIE_PRODUCT_POSTGRES_BIN).');
const certificateFile = process.env.XUNJIE_ALU_SCHOOL_CERT;
const keyFile = process.env.XUNJIE_ALU_SCHOOL_KEY;
const publicIp = process.env.XUNJIE_ALU_SCHOOL_IP;
if (!certificateFile || !keyFile || !publicIp)
  throw new Error('Set XUNJIE_ALU_SCHOOL_CERT, XUNJIE_ALU_SCHOOL_KEY and XUNJIE_ALU_SCHOOL_IP.');
/**
 * Pin the exact key from the certificate itself. Computing it here keeps the pin equal to what the
 * listener really serves, and avoids passing base64 through shells that rewrite a leading slash.
 */
const spki = createHash('sha256').update(new X509Certificate(await readFile(resolve(certificateFile))).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');

const root = await mkdtemp(join(tmpdir(), 'xj-alu-school-'));
const report = { kind: 'alu-school-https', ticket: '#192', platform: process.platform, arch: process.arch,
  node: process.version, root, publicIp, certificatePin: 'spki-sha256', cases: [], traffic: [], refused: [], status: 'running' };
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };
const freePort = () => new Promise((accept, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '0.0.0.0', () => { const { port } = server.address(); server.close(() => accept(port)); });
});
const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
  postgresVersion: '18.6', webRoot: resolve('apps/web/dist-runtime'), windowsPrerequisitePath: resolve('scripts/windows-prereq-prepare.ps1') } });
let browser;
try {
  const port = await freePort(), endpoint = `https://${publicIp}:${port}`;
  report.endpoint = endpoint;
  await runtime.install({ profile: 'school', database: { mode: 'managed' }, host: '0.0.0.0', port,
    publicEndpoint: endpoint, tls: { certificateFile: resolve(certificateFile), keyFile: resolve(keyFile) } });
  const started = await runtime.start();
  assert.equal(started.state, 'ready');
  assert.equal(started.environment.profile, 'school');
  passed('a Windows school deployment listens on a non-loopback address over TLS');

  // The listener is really TLS and really verified: this Node client trusts only the probe CA.
  const contextBody = await fetch(endpoint + '/api/learning/context');
  assert.equal(contextBody.status, 200);
  const context = await contextBody.json();
  assert.equal(context.profile, 'school', 'the served context is the school profile');
  assert.ok(!context.identities.some(item => item.key === 'personal'), 'the school entry exposes no personal device identity');
  report.context = context;
  passed('strict TLS is verified against the probe CA and the entry answers as the school profile');
} catch (error) {
  report.status = 'failed'; report.error = String(error?.stack ?? error);
  await writeEvidence(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, cases: report.cases, error: report.error }));
  throw error;
}

try {
  const { endpoint } = report;
  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const api = async (route, body) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', ...admin }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`);
    return value;
  };
  const component = await aluPackage(), course = await aluCoursePackage();
  const definition = await api('manage/component-import', component);
  course.release.components[0].definition = definition;
  await api('manage/course-import', course);
  passed('the fixed ALU component and course import through the school owner');

  // A school-shared member: no device target, so the work and its facts stay on the school host.
  const password = randomUUID(), loginName = 'alu-school-https';
  const member = await api('manage/members', { requestId: randomUUID(), loginName, password });
  assert.equal(member.target, undefined, 'the member must not carry a device target');
  await api('manage/course-access', { requestId: randomUUID(), courseId: course.course.courseId,
    principalId: member.principalId, active: true });

  // --ignore-certificate-errors-spki-list pins exactly this key; TLS verification stays on otherwise.
  browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: [`--ignore-certificate-errors-spki-list=${spki}`] });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
    ignoreHTTPSErrors: false });
  assert.equal((await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities',
    { data: { requestId: randomUUID(), releaseId: course.release.releaseId } });
  assert.equal(created.status(), 200);
  const activity = await created.json();
  report.activityId = activity.activityId;

  const page = await context.newPage();
  page.on('pageerror', error => console.log('PAGE ERROR ' + error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const from = message.location().url;
    console.log('BROWSER ' + message.text().slice(0, 300) + (from ? ' @ ' + from : ''));
    report.consoleErrors = [...(report.consoleErrors ?? []), { text: message.text().slice(0, 300), url: from }];
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/learning/executions/')) report.traffic.push({ path: url.pathname, status: response.status() });
    // Record every refused request so "no 404 mattered" is checked, not assumed.
    if (response.status() >= 400) report.refused.push({ path: url.pathname, status: response.status() });
  });
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId);
  await expect(page.locator('#activity-title')).toHaveText(course.task.title);
  passed('a Chrome with no local product opens the school entry over pinned HTTPS');

  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await expect(page.getByRole('button', { name: '运行', exact: true })).toBeEnabled({ timeout: 180000 });
  await expect(page.getByRole('button', { name: 'alu.sv', exact: true }).or(page.getByRole('tab', { name: 'alu.sv', exact: true })).first()).toBeVisible();
  passed('the fixed runtime resources are authorized, verified and self-checked from the school entry');

  await page.getByRole('button', { name: '运行', exact: true }).click();
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  await expect(page.getByText('输出包含 X/Z', { exact: false })).toBeVisible({ timeout: 90000 });

  const correct = "// 学校入口中文编辑内容随作品保护\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); always_comb begin F=0; Cout=0; if(M) begin if(S==0) {Cout,F}={1'b0,A}+{1'b0,B}+Cin; end else case(S) 0:F=~A; 1:F=A&B; 2:F=A|B; 3:F=A^B; endcase end endmodule";
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
  await captureEvidence(page, { path: join(output, 'school-https-run.png') });
  passed('a real Worker run over the school HTTPS entry produces a real carry observation');

  // The school owner, not a device-local database, holds the accepted fact and the retained VCD.
  await expect.poll(async () => {
    const history = await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`);
    if (!history.ok()) return false;
    const value = await history.json();
    return value.entries.some(entry => entry.query.state === 'succeeded' && entry.query.output?.output?.cout === '1');
  }, { timeout: 60000 }).toBe(true);
  const history = await (await context.request.get(`${endpoint}/api/learning/executions/${activity.activityId}/history`)).json();
  const last = history.entries.find(entry => entry.query.output?.output?.cout === '1');
  assert.ok(last.action.execution.basis.works.some(file => file.value.includes('学校入口中文编辑内容随作品保护')));
  const artifact = await (await context.request.get(
    `${endpoint}/api/learning/executions/${activity.activityId}/${last.query.requestId}/artifact`)).json();
  assert.ok(artifact.resources.some(resource => resource.name === 'trace.vcd' && resource.text.includes('$enddefinitions')));
  passed('the school owner keeps the fixed basis, Chinese source and the original VCD');

  // Nothing the page loaded came from a loopback or a device-local listener. Non-network schemes
  // (blob:/data:) are the verified runtime bytes the Worker consumes; they have no host by design.
  const parsed = requests.map(url => new URL(url));
  const hosts = [...new Set(parsed.filter(item => item.protocol.startsWith('http')).map(item => item.host))];
  assert.deepEqual(hosts, [new URL(endpoint).host], `the page must reach only the school origin, saw ${hosts.join(', ')}`);
  report.pageHosts = hosts;
  report.pageSchemes = [...new Set(parsed.map(item => item.protocol))].sort();
  assert.deepEqual(report.refused, [], `refused requests must be none, saw ${JSON.stringify(report.refused)}`);
  assert.ok(report.pageSchemes.every(scheme => ['https:', 'blob:', 'data:'].includes(scheme)),
    `unexpected network scheme, saw ${report.pageSchemes.join(', ')}`);
  passed('the school page reached no loopback or device-local service');

  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error?.stack ?? error);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await runtime.stop().catch(() => undefined);
  await writeEvidence(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error ?? null }));
}
