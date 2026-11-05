import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join, resolve, basename } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { resolveCredential } from '../packages/product-runtime/dist/index.js';
import { accumulatorPackage } from '../components/state-accumulator/package.mjs';

/**
 * Real product acceptance for #184 on Apple Silicon: the packaged candidate installs and passes its
 * own self-check, a student drives a real native session through desktop Chrome to 1/3/1, and the
 * durable owner survives a lost reply, an out-of-order control, a replayed control, a stop, a killed
 * session process and the declared concurrency limit. Nothing is stubbed: the session runs the
 * candidate's own Node under the candidate's own seatbelt profile against its own PostgreSQL.
 */
const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const product = option('--package', null);
if (!product) throw new Error('--package is required (for example dist/product-darwin-arm64-wp03-r2)');
const output = resolve(option('--out', '.verification/wp03-184-product'));
const evidence = resolve('docs/student-agent-implementation/evidence');
await mkdir(output, { recursive: true });

const nodeInProduct = join(product, 'resources/node/bin/node');
const scrubbed = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, LANG: 'en_US.UTF-8',
  TMPDIR: process.env.TMPDIR ?? '/tmp' };
const root = await mkdtemp(join(tmpdir(), 'xj-native-product-'));
const report = { ticket: 184, startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  osRelease: release(), productRoot: resolve(product), root, node: { path: nodeInProduct },
  cases: [], checks: {}, status: 'running' };
const record = (name, fact) => { report.cases.push({ name, ...fact }); };

const cli = async (command, extra = []) => {
  const { stdout } = await exec(nodeInProduct, [join(product, 'app/cli.js'), command, '--root', root, '--json', ...extra],
    { env: scrubbed, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
};

let endpoint = '';
async function api(route, body, headers, method) {
  const response = await fetch(new URL('/api/learning/' + route, endpoint), {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let value = null;
  try { value = text ? JSON.parse(text) : null } catch { value = text.slice(0, 400) }
  return { status: response.status, value };
}

async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex') }

/** Process facts. sandbox-exec execs in place, so the session is the node row that owns its group. */
async function processTable() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,pgid=,command=']);
  return stdout.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [pid, ppid, pgid, ...command] = line.split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), command: command.join(' ') };
  });
}
const sessionProcesses = rows => rows.filter(row => row.command.includes('--input-type=module')
  && row.command.includes('four-state-accumulator') && /(?:^|\/)node$/.test(row.command.split(' ')[0] ?? ''));
const toolEnv = { PATH: '/usr/sbin:/sbin:/usr/bin:/bin' };
async function cwdOf(pid) {
  const { stdout } = await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { env: toolEnv });
  return stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) ?? null;
}
async function socketsOf(pid) {
  const result = await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-i', '-Fn'], { env: toolEnv })
    .then(value => value.stdout, error => error.code === 1 ? '' : Promise.reject(error));
  return result.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
}

