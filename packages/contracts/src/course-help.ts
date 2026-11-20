import { z } from 'zod';

/** Versioned course help policy fixed by a release; the Agent receiver refuses questions outside it. */
export const teachingHelpPolicySchema = z.object({
  version: z.literal(1),
  questions: z.enum(['allowed', 'disabled']),
  scope: z.enum(['course', 'general']),
  note: z.string().max(2000).optional(),
  /** Optional, machine-enforced teaching stage. Free text still cannot override this choice. */
  predictionGate: z.object({ formatVersion: z.literal(1),
    hideResultsBeforePrediction: z.boolean() }).strict().optional(),
}).strict();
export type TeachingHelpPolicy = z.infer<typeof teachingHelpPolicySchema>;

export function predictionResultsHidden(policy: TeachingHelpPolicy | null | undefined): boolean {
  return policy?.predictionGate?.hideResultsBeforePrediction === true;
}
