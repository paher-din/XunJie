import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import { acquireLock, atomicJson, exists, initializeRoot, readJson } from './io.js';
import type { createMaintenanceCoordinator } from './maintenance.js';
import { checkIndependentDirectory, ensureRecoverySpace, sealRecovery, unsealRecovery, verifyRecovery } from './recovery-files.js';
import type { BackupPolicy, OwnerRecoveryData, RecoveryManifest, RecoveryOperation, RecoveryOwner, RecoveryTarget } from './recovery-types.js';

type Coordinator = ReturnType<typeof createMaintenanceCoordinator>;
export class RecoveryError extends Error {
  constructor(readonly code: string) { super(`Recovery: ${code}`); this.name = 'RecoveryError'; }
}
const safeCode = (error: unknown): string => {
  if (error instanceof AggregateError && error.errors.length) return safeCode(error.errors[0]);
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[a-zA-Z0-9_-]{1,60}$/.test(code) ? code : 'operation-failed';
};
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const checkId = (id: string) => { if (!idPattern.test(id)) throw new RecoveryError('invalid-identity'); };
type ServiceVersion = { serviceId: string; schemaVersion: string };
function versionsOf(owners: readonly RecoveryOwner[]): ServiceVersion[] {
  return owners.map(owner => ({ serviceId: owner.participant.descriptor.serviceId,
    schemaVersion: owner.participant.descriptor.schemaVersion })).sort((a,b) => a.serviceId.localeCompare(b.serviceId));
}

