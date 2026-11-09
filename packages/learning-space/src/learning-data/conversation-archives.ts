import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { activitySchema, conversationArchiveStateSchema, conversationArchiveSetSchema,
  conversationArchiveImportSchema, type ConversationArchiveState } from '@xunjie/contracts/learning-data';

// The UI branch originally used 25 before teaching artifacts landed on main.
export const conversationArchiveMigration: Migration = { version: 26, formerVersion: 25, name: 'subject-conversation-archives', sql: `
  CREATE TABLE conversation_archives(activity_id uuid PRIMARY KEY REFERENCES activities(id),
    space_environment_id uuid NOT NULL,space_id uuid NOT NULL,principal_id uuid NOT NULL,archived boolean NOT NULL);
  CREATE INDEX conversation_archives_scope ON conversation_archives(space_environment_id,space_id,principal_id);
` };
const scope = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The activity row serializes set/import even before an archive row exists. False rows are retained forever. */
export function createConversationArchives(storage: OwnedStorage, authorize: (identity: SpaceIdentity) => Promise<unknown>) {
  async function read(identity: SpaceIdentity): Promise<ConversationArchiveState> {
    await authorize(identity);
    const { rows } = await storage.read(`SELECT activity_id FROM conversation_archives
      WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3 AND archived=true ORDER BY activity_id`, scope(identity));
    return conversationArchiveStateSchema.parse({ archivedIds: rows.map(row => row.activity_id) });
  }
  async function set(identity: SpaceIdentity, value: unknown): Promise<ConversationArchiveState> {
    await authorize(identity);
    const input = conversationArchiveSetSchema.parse(value);
    // A cached request must still pass current object ownership checks.
    const { rows: [row] } = await storage.read(`SELECT body FROM activities
      WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4`, [...scope(identity), input.activityId]);
    if (!row) throw new StorageError('missing');
    if (activitySchema.parse(row.body).course) throw new StorageError('forbidden');
    await storage.request({ requestId: `conversation-archives:${digest(scope(identity))}:${input.requestId}`,
      fingerprint: digest({ scope: scope(identity), operation: 'set', input }) }, async tx => {
      const { rows: [locked] } = await tx.query(`SELECT body FROM activities
        WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4 FOR UPDATE`, [...scope(identity), input.activityId]);
      if (!locked) throw new StorageError('missing');
      if (activitySchema.parse(locked.body).course) throw new StorageError('forbidden');
      const updated = await tx.query(`INSERT INTO conversation_archives VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(activity_id) DO UPDATE SET archived=EXCLUDED.archived
        WHERE conversation_archives.space_environment_id=EXCLUDED.space_environment_id
          AND conversation_archives.space_id=EXCLUDED.space_id AND conversation_archives.principal_id=EXCLUDED.principal_id`,
      [input.activityId, ...scope(identity), input.archived]);
      if (updated.rowCount !== 1) throw new StorageError('corrupt');
      return null;
    });
    // Never return a historical list from the receipt after another browser has changed it.
    return read(identity);
  }
  async function importLegacy(identity: SpaceIdentity, value: unknown): Promise<ConversationArchiveState> {
    await authorize(identity);
    const input = conversationArchiveImportSchema.parse(value);
    await storage.request({ requestId: `conversation-archives:${digest(scope(identity))}:${input.requestId}`,
      fingerprint: digest({ scope: scope(identity), operation: 'import', input }) }, async tx => {
      // Stale browser IDs may be missing, foreign or course-bound: omit them without disclosing their existence.
      // Sort locks across overlapping imports to avoid opposite-order deadlocks.
      const { rows } = await tx.query(`SELECT id,body FROM activities WHERE space_environment_id=$1 AND space_id=$2
        AND principal_id=$3 AND id=ANY($4::uuid[]) ORDER BY id FOR UPDATE`, [...scope(identity), input.activityIds]);
      for (const row of rows) {
        if (activitySchema.parse(row.body).course) continue;
        await tx.query(`INSERT INTO conversation_archives VALUES($1,$2,$3,$4,true) ON CONFLICT(activity_id) DO NOTHING`,
          [row.id, ...scope(identity)]);
      }
      return null;
    });
    return read(identity);
  }
  return { read, set, import: importLegacy };
}

/** Recovery validates tombstones as well as archived rows against the original activity's full subject. */
export async function validateConversationArchives(storage: OwnedStorage) {
  const { rows } = await storage.read(`SELECT c.*,a.body FROM conversation_archives c LEFT JOIN activities a ON a.id=c.activity_id`);
  for (const row of rows) {
    const parsed = activitySchema.safeParse(row.body);
    if (!parsed.success || !z.boolean().safeParse(row.archived).success) throw new StorageError('corrupt');
    const activity = parsed.data;
    if (activity.course || activity.activityId !== row.activity_id
      || activity.identity.environmentId !== row.space_environment_id || activity.identity.spaceId !== row.space_id
      || activity.identity.principalId !== row.principal_id || activity.target.environmentId !== storage.owner.environmentId
      || activity.target.serviceId !== storage.owner.serviceId) throw new StorageError('corrupt');
  }
}
