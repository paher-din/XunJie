// Explicit WP08 acceptance. Only control travels over SSH; product calls use verified LAN HTTPS.
import assert from 'node:assert/strict';
import { parseArgs, promisify } from 'node:util';
import { randomUUID, createHash, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, hostname, release } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import https from 'node:https';
import tls from 'node:tls';

const { values: args } = parseArgs({ options: {
  product: { type: 'string' }, 'remote-product': { type: 'string' }, ssh: { type: 'string', default: 'win' },
  'remote-script': { type: 'string' }, certificate: { type: 'string' }, key: { type: 'string' },
  'remote-certificate': { type: 'string' }, 'remote-key': { type: 'string' },
  'mac-host': { type: 'string' }, 'win-host': { type: 'string' },
  'mac-port': { type: 'string' }, 'win-port': { type: 'string' },
  'credentials-file': { type: 'string' }, out: { type: 'string' },
  artifacts: { type: 'boolean' }, 'artifacts-windows-local-only': { type: 'boolean' }, 'artifacts-skip-windows-local': { type: 'boolean' }, 'artifacts-keep-failure': { type: 'boolean' }, 'artifacts-model': { type: 'string', default: 'real' }, 'artifacts-session': { type: 'string', default: 'wp09-cross-224' }, 'artifacts-call-budget': { type: 'string', default: '8' },
  'artifacts-resume': { type: 'string' }, 'artifacts-takeover-resume': { type: 'string' }, 'artifacts-worker-root': { type: 'string' },
  worker: { type: 'boolean' }, help: { type: 'boolean' }, discovery: { type: 'boolean' }, skills: { type: 'boolean' },
} });
const resumeFile = args['artifacts-resume'] ?? args['artifacts-takeover-resume'];
const takeoverContinuation = !!args['artifacts-takeover-resume'];
const resumeConfiguration = resumeFile ? JSON.parse(await readFile(resumeFile, 'utf8')) : null;
if (resumeConfiguration) {
  const file = resumeFile, output = args.out ?? resumeConfiguration.args.out.replace(/\.json$/, '-recovery.json');
  Object.assign(args, resumeConfiguration.args, { out: output, 'artifacts-resume': file,
    'artifacts-worker-root': resumeConfiguration.windowsRoot, 'artifacts-keep-failure': true });
}
if ([args.discovery, args.skills, args.artifacts].filter(Boolean).length > 1) throw new Error('Choose at most one of --discovery, --skills and --artifacts.');
const issue = args.artifacts ? 224 : args.skills ? 217 : args.discovery ? 216 : 215;
args['mac-port'] ??= args.artifacts ? '39409' : args.skills ? '39217' : args.discovery ? '38265' : '38215';
args['win-port'] ??= args.artifacts ? '39410' : args.skills ? '39218' : args.discovery ? '38266' : '38216';
const limits = Object.freeze({ maxGenerations: args.artifacts ? Number(args['artifacts-call-budget']) : args.discovery ? 4 : 2, maxOutputTokens: args.artifacts ? 8192 : 2048, timeoutMs: args.artifacts ? 60000 : 30000, retries: 0 });
const lifetime = new AbortController();
const exec = promisify(execFile), sha = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const digest = value => sha(JSON.stringify(canonical(value)));
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
// Never serialize an Error, assertion operands, private binding, HTTP header or provider response.
const safe = error => error instanceof assert.AssertionError ? 'acceptance-assertion'
  : typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(error.code) ? error.code : 'probe-operation-failed';
