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
import { createChunkClient } from '@xunjie/learning-space';
import { withAgentTransfer } from './agent-transfer-journal.js';
import { teachingDispatchAuthoritySchema } from '@xunjie/contracts/teaching-agent';

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
    // These pure queries have bounded replies (identity or void) and must always
    // check current authority. Keeping them out of the effect journal also avoids
    // multiplying reverse authorization calls into several durable round trips.
    const operation = (payload as { operation?: string }).operation;
    if (['authorize', 'identityFor', 'assertCommandDispatch', 'assertModelDispatch'].includes(operation ?? ''))
      return send(payload);
    const config = await readJson<InstalledConfiguration>(join(root, 'installation.json'));
    const environment = await readJson<RuntimeEnvironment>(join(root, 'environment.json'));
    const connection = config.connections.find(item => item.connectionId === connectionId);
    if (!connection) throw new StorageError('unavailable');
    const token = await resolveCredential(root, connection.credentialRef);
    const grantId = z.uuid().parse(token.split('.')[0]);
    const input = payload as { operation?: string; authority?: unknown; args?: Array<Record<string, unknown>> };
    const guardArgument = input.operation === 'assertModelDispatch' ? input.args?.[0] : undefined;
    const authority = input.authority !== undefined ? teachingDispatchAuthoritySchema.parse(input.authority)
      : guardArgument ? teachingDispatchAuthoritySchema.parse({ runId: guardArgument.runId, activityId: guardArgument.activityId,
        driverId: guardArgument.driverId, generation: guardArgument.generation })
      : input.operation === 'assertCommandDispatch' && input.args?.[0]?.authority
        ? teachingDispatchAuthoritySchema.parse(input.args[0].authority) : undefined;
    let recheckAuthorization = false;
    const value = await withAgentTransfer({ root, connection, capability, installationId: environment.installationId, grantId, payload },
      async (entry, receive, context) => {
        const modelOperation = input.operation === 'model' ? input.args?.[0]?.operation : undefined;
        recheckAuthorization = context.reused && (['activity', 'switchModel'].includes(input.operation ?? '')
          || modelOperation === 'selection.pin');
        if (entry.state !== 'pending') {
          // A lost ack is retried from a durable, complete local result. It cannot create a
          // fresh transfer or invoke the business handler again, including after process death.
          await send({ chunkChannel: 1, operation: 'ack', transferId: entry.transferId, origin: entry.origin });
          // Activity and pinned model/switch receipts require current authorization.
          // Their domain IDs make rechecking an already completed operation idempotent;
          // consume the original transport before asking the domain to check again.
          return entry.result === null && capability === 'teaching.agent' && operation === 'conversation'
            ? retryQuery : entry.result;
        }
        if (entry.origin.grantId !== grantId || entry.origin.sourceInstallationId !== environment.installationId) {
          try { await send({ chunkChannel: 1, operation: 'metadata', transferId: entry.transferId, origin: entry.origin }); }
          catch (error) {
            if (!(error instanceof StorageError) || error.code !== 'missing') throw error;
            // The authenticated original owner confirmed absence. Keep the transport ID
            // and fixed body, and durably move only this never-received transfer to the
            // current grant. Unknown/existing transfers always retain their old namespace.
            await context.rebindOrigin({ grantId, sourceEnvironmentId: connection.sourceEnvironmentId,
              sourceServiceId: connection.sourceServiceId, sourceInstallationId: environment.installationId });
          }
        }
        const read = () => chunked(entry.payload, { transferId: entry.transferId, durable: true, origin: entry.origin,
          ...(authority ? { authority } : {}), receive, acknowledge: true });
        try { return await read(); }
        catch (error) {
          if (!recoverQuery || capability !== 'teaching.agent' || operation !== 'conversation'
            || !(error instanceof StorageError) || !['commit-unknown', 'conflict'].includes(error.code)) throw error;
          // The original owner reconstructs and authorizes the retained input before it may
          // retire a pure query. Effects keep their original unknown transport and never retry.
          const state = await send({ chunkChannel: 1, operation: 'discard-query', transferId: entry.transferId,
            origin: entry.origin }) as { state?: string };
          if (state.state !== 'acknowledged') return read();
          await receive(null);
          return retryQuery;
        }
      });
    if (value === retryQuery) return invoke(payload, false);
    if (recheckAuthorization) return invoke(payload);
    const error = failure.safeParse(value);
    if (error.success) throw new StorageError(error.data.error);
    return value;
  };
  return invoke;
}
