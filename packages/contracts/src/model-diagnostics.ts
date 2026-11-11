import { z } from 'zod';

/** Credential-free facts shared by generation checks and lightweight supplier reads. */
export const modelDiagnosticFactsSchema = z.object({
  httpStatus: z.number().int().min(100).max(599).optional(),
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/).optional(),
  retryAfterSeconds: z.number().nonnegative().max(31536000).optional(), retryAt: z.iso.datetime().optional(),
  errorCode: z.string().max(100).optional(), parameter: z.string().max(100).optional(),
  message: z.string().max(1000).optional(), networkCode: z.string().max(80).optional(),
}).strict();
export const modelDiagnosticSchema = z.object({
  code: z.string().min(1).max(100), message: z.string().min(1).max(1000),
  suggestion: z.string().max(1000), field: z.enum(['baseUrl', 'apiKey', 'modelId', 'reasoningEffort',
    'reasoningLevels', 'contextWindow', 'maxOutputTokens', 'imageInput']).optional(),
}).strict();
export type ModelDiagnostic = z.infer<typeof modelDiagnosticSchema>;
