import { z } from 'zod';
import { resolvedAgentSchema, contextManifestSchema } from './agent-assembly.js';
export { agentDefinitionSchema, agentToolBindingSchema, resolvedAgentSchema, contextManifestSchema } from './agent-assembly.js';
export type { AgentDefinition, AgentToolBinding, ResolvedAgent, ContextManifest } from './agent-assembly.js';
import { modelUsageSchema, modelToolResultSchema } from './model-connections.js';
import { teachingHelpPolicySchema } from './course-help.js';
import { runtimeServiceSchema } from './product-runtime.js';
import { spaceIdentitySchema } from './spaces.js';
import { teachingStudentQuestionSchema } from './student-questions.js';
import { teachingInputSchema, teachingContinueSelectionSchema } from './teaching-input-control.js';
import { teachingSkillLoadedSchema } from './agent-skills.js';

export * from './student-questions.js';
export * from './teaching-inputs.js';
export * from './teaching-input-control.js';

export { teachingHelpPolicySchema } from './course-help.js';

export const teachingRunStateSchema = z.enum([
  'received', 'running', 'dispatching', 'waiting', 'completed', 'failed', 'stopped', 'paused',
]);

export const teachingModelFactSchema = z.object({
  connectionId: z.uuid(), version: z.number().int().positive(),
  protocol: z.enum(['chat-completions', 'responses', 'messages']),
  modelId: z.string().min(1).max(200),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict();

export const teachingRunSchema = z.object({
  runId: z.uuid(), activityId: z.uuid(), requestId: z.uuid(), inputId: z.uuid(),
  state: teachingRunStateSchema, reason: z.string().max(200),
  stopRequested: z.boolean(), previousRunId: z.uuid().nullable(),
  attemptId: z.uuid().nullable(), segmentId: z.uuid().nullable(),
  initialResolvedAgentId: z.uuid().nullable().optional(),
  model: teachingModelFactSchema.nullable(),
  usage: modelUsageSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
}).strict();
export type TeachingRun = z.infer<typeof teachingRunSchema>;

/** A pause can wait for configuration or original-identity verification without ending its Run budget. */
export function isRecoverableTeachingPause(run: { state: string; reason: string; completedAt: string | null }) {
  return run.state === 'paused' && run.completedAt === null && ['model-not-selected', 'model-unavailable',
    'max-output-missing', 'resource-busy', 'segment-busy', 'result-unknown', 'native-result-unavailable'].includes(run.reason);
}
export const teachingModelSwitchStateSchema = z.enum(['accepted', 'completed', 'paused']);
export const teachingModelSwitchSchema = z.object({
  requestId: z.uuid(), activityId: z.uuid(), selectionVersion: z.number().int().nonnegative(),
  state: teachingModelSwitchStateSchema, reason: z.string().max(200),
  fromSegmentId: z.uuid().nullable(), toSegmentId: z.uuid(),
  model: teachingModelFactSchema,
  source: z.object({ kind: z.enum(['school', 'personal']), feeSource: z.string().min(1).max(500) }).strict(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type TeachingModelSwitch = z.infer<typeof teachingModelSwitchSchema>;

export const teachingEventKindSchema = z.enum([
  'input', 'run-received', 'run-started', 'context-assembled', 'attempt-dispatched', 'assistant-progress', 'assistant',
  'run-completed', 'run-failed', 'run-stopped', 'stop-requested', 'run-continued', 'run-resumed',
  'model-unavailable', 'capacity-paused', 'system-notice',
  'step-completed', 'tool-intent', 'tool-permitted', 'tool-result', 'tools-paired',
  'wait-created', 'wait-consumed', 'wait-expired', 'wait-observed', 'budget-reserved', 'budget-settled',
  'native-summary',
  'question-created', 'question-presented', 'student-response', 'question-expired', 'question-cancelled',
  'input-adopted', 'input-revised', 'input-removed', 'input-promoted', 'inputs-paused', 'question-superseded',
  'model-switch-requested', 'model-switch-completed', 'model-switch-paused',
  'context-compaction-selected', 'context-compaction-generated', 'context-compacted', 'context-compaction-rejected',
  'model-capacity-rejected',
  'extension',
]);

export type TeachingEventKind = z.infer<typeof teachingEventKindSchema>;

/** Optional extension payloads are kept verbatim; they cannot declare required execution semantics. */
export const teachingIgnorableExtensionSchema = z.object({
  ignorable: z.literal(true), extensionId: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
  extensionVersion: z.number().int().positive(), payload: z.unknown(),
}).passthrough();

export const teachingEventSchema = z.object({
  activityId: z.uuid(), seq: z.number().int().nonnegative(), eventId: z.uuid(),
  kind: teachingEventKindSchema, version: z.literal(1),
  body: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime(),
}).strict().superRefine((event, context) => {
  if (event.kind === 'extension' && !teachingIgnorableExtensionSchema.safeParse(event.body).success)
    context.addIssue({ code: 'custom', path: ['body'], message: 'Unsupported required extension event' });
});
export type TeachingEvent = z.infer<typeof teachingEventSchema>;

export const teachingMessageSchema = z.object({
  eventId: z.uuid(), seq: z.number().int().nonnegative(),
  role: z.enum(['student', 'assistant', 'system']),
  text: z.string(), runId: z.uuid().nullable(),
  inputId: z.uuid().optional(),
  state: z.enum(['streaming', 'settled', 'stopped', 'failed', 'unknown']).optional(),
  kind: z.enum(['native-summary', 'student-response']).optional(),
  summaryTruncated: z.boolean().optional(),
  model: teachingModelFactSchema.optional(),
  modelSource: z.enum(['school', 'personal']).optional(),
  skillSource: teachingSkillLoadedSchema.optional(),
  createdAt: z.iso.datetime(),
}).strict();
export type TeachingMessage = z.infer<typeof teachingMessageSchema>;

export const teachingToolRecordSchema = z.object({
  commandId: z.uuid(), runId: z.uuid(), stepId: z.uuid(), snapshotId: z.uuid(),
  callId: z.string(), name: z.string(), version: z.literal(1),
  state: z.enum(['prepared', 'dispatching', 'waiting', 'settled']),
  effect: z.enum(['read', 'execute', 'input', 'stop', 'ask']),
  location: z.enum(['owner', 'browser', 'native', 'remote']),
  arguments: z.record(z.string(), z.unknown()), basis: z.record(z.string(), z.unknown()),
  outcome: z.enum(['not-dispatched', 'accepted', 'completed', 'failed', 'unknown']).nullable(),
  feedback: z.string(), result: z.record(z.string(), z.unknown()).nullable(),
  source: z.object({ label: z.string(), componentKey: z.string().optional(),
    requestId: z.uuid().optional(), contentId: z.uuid().optional() }).strict().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type TeachingToolRecord = z.infer<typeof teachingToolRecordSchema>;

export const teachingWaitSchema = z.object({
  waitId: z.uuid(), runId: z.uuid(), stepId: z.uuid(), commandId: z.uuid(),
  state: z.enum(['pending', 'consumed', 'expired']),
  reason: z.enum(['execution', 'browser', 'unknown', 'cleanup', 'student']),
  version: z.number().int().positive().default(1),
  deadline: z.iso.datetime(), nextCheckAt: z.iso.datetime(), consumedAt: z.iso.datetime().nullable(),
}).strict();
export type TeachingWait = z.infer<typeof teachingWaitSchema>;

export const teachingConversationSchema = z.object({
  activityId: z.uuid(), cursor: z.number().int().nonnegative(),
  messages: z.array(teachingMessageSchema), runs: z.array(teachingRunSchema),
  tools: z.array(teachingToolRecordSchema).default([]), waits: z.array(teachingWaitSchema).default([]),
  questions: z.array(teachingStudentQuestionSchema).default([]),
  inputs: z.array(teachingInputSchema).default([]),
}).strict();
export type TeachingConversation = z.infer<typeof teachingConversationSchema>;

export const teachingSnapshotSchema = z.object({
  snapshotId: z.uuid(), activityId: z.uuid(), runId: z.uuid(), attemptId: z.uuid(), segmentId: z.uuid(),
  assemblyVersion: z.union([z.literal(1), z.literal(2)]), model: teachingModelFactSchema,
  maxOutputTokens: z.number().int().positive(), contextWindow: z.number().int().positive().optional(),
  sources: z.array(z.object({ kind: z.enum(['platform', 'run', 'course', 'input', 'history', 'material', 'student-response']),
    id: z.string().max(200).optional(), label: z.string().max(200) }).strict()),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.record(z.string(), z.unknown()),
  resolvedAgent: resolvedAgentSchema.optional(), contextManifest: contextManifestSchema.optional(),
  createdAt: z.iso.datetime(),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.assemblyVersion === 2 && (!snapshot.resolvedAgent || !snapshot.contextManifest))
    ctx.addIssue({ code: 'custom', message: 'Version 2 requires the fixed agent and context manifest.' });
});
export type TeachingSnapshot = z.infer<typeof teachingSnapshotSchema>;

export const teachingStopInputSchema = z.object({ requestId: z.uuid() }).strict();
export const teachingContinueInputSchema = z.union([z.object({ requestId: z.uuid() }).strict(), teachingContinueSelectionSchema]);
export const teachingModelSwitchInputSchema = z.object({
  requestId: z.uuid(), selectionVersion: z.number().int().nonnegative(),
}).strict();

export const teachingAgentCapabilitiesSchema = z.object({
  receiver: z.object({ receiverId: z.string(), location: z.literal('remote'), kind: z.literal('question') }).strict(),
  modelAvailable: z.boolean(), modelUnavailableReason: z.string().max(200).optional(),
}).strict();

export function teachingAgentReceiverId(ownerServiceId: string) {
  return `teaching-agent:${ownerServiceId}`;
}

/** Maintainer-owned routing facts. Connection secrets never enter this descriptor. */
export const teachingAgentBindingSchema = z.object({
  version: z.literal(1), connectionId: z.uuid(),
  target: runtimeServiceSchema.refine(service => service.unit === 'teaching-agent'),
  installationId: z.uuid(),
}).strict();
export type TeachingAgentBinding = z.infer<typeof teachingAgentBindingSchema>;
export const teachingAgentBindingInputSchema = teachingAgentBindingSchema.omit({ version: true }).extend({
  requestId: z.uuid(), identity: spaceIdentitySchema,
}).strict();
export const teachingAgentOperationSchema = z.enum(['accept', 'query', 'cancel', 'conversation', 'events', 'switchModel',
  'capabilities', 'run', 'stop', 'continueRun', 'request', 'snapshot', 'assertCommandDispatch', 'assertModelDispatch',
  'respond', 'response', 'presentQuestion', 'controlInput', 'inputControlReceipt',
  'skills.list', 'skills.import', 'skills.select', 'skills.disable', 'skills.read']);
export const teachingAgentCallSchema = z.object({ version: z.literal(1), operation: teachingAgentOperationSchema,
  identity: spaceIdentitySchema, activityId: z.uuid().optional(), args: z.array(z.unknown()).max(4) }).strict()
  .refine(call => call.activityId !== undefined || call.operation.startsWith('skills.'), 'activity is required for conversation operations');

export const teachingPreparedToolSchema = z.object({ version: z.literal(1), commandId: z.uuid(), name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()), effect: z.enum(['read', 'execute', 'input', 'stop', 'ask']), conflictKey: z.string().min(1),
  location: z.enum(['owner', 'browser', 'native', 'remote']), basis: z.record(z.string(), z.unknown()) }).strict();
export const teachingToolOutcomeSchema = z.object({ state: z.enum(['not-dispatched', 'accepted', 'completed', 'failed', 'unknown']),
  feedback: modelToolResultSchema.omit({ callId: true }), result: z.record(z.string(), z.unknown()),
  source: z.object({ label: z.string(), componentKey: z.string().optional(), requestId: z.uuid().optional(), contentId: z.uuid().optional() }).strict(),
  execution: z.object({ requestId: z.uuid(), executionRef: z.string(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict();
export const teachingDispatchAuthoritySchema = z.object({ runId: z.uuid(), activityId: z.uuid(),
  driverId: z.string().min(1).max(1000), generation: z.number().int().positive() }).strict();
export const teachingDependencyCallSchema = z.object({ version: z.literal(1),
  operation: z.enum(['authorize', 'identityFor', 'activity', 'model', 'tool.definitions', 'tool.contributions', 'tool.prepare', 'tool.dispatch', 'tool.reconcile', 'tool.stop']),
  identity: spaceIdentitySchema.optional(),
  activityId: z.uuid().optional(),
  scope: z.object({ environmentId: z.uuid(), spaceId: z.uuid(), principalId: z.uuid() }).strict().optional(),
  authority: teachingDispatchAuthoritySchema.optional(), args: z.array(z.unknown()).max(4) }).strict();
