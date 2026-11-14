import { StorageError } from '@xunjie/storage';
import type { RuntimeConnection, RuntimeService, RuntimeEnvironment } from '@xunjie/contracts/product-runtime';
import { fixedRuntimeConnectionDescriptor } from '@xunjie/contracts/product-runtime';
import { storageErrorCodes } from '@xunjie/contracts/storage';
import { z } from 'zod';
import { join } from 'node:path';
import { createOutboundConnection, RuntimeConnectionError } from './connections.js';
import { readJson } from './io.js';
import { resolveCredential } from './postgres.js';
import type { InstalledConfiguration } from './runtime.js';
import { createChunkClient } from '@xunjie/storage/chunk-channel';
import { withAgentTransfer } from './agent-transfer-journal.js';
import { agentSessionCallSchema } from '@xunjie/contracts/agent-service';
import { agentDependencyCallSchema, isAgentDependencyRead } from '@xunjie/contracts/agent-dependencies';

/** A connection id denotes one owner. Looking up current configuration cannot change it. */
export function createAgentConnection(root: string, connectionId: string, capability: string,
  expected?: Pick<RuntimeService, 'environmentId' | 'serviceId'>) {
  let original: RuntimeConnection | undefined;
  const failure = z.object({ error: z.enum(storageErrorCodes) }).strict();
  const send = async (payload: unknown): Promise<unknown> => {
    const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
    const connection = config.connections.find(item => item.connectionId === connectionId);
    if (!connection || !connection.requiredCapabilities.includes(capability)) throw new StorageError('unavailable');
    if (expected && (connection.target.environmentId !== expected.environmentId || connection.target.serviceId !== expected.serviceId)
      || original && JSON.stringify(fixedRuntimeConnectionDescriptor(original)) !== JSON.stringify(fixedRuntimeConnectionDescriptor(connection))) throw new StorageError('identity-conflict');
    original ??= structuredClone(connection);
    try {
      const result = await createOutboundConnection({ connection: original, credential: () => resolveCredential(root, connection.credentialRef),
        allowInsecureLoopback: true, timeoutMs: 15000 }).request(capability, payload);
      const error = failure.safeParse(result);
      if (error.success) throw new StorageError(error.data.error);
      return result;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(error instanceof RuntimeConnectionError && ['http_401', 'http_403'].includes(error.code) ? 'forbidden' : 'unavailable');
    }
  };
  const chunked = createChunkClient(send);
  const retryQuery = Symbol('retry-query');
  const invoke = async (payload: unknown, recoverQuery = true): Promise<unknown> => {
    if (!['agent.sessions.v2', 'agent.dependencies.v2'].includes(capability)
      || (payload as { version?: unknown })?.version !== 2) throw new StorageError('incompatible');
    const session = capability === 'agent.sessions.v2' ? agentSessionCallSchema.safeParse(payload) : undefined;
    const dependency = capability === 'agent.dependencies.v2' ? agentDependencyCallSchema.safeParse(payload) : undefined;
    const parsed = session ?? dependency!;
    if (!parsed.success) throw new StorageError('invalid');
    const call = parsed.data;
    payload = call;
    const readOnlyQuery = dependency?.success ? isAgentDependencyRead(dependency.data)
      : ['run', 'events', 'snapshot', 'request', 'conversation'].includes(call.operation);
    // Bounded authority checks always consult the original owner and never a saved receipt.
    if (call.operation === 'assertDispatch' || call.operation === 'authorize') return send(payload);
    // A pure owner query has no effect to recover. Small replies use one fresh call;
    // large replies still use bounded chunks and release their temporary bytes after decoding.
    if (readOnlyQuery) return chunked(payload, { inline: true, acknowledge: true });
    const authority = 'permit' in call ? call.permit : undefined;
    const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
    const environment = await readJson<RuntimeEnvironment>(join(root, 'environment.json'));
    const connection = config.connections.find(item => item.connectionId === connectionId);
    if (!connection || !connection.requiredCapabilities.includes(capability)) throw new StorageError('unavailable');
    const token = await resolveCredential(root, connection.credentialRef);
    const grantId = z.uuid().parse(token.split('.')[0]);
    const value = await withAgentTransfer({ root, connection, capability, installationId: environment.installationId, grantId, payload },
      async (entry, receive, context) => {
        const transport = { transferId: entry.transferId, origin: entry.origin, ...(authority ? { authority } : {}) };
        if (entry.state !== 'pending') {
          // Recheck current source/subject authority even when the local reply is durable.
          await send({ chunkChannel: 1, operation: 'ack', ...transport });
          return entry.result === null && readOnlyQuery ? retryQuery : entry.result;
        }
        if (entry.origin.grantId !== grantId || entry.origin.sourceInstallationId !== environment.installationId) {
          try { await send({ chunkChannel: 1, operation: 'metadata', ...transport }); }
          catch (error) {
            if (!(error instanceof StorageError) || error.code !== 'missing') throw error;
            await context.rebindOrigin({ grantId, sourceEnvironmentId: connection.sourceEnvironmentId,
              sourceServiceId: connection.sourceServiceId, sourceInstallationId: environment.installationId });
          }
        }
        const read = () => chunked(entry.payload, { transferId: entry.transferId, durable: true, origin: entry.origin,
          ...(authority ? { authority } : {}), receive, acknowledge: true });
        try { return await read(); }
        catch (error) {
          if (!recoverQuery || !readOnlyQuery || !(error instanceof StorageError)
            || !['commit-unknown', 'conflict'].includes(error.code)) throw error;
          const state = await send({ chunkChannel: 1, operation: 'discard-query', ...transport }) as { state?: string };
          if (state.state !== 'acknowledged') return read();
          await receive(null);
          return retryQuery;
        }
      });
    if (value === retryQuery) return invoke(payload, false);
    const error = failure.safeParse(value);
    if (error.success) throw new StorageError(error.data.error);
    return value;
  };
  return invoke;
}
