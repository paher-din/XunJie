import { z } from 'zod';

/** Versioned course help policy fixed by a release; the Agent receiver refuses questions outside it. */
export const teachingHelpPolicySchema = z.object({
  version: z.literal(1),
  questions: z.enum(['allowed', 'disabled']),
  scope: z.enum(['course', 'general']),
  note: z.string().max(2000).optional(),
}).strict();
export type TeachingHelpPolicy = z.infer<typeof teachingHelpPolicySchema>;
