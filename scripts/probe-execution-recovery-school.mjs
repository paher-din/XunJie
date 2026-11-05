#!/usr/bin/env node
/**
 * #188 cross-machine recovery acceptance on a real client device.
 *
 * The client owns the actual product package, native PostgreSQL and desktop Chrome.
 * An independent school node is reached over strict HTTPS (SPKI-pinned Chrome,
 * NODE_EXTRA_CA_CERTS for Node, never ignoreHTTPSErrors). A real approved client
 * connection makes the school node a declared recovery receiver; the final
 * takeover fences that receiver over SSH (maintenance only) and proves that the
 * retired source installation cannot regain authority. Student traffic never
 * uses an SSH tunnel or a same-machine development proxy.
 *
 * Usage:
 *   node scripts/probe-execution-recovery-school.mjs <PACKAGE> <OUTPUT> \
 *     --school-state=FILE --spki=HASH --ssh-config=FILE --ssh-host=ALIAS \
 *     --ssh-root=/remote/root --ssh-cli=/remote/app/cli.js --ssh-node=/remote/node
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connect as connectTcp, createServer } from 'node:net';
import { chromium, expect } from '@playwright/test';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'school-state': { type: 'string' }, spki: { type: 'string' }, 'ssh-config': { type: 'string' },
  'ssh-host': { type: 'string' }, 'ssh-root': { type: 'string' }, 'ssh-cli': { type: 'string' },
  'ssh-node': { type: 'string' }, label: { type: 'string' }, 'component-definitions': { type: 'string' },
} });
const product = resolve(positionals[0] ?? '');
const output = resolve(positionals[1] ?? '.verification/wp03-188/school-recovery');
for (const key of ['school-state', 'spki', 'ssh-config', 'ssh-host', 'ssh-root', 'ssh-cli', 'ssh-node'])
  if (!values[key]) throw new Error(`--${key} is required`);
await mkdir(output, { recursive: true });
const state = JSON.parse(await readFile(resolve(values['school-state']), 'utf8'));
const runtime = await import(pathToFileURL(join(product, 'app/product-runtime.js')).href);
const resourcePaths = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
const resources = { ...resourcePaths };
for (const name of ['nodePath', 'postgresBin', 'webRoot', 'windowsPrerequisitePath', 'windowsSessionHelper'])
  if (resources[name]) resources[name] = resolve(product, resources[name]);
const root = await mkdtemp(join(tmpdir(), 'xunjie-188-school-'));
const sourceRoot = join(root, 'source'), targetRoot = join(root, 'target');
const source = runtime.openProductRuntime({ root: sourceRoot, resources });
const target = runtime.openProductRuntime({ root: targetRoot, resources });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/**
 * A workspace device builds the public component bytes from source. A client device may
 * instead consume those exact frozen bytes (hash recorded in the report) so it needs no
 * workspace contracts or esbuild, only the real product package and desktop Chrome.
 */
