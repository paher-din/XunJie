import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import { createChunkChannel, chunkChannelMigrationSql } from '@xunjie/storage/chunk-channel';
import { collectSources, ownerSourceClosureSchema, type OwnerSourceClosure } from '@xunjie/storage/source-closure';
import { agentRuntimeMigrations, collectAgentRuntimeSources, validateAgentRuntime } from '@xunjie/agent-runtime';
import { agentSessionCallSchema } from '@xunjie/contracts/agent-service';

/** The application composes transport storage; the generic kernel remains unaware of RPC. */
export const agentServiceMigrations: readonly Migration[] = [...agentRuntimeMigrations,
  { version: agentRuntimeMigrations.length + 1, name: 'agent-session-transport-v2', sql: chunkChannelMigrationSql }];
export const agentServiceSourceOwner = 'xunjie.agent-service';
export function isAgentSessionRead(value: unknown) {
  const call = agentSessionCallSchema.safeParse(value);
  return call.success && ['run', 'conversation', 'events', 'snapshot', 'request', 'assertDispatch'].includes(call.data.operation);
}
const transportSpecs = [
  { table: 'agent_chunk_transfers', kind: 'agent_chunk_transfers', id: ['source_key', 'transfer_id'], version: ['state'] },
  { table: 'agent_chunk_parts', kind: 'agent_chunk_parts', id: ['source_key', 'transfer_id', 'direction', 'part_index'], version: ['sha256'] },
];
export async function validateAgentServiceStorage(storage: OwnedStorage) {
  await validateAgentRuntime(storage);
  await createChunkChannel(storage).validate(isAgentSessionRead);
}
export async function collectAgentServiceSources(storage: OwnedStorage): Promise<OwnerSourceClosure> {
  await validateAgentServiceStorage(storage);
  const runtime = await collectAgentRuntimeSources(storage);
  const transport = await collectSources(storage, agentServiceSourceOwner, transportSpecs);
  const entries = [...runtime.entries.map(entry => ({ ...entry, owner: agentServiceSourceOwner })), ...transport.entries]
    .sort((a, b) => canonicalDigest(a).localeCompare(canonicalDigest(b)));
  return { ...transport, entries };
}
export async function validateAgentServiceSources(storage: OwnedStorage, value: unknown) {
  const parsed = ownerSourceClosureSchema.safeParse(value);
  if (!parsed.success || canonicalDigest(parsed.data) !== canonicalDigest(await collectAgentServiceSources(storage))) throw new StorageError('corrupt');
}
