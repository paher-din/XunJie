import { spawn, execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeConnectionSchema, runtimeEnvironmentSchema } from '@xunjie/contracts/product-runtime';
import type { RuntimeConnection, RuntimeEnvironment, RuntimeStatus } from '@xunjie/contracts/product-runtime';
import { createConnectionAuthority } from './connections.js';
import type { ConnectionAuthorization } from './connections.js';
import { acquireLock, assertRoot, atomicJson, exists, initializeRoot, ownsProcess, processIdentity, readJson, removeOwned, withLock } from './io.js';
import type { ProcessOwner } from './io.js';
import { databaseBinding, freePort, inspectDatabase, prepareDatabase, resolveCredential, stopDatabase, storeCredential } from './postgres.js';
import type { DatabaseConfiguration, RuntimeResources } from './postgres.js';
import { prepareProductPrerequisites, ProductInstallationRequiredError } from './prerequisites.js';
import type { ProductPrerequisiteResult } from './prerequisites.js';
import type { BackupPolicy, RecoveryManifest } from './recovery-types.js';
import { RecoveryError } from './recovery.js';
import type { RetirementProof } from './recovery.js';

export interface InstallOptions {
  profile: RuntimeEnvironment['profile'];
  database?: DatabaseConfiguration;
  host?: string;
  port?: number;
  publicEndpoint?: string;
  tls?: { certificateFile: string; keyFile: string };
  requiredServiceIds?: string[];
}
export interface InstalledConfiguration {
  installed: boolean;
  resources: RuntimeResources;
  database: DatabaseConfiguration;
  host: string;
  port: number;
  tls?: { certificateFile: string; keyFile: string };
  requiredServiceIds: string[];
  connections: RuntimeConnection[];
}
export interface RunningInstance extends ProcessOwner { endpoint: string }

