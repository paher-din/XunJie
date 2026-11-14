import { z } from 'zod';
import { modelToolResultSchema } from './model-connections.js';
import { spaceIdentitySchema, type SpaceIdentity } from './spaces.js';
import { agentDispatchPermitSchema, agentInputSchema, agentRuntimeSessionSchema, agentWaitResponseSchema, agentRunSchema, agentEventSchema,
  agentOperationSchema, agentInputReceiptSchema, agentWaitSchema, type AgentInput, type AgentRuntimeSession,
  type AgentDispatchPermit, type AgentRun, type AgentEvent, type AgentInputReceipt, type AgentWaitResponse } from './agent-runtime.js';

export const agentSessionsCapability = 'agent.sessions.v2' as const;
export const agentSessionOperationSchema = z.enum([
  'initialize', 'accept', 'run', 'events', 'stop', 'continueRun', 'snapshot', 'respond', 'resolveWait', 'request', 'conversation',
  'inputControl', 'assertDispatch',
]);
const facts = z.record(z.string(), z.json());
const inputControlBase = { requestId: z.uuid(), expectedVersion: z.number().int().positive() };
export const agentInputControlSchema = z.discriminatedUnion('operation', [
  z.object({ ...inputControlBase, operation: z.literal('edit'), text: agentInputSchema.shape.text.optional(),
    context: facts.optional(), mode: z.enum(['steering', 'queue']).optional() }).strict()
    .refine(value => value.text !== undefined || value.context !== undefined || value.mode !== undefined),
  z.object({ ...inputControlBase, operation: z.literal('remove') }).strict(),
  z.object({ ...inputControlBase, operation: z.literal('move'), mode: z.enum(['steering', 'queue']) }).strict(),
]);
export type AgentInputControl = z.infer<typeof agentInputControlSchema>;
export const agentSessionInputSchema = z.object({
  inputId: z.uuid(), runId: z.uuid(), version: z.number().int().positive(), mode: z.enum(['steering', 'queue']),
  state: z.enum(['pending', 'adopted', 'removed']), input: agentInputSchema, createdAt: z.iso.datetime(),
}).strict().refine(value => value.mode === value.input.mode, 'Input mode must retain its fixed current input.');
export type AgentSessionInput = z.infer<typeof agentSessionInputSchema>;
export const agentInputControlReceiptSchema = z.object({ requestId: z.uuid(), input: agentSessionInputSchema,
  previousRunId: z.uuid().optional() }).strict();
export type AgentInputControlReceipt = z.infer<typeof agentInputControlReceiptSchema>;
export const agentSessionSnapshotSchema = z.object({ session: agentRuntimeSessionSchema, runs: z.array(agentRunSchema),
  inputs: z.array(agentSessionInputSchema), waits: z.array(agentWaitSchema) }).strict().refine(value => {
  const runIds = new Set(value.runs.map(run => run.runId));
  return value.runs.every(run => run.sessionId === value.session.sessionId)
    && value.inputs.every(input => input.input.sessionId === value.session.sessionId && runIds.has(input.runId))
    && value.waits.every(wait => runIds.has(wait.runId));
}, 'Session projection must retain one owner session.');
export type AgentSessionSnapshot = z.infer<typeof agentSessionSnapshotSchema>;
export interface AgentSessionReadPort {
  sessionSnapshot(identity: SpaceIdentity, sessionId: string): Promise<AgentSessionSnapshot>;
}
export const agentRunBudgetSchema = z.object({ maxSteps: z.number().int().positive(), maxDispatches: z.number().int().positive(),
  deadline: z.iso.datetime().nullable(), steps: z.number().int().nonnegative(), dispatches: z.number().int().nonnegative() }).strict();
const envelope = z.object({ version: z.literal(2), identity: spaceIdentitySchema, sessionId: z.uuid() }).strict();
const runArgs = z.object({ runId: z.uuid() }).strict();
const controlArgs = runArgs.extend({ requestId: z.uuid() }).strict();
export const agentWaitResolutionSchema = agentWaitResponseSchema.omit({ answer: true })
  .extend({ result: z.record(z.string(), z.json()) }).strict();
export type AgentWaitResolution = z.infer<typeof agentWaitResolutionSchema>;

