import { z } from 'zod';
import { spaceIdentitySchema } from './spaces.js';
import { storageOwnerSchema } from './storage.js';
import { modelReasoningEfforts } from './model-reasoning.js';
export { modelReasoningEfforts, resolveModelProfile, modelReasoningParameters, modelReasoningError } from './model-reasoning.js';
export type { ReasoningEffort, ReasoningRoute } from './model-reasoning.js';

const reasoningLevelsSchema = z.array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).max(7)
  .refine(levels => new Set(levels).size === levels.length, 'Duplicate reasoning level');

/** Model owner wire. SDK objects, credentials and native reasoning never enter public projections. */
export const modelProtocolSchema = z.enum(['chat-completions', 'responses', 'messages']);
const modelBaseUrlSchema = z.url().max(2000).regex(/^(?:https:\/\/[^\/?#@]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?)(?:\/[^?#]*)?$/);
/** Deterministic input errors only; reachability and provider support require a connection check. */
export function modelBaseUrlError(baseUrl: string, protocol: z.infer<typeof modelProtocolSchema>): string | undefined {
  if (!baseUrl.trim()) return '请填写 Base URL。';
  if (baseUrl.length > 2000) return 'Base URL 不能超过 2000 个字符。';
  if (!z.url().safeParse(baseUrl).success) return '请输入完整地址，例如 https://api.example.com/v1。';
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(baseUrl)?.[1];
  if (authority?.includes('@')) return '地址中不能包含账号或密码，请把密钥填入 API Key。';
  if (/[?#]/.test(baseUrl)) return 'Base URL 不能包含 ? 查询参数或 # 片段。';
  if (!baseUrl.startsWith('https://') && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(baseUrl))
    return '请使用 HTTPS 地址；只有本机 localhost、127.0.0.1 或 [::1] 可以使用 HTTP。';
  if (/\s/.test(baseUrl) || !modelBaseUrlSchema.safeParse(baseUrl).success) return '请输入不含空格的完整 Base URL。';
  const path = baseUrl.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '');
  const suffix = { 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' }[protocol];
  if (path.endsWith(suffix)) return `请去掉末尾 ${suffix}，系统会自动追加接口路径。`;
  if (protocol === 'messages' && path.endsWith('/v1')) return 'Anthropic 兼容地址不带末尾 /v1，系统会自动追加 /v1/messages。';
}
export const modelConfigurationSchema = z.object({
  connectionId: z.uuid(), name: z.string().trim().min(1).max(120), protocol: modelProtocolSchema,
  baseUrl: modelBaseUrlSchema,
  path: z.enum(['/chat/completions', '/responses', '/v1/messages']),
  modelId: z.string().trim().min(1).max(200), dialect: z.enum(['standard', 'deepseek', 'command-code']),
  parameterMode: z.enum(['plain', 'thinking']), enabled: z.boolean(),
  /** Learning calls use the values saved with the connection, never probe limits. */
  contextWindow: z.number().int().min(1).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  reasoningEffort: z.enum(modelReasoningEfforts).optional(),
  reasoningLevels: reasoningLevelsSchema.optional(),
  reasoningSource: z.enum(['catalogue', 'manual', 'profile', 'unknown']).optional(),
  /** Provider and model choices are independent; enabled is their effective conjunction. */
  providerId: z.uuid().optional(), providerEnabled: z.boolean().optional(), modelEnabled: z.boolean().optional(),
}).strict().refine(value => value.path === ({ 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' } as const)[value.protocol]);
export const modelCredentialChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(), z.object({ action: z.literal('clear') }).strict(),
  z.object({ action: z.literal('replace'), value: z.string().trim().min(1).max(8192) }).strict(),
]);
export const saveModelConnectionSchema = modelConfigurationSchema.safeExtend({ requestId: z.uuid(),
  expectedVersion: z.number().int().nonnegative(), credential: modelCredentialChangeSchema })
  .refine(value => !modelBaseUrlError(value.baseUrl, value.protocol), { path: ['baseUrl'], message: 'Invalid base URL for this protocol' });
export const readModelCredentialSchema = z.object({ version: z.number().int().positive() }).strict();
/** Explicit owner editor response; never included in connection lists, selections or attempt projections. */
export const modelCredentialValueSchema = z.object({ connectionId: z.uuid(), version: z.number().int().positive(), value: z.string().max(8192) }).strict();
export const capabilityStateSchema = z.enum(['unknown', 'declared', 'verified', 'unsupported']);
export const modelConnectionSchema = modelConfigurationSchema.safeExtend({ version: z.number().int().positive(), routeId: z.uuid(),
  hasCredential: z.boolean(), adapterState: z.enum(['ready', 'not-integrated']),
  capabilities: z.object({ text: capabilityStateSchema, images: capabilityStateSchema, tools: capabilityStateSchema,
    strictSchema: capabilityStateSchema, nativeReplay: capabilityStateSchema.optional(), jsonMode: capabilityStateSchema.optional(),
    applicationSchema: capabilityStateSchema.optional(), strictTools: capabilityStateSchema.optional(),
    serverStorage: capabilityStateSchema.optional(), serverQuery: capabilityStateSchema.optional(), serverCancel: capabilityStateSchema.optional() }).strict(),
  capabilityEvidence: z.object({ observedAt: z.iso.date(), sdk: z.string(), adapter: z.string(), endpoint: z.url(), modelId: z.string(),
    protocol: modelProtocolSchema, parameterMode: z.enum(['plain', 'thinking']), testedToolChoice: z.enum(['auto', 'named', 'not-tested']),
    toolImageStrategy: z.enum(['paired-text-adjacent-user-image', 'native-function-output-image', 'native-tool-result-image', 'not-applicable']), limitations: z.array(z.string()) }).strict().optional() });
export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;
export type ModelConnection = z.infer<typeof modelConnectionSchema>;
export type SaveModelConnection = z.infer<typeof saveModelConnectionSchema>;

export const modelProviderSchema = z.object({ providerId: z.uuid(), version: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(120), protocol: modelProtocolSchema, baseUrl: modelBaseUrlSchema,
  enabled: z.boolean(), hasCredential: z.boolean(), models: z.array(modelConnectionSchema).min(1).max(64) }).strict();
export const providerModelInputSchema = z.object({ connectionId: z.uuid(), expectedVersion: z.number().int().nonnegative(),
  modelId: z.string().trim().min(1).max(200), enabled: z.boolean(), reasoningEffort: z.enum(modelReasoningEfforts).optional(),
  reasoningLevels: reasoningLevelsSchema.optional(),
  contextWindow: z.number().int().min(1).max(10_000_000).optional(), maxOutputTokens: z.number().int().min(1).max(1_000_000).optional() }).strict();
export const saveModelProviderSchema = z.object({ requestId: z.uuid(), providerId: z.uuid(), expectedVersion: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(120), protocol: modelProtocolSchema, baseUrl: modelBaseUrlSchema, enabled: z.boolean(),
  credential: modelCredentialChangeSchema, models: z.array(providerModelInputSchema).min(1).max(64) }).strict()
  .refine(value => !modelBaseUrlError(value.baseUrl, value.protocol), { path: ['baseUrl'], message: 'Invalid base URL for this protocol' })
  .refine(value => new Set(value.models.map(model => model.connectionId)).size === value.models.length &&
    new Set(value.models.map(model => model.modelId)).size === value.models.length, { path: ['models'], message: 'Duplicate model' });
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type SaveModelProvider = z.infer<typeof saveModelProviderSchema>;
export const modelProfilesInputSchema = z.object({ baseUrl: modelBaseUrlSchema, protocol: modelProtocolSchema,
  modelIds: z.array(z.string().trim().min(1).max(200)).min(1).max(64), refresh: z.boolean().optional() }).strict();
export const modelProfileSchema = z.object({ modelId: z.string(), dialect: z.enum(['standard', 'deepseek', 'command-code']),
  efforts: z.array(z.enum(modelReasoningEfforts)), source: z.enum(['catalogue', 'manual', 'profile', 'unknown']),
  contextWindow: z.number().int().positive().optional(), maxOutputTokens: z.number().int().positive().optional() }).strict();
export const modelProfilesSchema = z.object({ profiles: z.array(modelProfileSchema), updatedAt: z.iso.datetime().optional(), stale: z.boolean() }).strict();
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const modelCheckPolicySchema = z.object({ checksAllowed: z.boolean(), maxChecksPerHour: z.number().int().min(1).max(60),
  maxOutputTokens: z.number().int().min(1).max(2048), timeoutMs: z.number().int().min(250).max(30000) }).strict();
export const schoolModelInputSchema = saveModelConnectionSchema.safeExtend({ policy: modelCheckPolicySchema });
export const schoolModelSchema = z.object({ kind: z.literal('school'), connection: modelConnectionSchema,
  policy: modelCheckPolicySchema }).strict();
export const personalModelChoiceSchema = z.object({ kind: z.literal('personal'), connection: modelConnectionSchema,
  policy: modelCheckPolicySchema, origin: z.enum(['self', 'device', 'grant']), grantId: z.uuid().optional() }).strict();
export const modelChoiceSchema = z.union([schoolModelSchema, personalModelChoiceSchema]);
export const modelSelectionSchema = z.object({ version: z.number().int().nonnegative(), selected: modelChoiceSchema.nullable(),
  options: z.array(modelChoiceSchema), unavailableReason: z.string().optional(), restoredInstallation: z.literal(true).optional() }).strict();
export const modelSelectionSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('school'), connectionId: z.uuid() }).strict(),
  z.object({ kind: z.literal('personal'), connectionId: z.uuid(), grantId: z.uuid() }).strict(),
]);
export const selectModelSchema = z.object({ requestId: z.uuid(), expectedVersion: z.number().int().nonnegative(), source: modelSelectionSourceSchema }).strict();
export const modelGrantInputSchema = z.object({ requestId: z.uuid(), grantId: z.uuid(), connectionId: z.uuid(), owner: z.enum(['self', 'device']) }).strict();
export const modelGrantSchema = z.object({ grantId: z.uuid(), connectionId: z.uuid(), owner: spaceIdentitySchema,
  recipient: spaceIdentitySchema, version: z.number().int().positive(), active: z.boolean() }).strict();
export const revokeModelGrantSchema = z.object({ requestId: z.uuid(), expectedVersion: z.number().int().positive() }).strict();
export type ModelCheckPolicy = z.infer<typeof modelCheckPolicySchema>;

export const modelCheckInputSchema = z.object({ attemptId: z.uuid(), purpose: z.literal('connection-check'),
  source: z.union([
    z.object({ school: z.object({ connectionId: z.uuid(), version: z.number().int().positive() }).strict() }).strict(),
    z.object({ selected: z.literal(true), selectionVersion: z.number().int().nonnegative(), pinId: z.uuid().optional() }).strict(),
    z.object({ connectionId: z.uuid(), version: z.number().int().positive() }).strict(),
    z.object({ draft: modelConfigurationSchema, credential: modelCredentialChangeSchema,
      savedCredential: z.object({ connectionId: z.uuid(), version: z.number().int().positive() }).strict().optional() }).strict(),
  ]), limits: z.object({ maxOutputTokens: z.number().int().min(1).max(128), timeoutMs: z.number().int().min(250).max(30000) }).strict(),
}).strict();
export const modelUsageSchema = z.object({ state: z.enum(['final', 'partial', 'unknown']),
  inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(), cachedTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional() }).strict();
export const modelUpstreamSchema = z.object({ httpStatus: z.number().int().min(100).max(599).optional(),
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/).optional(),
  retryAfterSeconds: z.number().nonnegative().max(31536000).optional(), retryAt: z.iso.datetime().optional() }).strict();
export const modelImageRefSchema = z.object({ imageId: z.uuid(), version: z.literal(1) }).strict();
export const modelImageInputSchema = z.object({ requestId: z.uuid(), imageId: z.uuid(), mediaType: z.literal('image/png'),
  dataBase64: z.string().min(1).max(350000), source: modelImageRefSchema.safeExtend({ transformation: z.string().min(1).max(200) }).optional() }).strict();
export const modelToolSchema = z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().max(1000),
  inputSchema: z.record(z.string(), z.unknown()), strict: z.boolean().optional(),
  /** Application-only static preview projection; never sent to the model provider. */
  progress: z.object({ kind: z.literal('json-string'), property: z.literal('html') }).strict().optional() }).strict();
