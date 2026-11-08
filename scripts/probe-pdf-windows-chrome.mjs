// Windows interactive Chrome -> isolated Mac school/PDF/model owners. Provider secrets never leave Mac.
import assert from 'node:assert/strict';
import { parseArgs, promisify } from 'node:util';
import { randomUUID, createHash, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir, rm, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, hostname, release } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import dns from 'node:dns/promises';
import dnsCallback from 'node:dns';
import https from 'node:https';
import tls from 'node:tls';
const { values: args } = parseArgs({ options: {
  product: { type: 'string' }, transport: { type: 'string', default: 'dist/product-pdf-218-evidence/windows-transport.json' },
  ssh: { type: 'string', default: 'win' }, certificate: { type: 'string' }, key: { type: 'string' },
  'mac-host': { type: 'string', default: '192.168.3.39' }, port: { type: 'string', default: '38228' },
  'credentials-file': { type: 'string' }, out: { type: 'string' }, session: { type: 'string' },
  'windows-playwright': { type: 'string', default: 'C:/Users/h/XunJie-acceptance/package.json' },
  'chrome-job': { type: 'string' }, help: { type: 'boolean' },
} });
const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const safe = error => error instanceof assert.AssertionError ? 'acceptance-assertion'
  : /^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(error?.code ?? '') ? error.code
  : error?.name === 'TimeoutError' ? 'browser-control-timeout' : 'probe-operation-failed';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k,canonical(v)])) : value;
