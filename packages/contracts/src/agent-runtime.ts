import { z } from 'zod';
import { spaceIdentitySchema } from './spaces.js';

/** Mirrors modelUsageSchema; inlined to avoid a contracts import cycle with model-connections. */
const agentUsageSchema = z.object({ state: z.enum(['final', 'partial', 'unknown']),
  inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(), cachedTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional() }).strict();

/** A real user input. The kernel decides steering vs new Turn from the active Turn, not a caller mode. */
export const agentInputSchema = z.object({
  requestId: z.uuid(), sessionId: z.uuid(), text: z.string().min(1).max(1_000_000),
  context: z.record(z.string(), z.json()).default({}),
}).strict().refine(value => JSON.stringify(value).length <= 4_000_000,
  'fixed agent input exceeds the supported envelope');
export type AgentInput = z.infer<typeof agentInputSchema>;

/** Long-lived conversation and history. At most one active Turn per Session. */
export const agentRuntimeSessionSchema = z.object({
  sessionId: z.uuid(), identity: spaceIdentitySchema, scenario: z.string().min(1).max(200),
  createdAt: z.iso.datetime(),
}).strict();
export type AgentRuntimeSession = z.infer<typeof agentRuntimeSessionSchema>;

export const agentTurnStateSchema = z.enum(['active', 'completed', 'stopped', 'interrupted', 'failed']);
export const agentTurnTriggerSchema = z.enum(['user', 'task-notification', 'continue']);
/** One continuous processing run started by user input, manual continue, or a qualifying task notification. */
export const agentTurnSchema = z.object({
  turnId: z.uuid(), sessionId: z.uuid(), requestId: z.uuid(),
  trigger: agentTurnTriggerSchema, originNotificationId: z.uuid().nullable(),
  state: agentTurnStateSchema, reason: z.string().max(500),
  ownerInstanceId: z.string().min(1).max(200),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
}).strict();
export type AgentTurn = z.infer<typeof agentTurnSchema>;
export type AgentTurnState = z.infer<typeof agentTurnStateSchema>;

/** One logical main-model generation plus the whole tool batch its response produced. */
export const agentStepStateSchema = z.enum(['generating', 'executing', 'completed', 'interrupted', 'failed']);
export const agentStepSchema = z.object({
  stepId: z.uuid(), turnId: z.uuid(), stepNo: z.number().int().positive(),
  state: agentStepStateSchema,
  /** Fixed input range selected before generation: user inputs, notifications, context/model digest. */
  snapshot: z.record(z.string(), z.json()),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
}).strict();
export type AgentStep = z.infer<typeof agentStepSchema>;

