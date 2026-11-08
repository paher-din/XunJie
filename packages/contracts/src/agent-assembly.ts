import { z } from 'zod';
import { modelToolSchema } from './model-connections.js';
import { teachingSkillStateSchema } from './agent-skills.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const agentDefinitionSchema = z.object({
  definitionId: z.string().min(1).max(200), version: z.number().int().positive(),
  purpose: z.string().min(1),
  prompt: z.object({ platform: z.string(), runtime: z.string() }).strict(),
  capabilities: z.array(z.object({ sourceId: z.string(), required: z.boolean() }).strict()),
  contextPolicy: z.object({ version: z.number().int().positive(), maxSystemChars: z.number().int().positive(),
    maxInputChars: z.number().int().positive() }).strict(),
  outputContract: z.object({ kind: z.literal('text'), instructions: z.string() }).strict(),
  budgetPolicy: z.object({ version: z.number().int().positive(), retryLimit: z.number().int().nonnegative() }).strict(),
}).strict();
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export const agentToolBindingSchema = z.object({
  bindingId: digest, modelName: z.string(), definition: modelToolSchema,
  purpose: z.string().optional(), resultSchema: z.record(z.string(), z.unknown()).optional(),
  source: z.object({ kind: z.enum(['platform', 'course']), sourceId: z.string(), version: z.string(),
    contentDigest: digest, releaseId: z.uuid().optional(), componentKey: z.string().optional() }).strict(),
  executor: z.object({ executorId: z.string(), toolName: z.string(), version: z.string() }).strict(),
  effect: z.enum(['read', 'execute', 'input', 'stop', 'ask']),
  resourceScope: z.record(z.string(), z.unknown()),
}).strict();
export type AgentToolBinding = z.infer<typeof agentToolBindingSchema>;

export const resolvedAgentSchema = z.object({
  version: z.literal(1), resolvedId: z.uuid(), definition: agentDefinitionSchema, definitionDigest: digest,
  mode: z.enum(['self-study', 'course-tutoring']),
  scope: z.object({ environmentId: z.uuid(), spaceId: z.uuid(), principalId: z.uuid(), activityId: z.uuid(),
    releaseId: z.uuid().optional(), courseDigest: z.string().optional(), helpPolicy: z.unknown().optional() }).strict(),
  model: z.record(z.string(), z.unknown()),
  prompt: z.object({ system: z.string(), layers: z.array(z.object({
    kind: z.enum(['platform', 'output-contract', 'runtime', 'course-rules']), content: z.string(),
  }).strict()) }).strict(),
  tools: z.array(agentToolBindingSchema),
  skills: teachingSkillStateSchema.optional(),
  unavailable: z.array(z.object({ sourceId: z.string(), required: z.boolean(), reason: z.string() }).strict()),
}).strict();
export type ResolvedAgent = z.infer<typeof resolvedAgentSchema>;

export const contextManifestSchema = z.object({
  version: z.literal(1), manifestId: z.uuid(), resolvedId: z.uuid(), payloadSha256: digest,
  items: z.array(z.object({ kind: z.enum(['rule', 'input', 'history', 'material', 'work', 'effect', 'wait', 'observation', 'tool-schema', 'native']),
    owner: z.string(), id: z.string(), version: z.string(), required: z.boolean(),
    selection: z.record(z.string(), z.unknown()), content: z.unknown(), contentDigest: digest,
    disposition: z.enum(['included', 'omitted', 'missing']), reason: z.string().optional() }).strict()),
  capacity: z.object({ counting: z.enum(['reliable', 'estimated', 'unknown']), payloadBytes: z.number().int().nonnegative(),
    outputReserve: z.number().int().positive(), toolSchemaBytes: z.number().int().nonnegative(),
    imageCount: z.number().int().nonnegative(), nativeOverhead: z.literal('included-in-payload'),
    contextWindow: z.number().int().positive().optional(), inputTokens: z.number().int().nonnegative().optional(),
    reason: z.string() }).strict(),
}).strict();
export type ContextManifest = z.infer<typeof contextManifestSchema>;
