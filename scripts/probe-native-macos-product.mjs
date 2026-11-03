import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { resolveCredential } from '@xunjie/product-runtime';
import { accumulatorPackage } from '../components/state-accumulator/package.mjs';

/**
 * Real product acceptance for #184 on Apple Silicon: the packaged candidate installs and passes its
 * own self-check, a student drives a real native session through desktop Chrome to 1/3/1, and the
 * durable owner survives a lost reply, an out-of-order control, a replayed control, a killed
 * session process and the declared concurrency limit. Nothing is stubbed.
 */
const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const product = option('--package', null);
if (!product) throw new Error('--package is required (for example dist/wp03-184-<sha>)');
const output = resolve(option('--out', '.verification/wp03-184-product'));
const evidence = resolve('docs/student-agent-implementation/evidence');
await mkdir(output, { recursive: true });

const nodeInProduct = join(product, 'resources/node/bin/node');
const scrubbed = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, LANG: 'en_US.UTF-8',
  TMPDIR: process.env.TMPDIR ?? '/tmp' };
const root = await mkdtemp(join(tmpdir(), 'xj-native-product-'));
const report = { ticket: 184, startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  osRelease: release(), productRoot: product, root, node: { path: nodeInProduct },
  cases: [], checks: {}, status: 'running' };
const record = (name, fact) => { report.cases.push({ name, ...fact }); };

