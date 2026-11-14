import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { createChunkChannel } from '@xunjie/storage/chunk-channel';
import { createAgentSessionService } from '@xunjie/agents/transport/session-service';
import { isAgentSessionRead } from '@xunjie/agents/transport/session-storage';
import { agentSessionCallSchema, type AgentSessionCall, type AgentSessionPort } from '@xunjie/contracts/agent-service';
import type { CapabilityHandler } from './connections.js';

type Source = Parameters<CapabilityHandler>[1];
export interface SessionHandlerOptions {
  storage: OwnedStorage;
  agent: AgentSessionPort;
  authorize(call: AgentSessionCall, source: Source): Promise<void>;
  successor?(original: Source, current: Source): Promise<boolean>;
  externalResults?: boolean;
}

/** Authenticated service RPC shares the same contract as local product calls. */
export function createAgentSessionHandler(options: SessionHandlerOptions): CapabilityHandler {
  function parse(value: unknown) {
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 2) throw new StorageError('incompatible');
    const call = agentSessionCallSchema.safeParse(value);
    if (!call.success) throw new StorageError('invalid');
    return call.data;
  }
  async function authorize(value: unknown, source: Source) {
    await source.assertAuthorized?.();
    await options.authorize(parse(value), source);
  }
  async function invoke(value: unknown, source: Source) {
    const call = parse(value);
    const service = createAgentSessionService(options.agent, { audience: 'service',
      authorize: () => authorize(call, source),
      authorizeInitialize: () => authorize(call, source),
      authorizeDispatchPermit: () => authorize(call, source),
      ...(options.externalResults ? { authorizeResolveWait: () => authorize(call, source) } : {}),
    });
    return service(call);
  }
  const chunked = createChunkChannel(options.storage).wrap(invoke, { authorize, readOnly: isAgentSessionRead,
    ...(options.successor ? { successor: options.successor } : {}) });
  return async (value, source) => {
    try {
      if (value && typeof value === 'object' && 'chunkChannel' in value) return await chunked(value, source);
      return await invoke(value, source);
    } catch (error) { return { error: error instanceof StorageError ? error.code : 'invalid' }; }
  };
}
