import { provisionStorage as provision } from './database.js';
import type { StorageOwner } from '@xunjie/contracts/storage';
import type { DatabaseConnection, Migration, StorageBinding } from './types.js';

// Spell out the public signature so the emitted entry declaration never pulls
// private pg driver types into a distributed consumer's compilation.
export function provisionStorage(options: {
  admin: DatabaseConnection; owner: StorageOwner; password: string; migrations: readonly Migration[];
}): Promise<StorageBinding> { return provision(options); }
export { openStorage } from './storage.js';
export { StorageError } from './errors.js';
export { createFileBackend, createS3Backend, BlobError } from './blobs.js';
export type { BlobBackend } from './blobs.js';
export type { DatabaseConnection, StorageBinding, Migration, OwnedTransaction, QueryResult, StorageParticipant, OwnedStorage } from './types.js';
