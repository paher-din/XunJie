import { z } from 'zod';
import { workFilesSchema } from './learning-data.js';
import { actionInputSchema, actionReceiptSchema, actionScopeSchema, actionReceiverSchema } from './action-intents.js';
import { executionDecisionSchema, executionDeviceSchema } from './execution-plan.js';

// A course execution plan lives in its own module so courses and learning data can share it without a cycle.
export * from './execution-plan.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);

/** Budgets an adapter must both declare and actually enforce. Memory is the algorithm's own linear memory. */
export const executionLimitsSchema = z.object({
  timeMs: z.number().int().min(50).max(5000),
  /** 64 KiB WebAssembly pages. 256 pages is the 16 MiB algorithm ceiling, not a browser total. */
  memoryPages: z.number().int().min(1).max(256),
  inputBytes: z.number().int().min(1).max(1048576),
  outputBytes: z.number().int().min(1).max(1048576),
  concurrentJobs: z.number().int().min(1).max(2),
  queuedJobs: z.number().int().min(0).max(4),
}).strict();
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;
export const defaultExecutionLimits: ExecutionLimits = { timeMs: 5000, memoryPages: 256, inputBytes: 1048576,
  outputBytes: 1048576, concurrentJobs: 2, queuedJobs: 4 };

/** One fixed run plan. A location names who really executes it; the kind never crosses locations. */
export const executionPlanSchema = z.object({ planId: identifier, planVersion: z.number().int().positive(),
  planDigest: digest, location: z.enum(['browser', 'native']), kind: z.enum(['job', 'session']) }).strict()
  .refine(value => value.location === 'browser' ? value.kind === 'job' : value.kind === 'session',
    { message: 'A browser plan is a job and a native plan is a session' });
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

/**
 * Limits a native session supervisor both declares and enforces. Memory is the child's V8 heap
 * allowance, not a WebAssembly linear memory or a promise about total process RSS.
 */
export const nativeSessionLimitsSchema = z.object({
  operationTimeoutMs: z.number().int().min(50).max(30000),
  idleMs: z.number().int().min(1000).max(3600000),
  maxMs: z.number().int().min(1000).max(86400000),
  memoryMiB: z.number().int().min(16).max(512),
  concurrentSessions: z.number().int().min(1).max(4),
  queuedSessions: z.number().int().min(0).max(16),
}).strict();
export type NativeSessionLimits = z.infer<typeof nativeSessionLimitsSchema>;

/** A native session names a product-shipped adapter, never a command line or a file path. */
export const executionSessionRequestSchema = z.object({
  adapterId: identifier, adapterVersion: z.number().int().positive(), limits: nativeSessionLimitsSchema,
}).strict();
export type ExecutionSessionRequest = z.infer<typeof executionSessionRequestSchema>;

export const sessionControlEffectSchema = z.enum(['input', 'pause', 'resume', 'step', 'reset', 'checkpoint']);
export type SessionControlEffect = z.infer<typeof sessionControlEffectSchema>;
export const checkpointResumeSchema = z.object({ checkpointId: z.uuid(), sessionRef: z.uuid(), sha256: digest }).strict();
export type CheckpointResume = z.infer<typeof checkpointResumeSchema>;
export const executionCheckpointSchema = checkpointResumeSchema.extend({ contentId: z.uuid(),
  appliedSeq: z.number().int().nonnegative(), byteLength: z.number().int().positive().max(1048576),
  createdAt: z.string().min(1).max(40) }).strict();
export type ExecutionCheckpoint = z.infer<typeof executionCheckpointSchema>;
export const activityCheckpointSchema = executionCheckpointSchema.extend({ requestId: z.uuid(),
  instanceId: z.string().min(1).max(300), scope: actionScopeSchema }).strict();
export type ActivityCheckpoint = z.infer<typeof activityCheckpointSchema>;
export const checkpointPageSchema = z.object({ items: z.array(activityCheckpointSchema).max(64), nextCursor: z.uuid().nullable() }).strict();
export type CheckpointPage = z.infer<typeof checkpointPageSchema>;

export const executionInstanceSchema = z.object({ instanceId: z.string().min(1).max(300), key: identifier,
  componentId: z.uuid(), componentVersion: z.number().int().positive(),
  definitionDigest: digest, hostApiVersion: z.literal(1), stateVersion: z.number().int().positive() }).strict();
export type ExecutionInstance = z.infer<typeof executionInstanceSchema>;

export const executionResourceRefSchema = z.object({ kind: z.enum(['entry', 'algorithm']),
  resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().positive(), mediaType: z.string().min(1).max(120) }).strict();
export type ExecutionResourceRef = z.infer<typeof executionResourceRefSchema>;

/** Everything the run depends on is captured here and never re-read from a mutable head afterwards. */
export const executionBasisSchema = z.object({ works: workFilesSchema,
  state: z.object({ name: z.string().min(1).max(240), contentId: z.uuid(), sha256: digest }).strict().nullable(),
  expected: z.object({ stateContentId: z.uuid().nullable() }).strict(),
  resources: z.array(executionResourceRefSchema).max(8) }).strict();
