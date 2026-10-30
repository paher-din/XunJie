import { z } from 'zod';
import { spaceIdentitySchema, learningTargetSchema } from './spaces.js';

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
  status: z.enum(['open', 'closed']), createdAt: z.string() }).strict();
export type LearningActivity = z.infer<typeof activitySchema>;