export const modelToolProgressSchema = z.object({ callId: z.string().min(1).max(200), name: modelToolSchema.shape.name,
  property: z.literal('html'), text: z.string().max(200_000) }).strict();
export const modelProgressSchema = z.object({ text: z.string().max(1_000_000), revision: z.number().int().positive(),
  tools: z.array(modelToolProgressSchema).max(8).optional() }).strict();
export type ModelToolProgress = z.infer<typeof modelToolProgressSchema>;
export type ModelProgress = z.infer<typeof modelProgressSchema>;
export const modelToolIntentSchema = z.object({ callId: z.string().min(1).max(200), name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()) }).strict();
export const modelToolResultSchema = z.object({ callId: z.string().min(1).max(200), outcome: z.enum(['success', 'error', 'not-executed']),
  text: z.string().max(8192), images: z.array(modelImageRefSchema).max(2) }).strict();
export const settleModelToolsSchema = z.object({ requestId: z.uuid(), expectedSequence: z.number().int().nonnegative(),
  results: z.array(modelToolResultSchema).min(1).max(8) }).strict();
export const modelObservationSchema = z.object({ observationId: z.uuid(), version: z.number().int().positive(),
  source: z.literal('caller'), text: z.string().max(8192) }).strict();
export const modelChatOptionsSchema = z.object({
  toolChoice: z.union([z.enum(['auto', 'none']), z.object({ name: modelToolSchema.shape.name }).strict()]).optional(),
  responseFormat: z.union([z.object({ kind: z.literal('json-object') }).strict(), z.object({ kind: z.literal('json-schema'),
    name: modelToolSchema.shape.name, schema: z.record(z.string(), z.unknown()), strict: z.boolean() }).strict()]).optional(),
  applicationSchema: z.record(z.string(), z.unknown()).optional(),
  requiredCapabilities: z.array(z.enum(['text', 'images', 'tools', 'nativeReplay', 'jsonMode', 'applicationSchema', 'nativeStrict', 'strictTools'])).max(8).optional(),
  capabilityProbe: z.boolean().optional(),
}).strict();
/** Read-only request: credentials/drafts are deliberately excluded. */
export const modelCapabilityInputSchema = z.object({
  source: z.union([
    z.object({ school: z.object({ connectionId: z.uuid(), version: z.number().int().positive() }).strict() }).strict(),
    z.object({ selected: z.literal(true), selectionVersion: z.number().int().nonnegative(), pinId: z.uuid().optional() }).strict(),
    z.object({ connectionId: z.uuid(), version: z.number().int().positive() }).strict(),
  ]),
  prefix: z.object({ system: z.string().max(8192), tools: z.array(modelToolSchema).max(8), options: modelChatOptionsSchema.optional() }).strict(),
}).strict();
export const modelCapabilityRequirementSchema = z.enum([
  'text', 'images', 'tools', 'nativeReplay', 'jsonMode', 'applicationSchema', 'nativeStrict', 'strictTools', 'forcedTool',
]);
export const modelCapabilityItemSchema = z.object({
  capability: modelCapabilityRequirementSchema, status: z.enum(['available', 'unknown', 'unsupported']),
  evidence: z.object({ state: capabilityStateSchema,
    source: z.enum(['measured-route', 'unmeasured-route', 'application-validator', 'adapter-constraint']) }).strict(),
}).strict();
/** Only fixed route identity and reviewed capability facts, never endpoint, scopes or credential references. */
export const modelCapabilityDecisionSchema = z.object({
  connectionId: z.uuid(), routeId: z.uuid(), configurationVersion: z.number().int().positive(),
  protocol: modelProtocolSchema, parameterMode: z.enum(['plain', 'thinking']),
  required: z.array(modelCapabilityRequirementSchema), items: z.array(modelCapabilityItemSchema),
  available: z.boolean(), missing: z.array(modelCapabilityItemSchema), limitations: z.array(z.string()),
  evidence: z.object({ observedAt: z.iso.date(), sdk: z.string(), adapter: z.string(),
    testedToolChoice: z.enum(['auto', 'named', 'not-tested']) }).strict().optional(),
  assembly: z.object({
    toolImages: z.enum(['paired-text-adjacent-user-image', 'native-function-output-image', 'native-tool-result-image']),
    replay: z.literal('full-native-history'),
    output: z.enum(['text', 'native-json-object', 'native-json-schema']), applicationValidation: z.boolean(),
  }).strict(),
}).strict();
export const modelCapabilityFailureSchema = z.object({ error: z.literal('capability-unavailable'), decision: modelCapabilityDecisionSchema }).strict();
export type ModelCapabilityInput = z.infer<typeof modelCapabilityInputSchema>;
export type ModelCapabilityDecision = z.infer<typeof modelCapabilityDecisionSchema>;
export type ModelCapabilityRequirement = z.infer<typeof modelCapabilityRequirementSchema>;
export const modelSegmentPurposeSchema = z.enum(['chat-probe', 'learning']);
export const modelSegmentInputSchema = z.object({ requestId: z.uuid(), segmentId: z.uuid(), source: modelCheckInputSchema.shape.source,
  purpose: modelSegmentPurposeSchema.optional(),
  prefix: z.object({ system: z.string().max(400_000), tools: z.array(modelToolSchema).max(64), options: modelChatOptionsSchema.optional() }).strict(),
  portable: z.array(z.object({ text: z.string().max(400_000), role: z.enum(['user', 'assistant']).optional(),
    resultRef: z.uuid().optional() }).strict()).max(512),
  previousSegmentId: z.uuid().optional() }).strict();