export type ExecutionBasis = z.infer<typeof executionBasisSchema>;

/**
 * The versioned action envelope. Legacy question actions stay byte-identical: they carry no
 * `protocolVersion`/`kind`, keep their original digest, and are never rewritten into this shape.
 */
export const executionActionSchema = z.object({ protocolVersion: z.literal(2), kind: z.literal('execution'),
  requestId: z.uuid(), scope: actionScopeSchema, receiver: actionReceiverSchema,
  execution: z.object({ instance: executionInstanceSchema,
    operation: z.object({ operationId: identifier, effect: z.enum(['execute', 'input']) }).strict(),
    parameters: z.unknown(), basis: executionBasisSchema, limits: executionLimitsSchema,
    plan: executionPlanSchema,
    /** Present only for a native session; the adapter and its limits are fixed by the host manifest. */
    session: executionSessionRequestSchema.optional(),
    /** Client-observed scheduling facts; course eligibility remains an owner-side authorization. */
    device: executionDeviceSchema.optional(),
    resumeFromCheckpoint: checkpointResumeSchema.optional(),
    initiator: z.object({ kind: z.enum(['student', 'agent', 'self-check', 'teacher-preview']),
      principalId: z.uuid() }).strict() }).strict() }).strict()
  .refine(value => value.receiver.kind === 'execution', { message: 'An execution action needs an execution receiver' })
  .refine(value => value.execution.initiator.principalId === value.scope.principalId, { message: 'The initiator must be the fixed scope principal' })
  .refine(value => value.execution.plan.location === 'native'
    ? value.execution.session !== undefined && value.execution.operation.effect === 'input'
    : value.execution.session === undefined && value.execution.operation.effect === 'execute',
    { message: 'Only a native session plan carries an input operation and a session adapter' })
  .refine(value => !value.execution.resumeFromCheckpoint || value.execution.plan.kind === 'session',
    { message: 'Only a session can restore a checkpoint' })
  .refine(value => JSON.stringify(value).length <= 4000000, { message: 'fixed execution input exceeds its supported recovery envelope' });
export type ExecutionAction = z.infer<typeof executionActionSchema>;
export function isNativeSessionAction(action: ExecutionAction): boolean {
  return action.execution.plan.location === 'native';
}

/** One session input with its own stable identity and the sequence the caller last observed. */
export const executionControlSchema = z.object({ controlId: z.uuid(), operationId: identifier,
  effect: sessionControlEffectSchema, expectedSeq: z.number().int().nonnegative(), parameters: z.unknown() }).strict();
export type ExecutionControl = z.infer<typeof executionControlSchema>;

/** A stop keeps its original identity; an omitted explanation is represented by an empty string. */
export const executionStopSchema = z.object({ stopId: z.uuid(), reason: z.string().max(200) }).strict();
export type ExecutionStop = z.infer<typeof executionStopSchema>;

export const fixedActionSchema = z.union([actionInputSchema, executionActionSchema]);
export type FixedAction = z.infer<typeof fixedActionSchema>;
export function isExecutionAction(action: FixedAction): action is ExecutionAction {
  return (action as { kind?: unknown }).kind === 'execution';
}
/** Legacy records have no discriminator; only an explicit execution kind changes what an action means. */
export function fixedActionKind(value: unknown): 'question' | 'execution' {
  return (value as { kind?: unknown } | null)?.kind === 'execution' ? 'execution' : 'question';
}

/** Acceptance returns the original receipt plus the fixed execution reference; completion is a later fact. */
export const executionAcceptanceSchema = z.object({ receipt: actionReceiptSchema,
  execution: z.object({ executionRef: z.uuid(), acceptedSeq: z.number().int().positive() }).strict().nullable() }).strict()
  .refine(value => (value.receipt.state === 'accepted') === (value.execution !== null),
    { message: 'Only an accepted receipt carries an execution reference' });
export type ExecutionAcceptance = z.infer<typeof executionAcceptanceSchema>;

export const executionStateSchema = z.enum(['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled']);
export type ExecutionState = z.infer<typeof executionStateSchema>;
export const executionFailureSchema = z.object({ code: z.enum(['invalid-input', 'input-too-large', 'output-too-large',
  'budget-exceeded', 'algorithm-error', 'resource-unavailable', 'worker-terminated', 'capability-unavailable',
  'maintenance']),
  detail: z.string().max(500) }).strict();
export type ExecutionFailure = z.infer<typeof executionFailureSchema>;
export const executionOutputSchema = z.object({ contentId: z.uuid(), output: z.unknown(),
  artifact: z.object({ name: z.string().min(1).max(120), mediaType: z.string().min(1).max(120),
    byteLength: z.number().int().positive().max(1048576), sha256: digest }).strict().nullable() }).strict();
export type ExecutionOutput = z.infer<typeof executionOutputSchema>;

