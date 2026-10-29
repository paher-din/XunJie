import { z } from 'zod';

/** Storage owns this wire format. Driver configuration and credentials are host-only. */
export const storageOwnerSchema = z.object({ environmentId: z.uuid(), serviceId: z.uuid() }).strict();
export type StorageOwner = z.infer<typeof storageOwnerSchema>;

export const resourceReferenceSchema = z.object({
  formatVersion: z.literal(1),
  resourceId: z.uuid(),
  owner: storageOwnerSchema,
  scope: z.string().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().min(1).max(200),
  contentVersion: z.number().int().positive(),
  locator: z.object({ backendId: z.string().regex(/^[a-z0-9_-]{1,80}$/), key: z.string().regex(/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/), writeId: z.uuid() }).strict(),
}).strict();
export type ResourceReference = z.infer<typeof resourceReferenceSchema>;

export const storageErrorCodes = [
  'invalid', 'incompatible', 'migration-busy', 'conflict', 'identity-conflict',
  'commit-unknown', 'unavailable', 'forbidden', 'missing', 'corrupt',
  'upload-unknown', 'maintenance', 'stale-generation', 'resource-busy', 'resource-gone',
] as const;
export type StorageErrorCode = typeof storageErrorCodes[number];
export interface StorageFailure { code: StorageErrorCode; requestId?: string; }

export interface StorageReceipt {
  requestId: string;
  result: unknown;
  committedAt: string;
}

export interface StorageManifest {
  formatVersion: 1;
  backupId: string;
  owner: StorageOwner;
  schemaVersion: number;
  generation: string;
  resources: ResourceReference[];
}
