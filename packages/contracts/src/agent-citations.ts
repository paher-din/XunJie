import { z } from 'zod';

/** A source the model actually cited in this Turn. Owner details stay in the fixed source ref. */
export const agentCitationSchema = z.object({
  citationId: z.uuid(),
  claim: z.string().min(1).max(1000),
  label: z.string().min(1).max(300),
  materialId: z.string().min(1).max(200).optional(),
  source: z.record(z.string(), z.json()),
  range: z.record(z.string(), z.json()).nullable(),
  version: z.string().max(300).nullable(),
  digest: z.string().min(1).max(300),
}).strict();
export type AgentCitation = z.infer<typeof agentCitationSchema>;
