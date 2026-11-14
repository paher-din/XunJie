import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import type { MaintenanceParticipant } from './maintenance.js';

/** One accepted command that the owner had not settled when maintenance closed its gates. */
interface BoundaryUnresolvedCommand {
  requestId: string;
  inputDigest: string;
  executionRef: string;
  /** Where the command really runs: the browser owner, a local native session or a receiving node. */
  location: string;
  state: string;
  statusKnowledge: 'confirmed' | 'unknown';
  stopRequested: boolean;
  disposition: 'accepted-not-started' | 'running' | 'paused' | 'stop-pending' | 'unknown';
  /** Set when the command names a real executor instance, so a later takeover keeps the same node. */
  nodeId?: string;
  executorInstanceId?: string;
}
/** Agent commands identify a real session; execution commands retain their real activity. */
export type BoundaryUnresolved = BoundaryUnresolvedCommand & (
  | { sessionId: string; activityId?: string }
  | { activityId: string; sessionId?: string }
);

/**
 * What one owner observed at the maintenance boundary. It is written into the encrypted owner data,
 * never into the public catalog; the manifest carries only its aggregate counts. `blocking` is
 * non-empty when the owner cannot prove a safe boundary, so backup must publish nothing.
 */
export interface OwnerBoundaryMaterial {
  formatVersion: 1;
  kind: string;
  serviceId: string;
  boundaryAt: string;
  source: { environmentId: string; installationId: string };
  schemaVersion: string;
  /** Facts the service really received; browser-only unsynced state is deliberately out of scope. */
  coverage: 'service-received';
  unresolved: BoundaryUnresolved[];
  settled: number;
  retained: { resources: number; checkpoints: number };
  blocking: { code: string; detail: string }[];
  /** Owner-specific, versioned payload. Encryption keeps it out of the public catalog. */
  evidence?: unknown;
  /** Read-only owner source closure (#221). Absent in backups sealed before this version. */
  sources?: { formatVersion: 1; kind: 'xunjie.owner-sources/1'; owner: string; entries: unknown[] };
}

/** Owner data is encrypted with the artifacts, never copied into the public catalog. */
export interface OwnerRecoveryData {
  formatVersion: 1;
  schemaVersion: string;
  engineVersion?: string;
  data: unknown;
  /** Versioned maintenance evidence produced at the same closed boundary as `data`. */
  material?: OwnerBoundaryMaterial;
}
export interface RecoveryOwner {
  participant: MaintenanceParticipant;
  /** All participants are closed and drained before exports. Settle only once no more pins or files can be created, including after abort. */
  export(input: { backupId: string; directory: string; signal: AbortSignal }): Promise<OwnerRecoveryData>;
  /**
   * The boundary evidence this owner really observed. Called once every gate is closed and the
   * owner has drained; a missing method means the owner cannot support #176 maintenance at all.
   */
  material(input: { backupId: string; boundaryAt: string; signal: AbortSignal }): Promise<OwnerBoundaryMaterial>;
  /** The owner may distinguish dormant logical records from unresolved effects at a receiver fence. */
  receiverMaterial?(input: { backupId: string; boundaryAt: string; signal: AbortSignal }): Promise<OwnerBoundaryMaterial>;
  /** Idempotent, including unknown IDs; failed/interrupted releases are retried after directory retirement. */
  release(backupId: string): Promise<void>;
  close?(): Promise<void>;
}
export interface RecoveryTarget {
  serviceId: string;
  /** Restore into an empty independent target, with both gates durably closed. */
  restore(input: { backupId: string; targetRoot: string; directory: string; recovery: OwnerRecoveryData; signal: AbortSignal }): Promise<RecoveryOwner>;
  /** Read through the owner service API, including its constraints and resource bytes. */
  validate(owner: RecoveryOwner): Promise<void>;
  /** Re-derive the owner's own boundary evidence from the restored data, never from the material alone. */
  validateMaterial?(owner: RecoveryOwner, material: OwnerBoundaryMaterial): Promise<void>;
}
/** What a receiving authority returns after it durably fenced the retired installation. */
export interface ReceiverFenceProof {
  fenced: true;
  backupId: string;
  targetInstallationId: string;
  receiverId: string;
  sourceEnvironmentId: string;
  sourceInstallationId: string;
  sourceServiceIds: string[];
  /** Required: the receiver's real owners confirmed their asynchronous effects, not just HTTP. */
  execution: ReceiverExecutionBoundary;
}
export interface ReceiverExecutionBoundary {
  formatVersion: 1;
  boundaryAt: string;
  unresolved: number;
  blocking: number;
  services: { serviceId: string; unresolved: number; settled: number; blocking: number }[];
}
export interface RecoveryArtifact {
  path: string;
  sha256: string;
  byteLength: number;
}
export interface RecoveryManifest {
  formatVersion: 1;
  backupId: string;
  source: RuntimeEnvironment;
  boundaryAt: string;
  completedAt: string;
  durationMs: number;
  services: { serviceId: string; schemaVersion: string; engineVersion?: string }[];
  receiverIds: string[];
  /** Aggregate boundary evidence; an absent boundary marks a historical backup that cannot take over. */
  boundary?: {
    formatVersion: 1;
    services: { serviceId: string; kind: string; unresolved: number; settled: number; blocking: number }[];
  };
  artifacts: RecoveryArtifact[];
  authentication: string;
}
export interface BackupPolicy {
  directory: string;
  intervalMs: number;
  keep: number;
  minimumFreeBytes: number;
  recoveryKeyRef: string;
}
export interface RecoveryOperation {
  formatVersion: 1;
  operationId: string;
  kind: 'backup' | 'restore' | 'upgrade' | 'takeover';
  phase: 'closing' | 'exporting' | 'restoring' | 'validating' | 'isolated' | 'verifying' | 'retiring-source'
    | 'fencing-receivers' | 'validating-target' | 'retiring' | 'active' | 'complete' | 'failed';
  startedAt: string;
  updatedAt: string;
  backupId?: string;
  error?: string;
}