async function componentDefinitions() {
  if (values['component-definitions']) {
    const frozen = await readFile(resolve(values['component-definitions']));
    report.componentDefinitionsSha256 = hash(frozen);
    const definitions = JSON.parse(frozen.toString('utf8'));
    assert.equal(definitions.length, 3, 'frozen component definitions');
    return definitions;
  }
  const [annotation, aggregation, accumulator] = await Promise.all([
    import('../components/material-annotation/package.mjs'),
    import('../components/table-aggregation/package.mjs'),
    import('../components/state-accumulator/package.mjs'),
  ]);
  return [await annotation.annotationPackage(), await aggregation.aggregationPackage(),
    await accumulator.accumulatorPackage()];
}
const report = {
  label: values.label ?? `${process.platform}-${process.arch}`, ticket: '#188',
  platform: process.platform, arch: process.arch, os: release(), node: process.version,
  product, packageSha256: hash(await readFile(join(product, 'distribution.json'))),
  schoolEndpoint: state.endpoint, receiverId: state.receiverId,
  strictTLS: { ignoreHTTPSErrors: false, spkiPinned: true, relay: 'tcp-forward' },
  headless: false, cases: [], status: 'running',
};
const pass = name => { report.cases.push(name); console.log('PASS ' + name); };
let browser, restored, page, targetCreated = false, relay, connectionId, schoolOutbound;
const browserErrors = [], consoleErrors = [], requestFailures = [], httpErrors = [];
const tunnels = new Set();
const schoolUrl = new URL(state.endpoint);
const upstreamHost = schoolUrl.hostname, upstreamPort = Number(schoolUrl.port || 443);
if (/^(127\.|localhost$)/.test(upstreamHost)) throw new Error('a cross-machine probe needs a non-loopback school endpoint');
async function openRelay() {
  if (relay) return;
  relay = createServer(client => {
    const upstream = connectTcp({ host: upstreamHost, port: upstreamPort });
    const pair = { client, upstream };
    tunnels.add(pair);
    const forget = () => tunnels.delete(pair);
    client.on('close', () => { forget(); upstream.destroy(); });
    upstream.on('close', () => { forget(); client.destroy(); });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise((ok, bad) => { relay.once('error', bad); relay.listen(upstreamPort, '127.0.0.1', ok); });
}
async function severRelay() {
  const count = tunnels.size;
  for (const { client, upstream } of tunnels) { client.destroy(); upstream.destroy(); }
  tunnels.clear();
  const current = relay; relay = null;
  if (current) await new Promise(ok => current.close(ok));
  return count;
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
/** Deployment SSH carries maintenance only; student data always uses direct verified HTTPS. */
async function sshCommand(command, input) {
  return new Promise((ok, bad) => {
    const child = spawn('ssh', ['-F', resolve(values['ssh-config']), '-T', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=15',
      values['ssh-host'], command], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 90000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes.toString(); });
    child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    child.on('error', bad);
    child.stdin.on('error', bad);
    child.on('close', code => code === 0 ? ok(stdout) : bad(new Error(`school maintenance command failed (${code}): ${stderr.slice(0, 300)}`)));
    child.stdin.end(input);
  });
}
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
  await openRelay();
  await source.install({ profile: 'local' });
  const { endpoint } = await source.start();
  const admin = { authorization: `Bearer ${await runtime.resolveCredential(sourceRoot, 'control')}` };
  const definitions = [];
  for (const input of await componentDefinitions())
    definitions.push(await api(endpoint, 'manage/component-import', { requestId: randomUUID(), ...input }, admin));
  report.components = definitions.map(d => ({ componentId: d.manifest.componentId, version: d.manifest.version, digest: d.digest }));
  const materialId = randomUUID(), courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
  const bytes = Buffer.from('先区分观察到的事实与自己的解释。保留原始记录，再根据新的证据修订理解。');
  await api(endpoint, 'manage/course-import', { formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '组件与执行跨机恢复验收' }, task: { taskId, title: '重开原作品与实验记录', summary: '真实备份、隔离与接管' },
    release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['保持原作品、输入与执行身份'], requirements: '标注材料、计算固定表格，并为真实会话保存检查点。',
      starterWorks: [], capabilities: [], components: [
        { key: 'annotation', definition: definitions[0], configuration: { title: '材料标注' }, materialIds: [materialId] },
        { key: 'table', definition: definitions[1], configuration: { title: '表格聚合' }, materialIds: [] },
        { key: 'accumulator', definition: definitions[2], configuration: { title: '四态累加模拟' }, materialIds: [] },
      ], materials: [{ materialId, title: '阅读材料', path: 'material.txt', mediaType: 'text/plain', access: 'student',
        byteLength: bytes.length, sha256: hash(bytes) }] }, resources: [{ path: 'material.txt', contentBase64: bytes.toString('base64') }] }, admin);
  const loginName = 'recovery-reader-' + randomUUID().slice(0, 8), password = randomUUID();
  const identity = await api(endpoint, 'manage/members', { requestId: randomUUID(), loginName, password }, admin);
  await api(endpoint, 'manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: true }, admin);
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: [
    `--ignore-certificate-errors-spki-list=${values.spki}`,
    `--host-resolver-rules=MAP ${upstreamHost} 127.0.0.1`,
    '--no-proxy-server', '--disable-quic', '--no-first-run', '--no-default-browser-check',
    // A real desktop session may occlude the window; never let Chrome throttle the
    // Worker/WASM computation or its confirmation polling while evidence is collected.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
  ] });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, ignoreHTTPSErrors: false });
  const login = await context.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  assert.equal(login.status(), 200);
  const created = await context.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  assert.equal(created.status(), 200); const activity = await created.json();
  page = await context.newPage();
  page.on('pageerror', error => { browserErrors.push(error.message); });
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
  page.on('requestfailed', request => requestFailures.push(request.url().slice(0, 200) + ' ' + (request.failure()?.errorText ?? '')));
  page.on('response', response => { if (response.status() >= 400) httpErrors.push(response.status() + ' ' + response.url().slice(0, 200)); });
  const track = opened => opened.on('response', response => {
    if (response.status() >= 400) httpErrors.push(response.status() + ' ' + response.url().slice(0, 200));
  });
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
  const idleStatus = '可以选择分组列与数值列后运行。';
  await expect(frame.locator('#status')).toHaveText(idleStatus, { timeout: 30000 });
  let computePosts = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('execution')) computePosts++;
  });
  await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  // A real desktop window can be occluded, which may defer or drop the frame's first
  // input. Only repeat a click that produced neither a submit nor a status change;
  // never start a second execution for one that is already in flight.
  await page.waitForTimeout(750);
  if (computePosts === 0 && await frame.locator('#status').textContent() === idleStatus)
    await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  await expect(frame.locator('#status')).not.toHaveText(idleStatus, { timeout: 15000 });
  await expect(page.getByRole('region', { name: '计算记录' }).getByText('已完成', { exact: false })).toBeVisible({ timeout: 30000 });
  report.compute = { iframeStatus: await frame.locator('#status').textContent(), submits: computePosts };
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
  await page.screenshot({ path: join(output, 'source-before.png'), fullPage: true });
  pass('real product creates annotation, reference, question, Worker result and a native checkpoint with a lost control reply');

  // A school-shared member approves this installed client over strict HTTPS. Recovery
  // receivers are declared by *installed runtime connections*, not by the browser grant,
  // so the school node also issues an installation-bound learning.authority grant.
  const pending = await context.request.post(endpoint + '/api/learning/client/start', {
    data: { requestId: randomUUID(), schoolEndpoint: state.endpoint } });
  assert.equal(pending.status(), 200, 'client/start');
  const pendingBody = await pending.json();
  connectionId = pendingBody.requestId;
  // The school page must already hold the member's session when it loads; otherwise its
  // authorization button stays disabled until a full reload.
  const schoolContext = await browser.newContext({ ignoreHTTPSErrors: false });
  const schoolLogin = await schoolContext.request.post(state.endpoint + '/api/learning/login', {
    data: { loginName: state.loginName, password: state.password } });
  assert.equal(schoolLogin.status(), 200, 'strict HTTPS school login');
  const approval = await schoolContext.newPage();
  await approval.goto(pendingBody.authorizationUrl, { waitUntil: 'domcontentloaded' });
  await approval.getByRole('button', { name: '允许连接', exact: true }).click();
  await expect(approval.getByText('连接已批准', { exact: false })).toBeVisible({ timeout: 20000 });
  const completed = await context.request.post(endpoint + '/api/learning/client/complete', { data: { requestId: connectionId } });
  assert.equal(completed.status(), 200, 'client/complete');
  await schoolContext.close();

  const sourceEnvironment = JSON.parse(await readFile(join(sourceRoot, 'environment.json'), 'utf8'));
  const sourceService = sourceEnvironment.services.find(item => item.unit === 'learning-data');
  assert.ok(sourceService, 'the installed client must own a real learning-data service');
  const schoolEnvironmentResponse = await fetch(new URL('/runtime/environment', state.endpoint));
  assert.equal(schoolEnvironmentResponse.status, 200, 'strict HTTPS school runtime identity');
  const schoolEnvironment = await schoolEnvironmentResponse.json();
  const schoolService = schoolEnvironment.services.find(item =>
    `${schoolEnvironment.environmentId}/${item.serviceId}` === state.receiverId);
  assert.ok(schoolService, 'the declared receiver must publish its runtime identity over strict HTTPS');

  // SSH only performs receiver maintenance (one scoped grant); no student traffic is tunnelled.
  const grantPath = `${values['ssh-root']}/credentials/wp03-188-runtime-${randomUUID()}.json`;
  const authorizeCommand = [values['ssh-node'], values['ssh-cli'], 'authorize', '--root', values['ssh-root'],
    '--file', '/dev/stdin', '--out', grantPath].map(quote).join(' ');
  try {
    await sshCommand(authorizeCommand, JSON.stringify({ sourceEnvironmentId: sourceEnvironment.environmentId,
      sourceServiceId: sourceService.serviceId, sourceInstallationId: sourceEnvironment.installationId,
      capabilities: ['learning.authority'] }));
    const runtimeGrant = JSON.parse((await sshCommand(`cat ${quote(grantPath)}`)).trim());
    assert.ok(runtimeGrant.token && runtimeGrant.grantId, 'the school node must issue a scoped runtime grant');
    const runtimeConnection = { connectionId: randomUUID(), sourceEnvironmentId: sourceEnvironment.environmentId,
      sourceServiceId: sourceService.serviceId, target: schoolService,
      requiredCapabilities: ['learning.authority'], optionalCapabilities: [],
      credentialRef: 'wp03-188-school-runtime' };
    await source.connect(runtimeConnection, runtimeGrant.token);
    schoolOutbound = runtime.createOutboundConnection({ connection: runtimeConnection,
      credential: () => runtime.resolveCredential(sourceRoot, runtimeConnection.credentialRef), timeoutMs: 15000 });
    const handshake = await schoolOutbound.check();
    assert.equal(handshake.state, 'ready', `strict HTTPS runtime handshake: ${handshake.reason ?? handshake.state}`);
    assert.ok(handshake.availableCapabilities.includes('learning.authority'), 'the approved school authority must be reachable');
    report.connection = { connectionId, runtimeConnectionId: runtimeConnection.connectionId,
      grantId: runtimeGrant.grantId, receiverId: state.receiverId, strictHTTPS: true,
      capability: 'learning.authority', handshake: handshake.state };
    // The same installed client reads school-owned courses through its approved school space.
    const schoolCoursesResponse = await context.request.get(endpoint + '/api/learning/courses',
      { headers: { 'x-xj-space': 'school:' + connectionId } });
    assert.equal(schoolCoursesResponse.status(), 200, 'approved client school course read');
    const schoolCourses = await schoolCoursesResponse.json();
    assert.ok(schoolCourses.courses.some(item => item.courseId === state.courseId),
      'the approved installed client must read the independent school course');
    report.connection.schoolCourseId = state.courseId;
    const installed = JSON.parse(await readFile(join(sourceRoot, 'installation.json'), 'utf8'));
    const schoolReceiver = installed.connections.find(item =>
      `${item.target.environmentId}/${item.target.serviceId}` === state.receiverId);
    assert.ok(schoolReceiver, 'the approved school connection must be persisted as a recovery receiver');
    pass('a real school approval plus an installation-bound strict HTTPS runtime grant declares the independent school receiver');
  } finally { await sshCommand(`rm -f ${quote(grantPath)}`).catch(() => {}); }

  const sourceContext = await context.request.get(endpoint + '/api/learning/context').then(r => r.json());
  await expect.poll(async () => (await context.request.get(endpoint + `/api/learning/drafts/${activity.activityId}`,
    { headers: { 'x-xj-space': 'school' } }).then(r => r.json())).question).toBe('请核对这条原始标注。');
  await page.route('**/api/learning/drafts/**', route => route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue());
  await page.getByRole('button', { name: '打开对话', exact: true }).click();
  await page.getByLabel('你的问题', { exact: true }).fill('浏览器独有未同步草稿');
  await expect.poll(async () => (await browserDrafts(page)).some(draft =>
    draft.question === '浏览器独有未同步草稿' && draft.key.includes(sourceContext.clientNamespace))).toBe(true);
  await page.getByRole('button', { name: '问题与引用', exact: true }).click();
  const sourceSessions = await context.request.get(endpoint + `/api/learning/executions/${activity.activityId}/sessions`,
    { headers: { 'x-xj-space': 'school' } }).then(r => r.json());
  const originalSession = sourceSessions[0];
  report.originalSession = { requestId: originalSession.requestId, inputDigest: originalSession.inputDigest,
    executionRef: originalSession.executionRef, nodeId: originalSession.session.nodeId,
    executorInstanceId: originalSession.session.executorInstanceId };
  const sourceHistory = await context.request.get(endpoint + `/api/learning/executions/${activity.activityId}/history`,
    { headers: { 'x-xj-space': 'school' } }).then(r => r.json());
  const job = sourceHistory.entries.find(item => item.action.execution.instance.key === 'table');
  assert.ok(job?.query.output?.artifact);
  report.browserJob = { requestId: job.query.requestId, inputDigest: job.query.inputDigest,
    executionRef: job.query.executionRef, artifactSha256: job.query.output.artifact.sha256,
    artifactByteLength: job.query.output.artifact.byteLength };

  // A real link break on the school-facing TCP path: hold one live tunnel, then destroy
  // real sockets rather than toggling a browser offline flag.
  const heldTunnel = await new Promise((ok, bad) => {
    const socket = connectTcp({ host: '127.0.0.1', port: upstreamPort });
    socket.once('connect', () => ok(socket));
    socket.once('error', bad);
  });
  for (let attempt = 0; attempt < 100 && tunnels.size === 0; attempt++)
    await new Promise(ok => setTimeout(ok, 20));
  assert.ok(tunnels.size > 0, 'the relay must hold a live school TCP tunnel before the link break');
  report.relaySeveredTunnels = await severRelay();
  heldTunnel.destroy();
  assert.ok(report.relaySeveredTunnels >= 1, 'the link break must destroy at least one real TCP tunnel');
  const schoolOffline = await context.newPage();
  const unreachable = await schoolOffline.goto(state.endpoint + '/', { waitUntil: 'domcontentloaded', timeout: 8000 })
    .then(() => false).catch(() => true);
  await schoolOffline.close();
  assert.equal(unreachable, true, 'the broken TCP link must not reach the independent school node');
  report.realDisconnect = { mechanism: 'tcp-tunnels-destroyed', severedTunnels: report.relaySeveredTunnels, schoolReachable: false };
  await openRelay();
  const schoolOnline = await context.request.get(state.endpoint + '/');
  assert.equal(schoolOnline.status(), 200);
  pass('a real TCP link break isolates the school node and reconnect re-queries the same school identity');
  const schoolContextBody = await context.request.get(state.endpoint + '/api/learning/context').then(r => r.json());
  assert.equal(schoolContextBody.clientNamespace.includes(state.environmentId), true);

  const key = randomBytes(32);
  await source.setCredential('recovery-test-key', key.toString('base64'));
  const manifest = await source.recovery.backup({ directory: join(root, 'backups'), recoveryKeyRef: 'recovery-test-key', leaveClosed: true });
  report.backupId = manifest.backupId;
  assert.deepEqual(manifest.receiverIds, [state.receiverId], 'the backup must declare the independent school receiver');
  report.boundary = { services: manifest.boundary.services, receiverIds: manifest.receiverIds };
  restored = await runtime.restoreProductRecovery({ root: targetRoot, backupDirectory: join(root, 'backups', manifest.backupId), key, resources });
  targetCreated = true;
  for (const owner of restored.owners) await owner.close?.();
  restored = undefined;
  const isolated = await target.start();
  assert.equal(isolated.state, 'maintenance');
  const targetContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, ignoreHTTPSErrors: false });
  assert.equal((await targetContext.request.post(isolated.endpoint + '/api/learning/login', { data: { loginName, password } })).status(), 200);
  const targetState = await targetContext.request.get(isolated.endpoint + '/api/learning/context').then(r => r.json());
  assert.equal(targetState.readOnly, true);
  assert.notEqual(targetState.clientNamespace, sourceContext.clientNamespace);
  const targetPage = await targetContext.newPage(); page = targetPage; track(targetPage);
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
  await targetPage.screenshot({ path: join(output, 'isolated-annotation.png'), fullPage: true });
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
  await targetPage.screenshot({ path: join(output, 'isolated-native-light.png'), fullPage: true });
  await targetPage.emulateMedia({ colorScheme: 'dark' });
  await expect(targetPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  await targetPage.screenshot({ path: join(output, 'isolated-native-dark.png'), fullPage: true });
  await targetPage.setViewportSize({ width: 1000, height: 900 });
  await targetPage.screenshot({ path: join(output, 'isolated-native-narrow.png'), fullPage: true });
  assert.deepEqual(writes, [], 'isolated views must not dispatch, sync, report, or run self-tests');
  assert.ok((await browserDrafts(context.pages()[0])).some(draft =>
    draft.question === '浏览器独有未同步草稿' && draft.key.includes(sourceContext.clientNamespace)));
  pass('isolated Chrome reopens the original components, fixed artifact bytes, references, draft and checkpoint with zero writes');

  // Takeover fences the independent school node over SSH. SSH is maintenance only.
  const sshReceiver = { id: state.receiverId, ssh: {
    configFile: resolve(values['ssh-config']), host: values['ssh-host'],
    nodePath: values['ssh-node'], cliPath: values['ssh-cli'], root: values['ssh-root'],
  } };
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
  try { await assert.rejects(target.recovery.takeover({ sourceRoot, receivers: [sshReceiver] })); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(lostTakeoverReply, true);
  pass('a lost takeover reply stays isolated and the retry is idempotent');
  const takeover = await target.recovery.takeover({ sourceRoot, receivers: [sshReceiver] });
  assert.equal(takeover.backupId, manifest.backupId);
  assert.equal(takeover.phase, 'active');
  report.takeover = { backupId: takeover.backupId, phase: takeover.phase, receiverProof: 'ssh-fence-source' };
  report.lostTakeoverReply = true;
  await assert.rejects(source.recovery.resume(), { code: 'source-retired' });
  pass('takeover retires the source and holds a real SSH execution-boundary proof from the independent school node');

  // The retired installation must not regain authority at the school node.
  const oldGrant = await context.request.get(endpoint + '/api/learning/activities', {
    headers: { 'x-xj-space': 'school:' + connectionId } });
  report.oldGrantStatus = oldGrant.status();
  assert.notEqual(oldGrant.status(), 200, 'the retired installation must not read through the old school grant');
  pass('the old school grant of the retired installation is refused after the new installation is active');
  const fencedHandshake = await schoolOutbound.check();
  assert.notEqual(fencedHandshake.state, 'ready', 'the retired installation runtime grant must be refused at the school node');
  report.fencedGrant = { state: fencedHandshake.state, reason: fencedHandshake.reason ?? null };
  pass('the independent school node refuses the retired installation runtime connection after its real fence');

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
  await targetPage.getByRole('button', { name: '单步', exact: true }).click();
  await expect(targetPage.locator('.native-session-observation strong')).toHaveText('1');
  const after = await targetContext.request.get(isolated.endpoint + `/api/learning/executions/${activity.activityId}/sessions`,
    { headers: { 'x-xj-space': 'school' } }).then(r => r.json());
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
  report.oldNamespaceStatus = oldQueue.status();
  await targetPage.screenshot({ path: join(output, 'takeover-recovered.png'), fullPage: true });
  pass('after takeover the formal workspace edits in a new namespace and creates a distinct checkpoint instance whose real next result is 1');
  assert.deepEqual(browserErrors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error);
  report.browserErrors = browserErrors; report.consoleErrors = consoleErrors; report.requestFailures = requestFailures;
  report.httpErrors = httpErrors;
  console.log('PAGE_ERRORS ' + JSON.stringify(browserErrors));
  console.log('CONSOLE_ERRORS ' + JSON.stringify(consoleErrors));
  console.log('REQUEST_FAILURES ' + JSON.stringify(requestFailures));
  console.log('HTTP_ERRORS ' + JSON.stringify(httpErrors));
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (relay) await severRelay().catch(() => {});
  for (const owner of restored?.owners ?? []) await owner.close?.();
  const stopped = await Promise.allSettled([source.stop(), ...(targetCreated ? [target.stop()] : [])]);
  report.cleanup = stopped.map(value => value.status);
  if (stopped.every(value => value.status === 'fulfilled')
    && !(report.status === 'failed' && process.env.XUNJIE_KEEP_FAILED_ROOT === '1')) {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    try { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); report.temporaryRootRemoved = true; }
    catch (error) { report.temporaryRootRemoved = false; report.retainedRoot = root; report.cleanupError = error.code; }
  } else { report.temporaryRootRemoved = false; report.retainedRoot = root; }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