export function openProductRuntime(options: { root: string; resources?: RuntimeResources; windowsPrerequisitePath?: string }) {
  const root = resolve(options.root);
  const configPath = join(root, 'installation.json');
  const environmentPath = join(root, 'environment.json');
  const environment = async () => runtimeEnvironmentSchema.parse(await readJson(environmentPath));
  const configuration = async () => { await assertRoot(root); return readJson<InstalledConfiguration>(configPath); };
  async function recoveryControl<T>(action: string, input?: unknown): Promise<T> {
    await assertRoot(root);
    const instance = await readJson<RunningInstance>(join(root, 'instance.json'));
    if (!await ownsProcess(instance)) throw new RecoveryError('source-unreachable');
    const response = await fetch(new URL('/runtime/control/recovery', instance.endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300_000),
      headers: { authorization: `Bearer ${await resolveCredential(root, 'control')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, input }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: string };
      throw new RecoveryError(typeof failure.error === 'string' ? failure.error : 'control-failed');
    }
    return response.json() as Promise<T>;
  }

  async function prepare(input?: InstallOptions, reinstall = false): Promise<ProductPrerequisiteResult> {
    if (input) runtimeEnvironmentSchema.shape.profile.parse(input.profile);
    let resources: RuntimeResources;
    let database: DatabaseConfiguration;
    if (await exists(configPath)) {
      const config = await configuration();
      const descriptor = await environment();
      if (typeof config.installed !== 'boolean') throw new Error('Invalid product installation state.');
      if (!config.installed && !reinstall) throw new Error('Install the product before preparing or starting it.');
      if (reinstall && descriptor.profile !== input!.profile) throw new Error('Deployment profile change requires a separate environment.');
      resources = config.resources; database = config.database;
    } else {
      if (!input) { await configuration(); throw new Error('Install the product before preparing or starting it.'); }
      // Validate without creating even the root marker, identity or credentials.
      if (await exists(root)) {
        const entry = await lstat(root);
        if (entry.isSymbolicLink()) throw new Error('Environment root cannot be a symbolic link.');
        if (!entry.isDirectory()) throw new Error('Directory is occupied; select an empty product environment directory.');
        if (await exists(join(root, '.xunjie-root'))) await assertRoot(root);
        else if ((await readdir(root)).length) await assertRoot(root);
        if (await exists(environmentPath) && (await environment()).profile !== input.profile) throw new Error('Environment identity/profile mismatch.');
      }
      if (!options.resources) throw new Error('Install requires resources from the product distribution.');
      resources = options.resources;
      database = input.database ?? { mode: input.profile === 'remote' ? 'none' : 'managed' };
    }
    if (!database || !['managed', 'external', 'none'].includes(database.mode)) throw new Error('Invalid database mode in product installation.');
    if (!resources || typeof resources.nodePath !== 'string' || typeof resources.webRoot !== 'string') throw new Error('Invalid resources in product installation.');
    // A new product may supply its helper for old metadata. Saved Node/PG/data
    // resources are never replaced, including during a reinstall.
    const helper = resources.windowsPrerequisitePath ?? options.windowsPrerequisitePath ?? options.resources?.windowsPrerequisitePath;
    return prepareProductPrerequisites(helper ? { ...resources, windowsPrerequisitePath: helper } : resources, database);
  }
  async function requirePrepared(input?: InstallOptions, reinstall = false): Promise<void> {
    const result = await prepare(input, reinstall);
    if (result.status === 'installation-required') throw new ProductInstallationRequiredError(result);
  }

  async function control(action: 'status' | 'stop'): Promise<RuntimeStatus | null> {
    if (!await exists(join(root, 'instance.json'))) return null;
    const instance = await readJson<RunningInstance>(join(root, 'instance.json'));
    if (!await ownsProcess(instance)) return null;
    try {
      const response = await fetch(new URL(`/runtime/control/${action}`, instance.endpoint), {
        method: action === 'stop' ? 'POST' : 'GET', redirect: 'error',
        headers: { authorization: `Bearer ${await resolveCredential(root, 'control')}` },
        signal: AbortSignal.timeout(action === 'stop' ? 60_000 : 15_000),
      });
      if (!response.ok) throw new Error(`Runtime control returned ${response.status}.`);
      const value = await response.json() as RuntimeStatus;
      const expected = await environment();
      if (value.environment.environmentId !== expected.environmentId
        || value.environment.installationId !== expected.installationId) throw new Error('Runtime identity mismatch.');
      return value;
    } catch (error) {
      if (!await ownsProcess(instance)) return null;
      throw new Error(`Owned runtime is not responding; data and processes are preserved. ${(error as Error).message}`);
    }
  }

  async function status(): Promise<RuntimeStatus> {
    const config = await configuration();
    const current = await control('status');
    if (current) return current;
    const saved = await exists(join(root, 'status.json')) ? await readJson<RuntimeStatus>(join(root, 'status.json')) : undefined;
    return {
      state: !config.installed ? 'uninstalled' : saved?.state === 'failed' ? 'failed' : 'stopped',
      environment: await environment(), dependencies: [],
      ...(saved?.reason ? { reason: saved.reason } : {}),
    };
  }

  async function stopUnlocked(): Promise<RuntimeStatus> {
    const config = await configuration();
    const result = await control('stop');
    if (result) {
      const deadline = Date.now() + 10_000;
      while (await exists(join(root, 'instance.json'))) {
        if (Date.now() > deadline) throw new Error('Runtime shutdown is still in progress.');
        await delay(50);
      }
      return result;
    }
    // A crashed application can leave its PostgreSQL running. SQL identity and
    // PGDATA are verified before pg_ctl may stop that instance.
    await stopDatabase(root, config.resources, config.database);
    const stopped: RuntimeStatus = { state: config.installed ? 'stopped' : 'uninstalled', environment: await environment(), dependencies: [] };
    await atomicJson(join(root, 'status.json'), stopped);
    return stopped;
  }

  return {
    prepare: (input?: InstallOptions) => prepare(input),
    async install(input: InstallOptions = { profile: 'local' }): Promise<RuntimeStatus> {
      runtimeEnvironmentSchema.shape.profile.parse(input.profile);
      await requirePrepared(input, true);
      await initializeRoot(root);
      return withLock(root, async () => {
        if (await exists(configPath)) {
          const config = await configuration();
          const existing = await environment();
          if (existing.profile !== input.profile) throw new Error('Deployment profile change requires a separate environment.');
          if (config.installed) return status();
          await atomicJson(configPath, { ...config, installed: true });
          return status();
        }
        const resources = options.resources;
        if (!resources) throw new Error('Install requires resources from the product distribution.');
        const { stdout } = await promisify(execFile)(resources.nodePath, ['--version'], { timeout: 5000, windowsHide: true });
        if (stdout.trim() !== `v${resources.nodeVersion}` || resources.nodeVersion !== '24.21.0') throw new Error('Bundled Node.js version mismatch.');
        if (!await exists(join(resources.webRoot, 'index.html'))) throw new Error('Product web entry is missing.');
        const database = input.database ?? { mode: input.profile === 'remote' ? 'none' : 'managed' };
        const host = input.host === 'localhost' ? '127.0.0.1' : input.host ?? '127.0.0.1';
        if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !input.tls) throw new Error('A shared listener requires a TLS certificate and private key.');
        if (!['127.0.0.1', '::1'].includes(host) && !input.publicEndpoint) throw new Error('A shared listener requires its public HTTPS endpoint.');
        const port = input.port ?? await freePort();
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listener port.');
        const endpoint = input.publicEndpoint ?? `${input.tls ? 'https' : 'http'}://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}`;
        const target = new URL(endpoint);
        if (target.username || target.password || target.search || target.hash || target.pathname !== '/'
          || !['https:', 'http:'].includes(target.protocol)
          || (!['127.0.0.1', '::1'].includes(host) && target.protocol !== 'https:')) throw new Error('Invalid public endpoint.');
        const environmentId = randomUUID();
        const descriptor: RuntimeEnvironment = {
          formatVersion: 1, environmentId, installationId: randomUUID(),
          clientNamespace: `xunjie.v1.${environmentId}`, profile: input.profile,
          services: [{ environmentId, serviceId: randomUUID(), unit: 'client', endpoint,
            protocolVersion: 1, capabilities: ['runtime.status'] }],
        };
        // Persist identity before preparing resources: retry never adopts a fresh
        // identity for data initialized by an interrupted installation.
        const existing = await exists(environmentPath) ? await environment() : descriptor;
        if (existing.profile !== input.profile) throw new Error('Environment identity/profile mismatch.');
        await atomicJson(environmentPath, existing);
        if (!await exists(join(root, 'credentials', 'control'))) await storeCredential(root, 'control', randomBytes(32).toString('base64url'));
        if (database.mode === 'managed') await prepareDatabase(root, resources);
        if (database.mode === 'external') await inspectDatabase(root, database, true, true);
        await atomicJson(configPath, {
          installed: true, resources, database, host, port: input.publicEndpoint ? port : Number(new URL(existing.services[0]!.endpoint).port || port),
          ...(input.tls ? { tls: input.tls } : {}), requiredServiceIds: input.requiredServiceIds ?? [], connections: [],
        } satisfies InstalledConfiguration);
        const installed: RuntimeStatus = { state: 'installed', environment: existing, dependencies: [] };
        await atomicJson(join(root, 'status.json'), installed);
        return installed;
      });
    },
    async start(): Promise<RuntimeStatus> {
      if (await exists(join(root, 'retired.json'))) throw new RecoveryError('source-retired');
      await requirePrepared();
      return withLock(root, async () => {
        const config = await configuration();
        if (!config.installed) throw new Error('Install the product before starting it.');
        const current = await control('status');
        if (current) return current;
        const launchPath = join(root, 'launch.json');
        let launch = await exists(launchPath) ? await readJson<ProcessOwner>(launchPath) : undefined;
        if (!launch || !await ownsProcess(launch)) {
          await mkdir(join(root, 'logs'), { recursive: true, mode: 0o700 });
          const log = await open(join(root, 'logs', 'runtime.log'), 'a', 0o600);
          try {
            const child = spawn(config.resources.nodePath, [fileURLToPath(new URL('./daemon.js', import.meta.url)), '--root', root], {
              cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
              // Parent development flags (NODE_OPTIONS/NODE_PATH) cannot inject
              // loaders into a packaged product process.
              env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !['NODE_OPTIONS', 'NODE_PATH', 'PGPASSWORD', 'PGSERVICE', 'PGSERVICEFILE'].includes(name))),
            });
            await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject); });
            const identity = await processIdentity(child.pid!);
            if (!identity) throw new Error('Runtime exited before recording its process identity.');
            launch = { pid: child.pid!, processIdentity: identity };
            await atomicJson(launchPath, launch);
            child.unref();
          } finally { await log.close(); }
        }
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          if (!await ownsProcess(launch)) {
            const saved = await status();
            throw new Error(saved.reason ?? 'Runtime exited during startup; inspect logs/runtime.log.');
          }
          const running = await control('status');
          if (running && running.state !== 'starting') return running;
          await delay(100);
        }
        throw new Error('Runtime startup timed out; data is preserved.');
      });
    },
    status,
    recovery: {
      configure: (policy: BackupPolicy) => recoveryControl<{ configured: true }>('configure', policy),
      catalog: (directory?: string) => recoveryControl<{ backups: RecoveryManifest[]; latest: unknown; operations: unknown[] }>('catalog', { directory }),
      backup: (input: { directory?: string; recoveryKeyRef?: string; keep?: number; minimumFreeBytes?: number; leaveClosed?: boolean } = {}) => recoveryControl<RecoveryManifest>('backup', input),
      resume: () => recoveryControl('resume'),
      async retire(input: { backupId: string; targetInstallationId: string }): Promise<RetirementProof> {
        await assertRoot(root);
        if (await exists(join(root, 'retired.json'))) {
          const proof = await readJson<RetirementProof>(join(root, 'retired.json'));
          const expected = await environment();
          if (proof.sourceEnvironmentId !== expected.environmentId || proof.sourceInstallationId !== expected.installationId
            || proof.backupId !== input.backupId || proof.targetInstallationId !== input.targetInstallationId
            || typeof proof.retiredAt !== 'string' || !Number.isFinite(Date.parse(proof.retiredAt))) throw new RecoveryError('retirement-conflict');
          return { sourceEnvironmentId: proof.sourceEnvironmentId, sourceInstallationId: proof.sourceInstallationId,
            targetInstallationId: proof.targetInstallationId, backupId: proof.backupId, retiredAt: proof.retiredAt };
        }
        return recoveryControl<RetirementProof>('retire', input);
      },
      fenceSource: (input: { sourceEnvironmentId: string; sourceServiceId: string; timeoutMs?: number }) => recoveryControl('fence-source', input),
      takeover: (input: { sourceRoot: string; receivers: { id: string; root: string }[] }) => recoveryControl('takeover', input),
    },
    async stop() { await assertRoot(root); return withLock(root, stopUnlocked); },
    async uninstall(): Promise<RuntimeStatus> {
      await assertRoot(root);
      return withLock(root, async () => {
        await stopUnlocked();
        const config = await configuration();
        await atomicJson(configPath, { ...config, installed: false });
        return status();
      });
    },
    async deleteEnvironment(input: { environmentId: string }): Promise<void> {
      await assertRoot(root);
      return withLock(root, async () => {
        if (input.environmentId !== (await environment()).environmentId) throw new Error('Environment identity mismatch; refusing deletion.');
        await stopUnlocked();
        for (const name of ['pgdata', 'database.json', 'external-database.json', 'credentials', 'private', 'logs', 'status.json', 'instance.json',
          'launch.json', 'maintenance.json', 'postgres.log', 'installation.json', 'environment.json']) await removeOwned(root, name);
      });
    },
    async database() { const config = await configuration(); return databaseBinding(root, config.database); },
    async setCredential(ref: string, value: string) {
      await initializeRoot(root);
      return withLock(root, () => storeCredential(root, ref, value));
    },
    async connect(connection: RuntimeConnection, credential: string): Promise<void> {
      await assertRoot(root);
      const release = await acquireLock(root, 'recovery');
      try { return await withLock(root, async () => {
        if (await exists(join(root, 'retired.json'))) throw new RecoveryError('source-retired');
        const boundary = await exists(join(root, 'maintenance.json'))
          ? await readJson<{ phase: string; reason?: string }>(join(root, 'maintenance.json')) : undefined;
        if (boundary && boundary.phase !== 'open' && boundary.reason !== 'stop') throw new RecoveryError('configuration-in-maintenance');
        if (await exists(join(root, 'recovery-state.json'))
          && (await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase !== 'active') throw new RecoveryError('target-isolated');
        const parsed = runtimeConnectionSchema.parse(connection);
        const descriptor = await environment();
        if (parsed.sourceEnvironmentId !== descriptor.environmentId || !descriptor.services.some(service => service.serviceId === parsed.sourceServiceId)) throw new Error('Connection source identity mismatch.');
        const config = await configuration();
        if (config.connections.some(value => value.connectionId === parsed.connectionId)) throw new Error('Connection already registered.');
        await storeCredential(root, parsed.credentialRef, credential);
        await atomicJson(configPath, { ...config, connections: [...config.connections, parsed] });
      }); } finally { await release(); }
    },
    async authorize(input: ConnectionAuthorization) {
      await assertRoot(root);
      const service = (await environment()).services[0]!;
      return createConnectionAuthority({ root, service, handlers: { 'runtime.status': () => status() } }).authorize(input);
    },
    async revoke(grantId: string) {
      await assertRoot(root);
      const service = (await environment()).services[0]!;
      return createConnectionAuthority({ root, service, handlers: { 'runtime.status': () => status() } }).revoke(grantId);
    },
  };
}
