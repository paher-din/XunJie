import { z } from 'zod';
import { learningTargetSchema, type SpaceIdentity } from './spaces.js';

/** A preference fact keeps the exact source event and review state; corrections never rewrite history. */
export const studentFactScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('activity'), activityId: z.uuid() }).strict(),
  z.object({ kind: z.literal('course'), courseId: z.uuid() }).strict(),
  z.object({ kind: z.literal('global') }).strict(),
]);
export type StudentFactScope = z.infer<typeof studentFactScopeSchema>;
export const studentFactReviewStatusSchema = z.enum(['unreviewed', 'confirmed', 'corrected', 'retracted']);
export const studentFactSchema = z.object({ factId: z.uuid(), kind: z.literal('preference'), topic: z.string().min(1).max(200),
  statement: z.string().min(1).max(4000),
  source: z.object({ eventId: z.uuid(), seq: z.number().int().nonnegative(), activityId: z.uuid(),
    inputId: z.uuid().optional(), createdAt: z.iso.datetime(),
    sessionId: z.uuid().optional(), runId: z.uuid().optional(), owner: learningTargetSchema.optional(),
    learningTarget: learningTargetSchema.optional(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  contentVersion: z.number().int().positive(), scope: studentFactScopeSchema,
  reviewStatus: studentFactReviewStatusSchema, supersedes: z.uuid().nullable(), retractedBy: z.uuid().nullable() }).strict();
export type StudentFact = z.infer<typeof studentFactSchema>;

export const studentFactsReadInputSchema = z.object({ query: z.string().trim().max(200).optional(),
  scope: z.enum(['current-activity', 'same-course', 'eligible']).default('eligible') }).strict();
export type StudentFactsReadInput = z.infer<typeof studentFactsReadInputSchema>;
export const studentFactsReadResultSchema = z.object({ facts: z.array(studentFactSchema).max(100),
  activity: z.object({ activityId: z.uuid(), goal: z.string(), courseId: z.uuid().nullable() }).strict(),
  continuation: z.object({ state: z.enum(['same-activity', 'same-course', 'cross-course-preferences', 'ambiguous']),
    detail: z.string().max(1000) }).strict(),
  unknown: z.array(z.string().max(300)).max(20) }).strict();
export type StudentFactsReadResult = z.infer<typeof studentFactsReadResultSchema>;

/** A source owner authorizes the actual activity and returns only explicitly sourced preferences. */
export interface StudentFactsPort {
  read(identity: SpaceIdentity, activityId: string, input?: unknown): Promise<StudentFactsReadResult>;
}