/** One confirmed input observation, bound to the operation identity that produced it. */
export const executionObservationSchema = z.object({ seq: z.number().int().positive(), controlId: z.uuid(),
  state: z.unknown(), at: z.string().min(1).max(40) }).strict();
export type ExecutionObservation = z.infer<typeof executionObservationSchema>;

/** Stable session identity plus what the real supervisor confirmed; unknown never means stopped. */
export const executionSessionViewSchema = z.object({
  adapterId: identifier, adapterVersion: z.number().int().positive(),
  instanceId: z.string().min(1).max(300), instanceKey: identifier,
  nodeId: z.string().min(1).max(80), installGeneration: z.string().min(1).max(120),
  supervisorEpoch: z.uuid(), executorInstanceId: z.uuid(),
  appliedSeq: z.number().int().nonnegative(), lastControlId: z.uuid().nullable(),
  observation: z.unknown().nullable(), observations: z.array(executionObservationSchema).max(64),
  checkpoints: z.array(executionCheckpointSchema).max(64).optional(),
  restoredFrom: checkpointResumeSchema.optional(),
}).strict();
export type ExecutionSessionView = z.infer<typeof executionSessionViewSchema>;

/** `state` under `unknown` knowledge is the last confirmed state, never a guess about a live worker. */
export const executionQuerySchema = z.object({ requestId: z.uuid(), inputDigest: digest, scope: actionScopeSchema,
  executionRef: z.uuid(), state: executionStateSchema, statusKnowledge: z.enum(['confirmed', 'unknown']),
  stopRequested: z.boolean(), confirmedSeq: z.number().int().nonnegative(), reason: executionFailureSchema.nullable(),
  output: executionOutputSchema.nullable(), session: executionSessionViewSchema.nullable().optional() }).strict()
  .refine(value => value.statusKnowledge === 'confirmed' || value.reason !== null,
    { message: 'An unconfirmed status must say why it is unknown' });
export type ExecutionQuery = z.infer<typeof executionQuerySchema>;
export const executionControlReceiptSchema = z.object({ controlId: z.uuid(), requestId: z.uuid(), executionRef: z.uuid(),
  inputDigest: digest,
  effect: sessionControlEffectSchema, status: z.enum(['dispatching', 'applied', 'unknown', 'rejected']),
  seq: z.number().int().positive(), query: executionQuerySchema }).strict();
export type ExecutionControlReceipt = z.infer<typeof executionControlReceiptSchema>;

export const executionCapabilitiesSchema = z.object({ plans: z.array(executionPlanSchema).max(4),
  operations: z.array(z.object({ operationId: identifier, instanceId: z.string().min(1).max(300),
    limits: executionLimitsSchema, available: z.boolean(), reason: z.string().max(200).nullable(),
    /** The placement answer for this operation; absent for a component the course published without a plan. */
    decision: executionDecisionSchema.optional() }).strict()).max(8),
  running: z.number().int().nonnegative(), queued: z.number().int().nonnegative() }).strict();
export type ExecutionCapabilities = z.infer<typeof executionCapabilitiesSchema>;

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

/**
 * A confirmed terminal fact is final. Connectivity loss, a late reply or a repeated query can make
 * knowledge weaker, never the recorded outcome. `stopRequested` only ever becomes true.
 */
export function advanceExecution(current: ExecutionQuery | null, next: ExecutionQuery): ExecutionQuery {
  if (!current) return next;
  if (current.executionRef !== next.executionRef || current.requestId !== next.requestId
    || current.inputDigest !== next.inputDigest) throw new Error('invalid-input');
  const session = next.session ?? current.session;
  const merged: ExecutionQuery = { ...next, stopRequested: current.stopRequested || next.stopRequested,
    ...(session ? { session } : {}) };
  if (current.statusKnowledge === 'confirmed' && isTerminalExecutionState(current.state)) {
    // A late archived session observation may enrich history without changing its final outcome.
    if (current.session && next.session && next.statusKnowledge === 'confirmed' && next.state === current.state
      && next.confirmedSeq > current.confirmedSeq) return { ...current, confirmedSeq: next.confirmedSeq,
      stopRequested: merged.stopRequested, session: next.session };
    return current;
  }
  if (next.statusKnowledge === 'unknown' && current.statusKnowledge === 'confirmed') {
    // The state stays the last one the executor confirmed; only reachability became unknown.
    return { ...current, statusKnowledge: 'unknown', stopRequested: merged.stopRequested, reason: next.reason ?? current.reason };
  }
  if (next.confirmedSeq < current.confirmedSeq) return current;
  return merged;
}

/** Rejection is a real answer; a transport failure is not. Neither may be rewritten as a cancel. */
export function rejectedExecutionAcceptance(requestId: string, inputDigest: string, receiver: z.infer<typeof actionReceiverSchema>,
  detail: string): ExecutionAcceptance {
  return executionAcceptanceSchema.parse({ receipt: { requestId, inputDigest, receiver, state: 'rejected',
    receiptId: 'rejected:' + requestId, detail }, execution: null });
}
