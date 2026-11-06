import { createHash } from 'node:crypto';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { teachingInteractionSettingsSchema, teachingInteractionSettingsInputSchema } from '@xunjie/contracts/teaching-agent';

export const agentPreferenceMigration: Migration = { version: 21, name: 'subject-owned-agent-interaction', sql: `
  CREATE TABLE agent_interaction_preferences(scope_key text PRIMARY KEY,subject jsonb NOT NULL,body jsonb NOT NULL);
` };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const subject = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId];
const defaults = { version: 0, busyInputMode: 'steering' as const };

/** Personal preferences belong to the member's learning owner, independent of an activity's Agent deployment. */
export function createAgentPreferences(storage: OwnedStorage, authorize: (identity: SpaceIdentity) => Promise<unknown>) {
  const key = (identity: SpaceIdentity) => digest(subject(identity));
  const requestKey = (identity: SpaceIdentity, requestId: string) => 'agent-preferences:' + key(identity) + ':' + requestId;
  return {
    async read(identity: SpaceIdentity) {
      await authorize(identity);
      const { rows: [row] } = await storage.read('SELECT body FROM agent_interaction_preferences WHERE scope_key=$1', [key(identity)]);
      return teachingInteractionSettingsSchema.parse(row?.body ?? defaults);
    },
    async save(identity: SpaceIdentity, value: unknown) {
      await authorize(identity);
      const input = teachingInteractionSettingsInputSchema.parse(value), scopeKey = key(identity);
      const receipt = await storage.request({ requestId: requestKey(identity, input.requestId), fingerprint: digest({ subject: subject(identity), input }) }, async tx => {
        await tx.query('INSERT INTO agent_interaction_preferences VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [scopeKey, JSON.stringify(subject(identity)), JSON.stringify(defaults)]);
        const { rows: [row] } = await tx.query('SELECT body FROM agent_interaction_preferences WHERE scope_key=$1 FOR UPDATE', [scopeKey]);
        const previous = teachingInteractionSettingsSchema.parse(row?.body);
        if (previous.version !== input.expectedVersion) throw new StorageError('conflict');
        const next = { version: previous.version + 1, busyInputMode: input.busyInputMode };
        await tx.query('UPDATE agent_interaction_preferences SET body=$2 WHERE scope_key=$1', [scopeKey, JSON.stringify(next)]);
        return next;
      });
      return teachingInteractionSettingsSchema.parse(receipt.result);
    },
    async receipt(identity: SpaceIdentity, requestId: string) {
      await authorize(identity);
      teachingInteractionSettingsInputSchema.shape.requestId.parse(requestId);
      const receipt = await storage.receipt(requestKey(identity, requestId));
      return receipt ? teachingInteractionSettingsSchema.parse(receipt.result) : null;
    },
  };
}

export async function validateAgentPreferences(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT * FROM agent_interaction_preferences');
  for (const row of rows) {
    if (digest(row.subject) !== row.scope_key) throw new StorageError('corrupt');
    teachingInteractionSettingsSchema.parse(row.body);
  }
}