const digest = value => sha(JSON.stringify(canonical(value)));
const limits = { maxGenerations: 3, maxOutputTokens: 2048, timeoutMs: 30000, retries: 0 };
if (args.help) {
  console.log(`PACKAGED_NODE scripts/probe-pdf-windows-chrome.mjs --product MAC_R3_DIR
  --certificate TEST_CERT --key TEST_KEY --credentials-file MAC_PRIVATE_JSON
  --session CHAT_ID --out docs/student-agent-implementation/evidence/wp08-218/windows-model-chrome.json
  [--transport dist/product-pdf-218-evidence/windows-transport.json --mac-host 192.168.3.39 --port 38228]
Reads the newest r3 Windows product from transport metadata. Holds the shared Windows desktop lock
on Mac throughout the Interactive/Limited scheduled task. Uses installed Windows Chrome/Playwright.
The temporary student login crosses SSH stdin only and is deleted from its temporary job file when read.
Provider credentials stay on Mac. Three real requests maximum; fixed-page read, answer and followup.
Chrome reopens the source after a Mac product-host restart. Only this probe's temporary task/files are removed.`);
  process.exit(0);
}
async function until(action, code, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await action(); if (value) return value; await delay(500); }
  throw Object.assign(new Error(code), { code });
}
async function atomicJson(path, value) {
  await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(path + '.tmp', path);
}
async function trust(certificate) {
  const pem = await readFile(resolve(certificate), 'utf8');
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), pem]);
  process.env.NODE_EXTRA_CA_CERTS = resolve(certificate);
}
async function product(directory) {
  const root = resolve(directory), distributionBytes = await readFile(join(root, 'distribution.json'));
  const distribution = JSON.parse(distributionBytes), manifest = JSON.parse(await readFile(join(root, 'resources.json')));
  const resources = Object.fromEntries(Object.entries(manifest).map(([key, value]) => [key,
    typeof value === 'string' && /(?:Path|Bin|Root|Helper)$/.test(key) ? resolve(root, value) : value]));
  const entry = join(root, 'app/product-runtime.js'), bytes = await readFile(entry), source = bytes.toString('utf8');
  check(source.includes('immutable-agent-assembly') && source.includes('tool.contributions')
    && source.includes('read_pdf') && source.includes('rotated-cropbox-top-left-normalized'), 'candidate-missing-pdf-assembly');
  check(source.includes("img-src 'self' data:") && source.includes('plan.input.input.images.length > 8')
    && source.includes('const requiredInputs ='), 'candidate-missing-latest-driver-or-host-fix');
  check(source.includes('read_pdf_text') && source.includes('feedbackMatchesTruncated'), 'candidate-missing-r3-Spec-fixes');
  check(distribution.entryHashes?.['app/product-runtime.js']?.sha256 === sha(bytes), 'candidate-manifest-code-mismatch');
  const module = await import(pathToFileURL(entry).href);
  check(typeof module.openProductRuntime === 'function' && typeof module.createProductRuntimeHost === 'function'
    && typeof module.createProductLearningApplication === 'function', 'candidate-missing-public-host-api');
  return { root, resources, module, fact: { platform: distribution.platform, profile: distribution.profile,
    distributionSha256: sha(distributionBytes), applicationSha256: sha(bytes), createdAt: distribution.createdAt,
    latestDriverAndHostFixes: true, boundedPdfFeedbackAndRetainedTextContinuation: true, nodeVersion: process.version } };
}
async function removeEnvironment(runtime, root, state) {
  const result = { stopped: false, environmentDeleted: false, rootRemoved: false };
  try {
    await runtime.stop(); result.stopped = true;
    let environmentId = state?.environment?.environmentId;
    if (!environmentId) {
      try { environmentId = JSON.parse(await readFile(join(root, 'environment.json'), 'utf8')).environmentId; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (environmentId) {
      for (let attempt = 0; ; attempt++) {
        try { await runtime.deleteEnvironment({ environmentId }); break; }
        catch (error) {
          if (attempt >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
          await delay(200 * (attempt + 1));
        }
      }
    }
    result.environmentDeleted = true;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); result.rootRemoved = true;
  } catch (error) { result.error = safe(error); }
  return result;
}
// Keep the real endpoint for production capability classification. Only the transport
// boundary is intercepted; TLS uses the unmodified system socket lookup and real CA checks.
async function providerRelay(key) {
  const requests = [], rejected = [], active = new Set();
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup, socketLookup = dnsCallback.lookup;
  dns.lookup = async (host, options) => host === 'api.deepseek.com'
    ? options?.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 }
    : originalLookup(host, options);
  syncBuiltinESMExports();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname !== 'api.deepseek.com') return originalFetch(input, init);
    try {
      check(url.origin === 'https://api.deepseek.com' && request.method === 'POST'
        && url.pathname === '/v1/chat/completions', 'unexpected-provider-operation');
      check(request.headers.get('authorization') === 'Bearer ' + key && requests.length < limits.maxGenerations,
        'provider-budget-or-credential-refused');
      const row = { index: requests.length + 1, payloadSha256: null, status: null, finished: false, imageSha256: [] };
      requests.push(row);
      const body = Buffer.from(await request.arrayBuffer());
      check(body.length <= 4 * 1024 * 1024, 'provider-request-too-large');
      const payload = JSON.parse(body);
      check(payload.model === 'deepseek-flash' && payload.stream === true && Number.isInteger(payload.max_tokens)
        && payload.max_tokens > 0 && payload.max_tokens <= limits.maxOutputTokens, 'provider-limits-not-fixed');
      row.payloadSha256 = digest(payload); row.toolSchemaSha256 = digest(payload.tools ?? []);
      const images = value => {
        if (!value || typeof value !== 'object') return;
        if (['image_url', 'input_image', 'image'].includes(value.type)) {
          const data = value.source?.data ?? (typeof value.image_url === 'string' ? value.image_url : value.image_url?.url)?.split(',')[1];
          if (data) row.imageSha256.push(sha(Buffer.from(data, 'base64')));
        } else Object.values(value).forEach(images);
      };
      images(payload);
      return await new Promise((resolveRequest, reject) => {
        const started = Date.now(); let deadline;
        const upstream = https.request(url, { method: request.method,
          headers: { ...Object.fromEntries(request.headers), 'accept-encoding': 'identity', 'content-length': body.length },
          lookup: socketLookup, timeout: limits.timeoutMs }, incoming => {
          const chunks = []; let bytes = 0;
          incoming.on('data', chunk => { bytes += chunk.length;
            if (bytes > 8 * 1024 * 1024) upstream.destroy(Object.assign(new Error('provider-response-too-large'), { code: 'provider-response-too-large' }));
            else chunks.push(chunk);
          });
          incoming.on('end', () => { clearTimeout(deadline); active.delete(upstream);
            row.status = incoming.statusCode; row.finished = true; row.elapsedMs = Date.now() - started;
            resolveRequest(new Response(Buffer.concat(chunks), { status: incoming.statusCode,
              headers: { 'content-type': incoming.headers['content-type'] ?? 'text/event-stream' } }));
          });
          incoming.on('error', () => upstream.destroy(Object.assign(new Error('provider-stream-failed'), { code: 'provider-stream-failed' })));
        });
        active.add(upstream);
        deadline = setTimeout(() => upstream.destroy(Object.assign(new Error('provider-deadline'), { code: 'provider-deadline' })), limits.timeoutMs);
        upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('provider-timeout'), { code: 'provider-timeout' })));
        upstream.on('error', error => { clearTimeout(deadline); active.delete(upstream); row.error = safe(error);
          row.elapsedMs = Date.now() - started; reject(Object.assign(new Error('provider-network-failed'), { code: 'provider-network-failed' }));
        });
        upstream.end(body);
      });
    } catch (error) { rejected.push({ code: safe(error) }); return new Response('{}', { status: 429 }); }
  };
  return { endpoint: 'https://api.deepseek.com', requests, rejected,
    async close() { for (const request of active) request.destroy();
      globalThis.fetch = originalFetch; dns.lookup = originalLookup; syncBuiltinESMExports(); } };
}

