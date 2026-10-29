import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { extname, join, resolve, sep } from 'node:path';
import type { RuntimeDependencyStatus, RuntimeEnvironment, RuntimeStatus } from '@xunjie/contracts/product-runtime';
import { createConnectionAuthority, createOutboundConnection } from './connections.js';
import { acquireLock, assertRoot, atomicJson, processIdentity, readJson } from './io.js';
import { createMaintenanceCoordinator } from './maintenance.js';
import type { MaintenanceParticipant } from './maintenance.js';
import { inspectDatabase, resolveCredential, startDatabase, stopDatabase } from './postgres.js';
import type { InstalledConfiguration } from './runtime.js';

const send = (response: ServerResponse, code: number, value: unknown) => {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
};
const listen = (server: Server, port: number, host: string) => new Promise<void>((done, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => { server.removeListener('error', reject); done(); });
});
const close = (server: Server) => new Promise<void>((done, reject) => {
  server.close(error => error ? reject(error) : done());
});

/** School and local hosts compose this same lifecycle with their real owners. */
export async function createProductRuntimeHost(options: { root: string; participants?: MaintenanceParticipant[] }) {
  const root = resolve(options.root);
  await assertRoot(root);
  const release = await acquireLock(root, 'daemon', 0);
  try { return await createHost({ ...options, root }, release); }
  catch (error) { await release(); throw error; }
}

