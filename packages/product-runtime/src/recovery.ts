import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import { acquireLock, atomicJson, exists, initializeRoot, ownsProcess, processIdentity, readJson } from './io.js';
import type { ProcessOwner } from './io.js';
import type { createMaintenanceCoordinator } from './maintenance.js';
import { checkIndependentDirectory, ensureRecoverySpace, sealRecovery, unsealRecovery, verifyRecovery } from './recovery-files.js';
import type { BackupPolicy, OwnerBoundaryMaterial, OwnerRecoveryData, ReceiverFenceProof, RecoveryManifest,
  RecoveryOperation, RecoveryOwner, RecoveryTarget } from './recovery-types.js';

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
// Private journal data lives with the existing operation, before any owner can pin.
type BackupOperation = RecoveryOperation & { cleanup?: {
  directory: string;
  serviceIds: string[];
  disposition: 'pending' | 'verified' | 'retiring' | 'released';
  producer?: ProcessOwner;
  error?: string;
} };
// Shared by managers in this process, including a replacement manager after a
// timeout. Other processes rely on the durable OS creation identity instead.
const producingBackups = new Set<string>();
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
  fence(source: RuntimeEnvironment, serviceIds: readonly string[], binding: { backupId: string; targetInstallationId: string }): Promise<unknown>;
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

/**
 * Boundary material must describe this exact service at this exact boundary. The evidence itself
 * stays inside the encrypted owner data; only these identity fields are checked here.
 */
function verifyBoundaryMaterial(material: OwnerBoundaryMaterial | undefined, input: {
  serviceId: string; schemaVersion: string; boundaryAt: string; environment: RuntimeEnvironment; installationId: string;
}): asserts material is OwnerBoundaryMaterial {
  if (!material || material.formatVersion !== 1 || typeof material.kind !== 'string' || !/^[a-z0-9][a-z0-9._/-]*$/i.test(material.kind)
    || material.serviceId !== input.serviceId || material.schemaVersion !== input.schemaVersion
    || material.boundaryAt !== input.boundaryAt || material.coverage !== 'service-received'
    || material.source?.environmentId !== input.environment.environmentId
    || material.source?.installationId !== input.installationId
    || !Array.isArray(material.unresolved) || !Array.isArray(material.blocking)
    || typeof material.settled !== 'number' || !material.retained
    || typeof material.retained.resources !== 'number' || typeof material.retained.checkpoints !== 'number') {
    throw new RecoveryError('invalid-boundary-material');
  }
  for (const command of material.unresolved) {
    if (!command || typeof command !== 'object'
      || typeof command.requestId !== 'string' || typeof command.inputDigest !== 'string'
      || typeof command.executionRef !== 'string'
      || (command.activityId === undefined && command.sessionId === undefined)
      || (command.activityId !== undefined && (typeof command.activityId !== 'string' || !command.activityId.trim()))
      || (command.sessionId !== undefined && (typeof command.sessionId !== 'string' || !command.sessionId.trim()))
      || typeof command.location !== 'string'
      || !['accepted-not-started', 'running', 'paused', 'stop-pending', 'unknown'].includes(command.disposition)) {
      throw new RecoveryError('invalid-boundary-material');
    }
  }
  for (const item of material.blocking) {
    if (!item || typeof item.code !== 'string' || typeof item.detail !== 'string') throw new RecoveryError('invalid-boundary-material');
  }
}