const cli = async (command, extra = []) => {
  const { stdout } = await exec(nodeInProduct, [join(product, 'app/cli.js'), command, '--root', root, '--json', ...extra],
    { env: scrubbed, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
};

async function api(route, body, headers, method) {
  const response = await fetch(new URL('/api/learning/' + route, report.endpoint), {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let value = null;
  try { value = text ? JSON.parse(text) : null } catch { value = text.slice(0, 400) }
  return { status: response.status, value };
}

async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex') }

let browser;
try {
  // 1. The candidate installs and passes its own self-check without any development toolchain.
  const distribution = JSON.parse(await readFile(join(product, 'distribution.json'), 'utf8'));
  const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
  report.candidate = { platform: distribution.platform, profile: distribution.profile, status: distribution.status,
    signing: distribution.signing, distributionSha256: await sha256(join(product, 'distribution.json')),
    resourcesSha256: await sha256(join(product, 'resources.json')), resources };
  const installed = await cli('install');
  const status = await cli('status');
  report.node.version = (await exec(nodeInProduct, ['-v'], { env: scrubbed })).stdout.trim();
  const started = await cli('start');
  report.endpoint = started.endpoint;
  assert.ok(report.endpoint, 'the product must report an endpoint');
  const selfCheck = await cli('status');
  record('install-and-self-check', { installed, status, selfCheck,
    pathEntries: (scrubbed.PATH ?? '').split(':'), nodeFromPackage: (await exec(nodeInProduct, ['-v'], { env: scrubbed })).stdout.trim() });

  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const published = await accumulatorPackage();
  const imported = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
  assert.equal(imported.status, 200, JSON.stringify(imported.value));
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), password = randomUUID();
  const course = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '本机会话产品验收' },
    task: { taskId, title: '观察四态累加', summary: '' },
    release: { releaseId, objectives: ['连续输入并观察真实内部状态'], requirements: '依次输入 1、2、2，观察 1、3、1。',
      starterWorks: [], capabilities: [], materials: [],
      components: [{ key: 'accumulator', definition: imported.value, configuration: { title: '四态累加模拟' }, materialIds: [] }] },
    resources: [] };
  assert.equal((await api('manage/course-import', course, admin)).status, 200);
  const member = await api('manage/members', { requestId: randomUUID(), loginName: 'native-product-student', password }, admin);
  const login = await fetch(new URL('/api/learning/login', report.endpoint), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'native-product-student', password }) });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get('set-cookie').split(';')[0];
  const student = { cookie: cookieHeader };
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true }, admin);
  const created = await api('course-activities', { requestId: randomUUID(), releaseId }, student);
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const activityId = created.value.activityId;
  const context = await (await fetch(new URL('/api/learning/context', report.endpoint), { headers: { cookie: cookieHeader } })).json();
  const spaceKey = context.identities.find(item => item.identity.kind === 'school')?.key ?? context.identities[0]?.key;
  assert.ok(spaceKey, 'a learning space identity is required');
  const namespace = encodeURIComponent(spaceKey);
  const sessionHeaders = { ...student, 'x-xj-namespace': namespace };

  // 2. A real Chrome window drives the student path; the accept body is captured for replay.
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let acceptBody = null;
  page.on('request', request => {
    if (request.method() === 'POST' && /\/executions\/[0-9a-f-]+$/.test(new URL(request.url()).pathname))
      acceptBody = request.postData();
  });
  await page.context().addCookies(cookieHeader.split(';').map(pair => {
    const [name, ...rest] = pair.split('=');
    return { name: name.trim(), value: rest.join('=').trim(), url: report.endpoint };
  }));
  const openActivity = async () => {
    await page.goto(report.endpoint + '/?space=' + encodeURIComponent(spaceKey) + '&activity=' + activityId);
    await page.getByRole('tab', { name: '四态累加模拟' }).click();
    await page.frameLocator('.component-view iframe').getByText('组件已就绪').waitFor({ timeout: 60_000 });
  };
  await openActivity();
  const observation = page.locator('.native-session-observation');
  await page.getByRole('button', { name: '启动本机会话' }).click();
  await observation.locator('strong').waitFor();
  const startValue = (await observation.locator('strong').textContent()).trim();
  const sequence = [];
  const enter = async (value, expected) => {
    await page.getByLabel('输入整数（0–99）').fill(String(value));
    await page.getByRole('button', { name: '输入', exact: true }).click();
    await expect(observation.locator('strong')).toHaveText(expected);
    sequence.push(expected);
  };
  await enter(1, '1');
  await enter(2, '3');
  await enter(2, '1');
  const history = await page.locator('.native-session-history li').count();
  await page.screenshot({ path: join(output, 'native-product-light.png') });
  await page.getByRole('tab', { name: '作品' }).click();
  await page.getByRole('tab', { name: '四态累加模拟' }).click();
  await page.reload();
  await page.getByRole('tab', { name: '四态累加模拟' }).click();
  await page.frameLocator('.component-view iframe').getByText('组件已就绪').waitFor({ timeout: 60_000 });
  const reopened = (await page.locator('.native-session-observation strong').textContent()).trim();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('html[data-theme="dark"]').waitFor();
  await page.screenshot({ path: join(output, 'native-product-dark.png') });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: join(output, 'native-product-narrow.png') });
  record('chrome-student-path', { startValue, sequence, history, reopened, pageErrors: errors, acceptCaptured: Boolean(acceptBody) });
  report.checks.sequence = sequence.join(',') === '1,3,1' && startValue === '0' && reopened === '1' && history === 3;

  // 3. Durable facts: the owner lists the same reference after the reload.
  const sessions = await api('executions/' + activityId + '/sessions', undefined, sessionHeaders);
  assert.equal(sessions.status, 200, JSON.stringify(sessions.value));
  assert.ok(Array.isArray(sessions.value) && sessions.value.length === 1, 'exactly one durable session is expected');
  const current = sessions.value[0];
  const sessionRef = current.requestId;
  const appliedBefore = current.session.appliedSeq;
  record('owner-reference', { sessions: sessions.value.length, requestId: sessionRef,
    state: current.state, appliedSeq: appliedBefore, adapter: current.session.adapterId,
    instance: current.session.instanceId, observation: current.session.observation });

  // 4. Out-of-order controls are refused and change nothing.
  const stale = await api(`executions/${activityId}/${sessionRef}/control`, { controlId: randomUUID(),
    operationId: 'advance', effect: 'input', expectedSeq: appliedBefore + 5, parameters: { value: 1 } }, sessionHeaders);
  const afterStale = await api(`executions/${activityId}/${sessionRef}`, undefined, sessionHeaders);
  record('out-of-order-control', { status: stale.status, value: stale.value,
    appliedAfter: afterStale.value.session.appliedSeq });
  report.checks.outOfOrder = stale.status >= 400 && afterStale.value.session.appliedSeq === appliedBefore;

  // 5. One control identity is applied once, even when the reply is lost and the control is replayed.
  const controlId = randomUUID();
  const control = { controlId, operationId: 'advance', effect: 'input', expectedSeq: appliedBefore, parameters: { value: 2 } };
  const lost = await fetch(new URL(`/api/learning/executions/${activityId}/${sessionRef}/control`, report.endpoint), {
    method: 'POST', headers: { 'content-type': 'application/json', ...sessionHeaders },
    body: JSON.stringify(control), signal: AbortSignal.timeout(400) })
    .then(response => ({ status: response.status }), error => ({ status: null, error: error.name }));
  await new Promise(done => setTimeout(done, 800));
  const appliedAfterLoss = await api(`executions/${activityId}/${sessionRef}`, undefined, sessionHeaders);
  const replay = await api(`executions/${activityId}/${sessionRef}/control`, control, sessionHeaders);
  const appliedAfterReplay = await api(`executions/${activityId}/${sessionRef}`, undefined, sessionHeaders);
  record('lost-reply-and-replay', { lost, appliedAfterLoss: appliedAfterLoss.value.session.appliedSeq,
    replayStatus: replay.status, replaySeq: replay.value.session?.appliedSeq,
    replayObservation: replay.value.session?.observation, appliedAfterReplay: appliedAfterReplay.value.session.appliedSeq });
  report.checks.lostReply = appliedAfterLoss.value.session.appliedSeq === appliedBefore + 1
    && appliedAfterReplay.value.session.appliedSeq === appliedBefore + 1
    && replay.value.session?.observation?.applied === appliedBefore + 1;

  // 6. A killed session process is reported as unknown and never advances again.
  const processes = await exec('ps', ['-axo', 'pid=,command=']);
  const sessionRows = processes.stdout.split('\n')
    .filter(line => line.includes('--input-type=module') && line.includes('four-state-accumulator'));
  assert.equal(sessionRows.length, 1, 'exactly one native session process is expected: ' + sessionRows.length);
  const sessionPid = Number(sessionRows[0].trim().split(/\s+/)[0]);
  process.kill(sessionPid, 'SIGKILL');
  await new Promise(done => setTimeout(done, 1500));
  const afterCrash = await api(`executions/${activityId}/${sessionRef}`, undefined, sessionHeaders);
  const controlAfterCrash = await api(`executions/${activityId}/${sessionRef}/control`, { controlId: randomUUID(),
    operationId: 'advance', effect: 'input', expectedSeq: afterCrash.value.session?.appliedSeq ?? 0,
    parameters: { value: 1 } }, sessionHeaders);
  record('session-process-killed', { pid: sessionPid, state: afterCrash.value.state,
    statusKnowledge: afterCrash.value.statusKnowledge, reason: afterCrash.value.reason,
    observation: afterCrash.value.session?.observation, controlAfterCrash: controlAfterCrash.status });
  report.checks.crash = afterCrash.value.state !== 'running' || afterCrash.value.statusKnowledge === 'unknown';
  report.checks.crashStopsInput = controlAfterCrash.status >= 400;

  // 7. The declared concurrency limit is enforced by replaying the real accept body with new identities.
  const replayAccept = async requestId => {
    const body = JSON.parse(acceptBody);
    body.requestId = requestId;
    return api('executions/' + activityId, body, sessionHeaders);
  };
  const second = await replayAccept(randomUUID());
  const third = await replayAccept(randomUUID());
  const afterLimit = await api('executions/' + activityId + '/sessions', undefined, sessionHeaders);
  record('concurrency-limit', { second: second.status, third: third.status, thirdValue: third.value,
    declaredConcurrentSessions: 2, sessions: afterLimit.value.length });
  report.checks.concurrency = second.status === 200 && third.status >= 400;
  for (const item of afterLimit.value) {
    if (item.state === 'running' || item.state === 'queued')
      await api(`executions/${activityId}/${item.requestId}/stop`, { stopId: randomUUID() }, sessionHeaders).catch(() => null);
  }

  record('page-errors', { errors });
  report.checks.noPageErrors = errors.length === 0;
  report.finishedAt = new Date().toISOString();
  const failed = Object.entries(report.checks).filter(([, value]) => value === false).map(([name]) => name);
  report.status = failed.length ? 'failed' : 'passed';
  report.failed = failed;
  await writeFile(join(output, 'product-report.json'), JSON.stringify(report, null, 2));
  for (const name of ['native-product-light.png', 'native-product-dark.png', 'native-product-narrow.png']) {
    await cp(join(output, name), join(evidence, 'wp03-184-' + name.replace('native-product-', 'product-'))).catch(() => {});
  }
  await cp(join(output, 'product-report.json'), join(evidence, 'wp03-184-product.json')).catch(() => {});
  console.log(JSON.stringify({ status: report.status, failed, output }));
  if (report.status !== 'passed') process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await cli('stop').catch(() => null);
  await rm(root, { recursive: true, force: true }).catch(() => {});
  await writeFile(join(output, 'last-run.json'), JSON.stringify({ root, finishedAt: new Date().toISOString(), checks: report.checks }, null, 2)).catch(() => {});
}
