import { z } from 'zod';
import { assignmentViewSchema } from './index.ts';

export const assignmentBootstrapSchema = z.strictObject({
  assignment: assignmentViewSchema,
  recoveryGeneration: z.string().min(1).max(128),
  /** Present only for the assigned student; null means no Attempt has been created. */
  currentAttemptId: z.string().min(1).max(128).nullable().optional(),
});
export type AssignmentBootstrap = z.infer<typeof assignmentBootstrapSchema>;
