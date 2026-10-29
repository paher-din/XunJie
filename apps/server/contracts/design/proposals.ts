import { z } from 'zod';
import { contentPatchSchema, versionSchema } from './draft.ts';

const id = z.string().min(1).max(128);
export const referenceSelectionSchema = z.strictObject({
  resourceVersionId: id, paragraphId: id, contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const designGenerationFields = {
  recoveryGeneration: id, request: z.string().min(1).max(32000).refine(value => value.trim().length > 0),
  references: z.array(referenceSelectionSchema).max(64).default([]),
};
export const agentCreateSchema = z.strictObject({
  mode: z.literal('agent'), generationMode: z.enum(['candidates','blueprint']), ...designGenerationFields,
});
export const proposalRequestSchema = z.strictObject({
  ...designGenerationFields, expectedRevision: versionSchema, mode: z.enum(['blueprint','patch']),
  allowedFields: z.array(contentPatchSchema.keyof()).min(1).max(20),
});
export const rubricTrialRequestSchema = z.strictObject({
  ...designGenerationFields, expectedRevision: versionSchema,
  sampleReferenceIds: z.array(id).min(1).max(64),
});
export const adoptProposalSchema = z.strictObject({
  recoveryGeneration: id, candidateIndex: z.number().int().nonnegative().optional(),
  content: contentPatchSchema.default({}),
});
const strings = z.array(z.string());
const suggestion = { problem: z.string(), audience: z.string(), artifact: z.string(), routes: strings };
export const teacherBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('candidates'), candidates: z.array(z.strictObject({
    ...suggestion, goals: strings, constraints: strings, unresolved: strings, resourceRefs: strings,
  })).min(1).max(3) }),
  z.strictObject({ kind: z.literal('blueprint'), ...suggestion, goals: strings, milestones: strings,
    resources: strings, helpPolicy: z.string(), checkpoints: strings, rubric: strings, goalEvidenceLinks: strings, unresolved: strings }),
  z.strictObject({ kind: z.literal('patch'), changes: z.array(z.strictObject({ field: z.string(), value: z.json() })),
    rationale: z.string(), resourceRefs: strings, affectedLinks: strings, unresolved: strings }),
  z.strictObject({ kind: z.literal('rubric_trial'), criterionComments: strings, ambiguities: strings,
    suggestedChanges: strings, sampleRefs: strings, unresolved: strings }),
]);
export type TeacherBody = z.infer<typeof teacherBodySchema>;
export type ReferenceSelection = z.infer<typeof referenceSelectionSchema>;
