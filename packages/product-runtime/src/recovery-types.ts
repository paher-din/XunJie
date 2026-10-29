import type { RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import type { MaintenanceParticipant } from './maintenance.js';

/** Owner data is encrypted with the artifacts, never copied into the public catalog. */
export interface OwnerRecoveryData {
  formatVersion: 1;
  schemaVersion: string;
  engineVersion?: string;
  data: unknown;
}
export interface RecoveryOwner {
  participant: MaintenanceParticipant;
  /** All participants are closed and drained before the first owner exports. */
  export(input: { backupId: string; directory: string; signal: AbortSignal }): Promise<OwnerRecoveryData>;
  release(backupId: string): Promise<void>;
  close?(): Promise<void>;
}
export interface RecoveryTarget {
  serviceId: string;
  /** Restore into an empty independent target, with both gates durably closed. */
  restore(input: { backupId: string; targetRoot: string; directory: string; recovery: OwnerRecoveryData; signal: AbortSignal }): Promise<RecoveryOwner>;
  /** Read through the owner service API, including its constraints and resource bytes. */
  validate(owner: RecoveryOwner): Promise<void>;
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
  phase: 'closing' | 'exporting' | 'restoring' | 'validating' | 'isolated' | 'retiring' | 'active' | 'complete' | 'failed';
  startedAt: string;
  updatedAt: string;
  backupId?: string;
  error?: string;
}
