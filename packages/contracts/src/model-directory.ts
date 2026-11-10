import { z } from 'zod';
import { modelReasoningEfforts } from './model-reasoning.js';

export const modelPresetIdSchema = z.enum(['custom', 'deepseek', 'opencode-go', 'command-code', 'zhipu', 'kimi', 'mimo']);
const protocol = z.enum(['chat-completions', 'responses', 'messages']);
const credential = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(), z.object({ action: z.literal('clear') }).strict(),
  z.object({ action: z.literal('replace'), value: z.string().trim().min(1).max(8192) }).strict(),
]);
export const modelDirectoryInputSchema = z.object({
  presetId: modelPresetIdSchema.optional(), variantId: z.string().min(1).max(80).optional(),
  baseUrl: z.url().max(2000).optional(), protocol: protocol.optional(), credential: credential.optional(),
  savedCredential: z.object({ connectionId: z.uuid(), version: z.number().int().positive() }).strict().optional(),
  /** Automatic refresh observes the ten-minute cooldown; explicit manual refresh may bypass it. */
  refresh: z.boolean().optional(), manual: z.boolean().optional(),
}).strict();
export const modelDirectoryRefreshSchema = z.object({
  status: z.enum(['idle', 'refreshing', 'ready', 'cooldown', 'failed', 'needs-credential']),
  lastAttemptAt: z.iso.datetime().optional(), updatedAt: z.iso.datetime().optional(),
  nextRefreshAt: z.iso.datetime().optional(), retryAt: z.iso.datetime().optional(),
  error: z.enum(['offline', 'unauthorized', 'rate-limited', 'unavailable', 'invalid-response']).optional(),
}).strict();
export const modelDirectoryEntrySchema = z.object({
  modelId: z.string().trim().min(1).max(200), name: z.string().max(200).optional(),
  protocol: protocol.optional(), protocols: z.array(protocol).max(3).optional(), baseUrl: z.url().max(2000).optional(),
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
  efforts: z.array(z.enum(modelReasoningEfforts)).max(9).optional(),
  defaultEffort: z.enum(modelReasoningEfforts).optional(), reasoningKind: z.enum(['effort', 'toggle', 'none']).optional(),
}).strict();
export const modelDirectorySchema = z.object({
  models: z.array(modelDirectoryEntrySchema).max(10000), catalogue: modelDirectoryRefreshSchema,
  supplier: modelDirectoryRefreshSchema.optional(),
}).strict();
export type ModelPresetId = z.infer<typeof modelPresetIdSchema>;
export type ModelDirectoryInput = z.infer<typeof modelDirectoryInputSchema>;
export type ModelDirectoryRefresh = z.infer<typeof modelDirectoryRefreshSchema>;
export type ModelDirectoryEntry = z.infer<typeof modelDirectoryEntrySchema>;
export type ModelDirectory = z.infer<typeof modelDirectorySchema>;
