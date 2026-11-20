import { z } from 'zod';
import { teachingSkillLoadedSchema } from './agent-skills.js';
import { agentCitationSchema } from './agent-citations.js';
import { spaceIdentitySchema, type SpaceIdentity } from './spaces.js';
import { agentInputSchema, agentRuntimeSessionSchema, agentTurnSchema, agentEventSchema, agentInputReceiptSchema,
  agentQuestionSchema, agentQuestionResponseSchema, agentQuestionReceiptSchema, agentToolCallSchema, agentStepSchema,
  agentNotificationSchema, agentTurnBudgetSchema, agentDispatchPermitSchema, agentAttemptSchema,
  type AgentInput, type AgentRuntimeSession, type AgentTurn, type AgentEvent, type AgentInputReceipt,
  type AgentQuestionResponse, type AgentQuestionReceipt, type AgentDispatchPermit } from './agent-runtime.js';

export const agentSessionsCapability = 'agent.sessions.v3' as const;
export const agentSessionOperationSchema = z.enum([
  'initialize', 'submit', 'answerQuestion', 'stop', 'continueSession', 'turn', 'events', 'conversation',
  'sessionSnapshot', 'request', 'inputControl', 'registerNotification', 'recordProgress', 'assertDispatch',
]);
const facts = z.record(z.string(), z.json());
const inputControlBase = { requestId: z.uuid(), expectedVersion: z.number().int().positive() };
export const agentInputControlSchema = z.discriminatedUnion('operation', [
  z.object({ ...inputControlBase, operation: z.literal('edit'), text: agentInputSchema.shape.text.optional(),
    context: facts.optional() }).strict().refine(value => value.text !== undefined || value.context !== undefined),
  z.object({ ...inputControlBase, operation: z.literal('remove') }).strict(),
]);
export type AgentInputControl = z.infer<typeof agentInputControlSchema>;
export const agentSessionInputSchema = z.object({
  inputId: z.uuid(), turnId: z.uuid(), version: z.number().int().positive(),
  state: z.enum(['pending', 'adopted', 'removed', 'deferred']), input: agentInputSchema, createdAt: z.iso.datetime(),
}).strict();
export type AgentSessionInput = z.infer<typeof agentSessionInputSchema>;
export const agentInputControlReceiptSchema = z.object({ requestId: z.uuid(), input: agentSessionInputSchema }).strict();
export type AgentInputControlReceipt = z.infer<typeof agentInputControlReceiptSchema>;
export const agentSessionSnapshotSchema = z.object({ session: agentRuntimeSessionSchema, automaticWakeBlocked: z.string().nullable(),
  turns: z.array(agentTurnSchema), inputs: z.array(agentSessionInputSchema), steps: z.array(agentStepSchema),
  attempts: z.array(agentAttemptSchema), toolCalls: z.array(agentToolCallSchema), questions: z.array(agentQuestionSchema),
  notifications: z.array(agentNotificationSchema) }).strict();
export type AgentSessionSnapshot = z.infer<typeof agentSessionSnapshotSchema>;
export interface AgentSessionReadPort {
  sessionSnapshot(identity: SpaceIdentity, sessionId: string): Promise<AgentSessionSnapshot>;
}
const envelope = z.object({ version: z.literal(3), identity: spaceIdentitySchema, sessionId: z.uuid() }).strict();
const turnArgs = z.object({ turnId: z.uuid() }).strict();
const controlArgs = turnArgs.extend({ requestId: z.uuid() }).strict();
export const taskTerminalFactSchema = z.object({ taskId: z.string().min(1).max(200), taskVersion: z.string().min(1).max(200),
  terminalStatus: z.enum(['success', 'failed', 'cancelled']), summary: z.string().max(2000), resultRef: z.string().max(300).nullable() }).strict();
export type TaskTerminalFact = z.infer<typeof taskTerminalFactSchema>;

/** Names are presentation; these four fields fix the authenticated subject. */
export function sameAgentSubject(a: SpaceIdentity, b: SpaceIdentity): boolean {
  return a.environmentId === b.environmentId && a.spaceId === b.spaceId
    && a.principalId === b.principalId && a.kind === b.kind;
}

