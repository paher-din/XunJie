import { z } from 'zod';

const id=z.string().min(1).max(128),hash=z.string().regex(/^[a-f0-9]{64}$/);
const natural=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const hdlHelpSelectionSchema=z.strictObject({snapshotId:id,buildId:id,sessionId:id.optional(),operationId:id.optional()})
  .refine(value=>!value.operationId||!!value.sessionId);
export type HdlHelpSelection=z.infer<typeof hdlHelpSelectionSchema>;
export const hdlHelpBasisSchema=z.strictObject({snapshotId:id,snapshotHash:hash,buildId:id,
  execution:z.strictObject({nodeId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),nodeGeneration:id}).optional(),
  buildResultHash:hash.optional(),
  workspaceRevision:natural.optional(),
  buildStatus:z.enum(['queued','running','succeeded','failed','cancelled','outcome_unknown']),
  sessionId:id.optional(),sessionRevision:natural.min(1).optional(),
  sessionStatus:z.enum(['starting','active','stopping','stopped','failed','outcome_unknown']).optional(),
  sessionGeneration:id.optional(),confirmedSequence:natural.optional(),simTimePs:z.string().regex(/^\d{1,32}$/).optional(),
  pendingOperationId:id.optional(),stopRequested:z.boolean().optional(),terminationConfirmed:z.boolean().optional(),
  operationId:id.optional(),resultHash:hash.optional()});
export type HdlHelpBasis=z.infer<typeof hdlHelpBasisSchema>;