/** Names are presentation; these four fields fix the authenticated subject. */
export function sameAgentSubject(a: SpaceIdentity, b: SpaceIdentity): boolean {
  return a.environmentId === b.environmentId && a.spaceId === b.spaceId
    && a.principalId === b.principalId && a.kind === b.kind;
}

export const agentSessionCallSchema = z.discriminatedUnion('operation', [
  envelope.extend({ operation: z.literal('initialize'), args: z.object({ session: agentRuntimeSessionSchema }).strict() }),
  envelope.extend({ operation: z.literal('accept'), args: z.object({ input: agentInputSchema }).strict() }),
  envelope.extend({ operation: z.literal('run'), args: runArgs }),
  envelope.extend({ operation: z.literal('conversation'), args: z.object({ after: z.number().int().nonnegative().default(0) }).strict() }),
  envelope.extend({ operation: z.literal('events'), args: z.object({ after: z.number().int().nonnegative().default(0) }).strict() }),
  envelope.extend({ operation: z.literal('stop'), args: controlArgs }),
  envelope.extend({ operation: z.literal('continueRun'), args: controlArgs }),
  envelope.extend({ operation: z.literal('snapshot'), args: runArgs }),
  envelope.extend({ operation: z.literal('respond'), args: z.object({ response: agentWaitResponseSchema }).strict() }),
  envelope.extend({ operation: z.literal('resolveWait'), args: z.object({ resolution: agentWaitResolutionSchema }).strict() }),
  envelope.extend({ operation: z.literal('request'), args: z.object({ requestId: z.uuid() }).strict() }),
  envelope.extend({ operation: z.literal('inputControl'), args: z.object({ inputId: z.uuid(), control: agentInputControlSchema }).strict() }),
  envelope.extend({ operation: z.literal('assertDispatch'), args: z.object({ permit: agentDispatchPermitSchema, attemptId: z.uuid() }).strict() }),
]).superRefine((call, context) => {
  if (call.operation === 'accept' && call.args.input.sessionId !== call.sessionId) {
    context.addIssue({ code: 'custom', path: ['args', 'input', 'sessionId'], message: 'Input belongs to another session.' });
  }
  if (call.operation === 'initialize' && (call.args.session.sessionId !== call.sessionId
    || !sameAgentSubject(call.args.session.identity, call.identity))) {
    context.addIssue({ code: 'custom', path: ['args', 'session'], message: 'Initialization must preserve the authenticated session scope.' });
  }
  if (call.operation === 'assertDispatch' && (call.args.permit.sessionId !== call.sessionId
    || call.args.permit.operationId !== call.args.attemptId)) {
    context.addIssue({ code: 'custom', path: ['args', 'permit'], message: 'Dispatch must retain the original session and attempt.' });
  }
});
export type AgentSessionCall = z.infer<typeof agentSessionCallSchema>;
export type BrowserAgentSessionCall = Exclude<AgentSessionCall, { operation: 'initialize' | 'resolveWait' | 'assertDispatch' }>;

export const agentOperationResultSchema = z.object({
  state: z.enum(['completed', 'accepted', 'failed', 'unknown', 'not-dispatched']), value: facts,
  retryAfterMs: z.number().int().nonnegative().optional(),
}).strict();
export const agentSnapshotSchema = z.object({
  session: agentRuntimeSessionSchema, run: agentRunSchema, revision: z.number().int().nonnegative(),
  state: facts, sessionState: facts, budget: agentRunBudgetSchema,
  inputs: z.array(z.object({ inputId: z.uuid(), version: z.number().int().positive(), sequence: z.number().int().positive(),
    input: agentInputSchema }).strict()),
  steps: z.array(z.object({ stepId: z.uuid(), number: z.number().int().positive(), operation: agentOperationSchema,
    snapshot: facts, state: z.enum(['prepared', 'dispatching', 'waiting', 'unknown', 'completed']),
    result: agentOperationResultSchema.nullable(), continuationOpen: z.boolean() }).strict()),
  waits: z.array(agentWaitSchema),
}).strict().refine(value => value.run.sessionId === value.session.sessionId
  && value.inputs.every(input => input.input.sessionId === value.session.sessionId)
  && value.waits.every(wait => wait.runId === value.run.runId), 'Snapshot must retain one session and run scope.');