async function record(root: string, operation: RecoveryOperation) {
  await mkdir(join(root, 'recovery-operations'), { recursive: true, mode: 0o700 });
  operation.updatedAt = new Date().toISOString();
  await atomicJson(join(root, 'recovery-operations', `${operation.operationId}.json`), operation);
}
function operation(kind: RecoveryOperation['kind'], phase: RecoveryOperation['phase']): RecoveryOperation {
  return { formatVersion: 1, operationId: randomUUID(), kind, phase,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([action(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new RecoveryError('timeout')); }, timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}

export interface RecoveryReceiver {
  id: string;
  /** The receiving service durably rejects old credentials and drains their accepted requests. */
  fence(source: RuntimeEnvironment, serviceIds: readonly string[]): Promise<unknown>;
}
export interface RetirementProof {
  sourceEnvironmentId: string;
  sourceInstallationId: string;
  targetInstallationId: string;
  backupId: string;
  retiredAt: string;
}
function verifyRetirementProof(proof: RetirementProof | undefined, manifest: RecoveryManifest, environment: RuntimeEnvironment): asserts proof is RetirementProof {
  if (!proof || proof.sourceEnvironmentId !== manifest.source.environmentId || proof.sourceInstallationId !== manifest.source.installationId
    || proof.targetInstallationId !== environment.installationId || proof.backupId !== manifest.backupId
    || typeof proof.retiredAt !== 'string' || !Number.isFinite(Date.parse(proof.retiredAt))) throw new RecoveryError('invalid-retirement-proof');
}

/** The sole maintenance workflow. Hosts supply owners; no business table list lives here. */
export function createRecoveryManager(options: {
  root: string;
  environment: RuntimeEnvironment;
  maintenance: Coordinator;
  owners: readonly RecoveryOwner[];
  requiredServiceIds: readonly string[];
  receiverIds?: readonly string[] | (() => Promise<readonly string[]>);
  timeoutMs?: number;
}) {
  const root = resolve(options.root);
  const environment = structuredClone(options.environment);
  const owners = [...options.owners];
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RecoveryError('invalid-timeout');
  const required = [...new Set(options.requiredServiceIds)].sort();
  const configuredReceiverIds = options.receiverIds;
  const initialReceiverIds = typeof configuredReceiverIds === 'function' ? [] : [...(configuredReceiverIds ?? [])];
  const receiverIds = typeof configuredReceiverIds === 'function' ? configuredReceiverIds : async () => initialReceiverIds;
  const ownerIds = owners.map(item => item.participant.descriptor.serviceId);
  ownerIds.forEach(checkId);
  if (new Set(ownerIds).size !== ownerIds.length) throw new RecoveryError('duplicate-participant');

  function requireOwners() {
    const participants = options.maintenance.status().participants.map(item => item.serviceId).sort();
    if (required.some(id => !ownerIds.includes(id)) || participants.some(id => !ownerIds.includes(id))
      || ownerIds.some(id => !participants.includes(id))) throw new RecoveryError('missing-recovery-participant');
  }
  async function exclusive<T>(work: () => Promise<T>) {
    const unlock = await acquireLock(root, 'recovery', 0);
    try { return await work(); } finally { await unlock(); }
  }
  async function catalog(directory: string, key?: Uint8Array) {
    const backups: RecoveryManifest[] = [];
    const unavailable: { backupId: string; reason: string }[] = [];
    if (await exists(directory)) for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
      const path = join(directory, entry.name, 'manifest.json');
      if (!await exists(path)) continue;
      try {
        const value = await readJson<RecoveryManifest>(path);
        if (value.formatVersion === 1 && value.backupId === entry.name && value.source?.environmentId === environment.environmentId) {
          if (!key) unavailable.push({ backupId: entry.name, reason: 'recovery-key-required' });
          else backups.push(await verifyRecovery(join(directory, entry.name), key));
        }
      } catch (error) { unavailable.push({ backupId: entry.name, reason: safeCode(error) }); }
    }
    backups.sort((a, b) => b.boundaryAt.localeCompare(a.boundaryAt));
    const operations: RecoveryOperation[] = [];
    if (await exists(join(root, 'recovery-operations'))) for (const entry of await readdir(join(root, 'recovery-operations'))) {
      if (/^[0-9a-f-]{36}\.json$/.test(entry)) operations.push(await readJson(join(root, 'recovery-operations', entry)));
    }
    operations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { backups, unavailable, latest: operations[0] ?? null, operations };
  }
  async function backup(input: { directory: string; key: Uint8Array; minimumFreeBytes?: number; keep?: number; leaveClosed?: boolean }) {
    return exclusive(async () => {
      const state = operation('backup', 'closing');
      const backupId = state.operationId;
      state.backupId = backupId;
      let cleanupDirectory: string | undefined;
      await record(root, state);
      try {
        if (await exists(join(root, 'retired.json'))) throw new RecoveryError('source-retired');
        if (await exists(join(root, 'recovery-state.json'))
          && (await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase !== 'active') throw new RecoveryError('target-isolated');
        const resources = owners.flatMap(item => item.participant.descriptor.resourceRoots).filter(item => item.startsWith('/') || /^[a-z]:[\\/]/i.test(item));
        await checkIndependentDirectory(root, input.directory, resources);
        if (input.keep !== undefined && (!Number.isSafeInteger(input.keep) || input.keep < 1)) throw new RecoveryError('invalid-retention');
        await ensureRecoverySpace(input.directory, input.minimumFreeBytes ?? 64 * 1024 * 1024);
        const directory = join(resolve(input.directory), backupId);
        await mkdir(directory, { mode: 0o700 });
        cleanupDirectory = directory;
        const phase = options.maintenance.status().phase;
        if (phase === 'open' || phase === 'failed') await options.maintenance.enter(`backup:${backupId}`);
        else throw new RecoveryError('maintenance-already-entered');
        requireOwners();
        if (!options.maintenance.status().safeToStop) throw new RecoveryError('unconfirmed-boundary');
        const boundaryAt = new Date().toISOString();
        state.phase = 'exporting'; await record(root, state);
        const versions: RecoveryManifest['services'] = [];
        await bounded(async signal => {
          for (const owner of owners) {
            const serviceId = owner.participant.descriptor.serviceId;
            const ownerDirectory = join(directory, 'payload', serviceId);
            await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
            const recovery = await owner.export({ backupId, directory: ownerDirectory, signal }).catch(error => {
              throw new RecoveryError(`owner-export-${safeCode(error)}`);
            });
            if (recovery.formatVersion !== 1 || recovery.schemaVersion !== owner.participant.descriptor.schemaVersion) {
              throw new RecoveryError('incompatible-owner-format');
            }
            await writeFile(join(ownerDirectory, 'recovery.json'), JSON.stringify(recovery), { mode: 0o600, flag: 'wx' });
            versions.push({ serviceId, schemaVersion: recovery.schemaVersion,
              ...(recovery.engineVersion ? { engineVersion: recovery.engineVersion } : {}) });
          }
        }, timeoutMs);
        // Validation runs at the same closed boundary as exports and resource copies.
        await options.maintenance.validate();
        const manifest = await sealRecovery(directory, input.key, {
          formatVersion: 1, backupId, source: environment, boundaryAt, completedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(state.startedAt), services: versions,
          receiverIds: [...new Set(await receiverIds())].sort(),
        });
        await verifyRecovery(directory, input.key);
        await atomicJson(join(root, 'recovery-boundary.json'), { backupId, boundaryAt, held: Boolean(input.leaveClosed) });
        if (!input.leaveClosed) await options.maintenance.resume();
        state.phase = 'complete'; await record(root, state);
        if (input.keep) await retain(input.directory, input.key, input.keep);
        return manifest;
      } catch (error) {
        state.phase = 'failed'; state.error = safeCode(error);
        await record(root, state);
        throw error instanceof RecoveryError ? error : new RecoveryError(safeCode(error));
      } finally { if (cleanupDirectory) await rm(join(cleanupDirectory, 'payload'), { recursive: true, force: true }); }
    });
  }
  async function retain(directory: string, key: Uint8Array, keep: number) {
    const { backups } = await catalog(directory, key);
    for (const candidate of backups.slice(keep)) {
      const old = join(directory, candidate.backupId);
      const verified = await verifyRecovery(old, key);
      if (verified.source.environmentId !== environment.environmentId) throw new RecoveryError('backup-owner-conflict');
      const retired = join(directory, `.retired-${candidate.backupId}`);
      await rename(old, retired);
      // Stop advertising the backup before releasing its durable source pins.
      for (const owner of owners) await owner.release(candidate.backupId);
      await rm(retired, { recursive: true, force: true });
    }
  }
  async function retire(input: { backupId: string; targetInstallationId: string }): Promise<RetirementProof> {
    return exclusive(async () => {
      checkId(input.backupId); checkId(input.targetInstallationId);
      const prior = await exists(join(root, 'retired.json')) ? await readJson<RetirementProof>(join(root, 'retired.json')) : undefined;
      if (prior) {
        if (prior.backupId !== input.backupId || prior.targetInstallationId !== input.targetInstallationId
          || prior.sourceEnvironmentId !== environment.environmentId || prior.sourceInstallationId !== environment.installationId
          || !Number.isFinite(Date.parse(prior.retiredAt))) throw new RecoveryError('retirement-conflict');
        return prior;
      }
      requireOwners();
      const boundary = await readJson<{ backupId: string; held: boolean }>(join(root, 'recovery-boundary.json'));
      if (!boundary.held || boundary.backupId !== input.backupId || !options.maintenance.status().safeToStop
        || options.maintenance.status().reason !== `backup:${input.backupId}`) throw new RecoveryError('fresh-held-backup-required');
      await options.maintenance.validate();
      const proof: RetirementProof = { sourceEnvironmentId: environment.environmentId,
        sourceInstallationId: environment.installationId, targetInstallationId: input.targetInstallationId,
        backupId: input.backupId, retiredAt: new Date().toISOString() };
      await atomicJson(join(root, 'retired.json'), proof);
      return proof;
    });
  }
  async function takeover(input: { source: { retire: typeof retire }; receivers: readonly RecoveryReceiver[] }) {
    return exclusive(async () => {
      const recovered = await readJson<{ phase: string; manifest: RecoveryManifest; proof?: RetirementProof; versions?: ServiceVersion[] }>(join(root, 'recovery-state.json'));
      if (!['isolated','activating'].includes(recovered.phase)) throw new RecoveryError('validated-isolated-target-required');
      const manifest = recovered.manifest;
      if (environment.environmentId !== manifest.source.environmentId || environment.installationId === manifest.source.installationId) {
        throw new RecoveryError('target-identity-conflict');
      }
      const expected = [...manifest.receiverIds].sort();
      const actual = input.receivers.map(item => item.id).sort();
      if (new Set(actual).size !== actual.length || JSON.stringify(expected) !== JSON.stringify(actual)) throw new RecoveryError('missing-receiver');
      const state = operation('takeover', 'retiring'); state.backupId = manifest.backupId;
      await record(root, state);
      let proof = recovered.proof;
      try {
        if (proof || recovered.phase === 'activating') verifyRetirementProof(proof, manifest, environment);
        await atomicJson(join(root, 'recovery-state.json'), { ...recovered, phase: 'isolated' });
        requireOwners();
        const expectedVersions = (recovered.versions ?? manifest.services).map(({ serviceId, schemaVersion }) => ({ serviceId, schemaVersion }))
          .sort((a,b) => a.serviceId.localeCompare(b.serviceId));
        if (JSON.stringify(versionsOf(owners)) !== JSON.stringify(expectedVersions)) throw new RecoveryError('incompatible-owner-format');
        if (options.maintenance.status().phase === 'open') await options.maintenance.enter('takeover');
        await options.maintenance.validate();
        if (!proof) {
          const confirmed = await bounded(() => input.source.retire({ backupId: manifest.backupId,
            targetInstallationId: environment.installationId }), timeoutMs);
          verifyRetirementProof(confirmed, manifest, environment);
          proof = confirmed;
        }
        await atomicJson(join(root, 'recovery-state.json'), { ...recovered, phase: 'isolated', proof });
        const sourceServiceIds = [...new Set([...manifest.services.map(item => item.serviceId), ...manifest.source.services.map(item => item.serviceId)])];
        for (const receiver of input.receivers) await bounded(() => receiver.fence(manifest.source, sourceServiceIds), timeoutMs);
        // The durable isolation marker is removed only after proof and receiver confirmation.
        await atomicJson(join(root, 'recovery-state.json'), { ...recovered, phase: 'activating', proof });
        await options.maintenance.resume();
        await atomicJson(join(root, 'recovery-state.json'), { ...recovered, phase: 'active', proof });
        state.phase = 'active'; await record(root, state);
        return { phase: 'active' as const, backupId: manifest.backupId, installationId: environment.installationId };
      } catch (error) {
        // Failed/partial activation must be restart-safe and resealed, including runtime dispatch.
        const phase = options.maintenance.status().phase;
        if (phase === 'open' || phase === 'failed') await options.maintenance.enter('takeover-failed').catch(() => {});
        await atomicJson(join(root, 'recovery-state.json'), { ...recovered, phase: 'isolated', ...(proof ? { proof } : {}) });
        state.phase = 'failed'; state.error = safeCode(error); await record(root, state);
        throw error instanceof RecoveryError ? error : new RecoveryError(safeCode(error));
      }
    });
  }
  async function resume() {
    return exclusive(async () => {
      if (await exists(join(root, 'retired.json'))) throw new RecoveryError('source-retired');
      if (await exists(join(root, 'recovery-state.json'))
        && (await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase !== 'active') throw new RecoveryError('target-isolated');
      const result = await options.maintenance.resume();
      if (await exists(join(root, 'recovery-boundary.json'))) await atomicJson(join(root, 'recovery-boundary.json'), { held: false });
      return result;
    });
  }
  async function configure(policy: BackupPolicy) {
    if (!Number.isSafeInteger(policy.intervalMs) || policy.intervalMs < 60_000 || !Number.isSafeInteger(policy.keep) || policy.keep < 1
      || !Number.isSafeInteger(policy.minimumFreeBytes) || policy.minimumFreeBytes < 0
      || !/^[A-Za-z0-9_-]{1,100}$/.test(policy.recoveryKeyRef)) throw new RecoveryError('invalid-policy');
    await checkIndependentDirectory(root, policy.directory);
    await atomicJson(join(root, 'backup-policy.json'), { ...policy, directory: resolve(policy.directory) });
  }
  return { backup, catalog, configure, retire, takeover, resume };
}

/** Restoring never enables a target or dispatches work. Only takeover can transfer authority. */
export async function restoreRecoverySet(options: {
  backupDirectory: string; targetRoot: string; key: Uint8Array; targets: readonly RecoveryTarget[];
  minimumFreeBytes?: number; timeoutMs?: number;
}) {
  const manifest = await verifyRecovery(options.backupDirectory, options.key);
  const root = resolve(options.targetRoot);
  await checkIndependentDirectory(root, options.backupDirectory);
  if (await exists(root) && ((await lstat(root)).isSymbolicLink() || (await readdir(root)).length > 0)) throw new RecoveryError('target-conflict');
  const targetIds = options.targets.map(item => item.serviceId).sort();
  if (new Set(targetIds).size !== targetIds.length
    || JSON.stringify(targetIds) !== JSON.stringify(manifest.services.map(item => item.serviceId).sort())) throw new RecoveryError('missing-recovery-participant');
  await ensureRecoverySpace(root, options.minimumFreeBytes ?? manifest.artifacts.reduce((sum, item) => sum + item.byteLength, 64 * 1024 * 1024));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await initializeRoot(root);
  const state = operation('restore', 'restoring'); state.backupId = manifest.backupId;
  // Exclusive creation reserves this target across both preflight/lock windows.
  // It also fences a process exit before the first operation journal write.
  try {
    await writeFile(join(root, 'recovery-state.json'), JSON.stringify({ phase: 'restoring', manifest }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RecoveryError('target-conflict');
    throw error;
  }
  const unlock = await acquireLock(root, 'recovery', 0);
  const temporary = join(root, `.restore-${state.operationId}`);
  const owners: RecoveryOwner[] = [];
  try {
    if ((await readdir(root)).some(name => !['.xunjie-root', '.locks', 'recovery-state.json'].includes(name))) throw new RecoveryError('target-conflict');
    await record(root, state);
    await mkdir(temporary, { mode: 0o700 });
    await unsealRecovery(options.backupDirectory, temporary, options.key);
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    await bounded(async signal => {
      for (const target of options.targets) {
        signal.throwIfAborted();
        const directory = join(temporary, target.serviceId);
        const recovery = await readJson<OwnerRecoveryData>(join(directory, 'recovery.json'));
        const advertised = manifest.services.find(item => item.serviceId === target.serviceId)!;
        if (recovery.formatVersion !== 1 || recovery.schemaVersion !== advertised.schemaVersion || recovery.engineVersion !== advertised.engineVersion) throw new RecoveryError('incompatible-owner-format');
        const owner = await target.restore({ backupId: manifest.backupId, targetRoot: root, directory, recovery, signal });
        if (signal.aborted) {
          await Promise.allSettled([owner.participant.closeWrites(), owner.participant.closeDispatch()]);
          await owner.close?.();
          throw new RecoveryError('timeout');
        }
        owners.push(owner);
        if (owner.participant.descriptor.serviceId !== target.serviceId) throw new RecoveryError('owner-identity-conflict');
        await owner.participant.closeWrites(); await owner.participant.closeDispatch(); await owner.participant.drain();
        signal.throwIfAborted();
      }
    }, Math.max(1, deadline - Date.now()));
    const versions = versionsOf(owners);
    state.phase = 'validating'; await record(root, state);
    await bounded(async signal => {
      for (const owner of owners) {
        signal.throwIfAborted();
        await owner.participant.validate();
        signal.throwIfAborted();
        await options.targets.find(item => item.serviceId === owner.participant.descriptor.serviceId)!.validate(owner);
        signal.throwIfAborted();
      }
    }, Math.max(1, deadline - Date.now()));
    if (JSON.stringify(versionsOf(owners)) !== JSON.stringify(versions)) throw new RecoveryError('incompatible-owner-format');
    await atomicJson(join(root, 'recovery-state.json'), { phase: 'isolated', manifest, versions });
    state.phase = 'isolated'; await record(root, state);
    return { manifest, owners, versions };
  } catch (error) {
    await Promise.allSettled(owners.flatMap(owner => [owner.participant.closeWrites(), owner.participant.closeDispatch()]));
    await atomicJson(join(root, 'recovery-state.json'), { phase: 'failed', manifest, error: safeCode(error) });
    state.phase = 'failed'; state.error = safeCode(error); await record(root, state);
    throw error instanceof RecoveryError ? error : new RecoveryError(safeCode(error));
  } finally { await rm(temporary, { recursive: true, force: true }); await unlock(); }
}
