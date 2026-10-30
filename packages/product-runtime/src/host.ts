import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { extname, join, resolve, sep } from 'node:path';
import type { RuntimeDependencyStatus, RuntimeEnvironment, RuntimeStatus } from '@xunjie/contracts/product-runtime';
import { createConnectionAuthority, createOutboundConnection } from './connections.js';
import { acquireLock, assertRoot, atomicJson, exists, processIdentity, readJson } from './io.js';
import { createMaintenanceCoordinator } from './maintenance.js';
import type { MaintenanceParticipant } from './maintenance.js';
import { inspectDatabase, resolveCredential, startDatabase, stopDatabase } from './postgres.js';
import type { InstalledConfiguration } from './runtime.js';
import { openProductRuntime } from './runtime.js';
import { createRecoveryManager, RecoveryError } from './recovery.js';
import { createRuntimeRecoveryOwner } from './runtime-recovery.js';
import type { BackupPolicy, RecoveryOwner } from './recovery-types.js';

export interface ProductHostOptions {
  root: string;
  participants?: MaintenanceParticipant[];
  recoveryOwners?: readonly RecoveryOwner[];
  /** Compose real owner modules after native PostgreSQL is available. */
  createRecoveryOwners?: (context: { root: string; environment: RuntimeEnvironment }) => Promise<readonly RecoveryOwner[]>;
  createApplication?: (context: { root: string; environment: RuntimeEnvironment; configuration: InstalledConfiguration }) => Promise<{
    owners: readonly RecoveryOwner[];
    handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  } | undefined>;
}

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
export async function createProductRuntimeHost(options: ProductHostOptions) {
  const root = resolve(options.root);
  await assertRoot(root);
  if (await exists(join(root, 'retired.json'))) throw new RecoveryError('source-retired');
  const release = await acquireLock(root, 'daemon', 0);
  try { return await createHost({ ...options, root }, release); }
  catch (error) { await release(); throw error; }
}

