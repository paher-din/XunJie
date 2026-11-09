import { createHash } from 'node:crypto';
import { StorageError, type Migration, type OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { activitySchema, conversationHistoryItemSchema, conversationHistoryStateSchema,
  conversationHistoryUpdateSchema, type ConversationHistoryState } from '@xunjie/contracts/learning-data';

export const conversationHistoryMigration: Migration = { version: 27, name: 'subject-conversation-labels', sql: `
  CREATE UNIQUE INDEX activities_conversation_subject ON activities(id,space_environment_id,space_id,principal_id);
  CREATE TABLE conversation_labels(activity_id uuid PRIMARY KEY,
    space_environment_id uuid NOT NULL,space_id uuid NOT NULL,principal_id uuid NOT NULL,
    title text,pinned boolean NOT NULL DEFAULT false,deleted boolean NOT NULL DEFAULT false,
    FOREIGN KEY(activity_id,space_environment_id,space_id,principal_id)
      REFERENCES activities(id,space_environment_id,space_id,principal_id),
    CHECK(title IS NULL OR (length(btrim(title))>0 AND char_length(title)<=200)));
  CREATE INDEX conversation_labels_scope ON conversation_labels(space_environment_id,space_id,principal_id);
` };
const scope = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createConversationHistory(storage: OwnedStorage, authorize: (identity: SpaceIdentity) => Promise<unknown>) {
  async function read(identity: SpaceIdentity): Promise<ConversationHistoryState> {
    await authorize(identity);
    const { rows } = await storage.read(`SELECT a.id AS "activityId",l.title,
      COALESCE(l.pinned,false) AS pinned,COALESCE(l.deleted,false) AS deleted,COALESCE(c.archived,false) AS archived
      FROM activities a LEFT JOIN conversation_labels l ON l.activity_id=a.id
        AND l.space_environment_id=a.space_environment_id AND l.space_id=a.space_id AND l.principal_id=a.principal_id
      LEFT JOIN conversation_archives c ON c.activity_id=a.id
        AND c.space_environment_id=a.space_environment_id AND c.space_id=a.space_id AND c.principal_id=a.principal_id
      WHERE a.space_environment_id=$1 AND a.space_id=$2 AND a.principal_id=$3
        AND NOT (a.body ? 'course') AND (l.activity_id IS NOT NULL OR c.archived=true) ORDER BY a.id`, scope(identity));
    return conversationHistoryStateSchema.parse({ items: rows });
  }
  async function update(identity: SpaceIdentity, value: unknown): Promise<ConversationHistoryState> {
    await authorize(identity);
    const input = conversationHistoryUpdateSchema.parse(value);
    // Even a confirmed retry must pass current ownership and membership checks.
    const { rows: [row] } = await storage.read(`SELECT body FROM activities
      WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4`, [...scope(identity), input.activityId]);
    if (!row) throw new StorageError('missing');
    if (activitySchema.parse(row.body).course) throw new StorageError('forbidden');
    await storage.request({ requestId: `conversation-history:${digest(scope(identity))}:${input.requestId}`,
      fingerprint: digest({ scope: scope(identity), input }) }, async tx => {
      // The activity exists before the label does; all label/archive writers serialize on this row.
      const { rows: [locked] } = await tx.query(`SELECT body FROM activities
        WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3 AND id=$4 FOR UPDATE`, [...scope(identity), input.activityId]);
      if (!locked) throw new StorageError('missing');
      if (activitySchema.parse(locked.body).course) throw new StorageError('forbidden');
      const { rows: [label] } = await tx.query('SELECT deleted FROM conversation_labels WHERE activity_id=$1', [input.activityId]);
      if (label?.deleted && input.action !== 'delete') throw new StorageError('missing');
      // Update one field only: concurrent rename/pin cannot overwrite each other's values.
      const column = input.action === 'rename' ? 'title' : input.action === 'pin' ? 'pinned' : 'deleted';
      const next = input.action === 'rename' ? input.title : input.action === 'pin' ? input.pinned : true;
      const updated = await tx.query(`INSERT INTO conversation_labels(activity_id,space_environment_id,space_id,principal_id,${column})
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(activity_id) DO UPDATE SET ${column}=EXCLUDED.${column}
        WHERE conversation_labels.space_environment_id=EXCLUDED.space_environment_id
          AND conversation_labels.space_id=EXCLUDED.space_id AND conversation_labels.principal_id=EXCLUDED.principal_id`,
      [input.activityId, ...scope(identity), next]);
      if (updated.rowCount !== 1) throw new StorageError('corrupt');
      return null;
    });
    // Receipts confirm effects; they never replay a stale view of another browser's changes.
    return read(identity);
  }
  return { read, update };
}

export async function validateConversationHistory(storage: OwnedStorage) {
  const { rows } = await storage.read(`SELECT l.*,a.body FROM conversation_labels l LEFT JOIN activities a ON a.id=l.activity_id`);
  for (const row of rows) {
    const parsed = activitySchema.safeParse(row.body);
    const label = conversationHistoryItemSchema.safeParse({ activityId: row.activity_id, title: row.title,
      pinned: row.pinned, deleted: row.deleted, archived: false });
    if (!parsed.success || !label.success) throw new StorageError('corrupt');
    if (row.title !== null) {
      const rename = conversationHistoryUpdateSchema.safeParse({ requestId: row.activity_id, activityId: row.activity_id,
        action: 'rename', title: row.title });
      if (!rename.success || rename.data.action !== 'rename' || rename.data.title !== row.title) throw new StorageError('corrupt');
    }
    const activity = parsed.data;
    if (activity.course || activity.activityId !== row.activity_id
      || activity.identity.environmentId !== row.space_environment_id || activity.identity.spaceId !== row.space_id
      || activity.identity.principalId !== row.principal_id || activity.target.environmentId !== storage.owner.environmentId
      || activity.target.serviceId !== storage.owner.serviceId) throw new StorageError('corrupt');
  }
}
