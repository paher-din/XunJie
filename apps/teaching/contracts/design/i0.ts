import { z } from 'zod';
import { assignmentViewSchema } from './index.ts';

export const assignmentBootstrapSchema = z.strictObject({
  assignment: assignmentViewSchema,
  recoveryGeneration: z.string().min(1).max(128),
});
export type AssignmentBootstrap = z.infer<typeof assignmentBootstrapSchema>;
