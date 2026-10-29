import type { ResourceReference, StorageManifest, StorageOwner, StorageReceipt } from '@xunjie/contracts/storage';
import type { MaintenanceParticipantDescriptor } from '@xunjie/contracts/product-runtime';

export interface DatabaseConnection {
  host: string; port: number; database: string; user: string; password: string;
  ssl?: { ca: string };
}
export interface StorageBinding { owner: StorageOwner; schema: string; connection: DatabaseConnection; }
export interface Migration { version: number; name: string; sql: string; }
export interface QueryResult<T> { rows: T[]; rowCount: number; }

/** Only the owner module receives this interface; its database role cannot write another owner. */
export interface OwnedTransaction {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  reference(referenceId: string, resourceId: string): Promise<ResourceReference>;
  unreference(referenceId: string): Promise<void>;
  enqueue(intentId: string, payload: unknown): Promise<void>;
  completeIntent(intentId: string): Promise<void>;
}
export interface StorageParticipant {
  descriptor: MaintenanceParticipantDescriptor;
  closeWrites(): Promise<void>;
  closeDispatch(): Promise<void>;
  drain(): Promise<void>;
  validate(): Promise<void>;
  resume(): Promise<void>;
}
export interface OwnedStorage {
  readonly owner: StorageOwner;
  readonly generation: string;
  request(input: { requestId: string; fingerprint: string }, effect: (tx: OwnedTransaction) => Promise<unknown>): Promise<StorageReceipt>;
  receipt(requestId: string, fingerprint?: string): Promise<StorageReceipt | null>;
  read<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  pendingIntents(): Promise<{ intentId: string; payload: unknown }[]>;
  stageResource(input: { uploadId: string; scope: string; bytes: Uint8Array; mediaType: string; contentVersion: number }): Promise<ResourceReference>;
  reconcileUpload(uploadId: string): Promise<ResourceReference>;
  resource(resourceId: string): Promise<ResourceReference>;
  readResource(resourceId: string): Promise<Uint8Array>;
  /** Validated opaque bytes for snapshot copying; readResource returns the original payload. */
  readResourceObject(resourceId: string): Promise<Uint8Array>;
  collect(options: { olderThan: Date; limit?: number }): Promise<string[]>;
  participant(): StorageParticipant;
  snapshot<T>(backupId: string, consume: (snapshot: { databaseSnapshot: string; manifest: StorageManifest }) => Promise<T>): Promise<T>;
  releaseBackup(backupId: string): Promise<void>;
  validateManifest(manifest: StorageManifest): Promise<void>;
  close(): Promise<void>;
}
