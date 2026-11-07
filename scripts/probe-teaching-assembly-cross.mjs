// Explicit WP08 acceptance. Only control travels over SSH; product calls use verified LAN HTTPS.
import assert from 'node:assert/strict';
import { parseArgs, promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
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
  worker: { type: 'boolean' }, help: { type: 'boolean' }, discovery: { type: 'boolean' },
} });
const issue = args.discovery ? 216 : 215;
args['mac-port'] ??= args.discovery ? '38265' : '38215';
args['win-port'] ??= args.discovery ? '38266' : '38216';
const limits = Object.freeze({ maxGenerations: args.discovery ? 4 : 2, maxOutputTokens: 2048, timeoutMs: 30000, retries: 0 });
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
  [--mac-port 38215 --win-port 38216] [--discovery]
Creates an isolated Mac school and Windows Agent. The same test CA/certificate must cover both IPs.
Open Windows TCP 38216 only to the Mac IP; open Mac TCP 38215 only to the Windows IP.
Copy this script and the test certificates before running. It never copies provider credentials.
A fresh dependency operation is denied under a revoked grant before any Agent Run/model call;
renewing only that connection's grant then reconciles and dispatches the same original ActionIntent.
Two real DeepSeek chat-completions calls maximum, 2048 output tokens and 30 seconds each.
--discovery uses issue #216, ports 38265/38266 and four calls: discover_tools -> load_tools -> read_work -> answer.
Only hashes, public IDs, hosts, status and counts are written. No browser or teaching-effect claim.
--worker is a private JSON-lines control mode: start/authorize/connect/restart/cleanup only.`);
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
  check(source.includes('immutable-agent-assembly') && source.includes('tool.contributions'), 'candidate-missing-versioned-assembly');
  const module = await import(pathToFileURL(entry).href);
  check(typeof module.openProductRuntime === 'function' && typeof module.createProductRuntimeHost === 'function'
    && typeof module.createProductLearningApplication === 'function', 'candidate-missing-public-host-api');
  return { root, resources, module, fact: { platform: distribution.platform, profile: distribution.profile,
    distributionSha256: sha(distributionBytes), applicationSha256: sha(bytes), nodeVersion: process.version } };
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
  const pkg = await product(args.product), root = await mkdtemp(join(tmpdir(), `xj-wp08-${issue}-agent-`));
  const runtime = pkg.module.openProductRuntime({ root, resources: pkg.resources });
  let state, dependencyConnectionId, macSource, cleanupResult;
  async function cleanup() {
    cleanupResult ??= await removeEnvironment(runtime, root, state); return cleanupResult;
  }
  async function handle(input) {
    check(input && typeof input === 'object' && uuid(input.id), 'invalid-worker-control');
    if (input.operation === 'cleanup') return cleanup();
    check(!cleanupResult, 'worker-already-cleaned');
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
    + ` --mac-port ${port(args['mac-port'])} --win-port ${port(args['win-port'])}; exit $LASTEXITCODE`;
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
                if (operation === 'tool.contributions' || operation === 'tool.dispatch') wire.push({ operation, transferId: value.transferId ?? null,
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
    report.packages.windows = windows.package; report.topology.windows.host = windows.host;
    const agentTarget = windows.target;
    let dependencyGrant, dependencyConnection;
    await stage('bidirectional-runtime-authority-and-binding', async () => {
      const accept = await remote.call('authorize', { source: { sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId,
        sourceInstallationId: state.environment.installationId } });
      const connectionId = randomUUID();
      await runtime.connect({ connectionId, sourceEnvironmentId: data.environmentId, sourceServiceId: data.serviceId, target: agentTarget,
        requiredCapabilities: ['teaching.agent'], optionalCapabilities: [], credentialRef: 'assembly-cross-agent' }, accept.token);
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
    const providerKey = await providerCredential(args['credentials-file']);
    relay = await providerRelay(providerKey);
    await stage('mac-only-real-provider-configuration', async () => {
      const connectionId = randomUUID();
      await schoolApi('manage/model-default', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'WP08 cross-owner acceptance',
        protocol: 'chat-completions', baseUrl: relay.endpoint + '/v1', path: '/chat/completions', modelId: 'deepseek-flash',
        dialect: 'deepseek', parameterMode: 'thinking', enabled: true, contextWindow: 262144, maxOutputTokens: limits.maxOutputTokens,
        credential: { action: 'replace', value: providerKey }, policy: { checksAllowed: true, maxChecksPerHour: 2,
          maxOutputTokens: limits.maxOutputTokens, timeoutMs: limits.timeoutMs } }, admin);
      const previous = await schoolApi('models/selection');
      await schoolApi('models/selection', { requestId: randomUUID(), expectedVersion: previous.version, source: { kind: 'school', connectionId } });
      return { model: 'deepseek-flash', protocol: 'chat-completions', connectionId, credentialOwner: 'Mac', credentialExported: false };
    });
    const activity = await schoolApi('activities', { requestId: randomUUID(), goal: '跨机器核对固定原件与版本化能力装配', question: '', references: [] });
    check(activity.target.serviceId === data.serviceId, 'activity-left-mac-owner');
    const work = { objectId: randomUUID(), contentId: randomUUID(), name: 'cross-observation.txt', kind: 'text', encoding: 'utf8',
      mediaType: 'text/plain', value: '跨机固定观测：水位从 12 cm 增至 37 cm。原件核对标记：' + randomUUID() };
    await schoolApi('workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] });
    const capability = await schoolApi(`agent/${activity.activityId}/capabilities`);
    check(capability.modelAvailable, 'remote-agent-model-unavailable');
    check(capability.receiver.receiverId === 'teaching-agent:' + agentTarget.serviceId, 'activity-not-routed-to-windows-agent');
    const input = { requestId: randomUUID(), scope: { environmentId: identity.environmentId, spaceId: identity.spaceId,
      principalId: identity.principalId, activityId: activity.activityId }, receiver: capability.receiver,
      draft: { token: randomUUID(), question: (args.discovery
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
      const denied = await requestApi(endpoint, base + '/capabilities', undefined, headers);
      check(denied.status === 403 && denied.value.error === 'forbidden', 'revoked-dependency-was-not-refused');
      const blocked = await schoolApi(`intents/${activity.activityId}/${input.requestId}/dispatch`, {});
      check(blocked.state === 'dispatched' && blocked.input.requestId === input.requestId && !blocked.receipt, 'revoked-action-was-not-preserved-unconfirmed');
      check(blocked.inputDigest === prepared.inputDigest && relay.requests.length === 0, 'revoked-action-changed-or-dispatched');
      return { dependencyGrantId: dependencyGrant.grantId, operationHttpStatus: denied.status, operationError: denied.value.error,
        requestId: input.requestId, inputSha256: prepared.inputDigest, actionState: blocked.state, modelRequests: 0 };
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
      return { requestId: input.requestId, runId, inputSha256: prepared.inputDigest, dependencyConnectionId, dependencyGrantId: fresh.grantId };
    });
    const final = await stage(args.discovery ? 'windows-discovery-load-mac-work-and-four-real-model-calls' : 'windows-assembly-mac-work-and-two-real-model-calls', async () => {
      const conversation = await until(async () => {
        const value = await schoolApi(base + '/conversation'), run = value.runs.find(item => item.runId === receipt.runId);
        if (run && ['paused', 'failed', 'stopped'].includes(run.state)) throw Object.assign(new Error('remote-run-not-completed'), { code: 'remote-run-' + run.state });
        return run?.state === 'completed' ? value : null;
      }, 'remote-agent-completion-timeout', args.discovery ? 180000 : 90000);
      check(conversation.runs.length === 1 && conversation.runs[0].requestId === input.requestId, 'action-was-replayed-as-another-run');
      check(conversation.inputs.length === 1 && conversation.inputs[0].requestId === input.requestId, 'original-input-identity-changed');
      const expectedTools = args.discovery ? ['discover_tools', 'load_tools', 'read_work'] : ['read_work'];
      check(conversation.tools.length === expectedTools.length && expectedTools.every(name =>
        conversation.tools.filter(tool => tool.name === name && tool.outcome === 'completed').length === 1), 'expected-completed-tool-chain');
      const tool = conversation.tools.find(tool => tool.name === 'read_work');
      check(tool.name === 'read_work' && tool.outcome === 'completed' && tool.result?.file?.value === work.value, 'mac-fixed-work-not-returned');
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
      check(dispatches.length === 1 && dispatches[0].commandId === tool.commandId, 'tool-command-owner-not-witnessed');
      report.conversationSha256 = digest(conversation); report.wire = wire;
      report.work = { objectId: work.objectId, contentId: work.contentId, contentSha256: sha(work.value), commandId: tool.commandId };
      // Only the digest of the full public conversation is retained, not its content.
      return { runId: receipt.runId, requestId: input.requestId, activityId: activity.activityId, toolCommandId: tool.commandId,
        workContentSha256: sha(tool.result.file.value), modelRequests: relay.requests.length,
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
        check(snapshot.resolvedAgent.tools.some(tool => tool.modelName === 'read_work' && tool.executor.toolName === 'read_work'
          && tool.resourceScope.activityId === activity.activityId), 'real-read-work-binding-not-retained');
      }
      check(snapshots.length === limits.maxGenerations, args.discovery ? 'expected-four-original-snapshots' : 'expected-two-original-snapshots');
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
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = safe(error); }
  finally {
    report.providerRequests = relay?.requests ?? []; report.providerRefusals = relay?.rejected ?? [];
    report.dependencyOperations = Object.fromEntries(counters);
    report.cleanup = {};
    try { await relay?.close(); report.cleanup.providerRelayClosed = true; }
    catch (error) { report.cleanup.providerError = safe(error); }
    if (remote) {
      try { report.cleanup.windows = await remote.call('cleanup'); }
      catch (error) { report.cleanup.windows = { error: safe(error) }; }
      try { Object.assign(report.cleanup, await remote.close()); }
      catch (error) { report.cleanup.controlError = safe(error); }
    }
    try { await host?.stop(); }
    catch (error) { report.cleanup.macHostError = safe(error); }
    if (runtime && root) report.cleanup.mac = await removeEnvironment(runtime, root, state);
    if (report.status === 'passed' && (!report.cleanup.windows?.rootRemoved || !report.cleanup.mac?.rootRemoved
      || report.cleanup.controlError || report.cleanup.providerError || report.cleanup.macHostError)) report.status = 'failed';
    report.finishedAt = new Date().toISOString(); await persist();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  console.log(JSON.stringify({ status: report.status, report: output, modelRequests: report.providerRequests.length,
    browser: report.browser, ...(report.error ? { error: report.error } : {}) }));
  if (report.status !== 'passed') process.exitCode = 1;
}
try { if (args.worker) await worker(); else await main(); }
catch (error) { console.log(JSON.stringify({ status: 'failed', error: safe(error) })); process.exitCode = 1; }