export const agentSessionCallSchema = z.discriminatedUnion('operation', [
  envelope.extend({ operation: z.literal('initialize'), args: z.object({ session: agentRuntimeSessionSchema }).strict() }),
  envelope.extend({ operation: z.literal('submit'), args: z.object({ input: agentInputSchema }).strict() }),
  envelope.extend({ operation: z.literal('answerQuestion'), args: z.object({ response: agentQuestionResponseSchema }).strict() }),
  envelope.extend({ operation: z.literal('stop'), args: controlArgs }),
  envelope.extend({ operation: z.literal('continueSession'), args: z.object({ requestId: z.uuid() }).strict() }),
  envelope.extend({ operation: z.literal('turn'), args: turnArgs }),
  envelope.extend({ operation: z.literal('conversation'), args: z.object({ after: z.number().int().nonnegative().default(0) }).strict() }),
  envelope.extend({ operation: z.literal('events'), args: z.object({ after: z.number().int().nonnegative().default(0) }).strict() }),
  envelope.extend({ operation: z.literal('sessionSnapshot'), args: z.object({}).strict() }),
  envelope.extend({ operation: z.literal('request'), args: z.object({ requestId: z.uuid() }).strict() }),
  envelope.extend({ operation: z.literal('inputControl'), args: z.object({ inputId: z.uuid(), control: agentInputControlSchema }).strict() }),
  envelope.extend({ operation: z.literal('registerNotification'), args: z.object({ originTurnId: z.uuid(), fact: taskTerminalFactSchema }).strict() }),
  envelope.extend({ operation: z.literal('recordProgress'), args: z.object({ attemptId: z.uuid(), progress: z.object({ thinking: z.string().max(16000).optional(), revision: z.number().int().positive(), text: z.string().max(1_000_000), tools: z.array(z.json()).max(128).optional() }).strict() }).strict() }),
  envelope.extend({ operation: z.literal('assertDispatch'), args: z.object({ permit: agentDispatchPermitSchema }).strict() }),
]).superRefine((call, context) => {
  if (call.operation === 'submit' && call.args.input.sessionId !== call.sessionId)
    context.addIssue({ code: 'custom', path: ['args', 'input', 'sessionId'], message: 'Input belongs to another session.' });
  if (call.operation === 'assertDispatch' && call.args.permit.sessionId !== call.sessionId)
    context.addIssue({ code: 'custom', path: ['args', 'permit', 'sessionId'], message: 'Permit belongs to another session.' });
  if (call.operation === 'initialize' && (call.args.session.sessionId !== call.sessionId || !sameAgentSubject(call.args.session.identity, call.identity)))
    context.addIssue({ code: 'custom', path: ['args', 'session'], message: 'Initialization must preserve the authenticated session scope.' });
});
export type AgentSessionCall = z.infer<typeof agentSessionCallSchema>;
export type BrowserAgentSessionCall = Exclude<AgentSessionCall, { operation: 'initialize' | 'registerNotification' | 'recordProgress' | 'assertDispatch' }>;

export const agentAcceptedRequestSchema = z.object({ receipt: agentInputReceiptSchema, input: agentInputSchema }).strict()
  .refine(value => value.receipt.sessionId === value.input.sessionId && value.receipt.requestId === value.input.requestId);
export type AgentAcceptedRequest = z.infer<typeof agentAcceptedRequestSchema>;

export const agentConversationMessageSchema = z.object({
  messageId: z.string().min(1).max(300), turnId: z.uuid(), inputId: z.uuid().optional(),
  /** Assistant messages keep the Step/Attempt that produced this exact answer, never a Turn aggregate. */
  stepId: z.uuid().optional(), attemptId: z.uuid().optional(),
  role: z.enum(['user', 'assistant']), text: z.string(), createdAt: z.iso.datetime(), editedAt: z.iso.datetime().optional(),
  state: z.enum(['streaming', 'settled', 'failed', 'stopped']),
}).strict();
export const agentConversationInputSchema = z.object({
  canEdit: z.boolean().optional(),
  inputId: z.uuid(), turnId: z.uuid(), version: z.number().int().positive(),
  state: z.enum(['pending', 'adopted', 'removed', 'deferred']), text: z.string(), createdAt: z.iso.datetime(),
}).strict();
export const agentConversationToolSchema = z.object({
  toolCallId: z.uuid(), turnId: z.uuid(), stepId: z.uuid(), name: z.string().min(1).max(200),
  state: z.enum(['pending', 'started', 'closed']), result: z.json().nullable(),
  stepNo: z.number().int().positive().optional(), createdAt: z.iso.datetime().optional(),
  inputId: z.uuid().optional(), skill: teachingSkillLoadedSchema.optional(),
}).strict();
/** Product projection, independent of debug snapshots and provider SDK response shapes. */
export const agentConversationSchema = z.object({
  reset: z.boolean().optional(),
  thinking: z.array(z.object({ messageId: z.string(), turnId: z.uuid(), inputId: z.uuid().optional(),
    stepId: z.uuid().optional(), stepNo: z.number().int().positive().optional(),
    text: z.string(), createdAt: z.iso.datetime(), active: z.boolean() })).optional(),
  contextUsage: z.object({ model: z.object({ connectionId: z.uuid(), version: z.number().int().positive() }), tokens: z.number().int().nonnegative(), lowerBound: z.boolean() }).optional(),
  sessionId: z.uuid(), lastSeq: z.number().int().nonnegative(), messages: z.array(agentConversationMessageSchema),
  turns: z.array(agentTurnSchema), inputs: z.array(agentConversationInputSchema), questions: z.array(agentQuestionSchema),
  tools: z.array(agentConversationToolSchema),
  workspaces: z.array(z.object({ toolCallId: z.uuid(), turnId: z.uuid(), workspace: facts }).strict()),
  citations: z.array(z.object({ citation: agentCitationSchema, toolCallId: z.uuid().optional(), turnId: z.uuid(),
    stepId: z.uuid(), attemptId: z.uuid().optional(), inputId: z.uuid().optional() }).strict()).optional(),
}).strict();
export type AgentConversation = z.infer<typeof agentConversationSchema>;

