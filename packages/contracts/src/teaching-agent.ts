import { z } from 'zod';
import { modelUsageSchema, modelToolResultSchema } from './model-connections.js';
import { teachingHelpPolicySchema } from './course-help.js';
import { runtimeServiceSchema } from './product-runtime.js';
import { spaceIdentitySchema } from './spaces.js';
import { teachingStudentQuestionSchema } from './student-questions.js';

export * from './student-questions.js';

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
  model: teachingModelFactSchema.nullable(),
  usage: modelUsageSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
}).strict();
export type TeachingRun = z.infer<typeof teachingRunSchema>;

export const teachingEventKindSchema = z.enum([
  'input', 'run-received', 'run-started', 'context-assembled', 'attempt-dispatched', 'assistant-progress', 'assistant',
  'run-completed', 'run-failed', 'run-stopped', 'stop-requested', 'run-continued',
  'model-unavailable', 'capacity-paused', 'system-notice',
  'step-completed', 'tool-intent', 'tool-permitted', 'tool-result', 'tools-paired',
  'wait-created', 'wait-consumed', 'wait-expired', 'budget-reserved', 'budget-settled',
  'native-summary',
  'question-created', 'question-presented', 'student-response', 'question-expired', 'question-cancelled',
]);

export type TeachingEventKind = z.infer<typeof teachingEventKindSchema>;

export const teachingEventSchema = z.object({
  activityId: z.uuid(), seq: z.number().int().nonnegative(), eventId: z.uuid(),
  kind: teachingEventKindSchema, version: z.literal(1),
  body: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime(),
}).strict();
export type TeachingEvent = z.infer<typeof teachingEventSchema>;

export const teachingMessageSchema = z.object({
  eventId: z.uuid(), seq: z.number().int().nonnegative(),
  role: z.enum(['student', 'assistant', 'system']),
  text: z.string(), runId: z.uuid().nullable(),
  state: z.enum(['streaming', 'settled', 'stopped', 'failed', 'unknown']).optional(),
  kind: z.enum(['native-summary', 'student-response']).optional(),
  summaryTruncated: z.boolean().optional(),
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
}).strict();
export type TeachingConversation = z.infer<typeof teachingConversationSchema>;

export const teachingSnapshotSchema = z.object({
  snapshotId: z.uuid(), activityId: z.uuid(), runId: z.uuid(), attemptId: z.uuid(), segmentId: z.uuid(),
  assemblyVersion: z.literal(1), model: teachingModelFactSchema,
  maxOutputTokens: z.number().int().positive(), contextWindow: z.number().int().positive().optional(),
  sources: z.array(z.object({ kind: z.enum(['platform', 'run', 'course', 'input', 'history', 'material', 'student-response']),
    id: z.string().max(200).optional(), label: z.string().max(200) }).strict()),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
}).strict();
export type TeachingSnapshot = z.infer<typeof teachingSnapshotSchema>;

export const teachingStopInputSchema = z.object({ requestId: z.uuid() }).strict();
export const teachingContinueInputSchema = z.object({ requestId: z.uuid() }).strict();

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
export const teachingAgentOperationSchema = z.enum(['accept', 'query', 'cancel', 'conversation', 'events',
  'capabilities', 'run', 'stop', 'continueRun', 'request', 'snapshot', 'assertCommandDispatch', 'assertModelDispatch',
  'respond', 'response', 'presentQuestion']);
export const teachingAgentCallSchema = z.object({ version: z.literal(1), operation: teachingAgentOperationSchema,
  identity: spaceIdentitySchema, activityId: z.uuid(), args: z.array(z.unknown()).max(4) }).strict();

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
  operation: z.enum(['authorize', 'identityFor', 'activity', 'model', 'tool.definitions', 'tool.prepare', 'tool.dispatch', 'tool.reconcile', 'tool.stop']),
  identity: spaceIdentitySchema.optional(),
  activityId: z.uuid().optional(),
  scope: z.object({ environmentId: z.uuid(), spaceId: z.uuid(), principalId: z.uuid() }).strict().optional(),
  authority: teachingDispatchAuthoritySchema.optional(), args: z.array(z.unknown()).max(4) }).strict();
