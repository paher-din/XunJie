import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { digest } from './remote-probe-helpers.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
if (!args.endpoint || !args.spki || !args.payload || !args.control || !args.app || !args.web || !args.product)
  throw new Error('需要 --endpoint --spki --payload --control --app --web --product [--output]');
const actualPlatform = `${process.platform}-${process.arch}`;
assert.ok(['darwin-arm64', 'win32-x64'].includes(actualPlatform), '必须在真实桌面设备执行');
const platform = actualPlatform === 'darwin-arm64' ? 'macos-arm64' : 'windows-x64';
const output = resolve(args.output ?? `.verification/wp03-175/channel-${platform}`);
await mkdir(output, { recursive: true });
const root = join(output, 'runtime-' + randomUUID());
const endpoint = new URL(args.endpoint);
assert.equal(endpoint.protocol, 'https:');
assert.ok(!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname));
const payload = JSON.parse(await readFile(args.payload, 'utf8'));
const product = resolve(args.product);
const rawResources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'));
const resources = Object.fromEntries(Object.entries(rawResources).map(([key, value]) =>
  [key, /(?:Path|Bin|Root|Helper)$/.test(key) ? resolve(product, value) : value]));
resources.webRoot = resolve(args.web);
if (args.helper) resources.windowsSessionHelper = resolve(args.helper);
if (args['helper-sha256']) resources.windowsSessionHelperSha256 = args['helper-sha256'];
const { openProductRuntime } = await import(pathToFileURL(join(resolve(args.app), 'product-runtime.js')).href);
const runtime = openProductRuntime({ root, resources });
const exec = promisify(execFile);
const report = { ticket: 175, kind: '学校网页到真实桌面持久领取通道', platform, actualPlatform,
  endpoint: endpoint.origin, root, startedAt: new Date().toISOString(), status: 'running', cases: [], traffic: [] };
report.candidate = Object.fromEntries(await Promise.all(['product-runtime.js', 'daemon.js'].map(async name =>
  [name, createHash('sha256').update(await readFile(join(resolve(args.app), name))).digest('hex')])));
const pass = name => { report.cases.push(name); console.log('PASS ' + name); };
async function school(route, body, admin = false) {
  const response = await fetch(new URL('/api/learning/' + route, endpoint), {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', ...(admin ? { authorization: 'Bearer ' + (await readFile(args.control, 'utf8')).trim() } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  assert.equal(response.status, 200, `${route}: HTTP ${response.status} ${value.error ?? ''}`);
  return value;
}
let browser, page, mixedPage, mixedPath, activityId, connectionId, localEndpoint, currentPath;
let mixedHeaders = {};
async function api(route, body, clientPage = page) {
  return clientPage.evaluate(async ({ route, body, headers }) => {
    const response = await fetch('/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { route, body, headers: clientPage === mixedPage ? mixedHeaders : {} });
}
function ok(route, response) { assert.equal(response.status, 200, `${route}: HTTP ${response.status} ${response.body?.error ?? ''}`); return response.body; }
async function local(route, body) {
  const response = await fetch(new URL('/api/learning/' + route, localEndpoint), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return ok(route, { status: response.status, body: await response.json() });
}
async function until(probe, accepts, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  let value;
  do {
    value = await probe();
    if (accepts(value)) return value;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`${label} 超时: ${JSON.stringify(value)}`);
}
const fact = query => ({ executionRef: query.executionRef, requestId: query.requestId, state: query.state,
  statusKnowledge: query.statusKnowledge, nodeId: query.session?.nodeId, installGeneration: query.session?.installGeneration,
  supervisorEpoch: query.session?.supervisorEpoch, executorInstanceId: query.session?.executorInstanceId,
  appliedSeq: query.session?.appliedSeq, observation: query.session?.observation });
function fixed(a, b) {
  for (const key of ['executionRef', 'nodeId', 'installGeneration', 'supervisorEpoch', 'executorInstanceId'])
    assert.ok(a[key] && a[key] === b[key], `固定执行身份不匹配: ${key}`);
}
async function processes() {
  if (process.platform === 'darwin') {
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,command=']);
    return stdout.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const [pid, ppid, ...command] = line.split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), command: command.join(' ') };
    });
  }
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout).map(row => ({ pid: row.ProcessId, ppid: row.ParentProcessId, command: row.CommandLine ?? '' }));
}
const ownedProcesses = async () => {
  const instance = JSON.parse(await readFile(join(root, 'instance.json'), 'utf8'));
  const rows = await processes();
  const ids = new Set([instance.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
  }
  return rows.filter(row => ids.has(row.pid));
};
const nativeProcesses = async () => (await ownedProcesses()).filter(row => row.command.includes('--input-type=module')
  && row.command.includes('four-state-accumulator') && /^(?:"[^"]*[\\/]node(?:\.exe)?"|[^\s"]*[\\/]node(?:\.exe)?)(?:\s|$)/i.test(row.command));
