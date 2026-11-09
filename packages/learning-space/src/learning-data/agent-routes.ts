import { createHash } from 'node:crypto';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { teachingAgentBindingSchema, type TeachingAgentBinding } from '@xunjie/contracts/teaching-agent';
import { activitySchema } from '@xunjie/contracts/learning-data';

export const activityAgentRouteMigration: Migration = { version: 18, name: 'fixed-activity-agent-owners', sql: `
  CREATE TABLE activity_agent_routes(activity_id uuid PRIMARY KEY REFERENCES activities(id),body jsonb NOT NULL);
` };

/** New member configuration never rewrites the owner of an existing activity. */
export function createActivityAgentRoutes(storage: OwnedStorage, activity: (identity: SpaceIdentity, activityId: string) => Promise<unknown>,
  readOnly: () => Promise<boolean> = async () => false) {
  async function read(identity: SpaceIdentity, activityId: string) {
    await activity(identity, activityId);
    const { rows: [row] } = await storage.read('SELECT body FROM activity_agent_routes WHERE activity_id=$1', [activityId]);
    return row ? teachingAgentBindingSchema.parse(row.body) : null;
  }
  return {
    read,
    /** Original owner cleanup needs the stored scope, even after course access has been withdrawn. */
    async readForCleanup(identity: SpaceIdentity, activityId: string) {
      const { rows: [activity] } = await storage.read('SELECT body FROM activities WHERE id=$1', [activityId]);
      if (!activity) throw new StorageError('missing');
      const original = activitySchema.parse(activity.body);
      if (original.identity.environmentId !== identity.environmentId || original.identity.spaceId !== identity.spaceId
        || original.identity.principalId !== identity.principalId) throw new StorageError('forbidden');
      const { rows: [row] } = await storage.read('SELECT body FROM activity_agent_routes WHERE activity_id=$1', [activityId]);
      return row ? teachingAgentBindingSchema.parse(row.body) : null;
    },
    async resolve(identity: SpaceIdentity, activityId: string, proposed: () => Promise<TeachingAgentBinding>): Promise<TeachingAgentBinding> {
      const saved = await read(identity, activityId);
      if (saved) return saved;
      const binding = teachingAgentBindingSchema.parse(await proposed());
      if (await readOnly()) return binding;
      const receipt = await storage.request({ requestId: 'activity-agent-route:'+activityId,
        fingerprint: createHash('sha256').update(JSON.stringify([identity, activityId])).digest('hex') }, async tx => {
        await tx.query('INSERT INTO activity_agent_routes VALUES($1,$2) ON CONFLICT DO NOTHING', [activityId, binding]);
        const { rows: [saved] } = await tx.query('SELECT body FROM activity_agent_routes WHERE activity_id=$1', [activityId]);
        if (!saved) throw new StorageError('corrupt');
        return saved.body;
      });
      return teachingAgentBindingSchema.parse(receipt.result);
    },
    validate: () => validateActivityAgentRoutes(storage),
  };
}

export async function validateActivityAgentRoutes(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT body FROM activity_agent_routes');
  rows.forEach(row => teachingAgentBindingSchema.parse(row.body));
}