async function createHost(options: ProductHostOptions, release: () => Promise<void>) {
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
  try { await startDatabase(root, config.resources, config.database); }
  catch (error) { startupFailure = (error as Error).message; }
  const application = !startupFailure && options.createApplication
    ? await options.createApplication({ root, environment, configuration: config }) : undefined;
  const suppliedOwners = [...(application?.owners ?? []), ...(options.recoveryOwners ?? []), ...(!startupFailure && options.createRecoveryOwners
    ? await options.createRecoveryOwners({ root, environment }) : [])];
  const maintenance = createMaintenanceCoordinator({
    requiredServiceIds: [service.serviceId, ...config.requiredServiceIds],
    record: state => atomicJson(join(root, 'maintenance.json'), state),
    async beforeResume() {
      if (await exists(join(root, 'retired.json'))) throw new RecoveryError('source-retired');
      if (await exists(join(root, 'recovery-state.json'))
        && !['active', 'activating'].includes((await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase)) throw new RecoveryError('target-isolated');
    },
  });
  const runtimeParticipant: MaintenanceParticipant = {
    descriptor: { serviceId: service.serviceId, schemaVersion: '1', resourceRoots: [], configurationRefs: ['installation'] },
    async closeWrites() { gatesClosed = true; },
    async closeDispatch() { gatesClosed = true; },
    async drain() {}, // This host owns no queued business work.
    async validate() { if (config.database.mode !== 'none') await inspectDatabase(root, config.database); },
    async resume() {
      if (await exists(join(root, 'retired.json'))) throw new RecoveryError('source-retired');
      gatesClosed = false;
    },
  };
  maintenance.register(runtimeParticipant);
  for (const participant of options.participants ?? []) maintenance.register(participant);
  for (const owner of suppliedOwners) {
    if (!maintenance.status().participants.some(item => item.serviceId === owner.participant.descriptor.serviceId)) maintenance.register(owner.participant);
  }
  const recovery = createRecoveryManager({ root, environment, maintenance,
    requiredServiceIds: [service.serviceId, ...config.requiredServiceIds],
    receiverIds: async () => (await readJson<InstalledConfiguration>(join(root, 'installation.json'))).connections
      .map(item => `${item.target.environmentId}/${item.target.serviceId}`),
    owners: [createRuntimeRecoveryOwner({ root, participant: runtimeParticipant,
      requiredServiceIds: maintenance.status().participants.map(item => item.serviceId) }), ...suppliedOwners],
  });
  let scheduler: ReturnType<typeof setInterval> | undefined;
  let scheduled = false;
  async function authorityClosed() {
    return gatesClosed || await exists(join(root, 'retired.json')) || await exists(join(root, 'recovery-state.json'))
      && (await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase !== 'active';
  }

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
    await Promise.all((gatesClosed ? [] : latest.connections).map(async connection => {
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
      : await authorityClosed() ? 'maintenance' : dependencies.some(value => value.required && value.state !== 'ready') ? 'failed'
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
    if (pathname.startsWith('/api/learning/') && await authorityClosed()) { send(response, 503, { error: 'maintenance' }); return; }
    if (application && await application.handle(request, response)) return;
    if (await authorityClosed() && (pathname === '/runtime/connect' || pathname.startsWith('/runtime/capabilities/'))) {
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
    if (request.url === '/runtime/control/recovery' && request.method === 'POST') {
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new RecoveryError('input-too-large');
          chunks.push(Buffer.from(chunk));
        }
        const { action, input } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { action: string; input: any };
        const policy = async () => readJson<BackupPolicy>(join(root, 'backup-policy.json'));
        let result: unknown;
        if (action === 'configure') { await recovery.configure(input); result = { configured: true }; }
        else if (action === 'catalog') {
          const saved = await exists(join(root, 'backup-policy.json')) ? await policy()
            : await readJson<{ directory: string; recoveryKeyRef: string }>(join(root, 'last-backup-settings.json'));
          const key = Buffer.from(await resolveCredential(root, saved.recoveryKeyRef), 'base64');
          result = await recovery.catalog(input?.directory ?? saved.directory, key);
        }
        else if (action === 'backup') {
          const saved = await exists(join(root, 'backup-policy.json')) ? await policy() : undefined;
          const key = Buffer.from(await resolveCredential(root, input?.recoveryKeyRef ?? saved?.recoveryKeyRef ?? ''), 'base64');
          result = await recovery.backup({ directory: input?.directory ?? saved?.directory, key,
            keep: input?.keep ?? saved?.keep, minimumFreeBytes: input?.minimumFreeBytes ?? saved?.minimumFreeBytes,
            leaveClosed: input?.leaveClosed === true });
          await atomicJson(join(root, 'last-backup-settings.json'), { directory: input?.directory ?? saved?.directory,
            recoveryKeyRef: input?.recoveryKeyRef ?? saved?.recoveryKeyRef });
        } else if (action === 'resume') result = await recovery.resume();
        else if (action === 'retire') result = await recovery.retire(input);
        else if (action === 'fence-source') result = await authority.fenceSource(input);
        else if (action === 'takeover') {
          const source = openProductRuntime({ root: input.sourceRoot });
          const receivers = (input.receivers ?? []) as { id: string; root: string }[];
          result = await recovery.takeover({ source: { retire: value => source.recovery.retire(value) },
            receivers: receivers.map(receiver => ({ id: receiver.id, async fence(sourceEnvironment, sourceServiceIds) {
              const receiverRuntime = openProductRuntime({ root: receiver.root });
              const target = (await receiverRuntime.status()).environment;
              if (!target.services.some(item => receiver.id === `${target.environmentId}/${item.serviceId}`)) throw new RecoveryError('receiver-identity-conflict');
              // Every source service identity is fenced at each receiving authority.
              for (const serviceId of sourceServiceIds) await receiverRuntime.recovery.fenceSource({
                sourceEnvironmentId: sourceEnvironment.environmentId, sourceServiceId: serviceId,
              });
              return { fenced: true };
            } })),
          });
        } else throw new RecoveryError('unknown-action');
        send(response, 200, result); return;
      } catch (error) {
        send(response, 409, { error: error instanceof RecoveryError ? error.code : 'maintenance-failed' }); return;
      }
    }
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
    if (scheduler) clearInterval(scheduler);
    for (const owner of suppliedOwners) await owner.close?.();
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
    initialized = true;
    const isolated = await exists(join(root, 'recovery-state.json'))
      && (await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase !== 'active';
    const previousMaintenance = await exists(join(root, 'maintenance.json'))
      ? await readJson<{ phase: string; reason?: string }>(join(root, 'maintenance.json')) : undefined;
    if (isolated || previousMaintenance && previousMaintenance.phase !== 'open' && previousMaintenance.reason !== 'stop') {
      await maintenance.enter(isolated ? 'isolated-restore' : 'interrupted-maintenance');
    } else if (previousMaintenance?.reason === 'stop' && previousMaintenance.phase !== 'open' && suppliedOwners.length) {
      await maintenance.enter('restart');
      await maintenance.resume();
    }
    await atomicJson(join(root, 'status.json'), await status());
    completeStartup();
    scheduler = setInterval(() => {
      if (scheduled || gatesClosed || stopping) return;
      scheduled = true;
      void (async () => {
        if (!await exists(join(root, 'backup-policy.json'))) return;
        const policy = await readJson<BackupPolicy>(join(root, 'backup-policy.json'));
        const key = Buffer.from(await resolveCredential(root, policy.recoveryKeyRef), 'base64');
        const latest = (await recovery.catalog(policy.directory, key)).backups[0];
        if (latest && Date.now() - Date.parse(latest.boundaryAt) < policy.intervalMs) return;
        await recovery.backup({ directory: policy.directory, key, keep: policy.keep, minimumFreeBytes: policy.minimumFreeBytes });
      })().catch(() => {}).finally(() => { scheduled = false; });
    }, 10_000);
    scheduler.unref();
    return { status, stop, maintenance, recovery, environment, endpoint };
  } catch (error) {
    completeStartup();
    await Promise.allSettled([close(publicServer), close(controlServer)]);
    await releaseOnce();
    await atomicJson(join(root, 'status.json'), { state: 'failed', environment, dependencies: [], reason: (error as Error).message });
    throw error;
  }
}
