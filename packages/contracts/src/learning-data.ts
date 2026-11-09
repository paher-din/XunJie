import { z } from 'zod';
import { spaceIdentitySchema, learningTargetSchema } from './spaces.js';
import { courseActivityBindingSchema } from './courses.js';

/** UTF-8 text preserves original newline separators; binary and component state remain typed. */
export const workFileSchema = z.object({ objectId: z.uuid(), name: z.string().min(1).max(240)
  .refine(name => !name.startsWith('/') && !name.split('/').some(p => !p || p === '.' || p === '..') && !/[\\\x00-\x1f]/.test(name)),
  kind: z.enum(['text', 'code', 'resource', 'state']), contentId: z.uuid(),
  encoding: z.enum(['utf8', 'base64', 'json']), mediaType: z.string().min(1).max(200), value: z.string().max(2000000),
}).strict();
export type WorkFile = z.infer<typeof workFileSchema>;
export const workFilesSchema = z.array(workFileSchema).max(64).refine(files =>
  new Set(files.map(f => f.objectId)).size === files.length && new Set(files.map(f => f.name)).size === files.length
  && files.reduce((n, f) => n + f.value.length, 0) <= 1000000);
export const workViewSchema = z.object({ revision: z.number().int().nonnegative(), files: workFilesSchema }).strict();
export type WorkView = z.infer<typeof workViewSchema>;
export const workSyncSchema = z.object({ requestId: z.uuid(), baseRevision: z.number().int().nonnegative(), files: workFilesSchema }).strict();
export type WorkSync = z.infer<typeof workSyncSchema>;

/** Learning-data owner wire. Course releases and works have their own subsequent contracts. */
export const createActivitySchema = z.object({ requestId: z.uuid(), goal: z.string().max(4000),
  question: z.string().max(10000), references: z.array(z.object({ kind: z.literal('url'),
    url: z.url().refine(value => /^https:\/\//.test(value)), label: z.string().min(1).max(300) }).strict()).max(50),
}).strict().refine(value => !!(value.goal.trim() || value.question.trim() || value.references.length));
export type CreateActivity = z.infer<typeof createActivitySchema>;
export const activitySchema = z.object({ activityId: z.uuid(), identity: spaceIdentitySchema,
  target: learningTargetSchema, goal: z.string(), question: z.string(), references: createActivitySchema.shape.references,
  status: z.enum(['open', 'closed']), createdAt: z.string(), course: courseActivityBindingSchema.optional(), purpose: z.literal('preview').optional() }).strict();
export type LearningActivity = z.infer<typeof activitySchema>;

export const courseActivityResultSchema = z.object({ requestId: z.uuid(),
  state: z.enum(['pending', 'accepted', 'rejected']), activity: activitySchema.nullable(),
  error: z.string().nullable() }).strict();
export type CourseActivityResult = z.infer<typeof courseActivityResultSchema>;

/** Conversation visibility is independent of the activity's open/closed lifecycle. */
export const conversationArchiveStateSchema = z.object({ archivedIds: z.array(z.uuid()) }).strict();
export type ConversationArchiveState = z.infer<typeof conversationArchiveStateSchema>;
export const conversationArchiveSetSchema = z.object({ requestId: z.uuid(), activityId: z.uuid(), archived: z.boolean() }).strict();
export type ConversationArchiveSet = z.infer<typeof conversationArchiveSetSchema>;
export const conversationArchiveImportSchema = z.object({ requestId: z.uuid(), activityIds: z.array(z.uuid()) }).strict();
export type ConversationArchiveImport = z.infer<typeof conversationArchiveImportSchema>;

/** Labels and visibility do not change the activity or any teaching records. */
export const conversationHistoryItemSchema = z.object({ activityId: z.uuid(), title: z.string().nullable(),
  pinned: z.boolean(), deleted: z.boolean(), archived: z.boolean() }).strict();
export type ConversationHistoryItem = z.infer<typeof conversationHistoryItemSchema>;
export const conversationHistoryStateSchema = z.object({ items: z.array(conversationHistoryItemSchema) }).strict();
export type ConversationHistoryState = z.infer<typeof conversationHistoryStateSchema>;
export const conversationHistoryUpdateSchema = z.discriminatedUnion('action', [
  z.object({ requestId: z.uuid(), activityId: z.uuid(), action: z.literal('rename'),
    title: z.string().trim().min(1).max(200) }).strict(),
  z.object({ requestId: z.uuid(), activityId: z.uuid(), action: z.literal('pin'), pinned: z.boolean() }).strict(),
  z.object({ requestId: z.uuid(), activityId: z.uuid(), action: z.literal('delete') }).strict(),
]);
export type ConversationHistoryUpdate = z.infer<typeof conversationHistoryUpdateSchema>;
