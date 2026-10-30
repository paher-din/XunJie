#!/usr/bin/env node
// Independent restricted external service, NOT a school product runtime or a
// teaching-data owner. Only consumes the actual distributed connection authority.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { arch, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const HELP = `XunJie #145 independent Linux TLS receiver + S3 bridge (no school PG).
Initial foreground start (root must not exist, private and outside the repo/package):
  node recovery-hybrid-host.mjs --package DIR --root NEW_ROOT --s3-config PRIVATE_JSON
    --port PORT --cert CERT --key KEY --public-endpoint https://PUBLIC:PORT
The existing Seaweed config endpoint MUST be HTTP loopback. No Seaweed/nginx/SG
or existing service is started, stopped or changed. Host listens on 0.0.0.0.
S3 paths/headers/Host/SigV4/body are streamed unchanged to that loopback endpoint.
root/service.json is the stable actual-authority descriptor (capabilities effect,status).
POST /runtime/connect and /runtime/capabilities/{effect,status} require a real grant.
effect payload {requestId:UUID}; a repeated original ID returns the same durable
receipt and counter. status is authenticated; no public receipt/status endpoint.
Management in independent SSH action processes (saved package/config reused):
  node recovery-hybrid-host.mjs --root ROOT --action status|stop|start
  node recovery-hybrid-host.mjs --root ROOT --action authorize
    --source-file SOURCE_JSON --private-out NEW_PRIVATE_GRANT_FILE
  node recovery-hybrid-host.mjs --root ROOT --action fence-source --source-file SOURCE_JSON