/** An actual main-model call attempt. Retries stay inside the same Step. */
export const agentAttemptStateSchema = z.enum(['pending', 'completed', 'failed', 'interrupted']);
export const agentAttemptSchema = z.object({
  attemptId: z.uuid(), stepId: z.uuid(), attemptNo: z.number().int().positive(),
  state: agentAttemptStateSchema,
  requestRef: z.uuid().nullable(), responseRef: z.uuid().nullable(),
  usage: agentUsageSchema, reserved: z.object({ inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative() }).strict(),
  error: z.string().max(500).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type AgentAttempt = z.infer<typeof agentAttemptSchema>;

/** The single terminal result of one ToolCall. accepted is a receipt, never a final task result. */
export const agentToolResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed'), outcome: z.enum(['success', 'error']),
    summary: z.string().max(8192), data: z.json().optional(), resultRef: z.string().max(300).optional(),
    images: z.array(z.object({ imageId: z.uuid(), version: z.literal(1) }).strict()).max(2).optional() }).strict(),
  z.object({ kind: z.literal('accepted'), taskId: z.string().min(1).max(200),
    summary: z.string().max(8192), resultRef: z.string().max(300).optional() }).strict(),
  z.object({ kind: z.literal('interrupted'), reason: z.string().max(500) }).strict(),
  z.object({ kind: z.literal('not_started'), reason: z.string().max(500) }).strict(),
  z.object({ kind: z.literal('outcome_unknown'), reason: z.string().max(500),
    taskId: z.string().max(200).optional(), requestRef: z.string().max(300).optional() }).strict(),
]);
export type AgentToolResult = z.infer<typeof agentToolResultSchema>;
export const agentToolCallStateSchema = z.enum(['pending', 'started', 'closed']);
export const agentExecutionModeSchema = z.enum(['foreground', 'background']);
export type AgentExecutionMode = z.infer<typeof agentExecutionModeSchema>;
export const agentToolCallSchema = z.object({
  toolCallId: z.uuid(), stepId: z.uuid(), callIndex: z.number().int().nonnegative(),
  nativeCallId: z.string().min(1).max(200), name: z.string().min(1).max(200),
  input: z.record(z.string(), z.json()), executionMode: agentExecutionModeSchema,
  state: agentToolCallStateSchema, result: agentToolResultSchema.nullable(),
  taskId: z.string().max(200).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

/** A real question bound to a ToolCall. Business presentation/answer content is opaque to the kernel. */
export const agentQuestionStateSchema = z.enum(['pending', 'answered', 'skipped', 'closed', 'expired']);
export const agentQuestionSchema = z.object({
  questionId: z.uuid(), sessionId: z.uuid(), turnId: z.uuid(), stepId: z.uuid(), toolCallId: z.uuid(),
  version: z.number().int().positive(), state: agentQuestionStateSchema,
  presentation: z.record(z.string(), z.json()),
  answer: z.record(z.string(), z.json()).nullable(), answerRequestId: z.uuid().nullable(),
  deadline: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type AgentQuestion = z.infer<typeof agentQuestionSchema>;

/** A short input record for a task terminal state. Stable id from taskId + terminal version. */
export const agentNotificationSchema = z.object({
  notificationId: z.uuid(), sessionId: z.uuid(), originTurnId: z.uuid(),
  taskId: z.string().min(1).max(200), taskVersion: z.string().min(1).max(200),
  terminalStatus: z.enum(['success', 'failed', 'cancelled']),
  summary: z.string().max(2000), resultRef: z.string().max(300).nullable(),
  state: z.enum(['pending', 'adopted', 'suppressed']),
  consumedByStepId: z.uuid().nullable(), createdAt: z.iso.datetime(),
}).strict();
export type AgentNotification = z.infer<typeof agentNotificationSchema>;

export const agentEventSchema = z.object({
  sessionId: z.uuid(), seq: z.number().int().positive(), eventId: z.uuid(), version: z.literal(1),
  kind: z.string().min(1).max(200), body: z.record(z.string(), z.json()), createdAt: z.iso.datetime(),
}).strict();
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const agentInputReceiptSchema = z.object({
  requestId: z.uuid(), sessionId: z.uuid(), inputId: z.uuid(), turnId: z.uuid(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Dynamic projection of the immutable receipt: current queue state, never part of its fingerprint. */
  state: z.enum(['pending', 'deferred', 'adopted', 'removed']).optional(),
  currentTurnId: z.uuid().nullable().optional(),
}).strict();
export type AgentInputReceipt = z.infer<typeof agentInputReceiptSchema>;

/** Gateway transport fence only. The kernel adapter maps turnId→runId; no second Agent concept is exposed. */
export const agentDispatchPermitSchema = z.object({
  sessionId: z.uuid(), runId: z.uuid(), stepId: z.uuid(), operationId: z.uuid(),
  generation: z.number().int().positive(),
}).strict();
export type AgentDispatchPermit = z.infer<typeof agentDispatchPermitSchema>;

/** Frozen per-Turn budget. Attempt retries do not add Steps but their usage/reserve is billed. */
export const agentTurnBudgetSchema = z.object({
  maxSteps: z.number().int().positive().max(2_147_483_647),
  maxToolCalls: z.number().int().positive().max(2_147_483_647),
  maxInputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxCallMs: z.number().int().positive().max(2_147_483_647),
  deadline: z.iso.datetime(),
}).strict();
export type AgentTurnBudget = z.infer<typeof agentTurnBudgetSchema>;
export const defaultAgentTurnBudget = Object.freeze({ maxSteps: 16, maxToolCalls: 64,
  maxInputTokens: 4_194_304, maxOutputTokens: 65_536, maxCallMs: 600_000, hardDeadlineMs: 86_400_000 });

export const agentQuestionResponseSchema = z.object({
  requestId: z.uuid(), questionId: z.uuid(), expectedVersion: z.number().int().positive(),
  answer: z.record(z.string(), z.json()),
}).strict();
export type AgentQuestionResponse = z.infer<typeof agentQuestionResponseSchema>;
export const agentQuestionReceiptSchema = z.object({
  requestId: z.uuid(), questionId: z.uuid(), questionVersion: z.number().int().positive(),
  turnId: z.uuid(), status: z.enum(['accepted', 'rejected']), reason: z.string().max(200),
}).strict();
export type AgentQuestionReceipt = z.infer<typeof agentQuestionReceiptSchema>;

/** Public kernel entry: submit / answerQuestion / stop(turnId) / continue / reads / events. */
export interface AgentRuntimePort {
  initialize(session: AgentRuntimeSession): Promise<AgentRuntimeSession>;
  submit(identity: AgentRuntimeSession['identity'], input: AgentInput): Promise<AgentInputReceipt>;
  answerQuestion(identity: AgentRuntimeSession['identity'], sessionId: string, response: AgentQuestionResponse): Promise<AgentQuestionReceipt>;
  stop(identity: AgentRuntimeSession['identity'], sessionId: string, turnId: string, requestId: string): Promise<AgentTurn>;
  continueSession(identity: AgentRuntimeSession['identity'], sessionId: string, requestId: string): Promise<AgentTurn>;
  turn(identity: AgentRuntimeSession['identity'], sessionId: string, turnId: string): Promise<AgentTurn>;
  events(identity: AgentRuntimeSession['identity'], sessionId: string, after?: number): Promise<AgentEvent[]>;
}