/** A receiver proves it fenced this exact installation, never merely that a request returned. */
function verifyReceiverProof(value: unknown, receiverId: string, manifest: RecoveryManifest, targetInstallationId: string): asserts value is ReceiverFenceProof {
  const proof = value as ReceiverFenceProof | undefined;
  const expected = [...new Set([...manifest.services.map(item => item.serviceId),
    ...manifest.source.services.map(item => item.serviceId)])].sort();
  if (!proof || proof.fenced !== true || proof.receiverId !== receiverId
    || proof.backupId !== manifest.backupId || proof.targetInstallationId !== targetInstallationId
    || proof.sourceEnvironmentId !== manifest.source.environmentId
    || proof.sourceInstallationId !== manifest.source.installationId
    || !Array.isArray(proof.sourceServiceIds) || proof.sourceServiceIds.length === 0
    // The host fences the union of the backup's owner services and the source environment's
    // services, so either set may name a member; anything else is not this source.
    || proof.sourceServiceIds.some(id => !manifest.source.services.some(service => service.serviceId === id)
      && !manifest.services.some(service => service.serviceId === id))
    || JSON.stringify([...proof.sourceServiceIds].sort()) !== JSON.stringify(expected)
    || !proof.execution || proof.execution.formatVersion !== 1
    || !Number.isFinite(Date.parse(proof.execution.boundaryAt))
    || proof.execution.unresolved !== 0 || proof.execution.blocking !== 0
    || !Array.isArray(proof.execution.services) || !proof.execution.services.length
    || !proof.execution.services.some(item => item.serviceId === receiverId.split('/')[1])
    || new Set(proof.execution.services.map(item => item.serviceId)).size !== proof.execution.services.length
    || proof.execution.services.some(item => !item.serviceId || item.unresolved !== 0 || item.blocking !== 0
      || !Number.isSafeInteger(item.settled) || item.settled < 0)) {
    throw new RecoveryError('invalid-receiver-proof');
  }
}

