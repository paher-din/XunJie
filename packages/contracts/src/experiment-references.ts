import { z } from 'zod';
import { questionReferenceSourceSchema } from './question-drafts.js';

/** A fixed experiment handoff used by both the browser and the product host. */
export const experimentReferenceSchema = z.object({
  activityId: z.uuid(),
  requestId: z.uuid(),
  executionRef: z.uuid(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().trim().min(1).max(300).optional(),
  question: z.string().max(10_000).optional(),
  source: questionReferenceSourceSchema,
}).strict().superRefine((value, ctx) => {
  if (value.source.kind !== 'component' || value.source.origin !== 'execution-result'
    || value.source.activityId !== value.activityId || value.source.requestId !== value.requestId || value.source.objectId !== value.requestId
    || value.source.executionRef !== value.executionRef) {
    ctx.addIssue({ code: 'custom', path: ['source'], message: 'Experiment reference identity does not match its source' });
  }
});
export type ExperimentReference = z.infer<typeof experimentReferenceSchema>;
export const experimentDraftSchema = experimentReferenceSchema.safeExtend({
  label: z.string().trim().min(1).max(300),
  question: z.string().max(10_000),
});
export type ExperimentDraft = z.infer<typeof experimentDraftSchema>;
