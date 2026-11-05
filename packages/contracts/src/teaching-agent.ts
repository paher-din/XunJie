import { z } from 'zod';
import { actionReceiptSchema } from './action-intents.js';
import { modelUsageSchema } from './model-connections.js';
import { teachingHelpPolicySchema } from './course-help.js';

export { teachingHelpPolicySchema } from './course-help.js';

export const teachingRunStateSchema = z.enum([
  'received', 'running', 'dispatching', 'completed', 'failed', 'stopped', 'paused',
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
  'input', 'run-received', 'run-started', 'context-assembled', 'attempt-dispatched', 'assistant',
  'run-completed', 'run-failed', 'run-stopped', 'stop-requested', 'run-continued',
  'model-unavailable', 'capacity-paused', 'system-notice',
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
  createdAt: z.iso.datetime(),
}).strict();
export type TeachingMessage = z.infer<typeof teachingMessageSchema>;

export const teachingConversationSchema = z.object({
  activityId: z.uuid(), cursor: z.number().int().nonnegative(),
  messages: z.array(teachingMessageSchema), runs: z.array(teachingRunSchema),
}).strict();
export type TeachingConversation = z.infer<typeof teachingConversationSchema>;

export const teachingSnapshotSchema = z.object({
  snapshotId: z.uuid(), activityId: z.uuid(), runId: z.uuid(), attemptId: z.uuid(), segmentId: z.uuid(),
  assemblyVersion: z.literal(1), model: teachingModelFactSchema,
  maxOutputTokens: z.number().int().positive(), contextWindow: z.number().int().positive().optional(),
  sources: z.array(z.object({ kind: z.enum(['platform', 'run', 'course', 'input', 'history', 'material']),
    id: z.string().max(200).optional(), label: z.string().max(200) }).strict()),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
}).strict();
export type TeachingSnapshot = z.infer<typeof teachingSnapshotSchema>;

export const teachingRequestViewSchema = z.object({
  requestId: z.uuid(), runId: z.uuid(), inputId: z.uuid(),
  state: z.enum(['accepted', 'cancelled']), receipt: actionReceiptSchema,
}).strict();
export type TeachingRequestView = z.infer<typeof teachingRequestViewSchema>;

export const teachingStopInputSchema = z.object({ requestId: z.uuid() }).strict();
export const teachingContinueInputSchema = z.object({ requestId: z.uuid() }).strict();

export const teachingAgentCapabilitiesSchema = z.object({
  receiver: z.object({ receiverId: z.string(), location: z.literal('remote'), kind: z.literal('question') }).strict(),
  modelAvailable: z.boolean(), modelUnavailableReason: z.string().max(200).optional(),
}).strict();

export function teachingAgentReceiverId(ownerServiceId: string) {
  return `teaching-agent:${ownerServiceId}`;
}