let browser;
try {
  // 1. The candidate installs and passes its own self-check without any development toolchain.
  const distribution = JSON.parse(await readFile(join(product, 'distribution.json'), 'utf8'));
  const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
  report.candidate = { platform: distribution.platform, profile: distribution.profile, status: distribution.status,
    signing: distribution.signing, createdAt: distribution.createdAt,
    distributionSha256: await sha256(join(product, 'distribution.json')),
    resourcesSha256: await sha256(join(product, 'resources.json')),
    entries: distribution.entries ?? null, resources };
  const installed = await cli('install');
  const status = await cli('status');
  const nodeVersion = (await exec(nodeInProduct, ['-v'], { env: scrubbed })).stdout.trim();
  report.node.version = nodeVersion;
  const started = await cli('start');
  endpoint = started.endpoint;
  report.endpoint = endpoint;
  assert.ok(endpoint, 'the product must report an endpoint');
  const selfCheck = await cli('status');
  const scoped = await fetch(new URL('/api/learning/context', endpoint)).then(response => response.status, () => null);
  record('install-and-self-check', { installed, status, selfCheck, unauthenticatedContext: scoped,
    pathEntries: (scrubbed.PATH ?? '').split(':'), nodeFromPackage: nodeVersion,
    postgresVersion: resources.postgresVersion, webRoot: resources.webRoot });
  report.checks.install = ['installed', 'ready', 'degraded'].includes(String(installed.state))
    && ['ready', 'degraded'].includes(String(selfCheck.state)) && Boolean(endpoint);

  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` };
  const published = await accumulatorPackage();
  const imported = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin);
  assert.equal(imported.status, 200, JSON.stringify(imported.value));
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), password = randomUUID();
  const course = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '本机会话产品验收' },
    task: { taskId, title: '观察四态累加', summary: '' },
    release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['连续输入并观察真实内部状态'], requirements: '依次输入 1、2、2，观察 1、3、1。',
      starterWorks: [], capabilities: [], materials: [],
      components: [{ key: 'accumulator', definition: imported.value, configuration: { title: '四态累加模拟' }, materialIds: [] }] },
    resources: [] };
  assert.equal((await api('manage/course-import', course, admin)).status, 200);
  const member = await api('manage/members', { requestId: randomUUID(), loginName: 'native-product-student', password }, admin);
  const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'native-product-student', password }) });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get('set-cookie').split(';')[0];
  const student = { cookie: cookieHeader };
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true }, admin);
  const created = await api('course-activities', { requestId: randomUUID(), releaseId }, student);
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const activityId = created.value.activityId;
  const context = await (await fetch(new URL('/api/learning/context', endpoint), { headers: { cookie: cookieHeader } })).json();
  const chosen = context.identities.find(item => item.identity.kind === 'school') ?? context.identities[0];
  assert.ok(chosen, 'a learning space identity is required');
  const spaceKey = chosen.key;
  const subject = [chosen.identity.environmentId, chosen.identity.spaceId, chosen.identity.principalId].join('.');
  const sessionHeaders = { ...student, 'x-xj-space': spaceKey, 'x-xj-namespace': context.clientNamespace,
    'x-xj-expected-subject': subject };
  // A real lost reply: the request reaches the server, the client drops the socket on the first
  // response byte and therefore never learns the outcome it must reconcile.
  const sendAndDrop = (route, body) => new Promise((done, reject) => {
    const url = new URL(endpoint);
    const payload = Buffer.from(JSON.stringify(body));
    const head = [`POST /api/learning/${route} HTTP/1.1`, `Host: ${url.host}`, 'Content-Type: application/json',
      `Content-Length: ${payload.length}`, `Cookie: ${cookieHeader}`, `x-xj-space: ${spaceKey}`,
      `x-xj-namespace: ${context.clientNamespace}`, `x-xj-expected-subject: ${subject}`,
      'Connection: close', '', ''].join('\r\n');
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let received = 0;
    const finish = fact => { clearTimeout(timer); socket.destroy(); done(fact); };
    const timer = setTimeout(() => finish({ dropped: true, replyBytes: received, timedOut: true }), 5000);
    socket.once('connect', () => socket.write(Buffer.concat([Buffer.from(head, 'utf8'), payload])));
    socket.once('data', chunk => { received += chunk.length; finish({ dropped: true, replyBytes: received }); });
    socket.once('error', error => finish({ dropped: true, replyBytes: received, error: error.code }));
  });
  record('space-identity', { key: spaceKey, kind: chosen.identity.kind, clientNamespace: context.clientNamespace,
    identityCount: context.identities.length });

  // 2. A real desktop Chrome window drives the student path; the accept body is captured for replay.
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const browserVersion = browser.version();
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
    return { name: name.trim(), value: rest.join('=').trim(), url: endpoint };
  }));
  const openActivity = async () => {
    await page.goto(endpoint + '/?space=' + encodeURIComponent(spaceKey) + '&activity=' + activityId);
    await expect(page.locator('#activity-title')).toHaveText('观察四态累加');
    await page.getByRole('tab', { name: '四态累加模拟' }).click();
    await expect(page.frameLocator('.component-view iframe').getByText('组件已就绪')).toBeVisible({ timeout: 60_000 });
  };
  await openActivity();
  const observation = page.locator('.native-session-observation');
  await page.getByRole('button', { name: '启动本机会话' }).click();
  await expect(observation.locator('strong')).toHaveText('0');
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
  await expect(page.frameLocator('.component-view iframe').getByText('组件已就绪')).toBeVisible({ timeout: 60_000 });
  const reopened = (await page.locator('.native-session-observation strong').textContent()).trim();
  const reopenedHistory = await page.locator('.native-session-history li').count();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: join(output, 'native-product-dark.png') });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: join(output, 'native-product-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  record('chrome-student-path', { browser: 'installed desktop Chrome', browserVersion, startValue, sequence, history,
    reopened, reopenedHistory, pageErrors: errors, acceptCaptured: Boolean(acceptBody) });
  report.checks.sequence = sequence.join(',') === '1,3,1' && startValue === '0';
  report.checks.reopen = reopened === '1' && reopenedHistory === 3;

  // 3. Durable facts: the owner lists the same reference, and the product really runs it in a sandbox.
  const sessions = await api('executions/' + activityId + '/sessions', undefined, sessionHeaders);
  assert.equal(sessions.status, 200, JSON.stringify(sessions.value));
  assert.ok(Array.isArray(sessions.value) && sessions.value.length === 1, 'exactly one durable session is expected');
  const sessionRef = sessions.value[0].requestId;
  const appliedBefore = sessions.value[0].session.appliedSeq;
  const rows = await processTable();
  const sessionsSeen = sessionProcesses(rows);
  assert.equal(sessionsSeen.length, 1, 'exactly one native session process is expected: ' + sessionsSeen.length);
  const sessionProcess = sessionsSeen[0];
  const sessionDirectory = await cwdOf(sessionProcess.pid);
  assert.ok(sessionDirectory, 'the session process must expose its measured working directory');
  const profilePath = join(sessionDirectory, 'session.sb');
  const profileText = await readFile(profilePath, 'utf8');
  const isolation = { nodePid: sessionProcess.pid, parentPid: sessionProcess.ppid,
    pgid: sessionProcess.pgid, ownProcessGroup: sessionProcess.pgid === sessionProcess.pid,
    sessionDirectory, measuredFromCwd: /(?:^|\/)session-[A-Za-z0-9]{6,}\/?$/.test(sessionDirectory),
    profile: { path: profilePath, sha256: await sha256(profilePath), bytes: profileText.length,
      deniesByDefault: /\(deny default\)/.test(profileText), deniesNetwork: /\(deny network\*\)/.test(profileText),
      allowsThisSessionWrites: profileText.includes(basename(sessionDirectory)) },
    openNetworkSockets: await socketsOf(sessionProcess.pid) };
  record('owner-reference', { sessions: sessions.value.length, requestId: sessionRef, state: sessions.value[0].state,
    appliedSeq: appliedBefore, adapter: sessions.value[0].session.adapterId, instance: sessions.value[0].session.instanceId,
    observation: sessions.value[0].session.observation, isolation });
  // A running darwin session only exists through the seatbelt branch: the profile is on disk, the
  // process owns its own group, and it holds no network socket at all.
  report.checks.isolation = isolation.ownProcessGroup && isolation.measuredFromCwd
    && isolation.profile.deniesByDefault && isolation.profile.deniesNetwork
    && isolation.profile.allowsThisSessionWrites && isolation.openNetworkSockets.length === 0;

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
  const lost = await sendAndDrop(`executions/${activityId}/${sessionRef}/control`, control);
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

  // 6. The student stops the session in Chrome; only a real exit is reported as stopped.
  await page.getByRole('button', { name: '停止会话' }).click();
  await expect(page.locator('.execution-title')).toContainText('已取消', { timeout: 30_000 });
  const inputDisabled = await page.getByLabel('输入整数（0–99）').isDisabled();
  const stopped = await api(`executions/${activityId}/${sessionRef}`, undefined, sessionHeaders);
  const afterStopRows = await processTable();
  record('student-stop', { title: (await page.locator('.execution-title').textContent()).trim(), inputDisabled,
    state: stopped.value.state, reason: stopped.value.reason, remainingSessionProcesses: sessionProcesses(afterStopRows).length });
  report.checks.stop = inputDisabled && stopped.value.state === 'cancelled' && sessionProcesses(afterStopRows).length === 0;

  // 7. A restarted session then loses its process: the owner never pretends it is still advancing.
  await page.getByRole('button', { name: '开始新会话' }).click();
  await expect(observation.locator('strong')).toHaveText('0', { timeout: 60_000 });
  const restarted = await api('executions/' + activityId + '/sessions', undefined, sessionHeaders);
  const running = restarted.value.filter(item => item.state === 'running');
  assert.equal(running.length, 1, 'one restarted session is expected: ' + restarted.value.map(item => item.state).join(','));
  const crashRef = running[0].requestId;
  const crashRows = await processTable();
  const doomed = sessionProcesses(crashRows);
  assert.equal(doomed.length, 1, 'exactly one session process is expected before the crash: ' + doomed.length);
  process.kill(doomed[0].pid, 'SIGKILL');
  await new Promise(done => setTimeout(done, 1500));
  const afterCrash = await api(`executions/${activityId}/${crashRef}`, undefined, sessionHeaders);
  const controlAfterCrash = await api(`executions/${activityId}/${crashRef}/control`, { controlId: randomUUID(),
    operationId: 'advance', effect: 'input', expectedSeq: afterCrash.value.session?.appliedSeq ?? 0,
    parameters: { value: 1 } }, sessionHeaders);
  record('session-process-killed', { pid: doomed[0].pid, state: afterCrash.value.state,
    statusKnowledge: afterCrash.value.statusKnowledge, reason: afterCrash.value.reason,
    observation: afterCrash.value.session?.observation, controlAfterCrash: controlAfterCrash.status,
    remainingSessionProcesses: sessionProcesses(await processTable()).length });
  report.checks.crash = afterCrash.value.state !== 'running' && afterCrash.value.statusKnowledge === 'confirmed';
  report.checks.crashStopsInput = controlAfterCrash.status >= 400;

  // 8. The declared concurrency limit is enforced by replaying the real accept body with new identities.
  const acceptShape = Object.keys(JSON.parse(acceptBody));
  const replayAccept = async requestId => {
    const body = JSON.parse(acceptBody);
    body.action.requestId = requestId;
    delete body.acceptance;
    return api('executions/' + activityId, body, sessionHeaders);
  };
  const second = await replayAccept(randomUUID());
  const third = await replayAccept(randomUUID());
  const fourth = await replayAccept(randomUUID());
  const afterLimit = await api('executions/' + activityId + '/sessions', undefined, sessionHeaders);
  record('concurrency-limit', { declaredConcurrentSessions: 2, acceptBodyKeys: acceptShape,
    second: second.status, third: third.status, fourth: fourth.status, fourthValue: fourth.value,
    secondValue: second.value, states: afterLimit.value.map(item => item.state) });
  report.checks.concurrency = second.status === 200 && third.status === 200 && fourth.status >= 400;

  // 9. Every session is stopped through the owner; nothing is left running on the machine.
  for (const item of afterLimit.value) {
    if (item.state === 'running' || item.state === 'queued')
      await api(`executions/${activityId}/${item.requestId}/stop`, { stopId: randomUUID(), reason: '验收结束' }, sessionHeaders)
        .catch(() => null);
  }
  await page.waitForTimeout(1500);
  const leftovers = sessionProcesses(await processTable());
  record('cleanup', { leftoverSessionProcesses: leftovers.length, pids: leftovers.map(item => item.pid) });
  report.checks.cleanup = leftovers.length === 0;

  record('page-errors', { errors });
  report.checks.noPageErrors = errors.length === 0;
  report.browserVersion = browserVersion;
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
