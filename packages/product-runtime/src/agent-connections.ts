import { StorageError } from '@xunjie/storage';
import type { RuntimeConnection, RuntimeService } from '@xunjie/contracts/product-runtime';
import { storageErrorCodes } from '@xunjie/contracts/storage';
import { z } from 'zod';
import { join } from 'node:path';
import { createOutboundConnection, RuntimeConnectionError } from './connections.js';
import { readJson } from './io.js';
import { resolveCredential } from './postgres.js';
import type { InstalledConfiguration } from './runtime.js';
import { createChunkClient } from '@xunjie/learning-space';

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
      || original && JSON.stringify(original) !== JSON.stringify(connection)) throw new StorageError('identity-conflict');
    original ??= structuredClone(connection);
    try {
      const result = await createOutboundConnection({ connection: original, credential: () => resolveCredential(root, original!.credentialRef),
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
  return async (payload: unknown) => {
    const value = await chunked(payload, { inline: true, acknowledge: true });
    const error = failure.safeParse(value);
    if (error.success) throw new StorageError(error.data.error);
    return value;
  };
}