const port = value => { const n = Number(value); check(Number.isInteger(n) && n >= 1024 && n <= 65535, 'invalid-listener-port'); return n; };
function lanIp(value) { check(isIP(value) === 4 && !value.startsWith('127.') && value !== '0.0.0.0', 'direct-lan-ipv4-required'); return value; }
if (args.help) {
  console.log(`Usage: PACKAGED_NODE scripts/probe-teaching-assembly-cross.mjs
  --product MAC_DIR --remote-product WIN_DIR --ssh win --remote-script WIN_FILE
  --certificate PEM --key PEM --remote-certificate WIN_PEM --remote-key WIN_KEY
  --mac-host IP --win-host IP --credentials-file PRIVATE --out JSON
  [--discovery | --skills | --artifacts] [--mac-port PORT --win-port PORT]
Default mode uses issue #215, ports 38215/38216 and read_work -> answer.
--skills uses issue #217, ports 39217/39218 and skill_read -> answer for fixed course Skills.
Creates an isolated Mac school and Windows Agent. The same test CA/certificate must cover both IPs.
Open only the selected Windows TCP port to the Mac IP and Mac TCP port to the Windows IP.
Copy this script and the test certificates before running. It never copies provider credentials.
A fresh dependency operation is denied under a revoked grant before any Agent Run/model call;
renewing only that connection's grant then reconciles and dispatches the same original ActionIntent.
Default and --skills modes require two real DeepSeek chat-completions calls, 2048 output tokens and 30 seconds each.
--discovery uses issue #216, ports 38265/38266 and four calls: discover_tools -> load_tools -> read_work -> answer.
Only hashes, public IDs, hosts, status and counts are written. No browser or teaching-effect claim.
--worker is a private JSON-lines control mode: start/authorize/connect/offline/online/restart/cleanup only.`);
  process.exit(0);
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
  if(args.artifacts)for(const [path,fact]of Object.entries(distribution.entryHashes??{}))check(sha(await readFile(join(root,path)))===fact.sha256,'candidate-manifest-entry-mismatch');
  if (args.artifacts) { check(source.includes('activity-teaching-artifacts') && source.includes('generate_teaching_artifact'), 'candidate-missing-WP09-artifacts'); check(distribution.entryHashes?.['app/product-runtime.js']?.sha256 === sha(bytes), 'candidate-manifest-code-mismatch'); }
  if (args.skills) check(source.includes('independent-fixed-skill-packages') && source.includes('skill_read'), 'candidate-missing-fixed-skills');
  check(source.includes('immutable-agent-assembly') && source.includes('tool.contributions'), 'candidate-missing-versioned-assembly');
  const module = await import(pathToFileURL(entry).href);
  check(typeof module.openProductRuntime === 'function' && typeof module.createProductRuntimeHost === 'function'
    && typeof module.createProductLearningApplication === 'function', 'candidate-missing-public-host-api');
  if (args.skills) check(typeof module.createOutboundConnection === 'function', 'candidate-missing-public-connection-api');
  return { root, resources, module, fact: { platform: distribution.platform, profile: distribution.profile,
    distributionSha256: sha(distributionBytes), applicationSha256: sha(bytes), webRuntime: Object.entries(distribution.entryHashes ?? {}).filter(([name]) => /^web\/assets\/runtime-.*\.js$/.test(name)).map(([path, fact]) => ({ path, sha256: fact.sha256 })), nodeVersion: process.version } };
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
function publicState(state) {
  const environment = state.environment, target = environment.services.find(service => service.unit === 'teaching-agent');
  check(target && target.capabilities.includes('teaching.agent'), 'agent-capability-unavailable');
  check(environment.profile === 'agent' && environment.services.every(service => ['client', 'teaching-agent'].includes(service.unit)), 'agent-profile-owns-unexpected-data');
  return { state: state.state, endpoint: state.endpoint, environmentId: environment.environmentId,
    installationId: environment.installationId, target, units: environment.services.map(service => service.unit).sort() };
}
async function worker() {
  check(process.platform === 'win32' && args.product && args.certificate && args.key, 'worker-requires-windows-product-tls');
  lanIp(args['mac-host']); lanIp(args['win-host']);
  await trust(args.certificate);
  const pkg = await product(args.product), root = args['artifacts-worker-root']
    ? resolve(args['artifacts-worker-root']) : await mkdtemp(join(tmpdir(), `xj-wp08-${issue}-agent-`));
  if (args['artifacts-worker-root']) check(root.replaceAll('\\', '/').startsWith('C:/Users/h/AppData/Local/Temp/xj-wp08-224-agent-'), 'unexpected-resume-Agent-root');
  const runtime = pkg.module.openProductRuntime({ root, resources: pkg.resources });
  let state, dependencyConnectionId, macSource, cleanupResult, retainRoots = !!args['artifacts-worker-root'];
  const artifactWorker = args.artifacts ? await import('./lib/wp09-cross-case.mjs') : null;
  const artifactContext = { pkg, runtime, root, args, removeEnvironment };
  async function cleanup() {
    if (retainRoots) { const retained = artifactWorker ? await artifactWorker.cleanupArtifactWorker(artifactContext, { keep: true }) : {};
      await runtime.stop(); return { stopped: true, retained: true, rootRemoved: false, root, ...retained }; }
    if (artifactWorker) await artifactWorker.cleanupArtifactWorker(artifactContext);
    cleanupResult ??= await removeEnvironment(runtime, root, state); return cleanupResult;
  }
  async function handle(input) {
    check(input && typeof input === 'object' && uuid(input.id), 'invalid-worker-control');
    if (input.operation === 'retain') { retainRoots = true; return { retained: true, root }; }
    if (input.operation === 'cleanup') { if (input.remove === true) retainRoots = false; return cleanup(); }
    check(!cleanupResult, 'worker-already-cleaned');
    if (input.operation === 'resume') {
      check(args['artifacts-worker-root'] && !state && uuid(input.dependencyConnectionId), 'invalid-Agent-resume');
      dependencyConnectionId = input.dependencyConnectionId; state = await runtime.start();
      if (state.state === 'maintenance') { await runtime.recovery.resume(); state = await runtime.status(); }
      return { ...publicState(state), platform: process.platform, host: hostname(), osRelease: release(), package: pkg.fact,
        probeSha256: sha(await readFile(fileURLToPath(import.meta.url))) };
    }
    if (input.operation === 'start') {
      check(!dependencyConnectionId && uuid(input.dependencyConnectionId), 'invalid-agent-start');
      dependencyConnectionId = input.dependencyConnectionId;
      await runtime.install({ profile: 'agent', agent: { dependencyConnectionId }, host: '0.0.0.0', port: port(args['win-port']),
        publicEndpoint: `https://${args['win-host']}:${port(args['win-port'])}`,
        tls: { certificateFile: resolve(args.certificate), keyFile: resolve(args.key) } });
      state = await runtime.start();
      return { ...publicState(state), platform: process.platform, host: hostname(), osRelease: release(), package: pkg.fact,
        probeSha256: sha(await readFile(fileURLToPath(import.meta.url))) };
    }
    if (input.operation === 'resume-takeover') {
      dependencyConnectionId = input.dependencyConnectionId; state = await runtime.status();
      const target = await artifactWorker.artifactWorkerOperation({ ...input, operation: 'artifact.resume-active-target' }, { ...artifactContext, state });
      return { ...publicState(state), package: pkg.fact, target };
    }
    check(state, 'worker-not-started');
    if (input.operation === 'authorize') {
      const source = input.source;
      check(uuid(source?.sourceEnvironmentId) && uuid(source?.sourceServiceId) && uuid(source?.sourceInstallationId), 'invalid-school-source');
      if (macSource) assert.deepEqual(source, macSource); else macSource = structuredClone(source);
      return runtime.authorize({ ...source, capabilities: ['teaching.agent'] }, publicState(state).target.serviceId);
    }
    if (input.operation === 'connect') {
      const connection = input.connection, target = connection?.target;
      check(connection?.connectionId === dependencyConnectionId && connection.sourceEnvironmentId === state.environment.environmentId
        && connection.sourceServiceId === publicState(state).target.serviceId && typeof input.token === 'string', 'invalid-dependency-connection');
      check(target?.unit === 'learning-data' && target.environmentId === macSource?.sourceEnvironmentId && target.serviceId === macSource?.sourceServiceId,
        'invalid-dependency-owner');
      check(new URL(target.endpoint).origin === `https://${args['mac-host']}:${port(args['mac-port'])}`, 'dependency-must-use-direct-mac-https');
      assert.deepEqual(connection.requiredCapabilities, ['teaching.dependencies']); assert.deepEqual(connection.optionalCapabilities, []);
      await (input.replace ? runtime.reconnect(connection, input.token) : runtime.connect(connection, input.token));
      return { connected: true, connectionId: dependencyConnectionId, replacement: input.replace === true };
    }
    if (args.artifacts && input.operation.startsWith('artifact.')) return artifactWorker.artifactWorkerOperation(input, { ...artifactContext, state });
    if (input.operation === 'offline') { await runtime.stop(); return { offline: true }; }
    if (input.operation === 'online') { state = await runtime.start(); return publicState(state); }
    if (input.operation === 'restart') { await runtime.stop(); state = await runtime.start(); return publicState(state); }
    throw Object.assign(new Error('unsupported-worker-operation'), { code: 'unsupported-worker-operation' });
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let input;
      try {
        check(Buffer.byteLength(line) <= 1024 * 1024, 'worker-control-too-large');
        input = JSON.parse(line); const result = await handle(input);
        console.log(JSON.stringify({ id: input.id, ok: true, result }));
      } catch (error) { console.log(JSON.stringify({ id: input?.id, ok: false, code: safe(error) })); }
    }
  } finally { await cleanup(); }
}
function remoteDevice() {
  check(/^[A-Za-z0-9_.@-]+$/.test(args.ssh) && !args.ssh.startsWith('-'), 'invalid-ssh-alias');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const remoteProduct = args['remote-product'].replaceAll('\\', '/');
  const launch = `& ${quote(remoteProduct + '/resources/node/node.exe')} ${quote(args['remote-script'])} --worker${args.discovery ? ' --discovery' : ''}`
    + ` --product ${quote(remoteProduct)} --certificate ${quote(args['remote-certificate'])} --key ${quote(args['remote-key'])}`
    + ` --mac-host ${quote(args['mac-host'])} --win-host ${quote(args['win-host'])}`
    + ` --mac-port ${port(args['mac-port'])} --win-port ${port(args['win-port'])}${args.skills ? ' --skills' : ''}${args.artifacts ? ' --artifacts' : ''}`
    + `${args['artifacts-worker-root'] ? ' --artifacts-worker-root ' + quote(args['artifacts-worker-root']) : ''}; exit $LASTEXITCODE`;
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', args.ssh,
    'powershell -NoProfile -EncodedCommand ' + Buffer.from(launch, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let ended = false;
  const completion = new Promise(resolveExit => child.once('close', () => resolveExit()));
  const fail = code => { ended = true; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error(code), { code })); } pending.clear(); };
  child.stderr.on('data', () => {}); // No remote private diagnostic output is published.
  child.stdin.on('error', () => fail('remote-control-write-failed'));
  child.once('error', () => fail('remote-control-error')); child.once('exit', () => fail('remote-control-exited'));
  createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const entry = pending.get(value.id); if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    value.ok ? entry.resolve(value.result) : entry.reject(Object.assign(new Error('remote-operation-failed'), { code: value.code }));
  });
  return { call(operation, input = {}) {
    check(!ended, 'remote-control-exited');
    return new Promise((resolveCall, reject) => {
      const id = randomUUID(), timer = setTimeout(() => {
        pending.delete(id); reject(Object.assign(new Error('remote-control-timeout'), { code: 'remote-control-timeout' }));
      }, 180000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      child.stdin.write(JSON.stringify({ ...input, id, operation }) + '\n', error => {
        if (!error) return; const entry = pending.get(id); if (!entry) return;
        pending.delete(id); clearTimeout(timer); reject(Object.assign(new Error('remote-control-write-failed'), { code: 'remote-control-write-failed' }));
      });
    });
  }, async close() {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 45000);
    try { await completion; } finally { clearTimeout(timer); }
    return { controlProcessExited: true };
  } };
}
async function providerCredential(path) {
  const text = (await readFile(resolve(path), 'utf8')).replace(/^\uFEFF/, '');
  let provider;
  try { provider = JSON.parse(text).providers?.find(item => /deepseek/i.test(item.preset ?? item.name ?? '') && item.key); }
  catch {
    const line = text.split(/\r?\n/).find(value => /deepseek/i.test(value));
    const key = line?.match(/\bsk-[A-Za-z0-9_-]{8,}/)?.[0]; if (key) provider = { key };
  }
  check(typeof provider?.key === 'string' && provider.key.trim(), 'authorized-deepseek-key-unavailable');
  return provider.key.trim();
}
async function providerRelay(key) {
  const requests = [], rejected = [];
  const server = createServer(async (request, response) => {
    let upstream, deadline;
    try {
      check(request.method === 'POST' && request.url === '/v1/chat/completions', 'unexpected-provider-operation');
      check(request.headers.authorization === 'Bearer ' + key && requests.length < limits.maxGenerations, 'provider-budget-or-credential-refused');
      // Reserve before reading the body, so simultaneous arrivals cannot exceed the hard budget.
      const row = { index: requests.length + 1, payloadSha256: null, status: null, finished: false }; requests.push(row);
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; check(bytes <= 4 * 1024 * 1024, 'provider-request-too-large'); chunks.push(chunk); }
      const body = Buffer.concat(chunks), payload = JSON.parse(body);
      check(payload.model === 'deepseek-flash' && payload.stream === true && Number.isInteger(payload.max_tokens)
        && payload.max_tokens > 0 && payload.max_tokens <= limits.maxOutputTokens, 'provider-limits-not-fixed');
      row.payloadSha256 = digest(payload); row.toolSchemaSha256 = digest(payload.tools ?? []);
      if (args.artifacts && args['artifacts-model'] === 'controlled') {
        const { controlledArtifactStream } = await import('./lib/wp09-cross-case.mjs');
        row.status = 200; row.finished = true; row.model = 'controlled-chat-transport';
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(controlledArtifactStream(payload)); return;
      }
      const started = Date.now();
      upstream = https.request({ hostname: 'api.deepseek.com', servername: 'api.deepseek.com', path: '/v1/chat/completions', method: 'POST',
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'text/event-stream',
          'accept-encoding': 'identity', 'content-length': body.length }, timeout: limits.timeoutMs }, incoming => {
        row.status = incoming.statusCode; response.writeHead(incoming.statusCode, { 'content-type': incoming.headers['content-type'] ?? 'text/event-stream' });
        incoming.pipe(response);
        incoming.on('end', () => { row.finished = true; row.elapsedMs = Date.now() - started; });
        incoming.on('error', error => { row.error = safe(error); response.destroy(); });
      });
      deadline = setTimeout(() => { row.error = 'provider-deadline'; upstream.destroy(); }, limits.timeoutMs);
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', error => {
        row.error ??= safe(error); row.elapsedMs = Date.now() - started;
        if (!response.headersSent) response.writeHead(502); response.end();
      });
      response.on('close', () => { clearTimeout(deadline); upstream.destroy(); }); upstream.end(body);
    } catch (error) {
      rejected.push({ code: safe(error) }); clearTimeout(deadline); upstream?.destroy();
      if (!response.headersSent) response.writeHead(429); response.end();
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests, rejected,
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}
async function requestApi(endpoint, route, body, headers = {}) {
  const response = await fetch(endpoint + '/api/learning/' + route, { headers: { 'content-type': 'application/json', ...headers },
    redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]),
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function api(endpoint, route, body, headers) {
  const result = await requestApi(endpoint, route, body, headers);
  check(result.status === 200, 'learning-http-' + result.status); return result;
}
async function until(action, code, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { lifetime.signal.throwIfAborted(); const result = await action(); if (result) return result; await delay(250); }
  throw Object.assign(new Error(code), { code });
}
async function main() {
  check(process.platform === 'darwin', 'mac-controller-required');
  for (const key of ['product', 'remote-product', 'remote-script', 'certificate', 'key', 'remote-certificate', 'remote-key',
    'mac-host', 'win-host', 'credentials-file', 'out']) check(args[key], 'missing-' + key);
  lanIp(args['mac-host']); lanIp(args['win-host']); port(args['mac-port']); port(args['win-port']);
  check(args['mac-host'] !== args['win-host'], 'owners-must-be-on-different-machines');
  const output = resolve(args.out); await mkdir(dirname(output), { recursive: true });
  const report = { issue, measuredAt: new Date().toISOString(), status: 'running', limits,
    topology: { mac: { ip: args['mac-host'], host: hostname(), platform: process.platform, port: port(args['mac-port']) },
      windows: { ip: args['win-host'], port: port(args['win-port']) }, transport: 'direct LAN HTTPS; SSH control only; provider credentials remain on Mac' },
    stages: [], engineering: 'owned-by-main', browser: 'not-run', teachingEffect: 'not-assessed' };
  const persist = () => writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const interrupt = () => lifetime.abort(Object.assign(new Error('probe-interrupted'), { code: 'probe-interrupted' }));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  async function stage(name, action) {
    const row = { name, status: 'running' }; report.stages.push(row); await persist();
    try { lifetime.signal.throwIfAborted(); const fact = await action(); lifetime.signal.throwIfAborted();
      row.status = 'passed'; row.fact = fact; await persist(); return fact; }
    catch (error) { row.status = 'failed'; row.error = safe(error); await persist(); throw error; }
  }
  let runtime, host, root, state, remote, relay;
  const wire = [], counters = new Map();
  try {
    await trust(args.certificate);
    const pkg = await product(args.product); report.packages = { mac: pkg.fact };
    check(process.versions.node.startsWith('24.'), 'node24-required');
    report.probeSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
    root = await mkdtemp(join(tmpdir(), `xj-wp08-${issue}-school-`));
    runtime = pkg.module.openProductRuntime({ root, resources: pkg.resources });
    await stage('mac-school-direct-https', async () => {
      await runtime.install({ profile: 'school', host: '0.0.0.0', port: port(args['mac-port']),
        publicEndpoint: `https://${args['mac-host']}:${port(args['mac-port'])}`,
        tls: { certificateFile: resolve(args.certificate), keyFile: resolve(args.key) } });
      host = await pkg.module.createProductRuntimeHost({ root, createApplication: async context => {
        const app = await pkg.module.createProductLearningApplication(context);
        const entries = Object.entries(app.serviceCapabilities ?? {}).map(([serviceId, handlers]) => [serviceId,
          Object.fromEntries(Object.entries(handlers).map(([capability, handler]) => [capability,
            capability !== 'teaching.dependencies' ? handler : async (value, source) => {
              // Observe the published capability envelope; execute the unmodified production handler.
              const payload = value?.chunkChannel === 1 && value.operation === 'invoke' ? value.value : value;
              const operation = typeof payload?.operation === 'string' && /^(tool\.|model$|authorize$|identityFor$|activity$)/.test(payload.operation) ? payload.operation : null;
              const result = await handler(value, source);
              if (operation) {
                const model = operation === 'model' ? payload.args?.[0] : null;
                const name = model ? 'model.' + model.operation : operation;
                counters.set(name, (counters.get(name) ?? 0) + 1);
                if (operation === 'tool.contributions' || operation === 'tool.dispatch' || args.skills && operation === 'activity') wire.push({ operation, transferId: value.transferId ?? null,
                  inputSha256: digest(payload), sourceEnvironmentId: source.sourceEnvironmentId, sourceServiceId: source.sourceServiceId,
                  targetServiceId: serviceId, state: result?.state ?? (result?.error ? 'rejected' : 'returned'),
                  ...(operation === 'tool.dispatch' ? { commandId: payload.args?.[1]?.commandId ?? null } : {}) });
              }
              return result;
            }]))]);
        return { ...app, serviceCapabilities: Object.fromEntries(entries) };
      } });
      state = await runtime.status();
      check(state.endpoint === `https://${args['mac-host']}:${port(args['mac-port'])}`, 'mac-public-endpoint-mismatch');
      return { environmentId: state.environment.environmentId, installationId: state.environment.installationId, endpoint: state.endpoint,
        units: state.environment.services.map(service => service.unit).sort() };
    });
    const endpoint = state.endpoint, data = state.environment.services.find(service => service.unit === 'learning-data');
    check(data, 'mac-learning-data-owner-missing');
    const admin = { authorization: 'Bearer ' + await pkg.module.resolveCredential(root, 'control') };
    const loginName = 'wp08-cross-' + randomUUID(), password = randomUUID();
    const identity = (await api(endpoint, 'manage/members', { requestId: randomUUID(), loginName, password }, admin)).value;
    const login = await api(endpoint, 'login', { loginName, password });
    const headers = { cookie: login.cookie, 'x-xj-space': 'school' };
    const schoolApi = async (route, body, actor = headers) => (await api(endpoint, route, body, actor)).value;
    const dependencyConnectionId = randomUUID(); remote = remoteDevice();
    const windows = await stage('windows-independent-agent-direct-https', async () => {
      const value = await remote.call('start', { dependencyConnectionId });
      check(value.platform === 'win32' && value.host !== hostname(), 'independent-windows-host-not-proven');
      check(value.probeSha256 === report.probeSha256, 'remote-probe-copy-is-stale');
      check(new URL(value.endpoint).origin === `https://${args['win-host']}:${port(args['win-port'])}`, 'windows-public-endpoint-mismatch');
      return value;
    });
    if (args.artifacts) { check(windows.package.applicationSha256 === pkg.fact.applicationSha256, 'paired-final-applications-must-match'); assert.deepEqual(windows.package.webRuntime, pkg.fact.webRuntime); report.ownerCode = { identicalApplication: windows.package.applicationSha256 === pkg.fact.applicationSha256, commonWebRuntime: pkg.fact.webRuntime, policy: 'Each final package matches its own manifest; Mac owner may include the explicitly authorized backend-only adoption fix.' }; }
    report.packages.windows = windows.package; report.topology.windows.host = windows.host;
    const agentTarget = windows.target;
    let dependencyGrant, dependencyConnection, agentRpc;
    await stage('bidirectional-runtime-authority-and-binding', async () => {
      const accept = await remote.call('authorize', { source: { sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
        sourceInstallationId: state.environment.installationId } });
      const connectionId = randomUUID();
      const inbound = { connectionId, sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId, target: agentTarget,
        requiredCapabilities: ['teaching.agent'], optionalCapabilities: [], credentialRef: 'assembly-cross-agent' };
      await runtime.connect(inbound, accept.token);
      if (args.skills) agentRpc = pkg.module.createOutboundConnection({ connection: inbound, credential: async () => accept.token });
      await schoolApi('manage/agent-binding', { requestId: randomUUID(), identity, connectionId, target: agentTarget,
        installationId: windows.installationId }, admin);
      dependencyGrant = await runtime.authorize({ sourceEnvironmentId: agentTarget.environmentId, sourceServiceId: agentTarget.serviceId,
        sourceInstallationId: windows.installationId, capabilities: ['teaching.dependencies'] }, data.serviceId);
      dependencyConnection = { connectionId: dependencyConnectionId, sourceEnvironmentId: agentTarget.environmentId,
        sourceServiceId: agentTarget.serviceId, target: data, requiredCapabilities: ['teaching.dependencies'], optionalCapabilities: [],
        credentialRef: 'assembly-cross-dependencies' };
      await remote.call('connect', { connection: dependencyConnection, token: dependencyGrant.token });
      return { schoolDataOwner: { environmentId: data.environmentId, serviceId: data.serviceId },
        agentOwner: { environmentId: agentTarget.environmentId, serviceId: agentTarget.serviceId },
        agentConnectionId: connectionId, dependencyConnectionId, acceptGrantId: accept.grantId, dependencyGrantId: dependencyGrant.grantId };
    });
    const providerKey = args.artifacts && args['artifacts-model'] === 'controlled' ? 'isolated-controlled-transport-' + randomUUID() : await providerCredential(args['credentials-file']);
    relay = await providerRelay(providerKey);
    await stage('mac-only-real-provider-configuration', async () => {
      const connectionId = randomUUID();
      await schoolApi('manage/model-default', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: args.artifacts ? 'WP09 cross-owner artifact acceptance' : 'WP08 cross-owner acceptance',
        protocol: 'chat-completions', baseUrl: relay.endpoint + '/v1', path: '/chat/completions', modelId: 'deepseek-flash',
        dialect: 'deepseek', parameterMode: 'thinking', enabled: true, contextWindow: 262144, maxOutputTokens: limits.maxOutputTokens,
        credential: { action: 'replace', value: providerKey }, policy: { checksAllowed: true, maxChecksPerHour: args.artifacts ? 8 : 2,
          maxOutputTokens: Math.min(limits.maxOutputTokens, 2048), timeoutMs: Math.min(limits.timeoutMs, 30000) } }, admin);
      const previous = await schoolApi('models/selection');
      await schoolApi('models/selection', { requestId: randomUUID(), expectedVersion: previous.version, source: { kind: 'school', connectionId } });
      return { model: 'deepseek-flash', protocol: 'chat-completions', connectionId, credentialOwner: 'Mac', credentialExported: false };
    });
    if (args.artifacts) {
      const privateDirectory=await mkdtemp(join(tmpdir(),'xj-wp09-private-resume-'));
      report.privateResume=join(privateDirectory,'resume.json');
      await writeFile(report.privateResume,JSON.stringify({args,root,state,windows,windowsRoot:(await remote.call('artifact.metadata')).root,identity,student:{loginName,password},headers,admin,dependencyConnection},null,2),{mode:0o600});
      const { runArtifactsCase } = await import('./lib/wp09-cross-case.mjs');
      const result = await runArtifactsCase({ args, pkg, runtime, host, root, state, windows, remote, relay, schoolApi, api, requestApi,
        identity, loginName, password, headers, admin, data, agentTarget, dependencyGrant, dependencyConnection, dependencyConnectionId,
        report, stage, persist, check, safe, sha, digest, until, wire, counters });
      check(!Object.keys(result.cleanup).some(key => key.endsWith('Error')), 'artifact-case-cleanup-incomplete');
      report.artifacts = result; report.status = 'passed'; report.browser = 'passed'; return;
    }
    const fixedSkill = args.skills ? { skillId: randomUUID(), version: 1, source: 'course:217-cross-diagnosis', packageVersion: '1.0.0', required: true, files: [
      { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: cross-owner-diagnosis\ndescription: 依据固定附件核对跨机器观察\n---\n仅按学生当前问题解释；读取 references/observation.txt 后核对水位差。' },
      { path: 'references/observation.txt', encoding: 'utf8', content: '217固定附件：初始水位12 cm，最终37 cm；差值25 cm。' },
      { path: 'assets/original.bin', encoding: 'base64', content: Buffer.from([0, 217, 255, 12, 37]).toString('base64') },
      { path: 'scripts/do-not-run.ps1', encoding: 'utf8', content: 'throw "217-script-must-not-execute"' },
    ] } : null;
    let activity;
    if (fixedSkill) {
      const courseId = randomUUID(), releaseId = randomUUID();
      await schoolApi('manage/course-import', { formatVersion: 1, requestId: randomUUID(),
        course: { courseId, name: '217 跨 owner 固定 Skills' }, task: { taskId: randomUUID(), title: '核对固定观察', summary: '' },
        release: { releaseId, objectives: ['核对真实固定依据'], requirements: '只解释差值，不修改作品。',
          helpPolicy: { version: 1, questions: 'allowed', scope: 'course' }, materials: [], starterWorks: [], capabilities: [], skills: [fixedSkill] },
        resources: [] }, admin);
      await schoolApi('manage/course-access', { requestId: randomUUID(), courseId, principalId: identity.principalId, active: true }, admin);
      activity = await schoolApi('course-activities', { requestId: randomUUID(), releaseId });
      assert.deepEqual(activity.course.skills, [fixedSkill]);
      report.skill = { skillId: fixedSkill.skillId, version: fixedSkill.version, source: fixedSkill.source,
        packageVersion: fixedSkill.packageVersion, attachmentSha256: sha(fixedSkill.files[1].content), releaseId };
    } else activity = await schoolApi('activities', { requestId: randomUUID(), goal: '跨机器核对固定原件与版本化能力装配', question: '', references: [] });
    check(activity.target.serviceId === data.serviceId, 'activity-left-mac-owner');
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'cross-observation.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '跨机固定观测：水位从 12 cm 增至 37 cm。原件核对标记：' + randomUUID() };
    await schoolApi('workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    const capability = await schoolApi(`agent/${activity.activityId}/capabilities`);
    check(capability.modelAvailable, 'remote-agent-model-unavailable');
    check(capability.receiver.receiverId === 'teaching-agent:' + agentTarget.serviceId, 'activity-not-routed-to-windows-agent');
    const input = { requestId: randomUUID(), scope: { environmentId: identity.environmentId, spaceId: identity.spaceId,
      principalId: identity.principalId, activityId: activity.activityId }, receiver: capability.receiver,
      draft: { token: randomUUID(), question: (fixedSkill
        ? `先且仅调用一次 skill_read，skillId=${fixedSkill.skillId}，version=1，path=references/observation.txt，offset=0，length=6000。收到真实附件后，简短说明水位差并结束。不得调用其他工具或执行脚本。`
        : args.discovery
        ? '按顺序各调用一次工具：先 discover_tools，参数必须为 {"purpose":"read_work","source":"platform.learning","object":null,"cursor":null,"pageSize":2}；'
          + '再将返回的 read_work bindingId 放入 bindingIds 数组调用 load_tools；'
          + `等加载完成后，仅调用一次 read_work 读取 objectId=${work.objectId}、contentId=${work.contentId} 的固定原件。`
          + '收到真实原件后，简短说明水位增加多少并结束。只调用这三个工具，不修改作品、不提问。'
        : `先且仅调用一次 read_work，读取 objectId=${work.objectId}、contentId=${work.contentId} 的固定原件。`
          + '收到工具结果后，简短说明水位增加多少并结束。必须实际读取工具，不调用其他工具、不修改作品、不提问。'), references: [], bases: [] },
      works: [work], evidence: [] };
    const prepared = await schoolApi('intents/' + activity.activityId, input);
    const base = 'agent/' + activity.activityId;
    await stage('revoked-dependency-refuses-new-operation-without-replay', async () => {
      check(await runtime.revoke(dependencyGrant.grantId), 'dependency-revocation-not-confirmed');
      let disconnected;
      if (args.skills) {
        check((await remote.call('offline')).offline, 'windows-owner-not-offline');
        const pending = await schoolApi(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
        check(pending.state === 'dispatched' && !pending.receipt && pending.inputDigest === prepared.inputDigest,
          'offline-original-action-not-retained');
        const online = await remote.call('online');
        check(online.environmentId === windows.environmentId && online.target.serviceId === agentTarget.serviceId,
          'disconnect-reconnect-replaced-owner');
        disconnected = { outage: 'actual Windows Agent service stopped', originalActionRetained: true, originalOwnerRetained: true };
      }
      const denied = await requestApi(endpoint, base + '/capabilities', undefined, headers);
      check(denied.status === 403 && denied.value.error === 'forbidden', 'revoked-dependency-was-not-refused');
      const blocked = await schoolApi(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
      check(blocked.state === 'dispatched' && blocked.input.requestId === input.requestId && !blocked.receipt, 'revoked-action-was-not-preserved-unconfirmed');
      check(blocked.inputDigest === prepared.inputDigest && relay.requests.length === 0, 'revoked-action-changed-or-dispatched');
      return { dependencyGrantId: dependencyGrant.grantId, operationHttpStatus: denied.status, operationError: denied.value.error,
        requestId: input.requestId, inputSha256: prepared.inputDigest, actionState: blocked.state, modelRequests: 0, ...(disconnected ? { disconnected } : {}) };
    });
    const receipt = await stage('fresh-grant-resumes-the-original-action-identity', async () => {
      const fresh = await runtime.authorize({ sourceEnvironmentId: agentTarget.environmentId, sourceServiceId: agentTarget.serviceId,
        sourceInstallationId: windows.installationId, capabilities: ['teaching.dependencies'] }, data.serviceId);
      check(fresh.grantId !== dependencyGrant.grantId, 'new-grant-identity-required');
      await remote.call('connect', { connection: { ...dependencyConnection, credentialRef: 'assembly-cross-dependencies-renewed' }, token: fresh.token, replace: true });
      const accepted = await schoolApi(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
      check(accepted.state === 'accepted' && accepted.inputDigest === prepared.inputDigest, 'original-action-did-not-recover');
      const runId = JSON.parse(accepted.receipt.detail).runId;
      check(uuid(runId), 'accepted-run-identity-missing');
      dependencyGrant = fresh;
      return { requestId: input.requestId, runId, inputSha256: prepared.inputDigest, dependencyConnectionId, dependencyGrantId: fresh.grantId };
    });
    const final = await stage(args.skills ? 'windows-skill-reads-fixed-mac-course-with-two-real-model-calls'
      : args.discovery ? 'windows-discovery-load-mac-work-and-four-real-model-calls' : 'windows-assembly-mac-work-and-two-real-model-calls', async () => {
      const conversation = await until(async () => {
        const value = await schoolApi(base + '/conversation'), run = value.runs.find(item => item.runId === receipt.runId);
        if (run && ['paused', 'failed', 'stopped'].includes(run.state)) {
          report.failedRun = { runId: run.runId, state: run.state, reason: typeof run.reason === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(run.reason) ? run.reason : 'unclassified' };
          throw Object.assign(new Error('remote-run-not-completed'), { code: 'remote-run-' + run.state });
        }
        return run?.state === 'completed' ? value : null;
      }, 'remote-agent-completion-timeout', args.discovery ? 180000 : 90000);
      check(conversation.runs.length === 1 && conversation.runs[0].requestId === input.requestId, 'action-was-replayed-as-another-run');
      check(conversation.inputs.length === 1 && conversation.inputs[0].requestId === input.requestId, 'original-input-identity-changed');
      const expectedTools = fixedSkill ? ['skill_read'] : args.discovery ? ['discover_tools', 'load_tools', 'read_work'] : ['read_work'];
      check(conversation.tools.length === expectedTools.length && expectedTools.every(name =>
        conversation.tools.filter(tool => tool.name === name && tool.outcome === 'completed').length === 1), 'expected-completed-tool-chain');
      assert.deepEqual(conversation.tools.map(tool => tool.name), expectedTools);
      const tool = conversation.tools.find(tool => tool.name === (fixedSkill ? 'skill_read' : 'read_work'));
      if (fixedSkill) {
        assert.deepEqual(tool.arguments, { skillId: fixedSkill.skillId, version: fixedSkill.version,
          path: 'references/observation.txt', offset: 0, length: 6000 });
        const loaded = tool.result?.loaded;
        check(tool.name === 'skill_read' && tool.outcome === 'completed' && loaded?.content === fixedSkill.files[1].content
          && loaded.skillId === fixedSkill.skillId && loaded.version === fixedSkill.version && loaded.complete
          && loaded.digest === sha(fixedSkill.files[1].content), 'fixed-course-skill-attachment-not-returned');
        check(!JSON.stringify(conversation).includes('217-script-must-not-execute'), 'script-contents-were-loaded-unasked');
      } else check(tool.name === 'read_work' && tool.outcome === 'completed' && tool.result?.file?.value === work.value, 'mac-fixed-work-not-returned');
      if (args.discovery) {
        const discovered = conversation.tools.find(tool => tool.name === 'discover_tools');
        const loaded = conversation.tools.find(tool => tool.name === 'load_tools');
        assert.deepEqual(discovered.arguments, { purpose: 'read_work', source: 'platform.learning', object: null, cursor: null, pageSize: 2 });
        const entry = discovered.result?.entries?.find(entry => entry.definition?.name === 'read_work');
        check(entry && loaded.arguments.bindingIds?.length === 1 && loaded.arguments.bindingIds[0] === entry.bindingId, 'discovered-read-work-binding-not-loaded');
        assert.deepEqual(tool.arguments, { objectId: work.objectId, contentId: work.contentId });
      }
      check(relay.requests.length === limits.maxGenerations && relay.requests.every(item => item.status === 200 && item.finished)
        && relay.rejected.length === 0, args.discovery ? 'real-provider-four-call-boundary-failed' : 'real-provider-two-call-boundary-failed');
      const contributions = wire.filter(item => item.operation === 'tool.contributions' && item.state === 'completed');
      check(contributions.length > 0 && contributions.every(item => item.sourceEnvironmentId === agentTarget.environmentId
        && item.sourceServiceId === agentTarget.serviceId && item.targetServiceId === data.serviceId), 'cross-owner-tool-contributions-not-witnessed');
      const dispatches = wire.filter(item => item.operation === 'tool.dispatch' && item.state === 'completed');
      if (fixedSkill) check(wire.some(item => item.operation === 'activity' && item.sourceServiceId === agentTarget.serviceId), 'fixed-course-owner-read-not-witnessed');
      else check(dispatches.length === 1 && dispatches[0].commandId === tool.commandId, 'tool-command-owner-not-witnessed');
      report.conversationSha256 = digest(conversation); report.wire = wire;
      if (fixedSkill) report.skill.commandId = tool.commandId;
      else report.work = { objectId: work.objectId, contentId: work.contentId, contentSha256: sha(work.value), commandId: tool.commandId };
      // Only the digest of the full public conversation is retained, not its content.
      return { runId: receipt.runId, requestId: input.requestId, activityId: activity.activityId, toolCommandId: tool.commandId,
        fixedContentSha256: sha(fixedSkill ? tool.result.loaded.content : tool.result.file.value), modelRequests: relay.requests.length,
        ...(!fixedSkill ? { workContentSha256: sha(tool.result.file.value) } : {}),
        contributionTransfers: contributions.length, toolDispatches: dispatches.length, ...(args.discovery ? { completedTools: expectedTools } : {}) };
    });
    const events = await schoolApi(base + '/events');
    const snapshots = [];
    await stage('public-snapshots-match-actual-transport-and-fixed-assembly', async () => {
      for (const event of events.filter(item => item.kind === 'context-assembled')) {
        const snapshot = await schoolApi(base + '/snapshots/' + event.body.snapshotId); snapshots.push(snapshot);
        check(snapshot.assemblyVersion === 2 && snapshot.resolvedAgent.scope.activityId === activity.activityId
          && snapshot.resolvedAgent.scope.environmentId === data.environmentId, 'snapshot-assembly-scope-mismatch');
        check(snapshot.contextManifest.resolvedId === snapshot.resolvedAgent.resolvedId
          && snapshot.contextManifest.payloadSha256 === snapshot.payloadSha256 && digest(snapshot.payload) === snapshot.payloadSha256,
          'snapshot-transport-identity-mismatch');
        check(relay.requests.some(item => item.payloadSha256 === snapshot.payloadSha256), 'actual-provider-payload-not-matched');
        check(snapshot.contextManifest.items.every(item => digest(item.content) === item.contentDigest), 'context-manifest-content-not-fixed');
        const expectedTool = fixedSkill ? 'skill_read' : 'read_work';
        check(snapshot.resolvedAgent.tools.some(tool => tool.modelName === expectedTool && tool.executor.toolName === expectedTool
          && tool.resourceScope.activityId === activity.activityId), 'original-read-binding-not-retained');
        if (fixedSkill) {
          check(snapshot.resolvedAgent.skills.catalog.some(item => item.skillId === fixedSkill.skillId && item.origin === 'course'), 'fixed-course-catalog-not-retained');
          check(!JSON.stringify(snapshot.payload.messages.filter(message => message.role === 'system')).includes('仅按学生当前问题解释'), 'skill-body-promoted-to-system');
        }
      }
      check(snapshots.length === limits.maxGenerations, args.discovery ? 'expected-four-original-snapshots' : 'expected-two-original-snapshots');
      for (const request of relay.requests)
        check(snapshots.filter(snapshot => snapshot.payloadSha256 === request.payloadSha256).length === 1, 'provider-request-without-unique-original-snapshot');
      if (fixedSkill) {
        const attachment = snapshots[1].contextManifest.items.find(item => item.selection?.access === 'fixed-skill-content'
          && item.content?.skillId === fixedSkill.skillId && item.content?.path === 'references/observation.txt');
        check(attachment?.content?.content === fixedSkill.files[1].content && attachment.content.digest === sha(fixedSkill.files[1].content),
          'actual-attachment-not-fixed-in-step-manifest');
        check(snapshots[1].segmentId === snapshots[0].segmentId, 'progressive-skill-read-broke-original-native-pair');
      }
      report.snapshots = snapshots.map(snapshot => ({ snapshotId: snapshot.snapshotId, attemptId: snapshot.attemptId,
        segmentId: snapshot.segmentId, resolvedId: snapshot.resolvedAgent.resolvedId, definitionId: snapshot.resolvedAgent.definition.definitionId,
        definitionVersion: snapshot.resolvedAgent.definition.version, contextManifestId: snapshot.contextManifest.manifestId,
        payloadSha256: snapshot.payloadSha256, counting: snapshot.contextManifest.capacity.counting }));
      return { runId: final.runId, snapshots: report.snapshots, pureReads: true };
    });
    await stage('windows-process-restart-retains-original-request-without-model-or-tool', async () => {
      const beforeCounts = Object.fromEntries(counters), beforeRequests = relay.requests.length;
      const beforeReceipt = await schoolApi(base + '/requests/' + input.requestId);
      const beforeEventsDigest = digest(await schoolApi(base + '/events'));
      const restarted = await remote.call('restart');
      check(restarted.environmentId === windows.environmentId && restarted.installationId === windows.installationId
        && restarted.target.serviceId === agentTarget.serviceId, 'restart-replaced-original-owner');
      check(digest(await schoolApi(base + '/conversation')) === report.conversationSha256, 'restart-changed-original-conversation');
      assert.deepEqual(await schoolApi(base + '/requests/' + input.requestId), beforeReceipt);
      check(digest(await schoolApi(base + '/events')) === beforeEventsDigest, 'restart-appended-effect-history');
      for (const snapshot of snapshots) check(digest(await schoolApi(base + '/snapshots/' + snapshot.snapshotId)) === digest(snapshot), 'restart-changed-original-snapshot');
      check(relay.requests.length === beforeRequests && relay.rejected.length === 0, 'restart-generated-another-model-call');
      for (const operation of ['tool.contributions', 'tool.prepare', 'tool.dispatch', 'tool.reconcile', 'model.checks.receive', 'model.checks.dispatch'])
        check((counters.get(operation) ?? 0) === (beforeCounts[operation] ?? 0), 'restart-replayed-' + operation.replaceAll('.', '-'));
      return { environmentId: restarted.environmentId, agentServiceId: agentTarget.serviceId, runId: receipt.runId,
        requestId: input.requestId, conversationSha256: report.conversationSha256, modelRequests: 0, newToolOperations: 0 };
    });
    if (fixedSkill) await stage('revocation-refuses-new-skill-owner-reads-without-model-replay', async () => {
      const beforeRequests = relay.requests.length;
      const read = { version: 1, operation: 'skills.read', identity, activityId: activity.activityId,
        args: [{ skillId: fixedSkill.skillId, version: fixedSkill.version, path: 'references/observation.txt' }] };
      const original = await agentRpc.request('teaching.agent', read);
      check(original?.content === fixedSkill.files[1].content, 'live-attachment-owner-read-not-proven');
      check(await runtime.revoke(dependencyGrant.grantId), 'skill-dependency-revocation-not-confirmed');
      const denied = await requestApi(endpoint, base + '/skills', undefined, headers);
      check(denied.status === 403 && denied.value.error === 'forbidden', 'revoked-skill-read-was-not-refused');
      const deniedAttachment = await agentRpc.request('teaching.agent', read);
      check(deniedAttachment?.error === 'forbidden' && !deniedAttachment.content, 'revoked-attachment-bytes-were-disclosed');
      check(relay.requests.length === beforeRequests, 'revocation-read-generated-model-call');
      return { newReadHttpStatus: denied.status, error: denied.value.error, attachmentReadError: deniedAttachment.error,
        attachmentBytesDisclosed: false, newModelRequests: 0, originalRequestId: input.requestId };
    });
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = safe(error);  }
  finally {
    if (args.artifacts) report.modelSource = args['artifacts-model'] === 'controlled' ? 'controlled external Chat transport; no real supplier calls' : 'real DeepSeek chat-completions';
    report.providerRequests = relay?.requests ?? []; report.providerRefusals = relay?.rejected ?? [];
    report.dependencyOperations = Object.fromEntries(counters);
    report.cleanup = {};
    try { await relay?.close(); report.cleanup.providerRelayClosed = true; }
    catch (error) { report.cleanup.providerError = safe(error); }
    if (remote) {
      if(args.artifacts && args['artifacts-keep-failure'] && report.status!=='passed')try{report.retainedWindows=await remote.call('retain');}catch(error){report.retentionError=safe(error);}
      try { report.cleanup.windows = await remote.call('cleanup'); }
      catch (error) { report.cleanup.windows = { error: safe(error) }; }
      try { Object.assign(report.cleanup, await remote.close()); }
      catch (error) { report.cleanup.controlError = safe(error); }
    }
    try { if (!report.artifacts?.cleanup?.originalMacHostStopped) await host?.stop(); }
    catch (error) { report.cleanup.macHostError = safe(error); }
    if (runtime && root) { if(args.artifacts && args['artifacts-keep-failure'] && report.status!=='passed'){await runtime.stop();report.cleanup.mac={stopped:true,retained:true,rootRemoved:false,root};report.retained=true;}else report.cleanup.mac = await removeEnvironment(runtime, root, state); }
    if (report.status === 'passed' && (!report.cleanup.windows?.rootRemoved || !report.cleanup.mac?.rootRemoved
      || report.cleanup.controlError || report.cleanup.providerError || report.cleanup.macHostError)) report.status = 'failed';
    report.finishedAt = new Date().toISOString(); await persist();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    if (args.artifacts) { console.log(JSON.stringify({status:report.status,report:output,modelRequests:report.providerRequests.length,browser:report.browser,error:report.error})); if(report.status!=='passed') process.exitCode=1; }
  }
  console.log(JSON.stringify({ status: report.status, report: output, modelRequests: report.providerRequests.length,
    browser: report.browser, ...(report.error ? { error: report.error } : {}) }));
  if (report.status !== 'passed') process.exitCode = 1;
}
async function resumeArtifacts() {
  check(process.platform === 'darwin' && resumeConfiguration, 'retained-Mac-controller-required');
  const cfg = resumeConfiguration, originalBytes = await readFile(cfg.args.out);
  const previous = JSON.parse(originalBytes), output = resolve(args.out);
  const report = { issue: 224, status: 'running', measuredAt: new Date().toISOString(),
    scope: 'Same original two-host generation, candidates and student input; recovery continuation without model requests',
    sourceReport: cfg.args.out, sourceReportSha256: sha(originalBytes),
    priorStages: previous.stages, priorProviderRequests: previous.providerRequests,
    privateResume: args['artifacts-resume'], stages: [], browser: 'not-run', teachingEffect: 'not-assessed' };
  await mkdir(dirname(output), { recursive: true });
  const persist = () => writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const stage = async (name, action) => {
    const row = { name, status: 'running' }; report.stages.push(row); await persist();
    console.log(JSON.stringify({ stage: name, status: 'running' }));
    try { const fact = await action(); row.status = 'passed'; row.fact = fact; await persist();
      console.log(JSON.stringify({ stage: name, status: 'passed' })); return fact; }
    catch (error) { row.status = 'failed'; row.error = safe(error); await persist(); throw error; }
  };
  let runtime, host, remote, firewall;
  const wire = [], counters = new Map(), unexpected = [];
  const { windowsControl, runArtifactsCase } = await import('./lib/wp09-cross-case.mjs');
  const q = value => "'" + value.replaceAll("'", "''") + "'";
  const ps = source => windowsControl(args.ssh, source);
  try {
    await trust(args.certificate);
    const pkg = await product(args.product);
    for (const name of ['probe-teaching-assembly-cross.mjs', 'probe-wp09-cross.mjs', 'lib/wp09-cross-case.mjs'])
      await exec('scp', ['-q', fileURLToPath(new URL(name, import.meta.url)), args.ssh + ':' + args['remote-script'].replace(/\/[^/]+$/, '') + '/' + name]);
    firewall = 'XunJie-WP09-Recovery-' + randomUUID();
    await ps(`New-NetFirewallRule -Name ${q(firewall)} -DisplayName ${q(firewall)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port(args['win-port'])},${port(args['win-port']) + 2} -RemoteAddress ${q(args['mac-host'])} -Profile Any|Out-Null`);
    runtime = pkg.module.openProductRuntime({ root: cfg.root, resources: pkg.resources });
    host = await pkg.module.createProductRuntimeHost({ root: cfg.root, createApplication: async context => {
      context.configuration.resources.webRoot = pkg.resources.webRoot;
      const application = await pkg.module.createProductLearningApplication(context);
      const services = Object.fromEntries(Object.entries(application.serviceCapabilities ?? {}).map(([id, handlers]) => [id,
        Object.fromEntries(Object.entries(handlers).map(([capability, handler]) => [capability, capability !== 'teaching.dependencies' ? handler : async (value, source) => {
          const payload = value?.chunkChannel === 1 && value.operation === 'invoke' ? value.value : value;
          const operation = payload?.operation === 'model' ? 'model.' + payload.args?.[0]?.operation : payload?.operation;
          if (typeof operation === 'string') counters.set(operation, (counters.get(operation) ?? 0) + 1);
          if (['model.checks.receive', 'model.checks.dispatch', 'tool.prepare', 'tool.dispatch'].includes(operation)) {
            unexpected.push(operation); throw Object.assign(new Error(), { code: 'recovery-attempted-new-generation' });
          }
          return handler(value, source);
        }]))]));
      return { ...application, serviceCapabilities: services };
    } });
    let state = await runtime.status();
    if (state.state === 'maintenance') { await host.recovery.resume(); state = await runtime.status(); }
    check(state.environment.environmentId === cfg.state.environment.environmentId
      && state.environment.installationId === cfg.state.environment.installationId, 'retained-Mac-identity-changed');
    remote = remoteDevice();
    const windows = await stage('same-native-owners-restarted', async () => {
      const value = await remote.call('resume', { dependencyConnectionId: cfg.dependencyConnection.connectionId });
      check(value.environmentId === cfg.windows.environmentId && value.installationId === cfg.windows.installationId,
        'retained-Windows-identity-changed');
      check(value.package.applicationSha256 === pkg.fact.applicationSha256, 'retained-package-code-mismatch');
      assert.deepEqual(value.package.webRuntime, pkg.fact.webRuntime);
      return value;
    });
    const web = pkg.fact.webRuntime[0], webResponse = await fetch(state.endpoint + web.path.replace(/^web/, ''));
    check(webResponse.status === 200 && sha(Buffer.from(await webResponse.arrayBuffer())) === web.sha256, 'served-Web-does-not-match-package');
    report.packages = { mac: { ...pkg.fact, servedWebVerified: true }, windows: windows.package };
    const endpoint = state.endpoint, headers = cfg.headers, admin = cfg.admin;
    const schoolApi = async (route, body, actor = headers) => (await api(endpoint, route, body, actor)).value;
    await stage('original-public-candidates-and-Run-facts', async () => {
      const activityId = previous.artifacts.activityId;
      const artifacts = await schoolApi('artifacts/' + activityId);
      const attempts=[];report.originalConversationReadAttempts=attempts;
      const conversation = await until(async()=>{
        const reply=await requestApi(endpoint,'agent/'+activityId+'/conversation',undefined,headers);
        attempts.push({status:reply.status,...(typeof reply.value?.error==='string'&&/^[a-z-]{1,100}$/.test(reply.value.error)?{error:reply.value.error}:{})});
        await persist();if(reply.status===200)return reply.value;
        check([409,503].includes(reply.status),'retained-conversation-http-'+reply.status);return null;
      },'retained-conversation-not-recovered',30000);
      return { artifacts, runs: conversation.runs.map(run => ({ runId: run.runId, state: run.state, stopRequested: run.stopRequested })),
        tools: conversation.tools.map(tool => ({ commandId: tool.commandId, name: tool.name, outcome: tool.outcome,
          ...(tool.result?.artifact ? { artifact: tool.result.artifact } : {}) })),
        candidates: await Promise.all(artifacts.map(artifact => schoolApi(`artifacts/${activityId}/candidates/${artifact.latestCandidateId}`))) };
    });
    const relay = { requests: [...previous.providerRequests], rejected: [], async close() {} };
    const data = state.environment.services.find(service => service.unit === 'learning-data');
    const result = await runArtifactsCase({ args, pkg, runtime, host, root: cfg.root, state, windows, remote, relay,
      schoolApi, api, requestApi, identity: cfg.identity, loginName: cfg.student.loginName, password: cfg.student.password,
      headers, admin, data, agentTarget: windows.target, dependencyConnection: cfg.dependencyConnection,
      dependencyConnectionId: cfg.dependencyConnection.connectionId, report, stage, persist, check, safe, sha, digest, until, wire, counters,
      resume: previous });
    check(unexpected.length === 0, 'recovery-attempted-new-generation');
    check(!Object.keys(result.cleanup).some(key => key.endsWith('Error')), 'recovery-cleanup-incomplete');
    report.artifacts = result; report.newModelRequests = 0; report.newGenerationOperations = 0;
    report.status = 'passed'; report.browser = 'passed';
  } catch (error) { report.status = 'failed'; report.error = safe(error);  }
  finally {
    report.unexpectedGenerationOperations = unexpected; report.dependencyOperations = Object.fromEntries(counters); report.cleanup = {};
    if (remote) {
      try { report.cleanup.windows = await remote.call('cleanup', { remove: report.status === 'passed' }); }
      catch (error) { report.cleanup.windowsError = safe(error); }
      try { Object.assign(report.cleanup, await remote.close()); }
      catch (error) { report.cleanup.controlError = safe(error); }
    }
    try { if (!report.artifacts?.cleanup?.originalMacHostStopped) await host?.stop(); }
    catch (error) { report.cleanup.macHostError = safe(error); }
    if (runtime) {
      if (report.status === 'passed') report.cleanup.mac = await removeEnvironment(runtime, cfg.root, cfg.state);
      else { try { await runtime.stop(); report.cleanup.mac = { stopped: true, retained: true }; }
        catch (error) { report.cleanup.macStopError = safe(error); } }
    }
    if (firewall) {
      try { await ps(`Remove-NetFirewallRule -Name ${q(firewall)}`); report.cleanup.scopedFirewallRemoved = true; }
      catch (error) { report.cleanup.firewallError = safe(error); }
    }
    if (Object.keys(report.cleanup).some(key => key.endsWith('Error'))
      || report.status === 'passed' && (!report.cleanup.mac?.rootRemoved || !report.cleanup.windows?.rootRemoved)) report.status = 'failed';
    report.finishedAt = new Date().toISOString(); await persist();
  }
  console.log(JSON.stringify({ status: report.status, report: output, newModelRequests: report.newModelRequests, error: report.error }));
  if (report.status !== 'passed') process.exitCode = 1;
}
async function finishActiveTakeover() {
  const cfg=resumeConfiguration, prior=JSON.parse(await readFile(cfg.takeover.report,'utf8')), artifacts=prior.artifacts;
  const output=resolve(args.out),report={issue:224,status:'running',measuredAt:new Date().toISOString(),
    scope:'Continue the two already active original recovery targets; original sources stay retired',sourceReport:cfg.takeover.report,
    stages:[],newModelRequests:0,newGenerationOperations:0,teachingEffect:'not-assessed'};
  const persist=()=>writeFile(output,JSON.stringify(report,null,2)+'\n');
  const stage=async(name,action)=>{const row={name,status:'running'};report.stages.push(row);await persist();console.log(JSON.stringify({stage:name,status:'running'}));try{row.fact=await action();row.status='passed';await persist();console.log(JSON.stringify({stage:name,status:'passed'}));return row.fact;}catch(e){row.status='failed';row.error=safe(e);await persist();throw e;}};
  const {windowsControl,stableTlsIngress,artifactChromeJob,runWindowsLocalCase}=await import('./lib/wp09-cross-case.mjs');
  const {acquireNativeDesktop}=await import('./lib/native-desktop-lock.mjs');
  const q=s=>"'"+s.replaceAll("'","''")+"'",ps=(s,input)=>windowsControl(args.ssh,s,input);
  let host,runtime,remote,ingress,firewall,pkg,state,windows;
  const rejected=[];report.unexpectedGenerationOperations=rejected;
  try {
    await trust(args.certificate);pkg=await product(args.product);
    const remoteBase=args['remote-script'].replace(/\/[^/]+$/,'');
    for(const name of ['probe-teaching-assembly-cross.mjs','probe-wp09-cross.mjs','lib/wp09-cross-case.mjs'])await exec('scp',['-q',fileURLToPath(new URL(name,import.meta.url)),args.ssh+':'+remoteBase+'/'+name]);
    firewall='XunJie-WP09-Finish-'+randomUUID();await ps(`New-NetFirewallRule -Name ${q(firewall)} -DisplayName ${q(firewall)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port(args['win-port'])},${port(args['win-port'])+2} -RemoteAddress ${q(args['mac-host'])} -Profile Any|Out-Null`);
    runtime=pkg.module.openProductRuntime({root:cfg.takeover.macRoot,resources:pkg.resources});
    host=await pkg.module.createProductRuntimeHost({root:cfg.takeover.macRoot,createApplication:async context=>{
      context.configuration.resources.webRoot=pkg.resources.webRoot;
      const app=await pkg.module.createProductLearningApplication(context);
      return {...app,serviceCapabilities:Object.fromEntries(Object.entries(app.serviceCapabilities??{}).map(([id,handlers])=>[id,Object.fromEntries(Object.entries(handlers).map(([cap,handler])=>[cap,cap!=='teaching.dependencies'?handler:async(value,source)=>{
        const input=value?.chunkChannel===1&&value.operation==='invoke'?value.value:value,operation=input?.operation==='model'?'model.'+input.args?.[0]?.operation:input?.operation;
        if(['model.checks.receive','model.checks.dispatch','tool.prepare','tool.dispatch'].includes(operation)){rejected.push(operation);throw Object.assign(new Error(),{code:'takeover-generated-new-work'});}return handler(value,source);
      }]))]))};
    }});state=await runtime.status();
    ingress=await stableTlsIngress({certificate:args.certificate,key:args.key,port:port(args['mac-port']),target:state.endpoint});
    remote=remoteDevice();
    windows=await stage('same-two-active-targets-and-retirement-proofs',async()=>{
      const value=await remote.call('resume-takeover',{root:cfg.takeover.windowsRoot,dependencyConnectionId:cfg.dependencyConnection.connectionId});
      const proof=JSON.parse(await readFile(join(cfg.root,'retired.json'),'utf8'));
      check(proof.targetInstallationId===state.environment.installationId&&state.environment.installationId===artifacts.recovery.isolated.mac.installationId,'Mac-takeover-target-changed');
      check(value.target.environment.installationId===artifacts.recovery.isolated.windows.installationId,'Windows-takeover-target-changed');
      check(value.package.applicationSha256===pkg.fact.applicationSha256,'active-package-code-mismatch');
      await remote.call('artifact.switch-ingress');return value;
    });
    report.packages={mac:pkg.fact,windows:windows.package};
    const data=cfg.state.environment.services.find(s=>s.unit==='learning-data'),agent=cfg.windows.target;
    await stage('restored-receiver-revalidates-the-same-Mac-installation-succession',async()=>{
      const ids=cfg.state.environment.services.map(s=>s.serviceId).sort(),member=artifacts.recovery.members.find(m=>m.environmentId===cfg.state.environment.environmentId);
      const proof=await remote.call('artifact.fence-active',{fence:{sourceEnvironmentId:cfg.state.environment.environmentId,sourceServiceId:ids[0],sourceServiceIds:ids,
        sourceInstallationId:cfg.state.environment.installationId,backupId:member.backupId,targetInstallationId:state.environment.installationId}});
      check(proof.execution?.unresolved===0&&proof.execution?.blocking===0,'active-receiver-fence-not-confirmed');return {backupId:member.backupId,sourceInstallationId:cfg.state.environment.installationId,targetInstallationId:state.environment.installationId,execution:proof.execution};
    });
    await stage('fresh-grants-preserve-the-original-fixed-owner-descriptors',async()=>{
      const installed=JSON.parse(await readFile(join(cfg.root,'installation.json'),'utf8')),connection=installed.connections.find(c=>c.requiredCapabilities.includes('teaching.agent'));
      const grant=await remote.call('artifact.authorize',{source:{sourceEnvironmentId:data.environmentId,sourceServiceId:data.serviceId,sourceInstallationId:state.environment.installationId},targetServiceId:agent.serviceId});
      const targetConfig=JSON.parse(await readFile(join(cfg.takeover.macRoot,'installation.json'),'utf8'));
      await runtime[targetConfig.connections.some(c=>c.connectionId===connection.connectionId)?'reconnect':'connect']({...connection,credentialRef:'wp09-finish-agent-'+randomUUID()},grant.token);
      const dependency=await runtime.authorize({sourceEnvironmentId:agent.environmentId,sourceServiceId:agent.serviceId,sourceInstallationId:windows.target.environment.installationId,capabilities:['teaching.dependencies']},data.serviceId);
      await remote.call('artifact.connect',{connection:{...cfg.dependencyConnection,credentialRef:'wp09-finish-dependencies-'+randomUUID()},token:dependency.token});
      return {fixedOwnerDescriptorsRetained:true,macInstallationId:state.environment.installationId,windowsInstallationId:windows.target.environment.installationId};
    });
    const login=await api(state.endpoint,'login',{loginName:cfg.student.loginName,password:cfg.student.password}),ns=(await api(state.endpoint,'context',undefined,{cookie:login.cookie})).value.clientNamespace;
    const actor={cookie:login.cookie,'x-xj-space':'school','x-xj-namespace':ns},read=async route=>(await api(state.endpoint,route,undefined,actor)).value,id=artifacts.activityId;
    let expected;
    await stage('original-artifact-resources-input-and-Runs-after-formal-takeover',async()=>{
      const head=await read('workspaces/'+id);check(head.revision===artifacts.state.workRevision,'takeover-work-revision-changed');
      for(const file of artifacts.state.files){const current=head.files.find(f=>f.objectId===file.objectId);check(current?.contentId===file.contentId&&sha(current.value)===file.sha256,'takeover-fixed-input-changed');}
      expected=JSON.parse(head.files.find(f=>f.name==='components/artifact-'+artifacts.originals[0].artifactId+'.json').value).content.explanation;
      for(const original of artifacts.originals){const fixed=await read(`artifacts/${id}/${original.artifactId}/revisions/${original.revisionId}`);check(fixed.sha256===original.resourceSha256&&fixed.origin.runId===original.runId&&fixed.origin.commandId===original.commandId,'takeover-fixed-source-changed');}
      const attempts=[];const conversation=await until(async()=>{const r=await requestApi(state.endpoint,'agent/'+id+'/conversation',undefined,actor);attempts.push({status:r.status,error:typeof r.value?.error==='string'?r.value.error:undefined});if(r.status===200)return r.value;check([409,503].includes(r.status),'takeover-conversation-denied');return null;},'takeover-conversation-not-recovered',30000);
      check(conversation.runs.length===artifacts.originals.length&&artifacts.originals.every(o=>conversation.runs.some(r=>r.runId===o.runId)),'takeover-changed-original-Runs');
      return {workRevision:head.revision,inputSha256:sha(expected),runIds:conversation.runs.map(r=>r.runId),conversationAttempts:attempts,newModelRequests:0};
    });
    await stage('both-retired-sources-and-old-browser-namespace-refuse-new-work',async()=>{
      const old=await requestApi(cfg.state.endpoint,'artifacts/'+id+'/shelf',{requestId:randomUUID(),artifactId:artifacts.originals[0].artifactId,shelved:false},cfg.headers);
      check([401,403].includes(old.status),'old-browser-namespace-accepted');
      let mac=false;try{await pkg.module.openProductRuntime({root:cfg.root}).connect({...cfg.dependencyConnection,connectionId:randomUUID()},'unused-retired-probe');}catch(e){mac=e.code==='source-retired';}check(mac,'old-Mac-can-configure-new-work');
      const win=await remote.call('artifact.assert-retired',{connection:cfg.dependencyConnection,token:'unused-retired-probe'});check(win.rejected&&win.code==='source-retired','old-Windows-can-configure-new-work');
      return {macRetired:true,windowsRetired:true,oldBrowserHttpStatus:old.status};
    });
    const spki=createHash('sha256').update(new X509Certificate(await readFile(args.certificate)).publicKey.export({type:'spki',format:'der'})).digest('base64');
    async function browser(platform){
      const release=await acquireNativeDesktop(platform==='win32'?'windows':'macos',args['artifacts-session'],'WP09 final active takeover Chrome');
      const local=await mkdtemp(join(tmpdir(),'xj-wp09-final-Chrome-'));let task;
      try{
        const remoteDir=remoteBase+'/takeover-Chrome-'+randomUUID(),base=platform==='win32'?remoteDir:local;
        const head=await read('workspaces/'+id),value=JSON.parse(head.files.find(f=>f.name==='components/artifact-'+artifacts.originals[0].artifactId+'.json').value).content.explanation;
        const job={endpoint:state.endpoint,student:cfg.student,activityId:id,expected:value,readOnlyView:true,takeoverView:true,spki,
          certificate:platform==='win32'?args['remote-certificate']:args.certificate,product:platform==='win32'?args['remote-product']:pkg.root,
          applicationSha256:pkg.fact.applicationSha256,playwright:platform==='win32'?'C:/Users/h/XunJie-acceptance/package.json':resolve('apps/web/package.json'),result:base+'/result.json',screenshot:base+'/screen.png'};
        let result;
        if(platform==='win32'){
          task='XunJie-WP09-Takeover-'+randomUUID();const launch='"'+remoteBase+'/probe-wp09-cross.mjs" --chrome-job "'+base+'/job.json"';
          await ps(`New-Item -ItemType Directory -Path ${q(base)}|Out-Null;[IO.File]::WriteAllText(${q(base+'/job.json')},[Console]::In.ReadToEnd(),[Text.UTF8Encoding]::new($false));$a=New-ScheduledTaskAction -Execute ${q(args['remote-product']+'/resources/node/node.exe')} -Argument ${q(launch)};$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3);Register-ScheduledTask -TaskName ${q(task)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${q(task)}`,JSON.stringify(job));
          result=await until(async()=>{const text=await ps(`if(Test-Path -LiteralPath ${q(job.result)}){[IO.File]::ReadAllText(${q(job.result)})}`);const value=text?JSON.parse(text):null;if(value?.status==='failed')throw Object.assign(new Error(),{code:value.error});return value?.status==='passed'?value:null;},'takeover-Windows-Chrome-timeout',120000);
        }else{await writeFile(base+'/job.json',JSON.stringify(job),{mode:0o600});await artifactChromeJob(base+'/job.json');result=JSON.parse(await readFile(job.result,'utf8'));check(result.status==='passed','takeover-Mac-Chrome-failed');}
        const shots=[];for(const shot of result.screenshots){const bytes=platform==='win32'?Buffer.from(await ps(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${q(shot.path)}))`),'base64'):await readFile(shot.path);check(sha(bytes)===shot.sha256,'takeover-screenshot-mismatch');const path=join(dirname(output),platform+'-takeover.png');await writeFile(path,bytes);shots.push({path,sha256:shot.sha256});}
        return {status:'passed',checks:result.checks,chromeVersion:result.chromeVersion,screenshots:shots};
      }finally{if(task)await ps(`Stop-ScheduledTask -TaskName ${q(task)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${q(task)} -Confirm:$false`);await release();await rm(local,{recursive:true,force:true});}
    }
    report.windows=await stage('Windows-Interactive-Limited-Chrome-reopens-the-active-takeover',()=>browser('win32'));
    report.mac=await stage('Mac-Chrome-reopens-the-active-takeover',()=>browser('darwin'));
    report.windowsLocal=await stage('Windows-standalone-final-product-and-Chrome',()=>runWindowsLocalCase({args,remote,pkg,windows,report,persist,until}));
    check(rejected.length===0,'takeover-generated-new-work');report.status='passed';report.browser='passed';
  }catch(e){report.status='failed';report.error=safe(e);}
  finally{
    report.cleanup={};if(remote){try{report.cleanup.windows=await remote.call('cleanup',{remove:report.status==='passed'});}catch(e){report.cleanup.windowsError=safe(e);}try{await remote.close();report.cleanup.controlProcessExited=true;}catch(e){report.cleanup.controlError=safe(e);}}
    try{await ingress?.close();await host?.stop();if(runtime){await runtime.stop();if(report.status==='passed'){await runtime.deleteEnvironment({environmentId:state.environment.environmentId});await rm(join(cfg.root,'pg-diagnostic.log'),{force:true});const source=pkg.module.openProductRuntime({root:cfg.root});await source.deleteEnvironment({environmentId:cfg.state.environment.environmentId});await rm(dirname(cfg.takeover.macRoot),{recursive:true,force:true});report.cleanup.macRootsRemoved=true;}else report.cleanup.macTargetsRetained=true;}}catch(e){report.cleanup.macError=safe(e);}
    if(firewall){try{await ps(`Remove-NetFirewallRule -Name ${q(firewall)}`);report.cleanup.scopedFirewallRemoved=true;}catch(e){report.cleanup.firewallError=safe(e);}}
    if(Object.keys(report.cleanup).some(k=>k.endsWith('Error')))report.status='failed';report.finishedAt=new Date().toISOString();await persist();
  }
  console.log(JSON.stringify({status:report.status,report:output,error:report.error}));if(report.status!=='passed')process.exitCode=1;
}
try { if (args.worker) await worker(); else if (takeoverContinuation) await finishActiveTakeover(); else if (resumeConfiguration) await resumeArtifacts(); else await main(); }
catch (error) { console.log(JSON.stringify({ status: 'failed', error: safe(error) }));  process.exitCode = 1; }
