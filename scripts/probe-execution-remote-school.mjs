import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, connect as connectTcp } from 'node:net';
import { chromium, expect } from '@playwright/test';

/**
 * Cross-machine acceptance for #175 on a client device.
 *
 * The client has no XunJie installation and no local database: a desktop Chrome opens the school
 * entry over strict HTTPS and runs the browser computation there. The certificate is pinned by
 * public-key hash instead of disabling verification. All bytes travel through a local TCP relay
 * that forwards to the real school node; severing the relay destroys real sockets, so the network
 * loss is a broken TCP link rather than a browser-level offline flag. SSH is used only to deploy
 * the node and to read its control credential for the withdrawal step.
 */
const args = Object.fromEntries(process.argv.slice(2).map(item => {
  const [key, ...rest] = item.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const state = JSON.parse(await readFile(args.state, 'utf8'));
const endpoint = args.endpoint ?? state.endpoint;
const spki = args.spki;
const label = args.label ?? process.platform;
const output = resolve(args.output ?? `.verification/wp03-175/${label}`);
if (!endpoint) throw new Error('state file must carry an endpoint');
await mkdir(output, { recursive: true });

const report = {
  kind: 'remote-school-browser-acceptance', ticket: '#175', label,
  platform: process.platform, arch: process.arch, node: process.version,
  startedAt: new Date().toISOString(), endpoint, cases: [], traffic: [], status: 'running',
};
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };

const target = new URL(endpoint);
const upstreamPort = Number(target.port || 443);
const upstreamHost = target.hostname;
if (/^(127\.|localhost$)/.test(upstreamHost)) throw new Error('a cross-machine probe needs a non-loopback endpoint');
const relayHost = '127.0.0.1';
const relayPort = Number(args['relay-port'] ?? upstreamPort);
let relay = null;
const tunnels = new Set();
async function openRelay() {
  const server = createServer(client => {
    const upstream = connectTcp({ host: upstreamHost, port: upstreamPort });
    const pair = { client, upstream };
    tunnels.add(pair);
    const forget = () => tunnels.delete(pair);
    client.on('close', () => { forget(); upstream.destroy(); });
    upstream.on('close', () => { forget(); client.destroy(); });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(relayPort, relayHost, () => ok()); });
  relay = server;
}
async function severRelay() {
  const severed = tunnels.size;
  for (const { client, upstream } of tunnels) { client.destroy(); upstream.destroy(); }
  tunnels.clear();
  const current = relay;
  relay = null;
  if (current) await new Promise(ok => current.close(ok));
  return severed;
}
report.relay = { mode: 'tcp-forward', upstream: `${upstreamHost}:${upstreamPort}`, local: `${relayHost}:${relayPort}` };

let browser;
try {
  await openRelay();
  browser = await chromium.launch({
    channel: 'chrome', headless: false,
    args: [...(spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : []),
      `--host-resolver-rules=MAP ${upstreamHost} ${relayHost}`,
      '--no-proxy-server', '--disable-quic', '--no-first-run', '--no-default-browser-check'],
  });
  report.browser = { product: 'Google Chrome', version: browser.version() };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, ignoreHTTPSErrors: false });
  const page = await context.newPage();
  page.on('pageerror', error => console.log('BROWSER ERROR ' + error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE ' + message.text().slice(0, 300)); });

  // Every API call runs inside the page, so Chrome's pinned TLS is the only TLS path used.
  const api = (route, body, headers = {}) => page.evaluate(async ({ route, body, headers }) => {
    const response = await fetch('/api/learning/' + route, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }, { route, body, headers });

  const record = (request, event) => {
    const url = request.url();
    if (!url.includes('/api/learning/executions/')) return;
    const method = request.method();
    const parts = new URL(url).pathname.split('/api/learning/executions/')[1].split('/');
    const body = method === 'POST' && request.postData() ? request.postDataJSON() ?? {} : {};
    report.traffic.push({ phase: report.phase ?? 'run', method,
      kind: parts[2] ?? (method === 'GET' ? 'query' : 'accept'), event,
      requestId: body?.action?.requestId ?? parts[1] ?? null });
  };
  page.on('request', request => record(request, 'attempt'));
  page.on('response', response => record(response.request(), response.ok() ? 'ok' : 'error'));

  await page.goto(endpoint + '/', { waitUntil: 'domcontentloaded' });
  const tls = await page.evaluate(() => ({ protocol: location.protocol, host: location.host }));
  if (tls.protocol !== 'https:') throw new Error('the school entry must be HTTPS');
  report.entry = tls;
  passed('the school entry loads over strict HTTPS with a pinned certificate');

  const login = await api('login', { loginName: state.loginName, password: state.password });
  report.loginStatus = login.status;
  if (login.status !== 200) throw new Error('login failed: ' + login.status);
  passed('a school-shared member signs in without any local product or database');

  const created = await api('course-activities', { requestId: crypto.randomUUID(), releaseId: state.releaseId });
  if (created.status !== 200) throw new Error('course activity failed: ' + created.status + ' ' + JSON.stringify(created.body));
  const activity = created.body;
  report.activityId = activity.activityId;

  report.phase = 'run';
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#activity-title')).toHaveText('学校入口浏览器计算', { timeout: 20000 });
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  const frame = page.frameLocator('iframe[title="表格聚合"]');
  await expect(frame.getByRole('heading', { name: '表格聚合', exact: true })).toBeVisible({ timeout: 20000 });
  await expect(frame.getByRole('textbox', { name: '得分 第1行', exact: true })).toHaveValue('88');
  passed('the component view renders in the remote school workspace');
  await page.screenshot({ path: join(output, 'remote-school-before.png'), fullPage: true });

  await frame.getByRole('button', { name: '运行计算', exact: true }).click();
  await expect(frame.locator('#summary')).toContainText('共 12 行、3 组', { timeout: 30000 });
  await expect(frame.locator('#groups')).toContainText('332');
  const panel = page.getByRole('region', { name: '计算记录' });
  await expect(panel).toContainText('已完成', { timeout: 20000 });
  passed('a real Worker/WASM run completes on the browser client');

  const requestId = report.traffic.filter(item => item.kind === 'accept' && item.requestId).at(-1)?.requestId;
  report.phase = 'query';
  const stored = requestId ? await api('executions/' + activity.activityId + '/' + requestId) : { status: 0, body: null };
  report.stored = { requestId, status: stored.status, state: stored.body?.state ?? null,
    executionRef: stored.body?.executionRef ?? null, output: stored.body?.output?.contentId ?? null };
  if (stored.body?.state !== 'succeeded') throw new Error('the school node did not confirm the run: ' + stored.status);
  passed('the original school node answers the query under its own learning-data owner');

  report.phase = 'stop';
  const stopped = await api('executions/' + activity.activityId + '/' + requestId + '/stop',
    { stopId: crypto.randomUUID(), reason: '跨机验收：原节点停止请求' });
  report.stop = { status: stopped.status, state: stopped.body?.state ?? null,
    executionRef: stopped.body?.executionRef ?? null };
  if (stopped.status !== 200 || stopped.body?.state !== 'succeeded'
    || stopped.body?.executionRef !== report.stored.executionRef)
    throw new Error('the original node stop changed the confirmed run: ' + JSON.stringify(report.stop));
  passed('a stop on the original node keeps the confirmed terminal state and the same execution reference');

  // A real link break: destroy the TCP tunnels and stop listening. No browser offline flag is used.
  report.phase = 'offline';
  report.relay.severedTunnels = await severRelay();
  await page.waitForTimeout(1200);
  const offline = await page.evaluate(async () => {
    try {
      await fetch('/api/learning/context', { cache: 'no-store' });
      return { reachable: true };
    } catch { return { reachable: false } };
  });
  report.offline = { ...offline, mechanism: 'tcp-tunnels-destroyed', severedTunnels: report.relay.severedTunnels };
  if (offline.reachable) throw new Error('the broken TCP link still reached the school node');
  await expect(panel).toContainText('已完成', { timeout: 10000 });
  passed('a broken TCP link neither moves the run nor rewrites its confirmed state');

  report.phase = 'reconnect';
  await openRelay();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click();
  await expect(page.getByRole('region', { name: '计算记录' })).toContainText('已完成', { timeout: 20000 });
  const readBack = await api('executions/' + activity.activityId + '/' + requestId);
  report.readBack = { status: readBack.status, state: readBack.body?.state ?? null,
    executionRef: readBack.body?.executionRef ?? null };
  if (readBack.body?.executionRef !== report.stored.executionRef || readBack.body?.state !== 'succeeded')
    throw new Error('reconnect returned a different run: ' + JSON.stringify(report.readBack));
  passed('reconnect re-queries the original node and the original execution reference');
  await page.screenshot({ path: join(output, 'remote-school-after.png'), fullPage: true });

  const control = args.control ? (await readFile(args.control, 'utf8')).trim() : state.controlToken;
  if (control) {
    report.phase = 'revocation';
    const headers = { authorization: `Bearer ${control}` };
    const revoke = await api('manage/course-access', { requestId: crypto.randomUUID(),
      courseId: state.courseId, principalId: state.principalId, active: false }, headers);
    if (revoke.status !== 200) throw new Error('course eligibility could not be withdrawn: ' + revoke.status);
    const refused = await api('executions/' + activity.activityId + '/' + requestId);
    report.revocation = { withdrawStatus: revoke.status, readStatusAfter: refused.status,
      readError: refused.body?.error ?? null };
    if (refused.status !== 403) throw new Error('read after withdrawal was not refused: ' + refused.status);
    passed('withdrawing course eligibility makes the original node refuse the result read');
    const restore = await api('manage/course-access', { requestId: crypto.randomUUID(),
      courseId: state.courseId, principalId: state.principalId, active: true }, headers);
    if (restore.status !== 200) throw new Error('course eligibility could not be restored: ' + restore.status);
    const readable = await api('executions/' + activity.activityId + '/' + requestId);
    report.revocation.readStatusRestored = readable.status;
    if (readable.status !== 200 || readable.body?.executionRef !== report.stored.executionRef)
      throw new Error('restoring eligibility did not restore the original read: ' + readable.status);
    passed('restoring eligibility returns the original run, not a new execution');
  }

  report.status = 'passed';
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await writeFile(join(output, 'remote-school.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close().catch(() => {});
  if (relay) await severRelay();
}