let acceptBody;
try {
  if (!Object.hasOwn(args, 'reuse-course')) {
  const imported = await school('manage/component-import', { requestId: randomUUID(), ...payload.component }, true);
  const session = payload.component.manifest.session;
  const planBasis = { planId: 'approved-local-native-accumulator', planVersion: 1,
    components: [{ key: 'accumulator', definitionDigest: imported.digest,
      configurationDigest: digest(payload.configuration), operations: [session.operation.operationId] }],
    capabilities: ['execution.submit', 'native-session'], resources: { browser: null,
      native: { memoryMiB: session.budgets.memoryMiB, operationTimeoutMs: session.budgets.operationTimeoutMs, maxMs: session.budgets.maxMs } },
    locations: ['native'], remote: null };
  const executionPlan = { ...planBasis, planDigest: digest(planBasis) };
  await school('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: payload.course, task: payload.task,
    release: { ...payload.release, components: [{ key: 'accumulator', definition: imported, configuration: payload.configuration, materialIds: [] }], executionPlan }, resources: [] }, true);
  const member = await school('manage/members', { requestId: randomUUID(), loginName: payload.loginName, password: payload.password }, true);
  await school('manage/course-access', { requestId: randomUUID(), courseId: payload.courseId, principalId: member.principalId, active: true }, true);
  pass('通过学校管理 API 导入发布原四态累加课程并授权学生');
  }
  await runtime.install({ profile: 'remote' });
  const started = await runtime.start();
  localEndpoint = started.endpoint;
  assert.ok(localEndpoint);
  report.runtime = { endpoint: localEndpoint, installationId: started.environment.installationId, resources };
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: [
    `--ignore-certificate-errors-spki-list=${args.spki}`, '--no-proxy-server', '--disable-quic', '--no-first-run'] });
  report.browser = { product: 'Google Chrome', version: browser.version(), headless: false, ignoreHTTPSErrors: false };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false });
  page = await context.newPage();
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/executions/')) {
      report.traffic.push({ method: request.method(), path });
      if (request.method() === 'POST' && /\/executions\/[0-9a-f-]+$/.test(path)) acceptBody = request.postDataJSON();
    }
  });
  await page.goto(endpoint.origin, { waitUntil: 'domcontentloaded' });
  report.clientFacts = await page.evaluate(async () => navigator.userAgentData.getHighEntropyValues(['platform', 'architecture', 'bitness']));
  assert.equal(report.clientFacts.platform, process.platform === 'darwin' ? 'macOS' : 'Windows');
  ok('login', await api('login', { loginName: payload.loginName, password: payload.password }));
  const requestId = randomUUID();
  await local('client/start', { requestId, schoolEndpoint: endpoint.origin });
  ok('approve', await api('connections/approve', { requestId }));
  await local('client/complete', { requestId });
  const nodes = await until(async () => ok('nodes', await api('native-channel/nodes')),
    value => value.some(node => node.platform === platform && node.installationId === started.environment.installationId), '本机 worker 登记');
  const node = nodes.find(node => node.installationId === started.environment.installationId);
  connectionId = node.connectionId;
  report.node = node;
  pass('复用学校已批准连接，真实桌面 worker 登记本机安装身份和适配器');
  const activity = ok('activity', await api('course-activities', { requestId: randomUUID(), releaseId: payload.releaseId }));
  activityId = activity.activityId;
  report.activityId = activityId;
  await page.goto(`${endpoint.origin}/?space=school&activity=${activityId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: payload.component.manifest.title, exact: true }).click();
  await expect(page.frameLocator('.component-view iframe').getByText('组件已就绪')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: join(output, 'channel-before.png'), fullPage: true });
  const observation = page.locator('.native-session-observation');
  await page.getByRole('button', { name: /启动(?:本机|原生)会话/ }).click();
  await until(async () => acceptBody, value => !!value, '浏览器发出启动请求');
  assert.equal(acceptBody.action.receiver.location, 'local');
  report.receiver = acceptBody.action.receiver;
  currentPath = `executions/${activityId}/${acceptBody.action.requestId}`;
  const original = await until(async () => fact(ok('query', await api(currentPath))),
    query => query.state === 'running' && query.statusKnowledge === 'confirmed', '本机 worker 确认启动');
  await page.getByRole('button', { name: /核对(?:状态|原操作)/ }).click();
  await expect(observation.locator('strong')).toHaveText('0', { timeout: 15_000 });
  report.accepted = original;
  assert.equal(original.state, 'running');
  assert.equal(original.nodeId, node.nodeId);
  assert.equal(original.installGeneration, started.environment.installationId);
  const children = await nativeProcesses();
  assert.equal(children.length, 1, '必须观察到一个真实本机原生会话进程');
  report.process = { pid: children[0].pid, parentPid: children[0].ppid, productNode: resources.nodePath };
  const observations = [];
  for (const [value, expected] of [[1, '1'], [2, '3'], [2, '1']]) {
    await page.getByLabel('输入整数（0–99）').fill(String(value));
    await page.getByRole('button', { name: '输入', exact: true }).click();
    const query = await until(async () => fact(ok('query', await api(currentPath))),
      query => query.appliedSeq === observations.length + 1 && query.observation?.value === Number(expected), '本机 worker 确认输入');
    await page.getByRole('button', { name: /核对(?:状态|原操作)/ }).click();
    await expect(observation.locator('strong')).toHaveText(expected, { timeout: 15_000 });
    fixed(original, query);
    observations.push(query);
  }
  report.observations = observations;
  assert.deepEqual(observations.map(value => value.observation.value), [1, 3, 1]);
  assert.deepEqual(observations.map(value => value.appliedSeq), [1, 2, 3]);
  await page.screenshot({ path: join(output, 'channel-running.png'), fullPage: true });
  pass('学校网页经持久领取通道启动真实本机进程，连续输入 1、2、2 得到 1、3、1');
  if (args['remote-native-state']) {
    const remote = JSON.parse(await readFile(args['remote-native-state'], 'utf8'));
    report.mixedFallback = { status: 'running', registeredLocalNode: node,
      localBefore: fact(ok('local-before-fallback', await api(currentPath))) };
    const mixed = report.mixedFallback;
    fixed(original, mixed.localBefore);
    await school('manage/course-access', { requestId: randomUUID(), courseId: remote.courseId,
      principalId: activity.identity.principalId, active: true }, true);
    const remoteRelease = ok('remote-release', await api(`releases/${remote.releaseId}`));
    const remoteBinding = remoteRelease.components.find(item => item.key === 'accumulator');
    const remoteManifest = remoteBinding.definition.manifest;
    assert.equal(remoteManifest.session.adapterId, 'linux-proc-accumulator');
    mixed.environment = ok('mixed-environment', await api('execution-environment'));
    const registered = ok('mixed-nodes', await api('native-channel/nodes'));
    assert.ok(registered.some(item => item.nodeId === node.nodeId && item.installationId === node.installationId), 'Linux回退前原本机节点必须仍在登记');
    const remoteActivity = ok('remote-activity', await api('course-activities', { requestId: randomUUID(), releaseId: remote.releaseId }));
    mixed.activityId = remoteActivity.activityId;
    mixed.releaseId = remote.releaseId;
    const localEntry = Object.hasOwn(args, 'local-entry-native');
    mixed.entry = localEntry ? localEndpoint : endpoint.origin;
    mixed.spaceKey = localEntry ? `school:${connectionId}` : 'school';
    mixedHeaders = localEntry ? { 'x-xj-space': mixed.spaceKey, 'x-xj-namespace': started.environment.clientNamespace,
      'x-xj-expected-subject': [remoteActivity.identity.environmentId, remoteActivity.identity.spaceId, remoteActivity.identity.principalId].join('.') } : {};
    mixedPage = await page.context().newPage();
    let remoteAccept;
    mixed.traffic = [];
    mixedPage.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.includes('/executions/')) mixed.traffic.push({ origin: url.origin, method: request.method(), path: url.pathname });
      if (request.method() === 'POST' && url.pathname === `/api/learning/executions/${remoteActivity.activityId}`)
        remoteAccept = request.postDataJSON();
    });
    if (Object.hasOwn(args, 'lose-native-replies')) {
      mixed.lostResponses = {};
      await mixedPage.route('**/api/learning/executions/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        const operation = path.endsWith('/control') ? 'control' : path.endsWith('/stop') ? 'stop'
          : path === `/api/learning/executions/${remoteActivity.activityId}` ? 'submit' : null;
        if (request.method() !== 'POST' || !operation || mixed.lostResponses[operation]) return route.continue();
        const response = await route.fetch({ maxRedirects: 0 });
        if (response.status() !== 200) return route.fulfill({ response });
        const body = request.postDataJSON();
        mixed.lostResponses[operation] = { mechanism: 'discard-response-after-real-owner-accepted',
          commandId: body.action?.requestId ?? body.controlId ?? body.stopId, response: fact(await response.json()) };
        await route.abort('failed');
      });
    }
    await mixedPage.goto(`${mixed.entry}/?space=${encodeURIComponent(mixed.spaceKey)}&activity=${remoteActivity.activityId}`, { waitUntil: 'domcontentloaded' });
    await mixedPage.getByRole('tab', { name: remoteManifest.title, exact: true }).click();
    await expect(mixedPage.frameLocator('.component-view iframe').getByText('组件已就绪')).toBeVisible({ timeout: 60_000 });
    await mixedPage.screenshot({ path: join(output, 'mixed-fallback-before.png'), fullPage: true });
    await mixedPage.getByRole('button', { name: /启动(?:本机|原生)会话/ }).click();
    await until(async () => remoteAccept, value => !!value, '浏览器发出Linux回退请求');
    if (mixed.lostResponses) {
      await until(async () => mixed.lostResponses.submit, Boolean, '真实启动已生效且回包已丢弃');
      await expect(mixedPage.getByRole('button', { name: '核对原启动请求', exact: true })).toBeVisible();
      await mixedPage.reload({ waitUntil: 'domcontentloaded' });
      await mixedPage.getByRole('tab', { name: remoteManifest.title, exact: true }).click();
      await expect(mixedPage.frameLocator('.component-view iframe').getByText('组件已就绪')).toBeVisible({ timeout: 60_000 });
    }
    assert.equal(remoteAccept.action.receiver.location, 'remote');
    mixed.receiver = remoteAccept.action.receiver;
    mixedPath = `executions/${remoteActivity.activityId}/${remoteAccept.action.requestId}`;
    mixed.accepted = await until(async () => fact(ok('remote-query', await api(mixedPath, undefined, mixedPage))),
      query => query.state === 'running' && query.statusKnowledge === 'confirmed', '学校Linux真实会话启动');
    assert.match(mixed.accepted.nodeId, /^school-/);
    assert.notEqual(mixed.accepted.nodeId, original.nodeId);
    assert.ok(Number.isInteger(mixed.accepted.observation?.pid) && mixed.accepted.observation.pid > 0);
    assert.ok(Number.isInteger(mixed.accepted.observation?.threads) && mixed.accepted.observation.threads > 0);
    if (mixed.lostResponses) {
      fixed(mixed.lostResponses.submit.response, mixed.accepted);
      assert.equal(mixed.accepted.observation.pid, mixed.lostResponses.submit.response.observation.pid);
    }
    const remoteObservation = mixedPage.locator('.native-session-observation');
    await mixedPage.getByRole('button', { name: /核对(?:状态|原操作)/ }).click();
    await expect(remoteObservation.locator('strong')).toHaveText('0');
    mixed.observations = [];
    for (const [value, expected] of [[1, '1'], [2, '3'], [2, '1']]) {
      await mixedPage.getByLabel('输入整数（0–99）').fill(String(value));
      await mixedPage.getByRole('button', { name: '输入', exact: true }).click();
      const query = await until(async () => fact(ok('remote-input-query', await api(mixedPath, undefined, mixedPage))),
        query => query.appliedSeq === mixed.observations.length + 1 && query.observation?.value === Number(expected), '学校Linux输入确认');
      fixed(mixed.accepted, query);
      assert.equal(query.observation.pid, mixed.accepted.observation.pid);
      assert.ok(query.observation.threads > 0);
      mixed.observations.push(query);
      await mixedPage.getByRole('button', { name: /核对(?:状态|原操作)/ }).click();
      await expect(remoteObservation.locator('strong')).toHaveText(expected);
    }
    await expect(remoteObservation).toContainText(`进程 PID ${mixed.accepted.observation.pid}；线程数`);
    await mixedPage.screenshot({ path: join(output, 'mixed-fallback-running.png'), fullPage: true });
    await mixedPage.getByRole('button', { name: '停止会话' }).click();
    mixed.stop = await until(async () => fact(ok('remote-stop-query', await api(mixedPath, undefined, mixedPage))),
      query => query.state === 'cancelled' && query.statusKnowledge === 'confirmed', '学校Linux确认停止');
    fixed(mixed.accepted, mixed.stop);
    if (mixed.lostResponses) {
      assert.deepEqual(Object.keys(mixed.lostResponses).sort(), ['control', 'stop', 'submit']);
      assert.equal(mixed.lostResponses.control.response.appliedSeq, 1);
      assert.equal(mixed.lostResponses.stop.response.state, 'cancelled');
      for (const value of Object.values(mixed.lostResponses)) fixed(mixed.accepted, value.response);
    }
    if (localEntry) assert.ok(mixed.traffic.every(request => request.origin === new URL(localEndpoint).origin),
      '原生操作必须经过本机产品 HTTP 入口及真实 school-client 转发');
    await mixedPage.getByRole('button', { name: /核对(?:状态|原操作)/ }).click();
    await mixedPage.screenshot({ path: join(output, 'mixed-fallback-stopped.png'), fullPage: true });
    mixed.localAfter = fact(ok('local-after-fallback', await api(currentPath)));
    fixed(original, mixed.localAfter);
    assert.equal(mixed.localAfter.state, 'running');
    assert.equal(mixed.localAfter.appliedSeq, 3);
    assert.equal(mixed.localAfter.observation.value, 1);
    assert.ok((await nativeProcesses()).some(item => item.pid === report.process.pid), '原本机进程必须继续存活');
    mixed.localNodeAfter = ok('mixed-nodes-after', await api('native-channel/nodes')).find(item => item.nodeId === node.nodeId);
    assert.equal(mixed.localNodeAfter?.installationId, node.installationId);
    await mixedPage.close(); mixedPage = undefined; mixedPath = undefined; mixedHeaders = {};
    await page.bringToFront();
    await page.screenshot({ path: join(output, 'mixed-local-returned.png'), fullPage: true });
    mixed.status = 'passed';
    pass(localEntry ? '无数据库本机产品入口经认证HTTPS调用学校Linux，真实启动/输入/停止丢回包后保留原身份与1/3/1观察'
      : '同一获准本机节点存活时Linux-only课程回退学校真实PID，1/2/2得1/3/1并停止，原本机会话保持固定身份与状态');
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: payload.component.manifest.title, exact: true }).click();
  await expect(observation.locator('strong')).toHaveText('1', { timeout: 30_000 });
  await expect(observation).toContainText('已确认 3 次');
  fixed(original, fact(ok('reopen-query', await api(currentPath))));
  pass('刷新学校网页恢复同一节点、安装代次、监督周期、执行器与确认序号');
  await page.getByRole('button', { name: '停止会话' }).click();
  report.stop = await until(async () => fact(ok('stop-query', await api(currentPath))), query => query.state === 'cancelled' && query.statusKnowledge === 'confirmed', '同一桌面确认停止');
  fixed(original, report.stop);
  await page.getByRole('button', { name: /核对(?:状态|原操作)/ }).click();
  await until(processes, rows => !rows.some(row => row.pid === report.process.pid), '停止后原 PID 已从 OS 退出');
  report.stop.processPidGone = true;
  await until(nativeProcesses, rows => rows.length === 0, '停止后真实子进程退出');
  await page.screenshot({ path: join(output, 'channel-stopped.png'), fullPage: true });
  pass('学校面板停止同一桌面执行器且 OS 确认原生进程退出');
  const firstRequestId = acceptBody.action.requestId;
  await page.getByRole('button', { name: '开始新会话' }).click();
  await until(async () => acceptBody, value => value.action.requestId !== firstRequestId, '浏览器发出第二次启动请求');
  currentPath = `executions/${activityId}/${acceptBody.action.requestId}`;
  await until(async () => fact(ok('second-query', await api(currentPath))), query => query.state === 'running' && query.statusKnowledge === 'confirmed', '第二次会话真实启动');
  await page.getByRole('button', { name: /核对(?:状态|原操作)/ }).click();
  await expect(observation.locator('strong')).toHaveText('0', { timeout: 15_000 });
  report.revocation = { before: fact(ok('query', await api(currentPath))), pids: (await nativeProcesses()).map(row => row.pid) };
  assert.equal(report.revocation.pids.length, 1);
  const revokedAt = Date.now();
  ok('revoke', await api('connections/revoke', { connectionId }));
  await until(processes, rows => !rows.some(row => report.revocation.pids.includes(row.pid)), '撤销连接后原 PID 已从 OS 退出', 15_000);
  report.revocation.cleanupMs = Date.now() - revokedAt;
  report.revocation.processPidsGone = true;
  assert.equal((await nativeProcesses()).length, 0);
  const forbiddenQuery = await api(currentPath);
  const forbiddenControl = await api(currentPath + '/control', { controlId: randomUUID(), operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 1 } });
  report.revocation.queryStatus = forbiddenQuery.status;
  report.revocation.controlStatus = forbiddenControl.status;
  report.revocation.query = forbiddenQuery.status === 200 ? fact(forbiddenQuery.body) : { error: forbiddenQuery.body.error };
  assert.ok(forbiddenQuery.status >= 400 || forbiddenQuery.body.statusKnowledge === 'unknown');
  assert.ok(forbiddenControl.status >= 400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: payload.component.manifest.title, exact: true }).click();
  await page.screenshot({ path: join(output, 'channel-revoked.png'), fullPage: true });
  pass('学校撤销当前连接后拒绝继续控制，本机 worker 在 15 秒内清理真实子进程');
  const entries = await readdir(root);
  report.noLocalDatabase = { databaseJson: entries.includes('database.json'), pgdata: entries.includes('pgdata'),
    postgresProcesses: (await ownedProcesses()).filter(row => /postgres(?:\.exe)?(?:\s|$)/.test(row.command)).length };
  assert.deepEqual(report.noLocalDatabase, { databaseJson: false, pgdata: false, postgresProcesses: 0 });
  pass('remote profile 全流程未创建本地学习数据库或 PostgreSQL 进程');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  if (error?.cause?.code) report.cause = error.cause.code;
  if (report.mixedFallback?.status === 'running') {
    report.mixedFallback.status = 'failed';
    report.mixedFallback.error = report.error;
  }
  process.exitCode = 1;
  if (page) await page.screenshot({ path: join(output, 'channel-failed.png'), fullPage: true }).catch(() => {});
  if (mixedPage) await mixedPage.screenshot({ path: join(output, 'mixed-fallback-failed.png'), fullPage: true }).catch(() => {});
} finally {
  if (mixedPage && mixedPath) await api(mixedPath + '/stop', { stopId: randomUUID(), reason: '混合回退验收结束清理' }, mixedPage).catch(() => {});
  if (page && currentPath) await api(currentPath + '/stop', { stopId: randomUUID(), reason: '原生领取验收结束清理' }).catch(() => {});
  if (page && connectionId) await api('connections/revoke', { connectionId }).catch(() => {});
  await browser?.close().catch(() => {});
  await runtime.stop().catch(error => { report.cleanupError = error.message; });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'channel-report.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.mixedFallback) await writeFile(join(output, 'mixed-fallback.json'), JSON.stringify(report.mixedFallback, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: join(output, 'channel-report.json'), error: report.error }));
}