authorize source JSON: {sourceEnvironmentId,sourceServiceId}; output file is the
actual grant (including token); stdout contains only grantId, never token.
fence source JSON: {sourceEnvironmentId,sourceServiceIds:[ALL original service IDs]};
stdout returns only {fenced:true,proofs:[actual fenceSource proofs]}.
start detached-spawns ONLY this saved host; stop uses private Unix socket + PID +
nonce so it cannot signal an unrelated/recycled PID. Both poll for confirmation.
State/grants/effect receipts persist across restart; no runtime lifecycle is copied.
All acceptance records belong to this disposable external service, not courses.
`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const codeOf = error => /^[a-zA-Z0-9_-]{1,80}$/.test(error?.code ?? '') ? error.code : 'hybrid-host-failed';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const inside = (parent, child) => { const rel = relative(parent, child); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function privateFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077)) fail('private-file-required');
  return json(path);
}
async function save(path, value, exclusive = false) {
  const temporary = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  if (!exclusive) await rename(temporary, path);
  const dir = await open(dirname(path), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
function parse(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !['package','root','s3-config','port','cert','key','public-endpoint','action','source-file','private-out'].includes(name)
      || !argv[i + 1] || argv[i + 1].startsWith('--') || opt[name]) fail('invalid-arguments');
    opt[name] = argv[++i];
  }
  if (!opt.root) fail('root-required');
  opt.root = resolve(opt.root);
  return opt;
}
function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
}
const listen = (server, ...args) => new Promise((yes, no) => { server.once('error', no); server.listen(...args, () => { server.off('error', no); yes(); }); });
const close = server => new Promise((yes, no) => { server.close(e => e ? no(e) : yes()); server.closeIdleConnections(); });

async function loadApi(config) {
  return import(pathToFileURL(join(config.package, 'app', 'product-runtime.js')).href);
}
async function describe(config) {
  const entry = join(config.package, 'app', 'product-runtime.js');
  return { platform: platform(), arch: arch(), release: release(), node: process.version,
    package: config.package, resources: await json(join(config.package, 'resources.json')),
    bundleSha256: createHash('sha256').update(await readFile(entry)).digest('hex'),
    scriptSha256: createHash('sha256').update(await readFile(script)).digest('hex'),
    responsibility: { local: 'Mac source/target own managed PostgreSQL and independent S3 buckets',
      school: 'Independent restricted external effect receiver and TLS bridge to existing loopback Seaweed S3; no school PG installed; not teaching business data' } };
}
async function control(root, action) {
  const instance = await privateFile(join(root, 'private', 'instance.json'));
  const result = await new Promise((yes, no) => {
    const req = httpRequest({ socketPath: join(root, 'private', 'control.sock'), path: '/', method: 'POST', timeout: 5000,
      headers: { 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', part => chunks.push(part));
      res.on('end', () => { try { const value = JSON.parse(Buffer.concat(chunks)); if (res.statusCode !== 200) fail('control-rejected'); yes(value); } catch (e) { no(e); } });
    });
    req.on('error', no); req.on('timeout', () => req.destroy(Object.assign(new Error(), { code: 'control-timeout' })));
    req.end(JSON.stringify({ action, pid: instance.pid, nonce: instance.nonce }));
  });
  if (result.pid !== instance.pid) fail('host-pid-conflict');
  return result;
}
async function bootstrap(opt) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') fail('posix-host-required');
  for (const key of ['package','s3-config','port','cert','key','public-endpoint']) if (!opt[key]) fail('initial-arguments-required');
  const pkg = await realpath(opt.package);
  const root = join(await realpath(dirname(opt.root)), basename(opt.root));
  const excluded = [pkg];
  // The standalone script is copied to Linux without a checkout. Its parent
  // must not be mistaken for a repository (e.g. forbidding every root in /tmp).
  for (let parent = dirname(script); ; parent = dirname(parent)) {
    if (await exists(join(parent, '.git'))) { excluded.push(await realpath(parent)); break; }
    if (parent === dirname(parent)) break;
  }
  if (excluded.some(parent => inside(parent, root))) fail('independent-root-required');
  if (Buffer.byteLength(join(root, 'private', 'control.sock')) > 100) fail('shorter-root-required-for-unix-socket');
  const endpoint = new URL(opt['public-endpoint']);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) fail('public-tls-endpoint-required');
  const port = Number(opt.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || Number(endpoint.port || 443) !== port) fail('port-endpoint-mismatch');
  const config = { formatVersion: 1, package: pkg, root, port, publicEndpoint: endpoint.origin,
    s3Config: await realpath(opt['s3-config']), cert: await realpath(opt.cert), key: await realpath(opt.key) };
  await privateFile(config.s3Config);
  await mkdir(root, { mode: 0o700 }); // exclusive; never adopt another service
  await mkdir(join(root, 'private'), { mode: 0o700 });
  await save(join(root, 'host-config.json'), config, true);
  await save(join(root, 'service.json'), { environmentId: randomUUID(), serviceId: randomUUID(),
    unit: 'tool-execution', endpoint: endpoint.origin, protocolVersion: 1, capabilities: ['effect','status'] }, true);
  return config;
}
async function serve(config) {
  const root = config.root;
  // Exclusive lease prevents two live hosts. A stale lease must be explicitly
  // diagnosed, never automatically overwritten or used to kill a process.
  const lease = await open(join(root, 'private', 'host.lock'), 'wx', 0o600);
  let tls, management;
  try {
    const upstream = new URL((await privateFile(config.s3Config)).endpoint);
    if (upstream.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(upstream.hostname)
      || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) fail('loopback-s3-required');
    const api = await loadApi(config);
    const service = await json(join(root, 'service.json'));
    let queue = Promise.resolve();
    const serialize = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
    const effectsFile = join(root, 'private', 'effects.json');
    if (!await exists(effectsFile)) await save(effectsFile, { counter: 0, receipts: {} }, true);
    const metadata = await describe(config);
    const authority = api.createConnectionAuthority({ root, service, handlers: {
      effect: (payload, source) => serialize(async () => {
        if (!uuid(payload?.requestId)) fail('invalid-request-id');
        const state = await privateFile(effectsFile);
        if (Object.hasOwn(state.receipts, payload.requestId)) return state.receipts[payload.requestId];
        const receipt = { requestId: payload.requestId, receiptId: randomUUID(), counter: ++state.counter,
          originalSource: { sourceEnvironmentId: source.sourceEnvironmentId, sourceServiceId: source.sourceServiceId },
          committedAt: new Date().toISOString() };
        state.receipts[payload.requestId] = receipt;
        await save(effectsFile, state); return receipt;
      }),
      status: () => serialize(async () => ({ ...(await privateFile(effectsFile)), ...metadata, service,
        pid: process.pid, publicEndpoint: config.publicEndpoint })),
    } });
    const proxy = (req, res) => {
      const outgoing = httpRequest({ hostname: upstream.hostname.replace(/^\[|\]$/g, ''), port: upstream.port || 80,
        method: req.method, path: req.url, headers: req.rawHeaders, timeout: 15000 }, incoming => {
        res.writeHead(incoming.statusCode, incoming.rawHeaders); incoming.pipe(res);
        incoming.on('error', () => res.destroy());
      });
      outgoing.on('error', () => { if (!res.headersSent) send(res, 502, { error: 's3_upstream_unavailable' }); else res.destroy(); });
      outgoing.on('timeout', () => outgoing.destroy());
      req.on('aborted', () => outgoing.destroy());
      res.on('close', () => outgoing.destroy());
      req.pipe(outgoing);
    };
    tls = httpsServer({ cert: await readFile(config.cert), key: await readFile(config.key) }, (req, res) => {
      void (async () => {
        if (await authority.handle(req, res)) return;
        if ((req.url ?? '').startsWith('/runtime/')) { send(res, 404, { error: 'not_found' }); return; }
        proxy(req, res);
      })().catch(() => { if (!res.headersSent) send(res, 500, { error: 'request_failed' }); else res.destroy(); });
    });
    const nonce = randomUUID();
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await close(tls); await queue; await close(management);
      await rm(join(root, 'private', 'instance.json'), { force: true });
      await rm(join(root, 'private', 'control.sock'), { force: true });
      await lease.close(); await rm(join(root, 'private', 'host.lock'));
    };
    management = httpServer((req, res) => {
      void (async () => {
        let bytes = ''; for await (const part of req) { bytes += part; if (bytes.length > 1024) fail('control-input-too-large'); }
        const input = JSON.parse(bytes);
        if (input.pid !== process.pid || input.nonce !== nonce) { send(res, 403, { error: 'host-identity-mismatch' }); return; }
        if (!['status','stop'].includes(input.action)) { send(res, 400, { error: 'unknown-action' }); return; }
        send(res, 200, { pid: process.pid, running: true, stopping: input.action === 'stop', service, ...metadata });
        if (input.action === 'stop') void shutdown().catch(() => { process.exitCode = 1; });
      })().catch(() => { if (!res.headersSent) send(res, 400, { error: 'control-failed' }); });
    });
    await listen(tls, config.port, '0.0.0.0');
    await listen(management, join(root, 'private', 'control.sock'));
    await chmod(join(root, 'private', 'control.sock'), 0o600);
    await save(join(root, 'private', 'instance.json'), { pid: process.pid, nonce }, true);
    const signal = () => { void shutdown().catch(() => { process.exitCode = 1; }); };
    process.once('SIGTERM', signal); process.once('SIGINT', signal);
    console.log(JSON.stringify({ ready: true, pid: process.pid, service, ...metadata }));
  } catch (e) {
    await Promise.allSettled([tls && close(tls), management && close(management)]);
    await lease.close().catch(() => {}); await rm(join(root, 'private', 'host.lock'), { force: true }); throw e;
  }
}
async function main(opt) {
  process.umask(0o077);
  if (!opt.action) return serve(await bootstrap(opt));
  const config = await privateFile(join(opt.root, 'host-config.json'));
  if (config.root !== await realpath(opt.root)) fail('host-root-conflict');
  const info = await lstat(opt.root);
  if (!info.isDirectory() || (info.mode & 0o077)) fail('private-root-required');
  if (opt.action === 'serve') return serve(config);
  if (opt.action === 'status') return console.log(JSON.stringify(await control(opt.root, 'status')));
  if (opt.action === 'stop') {
    const result = await control(opt.root, 'stop');
    for (let i = 0; i < 200; i++) {
      if (!await exists(join(opt.root, 'private', 'host.lock'))) return console.log(JSON.stringify({ stopped: true, pid: result.pid, ownPidConfirmed: true }));
      await delay(100);
    }
    fail('stop-not-confirmed');
  }
  if (opt.action === 'start') {
    if (await exists(join(opt.root, 'private', 'host.lock'))) fail('host-already-running-or-stale-lease');
    const resources = await json(join(config.package, 'resources.json'));
    const log = await open(join(opt.root, 'private', 'host.log'), 'a', 0o600);
    const child = spawn(resolve(config.package, resources.nodePath), [script, '--root', opt.root, '--action', 'serve'],
      { detached: true, stdio: ['ignore', log.fd, log.fd], shell: false,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_OPTIONS','NODE_PATH'].includes(key))) });
    let spawnError; child.once('error', e => { spawnError = e; }); child.unref(); await log.close();
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError;
      try { const result = await control(opt.root, 'status'); if (result.pid !== child.pid) fail('start-pid-conflict'); return console.log(JSON.stringify({ started: true, ...result })); }
      catch (e) { if (e.code === 'start-pid-conflict') throw e; }
      await delay(100);
    }
    fail('start-not-confirmed');
  }
  if (!['authorize','fence-source'].includes(opt.action) || !opt['source-file']) fail('unknown-or-incomplete-action');
  const api = await loadApi(config), service = await json(join(opt.root, 'service.json'));
  const authority = api.createConnectionAuthority({ root: opt.root, service, handlers: { effect() {}, status() {} } });
  const source = await privateFile(resolve(opt['source-file']));
  if (opt.action === 'authorize') {
    if (!opt['private-out']) fail('private-out-required');
    const out = resolve(opt['private-out']);
    const parent = await lstat(dirname(out));
    if (!parent.isDirectory() || (parent.mode & 0o077)) fail('private-output-directory-required');
    const grant = await authority.authorize({ sourceEnvironmentId: source.sourceEnvironmentId,
      sourceServiceId: source.sourceServiceId, capabilities: ['effect','status'] });
    await save(out, grant, true);
    console.log(JSON.stringify({ authorized: true, grantId: grant.grantId, privateOut: out })); return;
  }
  if (!uuid(source.sourceEnvironmentId) || !Array.isArray(source.sourceServiceIds) || !source.sourceServiceIds.length
    || source.sourceServiceIds.length > 100 || source.sourceServiceIds.some(id => !uuid(id))) fail('all-source-service-ids-required');
  const proofs = [];
  for (const id of new Set(source.sourceServiceIds)) proofs.push(await authority.fenceSource({
    sourceEnvironmentId: source.sourceEnvironmentId, sourceServiceId: id, timeoutMs: 15000 }));
  console.log(JSON.stringify({ fenced: true, proofs }));
}
if (process.argv.includes('--help')) console.log(HELP);
else Promise.resolve().then(() => main(parse(process.argv.slice(2)))).catch(error => {
  const site = /recovery-hybrid-host\.mjs:(\d+):(\d+)/.exec(String(error?.stack ?? ''));
  console.error(JSON.stringify({ error: codeOf(error), ...(site ? { line: Number(site[1]) } : {}) })); process.exitCode = 1;
});