export type AgentSnapshot = z.infer<typeof agentSnapshotSchema>;
export const agentAcceptedRequestSchema = z.object({ receipt: agentInputReceiptSchema, input: agentInputSchema }).strict()
  .refine(value => value.receipt.sessionId === value.input.sessionId && value.receipt.requestId === value.input.requestId,
    'Original input and receipt must retain the same request scope.');
export type AgentAcceptedRequest = z.infer<typeof agentAcceptedRequestSchema>;
export const agentWaitReceiptSchema = z.object({ runId: z.uuid(), waitId: z.uuid() }).strict();
export type AgentWaitReceipt = z.infer<typeof agentWaitReceiptSchema>;

export const agentConversationMessageSchema = z.object({
  messageId: z.string().min(1).max(300), runId: z.uuid(), inputId: z.uuid().optional(),
  role: z.enum(['user', 'assistant']), text: z.string(), createdAt: z.iso.datetime(),
  state: z.enum(['streaming', 'settled', 'failed', 'stopped']),
}).strict();
export const agentConversationInputSchema = z.object({
  inputId: z.uuid(), runId: z.uuid(), version: z.number().int().positive(), mode: z.enum(['steering', 'queue']),
  state: z.enum(['pending', 'adopted', 'removed']), text: z.string(), createdAt: z.iso.datetime(),
}).strict();
export const agentConversationToolSchema = z.object({
  operationId: z.uuid(), runId: z.uuid(), name: z.string().min(1).max(200),
  state: z.enum(['prepared', 'dispatching', 'waiting', 'accepted', 'completed', 'failed', 'unknown', 'not-dispatched', 'stopped']),
  feedback: modelToolResultSchema.omit({ callId: true }).optional(),
}).strict();
/** Product projection, independent of debug snapshots and provider SDK response shapes. */
export const agentConversationSchema = z.object({
  sessionId: z.uuid(), lastSeq: z.number().int().nonnegative(), messages: z.array(agentConversationMessageSchema),
  runs: z.array(agentRunSchema), inputs: z.array(agentConversationInputSchema), waits: z.array(agentWaitSchema),
  tools: z.array(agentConversationToolSchema),
  workspaces: z.array(z.object({ operationId: z.uuid(), runId: z.uuid(), workspace: facts }).strict()),
}).strict().refine(value => {
  const runIds = new Set(value.runs.map(run => run.runId));
  return value.runs.every(run => run.sessionId === value.sessionId)
    && [...value.messages, ...value.inputs, ...value.waits, ...value.tools, ...value.workspaces].every(item => runIds.has(item.runId));
}, 'Conversation facts must belong to the projected session and its runs.');
export type AgentConversation = z.infer<typeof agentConversationSchema>;

/** Public wire port, independent of the core implementation and Node host types. */
export interface AgentSessionPort {
  initialize(session: AgentRuntimeSession): Promise<AgentRuntimeSession>;
  accept(identity: SpaceIdentity, input: AgentInput): Promise<AgentInputReceipt>;
  run(identity: SpaceIdentity, sessionId: string, runId: string): Promise<AgentRun>;
  conversation(identity: SpaceIdentity, sessionId: string, after?: number): Promise<AgentConversation>;
  events(identity: SpaceIdentity, sessionId: string, after?: number): Promise<AgentEvent[]>;
  stop(identity: SpaceIdentity, sessionId: string, runId: string, requestId: string): Promise<AgentRun>;
  continueRun(identity: SpaceIdentity, sessionId: string, runId: string, requestId: string): Promise<AgentRun>;
  snapshot(identity: SpaceIdentity, sessionId: string, runId: string): Promise<AgentSnapshot>;
  respond(identity: SpaceIdentity, sessionId: string, response: AgentWaitResponse): Promise<AgentWaitReceipt>;
  resolveWait(identity: SpaceIdentity, sessionId: string, resolution: AgentWaitResolution): Promise<AgentWaitReceipt>;
  request(identity: SpaceIdentity, sessionId: string, requestId: string): Promise<AgentAcceptedRequest | null>;
  inputControl(identity: SpaceIdentity, sessionId: string, inputId: string, control: AgentInputControl): Promise<AgentInputControlReceipt>;
  assertDispatch(identity: SpaceIdentity, permit: AgentDispatchPermit): Promise<void>;
}
/** A host may add original receipt lookup when its core supports it; no fallback may invent a receipt. */
export type AgentSessionBackend = Omit<AgentSessionPort, 'request' | 'conversation' | 'inputControl' | 'assertDispatch'>
  & Partial<Pick<AgentSessionPort, 'request' | 'conversation' | 'inputControl' | 'assertDispatch'>>;

