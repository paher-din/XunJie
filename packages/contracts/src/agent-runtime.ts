import { z } from 'zod';
import { spaceIdentitySchema } from './spaces.js';

/** The owner validates scene-specific context; the kernel only retains its fixed JSON. */
export const agentInputSchema = z.object({
  requestId: z.uuid(), sessionId: z.uuid(), text: z.string().min(1).max(1_000_000),
  mode: z.enum(['steering', 'queue']).default('steering'),
  context: z.record(z.string(), z.json()).default({}),
}).strict().refine(value => JSON.stringify(value).length <= 4_000_000,
  'fixed agent input exceeds the supported recovery envelope');
export type AgentInput = z.infer<typeof agentInputSchema>;

export const agentRuntimeSessionSchema = z.object({
  sessionId: z.uuid(), identity: spaceIdentitySchema, scenario: z.string().min(1).max(200),
  restartPolicy: z.enum(['explicit', 'automatic']), createdAt: z.iso.datetime(),
}).strict();
export type AgentRuntimeSession = z.infer<typeof agentRuntimeSessionSchema>;

export const agentRunStateSchema = z.enum(['received', 'running', 'waiting', 'paused', 'completed', 'failed', 'stopped']);
export const agentRunSchema = z.object({
  runId: z.uuid(), sessionId: z.uuid(), requestId: z.uuid(), inputId: z.uuid(),
  state: agentRunStateSchema, reason: z.string(), generation: z.number().int().nonnegative(),
  stopRequested: z.boolean(), needsContinue: z.boolean(), previousRunId: z.uuid().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
}).strict();
export type AgentRun = z.infer<typeof agentRunSchema>;

export const agentEventSchema = z.object({
  sessionId: z.uuid(), seq: z.number().int().positive(), eventId: z.uuid(), version: z.literal(1),
  kind: z.string().min(1).max(200), body: z.record(z.string(), z.json()), createdAt: z.iso.datetime(),
}).strict();
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** A generation fences dispatch, independently of an optional worker lease. */
export const agentDispatchPermitSchema = z.object({
  sessionId: z.uuid(), runId: z.uuid(), stepId: z.uuid(), operationId: z.uuid(),
  generation: z.number().int().positive(),
}).strict();
export type AgentDispatchPermit = z.infer<typeof agentDispatchPermitSchema>;

export const agentInputReceiptSchema = z.object({
  requestId: z.uuid(), sessionId: z.uuid(), inputId: z.uuid(), runId: z.uuid(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type AgentInputReceipt = z.infer<typeof agentInputReceiptSchema>;

export const agentOperationSchema = z.object({
  operationId: z.uuid(), kind: z.string().min(1).max(200), bindingId: z.string().min(1).max(300),
  input: z.record(z.string(), z.json()),
}).strict();
export type AgentOperation = z.infer<typeof agentOperationSchema>;

export const agentWaitSchema = z.object({
  waitId: z.uuid(), runId: z.uuid(), operationId: z.uuid(), version: z.number().int().positive(),
  kind: z.string().min(1).max(100), state: z.enum(['pending', 'consumed', 'cancelled', 'expired']),
  presentation: z.record(z.string(), z.json()), response: z.record(z.string(), z.json()).nullable(),
  deadline: z.iso.datetime().nullable(),
  continuationOperationId: z.uuid().optional(),
  /** Only explicitly interruptible waits may be superseded by a new steering input. */
  interruptible: z.boolean().optional(),
}).strict();
export type AgentWait = z.infer<typeof agentWaitSchema>;

export const agentWaitResponseSchema = z.object({
  requestId: z.uuid(), waitId: z.uuid(), expectedVersion: z.number().int().positive(),
  answer: z.record(z.string(), z.json()),
}).strict();
export type AgentWaitResponse = z.infer<typeof agentWaitResponseSchema>;

export interface AgentRuntimePort {
  initialize(session: AgentRuntimeSession): Promise<AgentRuntimeSession>;
  accept(identity: AgentRuntimeSession['identity'], input: AgentInput): Promise<AgentInputReceipt>;
  run(identity: AgentRuntimeSession['identity'], sessionId: string, runId: string): Promise<AgentRun>;
  events(identity: AgentRuntimeSession['identity'], sessionId: string, after?: number): Promise<AgentEvent[]>;
  stop(identity: AgentRuntimeSession['identity'], sessionId: string, runId: string, requestId: string): Promise<AgentRun>;
  continueRun(identity: AgentRuntimeSession['identity'], sessionId: string, runId: string, requestId: string): Promise<AgentRun>;
}
