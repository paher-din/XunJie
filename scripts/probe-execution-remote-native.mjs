import { probeEvidenceDirectory, writeEvidence, captureEvidence, hasProbeEvidence } from './lib/probe-evidence.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, connect } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const platform = args.platform;
if (!args.state || !args.spki || !['macos-arm64', 'windows-x64'].includes(platform))
  throw new Error('usage: --state=FILE --endpoint=HTTPS_URL --spki=HASH --platform=macos-arm64|windows-x64 [--output=DIR]');
const actualPlatform = `${process.platform}-${process.arch}`;
if (actualPlatform !== ({ 'macos-arm64': 'darwin-arm64', 'windows-x64': 'win32-x64' })[platform])
  throw new Error('platform does not match the actual client device');
const state = JSON.parse(await readFile(args.state, 'utf8'));
const target = new URL(args.endpoint ?? state.endpoint);
if (target.protocol !== 'https:' || /^(localhost$|127\.|\[?::1\]?$)/.test(target.hostname))
  throw new Error('a cross-machine probe requires a non-loopback HTTPS school endpoint');
const output = probeEvidenceDirectory(args.output);
await mkdir(output, { recursive: true });
const report = { kind: 'remote-native-browser-acceptance', ticket: '#175', platform,
  actualPlatform, startedAt: new Date().toISOString(), endpoint: target.origin,
  status: 'running', cases: [], traffic: [] };
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const tunnels = new Set();
let relay, browser, page, executionPath, stopConfirmed = false;
const relayPort = Number(target.port || 443);
report.relay = { mode: 'tcp-forward', upstream: `${target.hostname}:${relayPort}`, local: `127.0.0.1:${relayPort}` };
async function openRelay() {
  const server = createServer(client => {
    const upstream = connect({ host: target.hostname, port: relayPort });
    const pair = { client, upstream };
    tunnels.add(pair);
    client.on('close', () => { tunnels.delete(pair); upstream.destroy(); });
    upstream.on('close', () => { tunnels.delete(pair); client.destroy(); });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(relayPort, '127.0.0.1', ok); });
  relay = server;
}
async function severRelay() {
  const count = tunnels.size;
  for (const { client, upstream } of tunnels) { client.destroy(); upstream.destroy(); }
  tunnels.clear();
  const current = relay; relay = null;
  if (current) await new Promise(ok => current.close(ok));
  return count;
}
const api = (route, body) => page.evaluate(async ({ route, body }) => {
  const response = await fetch('/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}, { route, body });
const ok = (name, response) => {
  if (response.status !== 200) throw new Error(`${name}: HTTP ${response.status}, ${response.body?.error ?? 'request refused'}`);
  return response.body;
};
const executionFact = value => ({ executionRef: value.executionRef, state: value.state,
  statusKnowledge: value.statusKnowledge, nodeId: value.session?.nodeId,
  installGeneration: value.session?.installGeneration, supervisorEpoch: value.session?.supervisorEpoch,
  executorInstanceId: value.session?.executorInstanceId, observation: value.session?.observation });
const fixedFields = ['executionRef', 'nodeId', 'installGeneration', 'supervisorEpoch', 'executorInstanceId'];
function fixed(original, next) {
  for (const field of fixedFields) if (!original[field] || next[field] !== original[field])
    throw new Error(`original execution identity changed or was absent: ${field}`);
}
try {
  await openRelay();
  browser = await chromium.launch({ channel: 'chrome', headless: false, args: [
    `--ignore-certificate-errors-spki-list=${args.spki}`,
    `--host-resolver-rules=MAP ${target.hostname} 127.0.0.1`,
    '--no-proxy-server', '--disable-quic', '--no-first-run', '--no-default-browser-check'] });
  report.browser = { product: 'Google Chrome', version: browser.version(), headless: false, ignoreHTTPSErrors: false };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false });
  page = await context.newPage();
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/learning/executions/'))
      report.traffic.push({ method: response.request().method(), path: url.pathname, status: response.status() });
  });
  await page.goto(target.origin, { waitUntil: 'domcontentloaded' });
  if (await page.evaluate(() => location.protocol) !== 'https:') throw new Error('school entry is not HTTPS');
  passed('桌面 Chrome 通过限定 SPKI 的严格 HTTPS 访问跨机学校节点');
  const clientFacts = await page.evaluate(async () => {
    if (!navigator.userAgentData?.getHighEntropyValues) throw new Error('Chrome UAData platform facts are unavailable');
    const ua = await navigator.userAgentData.getHighEntropyValues(['platform', 'architecture', 'bitness']);
    return { ua: { platform: ua.platform, architecture: ua.architecture, bitness: ua.bitness },
      browser: { worker: typeof Worker === 'function', webassembly: typeof WebAssembly === 'object',
        sandboxedFrame: 'sandbox' in document.createElement('iframe') } };
  });
  const measuredPlatform = clientFacts.ua.platform === 'macOS' && clientFacts.ua.architecture === 'arm' && clientFacts.ua.bitness === '64'
    ? 'macos-arm64' : clientFacts.ua.platform === 'Windows' && clientFacts.ua.architecture === 'x86' && clientFacts.ua.bitness === '64'
      ? 'windows-x64' : null;
  report.clientFacts = { ...clientFacts, measuredPlatform, source: 'Chrome-UAData-and-browser-feature-detection' };
  if (measuredPlatform !== platform) throw new Error('Chrome UAData platform does not match the actual probe device');
  ok('login', await api('login', { loginName: state.loginName, password: state.password }));
  const release = ok('release', await api(`releases/${state.releaseId}`));
  const binding = release.components?.find(item => item.key === 'accumulator');
  if (!binding?.definition?.manifest?.session) throw new Error('published release has no native accumulator session');
  const manifest = binding.definition.manifest, session = manifest.session;
  if (session.adapterId !== 'linux-proc-accumulator' || session.adapterVersion !== 1)
    throw new Error('this cross-machine acceptance requires the published Linux-only procfs experiment');
  const plan = release.executionPlan;
  if (!plan?.locations?.includes('native') || plan.remote?.nodeClass !== 'school-execution-node'
    || plan.remote.secureTransport !== true || plan.remote.adapter.adapterId !== session.adapterId
    || plan.remote.adapter.adapterVersion !== session.adapterVersion || !plan.remote.clientPlatforms.includes(measuredPlatform))
    throw new Error('the published course plan does not permit this client and adapter on a secure school execution node');
  report.publishedPlan = { planId: plan.planId, planDigest: plan.planDigest, locations: plan.locations, remote: plan.remote };
  const environment = ok('execution-environment', await api('execution-environment'));
  const adapter = environment.adapters?.find(item => item.adapterId === session.adapterId && item.adapterVersion === session.adapterVersion);
  report.adapterRegistry = adapter ?? null;
  if (!adapter || JSON.stringify(adapter.platforms) !== '["linux-x64"]' || adapter.platforms.includes(measuredPlatform))
    throw new Error('the product registry does not prove this adapter is unsupported on the measured client platform');
  const device = { platform: measuredPlatform, browser: clientFacts.browser,
    native: { supported: false, installed: false, authorized: false, prepared: 'none' } };
  report.device = device;
  report.unsupportedBasis = { adapterId: session.adapterId, adapterVersion: session.adapterVersion,
    source: 'authenticated-product-adapter-registry', supportedPlatforms: adapter.platforms, measuredClientPlatform: measuredPlatform };
  passed('Chrome UAData 实测平台与产品 registry 证实客户端不支持 Linux 专属 procfs 适配器');
  const activity = ok('activity', await api('course-activities', { requestId: randomUUID(), releaseId: state.releaseId }));
  report.activityId = activity.activityId;
  await page.goto(`${target.origin}/?space=school&activity=${encodeURIComponent(activity.activityId)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: manifest.title, exact: true }).click();
  await page.frameLocator(`iframe[title="${manifest.title}"]`).locator('body').waitFor({ state: 'visible' });
  await captureEvidence(page, { path: join(output, 'native-before.png'), fullPage: true });
  const requestId = randomUUID();
  const action = { protocolVersion: 2, kind: 'execution', requestId,
    scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId,
      principalId: activity.identity.principalId, activityId: activity.activityId },
    receiver: { receiverId: 'school-native-execution', location: 'remote', kind: 'execution' },
    execution: {
      device,
      instance: { instanceId: `${activity.activityId}:accumulator`, key: 'accumulator', componentId: manifest.componentId,
        componentVersion: manifest.version, definitionDigest: binding.definition.digest,
        hostApiVersion: manifest.hostApiVersion, stateVersion: manifest.stateVersion },
      operation: { operationId: session.operation.operationId, effect: 'input' }, parameters: {},
      basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
      limits: { timeMs: session.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: session.budgets.inputBytes,
        outputBytes: session.budgets.outputBytes, concurrentJobs: session.budgets.concurrentSessions, queuedJobs: session.budgets.queuedSessions },
      plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
        planDigest: digest({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId,
          componentVersion: manifest.version, operationId: session.operation.operationId }) },
      session: { adapterId: session.adapterId, adapterVersion: session.adapterVersion,
        limits: { operationTimeoutMs: session.budgets.operationTimeoutMs, idleMs: session.budgets.idleMs,
          maxMs: session.budgets.maxMs, memoryMiB: session.budgets.memoryMiB,
          concurrentSessions: session.budgets.concurrentSessions, queuedSessions: session.budgets.queuedSessions } },
      initiator: { kind: 'student', principalId: activity.identity.principalId },
    } };
  const base = `executions/${activity.activityId}`;
  executionPath = `${base}/${requestId}`;
  const accepted = executionFact(ok('accept', await api(base, { action })));
  report.accepted = accepted;
  if (accepted.state !== 'running') throw new Error('native session did not start running');
  const observations = [accepted.observation];
  for (const [value, expectedSeq] of [[1, 0], [2, 1], [2, 2]]) {
    const response = executionFact(ok('control', await api(`${executionPath}/control`, {
      controlId: randomUUID(), operationId: session.operation.operationId, effect: 'input', expectedSeq, parameters: { value } })));
    fixed(accepted, response); observations.push(response.observation);
  }
  report.observations = observations;
  if (JSON.stringify(observations.map(item => item.value)) !== '[0,1,3,1]'
    || JSON.stringify(observations.map(item => item.applied)) !== '[0,1,2,3]') throw new Error('native observations or applied sequence differ');
  if (observations.some(item => !Number.isInteger(item.pid) || item.pid <= 0
    || !Number.isInteger(item.threads) || item.threads <= 0 || item.pid !== observations[0].pid))
    throw new Error('Linux procfs observations lack a consistent real process pid or positive thread count');
  report.procfs = { source: '/proc/self/status', pid: observations[0].pid,
    threadCounts: observations.map(item => item.threads) };
  passed('学校 Linux 原生会话真实控制 1、2、2 得到 1、3、1，并持续观察同一 procfs PID 与线程数');
  const queried = executionFact(ok('query', await api(executionPath)));
  fixed(accepted, queried); report.queried = queried;
  passed('查询固定到原节点、安装代次、监督周期与同一原生执行器');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: manifest.title, exact: true }).click();
  const observationPanel = page.getByRole('region', { name: '原生会话', exact: true }).locator('.native-session-observation');
  await expect(observationPanel).toContainText(`进程 PID ${report.procfs.pid}；线程数`, { timeout: 15000 });
  await expect(observationPanel).toContainText('已确认 3 次');
  report.uiObservation = await observationPanel.innerText();
  await captureEvidence(page, { path: join(output, 'native-running.png'), fullPage: true });
  passed('真实原生会话面板展示已确认输入次数、Linux 进程 PID 与线程数');
  report.offline = { mechanism: 'tcp-sockets-destroyed', severedTunnels: await severRelay() };
  if (!report.offline.severedTunnels) throw new Error('no actual TLS TCP tunnels existed to sever');
  report.offline.reachable = await page.evaluate(async () => {
    try { await fetch('/api/learning/context', { cache: 'no-store', signal: AbortSignal.timeout(5000) }); return true; }
    catch { return false; }
  });
  if (report.offline.reachable) throw new Error('school node remained reachable after TCP disconnect');
  await captureEvidence(page, { path: join(output, 'native-disconnected.png'), fullPage: true });
  await openRelay();
  const reconnected = executionFact(ok('reconnect-query', await api(executionPath)));
  fixed(accepted, reconnected); report.reconnected = reconnected;
  if (reconnected.state !== 'running' || reconnected.observation.applied !== 3 || reconnected.observation.value !== 1
    || reconnected.observation.pid !== report.procfs.pid || reconnected.observation.threads <= 0)
    throw new Error('reconnect changed the live native state or repeated a control');
  passed('真实 TCP 断连与重连保留原运行会话及 applied=3，不重放控制');
  const stopped = ok('stop', await api(`${executionPath}/stop`, { stopId: randomUUID(), reason: '跨机原生会话验收停止' }));
  report.stop = { stopRequested: stopped.stopRequested, ...executionFact(stopped) };
  const cancelled = executionFact(ok('cancelled-query', await api(executionPath)));
  fixed(accepted, cancelled); report.cancelled = cancelled;
  if (!stopped.stopRequested || cancelled.state !== 'cancelled' || cancelled.statusKnowledge !== 'confirmed')
    throw new Error('running native session cancellation was not confirmed');
  stopConfirmed = true;
  passed('停止运行中的原生会话后，原节点确认 cancelled');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: manifest.title, exact: true }).click();
  await page.frameLocator(`iframe[title="${manifest.title}"]`).locator('body').waitFor({ state: 'visible' });
  await expect(observationPanel).toContainText(`进程 PID ${report.procfs.pid}；线程数`, { timeout: 15000 });
  await expect(observationPanel).toContainText('已确认 3 次');
  await captureEvidence(page, { path: join(output, 'native-after.png'), fullPage: true });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (executionPath && !stopConfirmed && page) {
    try {
      if (!relay) await openRelay();
      const cleanup = await api(`${executionPath}/stop`, { stopId: randomUUID(), reason: '验收失败清理' });
      report.cleanup = { status: cleanup.status, state: cleanup.body?.state };
    } catch { report.cleanup = { status: 'unreachable' }; }
  }
  report.finishedAt = new Date().toISOString();
  await writeEvidence(join(output, 'remote-native.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close().catch(() => {});
  if (relay) await severRelay();
  console.log(JSON.stringify({ status: report.status, report: !hasProbeEvidence(output) ? null : join(output, 'remote-native.json'), error: report.error }));
}
