import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import type { RuntimeDependencyStatus, RuntimeEnvironment, RuntimeStatus } from '@xunjie/contracts/product-runtime';
import { createConnectionAuthority, createOutboundConnection } from './connections.js';
import type { CapabilityHandler, SourceFenceProof } from './connections.js';
import { acquireLock, assertRoot, atomicJson, exists, processIdentity, readJson, withLock } from './io.js';
import { createMaintenanceCoordinator } from './maintenance.js';
import type { MaintenanceParticipant } from './maintenance.js';
import { inspectDatabase, resolveCredential, startDatabase, stopDatabase } from './postgres.js';
import type { InstalledConfiguration } from './runtime.js';
import { openProductRuntime } from './runtime.js';
import { createRecoveryManager, RecoveryError } from './recovery.js';
import { createRuntimeRecoveryOwner } from './runtime-recovery.js';
import { recordRecoverySuccession } from './recovery-successions.js';
import { createSshRecoveryReceiver } from './ssh-recovery.js';
import type { SshRecoveryReceiver } from './ssh-recovery.js';
import type { BackupPolicy, ReceiverExecutionBoundary, RecoveryOwner } from './recovery-types.js';

export interface ProductHostOptions {
  root: string;
  participants?: MaintenanceParticipant[];
  recoveryOwners?: readonly RecoveryOwner[];
  /** Compose real owner modules after native PostgreSQL is available. */
  createRecoveryOwners?: (context: { root: string; environment: RuntimeEnvironment }) => Promise<readonly RecoveryOwner[]>;
  createApplication?: (context: { root: string; environment: RuntimeEnvironment; configuration: InstalledConfiguration;
    readOnly: () => Promise<boolean> }) => Promise<{
    owners: readonly RecoveryOwner[];
    /** Explicit opt-in: the application enforces isolated reads at its own domain boundary. */
    isolatedReads?: true;
    capabilities?: Readonly<Record<string, CapabilityHandler>>;
    serviceCapabilities?: Readonly<Record<string, Readonly<Record<string, CapabilityHandler>>>>;
    /** Host facts an operator must be able to read before asking this node to run anything. */
    facts?: () => Promise<readonly RuntimeDependencyStatus[]>;
    lifecycle?: { pause(): Promise<void>; resume(): Promise<void>; close(): Promise<void> };
    poll?(isOpen: () => boolean): Promise<void>;
    modelTask?(input: unknown): Promise<unknown>;
    authorizedSource?(targetServiceId: string, source: Omit<import('./connections.js').ConnectionGrant, 'token'>): Promise<void>;
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
const close = (server: Server, sockets?: ReadonlySet<Socket>) => new Promise<void>((done, reject) => {
  server.close(error => error ? reject(error) : done());
  // Unrequested TCP/TLS preconnections are not HTTP idle requests. Once the
  // business owners have drained, they cannot keep this owned listener alive.
  for (const socket of sockets ?? []) socket.destroy();
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
  const isolatedMode = async () => await exists(join(root, 'recovery-state.json'))
    && (await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase !== 'active';
  if (!['school', 'agent'].includes(environment.profile) && (!['127.0.0.1', '::1'].includes(config.host)
    || !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(environment.services[0]!.endpoint).hostname))) throw new Error('Device profiles require a loopback listener and endpoint.');
  if (!['127.0.0.1', '::1'].includes(config.host)
    && (!config.tls || new URL(environment.services[0]!.endpoint).protocol !== 'https:')) throw new Error('A shared listener requires HTTPS.');
  if (environment.profile === 'agent' && config.database.mode === 'none') throw new Error('The agent profile requires PostgreSQL.');
  if (!config.installed) { await releaseOnce(); throw new Error('Product is uninstalled.'); }
  const service = environment.services[0]!;
  const endpoint = service.endpoint;
  let initialized = false;
  let startupFailure: string | undefined;
  let gatesClosed = false;
  let stopping = false;
  let activeApplicationRequests = 0;
  try { await startDatabase(root, config.resources, config.database); }
  catch (error) { startupFailure = (error as Error).message; }
  const application = !startupFailure && options.createApplication
    ? await options.createApplication({ root, environment, configuration: config, readOnly: isolatedMode }) : undefined;
  const suppliedOwners = [...(application?.owners ?? []), ...(options.recoveryOwners ?? []), ...(!startupFailure && options.createRecoveryOwners
    ? await options.createRecoveryOwners({ root, environment }) : [])];
  const maintenance = createMaintenanceCoordinator({
    requiredServiceIds: [service.serviceId, ...config.requiredServiceIds],
    async record(state) {
      await atomicJson(join(root, 'maintenance.json'), state);
      if (state.phase === 'open') await application?.lifecycle?.resume();
    },
    async beforeResume() {
      if (await exists(join(root, 'retired.json'))) throw new RecoveryError('source-retired');
      if (await exists(join(root, 'recovery-state.json'))
        && !['active', 'activating'].includes((await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase)) throw new RecoveryError('target-isolated');
    },
  });
  const runtimeParticipant: MaintenanceParticipant = {
    descriptor: { serviceId: service.serviceId, schemaVersion: '1', resourceRoots: [], configurationRefs: ['installation'] },
    async closeWrites() { gatesClosed = true; },
    async closeDispatch() { gatesClosed = true; await application?.lifecycle?.pause(); },
    async drain() {
      await application?.lifecycle?.pause();
      const deadline = Date.now() + 15000;
      while (activeApplicationRequests) {
        if (Date.now() >= deadline) throw new Error('Learning requests have not drained.');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
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
    prepareActivation: receiverIds => withLock(root, async () => {
      const fenced = new Set(receiverIds);
      const installed = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
      await atomicJson(join(root, 'installation.json'), { ...installed,
        connections: installed.connections.filter(item => !fenced.has(`${item.target.environmentId}/${item.target.serviceId}`)) });
    }),
  });
  let scheduler: ReturnType<typeof setInterval> | undefined;
  let applicationPoll: ReturnType<typeof setInterval> | undefined;
  let scheduled = false;
  async function authorityClosed() {
    // A maintenance boundary closes admission when the transition starts, not when every
    // participant has finished closing. Otherwise work accepted in the 'closing' window is
    // reported as started after the operator asked the host to stop taking new work.
    return gatesClosed || maintenance.status().phase !== 'open'
      || await exists(join(root, 'retired.json')) || await exists(join(root, 'recovery-state.json'))
      && (await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase !== 'active';
  }

  async function status(): Promise<RuntimeStatus> {
    // A probe that began before readiness must not report failed after the flag flips mid-call.
    const starting = !initialized;
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
    // A fact the application measured itself (what it can confine, which entry it uses) belongs in
    // the same list as every other dependency: an operator reads one answer, not two.
    if (application?.facts) {
      try { dependencies.push(...await application.facts()); }
      catch (error) {
        dependencies.push({ name: 'application-facts', required: false, state: 'unavailable', detail: (error as Error).message });
      }
    }
    const state: RuntimeStatus['state'] = !initialized || starting ? 'starting' : maintenance.status().phase === 'failed' ? 'failed'
      : await authorityClosed() ? 'maintenance' : dependencies.some(value => value.required && value.state !== 'ready') ? 'failed'
        : dependencies.some(value => value.state !== 'ready') ? 'degraded' : 'ready';
    return { state, environment, endpoint, dependencies, ...(startupFailure ? { reason: startupFailure } : {}) };
  }

  const authorities = new Map<string, ReturnType<typeof createConnectionAuthority>>();
  for (const target of environment.services) {
    const handlers = { ...(target.serviceId === service.serviceId ? application?.capabilities : {}),
      ...application?.serviceCapabilities?.[target.serviceId] };
    const applicationHandlers = Object.fromEntries(Object.entries(handlers).filter(([name]) => name !== 'runtime.status')
      .map(([name, handler]) => [name, async (...args: Parameters<CapabilityHandler>) => {
        activeApplicationRequests++;
        try {
          if (stopping || await authorityClosed()) throw new RecoveryError('maintenance');
          return await handler(...args);
        } finally { activeApplicationRequests--; }
      }]));
    target.capabilities = ['runtime.status', ...Object.keys(applicationHandlers)];
    authorities.set(target.serviceId, createConnectionAuthority({ root, service: target,
      handlers: { ...applicationHandlers, 'runtime.status': () => status() } }));
  }
  await atomicJson(join(root, 'environment.json'), environment);
  async function publicRequest(request: IncomingMessage, response: ServerResponse) {
    const pathname = new URL(request.url ?? '/', 'http://runtime.invalid').pathname;
    if (request.method === 'GET' && pathname === '/runtime/environment') { send(response, 200, environment); return; }
    if (request.method === 'GET' && pathname === '/runtime/status') {
      const current = await status();
      send(response, current.state === 'failed' ? 503 : 200, current); return;
    }
    if (pathname.startsWith('/runtime/control/')) { send(response, 404, { error: 'not_found' }); return; }
    if (pathname.startsWith('/api/learning/')) {
      // Original claim capabilities can only confirm exit. Keep exact retries available after
      // writes close; the module checks proofs read-only before considering any first write.
      const terminalAcknowledgement = () => environment.profile === 'school' && request.method === 'POST'
        && pathname === '/api/learning/native-channel/cleanup';
      if ((gatesClosed || stopping) && !terminalAcknowledgement()
        && !(application?.isolatedReads && !stopping && await isolatedMode())) { send(response, 503, { error: 'maintenance' }); return; }
      activeApplicationRequests++;
      try {
        // Isolated recovery serves the same application through its read-only HTTP boundary.
        // Ordinary maintenance remains unavailable; no runtime capability is enabled here.
        if ((await authorityClosed() || gatesClosed || stopping) && !terminalAcknowledgement()
          && !(application?.isolatedReads && !stopping && await isolatedMode())) { send(response, 503, { error: 'maintenance' }); return; }
        if (application && await application.handle(request, response)) return;
      } finally { activeApplicationRequests--; }
    }
    if (await authorityClosed() && (pathname === '/runtime/connect' || pathname.startsWith('/runtime/capabilities/'))) {
      send(response, 503, { error: 'maintenance' }); return;
    }
    if (pathname === '/runtime/connect' || pathname.startsWith('/runtime/capabilities/')) {
      const targetId = request.headers['x-runtime-target-service-id'];
      const target = typeof targetId === 'string' ? authorities.get(targetId) : undefined;
      if (!target) { send(response, 409, { error: 'target_identity_mismatch' }); return; }
      if (await target.handle(request, response)) return;
    }
    if (!['GET', 'HEAD'].includes(request.method ?? '') || pathname.startsWith('/runtime/')) { send(response, 404, { error: 'not_found' }); return; }
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
    const webRoot = await realpath(config.resources.webRoot);
    const file = await realpath(resolve(webRoot, relative));
    if (!file.startsWith(webRoot + sep) || !(await stat(file)).isFile()) { send(response, 404, { error: 'not_found' }); return; }
    const contentType = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': contentType, 'x-content-type-options': 'nosniff',
      // The execution path compiles a pinned, digest-checked WebAssembly algorithm in a dedicated
      // worker; `wasm-unsafe-eval` permits exactly that compilation. `unsafe-eval` stays forbidden.
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'", 'cache-control': 'no-cache' });
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
  const publicSockets = new Set<Socket>();
  publicServer.on('connection', socket => {
    publicSockets.add(socket);
    socket.once('close', () => publicSockets.delete(socket));
  });
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
        if (action === 'authorize-capability') {
          if (await authorityClosed()) throw new RecoveryError('maintenance');
          const target = authorities.get(input.targetServiceId);
          if (!target) throw new RecoveryError('target-identity-mismatch');
          const grant = await target.authorize(input.authorization);
          const { token, ...source } = grant;
          try { await application?.authorizedSource?.(input.targetServiceId, source); }
          catch (error) { await target.revoke(grant.grantId); throw error; }
          result = grant;
        }
        else if (action === 'model-task') {
          if (await authorityClosed() || !application?.modelTask) throw new RecoveryError('maintenance');
          activeApplicationRequests++;
          try { result = await application.modelTask(input); }
          finally { activeApplicationRequests--; }
        }
        else if (action === 'configure') { await recovery.configure(input); result = { configured: true }; }
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
        else if (action === 'fence-source') {
          const validId = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
          const sourceServiceIds = input.sourceServiceIds ?? [input.sourceServiceId];
          if (!validId(input.sourceEnvironmentId) || !validId(input.sourceServiceId)
            || input.sourceInstallationId !== undefined && !validId(input.sourceInstallationId)
            || !Array.isArray(sourceServiceIds) || !sourceServiceIds.length || sourceServiceIds.length > 100
            || !sourceServiceIds.includes(input.sourceServiceId) || sourceServiceIds.some(id => !validId(id)))
            throw new RecoveryError('invalid-source-services');
          if ((input.backupId !== undefined || input.targetInstallationId !== undefined)
            && (!validId(input.backupId) || !validId(input.targetInstallationId) || !validId(input.sourceInstallationId)))
            throw new RecoveryError('invalid-identity');
          // Fence admission first. Closing this receiver's actual owners then waits for the
          // asynchronous effects that outlive a capability handler. On failure remain closed;
          // never turn a handler-only acknowledgement into an execution-safety proof.
          const reopen = maintenance.status().phase === 'open' || maintenance.status().reason === 'receiver-fence';
          gatesClosed = true;
          if (reopen || maintenance.status().phase === 'failed') await maintenance.enter('receiver-fence');
          await maintenance.validate();
          let proof: SourceFenceProof | undefined;
          for (const serviceId of new Set<string>(sourceServiceIds)) for (const target of authorities.values()) {
            const confirmed = await target.fenceSource({ ...input, sourceServiceId: serviceId });
            if (serviceId === input.sourceServiceId) proof = confirmed;
          }
          const boundaryAt = new Date().toISOString();
          const services: ReceiverExecutionBoundary['services'] = [];
          for (const owner of suppliedOwners) {
            const readMaterial = owner.receiverMaterial ?? owner.material;
            const material = await readMaterial.call(owner, { backupId: input.backupId ?? input.sourceInstallationId ?? input.sourceEnvironmentId,
              boundaryAt, signal: AbortSignal.timeout(30000) });
            if (material.serviceId !== owner.participant.descriptor.serviceId || material.boundaryAt !== boundaryAt
              || material.source.environmentId !== environment.environmentId
              || material.source.installationId !== environment.installationId
              || material.blocking.length || material.unresolved.length) throw new RecoveryError('unconfirmed-receiver-boundary');
            services.push({ serviceId: material.serviceId, unresolved: material.unresolved.length,
              settled: material.settled, blocking: material.blocking.length });
          }
          services.push({ serviceId: service.serviceId, unresolved: 0, settled: 0, blocking: 0 });
          const expectedOwners = maintenance.status().participants.map(item => item.serviceId).sort();
          if (JSON.stringify(services.map(item => item.serviceId).sort()) !== JSON.stringify(expectedOwners))
            throw new RecoveryError('missing-receiver-boundary-owner');
          const execution: ReceiverExecutionBoundary = { formatVersion: 1, boundaryAt, services, unresolved: 0, blocking: 0 };
          if (input.backupId && input.sourceInstallationId && input.targetInstallationId) for (const serviceId of new Set<string>(sourceServiceIds)) {
            await recordRecoverySuccession(root, { formatVersion: 1, backupId: input.backupId, sourceEnvironmentId: input.sourceEnvironmentId,
              sourceServiceId: serviceId, sourceInstallationId: input.sourceInstallationId, targetInstallationId: input.targetInstallationId });
          }
          if (reopen) await maintenance.resume();
          result = { ...proof, execution };
        }
        else if (action === 'takeover') {
          const source = openProductRuntime({ root: input.sourceRoot });
          const receivers = (input.receivers ?? []) as ({ id: string; root: string } | SshRecoveryReceiver)[];
          result = await recovery.takeover({ source: { retire: value => source.recovery.retire(value) },
            receivers: receivers.map(receiver => 'ssh' in receiver ? createSshRecoveryReceiver(receiver) : ({ id: receiver.id, async fence(sourceEnvironment, sourceServiceIds, binding) {
              const receiverRuntime = openProductRuntime({ root: receiver.root });
              const target = (await receiverRuntime.status()).environment;
              if (!target.services.some(item => receiver.id === `${target.environmentId}/${item.serviceId}`)) throw new RecoveryError('receiver-identity-conflict');
              // Every source service identity is fenced at each receiving authority. The retired
              // installation is fenced, not the whole environment, so a successor installation can
              // still be authorized and connected.
              const execution = (await receiverRuntime.recovery.fenceSource({
                sourceEnvironmentId: sourceEnvironment.environmentId, sourceServiceId: sourceServiceIds[0]!,
                sourceInstallationId: sourceEnvironment.installationId, sourceServiceIds, ...binding,
              })).execution;
              // The proof names the installation that was really fenced, so the takeover cannot
              // accept an acknowledgement for a different source or a partial service set.
              return { fenced: true as const, ...binding, receiverId: receiver.id,
                sourceEnvironmentId: sourceEnvironment.environmentId,
                sourceInstallationId: sourceEnvironment.installationId,
                sourceServiceIds: [...sourceServiceIds], execution };
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
      // A killed owned database must recover its WAL before owners can persist their stop gates.
      // The public dispatch gate closes first; an external database is never started or replaced.
      gatesClosed = true;
      if (!startupFailure && config.database.mode === 'managed')
        await startDatabase(root, config.resources, config.database, { stoppedOnly: true });
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
    if (applicationPoll) clearInterval(applicationPoll);
    await application?.lifecycle?.close();
    for (const owner of suppliedOwners) await owner.close?.();
    await atomicJson(join(root, 'status.json'), { state: 'stopped', environment, dependencies: [] } satisfies RuntimeStatus);
    await Promise.all([close(publicServer, publicSockets), close(controlServer)]);
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
    if (maintenance.status().phase === 'open') await application?.lifecycle?.resume();
    // start() must not observe readiness before a previous stop/restart gate reopens.
    initialized = true;
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
    if (application?.poll) {
      const isOpen = () => !gatesClosed && !stopping;
      let polling = false;
      applicationPoll = setInterval(() => {
        if (!isOpen() || polling) return;
        polling = true;
        activeApplicationRequests++;
        void application.poll!(isOpen).catch(() => {}).finally(() => {
          activeApplicationRequests--;
          polling = false;
        });
      }, 250);
      applicationPoll.unref();
    }
    return { status, stop, maintenance, recovery, environment, endpoint };
  } catch (error) {
    completeStartup();
    await Promise.allSettled([application?.lifecycle?.close(), close(publicServer, publicSockets), close(controlServer)]);
    await releaseOnce();
    await atomicJson(join(root, 'status.json'), { state: 'failed', environment, dependencies: [], reason: (error as Error).message });
    throw error;
  }
}