async function createHost(options: { root: string; participants?: MaintenanceParticipant[] }, release: () => Promise<void>) {
  const root = options.root;
  let released = false;
  const releaseOnce = async () => { if (!released) { released = true; await release(); } };
  const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
  const environment = await readJson<RuntimeEnvironment>(join(root, 'environment.json'));
  if (!config.installed) { await releaseOnce(); throw new Error('Product is uninstalled.'); }
  const service = environment.services[0]!;
  const endpoint = service.endpoint;
  let initialized = false;
  let startupFailure: string | undefined;
  let gatesClosed = false;
  let stopping = false;
  const maintenance = createMaintenanceCoordinator({
    requiredServiceIds: [service.serviceId, ...config.requiredServiceIds],
    record: state => atomicJson(join(root, 'maintenance.json'), state),
  });
  maintenance.register({
    descriptor: { serviceId: service.serviceId, schemaVersion: '1', resourceRoots: [], configurationRefs: ['installation'] },
    async closeWrites() { gatesClosed = true; },
    async closeDispatch() { gatesClosed = true; },
    async drain() {}, // This host owns no queued business work.
    async validate() { if (config.database.mode !== 'none') await inspectDatabase(root, config.database); },
    async resume() { gatesClosed = false; },
  });
  for (const participant of options.participants ?? []) maintenance.register(participant);

  async function status(): Promise<RuntimeStatus> {
    const dependencies: RuntimeDependencyStatus[] = [];
    if (config.database.mode !== 'none') {
      try {
        if (!initialized) throw new Error('PostgreSQL startup is in progress.');
        const result = await inspectDatabase(root, config.database);
        startupFailure = undefined;
        dependencies.push({ name: 'PostgreSQL', required: true, state: 'ready', detail: result.version });
      } catch (error) {
        dependencies.push({ name: 'PostgreSQL', required: true, state: 'unavailable', detail: (error as Error).message });
      }
    }
    const latest = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
    await Promise.all(latest.connections.map(async connection => {
      try {
        const result = await createOutboundConnection({ connection,
          credential: () => resolveCredential(root, connection.credentialRef), allowInsecureLoopback: true }).check();
        dependencies.push({ name: `${connection.target.unit}:${connection.target.serviceId}`,
          required: connection.requiredCapabilities.length > 0,
          state: result.state === 'unavailable' ? 'unavailable' : 'ready',
          ...(result.reason ? { detail: result.reason } : result.missingOptionalCapabilities.length
            ? { detail: `Optional capabilities unavailable: ${result.missingOptionalCapabilities.join(', ')}` } : {}),
        });
        if (result.state === 'degraded') dependencies.push({ name: `optional:${connection.target.serviceId}`,
          required: false, state: 'unavailable', detail: result.missingOptionalCapabilities.join(', ') });
      } catch (error) {
        dependencies.push({ name: connection.connectionId, required: connection.requiredCapabilities.length > 0,
          state: 'unavailable', detail: (error as Error).message });
      }
    }));
    const missing = maintenance.status().missingServiceIds;
    if (missing.length) dependencies.push({ name: 'maintenance-participants', required: true, state: 'unavailable', detail: missing.join(', ') });
    const state: RuntimeStatus['state'] = !initialized ? 'starting' : maintenance.status().phase === 'failed' ? 'failed'
      : gatesClosed ? 'maintenance' : dependencies.some(value => value.required && value.state !== 'ready') ? 'failed'
        : dependencies.some(value => value.state !== 'ready') ? 'degraded' : 'ready';
    return { state, environment, endpoint, dependencies, ...(startupFailure ? { reason: startupFailure } : {}) };
  }

  const authority = createConnectionAuthority({ root, service, handlers: { 'runtime.status': () => status() } });
  async function publicRequest(request: IncomingMessage, response: ServerResponse) {
    const pathname = new URL(request.url ?? '/', 'http://runtime.invalid').pathname;
    if (request.method === 'GET' && pathname === '/runtime/environment') { send(response, 200, environment); return; }
    if (request.method === 'GET' && pathname === '/runtime/status') {
      const current = await status();
      send(response, current.state === 'failed' ? 503 : 200, current); return;
    }
    if (pathname.startsWith('/runtime/control/')) { send(response, 404, { error: 'not_found' }); return; }
    if (gatesClosed && (pathname === '/runtime/connect' || pathname.startsWith('/runtime/capabilities/'))) {
      send(response, 503, { error: 'maintenance' }); return;
    }
    if (await authority.handle(request, response)) return;
    if (!['GET', 'HEAD'].includes(request.method ?? '') || pathname.startsWith('/runtime/')) { send(response, 404, { error: 'not_found' }); return; }
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
    const webRoot = await realpath(config.resources.webRoot);
    const file = await realpath(resolve(webRoot, relative));
    if (!file.startsWith(webRoot + sep) || !(await stat(file)).isFile()) { send(response, 404, { error: 'not_found' }); return; }
    const contentType = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': contentType, 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'", 'cache-control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : await readFile(file));
  }
  const handle = (action: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => (req: IncomingMessage, res: ServerResponse) => {
    void action(req, res).catch(error => {
      if (!res.headersSent) send(res, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500, { error: 'request_failed' });
      else res.destroy();
    });
  };
  const publicServer = config.tls ? httpsServer({ cert: await readFile(config.tls.certificateFile),
    key: await readFile(config.tls.keyFile) }, handle(publicRequest)) : httpServer(handle(publicRequest));
  const controlToken = await resolveCredential(root, 'control');
  const controlServer = httpServer(handle(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${controlToken}`) { send(response, 401, { error: 'unauthorized' }); return; }
    if (request.url === '/runtime/control/status' && request.method === 'GET') { send(response, 200, await status()); return; }
    if (request.url === '/runtime/control/stop' && request.method === 'POST') {
      try {
        await quiesce();
        send(response, 200, { state: 'stopped', environment, dependencies: [] } satisfies RuntimeStatus);
        await shutdown();
      } catch (error) { send(response, 409, { error: (error as Error).message }); }
      return;
    }
    send(response, 404, { error: 'not_found' });
  }));
  async function quiesce() {
    if (stopping) throw new Error('Shutdown is in progress.');
    stopping = true;
    try {
      await startupComplete;
      if (!maintenance.status().safeToStop) {
        const phase = maintenance.status().phase;
        if (phase !== 'open' && phase !== 'failed') throw new Error('Maintenance has not confirmed a safe stop boundary.');
        await maintenance.enter('stop');
      }
      if (!maintenance.status().safeToStop) throw new Error('Maintenance participants have not confirmed a safe stop.');
      await stopDatabase(root, config.resources, config.database);
    } catch (error) { stopping = false; throw error; }
  }
  async function shutdown() {
    await atomicJson(join(root, 'status.json'), { state: 'stopped', environment, dependencies: [] } satisfies RuntimeStatus);
    await Promise.all([close(publicServer), close(controlServer)]);
    await rm(join(root, 'instance.json'), { force: true });
    await rm(join(root, 'launch.json'), { force: true });
    await releaseOnce();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
  const stop = async () => { await quiesce(); await shutdown(); };
  const onSignal = () => { void stop().catch(error => { console.error((error as Error).message); }); };
  let completeStartup!: () => void;
  const startupComplete = new Promise<void>(done => { completeStartup = done; });
  try {
    await listen(publicServer, config.port, config.host);
    await listen(controlServer, 0, '127.0.0.1');
    await atomicJson(join(root, 'instance.json'), { pid: process.pid, processIdentity: await processIdentity(process.pid),
      endpoint: `http://127.0.0.1:${(controlServer.address() as { port: number }).port}` });
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    try { await startDatabase(root, config.resources, config.database); }
    catch (error) { startupFailure = (error as Error).message; }
    initialized = true;
    await atomicJson(join(root, 'status.json'), await status());
    completeStartup();
    return { status, stop, maintenance, environment, endpoint };
  } catch (error) {
    completeStartup();
    await Promise.allSettled([close(publicServer), close(controlServer)]);
    await releaseOnce();
    await atomicJson(join(root, 'status.json'), { state: 'failed', environment, dependencies: [], reason: (error as Error).message });
    throw error;
  }
}
