import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { agentSessionCallSchema, agentSessionOperationSchema, parseAgentSessionResult,
  type AgentSessionBackend, type AgentSessionCall, type AgentSessionPort, type AgentSessionResults,
  type BrowserAgentSessionCall } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { AgentRuntimeSession } from '@xunjie/contracts/agent-runtime';

export interface AgentSessionServiceOptions {
  /** Fixed by the authenticated host, never read from a call or browser request body. */
  audience: 'browser' | 'service';
  authorize(identity: SpaceIdentity, sessionId: string, operation: AgentSessionCall['operation']): Promise<void>;
  authorizeInitialize?(session: AgentRuntimeSession): Promise<void>;
  /** Notification bridge and progress recording are privileged service operations. */
  authorizeService?(identity: SpaceIdentity, sessionId: string): Promise<void>;
}
const header = z.object({ version: z.literal(3), operation: agentSessionOperationSchema }).passthrough();
function parseCall(value: unknown): AgentSessionCall {
  if (!header.safeParse(value).success) throw new StorageError('incompatible');
  const parsed = agentSessionCallSchema.safeParse(value);
  if (!parsed.success) throw new StorageError('invalid');
  return parsed.data;
}
function result<C extends AgentSessionCall>(call: C, value: unknown): AgentSessionResults[C['operation']] {
  try { return parseAgentSessionResult(call, value); }
  catch { throw new StorageError('incompatible'); }
}

/** Product wiring only: the kernel owns the loop; this service exposes the v3 public entry. */
export function createAgentSessionService(agent: AgentSessionBackend, options: AgentSessionServiceOptions) {
  if (!['browser', 'service'].includes(options.audience)) throw new StorageError('invalid');
  return async (value: unknown): Promise<AgentSessionResults[AgentSessionCall['operation']]> => {
    const call = parseCall(value), { identity, sessionId } = call;
    if (call.operation === 'initialize' && (options.audience !== 'service' || !options.authorizeInitialize)) throw new StorageError('forbidden');
    if ((call.operation === 'registerNotification' || call.operation === 'recordProgress')
      && (options.audience !== 'service' || !options.authorizeService)) throw new StorageError('forbidden');
    if (typeof agent[call.operation] !== 'function') throw new StorageError('incompatible');
    await options.authorize(identity, sessionId, call.operation);
    let output: unknown;
    switch (call.operation) {
      case 'initialize':
        await options.authorizeInitialize!(call.args.session);
        output = await agent.initialize(call.args.session); break;
      case 'submit': output = await agent.submit(identity, call.args.input); break;
      case 'answerQuestion': output = await agent.answerQuestion(identity, sessionId, call.args.response); break;
      case 'stop': output = await agent.stop(identity, sessionId, call.args.turnId, call.args.requestId); break;
      case 'continueSession': output = await agent.continueSession(identity, sessionId, call.args.requestId); break;
      case 'turn': output = await agent.turn(identity, sessionId, call.args.turnId); break;
      case 'conversation': output = await agent.conversation!(identity, sessionId, call.args.after); break;
      case 'events': output = await agent.events(identity, sessionId, call.args.after); break;
      case 'sessionSnapshot': output = await agent.sessionSnapshot(identity, sessionId); break;
      case 'request': output = await agent.request!(identity, sessionId, call.args.requestId); break;
      case 'inputControl': output = await agent.inputControl!(identity, sessionId, call.args.inputId, call.args.control); break;
      case 'registerNotification':
        await options.authorizeService!(identity, sessionId);
        output = await agent.registerNotification(identity, sessionId, call.args.originTurnId, call.args.fact); break;
      case 'recordProgress': {
        await options.authorizeService!(identity, sessionId);
        const p = call.args.progress;
        output = await agent.recordProgress(identity, sessionId, call.args.attemptId,
          { revision: p.revision, text: p.text, ...(p.tools ? { tools: p.tools } : {}) }); break;
      }
      case 'assertDispatch': {
        if (typeof agent.assertDispatch !== 'function') throw new StorageError('incompatible');
        output = await agent.assertDispatch(identity, call.args.permit); break;
      }
    }
    return result(call, output);
  };
}

export function createAgentSessionClient(transport: (call: AgentSessionCall) => Promise<unknown>): AgentSessionPort {
  async function invoke<C extends AgentSessionCall>(call: C): Promise<AgentSessionResults[C['operation']]> {
    const parsed = parseCall(call);
    return result(call, await transport(parsed));
  }
  return {
    initialize: session => invoke({ version: 3, operation: 'initialize', identity: session.identity, sessionId: session.sessionId, args: { session } }),
    submit: (identity, input) => invoke({ version: 3, operation: 'submit', identity, sessionId: input.sessionId, args: { input } }),
    answerQuestion: (identity, sessionId, response) => invoke({ version: 3, operation: 'answerQuestion', identity, sessionId, args: { response } }),
    stop: (identity, sessionId, turnId, requestId) => invoke({ version: 3, operation: 'stop', identity, sessionId, args: { turnId, requestId } }),
    continueSession: (identity, sessionId, requestId) => invoke({ version: 3, operation: 'continueSession', identity, sessionId, args: { requestId } }),
    turn: (identity, sessionId, turnId) => invoke({ version: 3, operation: 'turn', identity, sessionId, args: { turnId } }),
    conversation: (identity, sessionId, after = 0) => invoke({ version: 3, operation: 'conversation', identity, sessionId, args: { after } }),
    events: (identity, sessionId, after = 0) => invoke({ version: 3, operation: 'events', identity, sessionId, args: { after } }),
    sessionSnapshot: (identity, sessionId) => invoke({ version: 3, operation: 'sessionSnapshot', identity, sessionId, args: {} }),
    request: (identity, sessionId, requestId) => invoke({ version: 3, operation: 'request', identity, sessionId, args: { requestId } }),
    inputControl: (identity, sessionId, inputId, control) => invoke({ version: 3, operation: 'inputControl', identity, sessionId, args: { inputId, control } }),
    registerNotification: (identity, sessionId, originTurnId, fact) => invoke({ version: 3, operation: 'registerNotification', identity, sessionId, args: { originTurnId, fact } }),
    recordProgress: (identity, sessionId, attemptId, progress) => invoke({ version: 3, operation: 'recordProgress', identity, sessionId,
      args: { attemptId, progress: { revision: progress.revision, text: progress.text,
        ...(progress.tools ? { tools: JSON.parse(JSON.stringify(progress.tools)) } : {}) } } }),
    assertDispatch: (identity, permit) => invoke({ version: 3, operation: 'assertDispatch', identity, sessionId: permit.sessionId, args: { permit } }),
  };
}

/** The HTTP host supplies identity and sessionId after authentication; this helper never derives them. */
export function createBrowserAgentSessionCall<O extends BrowserAgentSessionCall['operation']>(identity: SpaceIdentity, sessionId: string,
  operation: O, args: Extract<BrowserAgentSessionCall, { operation: O }>['args']): BrowserAgentSessionCall {
  const call = parseCall({ version: 3, identity, sessionId, operation, args });
  if (call.operation === 'initialize' || call.operation === 'registerNotification' || call.operation === 'recordProgress'
    || call.operation === 'assertDispatch') throw new StorageError('forbidden');
  return call;
}