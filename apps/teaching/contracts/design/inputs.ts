import { z } from 'zod';
import { draftSchema, versionSchema } from './draft.ts';
export type { BlueprintDraft, BlueprintContent, GoalRef } from './draft.ts';
const id = z.string().min(1).max(128);
export const helpPolicySchema = z.strictObject({ versionId: id, helpAllowed: z.boolean(), wholeSolutionAllowed: z.literal(false),
  limitedCheckHelpAllowed: z.literal(false), description: z.string().min(1) });
export const checkRuleSchema = z.strictObject({ versionId: z.enum(['textscope-core-v1', 'textscope-report-v1']),
  validatorVersion: z.literal('textscope-validator-v1'), limitedHelp: z.boolean(), description: z.string().min(1) });
export const runtimeSchema = z.strictObject({ runtimeProfileVersion: id, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  compilerImage: z.string().regex(/^sha256:[a-f0-9]{64}$/), runtimeImage: z.string().regex(/^sha256:[a-f0-9]{64}$/), approvedResultFiles: z.array(id) });
export const releaseSchema = z.strictObject({ expectedRevision: versionSchema, recoveryGeneration: id, confirmed: z.literal(true),
  concerns: z.array(z.strictObject({ code: z.enum(['meaning', 'difficulty', 'time', 'solution_space', 'rubric_ambiguity']),
    path: z.string(), reason: z.string(), resolution: z.string().optional() })).default([]) });
export const assignmentSchema = z.strictObject({ studentIds: z.array(id).min(1).max(100).refine(ids => new Set(ids).size === ids.length),
  expectedActivityControlRevision: versionSchema, recoveryGeneration: id });
export const activityControlSchema = z.strictObject({ expectedActivityControlRevision: versionSchema, action: z.enum(['pause', 'resume']), reason: z.string().trim().min(1), recoveryGeneration: id });
export const assignmentControlSchema = z.strictObject({ expectedAssignmentRevision: versionSchema, action: z.enum(['pause', 'resume']), reason: z.string().trim().min(1), recoveryGeneration: id });
export const frozenActivityShape = {
  activityVersionId: id, courseId: id, sourceBlueprintId: id, sourceRevision: versionSchema,
  draft: draftSchema, helpPolicy: helpPolicySchema, checkRule: checkRuleSchema, runtimeProfile: runtimeSchema,
  recoveryGeneration: id, confirmedBy: id, confirmedAt: z.number().int().nonnegative(),
};
export type HelpPolicyVersion = z.infer<typeof helpPolicySchema>;
export type CheckRuleVersion = z.infer<typeof checkRuleSchema>;