export const modelSegmentCloseSchema = z.object({ requestId: z.uuid(), expectedSequence: z.number().int().nonnegative() }).strict();
export const modelPortableResultSchema = z.object({ owner: storageOwnerSchema, attemptId: z.uuid(), resultRef: z.uuid(), routeId: z.uuid(),
  configurationVersion: z.number().int().positive(), text: z.string(), visibleTextSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const modelSegmentBoundarySchema = z.object({ owner: storageOwnerSchema, segmentId: z.uuid(), sequence: z.number().int().nonnegative(),
  routeId: z.uuid(), resultRef: z.uuid().nullable() }).strict();
export const modelSegmentProvenanceSchema = z.object({ boundary: modelSegmentBoundarySchema.extend({ destination: z.enum(['local', 'school']) }).optional(),
  results: z.array(modelPortableResultSchema.omit({ text: true }).extend({ destination: z.enum(['local', 'school']) })).max(8) }).strict();
export const modelChatInputSchema = z.object({ attemptId: z.uuid(), purpose: z.literal('chat-probe'), segmentId: z.uuid(),
  expectedSequence: z.number().int().min(0).max(32), input: z.object({ text: z.string().max(8192), images: z.array(modelImageRefSchema).max(2),
    toolResults: z.array(modelToolResultSchema).max(8), observations: z.array(modelObservationSchema).max(8).default([]) }).strict(),
  limits: z.object({ maxOutputTokens: z.number().int().min(1).max(2048), timeoutMs: z.number().int().min(250).max(30000) }).strict() }).strict();
/** Learning calls are not probes: no probe count, sequence, output or time caps apply. */
export const modelLearningInputSchema = z.object({ attemptId: z.uuid(), purpose: z.literal('learning'), segmentId: z.uuid(),
  expectedSequence: z.number().int().nonnegative(), input: z.object({ text: z.string().max(1_000_000), images: z.array(modelImageRefSchema).max(8).default([]),
    toolResults: z.array(modelToolResultSchema).max(64).default([]), observations: z.array(modelObservationSchema).max(512).default([]) }).strict(),
  limits: z.object({ maxOutputTokens: z.number().int().min(1).max(1_000_000),
    timeoutMs: z.number().int().min(250).max(2_147_483_647).optional() }).strict() }).strict();
export const modelAttemptInputSchema = z.union([modelCheckInputSchema, modelChatInputSchema, modelLearningInputSchema]);
export const modelAttemptSchema = z.object({ attemptId: z.uuid(), purpose: z.enum(['connection-check', 'chat-probe', 'learning']),
  source: z.object({ kind: z.enum(['school', 'personal']), ownerScope: z.string().min(1).max(500),
    feeSource: z.string().min(1).max(500), grantId: z.uuid().optional(), grantVersion: z.number().int().positive().optional() }).strict().optional(),
  connection: modelConnectionSchema, limits: modelLearningInputSchema.shape.limits,
  segment: z.object({ segmentId: z.uuid(), sequence: z.number().int().nonnegative() }).strict().optional(),
  toolIntents: z.array(modelToolIntentSchema).max(8).optional(),
  state: z.enum(['accepted', 'dispatched', 'completed', 'incomplete', 'failed', 'cancelled', 'unknown']),
  dispatched: z.boolean(), cancelRequested: z.boolean(), physicalRequestEnded: z.boolean(),
  upstreamStopped: z.literal('unknown'), text: z.string(), usage: modelUsageSchema,
  upstream: modelUpstreamSchema.optional(),
  reason: z.string().max(100), requestRef: z.uuid(), resultRef: z.uuid().nullable(), createdAt: z.string(),
}).strict();
export type ModelCheckInput = z.infer<typeof modelCheckInputSchema>;
export type ModelAttempt = z.infer<typeof modelAttemptSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;
export type ModelUpstream = z.infer<typeof modelUpstreamSchema>;
export type ModelChatInput = z.infer<typeof modelChatInputSchema>;
export type ModelLearningInput = z.infer<typeof modelLearningInputSchema>;
export type ModelSegmentPurpose = z.infer<typeof modelSegmentPurposeSchema>;
export type ModelAttemptInput = z.infer<typeof modelAttemptInputSchema>;
export type ModelTool = z.infer<typeof modelToolSchema>;
export type ModelToolIntent = z.infer<typeof modelToolIntentSchema>;
export type ModelToolResult = z.infer<typeof modelToolResultSchema>;
export type ModelImageRef = z.infer<typeof modelImageRefSchema>;