/** Public wire port, independent of the core implementation and Node host types. */
export interface AgentSessionPort {
  initialize(session: AgentRuntimeSession): Promise<AgentRuntimeSession>;
  submit(identity: SpaceIdentity, input: AgentInput): Promise<AgentInputReceipt>;
  answerQuestion(identity: SpaceIdentity, sessionId: string, response: AgentQuestionResponse): Promise<AgentQuestionReceipt>;
  stop(identity: SpaceIdentity, sessionId: string, turnId: string, requestId: string): Promise<AgentTurn>;
  continueSession(identity: SpaceIdentity, sessionId: string, requestId: string): Promise<AgentTurn>;
  turn(identity: SpaceIdentity, sessionId: string, turnId: string): Promise<AgentTurn>;
  conversation(identity: SpaceIdentity, sessionId: string, after?: number): Promise<AgentConversation>;
  events(identity: SpaceIdentity, sessionId: string, after?: number): Promise<AgentEvent[]>;
  sessionSnapshot(identity: SpaceIdentity, sessionId: string): Promise<AgentSessionSnapshot>;
  request(identity: SpaceIdentity, sessionId: string, requestId: string): Promise<AgentAcceptedRequest | null>;
  inputControl(identity: SpaceIdentity, sessionId: string, inputId: string, control: AgentInputControl): Promise<AgentInputControlReceipt>;
  registerNotification(identity: SpaceIdentity, sessionId: string, originTurnId: string, fact: TaskTerminalFact): Promise<{ notificationId: string; turnId: string | null }>;
  recordProgress(identity: SpaceIdentity, sessionId: string, attemptId: string, progress: { revision: number; text: string; thinking?: string; tools?: readonly unknown[] }): Promise<boolean>;
  /** Live-Step check for a cross-machine adapter; not a loop phase and not a browser operation. */
  assertDispatch(identity: SpaceIdentity, permit: AgentDispatchPermit): Promise<null>;
}
export type AgentSessionBackend = Omit<AgentSessionPort, 'request' | 'conversation' | 'inputControl' | 'assertDispatch'>
  & Partial<Pick<AgentSessionPort, 'request' | 'conversation' | 'inputControl' | 'assertDispatch'>>;

export const agentSessionResultSchemas = {
  initialize: agentRuntimeSessionSchema, submit: agentInputReceiptSchema, answerQuestion: agentQuestionReceiptSchema,
  stop: agentTurnSchema, continueSession: agentTurnSchema, turn: agentTurnSchema,
  conversation: agentConversationSchema, events: z.array(agentEventSchema), sessionSnapshot: agentSessionSnapshotSchema,
  request: agentAcceptedRequestSchema.nullable(), inputControl: agentInputControlReceiptSchema,
  registerNotification: z.object({ notificationId: z.uuid(), turnId: z.uuid().nullable() }).strict(),
  recordProgress: z.boolean(),
  assertDispatch: z.null(),
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
    case 'submit': {
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
        && receipt.input.input.sessionId === call.sessionId && receipt.input.version === call.args.control.expectedVersion + 1; break;
    }
    case 'stop': case 'turn': {
      const turn = agentTurnSchema.parse(result);
      matches = turn.sessionId === call.sessionId && turn.turnId === call.args.turnId; break;
    }
    case 'answerQuestion': {
      const receipt = agentQuestionReceiptSchema.parse(result);
      matches = receipt.questionId === call.args.response.questionId; break;
    }
    case 'assertDispatch': matches = call.args.permit.sessionId === call.sessionId; break;
    case 'conversation': matches = agentConversationSchema.parse(result).sessionId === call.sessionId; break;
    case 'sessionSnapshot': matches = agentSessionSnapshotSchema.parse(result).session.sessionId === call.sessionId; break;
    case 'events': {
      const events = z.array(agentEventSchema).parse(result);
      matches = events.every((event, index) => event.sessionId === call.sessionId && event.seq > (events[index - 1]?.seq ?? call.args.after)); break;
    }
  }
  z.custom<boolean>(value => value === true, 'Result does not match the requested session operation.').parse(matches);
  return result as AgentSessionResults[C['operation']];
}
