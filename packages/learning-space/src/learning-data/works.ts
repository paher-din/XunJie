import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { OwnedStorage, Migration } from '@xunjie/storage';
import { workFileSchema, workSyncSchema, workViewSchema } from '@xunjie/contracts/learning-data';
import type { WorkFile, WorkView, WorkSync } from '@xunjie/contracts/learning-data';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';

export const workMigration: Migration = { version: 2, name: 'reliable-activity-works', sql: `
  CREATE TABLE work_heads(activity_id uuid PRIMARY KEY REFERENCES activities(id),revision integer NOT NULL,files jsonb NOT NULL);
  CREATE TABLE work_contents(content_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),object_id uuid NOT NULL,
    encoding text NOT NULL,media_type text NOT NULL);
  CREATE TABLE work_objects(object_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),kind text NOT NULL,deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE work_receipts(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id));
  CREATE TABLE work_versions(activity_id uuid NOT NULL REFERENCES activities(id),revision integer NOT NULL,files jsonb NOT NULL,
    PRIMARY KEY(activity_id,revision));
` };
type ManifestFile = Omit<WorkFile, 'value'>;
const basisSchema = z.object({ objectId: z.uuid(), contentId: z.uuid(), name: workFileSchema.shape.name,
  kind: z.enum(['text', 'code']), encoding: z.literal('utf8'), mediaType: z.string().min(1).max(200),
  value: z.string().max(2000000) }).strict();
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
function bytes(file: WorkFile) {
  const result = Buffer.from(file.value, file.encoding === 'base64' ? 'base64' : 'utf8');
  if (result.toString(file.encoding === 'base64' ? 'base64' : 'utf8') !== file.value) throw new StorageError('invalid');
  if (file.encoding === 'json') { try { JSON.parse(file.value); } catch { throw new StorageError('invalid'); } }
  return result;
}
async function materialize(storage: OwnedStorage, revision: number, manifest: ManifestFile[]): Promise<WorkView> {
  const files = await Promise.all(manifest.map(async f => ({ ...f,
    value: Buffer.from(await storage.readResource(f.contentId)).toString(f.encoding === 'base64' ? 'base64' : 'utf8') })));
  return workViewSchema.parse({ revision, files });
}
export async function validateWorks(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT activity_id,revision,files FROM work_versions');
  for (const row of rows) {
    const view = await materialize(storage, Number(row.revision), row.files as ManifestFile[]);
    for (const f of view.files) {
      const { rows: [content] } = await storage.read('SELECT activity_id,object_id,encoding,media_type FROM work_contents WHERE content_id=$1', [f.contentId]);
      if (!content || content.activity_id !== row.activity_id || content.object_id !== f.objectId
        || content.encoding !== f.encoding || content.media_type !== f.mediaType) throw new StorageError('corrupt');
    }
  }
  const { rows: heads } = await storage.read('SELECT h.activity_id,h.revision,h.files,v.files AS version_files FROM work_heads h LEFT JOIN work_versions v USING(activity_id,revision)');
  for (const h of heads) {
    if (JSON.stringify(h.files) !== JSON.stringify(h.version_files)) throw new StorageError('corrupt');
    for (const f of h.files as ManifestFile[]) {
      const { rows: [object] } = await storage.read('SELECT activity_id,kind,deleted FROM work_objects WHERE object_id=$1', [f.objectId]);
      if (!object || object.activity_id !== h.activity_id || object.kind !== f.kind || object.deleted) throw new StorageError('corrupt');
    }
  }
  const { rows: receipts } = await storage.read('SELECT request_id,activity_id FROM work_receipts');
  for (const receipt of receipts) {
    const saved = await storage.receipt(String(receipt.request_id));
    const result = saved?.result as { revision?: number; files?: ManifestFile[] } | undefined;
    const { rows: [version] } = await storage.read('SELECT files FROM work_versions WHERE activity_id=$1 AND revision=$2', [receipt.activity_id, result?.revision ?? -1]);
    if (!version || JSON.stringify(version.files) !== JSON.stringify(result?.files)) throw new StorageError('corrupt');
  }
}
/** Whole-workspace optimistic revision; all files and their immutable resource references commit together. */
export function createWorks(storage: OwnedStorage, authorize: (identity: SpaceIdentity, activityId: string) => Promise<unknown>) {
  async function read(identity: SpaceIdentity, activityId: string) {
    z.uuid().parse(activityId); await authorize(identity, activityId);
    const { rows: [row] } = await storage.read('SELECT revision,files FROM work_heads WHERE activity_id=$1', [activityId]);
    return row ? materialize(storage, Number(row.revision), row.files as ManifestFile[]) : { revision: 0, files: [] };
  }
  async function receipt(identity: SpaceIdentity, activityId: string, requestId: string): Promise<WorkView | null> {
    await authorize(identity, activityId); z.uuid().parse(requestId);
    const { rows } = await storage.read('SELECT request_id FROM work_receipts WHERE activity_id=$1 AND request_id=$2', [activityId, requestId]);
    if (!rows.length) return null;
    const found = await storage.receipt(requestId);
    if (!found) throw new StorageError('corrupt');
    const result = found.result as { revision: number; files: ManifestFile[] };
    return materialize(storage, result.revision, result.files);
  }
  async function sync(identity: SpaceIdentity, activityId: string, value: WorkSync): Promise<WorkView> {
    await authorize(identity, activityId);
    const input = workSyncSchema.parse(value);
    const fingerprint = digest({ identity, activityId, input });
    const previous = await storage.receipt(input.requestId, fingerprint);
    if (previous) {
      const own = await receipt(identity, activityId, input.requestId);
      if (!own) throw new StorageError('identity-conflict');
      return own;
    }
    // Every upload uses its immutable content identity. Unknown uploads reconcile through the same stageResource call.
    for (const file of input.files) await storage.stageResource({ uploadId: file.contentId, scope: `works/${activityId}/${file.objectId}`,
      bytes: bytes(file), mediaType: file.mediaType, contentVersion: 1 });
    const files = input.files.map(({ value: _value, ...file }) => file);
    const result = await storage.request({ requestId: input.requestId, fingerprint }, async tx => {
      await tx.query('INSERT INTO work_heads VALUES ($1,0,$2) ON CONFLICT DO NOTHING', [activityId, '[]']);
      const { rows: [head] } = await tx.query('SELECT revision FROM work_heads WHERE activity_id=$1 FOR UPDATE', [activityId]);
      if (head!.revision !== input.baseRevision) throw new StorageError('conflict');
      for (const f of files) {
        await tx.query('INSERT INTO work_objects(object_id,activity_id,kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [f.objectId, activityId, f.kind]);
        const { rows: [object] } = await tx.query('SELECT activity_id,kind,deleted FROM work_objects WHERE object_id=$1', [f.objectId]);
        if (object!.deleted || object!.activity_id !== activityId || object!.kind !== f.kind) throw new StorageError('identity-conflict');
        await tx.query('INSERT INTO work_contents VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [f.contentId, activityId, f.objectId, f.encoding, f.mediaType]);
        const { rows: [stored] } = await tx.query('SELECT activity_id,object_id,encoding,media_type FROM work_contents WHERE content_id=$1', [f.contentId]);
        if (stored!.activity_id !== activityId || stored!.object_id !== f.objectId || stored!.encoding !== f.encoding
          || stored!.media_type !== f.mediaType) throw new StorageError('identity-conflict');
        // All published versions retain their original content even after rename/delete.
        await tx.reference('work-content/' + f.contentId, f.contentId);
      }
      const revision = input.baseRevision + 1;
      await tx.query('UPDATE work_objects SET deleted=true WHERE activity_id=$1 AND NOT(object_id=ANY($2::uuid[]))', [activityId, files.map(f => f.objectId)]);
      await tx.query('UPDATE work_heads SET revision=$2,files=$3 WHERE activity_id=$1', [activityId, revision, JSON.stringify(files)]);
      await tx.query('INSERT INTO work_versions VALUES ($1,$2,$3)', [activityId, revision, JSON.stringify(files)]);
      await tx.query('INSERT INTO work_receipts VALUES ($1,$2)', [input.requestId, activityId]);
      return { revision, files };
    });
    const saved = result.result as { revision: number; files: ManifestFile[] };
    return materialize(storage, saved.revision, saved.files);
  }
  async function content(identity: SpaceIdentity, activityId: string, contentId: string) {
    await authorize(identity, activityId); z.uuid().parse(contentId);
    const { rows: [row] } = await storage.read(`SELECT c.object_id,c.encoding,c.media_type,o.kind
      FROM work_contents c JOIN work_objects o ON o.object_id=c.object_id
      WHERE c.activity_id=$1 AND c.content_id=$2`, [activityId, contentId]);
    if (!row) throw new StorageError('missing');
    return { contentId, objectId: row.object_id as string, kind: row.kind as WorkFile['kind'],
      encoding: row.encoding as WorkFile['encoding'], mediaType: row.media_type as string,
      value: Buffer.from(await storage.readResource(contentId)).toString(row.encoding === 'base64' ? 'base64' : 'utf8') };
  }
  /**
   * Fixed basis registration does not advance the current head. A selection may refer to content
   * that was never published, or was replaced by later edits; its bytes are retained independently.
   */
  async function registerBasis(identity: SpaceIdentity, activityId: string, value: unknown) {
    await authorize(identity, activityId); z.uuid().parse(activityId);
    const file: WorkFile = basisSchema.parse(value);
    const uploaded = bytes(file);
    await storage.stageResource({ uploadId: file.contentId, scope: `works/${activityId}/${file.objectId}`,
      bytes: uploaded, mediaType: file.mediaType, contentVersion: 1 });
    const receipt = await storage.request({ requestId: `work-basis:${file.contentId}`,
      fingerprint: digest({ identity, activityId, file }) }, async tx => {
      await tx.query('INSERT INTO work_objects(object_id,activity_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [file.objectId, activityId, file.kind]);
      const { rows: [object] } = await tx.query('SELECT activity_id,kind,deleted FROM work_objects WHERE object_id=$1 FOR UPDATE', [file.objectId]);
      if (!object || object.activity_id !== activityId || object.kind !== file.kind) throw new StorageError('identity-conflict');
      const { rows: [known] } = await tx.query('SELECT activity_id,object_id,encoding,media_type FROM work_contents WHERE content_id=$1', [file.contentId]);
      if (!known) {
        if (object.deleted) throw new StorageError('missing');
        // A concurrent work sync may register the same immutable content first.
        await tx.query('INSERT INTO work_contents VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [file.contentId, activityId, file.objectId, file.encoding, file.mediaType]);
      }
      const { rows: [stored] } = await tx.query('SELECT activity_id,object_id,encoding,media_type FROM work_contents WHERE content_id=$1', [file.contentId]);
      if (!stored || stored.activity_id !== activityId || stored.object_id !== file.objectId
        || stored.encoding !== file.encoding || stored.media_type !== file.mediaType) throw new StorageError('identity-conflict');
      await tx.reference('work-content/' + file.contentId, file.contentId);
      return { objectId: file.objectId, contentId: file.contentId };
    });
    return receipt.result as { objectId: string; contentId: string };
  }
  return { read, sync, receipt, content, registerBasis };
}
