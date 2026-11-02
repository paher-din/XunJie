import { z } from 'zod';

/** Model owner wire. SDK objects, credentials and native reasoning never enter public projections. */
export const modelProtocolSchema = z.enum(['chat-completions', 'responses', 'messages']);
export const modelConfigurationSchema = z.object({
  connectionId: z.uuid(), name: z.string().trim().min(1).max(120), protocol: modelProtocolSchema,
  baseUrl: z.url().max(2000).regex(/^(?:https:\/\/[^\/?#@]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?)(?:\/[^?#]*)?$/),
  path: z.enum(['/chat/completions', '/responses', '/v1/messages']),
  modelId: z.string().trim().min(1).max(200), dialect: z.enum(['standard', 'deepseek', 'command-code']),
  parameterMode: z.enum(['plain', 'thinking']), enabled: z.boolean(),
}).strict().refine(value => value.path === ({ 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' } as const)[value.protocol]);
export const modelCredentialChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(), z.object({ action: z.literal('clear') }).strict(),
  z.object({ action: z.literal('replace'), value: z.string().trim().min(1).max(8192) }).strict(),
]);
export const saveModelConnectionSchema = modelConfigurationSchema.safeExtend({ requestId: z.uuid(),
  expectedVersion: z.number().int().nonnegative(), credential: modelCredentialChangeSchema });
export const capabilityStateSchema = z.enum(['unknown', 'declared', 'verified', 'unsupported']);
export const modelConnectionSchema = modelConfigurationSchema.safeExtend({ version: z.number().int().positive(), routeId: z.uuid(),
  hasCredential: z.boolean(), adapterState: z.enum(['ready', 'not-integrated']),
  capabilities: z.object({ text: capabilityStateSchema, images: capabilityStateSchema, tools: capabilityStateSchema,
    strictSchema: capabilityStateSchema }).strict() });
export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;
export type ModelConnection = z.infer<typeof modelConnectionSchema>;
export type SaveModelConnection = z.infer<typeof saveModelConnectionSchema>;

export const modelCheckInputSchema = z.object({ attemptId: z.uuid(), purpose: z.literal('connection-check'),
  source: z.union([
    z.object({ connectionId: z.uuid(), version: z.number().int().positive() }).strict(),
    z.object({ draft: modelConfigurationSchema, credential: modelCredentialChangeSchema,
      savedCredential: z.object({ connectionId: z.uuid(), version: z.number().int().positive() }).strict().optional() }).strict(),
  ]), limits: z.object({ maxOutputTokens: z.number().int().min(1).max(128), timeoutMs: z.number().int().min(250).max(30000) }).strict(),
}).strict();
export const modelUsageSchema = z.object({ state: z.enum(['final', 'partial', 'unknown']),
  inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(), cachedTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional() }).strict();
export const modelAttemptSchema = z.object({ attemptId: z.uuid(), purpose: z.literal('connection-check'),
  connection: modelConnectionSchema, limits: modelCheckInputSchema.shape.limits,
  state: z.enum(['accepted', 'dispatched', 'completed', 'incomplete', 'failed', 'cancelled', 'unknown']),
  dispatched: z.boolean(), cancelRequested: z.boolean(), physicalRequestEnded: z.boolean(),
  upstreamStopped: z.literal('unknown'), text: z.string(), usage: modelUsageSchema,
  reason: z.string().max(100), requestRef: z.uuid(), resultRef: z.uuid().nullable(), createdAt: z.string(),
}).strict();
export type ModelCheckInput = z.infer<typeof modelCheckInputSchema>;
export type ModelAttempt = z.infer<typeof modelAttemptSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;