/** The sole maintenance workflow. Hosts supply owners; no business table list lives here. */
export function createRecoveryManager(options: {
  root: string;
  environment: RuntimeEnvironment;
  maintenance: Coordinator;
  owners: readonly RecoveryOwner[];
  requiredServiceIds: readonly string[];
  receiverIds?: readonly string[] | (() => Promise<readonly string[]>);
  /** Runtime-owned credential connections are retired before the target can admit configuration or work. */
  prepareActivation?(receiverIds: readonly string[]): Promise<void>;
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
  async function exclusive<T>(work: () => Promise<T>, waitMs = 0) {
    const unlock = await acquireLock(root, 'recovery', waitMs);
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
      if (/^[0-9a-f-]{36}\.json$/.test(entry)) {
        const { cleanup: _cleanup, ...state } = await readJson<BackupOperation>(join(root, 'recovery-operations', entry));
        operations.push(state);
      }
    }
    operations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { backups, unavailable, latest: operations[0] ?? null, operations };
  }
  async function cleanBackup(state: BackupOperation) {
    const pending = state.cleanup;
    if (!pending || pending.disposition === 'verified' || pending.disposition === 'released') return;
    // A timed-out producer can still establish pins. Process death or settlement,
    // never the timeout itself, proves it cannot create another pin for this ID.
    if (pending.producer && await ownsProcess(pending.producer)
      && (pending.producer.pid !== process.pid || producingBackups.has(state.operationId))) throw new RecoveryError('backup-export-pending');
    if (pending.disposition === 'pending' && state.phase !== 'failed') {
      state.phase = 'failed'; state.error = 'interrupted-backup';
    }
    pending.disposition = 'retiring'; delete pending.producer; delete pending.error;
    await record(root, state);
    const old = join(pending.directory, state.backupId!);
    const retired = join(pending.directory, `.retired-${state.backupId!}`);
    if (await exists(old)) await rename(old, retired);
    // A retry also visits already-retired directories, even without a manifest.
    let failure: unknown;
    for (const serviceId of [...pending.serviceIds]) {
      try {
        const owner = owners.find(item => item.participant.descriptor.serviceId === serviceId);
        if (!owner) throw new RecoveryError('missing-recovery-participant');
        await bounded(() => owner.release(state.backupId!), timeoutMs);
        pending.serviceIds = pending.serviceIds.filter(id => id !== serviceId);
        await record(root, state);
      } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
    await rm(retired, { recursive: true, force: true });
    pending.disposition = 'released';
    await record(root, state);
  }
  async function tryCleanBackup(state: BackupOperation) {
    try { await cleanBackup(state); }
    catch (error) {
      if (state.cleanup) { state.cleanup.error = safeCode(error); await record(root, state); }
      throw error instanceof RecoveryError ? error : new RecoveryError(safeCode(error));
    }
  }
  async function retryCleanup() {
    const directory = join(root, 'recovery-operations');
    if (!await exists(directory)) return;
    let failure: unknown;
    for (const entry of await readdir(directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(entry)) continue;
      const state = await readJson<BackupOperation>(join(directory, entry));
      if (state.kind !== 'backup' || !state.cleanup) continue;
      try { await tryCleanBackup(state); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  /** Retry durable failed/interrupted backup cleanup without reopening the gates. */
  async function cleanup() { return exclusive(retryCleanup); }
  async function backup(input: { directory: string; key: Uint8Array; minimumFreeBytes?: number; keep?: number; leaveClosed?: boolean }) {
    return exclusive(async () => {
      const state: BackupOperation = operation('backup', 'closing');
      const backupId = state.operationId;
      state.backupId = backupId;
      let exporting: Promise<void> | undefined;
      let exportFinished = true;
      await record(root, state);
      try {
        await retryCleanup();
        if (await exists(join(root, 'retired.json'))) throw new RecoveryError('source-retired');
        if (await exists(join(root, 'recovery-state.json'))
          && (await readJson<{ phase: string }>(join(root, 'recovery-state.json'))).phase !== 'active') throw new RecoveryError('target-isolated');
        const resources = owners.flatMap(item => item.participant.descriptor.resourceRoots).filter(item => item.startsWith('/') || /^[a-z]:[\\/]/i.test(item));
        await checkIndependentDirectory(root, input.directory, resources);
        if (input.keep !== undefined && (!Number.isSafeInteger(input.keep) || input.keep < 1)) throw new RecoveryError('invalid-retention');
        await ensureRecoverySpace(input.directory, input.minimumFreeBytes ?? 64 * 1024 * 1024);
        const directory = join(resolve(input.directory), backupId);
        const identity = await processIdentity(process.pid);
        if (!identity) throw new RecoveryError('unknown-process-identity');
        state.cleanup = { directory: resolve(input.directory), serviceIds: [], disposition: 'pending',
          producer: { pid: process.pid, processIdentity: identity } };
        producingBackups.add(backupId);
        await record(root, state);
        await mkdir(directory, { mode: 0o700 });
        const phase = options.maintenance.status().phase;
        if (phase === 'open' || phase === 'failed') await options.maintenance.enter(`backup:${backupId}`);
        else throw new RecoveryError('maintenance-already-entered');
        requireOwners();
        if (!options.maintenance.status().safeToStop) throw new RecoveryError('unconfirmed-boundary');
        const boundaryAt = new Date().toISOString();
        // Boundary evidence is read at the same closed boundary as the exports. A blocking owner
        // means this maintenance success cannot be published at all.
        const materials = new Map<string, OwnerBoundaryMaterial>();
        const boundaryServices: NonNullable<RecoveryManifest['boundary']>['services'] = [];
        for (const owner of owners) {
          const descriptor = owner.participant.descriptor;
          // An owner that cannot describe its boundary cannot take part in #176 maintenance.
          if (typeof owner.material !== 'function') throw new RecoveryError('missing-boundary-material');
          let material: OwnerBoundaryMaterial;
          try {
            material = await owner.material({ backupId, boundaryAt, signal: new AbortController().signal });
          } catch (error) {
            throw new RecoveryError(`owner-boundary-${safeCode(error)}`);
          }
          verifyBoundaryMaterial(material, { serviceId: descriptor.serviceId, schemaVersion: descriptor.schemaVersion,
            boundaryAt, environment, installationId: environment.installationId });
          if (material.blocking.length) throw new RecoveryError('unconfirmed-execution-boundary');
          materials.set(descriptor.serviceId, material);
          boundaryServices.push({ serviceId: descriptor.serviceId, kind: material.kind,
            unresolved: material.unresolved.length, settled: material.settled, blocking: 0 });
        }
        state.phase = 'exporting'; state.cleanup.serviceIds = [...ownerIds]; await record(root, state);
        const versions: RecoveryManifest['services'] = [];
        await bounded(signal => exporting = (async () => {
          exportFinished = false;
          for (const owner of owners) {
            signal.throwIfAborted();
            const serviceId = owner.participant.descriptor.serviceId;
            const ownerDirectory = join(directory, 'payload', serviceId);
            await mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
            signal.throwIfAborted();
            const recovery = await owner.export({ backupId, directory: ownerDirectory, signal }).catch(error => {
              throw new RecoveryError(`owner-export-${safeCode(error)}`);
            });
            signal.throwIfAborted();
            if (recovery.formatVersion !== 1 || recovery.schemaVersion !== owner.participant.descriptor.schemaVersion) {
              throw new RecoveryError('incompatible-owner-format');
            }
            const material = materials.get(serviceId);
            verifyBoundaryMaterial(material, { serviceId, schemaVersion: owner.participant.descriptor.schemaVersion,
              boundaryAt, environment, installationId: environment.installationId });
            await writeFile(join(ownerDirectory, 'recovery.json'), JSON.stringify({ ...recovery, material }),
              { mode: 0o600, flag: 'wx' });
            versions.push({ serviceId, schemaVersion: recovery.schemaVersion,
              ...(recovery.engineVersion ? { engineVersion: recovery.engineVersion } : {}) });
          }
        })().finally(() => { exportFinished = true; }), timeoutMs);
        // Validation runs at the same closed boundary as exports and resource copies.
        await options.maintenance.validate();
        const manifest = await sealRecovery(directory, input.key, {
          formatVersion: 1, backupId, source: environment, boundaryAt, completedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(state.startedAt), services: versions,
          receiverIds: [...new Set(await receiverIds())].sort(),
          boundary: { formatVersion: 1, services: boundaryServices },
        });
        await verifyRecovery(directory, input.key);
        state.cleanup.disposition = 'verified'; delete state.cleanup.producer;
        producingBackups.delete(backupId);
        await record(root, state);
        await atomicJson(join(root, 'recovery-boundary.json'), { backupId, boundaryAt, held: Boolean(input.leaveClosed) });
        if (!input.leaveClosed) await options.maintenance.resume();
        state.phase = 'complete'; await record(root, state);
        if (input.keep) await retain(input.directory, input.key, input.keep);
        return manifest;
      } catch (error) {
        state.phase = 'failed'; state.error = safeCode(error);
        if (exportFinished) {
          producingBackups.delete(backupId);
          if (state.cleanup) delete state.cleanup.producer;
        }
        await record(root, state);
        if (exportFinished) await tryCleanBackup(state).catch(() => {});
        else {
          // Never race journal writes with another manager's cleanup. Settlement
          // also makes a retry in this process safe if the background lock fails.
          const settled = async () => {
            producingBackups.delete(backupId);
            await exclusive(async () => {
              const current = await readJson<BackupOperation>(join(root, 'recovery-operations', `${backupId}.json`));
              delete current.cleanup!.producer;
              await record(root, current);
              await tryCleanBackup(current);
            }, 60_000);
          };
          void exporting!.then(settled, settled).catch(() => {});
        }
        throw error instanceof RecoveryError ? error : new RecoveryError(safeCode(error));
      }
    });
  }
  async function retain(directory: string, key: Uint8Array, keep: number) {
    const { backups } = await catalog(directory, key);
    for (const candidate of backups.slice(keep)) {
      const old = join(directory, candidate.backupId);
      const verified = await verifyRecovery(old, key);
      if (verified.source.environmentId !== environment.environmentId) throw new RecoveryError('backup-owner-conflict');
      const path = join(root, 'recovery-operations', `${candidate.backupId}.json`);
      const state: BackupOperation = await exists(path) ? await readJson(path) : {
        ...operation('backup', 'complete'), operationId: candidate.backupId, backupId: candidate.backupId,
      };
      state.cleanup = { directory: resolve(directory), serviceIds: candidate.services.map(item => item.serviceId), disposition: 'retiring' };
      await record(root, state);
      await tryCleanBackup(state);
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
      const recovered = await readJson<{ phase: string; manifest: RecoveryManifest; proof?: RetirementProof; versions?: ServiceVersion[];
        legacy?: boolean; takeover?: { stage: string; updatedAt: string; receivers: string[];
          receiverProofs?: Record<string, ReceiverFenceProof> } }>(join(root, 'recovery-state.json'));
      if (!['isolated','activating','active'].includes(recovered.phase)) throw new RecoveryError('validated-isolated-target-required');
      const manifest = recovered.manifest;
      if (environment.environmentId !== manifest.source.environmentId || environment.installationId === manifest.source.installationId) {
        throw new RecoveryError('target-identity-conflict');
      }
      // Authority transfer needs a complete boundary: every owner supplied material at this exact
      // boundary and none of them reported unresolved execution. Aggregate generation counters
      // alone never prove that, so a legacy or partial backup stays isolated.
      const boundary = manifest.boundary;
      const expectedServices = manifest.services.map(item => item.serviceId).sort();
      if (recovered.legacy === true || !boundary || boundary.formatVersion !== 1
        || JSON.stringify(boundary.services.map(item => item.serviceId).sort()) !== JSON.stringify(expectedServices)
        || boundary.services.some(item => item.blocking !== 0)) throw new RecoveryError('boundary-material-required');
      const expected = [...manifest.receiverIds].sort();
      const actual = input.receivers.map(item => item.id).sort();
      if (new Set(actual).size !== actual.length || JSON.stringify(expected) !== JSON.stringify(actual)) throw new RecoveryError('missing-receiver');
      // A successful transition may lose its reply. Confirm the original durable evidence and
      // return the same outcome; never retire/fence again or interrupt new target-side edits.
      if (recovered.phase === 'active') {
        verifyRetirementProof(recovered.proof, manifest, environment);
        for (const receiver of input.receivers)
          verifyReceiverProof(recovered.takeover?.receiverProofs?.[receiver.id], receiver.id, manifest, environment.installationId);
        return { phase: 'active' as const, backupId: manifest.backupId, installationId: environment.installationId };
      }
      const state = operation('takeover', 'verifying'); state.backupId = manifest.backupId;
      await record(root, state);
      let proof = recovered.proof;
      const takeover = recovered.takeover ?? { stage: 'verifying', updatedAt: new Date().toISOString(), receivers: [] };
      takeover.receiverProofs ??= {};
      // Durable stage marker: a crash between stages restarts from the recorded place, and the
      // isolation marker is never removed by a stage that did not complete.
      const saveStage = async (stage: string, phase: 'isolated' | 'activating' = 'isolated') => {
        takeover.stage = stage; takeover.updatedAt = new Date().toISOString();
        await atomicJson(join(root, 'recovery-state.json'), { ...recovered, phase, ...(proof ? { proof } : {}), takeover });
      };
      try {
        if (proof || recovered.phase === 'activating') verifyRetirementProof(proof, manifest, environment);
        await saveStage('verifying');
        requireOwners();
        const expectedVersions = (recovered.versions ?? manifest.services).map(({ serviceId, schemaVersion }) => ({ serviceId, schemaVersion }))
          .sort((a,b) => a.serviceId.localeCompare(b.serviceId));
        if (JSON.stringify(versionsOf(owners)) !== JSON.stringify(expectedVersions)) throw new RecoveryError('incompatible-owner-format');
        if (options.maintenance.status().phase === 'open') await options.maintenance.enter('takeover');
        await saveStage('retiring-source');
        state.phase = 'retiring-source'; await record(root, state);
        if (!proof) {
          const confirmed = await bounded(() => input.source.retire({ backupId: manifest.backupId,
            targetInstallationId: environment.installationId }), timeoutMs);
          verifyRetirementProof(confirmed, manifest, environment);
          proof = confirmed;
        }
        await saveStage('fencing-receivers');
        state.phase = 'fencing-receivers'; await record(root, state);
        const sourceServiceIds = [...new Set([...manifest.services.map(item => item.serviceId), ...manifest.source.services.map(item => item.serviceId)])];
        for (const receiver of input.receivers) {
          // A returned promise is not evidence: the proof must name this source installation and
          // only source services, so a receiver cannot acknowledge a different fence.
          const value = await bounded(() => receiver.fence(manifest.source, sourceServiceIds,
            { backupId: manifest.backupId, targetInstallationId: environment.installationId }), timeoutMs);
          verifyReceiverProof(value, receiver.id, manifest, environment.installationId);
          takeover.receiverProofs[receiver.id] = value;
          if (!takeover.receivers.includes(receiver.id)) takeover.receivers.push(receiver.id);
          await saveStage('fencing-receivers');
        }
        await saveStage('validating-target');
        state.phase = 'validating-target'; await record(root, state);
        await options.maintenance.validate();
        await options.prepareActivation?.(input.receivers.map(receiver => receiver.id));
        // The durable isolation marker is removed only after proof and receiver confirmation.
        await saveStage('validating-target', 'activating');
        await options.maintenance.resume();
        await saveStage('active', 'activating');
        await atomicJson(join(root, 'recovery-state.json'), { ...recovered, phase: 'active', ...(proof ? { proof } : {}), takeover });
        state.phase = 'active'; await record(root, state);
        return { phase: 'active' as const, backupId: manifest.backupId, installationId: environment.installationId };
      } catch (error) {
        // Failed/partial activation must be restart-safe and resealed, including runtime dispatch.
        const phase = options.maintenance.status().phase;
        if (phase === 'open' || phase === 'failed') await options.maintenance.enter('takeover-failed').catch(() => {});
        takeover.updatedAt = new Date().toISOString();
        await atomicJson(join(root, 'recovery-state.json'), { ...recovered, phase: 'isolated', ...(proof ? { proof } : {}), takeover });
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
      await retryCleanup();
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
  return { backup, catalog, cleanup, configure, retire, takeover, resume };
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
  const materials = new Map<string, OwnerBoundaryMaterial>();
  // A backup sealed before boundary material existed can still be read in isolation, but it can
  // never take over: the marker keeps that difference visible to the operator and to takeover.
  let legacy = false;
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
        if (recovery.material === undefined) legacy = true;
        else {
          verifyBoundaryMaterial(recovery.material, { serviceId: target.serviceId, schemaVersion: advertised.schemaVersion,
            boundaryAt: manifest.boundaryAt, environment: manifest.source, installationId: manifest.source.installationId });
          materials.set(target.serviceId, recovery.material);
        }
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
        const target = options.targets.find(item => item.serviceId === owner.participant.descriptor.serviceId)!;
        await target.validate(owner);
        const material = materials.get(owner.participant.descriptor.serviceId);
        // The owner re-derives its own evidence from the restored data, never from the material alone.
        if (material && target.validateMaterial) await target.validateMaterial(owner, material);
        signal.throwIfAborted();
      }
    }, Math.max(1, deadline - Date.now()));
    if (JSON.stringify(versionsOf(owners)) !== JSON.stringify(versions)) throw new RecoveryError('incompatible-owner-format');
    await atomicJson(join(root, 'recovery-state.json'), { phase: 'isolated', manifest, versions, ...(legacy ? { legacy: true } : {}) });
    state.phase = 'isolated'; await record(root, state);
    return { manifest, owners, versions };
  } catch (error) {
    await Promise.allSettled(owners.flatMap(owner => [owner.participant.closeWrites(), owner.participant.closeDispatch()]));
    await atomicJson(join(root, 'recovery-state.json'), { phase: 'failed', manifest, error: safeCode(error) });
    state.phase = 'failed'; state.error = safeCode(error); await record(root, state);
    throw error instanceof RecoveryError ? error : new RecoveryError(safeCode(error));
  } finally { await rm(temporary, { recursive: true, force: true }); await unlock(); }
}
