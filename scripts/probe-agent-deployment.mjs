// Explicit real-provider/product acceptance. SSH carries control only, never product traffic.
import assert from 'node:assert/strict';
import { parseArgs, promisify } from 'node:util';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir, tmpdir, hostname, platform, arch, release } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';

const { values: args } = parseArgs({ options: {
  mode: { type: 'string', default: 'preflight' }, product: { type: 'string' }, out: { type: 'string' },
  'credentials-file': { type: 'string', default: join(homedir(), '.config/magpie/providers.json') },
  protocol: { type: 'string', default: 'chat-completions' }, ssh: { type: 'string', default: 'win' },
  'ssh-config': { type: 'string' }, 'remote-product': { type: 'string' }, 'remote-script': { type: 'string' },
  'remote-ca': { type: 'string' }, 'lan-host': { type: 'string' }, certificate: { type: 'string' }, key: { type: 'string' },
  'budget-file': { type: 'string' }, 'max-generations': { type: 'string', default: '40' }, 'budget-reason': { type: 'string' }, 'chrome-job': { type: 'string' }, 'windows-playwright': { type: 'string', default: 'D:/XunJie-acceptance/wp07-203/browser/node_modules/playwright/index.mjs' }, worker: { type: 'boolean' }, help: { type: 'boolean' },
} });
const exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(done => setTimeout(done, ms));
const limits = { maxGenerations: Number(args['max-generations']), maxOutputTokens: 2048, timeoutMs: 60000, retries: 0 };
check(Number.isSafeInteger(limits.maxGenerations) && limits.maxGenerations > 0, 'invalid-generation-limit');
const routes = { 'chat-completions': ['/v1', '/chat/completions'], responses: ['/v1', '/responses'], messages: ['/anthropic', '/v1/messages'] };
if (args.help) {
  console.log(`Usage: node scripts/probe-agent-deployment.mjs --mode preflight|local|school|agent|cross|windows-agent --product DIR --out FILE
  [--credentials-file PRIVATE_JSON] [--protocol chat-completions|responses|messages] [--max-generations TOTAL --budget-reason TEXT]
  cross: --ssh win --remote-product WINDOWS_DIR --remote-script WINDOWS_FILE --remote-ca WINDOWS_PEM --lan-host MAC_LAN_IP --certificate PEM --key PEM
  --worker --product DIR: task-owned SSH JSON-lines device control; reads secrets from stdin, never command arguments.
No builds. Every execution creates and deletes isolated product roots. Preflight performs GET /models only.
local = all owners in local profile; school = school profile; agent = separate Agent on same host;
cross = macOS separate Agent + school, Windows model owner, direct HTTPS LAN; no tunnel.
Course/browser operation must enter a durable Wait before Chrome executes the real WASM component.`);
  process.exit(0);
}
function safe(error) { return error?.code ?? (error instanceof assert.AssertionError ? 'acceptance-assertion' : error?.name ?? 'unknown'); }
function check(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }
async function credential() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim();
  const document = JSON.parse(await readFile(resolve(args['credentials-file']), 'utf8'));
  const provider = document.providers?.find(item => /deepseek/i.test(item.preset ?? item.name ?? '') && item.key);
  check(provider, 'deepseek-credential-not-configured'); return provider.key;
}
async function providerHealth(key) {
  return new Promise((done, reject) => {
    const request = https.get('https://api.deepseek.com/models', { headers: { authorization: 'Bearer ' + key }, timeout: 15000 }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes));
      response.on('end', () => {
        let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { /* report status only */ }
        done({ httpStatus: response.statusCode, selectedModelPresent: body?.data?.some(item => item.id === 'deepseek-flash') ?? false, generations: 0 });
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('health-timeout'), { code: 'health-timeout' })));
    request.on('error', reject);
  });
}
async function product(directory) {
  const root = resolve(directory), bytes = await readFile(join(root, 'distribution.json'));
  const distribution = JSON.parse(bytes), manifest = JSON.parse(await readFile(join(root, 'resources.json')));
  const resources = Object.fromEntries(Object.entries(manifest).map(([key, value]) => [key,
    typeof value === 'string' && /(?:Path|Bin|Root|Helper)$/.test(key) ? resolve(root, value) : value]));
  const module = await import(pathToFileURL(join(root, 'app/product-runtime.js')).href);
  const application = await readFile(join(root, 'app/product-runtime.js'));
  const applicationText = application.toString('utf8');
  return { root, resources, module, fact: { platform: distribution.platform, profile: distribution.profile, createdAt: distribution.createdAt,
    distributionSha256: hash(bytes), applicationSha256: hash(application),
    schemaMarkers: { model13: applicationText.includes('model-owned-origin-journals'),
      model14: applicationText.includes('root-owned-device-model-choices'),
      model15: applicationText.includes('fixed-owner-device-grant-revocations'),
      learning20: applicationText.includes('agent-execution-owner-cleanup-origins'),
      terminalModelClosesSegment: /closed:\s+segment\d*\.closed\s+\|\|\s+fact\d*\.state !== ["']completed["']/.test(applicationText) },
    nodeVersion: (await exec(resources.nodePath, ['--version'])).stdout.trim(),
    postgresVersion: (await exec(join(resources.postgresBin, process.platform === 'win32' ? 'postgres.exe' : 'postgres'), ['--version'])).stdout.trim() } };
}
async function relayProvider(maximum = limits.maxGenerations) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (!['/v1/chat/completions', '/v1/responses', '/anthropic/v1/messages'].includes(request.url)
      || request.method !== 'POST' || requests.length >= maximum) {
      response.writeHead(429); response.end(); return;
    }
    const row = { index: requests.length + 1, path: request.url, startedAt: new Date().toISOString(), status: null, senderPlatform: process.platform, senderHost: hostname() };
    requests.push(row); const started = Date.now();
    const upstream = https.request({ hostname: 'api.deepseek.com', servername: 'api.deepseek.com', path: request.url, method: 'POST',
      headers: { ...request.headers, host: 'api.deepseek.com' }, timeout: limits.timeoutMs }, incoming => {
      row.status = incoming.statusCode; response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
      let pending = '';
      incoming.on('data', () => { row.firstProviderChunkMs ??= Date.now() - started; });
      const encoding = incoming.headers['content-encoding'];
      const decoded = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress()
        : encoding === 'deflate' ? createInflate() : incoming;
      if (decoded !== incoming) { decoded.on('error', () => {}); incoming.pipe(decoded); }
      decoded.on('data', bytes => {
        if (row.firstTextDeltaMs !== undefined && row.firstToolDeltaMs !== undefined) return;
        pending = (pending + bytes.toString('utf8')).slice(-65536);
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const event = JSON.parse(line.slice(5));
            if (event.choices?.some(choice => choice.delta?.tool_calls?.length)
              || event.type === 'response.function_call_arguments.delta'
              || event.type === 'content_block_start' && event.content_block?.type === 'tool_use')
              row.firstToolDeltaMs ??= Date.now() - started;
            if (event.choices?.some(choice => typeof choice.delta?.content === 'string' && choice.delta.content.length)
              || event.type === 'response.output_text.delta' && event.delta
              || event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text)
              row.firstTextDeltaMs ??= Date.now() - started;
          } catch { /* No raw provider content or private reasoning is recorded. */ }
        }
      });
      incoming.on('end', () => { row.elapsedMs = Date.now() - started; row.streamEndObserved = true; });
      incoming.on('close', () => { row.connectionClosedMs = Date.now() - started; row.streamEndObserved ??= false; if (decoded !== incoming) decoded.destroy(); });
    });
    const deadline = setTimeout(() => { row.error = 'provider-deadline'; upstream.destroy(); }, limits.timeoutMs);
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', error => { row.error = safe(error); if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => { clearTimeout(deadline); upstream.destroy(); }); request.pipe(upstream);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests,
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}
async function api(endpoint, route, body, headers = {}) {
  const response = await fetch(endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', ...headers },
    redirect: 'error', signal: AbortSignal.timeout(30000),
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const value = await response.json();
  check(response.status === 200, 'api-' + route.split('/')[0] + '-http-' + response.status);
  return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function worker() {
  check(args.product, 'worker-product-required');
  if (args.certificate) {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), await readFile(resolve(args.certificate), 'utf8')]);
    process.env.NODE_EXTRA_CA_CERTS = resolve(args.certificate);
  }
  const pkg = await product(args.product), root = await mkdtemp(join(tmpdir(), 'xj-wp07-203-owner-'));
  const runtime = pkg.module.openProductRuntime({ root, resources: pkg.resources });
  let endpoint, relay, installed = false, settledWitness, activeProfile, proofDirectory;
  const lifecycle = { stopped: false, environmentDeleted: false, rootRemoved: false };
  async function handle(input) {
    if (input.operation === 'start') {
      check(!installed, 'already-installed');
      activeProfile = input.profile ?? 'model';
      check(['model', 'agent'].includes(activeProfile), 'worker-profile-forbidden');
      if (activeProfile === 'agent') check(input.generationLimit === 0, 'agent-platform-check-must-disable-generation');
      else relay = await relayProvider(input.generationLimit);
      await runtime.install({ profile: activeProfile }); installed = true;
      const state = await runtime.start(); endpoint = state.endpoint;
      return { state, root, host: hostname(), platform: process.platform, osRelease: release(), package: pkg.fact, providerEndpoint: relay?.endpoint ?? null };
    }
    if (input.operation === 'status') return runtime.status();
    if (input.operation === 'stop') { await runtime.stop(); lifecycle.stopped = true; return runtime.status(); }
    if (input.operation === 'agent-platform-proof') {
      check(activeProfile === 'agent' && installed, 'agent-proof-requires-agent-profile');
      const configuration = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'));
      const binding = await runtime.database();
      check(configuration.database.mode === 'managed' && binding, 'agent-managed-postgres-missing');
      proofDirectory = await mkdtemp(join(tmpdir(), 'xj-wp07-203-agent-proof-'));
      // Public recovery manifest proves the live production owner/schema, without SQL inspection
      // or leaking a database binding/credential. No model capability is configured or called.
      const recoveryKeyRef = 'wp07-agent-proof-' + randomUUID();
      await runtime.setCredential(recoveryKeyRef, randomBytes(32).toString('base64'));
      const manifest = await runtime.recovery.backup({ directory: proofDirectory, recoveryKeyRef });
      const schemas = manifest.services.map(item => ({ serviceId: item.serviceId, schemaVersion: item.schemaVersion }));
      const state = await runtime.status();
      const service = state.environment.services.find(item => item.unit === 'teaching-agent');
      check(schemas.some(item => item.serviceId === service.serviceId && /owner\/\d+/.test(item.schemaVersion)), 'agent-owner-migration-not-proven');
      return { managedPostgres: true, databasePort: binding.port, ownerSchemas: schemas,
        backupId: manifest.backupId, configuredDependency: !!configuration.agent?.dependencyConnectionId,
        afterProofState: state.state };
    }
    if (input.operation === 'api') return api(endpoint, input.route, input.body, input.headers);
    if (input.operation === 'admin-api') return api(endpoint, input.route, input.body,
      { authorization: 'Bearer ' + await pkg.module.resolveCredential(root, 'control') });
    if (input.operation === 'connect') { await runtime.connect(input.connection, input.token); return { connected: true }; }
    if (input.operation === 'witness') return settledWitness ?? { platform: process.platform, host: hostname(), requests: relay?.requests ?? [], providerRelayClosed: false };
    if (input.operation === 'cleanup') {
      let errorCode;
      try {
        if (installed) {
          const state = await runtime.status(); await runtime.stop(); lifecycle.stopped = true;
          for (let retry = 0; ; retry++) {
            try { await runtime.deleteEnvironment({ environmentId: state.environment.environmentId }); break; }
            catch (error) {
              if (process.platform !== 'win32' || retry >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
              await delay(200 * (retry + 1));
            }
          }
          installed = false; lifecycle.environmentDeleted = true;
        }
      } catch (error) { errorCode = safe(error); }
      // Stop the paid relay even when data deletion fails. This final witness counts actual
      // external requests, independently from the directory cleanup outcome.
      const requests = relay?.requests ?? settledWitness?.requests ?? [];
      await relay?.close(); relay = undefined;
      settledWitness = { platform: process.platform, host: hostname(), requests, providerRelayClosed: true };
      if (!installed) {
        try {
          await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
          if (proofDirectory) await rm(proofDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
          lifecycle.rootRemoved = true;
        } catch (error) { errorCode ??= safe(error); }
      }
      return { ...lifecycle, ...(errorCode ? { error: errorCode } : {}), witness: settledWitness };
    }
    throw Object.assign(new Error('unknown-operation'), { code: 'unknown-operation' });
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try { for await (const line of lines) {
    let input;
    try { input = JSON.parse(line); const result = await handle(input); console.log(JSON.stringify({ id: input.id, ok: true, result })); }
    catch (error) { console.log(JSON.stringify({ id: input?.id, ok: false, code: safe(error) })); }
  } } finally { await handle({ operation: 'cleanup' }); }
}
async function chromeJob(path) {
  const job = JSON.parse(await readFile(path, 'utf8'));
  let browser;
  const result = { platform: process.platform, status: 'running' };
  try {
    check(process.platform === 'win32', 'windows-chrome-required');
    const { chromium } = await import(pathToFileURL(job.playwrightModule).href);
    browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--ignore-certificate-errors-spki-list=' + job.spki] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    if (!job.preflight) {
      const [name, ...value] = job.cookie.split('=');
      await context.addCookies([{ name, value: value.join('='), url: job.endpoint }]);
    }
    const page = await context.newPage();
    if (job.preflight) {
      await page.goto('about:blank'); await page.screenshot({ path: job.screenshot });
      const session = await exec('powershell.exe', ['-NoProfile', '-Command', '[System.Diagnostics.Process]::GetCurrentProcess().SessionId']);
      result.desktopSessionId = Number(session.stdout.trim()); check(result.desktopSessionId > 0, 'chrome-ran-in-session-zero');
      result.status = 'passed'; result.browserVersion = browser.version(); result.modelRequests = 0;
      return;
    }
    await page.goto(job.endpoint + '/?space=school&activity=' + job.activityId);
    await page.getByRole('button', { name: '打开对话', exact: true }).click({ timeout: 30000 });
    const conversation = () => page.evaluate(async activityId => {
      const response = await fetch('/api/learning/agent/' + activityId + '/conversation', { headers: { 'x-xj-space': 'school' } });
      if (!response.ok) throw new Error('conversation-http-' + response.status);
      return response.json();
    }, job.activityId);
    const deadline = Date.now() + 180000; let final;
    while (Date.now() < deadline) {
      final = await conversation();
      const run = final.runs.find(item => item.runId === job.runId);
      if (run?.state === 'completed') break;
      check(!['failed', 'stopped', 'paused'].includes(run?.state), 'windows-run-' + run?.state);
      await delay(500);
    }
    check(final?.runs.some(run => run.runId === job.runId && run.state === 'completed'), 'windows-conversation-timeout');
    await page.screenshot({ path: job.screenshot, fullPage: true });
    await page.reload();
    await page.getByRole('button', { name: '打开对话', exact: true }).click({ timeout: 30000 });
    const reloaded = await conversation(); assert.deepEqual(reloaded, final);
    result.status = 'passed'; result.browserVersion = browser.version(); result.userAgent = await page.evaluate(() => navigator.userAgent);
    result.reloadedSameConversation = true; result.runId = job.runId; result.finalDigest = hash(JSON.stringify(final));
    const session = await exec('powershell.exe', ['-NoProfile', '-Command', '[System.Diagnostics.Process]::GetCurrentProcess().SessionId']);
    result.desktopSessionId = Number(session.stdout.trim()); check(result.desktopSessionId > 0, 'chrome-ran-in-session-zero');
  } catch (error) { result.status = 'failed'; result.error = safe(error); }
  finally { await browser?.close().catch(() => {}); await writeFile(job.result, JSON.stringify(result)); }
}
if (args['chrome-job']) { await chromeJob(args['chrome-job']); process.exit(0); }
if (args.worker) { await worker(); process.exit(0); }
check(['preflight', 'local', 'school', 'agent', 'cross', 'windows-agent'].includes(args.mode), 'invalid-mode');
check(args.out, 'out-required'); check(routes[args.protocol], 'invalid-protocol');
const output = resolve(args.out); await mkdir(dirname(output), { recursive: true });
const report = { issue: 203, measuredAt: new Date().toISOString(), mode: args.mode, protocol: args.protocol,
  status: 'running', host: { name: hostname(), platform: platform(), arch: arch(), osRelease: release(), node: process.version },
  limits, stages: [], engineering: 'owned-by-mainline', browser: 'not-run', teachingEffect: 'not-assessed' };
async function persist() { await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
async function stage(name, action) {
  const row = { name, status: 'running', startedAt: new Date().toISOString() }; report.stages.push(row); await persist();
  try { const fact = await action(); Object.assign(row, { status: 'passed', fact }); return fact; }
  catch (error) { Object.assign(row, { status: 'failed', error: safe(error) }); throw error; }
  finally { row.finishedAt = new Date().toISOString(); await persist(); }
}
function sshArguments() { return [...(args['ssh-config'] ? ['-F', args['ssh-config']] : []), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', args.ssh]; }
function remoteDevice() {
  check(args['remote-product'] && args['remote-script'] && args['remote-ca'], 'remote-paths-required');
  for (const path of [args['remote-product'], args['remote-script'], args['remote-ca']]) check(!/["\r\n]/.test(path), 'invalid-remote-path');
  const remoteProduct = args['remote-product'].replaceAll('\\', '/');
  const launch = `& "${remoteProduct}/resources/node/node.exe" "${args['remote-script']}" --worker --product "${remoteProduct}" --certificate "${args['remote-ca']}"; exit $LASTEXITCODE`;
  const command = 'powershell -NoProfile -EncodedCommand ' + Buffer.from(launch, 'utf16le').toString('base64');
  const child = spawn('ssh', [...sshArguments(), command], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let exited = false;
  child.stderr.on('data', () => {});
  createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const entry = pending.get(value.id); if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    if (value.ok) entry.resolve(value.result); else entry.reject(Object.assign(new Error('remote-operation'), { code: value.code }));
  });
  child.on('error', () => { exited = true; });
  child.on('exit', () => { exited = true; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error('remote-exit'), { code: 'remote-exit' })); } pending.clear(); });
  return { call(operation, input = {}) {
    check(!exited, 'remote-exited'); return new Promise((resolveCall, reject) => {
      const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('remote-timeout'), { code: 'remote-timeout' })); }, 120000);
      pending.set(id, { resolve: resolveCall, reject, timer }); child.stdin.write(JSON.stringify({ id, operation, ...input }) + '\n');
    });
  }, close() { child.stdin.end(); } };
}
async function windowsPowerShell(script, input) {
  return new Promise((done, reject) => {
    const child = spawn('ssh', [...sshArguments(), 'powershell -NoProfile -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', () => {});
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('windows-control-timeout'), { code: 'windows-control-timeout' })); }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? done(stdout.trim()) : reject(Object.assign(new Error('windows-control-failed'), { code: 'windows-control-failed' })); });
    child.stdin.end(input ?? '');
  });
}
async function startWindowsChrome(job) {
  const directory = args['remote-script'].replaceAll('\\', '/').replace(/\/[^/]+$/, '');
  const id = randomUUID(), name = 'XunJie-WP07-203-Chrome-' + id;
  const files = { job: directory + '/' + id + '.job.json', result: directory + '/' + id + '.result.json', screenshot: directory + '/' + id + '.png' };
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const node = args['remote-product'].replaceAll('\\', '/') + '/resources/node/node.exe';
  const launch = '"' + args['remote-script'] + '" --chrome-job "' + files.job + '"';
  await windowsPowerShell(`$ErrorActionPreference='Stop';$data=[Console]::In.ReadToEnd();[IO.File]::WriteAllText(${quote(files.job)},$data);`
    + `$a=New-ScheduledTaskAction -Execute ${quote(node)} -Argument ${quote(launch)};`
    + `$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;`
    + `$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5);`
    + `Register-ScheduledTask -TaskName ${quote(name)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(name)}`,
    JSON.stringify({ ...job, playwrightModule: args['windows-playwright'], result: files.result, screenshot: files.screenshot }));
  return {
    async result() {
      for (let attempt = 0; attempt < 100; attempt++) {
        const text = await windowsPowerShell(`if(Test-Path ${quote(files.result)}){[IO.File]::ReadAllText(${quote(files.result)})}`);
        if (text) {
          const result = JSON.parse(text);
          if (result.status === 'passed') {
            const bytes = await windowsPowerShell(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${quote(files.screenshot)}))`);
            await writeFile(join(dirname(output), basename(output, '.json') + '-windows-chrome.png'), Buffer.from(bytes, 'base64'));
          }
          return result;
        }
        await delay(1500);
      }
      throw Object.assign(new Error('windows-chrome-timeout'), { code: 'windows-chrome-timeout' });
    },
    async close() {
      await windowsPowerShell(`$ErrorActionPreference='Stop';Stop-ScheduledTask -TaskName ${quote(name)} -ErrorAction SilentlyContinue;`
        + `Unregister-ScheduledTask -TaskName ${quote(name)} -Confirm:$false -ErrorAction SilentlyContinue;`
        + `Remove-Item -Force -ErrorAction SilentlyContinue ${Object.values(files).map(quote).join(',')}`);
    },
  };
}
let budget, lab, school, agent, device, browser, currentPage, windowsChrome, relay, schoolInstalled = false, agentInstalled = false;
try {
  const sourceCommit = await exec('git', ['rev-parse', 'HEAD']).catch(() => null);
  const sourceDiff = await exec('git', ['diff', '--', 'packages', 'apps'], { maxBuffer: 8 * 1024 * 1024 }).catch(() => null);
  report.source = { commit: sourceCommit?.stdout.trim() ?? null, trackedDiffSha256: sourceDiff ? hash(sourceDiff.stdout) : null,
    probeSha256: hash(await readFile(fileURLToPath(import.meta.url))) };
  let providerKey;
  if (args.mode !== 'windows-agent') {
    providerKey = await stage('private-provider-configured', async () => { await credential(); return { configured: true, secretRecorded: false }; }).then(() => credential());
    await stage('deepseek-authentication-without-generation', async () => {
      const fact = await providerHealth(providerKey); check(fact.httpStatus === 200, 'deepseek-health-' + fact.httpStatus); return fact;
    });
  }
  if (args.mode === 'windows-agent') {
    device = remoteDevice();
    await stage('windows-agent-install-start-degraded', async () => {
      const remote = await device.call('start', { profile: 'agent', generationLimit: 0 });
      check(remote.platform === 'win32', 'agent-platform-must-be-windows');
      assert.deepEqual(remote.state.environment.services.map(item => item.unit).sort(), ['client', 'teaching-agent']);
      check(remote.state.state === 'degraded', 'unconfigured-agent-must-be-degraded');
      check(remote.state.dependencies.some(item => item.name === 'PostgreSQL' && item.state === 'ready'), 'postgres-not-ready');
      check(remote.state.dependencies.some(item => item.name === 'agent-dependencies' && item.state === 'unavailable'), 'missing-dependency-not-reported');
      report.device = { platform: remote.platform, host: remote.host, osRelease: remote.osRelease,
        taskRoot: remote.root, environment: remote.state.environment, package: remote.package };
      return { state: remote.state.state, units: remote.state.environment.services.map(item => item.unit), dependencies: remote.state.dependencies };
    });
    await stage('windows-agent-status-and-owner-migrations', async () => {
      const state = await device.call('status'); check(state.state === 'degraded', 'agent-status-must-remain-degraded');
      const proof = await device.call('agent-platform-proof'); check(proof.managedPostgres && !proof.configuredDependency, 'agent-proof-mismatch');
      return proof;
    });
    await stage('windows-agent-stop', async () => {
      const state = await device.call('stop'); check(state.state === 'stopped', 'agent-stop-not-confirmed');
      return { state: state.state };
    });
    report.status = 'passed';
  } else if (args.mode === 'preflight') {
    await stage('windows-ssh', async () => {
      const script = `[pscustomobject]@{platform='win32';computer=[Environment]::MachineName;desktopUser=(Get-CimInstance Win32_ComputerSystem).UserName;session=[System.Diagnostics.Process]::GetCurrentProcess().SessionId;node=(& node --version)}|ConvertTo-Json -Compress`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const { stdout } = await exec('ssh', [...sshArguments(), 'powershell -NoProfile -EncodedCommand ' + encoded], { timeout: 20000 });
      const fact = JSON.parse(stdout); check(fact.platform === 'win32', 'not-windows'); return fact;
    });
    if (args.product) report.package = await stage('candidate-package', async () => (await product(args.product)).fact);
    report.status = 'prepared';
  } else {
    const budgetPath = resolve(args['budget-file'] ?? join(dirname(output), 'generation-budget.json'));
    let account;
    try { account = JSON.parse(await readFile(budgetPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; account = { limit: limits.maxGenerations, used: 0, runs: [] }; }
    check(Number.isInteger(account.used) && account.used >= 0 && account.used < limits.maxGenerations && !account.reservation, 'generation-budget-unavailable');
    if (account.limit !== limits.maxGenerations) {
      (account.limitChanges ??= []).push({ from: account.limit, to: limits.maxGenerations, reason: args['budget-reason'] ?? 'explicit-cli-limit', measuredAt: new Date().toISOString() });
      account.limit = limits.maxGenerations;
    }
    const remaining = limits.maxGenerations - account.used;
    budget = { path: budgetPath, account, remaining };
    account.reservation = { output, mode: args.mode, allocated: remaining, startedAt: new Date().toISOString() };
    await writeFile(budgetPath, JSON.stringify(account, null, 2) + '\n');
    report.budget = { usedBefore: account.used, available: remaining, limit: limits.maxGenerations };
    check(args.product, 'product-required');
    const pkg = await product(args.product); report.package = pkg.fact;
    check(process.execPath === pkg.resources.nodePath, 'run-with-packaged-node');
    const { openProductRuntime, resolveCredential } = pkg.module;
    lab = await mkdtemp(join(tmpdir(), 'xj-wp07-203-')); report.temporaryRoot = lab;
    school = openProductRuntime({ root: join(lab, 'school'), resources: pkg.resources });
    relay = await relayProvider(budget.remaining);
    const separate = ['agent', 'cross'].includes(args.mode), dependencyConnectionId = randomUUID();
    let shared = {};
    if (args.mode === 'cross') {
      check(process.platform === 'darwin' && args['lan-host'] && args.certificate && args.key, 'cross-mac-tls-required');
      const certificate = await readFile(resolve(args.certificate), 'utf8');
      tls.setDefaultCACertificates([...tls.getCACertificates('default'), certificate]);
      process.env.NODE_EXTRA_CA_CERTS = resolve(args.certificate);
      // Both addresses are direct LAN endpoints, never an SSH tunnel or localhost alias.
      check(!['localhost', '127.0.0.1', '::1'].includes(args['lan-host']), 'cross-requires-lan');
      const reserve = createServer(); await new Promise(done => reserve.listen(0, '0.0.0.0', done));
      const port = reserve.address().port; await new Promise(done => reserve.close(done));
      shared = { host: '0.0.0.0', port, publicEndpoint: `https://${args['lan-host']}:${port}`,
        tls: { certificateFile: resolve(args.certificate), keyFile: resolve(args.key) } };
    }
    await stage('install-and-start-school', async () => {
      await school.install({ profile: args.mode === 'local' ? 'local' : 'school', ...shared }); schoolInstalled = true;
      const state = await school.start(); report.school = state.environment; return { state: state.state, profile: state.environment.profile };
    });
    let state = await school.status(), endpoint = state.endpoint;
    const data = state.environment.services.find(service => service.unit === 'learning-data');
    const admin = { authorization: 'Bearer ' + await resolveCredential(join(lab, 'school'), 'control') };
    const loginName = 'wp07-203-' + randomUUID(), password = randomUUID();
    const identity = (await api(endpoint, 'manage/members', { requestId: randomUUID(), loginName, password }, admin)).value;
    const login = await api(endpoint, 'login', { loginName, password });
    const headers = { cookie: login.cookie, 'x-xj-space': 'school' };
    const schoolApi = async (route, body, actor = headers) => (await api(endpoint, route, body, actor)).value;
    if (separate) await stage('independent-agent-and-bidirectional-capabilities', async () => {
      agent = openProductRuntime({ root: join(lab, 'agent'), resources: pkg.resources });
      await agent.install({ profile: 'agent', agent: { dependencyConnectionId } }); agentInstalled = true;
      const remote = await agent.start(), target = remote.environment.services.find(service => service.unit === 'teaching-agent');
      const accept = await agent.authorize({ sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
        sourceInstallationId: state.environment.installationId, capabilities: ['teaching.agent'] }, target.serviceId);
      const connectionId = randomUUID();
      await school.connect({ connectionId, sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
        target, requiredCapabilities: ['teaching.agent'], optionalCapabilities: [], credentialRef: 'wp07-agent' }, accept.token);
      await schoolApi('manage/agent-binding', { requestId: randomUUID(), identity, connectionId, target, installationId: remote.environment.installationId }, admin);
      const grant = await school.authorize({ sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId,
        sourceInstallationId: remote.environment.installationId, capabilities: ['teaching.dependencies'] }, data.serviceId);
      await agent.connect({ connectionId: dependencyConnectionId, sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId,
        target: data, requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [], credentialRef: 'wp07-dependency' }, grant.token);
      report.agent = remote.environment;
      return { agent: target, dependencyGrantId: grant.grantId, acceptGrantId: accept.grantId, placement: 'same-mac-as-school' };
    });
    let modelApi = schoolApi, providerEndpoint = relay.endpoint, modelHeaders = headers, useOwner = 'self';
    if (args.mode === 'cross') await stage('windows-model-owner-pairing', async () => {
      device = remoteDevice(); const remote = await device.call('start', { generationLimit: budget.remaining });
      check(remote.platform === 'win32' && remote.host !== hostname(), 'not-cross-machine');
      const model = remote.state.environment.services.find(service => service.unit === 'model-connection');
      const connectionId = randomUUID(), runtimeConnectionId = randomUUID();
      await device.call('api', { route: 'client/start', body: { requestId: connectionId, schoolEndpoint: endpoint } });
      await schoolApi('connections/approve', { requestId: connectionId });
      await device.call('api', { route: 'client/complete', body: { requestId: connectionId } });
      const grant = await school.authorize({ sourceEnvironmentId: model.environmentId, sourceServiceId: model.serviceId,
        sourceInstallationId: remote.state.environment.installationId, capabilities: ['learning.authority'] });
      await device.call('connect', { connection: { connectionId: runtimeConnectionId, sourceEnvironmentId: model.environmentId,
        sourceServiceId: model.serviceId, target: state.environment.services[0], requiredCapabilities: ['learning.authority'],
        optionalCapabilities: [], credentialRef: 'wp07-model-authority' }, token: grant.token });
      const target = { environmentId: model.environmentId, serviceId: model.serviceId, version: 1 };
      await schoolApi('manage/model-device-binding', { identity, binding: { requestId: randomUUID(), expectedVersion: 0,
        owner: { environmentId: model.environmentId, serviceId: model.serviceId }, installationId: remote.state.environment.installationId,
        grantId: grant.grantId, connectionId } }, admin);
      await device.call('admin-api', { route: 'manage/model-binding', body: { connectionId, runtimeConnectionId, target } });
      modelApi = async (route, body, actor) => (await device.call('api', { route, body, headers: actor })).value;
      providerEndpoint = remote.providerEndpoint; useOwner = 'device';
      modelHeaders = { 'x-xj-space': 'school:' + connectionId };
      report.device = { platform: remote.platform, osRelease: remote.osRelease, host: remote.host, taskRoot: remote.root, package: remote.package,
        environment: remote.state.environment, source: model, runtimeGrantId: grant.grantId };
      return { directProductEndpoint: endpoint, devicePlatform: remote.platform, host: remote.host, traffic: 'direct HTTPS; SSH control only' };
    });
    const configuredModel = await stage('real-deepseek-selection', async () => {
      const connectionId = randomUUID(), grantId = randomUUID(), [prefix, path] = routes[args.protocol];
      const configuration = { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'WP07 203 real acceptance',
        protocol: args.protocol, baseUrl: providerEndpoint + prefix, path, modelId: 'deepseek-flash', dialect: 'deepseek',
        parameterMode: 'thinking', enabled: true, contextWindow: 262144, maxOutputTokens: limits.maxOutputTokens,
        credential: { action: 'replace', value: providerKey } };
      if (['school', 'agent'].includes(args.mode)) {
        await schoolApi('manage/model-default', { ...configuration,
          policy: { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: limits.maxOutputTokens, timeoutMs: Math.min(30000, limits.timeoutMs) } }, admin);
        return { modelConnectionId: connectionId, model: 'deepseek-flash', modelLocation: 'school-owner-on-Mac', selection: 'school-default' };
      }
      const rootBefore = args.mode === 'cross' ? await schoolApi('models/selection') : undefined;
      await modelApi('models/connections', configuration, args.mode === 'cross' ? { 'x-xj-space': 'personal' } : headers);
      await modelApi('models/grants', { requestId: randomUUID(), connectionId, grantId, owner: useOwner }, modelHeaders);
      if (args.mode === 'cross') {
        // The device actively publishes modelChoices on the existing learning.authority path.
        // Discover the same public options as school settings. Never warm via Agent capabilities,
        // copy a device pointer, write owner tables, or let discovery choose a Root default.
        const pointer = view => [view.selected?.kind ?? null, view.selected?.connection.connectionId ?? null, view.selected?.grantId ?? null];
        const discoveryStarted = Date.now(), deadline = discoveryStarted + 60000;
        let projection, choice;
        do {
          projection = await schoolApi('models/selection');
          check(projection.version === rootBefore.version && JSON.stringify(pointer(projection)) === JSON.stringify(pointer(rootBefore)),
            'device-publication-changed-root-pointer');
          choice = projection.options.find(item => item.kind === 'personal' && item.connection.connectionId === connectionId && item.grantId === grantId);
          if (choice) break;
          await delay(500);
        } while (Date.now() < deadline);
        check(choice, 'device-choice-not-published-to-root-settings');
        report.rootChoiceDiscovery = { endpoint: '/api/learning/models/selection', elapsedMs: Date.now() - discoveryStarted,
          rootVersion: projection.version, connectionId: choice.connection.connectionId, grantId: choice.grantId,
          origin: choice.origin, pointerPreserved: true, activePublicationOnly: true };
        const selected = await schoolApi('models/selection', { requestId: randomUUID(), expectedVersion: projection.version,
          source: { kind: 'personal', connectionId: choice.connection.connectionId, grantId: choice.grantId } });
        const confirmed = await schoolApi('models/selection');
        check(confirmed.version === projection.version + 1 && confirmed.version === selected.version && confirmed.selected?.kind === 'personal'
          && confirmed.selected.connection.connectionId === connectionId && confirmed.selected.grantId === grantId,
          'root-explicit-device-selection-not-confirmed');
        report.rootSelection = { version: confirmed.version, connectionId, grantId };
      } else {
        // Here modelApi is schoolApi: this is the Root's own explicit local selection.
        const current = await modelApi('models/selection', undefined, modelHeaders);
        await modelApi('models/selection', { requestId: randomUUID(), expectedVersion: current.version,
          source: { kind: 'personal', connectionId, grantId } }, modelHeaders);
      }
      return { modelConnectionId: connectionId, grantId, model: 'deepseek-flash', modelLocation: args.mode === 'cross' ? 'Windows' : 'Mac',
        ...(args.mode === 'cross' ? { rootChoiceDiscovery: report.rootChoiceDiscovery, rootSelection: report.rootSelection } : {}) };
    });
    const { aggregationPackage } = await import('../components/table-aggregation/package.mjs');
    const definition = await schoolApi('manage/component-import', { requestId: randomUUID(), ...await aggregationPackage() }, admin);
    const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
    await schoolApi('manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: 'WP07 真实部署验收' },
      task: { taskId, title: '按组核对真实平均分', summary: '' }, release: { releaseId, objectives: ['核对原始执行结果'],
        requirements: '按小组聚合得分平均值，解释实际结果。', materials: [], starterWorks: [], capabilities: [],
        helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
        components: [{ key: 'table', definition, configuration: { title: '真实表格聚合' }, materialIds: [] }] }, resources: [] }, admin);
    await schoolApi('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: true }, admin);
    const activity = await schoolApi('course-activities', { requestId: randomUUID(), releaseId }); report.activityId = activity.activityId;
    // Submit the declared sample as real fixed input. A tool may not invent missing component
    // state; a browser opened only after dispatch would otherwise have no approved table basis.
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'components/table.json', kind: 'state', encoding: 'json',
      mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
        instanceId: activity.activityId + ':table', componentId: definition.manifest.componentId, version: definition.manifest.version,
        definitionDigest: definition.digest, stateVersion: definition.manifest.stateVersion, operationId: randomUUID(), content: definition.manifest.initialState }) };
    await schoolApi('workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    const capabilities = await schoolApi(`agent/${activity.activityId}/capabilities`); check(capabilities.modelAvailable, 'model-unavailable');
    if (args.mode === 'cross') {
      const confirmed = await schoolApi('models/selection');
      check(confirmed.version === report.rootSelection.version && confirmed.selected?.kind === 'personal'
        && confirmed.selected.connection.connectionId === report.rootSelection.connectionId
        && confirmed.selected.grantId === report.rootSelection.grantId, 'capability-refresh-changed-root-selection');
    }
    const requestId = randomUUID(), started = Date.now();
    await schoolApi(`intents/${activity.activityId}`, { requestId, receiver: capabilities.receiver,
      scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId: activity.activityId },
      draft: { token: randomUUID(), question: '请实际调用 course_operation：componentKey=table，operationId=aggregate，parameters={"groupColumn":"小组","valueColumn":"得分","aggregate":"mean"}。等待真实执行结果后，用中文简要解释各组与总平均分。不要估算结果，不要调用其他工具。',
        references: [], bases: [] }, works: [work], evidence: [] });
    const receipt = await schoolApi(`intents/${activity.activityId}/${requestId}/dispatch`, {});
    check(receipt.state === 'accepted', 'question-not-accepted'); report.requestId = requestId;
    const runId = JSON.parse(receipt.receipt.detail).runId; report.runId = runId;
    async function untilConversation(predicate, deadlineMs = 150000) {
      const end = Date.now() + deadlineMs; let conversation;
      while (Date.now() < end) {
        conversation = await schoolApi(`agent/${activity.activityId}/conversation`);
        report.lastConversation = conversation;
        if (predicate(conversation)) return conversation;
        const run = conversation.runs.find(item => item.runId === runId);
        check(!['failed', 'paused', 'stopped'].includes(run?.state), 'run-' + run?.state + '-' + run?.reason);
        await delay(500);
      }
      report.lastState = { runs: conversation?.runs, tools: conversation?.tools.map(tool => ({ name: tool.name, state: tool.state, outcome: tool.outcome })), waits: conversation?.waits };
      throw Object.assign(new Error('conversation-timeout'), { code: 'conversation-timeout' });
    }
    const waiting = await stage('durable-wait-before-browser-execution', async () => {
      const conversation = await untilConversation(value => value.waits.some(wait => wait.runId === runId && wait.state === 'pending'));
      return { elapsedMs: Date.now() - started, waits: conversation.waits.filter(wait => wait.runId === runId),
        tools: conversation.tools.map(tool => ({ commandId: tool.commandId, name: tool.name, location: tool.location })) };
    });
    let page;
    if (args.mode === 'cross') {
      const publicKey = await exec('openssl', ['x509', '-in', args.certificate, '-pubkey', '-noout']);
      const der = await new Promise((done, reject) => {
        const child = spawn('openssl', ['pkey', '-pubin', '-outform', 'DER'], { stdio: ['pipe', 'pipe', 'ignore'] });
        const chunks = []; child.stdout.on('data', bytes => chunks.push(bytes)); child.on('error', reject);
        child.on('exit', code => code === 0 ? done(Buffer.concat(chunks)) : reject(new Error('spki-failed'))); child.stdin.end(publicKey.stdout);
      });
      windowsChrome = await startWindowsChrome({ endpoint, activityId: activity.activityId, runId, cookie: login.cookie,
        spki: createHash('sha256').update(der).digest('base64') });
    } else {
      const { chromium } = await import('@playwright/test');
      browser = await chromium.launch({ channel: 'chrome', headless: false });
      const context = await browser.newContext();
      const [cookieName, ...cookieValue] = login.cookie.split('=');
      await context.addCookies([{ name: cookieName, value: cookieValue.join('='), url: endpoint }]);
      page = await context.newPage(); currentPage = page;
      await page.goto(endpoint + '/?space=school&activity=' + activity.activityId);
      await page.getByRole('button', { name: '打开对话', exact: true }).click({ timeout: 30000 });
    }
    await stage('chrome-real-course-result-and-model-explanation', async () => {
      const final = await untilConversation(value => value.runs.some(run => run.runId === runId && run.state === 'completed'));
      if (args.mode === 'cross') check(final.runs.find(run => run.runId === runId)?.model.connectionId === configuredModel.modelConnectionId, 'run-did-not-use-explicit-device-choice');
      const tool = final.tools.find(tool => tool.runId === runId && tool.name === 'course_operation' && tool.outcome === 'completed');
      check(tool, 'no-completed-course-tool');
      check(final.waits.some(wait => waiting.waits.some(original => original.waitId === wait.waitId) && wait.state === 'consumed'), 'original-wait-not-consumed');
      const answer = final.messages.filter(message => message.runId === runId && message.role === 'assistant').map(message => message.text).join('\n');
      check(/83[.．]33/.test(answer), 'explanation-missing-actual-average');
      await page?.screenshot({ path: join(dirname(output), basename(output, '.json') + '-chrome.png'), fullPage: true });
      if (windowsChrome) { report.windowsChrome = await windowsChrome.result(); check(report.windowsChrome.status === 'passed', 'windows-chrome-failed'); }
      report.browser = 'passed'; report.browserVersion = browser?.version() ?? report.windowsChrome?.browserVersion; report.completed = { run: final.runs.find(run => run.runId === runId),
        tools: final.tools, waits: final.waits, answerSha256: hash(answer), elapsedMs: Date.now() - started };
      return { actualCourseTool: tool.name, originalWaitConsumed: true, answerSha256: hash(answer),
        resultSha256: hash(JSON.stringify(tool.result)), toolElapsedMs: Date.parse(tool.updatedAt) - Date.parse(tool.createdAt), elapsedMs: Date.now() - started };
    });
    await stage('reload-and-restart-query-original-request', async () => {
      const witness = async () => args.mode === 'cross' ? (await device.call('witness')).requests.length : relay.requests.length;
      const restoreStarted = Date.now();
      const sendsBefore = await witness();
      await page?.reload();
      const before = await schoolApi(`agent/${activity.activityId}/conversation`);
      if (separate) { await agent.stop(); await agent.start(); } else { await school.stop(); state = await school.start(); endpoint = state.endpoint; }
      const after = await schoolApi(`agent/${activity.activityId}/conversation`);
      assert.deepEqual(after, before);
      check((await schoolApi(`agent/${activity.activityId}/requests/${requestId}`)).state === 'accepted', 'lost-original-request');
      await delay(1000);
      const sendsAfter = await witness(); check(sendsAfter === sendsBefore, 'read-replayed-model-request');
      if (args.mode === 'cross') check(relay.requests.length === 0, 'unexpected-school-side-model-generation');
      return { sameConversation: true, sameRequest: true, recoveryElapsedMs: Date.now() - restoreStarted, generationsBefore: sendsBefore, generationsAfter: sendsAfter, comparisonSha256: hash(JSON.stringify(after)) };
    });
    report.status = 'passed';
  }
} catch (error) { report.status = 'failed'; report.failure = { code: safe(error) }; process.exitCode = 1; }
finally {
  report.cleanup = [];
  if (currentPage && report.status !== 'passed') await currentPage.screenshot({ path: join(dirname(output), basename(output, '.json') + '-failure.png'), fullPage: true }).catch(() => {});
  await browser?.close().catch(() => {});
  if (windowsChrome) try { await windowsChrome.close(); } catch (error) { report.cleanup.push({ windowsChrome: safe(error) }); }
  if (device) {
    try { report.windowsWitness = await device.call('witness'); } catch (error) { report.cleanup.push({ remoteWitness: safe(error) }); }
    try { const result = await device.call('cleanup'); report.cleanup.push({ device: result });
      report.windowsWitness = result.witness; report.deviceSettled = result.witness?.providerRelayClosed === true;
      if (result.error || !result.rootRemoved) { report.status = 'failed'; process.exitCode = 1; } } catch (error) { report.cleanup.push({ device: safe(error) }); report.status = 'failed'; process.exitCode = 1; }
    device.close();
  }
  for (const [runtime, installed, label] of [[agent, agentInstalled, 'agent'], [school, schoolInstalled, 'school']]) {
    if (!installed) continue;
    try { const state = await runtime.status(); await runtime.stop(); await runtime.deleteEnvironment({ environmentId: state.environment.environmentId }); report.cleanup.push({ owner: label, stopped: true, deleted: true }); }
    catch (error) { report.cleanup.push({ owner: label, error: safe(error) }); report.status = 'failed'; process.exitCode = 1; }
  }
  if (relay) { report.providerRequests = relay.requests; await relay.close(); }
  if (lab && report.cleanup.every(item => !item.error)) await rm(lab, { recursive: true, force: true });
  const observedRequests = [...(report.providerRequests ?? []), ...(report.windowsWitness?.requests ?? [])];
  report.requestAccounting = { observedExternalAttempts: observedRequests.length,
    httpSuccess: observedRequests.filter(item => item.status >= 200 && item.status < 300).length,
    httpFailure: observedRequests.filter(item => item.status >= 300).length,
    responseUnconfirmed: observedRequests.filter(item => item.status === null).length,
    witnessFinal: args.mode !== 'cross' || !device || report.deviceSettled === true };
  if (budget) {
    const uncertain = args.mode === 'cross' && device && !report.deviceSettled;
    const measured = Array.isArray(report.windowsWitness?.requests);
    const count = (report.providerRequests?.length ?? 0) + (measured ? report.windowsWitness.requests.length : uncertain ? budget.remaining : 0);
    budget.account.used += count;
    budget.account.runs.push({ output, mode: args.mode, generations: count, uncertaintyCharged: !!uncertain && !measured, witnessFinal: !uncertain, status: report.status });
    delete budget.account.reservation;
    const temporary = budget.path + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(budget.account, null, 2) + '\n'); await rename(temporary, budget.path);
    report.budget.usedAfter = budget.account.used;
  }
  report.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ status: report.status, mode: report.mode, stages: report.stages.map(item => ({ name: item.name, status: item.status })), failure: report.failure }));
}
