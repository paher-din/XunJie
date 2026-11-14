import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { agentSessionCallSchema, agentSessionOperationSchema, parseAgentSessionResult,
  type AgentSessionBackend, type AgentSessionCall, type AgentSessionPort, type AgentSessionResults,
  type BrowserAgentSessionCall } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { AgentDispatchPermit, AgentRuntimeSession } from '@xunjie/contracts/agent-runtime';

export interface AgentSessionServiceOptions {
  /** Fixed by the authenticated host, never read from a call or browser request body. */
  audience: 'browser' | 'service';
  authorize(identity: SpaceIdentity, sessionId: string, operation: AgentSessionCall['operation']): Promise<void>;
  authorizeInitialize?(session: AgentRuntimeSession): Promise<void>;
  authorizeResolveWait?(identity: SpaceIdentity, sessionId: string): Promise<void>;
  authorizeDispatchPermit?(identity: SpaceIdentity, permit: AgentDispatchPermit): Promise<void>;
}
const header = z.object({ version: z.literal(2), operation: agentSessionOperationSchema }).passthrough();
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

export function createAgentSessionService(agent: AgentSessionBackend, options: AgentSessionServiceOptions) {
  if (!['browser', 'service'].includes(options.audience)) throw new StorageError('invalid');
  return async (value: unknown): Promise<AgentSessionResults[AgentSessionCall['operation']]> => {
    const call = parseCall(value), { identity, sessionId } = call;
    // Reject unavailable operations and privileged browser operations before any owner call.
    if (call.operation === 'initialize' && (options.audience !== 'service' || !options.authorizeInitialize)) throw new StorageError('forbidden');
    if (call.operation === 'resolveWait' && (options.audience !== 'service' || !options.authorizeResolveWait)) throw new StorageError('forbidden');
    if (call.operation === 'assertDispatch' && (options.audience !== 'service' || !options.authorizeDispatchPermit)) throw new StorageError('forbidden');
    if (typeof agent[call.operation] !== 'function') throw new StorageError('incompatible');
    await options.authorize(identity, sessionId, call.operation);
    let output: unknown;
    switch (call.operation) {
      case 'initialize':
        await options.authorizeInitialize!(call.args.session);
        output = await agent.initialize(call.args.session); break;
      case 'accept': output = await agent.accept(identity, call.args.input); break;
      case 'run': output = await agent.run(identity, sessionId, call.args.runId); break;
      case 'conversation': output = await agent.conversation!(identity, sessionId, call.args.after); break;
      case 'events': output = await agent.events(identity, sessionId, call.args.after); break;
      case 'stop': output = await agent.stop(identity, sessionId, call.args.runId, call.args.requestId); break;
      case 'continueRun': output = await agent.continueRun(identity, sessionId, call.args.runId, call.args.requestId); break;
      case 'snapshot': output = await agent.snapshot(identity, sessionId, call.args.runId); break;
      case 'respond': output = await agent.respond(identity, sessionId, call.args.response); break;
      case 'resolveWait':
        await options.authorizeResolveWait!(identity, sessionId);
        output = await agent.resolveWait(identity, sessionId, call.args.resolution); break;
      case 'request': output = await agent.request!(identity, sessionId, call.args.requestId); break;
      case 'inputControl': output = await agent.inputControl!(identity, sessionId, call.args.inputId, call.args.control); break;
      case 'assertDispatch':
        await options.authorizeDispatchPermit!(identity, call.args.permit);
        await agent.assertDispatch!(identity, call.args.permit);
        output = call.args.permit; break;
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
    initialize: session => invoke({ version: 2, operation: 'initialize', identity: session.identity, sessionId: session.sessionId, args: { session } }),
    accept: (identity, input) => invoke({ version: 2, operation: 'accept', identity, sessionId: input.sessionId, args: { input } }),
    run: (identity, sessionId, runId) => invoke({ version: 2, operation: 'run', identity, sessionId, args: { runId } }),
    conversation: (identity, sessionId, after = 0) => invoke({ version: 2, operation: 'conversation', identity, sessionId, args: { after } }),
    events: (identity, sessionId, after = 0) => invoke({ version: 2, operation: 'events', identity, sessionId, args: { after } }),
    stop: (identity, sessionId, runId, requestId) => invoke({ version: 2, operation: 'stop', identity, sessionId, args: { runId, requestId } }),
    continueRun: (identity, sessionId, runId, requestId) => invoke({ version: 2, operation: 'continueRun', identity, sessionId, args: { runId, requestId } }),
    snapshot: (identity, sessionId, runId) => invoke({ version: 2, operation: 'snapshot', identity, sessionId, args: { runId } }),
    respond: (identity, sessionId, response) => invoke({ version: 2, operation: 'respond', identity, sessionId, args: { response } }),
    resolveWait: (identity, sessionId, resolution) => invoke({ version: 2, operation: 'resolveWait', identity, sessionId, args: { resolution } }),
    request: (identity, sessionId, requestId) => invoke({ version: 2, operation: 'request', identity, sessionId, args: { requestId } }),
    inputControl: (identity, sessionId, inputId, control) => invoke({ version: 2, operation: 'inputControl', identity, sessionId, args: { inputId, control } }),
    async assertDispatch(identity, permit) {
      await invoke({ version: 2, operation: 'assertDispatch', identity, sessionId: permit.sessionId,
        args: { permit, attemptId: permit.operationId } });
    },
  };
}

/** The HTTP host supplies identity and sessionId after authentication; this helper never derives them. */
export function createBrowserAgentSessionCall<O extends BrowserAgentSessionCall['operation']>(identity: SpaceIdentity, sessionId: string,
  operation: O, args: Extract<BrowserAgentSessionCall, { operation: O }>['args']): BrowserAgentSessionCall {
  const call = parseCall({ version: 2, identity, sessionId, operation, args });
  if (call.operation === 'initialize' || call.operation === 'resolveWait' || call.operation === 'assertDispatch') throw new StorageError('forbidden');
  return call;
}
