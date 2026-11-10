import { z } from 'zod';
import { spaceIdentitySchema } from './spaces.js';
import { storageOwnerSchema, resourceReferenceSchema } from './storage.js';

/** Owner-selected rows only. Table names and columns are checked again by the receiving owner. */
export const studyTransferSchema = z.object({
  version: z.literal(1), identity: spaceIdentitySchema, sourceOwner: storageOwnerSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.json()))),
  resources: z.array(z.object({ reference: resourceReferenceSchema, base64: z.string() }).strict()),
  references: z.array(z.object({ referenceId: z.string(), resourceId: z.uuid() }).strict()),
  receipts: z.array(z.object({ requestId: z.string(), fingerprint: z.string(), result: z.json(),
    committedAt: z.string().nullable() }).strict()),
  /** Historical outbox entries are retained as evidence, never enqueued on the receiving owner. */
  outbox: z.array(z.object({ intentId: z.string(), requestId: z.string(), payload: z.json(),
    completedAt: z.string().nullable() }).strict()),
}).strict();
export type StudyTransfer = z.infer<typeof studyTransferSchema>;
export interface StudyImportReceipt { digest: string; activityIds: string[]; }
export interface StudyExportReceipt { digest: string; activityIds: string[]; state: 'acknowledged'; }