export const agentSessionResultSchemas = {
  initialize: agentRuntimeSessionSchema, accept: agentInputReceiptSchema,
  run: agentRunSchema, conversation: agentConversationSchema, events: z.array(agentEventSchema), stop: agentRunSchema, continueRun: agentRunSchema,
  snapshot: agentSnapshotSchema, respond: agentWaitReceiptSchema, resolveWait: agentWaitReceiptSchema,
  request: agentAcceptedRequestSchema.nullable(),
  inputControl: agentInputControlReceiptSchema,
  assertDispatch: agentDispatchPermitSchema,
};
export type AgentSessionResults = { [K in keyof typeof agentSessionResultSchemas]: z.infer<(typeof agentSessionResultSchemas)[K]> };

/** Shape and correlation checks apply equally to local service output and remote client input. */
export function parseAgentSessionResult<C extends AgentSessionCall>(call: C, value: unknown): AgentSessionResults[C['operation']] {
  const result = agentSessionResultSchemas[call.operation].parse(value);
  let matches = true;
  switch (call.operation) {
    case 'initialize': {
      const session = agentRuntimeSessionSchema.parse(result);
      matches = session.sessionId === call.sessionId && sameAgentSubject(session.identity, call.identity); break;
    }
    case 'accept': {
      const receipt = agentInputReceiptSchema.parse(result);
      matches = receipt.sessionId === call.sessionId && receipt.requestId === call.args.input.requestId; break;
    }
    case 'request': {
      const accepted = agentAcceptedRequestSchema.nullable().parse(result);
      matches = accepted === null || accepted.receipt.sessionId === call.sessionId && accepted.receipt.requestId === call.args.requestId; break;
    }
    case 'inputControl': {
      const receipt = agentInputControlReceiptSchema.parse(result);
      matches = receipt.requestId === call.args.control.requestId && receipt.input.inputId === call.args.inputId
        && receipt.input.input.sessionId === call.sessionId && receipt.input.version === call.args.control.expectedVersion + 1
        && receipt.input.state === (call.args.control.operation === 'remove' ? 'removed' : 'pending'); break;
    }
    case 'assertDispatch': {
      const permit = agentDispatchPermitSchema.parse(result);
      matches = (['sessionId', 'runId', 'stepId', 'operationId', 'generation'] as const)
        .every(key => permit[key] === call.args.permit[key]); break;
    }
    case 'run': case 'stop': case 'continueRun': {
      const run = agentRunSchema.parse(result);
      matches = run.sessionId === call.sessionId && run.runId === call.args.runId; break;
    }
    case 'conversation': {
      matches = agentConversationSchema.parse(result).sessionId === call.sessionId; break;
    }
    case 'events': {
      const events = z.array(agentEventSchema).parse(result);
      matches = events.every((event, index) => event.sessionId === call.sessionId && event.seq > (events[index - 1]?.seq ?? call.args.after)); break;
    }
    case 'snapshot': {
      const snapshot = agentSnapshotSchema.parse(result);
      matches = snapshot.session.sessionId === call.sessionId && sameAgentSubject(snapshot.session.identity, call.identity)
        && snapshot.run.runId === call.args.runId; break;
    }
    case 'respond': case 'resolveWait': {
      const receipt = agentWaitReceiptSchema.parse(result);
      matches = receipt.waitId === (call.operation === 'respond' ? call.args.response.waitId : call.args.resolution.waitId); break;
    }
  }
  z.custom<boolean>(value => value === true, 'Result does not match the requested session operation.').parse(matches);
  return result as AgentSessionResults[C['operation']];
}