async function chromeJob() {
  const job = JSON.parse(await readFile(args['chrome-job'], 'utf8'));
  // The temporary account is never serialized into a result, screenshot or diagnostic log.
  await rm(args['chrome-job']);
  const result = { status: 'running', platform: process.platform, workerProcessId: process.pid, checks: [], browser: 'Chrome', teachingEffect: 'not-assessed' };
  let browser, page, phase = 'interactive-session';
  const save = () => atomicJson(job.result, result);
  await save();
  try {
    check(process.platform === 'win32', 'interactive-windows-required');
    const session = await exec('powershell.exe', ['-NoProfile', '-Command', '[Diagnostics.Process]::GetCurrentProcess().SessionId']);
    result.desktopSessionId = Number(session.stdout.trim()); check(result.desktopSessionId > 0, 'browser-session-zero');
    const distributionBytes = await readFile(join(job.product, 'distribution.json'));
    const distribution = JSON.parse(distributionBytes);
    result.product = { path: job.product, distributionSha256: sha(distributionBytes), createdAt: distribution.createdAt,
      applicationSha256: sha(await readFile(join(job.product, 'app/product-runtime.js'))) };
    check(result.product.applicationSha256 === job.applicationSha256, 'windows-product-code-mismatch');
    const { chromium, expect } = createRequire(job.playwright)('@playwright/test');
    browser = await chromium.launch({ channel: 'chrome', headless: false,
      args: ['--ignore-certificate-errors-spki-list=' + job.spki] });
    result.chromeVersion = browser.version();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    const pageErrors = []; page.on('pageerror', () => pageErrors.push('browser-page-error'));
    let pdfRenderRequests = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname
      === '/api/learning/pdf/' + job.activityId + '/read') pdfRenderRequests++; });
    const api = (route) => page.evaluate(async route => {
      const response = await fetch('/api/learning/' + route, { headers: { 'x-xj-space': 'school' } });
      if (!response.ok) throw new Error('public-read-failed'); return response.json();
    }, route);
    const openConversation = async () => {
      const button = page.getByRole('button', { name: /^(打开对话|问题与引用)$/ });
      await button.waitFor(); if (await button.getAttribute('aria-expanded') === 'false') await button.click();
    };
    const locate = async readingId => {
      await openConversation();
      const summary = page.locator('.teaching-tool-record > summary').first(); await summary.waitFor();
      if (await summary.evaluate(el => !el.parentElement.open)) await summary.click();
      await page.getByRole('button', { name: '定位来源', exact: true }).first().click();
      await expect(page.locator('[data-pdf-reading-id]')).toHaveAttribute('data-pdf-reading-id', readingId);
      await expect(page.getByRole('img', { name: 'PDF 第 2 页固定页图', exact: true })).toBeVisible();
    };
    phase = 'student-ui-login';
    await page.goto(job.endpoint + '/?space=school');
    await page.getByLabel('学校账号', { exact: true }).fill(job.student.loginName);
    await page.getByLabel('密码', { exact: true }).fill(job.student.password);
    await page.getByRole('button', { name: '登录此学校', exact: true }).click();
    await page.getByLabel('学校账号', { exact: true }).waitFor({ state: 'hidden' });
    delete job.student;
    result.checks.push('student-login-through-form'); await save();
    phase = 'formal-personal-pdf-upload';
    await page.goto(job.endpoint + '/?space=school&activity=' + job.activityId);
    const materials = page.getByRole('button', { name: '目标与材料', exact: true }); await materials.waitFor();
    if (await materials.getAttribute('aria-expanded') === 'false') await materials.click();
    await page.locator('input[type=file][accept="application/pdf,.pdf"]').setInputFiles({
      name: 'windows-fixed.pdf', mimeType: 'application/pdf', buffer: Buffer.from(job.pdfBase64, 'base64') });
    await page.getByRole('img', { name: 'PDF 第 1 页固定页图', exact: true }).waitFor();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.getByRole('img', { name: 'PDF 第 2 页固定页图', exact: true }).waitFor();
    const pdfRoute = 'pdf/' + job.activityId;
    const documents = await api(pdfRoute); check(documents.length === 1, 'expected-one-uploaded-pdf');
    const document = documents[0];
    check(document.sha256 === job.pdfSha256 && document.pageCount === 2 && document.pageLabels[1] === '7', 'uploaded-fixed-pdf-mismatch');
    const readingId = await page.locator('[data-pdf-reading-id]').getAttribute('data-pdf-reading-id');
    const reading = await api(pdfRoute + '/reads/' + readingId);
    check(reading.requestedPages.length === 1 && reading.pages[0].page === 2 && reading.pages[0].label === '7'
      && sha(Buffer.from(reading.pages[0].image.dataBase64, 'base64')) === reading.pages[0].image.sha256, 'page-image-not-fixed');
    result.source = { documentId: document.documentId, documentSha256: document.sha256,
      readingId, page: 2, label: '7', imageSha256: reading.pages[0].image.sha256, retainedReadingSha256: digest(reading) };
    result.checks.push('formal-upload-page2-label7');
    await page.getByRole('button', { name: '引用此页', exact: true }).click(); await openConversation();
    const question = page.locator('textarea:visible').last();
    await question.fill('请先且仅调用一次 read_reference 实际读取我引用的 PDF 页图，然后简短说明电压数值、实际页序和印刷标签。读取后直接回答，不调用其他工具。');
    await expect.poll(async () => (await api('drafts/' + job.activityId)).references.length).toBe(1);
    const draft = await api('drafts/' + job.activityId);
    check(draft.references[0].source.readingId === readingId, 'quoted-draft-reading-changed');
    result.checks.push('fixed-pdf-reference-in-reliable-draft'); await save();
    phase = 'real-read-reference-and-answer';
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    const conversationRoute = 'agent/' + job.activityId;
    const first = await until(async () => {
      const value = await api(conversationRoute + '/conversation'), run = value.runs[0];
      check(!['failed','paused','stopped'].includes(run?.state), 'first-model-run-not-completed');
      return run?.state === 'completed' ? value : null;
    }, 'first-model-completion-timeout');
    check(first.runs.length === 1 && first.tools.length === 1 && first.tools[0].name === 'read_reference'
      && first.tools[0].outcome === 'completed' && first.tools[0].result.source.readingId === readingId
      && first.tools[0].result.images[0].sha256 === result.source.imageSha256, 'real-pdf-tool-not-completed');
    const firstAnswer = first.messages.filter(item => item.role === 'assistant').map(item => item.text).join('\n');
    check(/(?<!\d)37(?!\d)/.test(firstAnswer), 'answer-missing-fixed-pdf-evidence');
    await expect(page.locator('.teaching-message.assistant').filter({ hasText: '37' }).first()).toBeVisible();
    result.firstRun = { runId: first.runs[0].runId, requestId: first.runs[0].requestId, commandId: first.tools[0].commandId,
      answerSha256: sha(firstAnswer), voltage37: true };
    result.checks.push('real-read-reference-and-voltage-answer');
    phase = 'source-button';
    await page.getByRole('button', { name: '返回作品', exact: true }).click(); await locate(readingId);
    result.checks.push('tool-record-source-opens-original-page'); await save();
    phase = 'followup';
    await question.fill('不要再调用任何工具，仅依据刚才已经读取的固定页，用一句话重述电压数值和实际页序。');
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    const final = await until(async () => {
      const value = await api(conversationRoute + '/conversation'), run = value.runs.find(item => item.runId !== first.runs[0].runId);
      check(!['failed','paused','stopped'].includes(run?.state), 'followup-model-run-not-completed');
      return run?.state === 'completed' ? value : null;
    }, 'followup-completion-timeout');
    check(final.runs.length === 2 && final.inputs.length === 2 && final.tools.length === 1, 'followup-replayed-pdf-tool');
    const followupRun = final.runs.find(item => item.runId !== first.runs[0].runId);
    const answer = final.messages.filter(item => item.role === 'assistant' && item.runId === followupRun.runId).map(item => item.text).join('\n');
    check(/(?<!\d)37(?!\d)/.test(answer), 'followup-lost-original-evidence');
    await expect(page.locator('.teaching-message.assistant[data-run-id="' + followupRun.runId + '"]').filter({ hasText: '37' }).first()).toBeVisible();
    result.followup = { runId: followupRun.runId,
      conversationSha256: digest(final), toolCount: final.tools.length, answerSha256: sha(answer) };
    const events = await api(conversationRoute + '/events');
    result.snapshots = [];
    for (const event of events.filter(item => item.kind === 'context-assembled')) {
      const snapshot = await api(conversationRoute + '/snapshots/' + event.body.snapshotId);
      check(digest(snapshot.payload) === snapshot.payloadSha256, 'snapshot-payload-digest-mismatch');
      result.snapshots.push({ snapshotId: snapshot.snapshotId, payloadSha256: snapshot.payloadSha256, snapshotSha256: digest(snapshot) });
    }
    check(result.snapshots.length === 3, 'expected-three-real-model-snapshots');
    result.checks.push('followup-without-another-pdf-command');
    result.pdfRenderRequestsBeforeRestart = pdfRenderRequests;
    result.status = 'awaiting-host-restart'; await save();
    phase = 'host-restart-fixed-source';
    await until(async () => { try { return JSON.parse(await readFile(job.restartSignal, 'utf8')).restarted; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, 'mac-host-restart-not-signaled');
    await page.reload(); await openConversation(); await locate(readingId);
    assert.deepEqual(await api(pdfRoute + '/reads/' + readingId), reading);
    check(digest(await api(conversationRoute + '/conversation')) === result.followup.conversationSha256, 'restart-changed-original-conversation');
    for (const snapshot of result.snapshots) check(digest(await api(conversationRoute + '/snapshots/' + snapshot.snapshotId)) === snapshot.snapshotSha256,
      'restart-changed-original-snapshot');
    check(pdfRenderRequests === result.pdfRenderRequestsBeforeRestart, 'restart-reconverted-pdf');
    result.restart = { newPdfRenderRequests: 0 };
    result.checks.push('Chrome-source-click-after-host-restart-retains-original-reading');
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    check(!pageErrors.length, 'browser-page-error'); result.pageErrors = pageErrors;
    await page.screenshot({ path: job.screenshot, fullPage: true });
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = safe(error); result.phase = phase;
    // Never capture the temporary student login screen.
    if (page && phase !== 'student-ui-login' && phase !== 'interactive-session')
      await page.screenshot({ path: job.screenshot, fullPage: true }).catch(() => {});
  } finally { await browser?.close().catch(() => {}); result.finishedAt = new Date().toISOString(); await save(); }
}
async function windowsPowerShell(script, input = '') {
  check(/^[A-Za-z0-9_.@-]+$/.test(args.ssh) && !args.ssh.startsWith('-'), 'invalid-ssh-alias');
  return await new Promise((done, reject) => {
    const child = spawn('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=10',args.ssh,
      'powershell -NoProfile -EncodedCommand ' + Buffer.from("$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')],
    { stdio: ['pipe','pipe','pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('windows-control-timeout'), { code: 'windows-control-timeout' })); }, 45000);
    child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error('windows-control-failed'), { code: 'windows-control-failed' })); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? done(output.replace(/^\uFEFF/, '').trim())
      : reject(Object.assign(new Error('windows-control-failed'), { code: 'windows-control-failed' })); });
    child.stdin.end(input);
  });
}
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
async function main() {
  check(process.platform === 'darwin', 'mac-controller-required');
  for (const field of ['product','certificate','key','credentials-file','out','session']) check(args[field], 'missing-' + field);
  check(/^192\.168\.[0-9.]+$/.test(args['mac-host']), 'explicit-lan-host-required');
  const port = Number(args.port); check(Number.isInteger(port) && port >= 1024 && port <= 65535, 'invalid-port');
  const output = resolve(args.out), screenshot = output.replace(/\.json$/, '.png');
  await mkdir(dirname(output), { recursive: true });
  const report = { issue: 218, status: 'running', measuredAt: new Date().toISOString(), limits,
    topology: 'Windows interactive Chrome -> direct LAN HTTPS -> Mac school, materials, Agent and model owners',
    browser: 'running', engineering: 'owned-by-main', teachingEffect: 'not-assessed', stages: [], cleanup: {} };
  const persist = () => atomicJson(output, report);
  async function stage(name, action) {
    const row = { name, status: 'running' }; report.stages.push(row); await persist();
    try { const value = await action(); row.status = 'passed'; row.fact = value; await persist(); return value; }
    catch (error) { row.status = 'failed'; row.error = safe(error); await persist(); throw error; }
  }
  let runtime, host, root, state, relay, releaseDesktop, remoteDirectory, taskName, taskRegistered = false;
  try {
    const transport = JSON.parse(await readFile(args.transport, 'utf8'));
    const revision = ['r3'].find(revision => transport[revision + 'RemoteProduct'] && transport[revision + 'State'] === 'passed');
    check(revision, 'r3-windows-product-not-ready');
    const remoteProduct = transport[revision + 'RemoteProduct'];
    const pkg = await product(args.product); check(pkg.fact.profile === 'full', 'complete-mac-product-required');
    report.macProduct = { path: pkg.root, ...pkg.fact }; report.windowsProductPath = remoteProduct;
    report.probeSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
    await trust(args.certificate);
    const certificate = new X509Certificate(await readFile(args.certificate));
    const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const provider = JSON.parse(await readFile(args['credentials-file'], 'utf8')).providers.find(item => /deepseek/i.test(item.preset ?? item.name ?? '') && item.key);
    check(provider?.key, 'authorized-provider-unavailable'); relay = await providerRelay(provider.key);
    root = await mkdtemp(join(tmpdir(), 'xj-wp08-218-win-chrome-'));
    runtime = pkg.module.openProductRuntime({ root, resources: pkg.resources });
    await stage('isolated-Mac-school-owner-on-current-product', async () => {
      await runtime.install({ profile: 'school', host: '0.0.0.0', port,
        publicEndpoint: `https://${args['mac-host']}:${port}`,
        tls: { certificateFile: resolve(args.certificate), keyFile: resolve(args.key) } });
      host = await pkg.module.createProductRuntimeHost({ root, createApplication: pkg.module.createProductLearningApplication });
      state = await runtime.status(); return { endpoint: state.endpoint, environmentId: state.environment.environmentId,
        serviceIds: state.environment.services.map(service => ({ unit: service.unit, serviceId: service.serviceId })) };
    });
    const endpoint = state.endpoint;
    const api = async (route, body, headers = {}) => {
      const response = await fetch(endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', ...headers },
        signal: AbortSignal.timeout(45000), ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      check(response.status === 200, 'learning-http-' + response.status); return { value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const admin = { authorization: 'Bearer ' + await pkg.module.resolveCredential(root, 'control') };
    const student = { loginName: 'pdf-windows-' + randomUUID(), password: randomUUID() };
    const identity = (await api('manage/members', { requestId: randomUUID(), ...student }, admin)).value;
    const login = await api('login', student), actor = { 'x-xj-space': 'school', cookie: login.cookie };
    const schoolApi = async (route, body) => (await api(route, body, actor)).value;
    await stage('Mac-only-provider-and-student-model-selection', async () => {
      const connectionId = randomUUID();
      await api('manage/model-default', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'PDF Windows Chrome acceptance',
        protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com/v1', path: '/chat/completions', modelId: 'deepseek-flash',
        dialect: 'deepseek', parameterMode: 'thinking', enabled: true, contextWindow: 262144, maxOutputTokens: limits.maxOutputTokens,
        credential: { action: 'replace', value: provider.key }, policy: { checksAllowed: true, maxChecksPerHour: 3,
          maxOutputTokens: limits.maxOutputTokens, timeoutMs: limits.timeoutMs } }, admin);
      const selected = await schoolApi('models/selection');
      await schoolApi('models/selection', { requestId: randomUUID(), expectedVersion: selected.version, source: { kind: 'school', connectionId } });
      check((await schoolApi('models/school-default')).connection.capabilities.images === 'verified', 'model-image-route-unverified');
      return { connectionId, credentialOwner: 'Mac', providerCredentialExported: false, images: 'verified' };
    });
    const activity = await schoolApi('activities', { requestId: randomUUID(), goal: 'Windows 正式 Chrome 固定 PDF 学习', question: '', references: [] });
    const { fixedPdf } = await import('../apps/server/tests/fixtures/pdf-material.mjs');
    const pdf = fixedPdf();
    const { acquireNativeDesktop } = await import('./lib/native-desktop-lock.mjs');
    await stage('acquire-Windows-desktop-after-current-owner-releases', async () => {
      releaseDesktop = await until(async () => {
        try { return await acquireNativeDesktop('windows', args.session, 'Issue 218 Windows Chrome real PDF model and restart'); }
        catch (error) { if (!error.message.startsWith('Desktop lock is held;')) throw error; return null; }
      }, 'windows-desktop-still-owned', 15 * 60 * 1000);
      return { owner: args.session, heldAcrossScheduledTaskStartupWaitAndCleanup: true };
    });
    remoteDirectory = 'C:/Users/h/AppData/Local/Temp/wp08-218-model-chrome-' + randomUUID();
    const remoteScript = remoteDirectory + '/probe-pdf-windows-chrome.mjs';
    const files = { job: remoteDirectory + '/job.json', result: remoteDirectory + '/result.json',
      screenshot: remoteDirectory + '/result.png', restartSignal: remoteDirectory + '/restart.json' };
    await windowsPowerShell(`New-Item -ItemType Directory -Path ${psQuote(remoteDirectory)} | Out-Null;`
      + `[IO.File]::WriteAllText(${psQuote(remoteScript)},[Console]::In.ReadToEnd(),[Text.UTF8Encoding]::new($false))`,
      await readFile(fileURLToPath(import.meta.url), 'utf8'));
    taskName = 'XunJie-218-Model-Chrome-' + randomUUID();
    const job = { endpoint, student, activityId: activity.activityId, product: remoteProduct,
      applicationSha256: pkg.fact.applicationSha256, spki, playwright: args['windows-playwright'], pdfBase64: pdf.toString('base64'), pdfSha256: sha(pdf), ...files };
    await stage('start-Interactive-Limited-Windows-Chrome-task', async () => {
      const launch = '"' + remoteScript + '" --chrome-job "' + files.job + '"';
      await windowsPowerShell(`[IO.File]::WriteAllText(${psQuote(files.job)},[Console]::In.ReadToEnd(),[Text.UTF8Encoding]::new($false));`
        + `$a=New-ScheduledTaskAction -Execute ${psQuote(remoteProduct + '/resources/node/node.exe')} -Argument ${psQuote(launch)};`
        + `$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;`
        + `$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 8);`
        + `Register-ScheduledTask -TaskName ${psQuote(taskName)} -Action $a -Principal $p -Settings $s | Out-Null;`
        + `Start-ScheduledTask -TaskName ${psQuote(taskName)}`, JSON.stringify(job));
      taskRegistered = true; delete job.student;
      return { taskName, logonType: 'Interactive', runLevel: 'Limited', port, transport: 'direct HTTPS with pinned test-certificate SPKI' };
    });
    const readRemoteResult = async () => {
      const text = await windowsPowerShell(`if(Test-Path -LiteralPath ${psQuote(files.result)}){[IO.File]::ReadAllText(${psQuote(files.result)})}`);
      return text ? JSON.parse(text) : null;
    };
    let beforeRestart;
    await stage('Windows-formal-upload-quote-real-model-source-and-followup', async () => {
      beforeRestart = await until(async () => {
        const value = await readRemoteResult();
        if (value?.status === 'failed') { report.windows = value; throw Object.assign(new Error(value.error), { code: value.error }); }
        return value?.status === 'awaiting-host-restart' ? value : null;
      }, 'windows-real-model-chain-timeout', 300000);
      report.windows = beforeRestart;
      check(relay.requests.length === 3 && relay.requests.every(item => item.status === 200 && item.finished)
        && !relay.rejected.length, 'three-real-model-calls-not-proven');
      check(relay.requests[1].imageSha256.includes(beforeRestart.source.imageSha256), 'actual-model-did-not-consume-fixed-image');
      check(beforeRestart.snapshots.every(snapshot => relay.requests.some(request => request.payloadSha256 === snapshot.payloadSha256)), 'model-snapshots-not-actual-transport');
      return { checks: beforeRestart.checks, source: beforeRestart.source, modelRequests: relay.requests.length,
        snapshots: beforeRestart.snapshots, desktopSessionId: beforeRestart.desktopSessionId };
    });
    await stage('restart-Mac-host-and-reopen-source-in-same-Windows-Chrome', async () => {
      const beforeRequests = relay.requests.length;
      await host.stop(); host = await pkg.module.createProductRuntimeHost({ root, createApplication: pkg.module.createProductLearningApplication });
      check(host.endpoint === endpoint, 'restart-changed-school-endpoint');
      await windowsPowerShell(`[IO.File]::WriteAllText(${psQuote(files.restartSignal)},'{"restarted":true}',[Text.UTF8Encoding]::new($false))`);
      const final = await until(async () => {
        const value = await readRemoteResult();
        if (value?.status === 'failed') { report.windows = value; throw Object.assign(new Error(value.error), { code: value.error }); }
        return value?.status === 'passed' ? value : null;
      }, 'windows-Chrome-restart-read-timeout');
      report.windows = final;
      check(relay.requests.length === beforeRequests && !relay.rejected.length, 'restart-issued-another-model-call');
      return { checks: final.checks, newModelRequests: 0, conversationSha256: final.followup.conversationSha256,
        readingId: final.source.readingId, imageSha256: final.source.imageSha256 };
    });
    report.status = 'passed'; report.browser = 'passed';
  } catch (error) { report.status = 'failed'; report.error = safe(error); report.browser = 'failed-or-incomplete'; }
  finally {
    report.providerRequests = relay?.requests ?? []; report.providerRefusals = relay?.rejected ?? [];
    if (remoteDirectory) {
      try {
        const bytes = await windowsPowerShell(`if(Test-Path -LiteralPath ${psQuote(remoteDirectory + '/result.png')}){[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psQuote(remoteDirectory + '/result.png')}))}`);
        if (bytes) { await writeFile(screenshot, Buffer.from(bytes, 'base64')); report.screenshotSha256 = sha(Buffer.from(bytes, 'base64')); }
        const control = await windowsPowerShell(`if(Test-Path -LiteralPath ${psQuote(remoteDirectory + '/result.json')}){[IO.File]::ReadAllText(${psQuote(remoteDirectory + '/result.json')})}`);
        const worker = control ? JSON.parse(control) : null;
        if (worker && !['passed','failed'].includes(worker.status) && Number.isInteger(worker.workerProcessId))
          await windowsPowerShell(`$owned=Get-CimInstance Win32_Process -Filter 'ProcessId = ${worker.workerProcessId}';`
            + `if($owned -and $owned.CommandLine.Contains(${psQuote(remoteDirectory)})){& taskkill.exe /PID ${worker.workerProcessId} /T /F 2>$null | Out-Null}`);
        if (taskRegistered) await windowsPowerShell(`Stop-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction SilentlyContinue;`
          + `Unregister-ScheduledTask -TaskName ${psQuote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`);
        await windowsPowerShell(`Remove-Item -LiteralPath ${psQuote(remoteDirectory)} -Recurse -Force;`
          + `if(Test-Path -LiteralPath ${psQuote(remoteDirectory)}){throw 'owned-temporary-root-remains'}`);
        report.cleanup.windowsTaskAndTemporaryFilesRemoved = true;
      } catch (error) { report.cleanup.windowsError = safe(error); }
    }
    try { await releaseDesktop?.(); report.cleanup.windowsDesktopReleased = !!releaseDesktop; }
    catch (error) { report.cleanup.desktopError = safe(error); }
    try { await host?.stop(); } catch (error) { report.cleanup.macHostError = safe(error); }
    if (runtime && root) report.cleanup.mac = await removeEnvironment(runtime, root, state);
    try { await relay?.close(); report.cleanup.providerTransportRestored = true; }
    catch (error) { report.cleanup.providerError = safe(error); }
    report.cleanup.firewallChanges = 'none-required: Windows outbound HTTPS; Mac firewall already disabled';
    if (report.status === 'passed' && (!report.cleanup.windowsTaskAndTemporaryFilesRemoved || !report.cleanup.windowsDesktopReleased
      || !report.cleanup.mac?.rootRemoved || !report.screenshotSha256 || Object.keys(report.cleanup).some(key => key.endsWith('Error')))) report.status = 'failed';
    report.finishedAt = new Date().toISOString(); await persist();
  }
  console.log(JSON.stringify({ status: report.status, report: output, browser: report.browser, modelRequests: report.providerRequests.length,
    ...(report.error ? { error: report.error, phase: report.windows?.phase } : {}) }));
  if (report.status !== 'passed') process.exitCode = 1;
}
try { if (args['chrome-job']) await chromeJob(); else await main(); }
catch (error) { console.log(JSON.stringify({ status: 'failed', error: safe(error) })); process.exitCode = 1; }
