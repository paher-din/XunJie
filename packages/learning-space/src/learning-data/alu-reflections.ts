import { StorageError } from '@xunjie/storage';
import type { OwnedStorage, OwnedTransaction } from '@xunjie/storage';
import { z } from 'zod';
import { ALU_REFLECTION_MEDIA_TYPE, isAluObservationAction, aluReflectionName, aluReflectionSchema, parseAluReflectionFile } from '@xunjie/contracts/alu-learning';
import type { AluReflection } from '@xunjie/contracts/alu-learning';
import type { ExecutionActionV3 } from '@xunjie/contracts/execution';
import { activitySchema, workFileSchema } from '@xunjie/contracts/learning-data';
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data';
import { readExecutionSource } from './execution-source.js';

interface ReflectionSource { note: AluReflection; action: ExecutionActionV3; file: WorkFile; }
type FileIdentity = Pick<WorkFile, 'objectId' | 'contentId' | 'encoding' | 'mediaType'>;
function immutableIdentity(activityId: string, file: FileIdentity, rows: Record<string, unknown>[]) {
  for (const row of rows) {
    if (file.mediaType !== ALU_REFLECTION_MEDIA_TYPE && row.media_type !== ALU_REFLECTION_MEDIA_TYPE) continue;
    if (row.activity_id !== activityId || row.object_id !== file.objectId || row.content_id !== file.objectId
      || file.contentId !== file.objectId || file.encoding !== 'json' || row.encoding !== 'json'
      || file.mediaType !== ALU_REFLECTION_MEDIA_TYPE || row.media_type !== ALU_REFLECTION_MEDIA_TYPE)
      throw new StorageError('identity-conflict');
  }
}

/** Serialize the immutable object rule with both sync and fixed-basis registration. */
export async function validateAluReflectionRegistration(tx: OwnedTransaction, activityId: string, file: FileIdentity) {
  await tx.query('SELECT object_id FROM work_objects WHERE object_id=$1 FOR UPDATE', [file.objectId]);
  const { rows } = await tx.query('SELECT activity_id,object_id,content_id,encoding,media_type FROM work_contents WHERE object_id=$1', [file.objectId]);
  immutableIdentity(activityId, file, rows);
}
function parseFile(file: WorkFile): AluReflection {
  try { return parseAluReflectionFile(workFileSchema.parse(file)); } catch { throw new StorageError('invalid'); }
}

/** Only the original execution owner can establish the case a student's explanation names. */
async function originalAction(storage: OwnedStorage, activity: LearningActivity, note: AluReflection): Promise<ExecutionActionV3> {
  try {
    const { action } = await readExecutionSource(storage, activity, note);
    if (!isAluObservationAction(action) || note.activityId !== action.scope.activityId
      || note.bindingKey !== action.execution.instance.key || note.instanceId !== action.execution.instance.instanceId
      || note.definitionDigest !== action.execution.instance.definitionDigest) throw new StorageError('invalid');
    return action;
  } catch (error) {
    if (error instanceof StorageError && error.code === 'corrupt') throw new StorageError('invalid');
    throw error;
  }
}

function validation(storage: OwnedStorage, activity: LearningActivity) {
  const sources = new Map<string, ReflectionSource>(), complete = new Set<string>();
  async function source(file: WorkFile): Promise<ReflectionSource> {
    const note = parseFile(file);
    return { note, action: await originalAction(storage, activity, note), file };
  }
  async function stored(noteId: string): Promise<ReflectionSource> {
    const { rows: [row] } = await storage.read(`SELECT c.activity_id,c.object_id,c.encoding,c.media_type,o.kind,o.activity_id AS object_activity_id
      FROM work_contents c LEFT JOIN work_objects o ON o.object_id=c.object_id WHERE c.content_id=$1`, [noteId]);
    if (!row) throw new StorageError('missing');
    if (row.activity_id !== activity.activityId || row.object_activity_id !== activity.activityId || row.object_id !== noteId
      || row.media_type !== ALU_REFLECTION_MEDIA_TYPE || row.encoding !== 'json' || row.kind !== 'state') throw new StorageError('invalid');
    const { rows: versions } = await storage.read('SELECT activity_id,object_id,content_id,encoding,media_type FROM work_contents WHERE object_id=$1', [noteId]);
    immutableIdentity(activity.activityId, { objectId: noteId, contentId: noteId, encoding: 'json', mediaType: ALU_REFLECTION_MEDIA_TYPE }, versions);
    const resource = await storage.resource(noteId);
    if (resource.resourceId !== noteId || resource.scope !== `works/${activity.activityId}/${noteId}`
      || resource.mediaType !== ALU_REFLECTION_MEDIA_TYPE || resource.contentVersion !== 1
      || resource.owner.environmentId !== storage.owner.environmentId || resource.owner.serviceId !== storage.owner.serviceId)
      throw new StorageError('invalid');
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await storage.readResource(noteId));
    let note;
    try { note = aluReflectionSchema.parse(JSON.parse(value)); } catch { throw new StorageError('invalid'); }
    return source({ objectId: String(row.object_id), contentId: noteId, kind: 'state', encoding: 'json',
      mediaType: ALU_REFLECTION_MEDIA_TYPE, name: aluReflectionName(note.bindingKey, note.noteId), value });
  }
  async function chain(start: ReflectionSource) {
    const path = new Set<string>();
    let current = start;
    while (!complete.has(current.note.noteId)) {
      if (path.has(current.note.noteId)) throw new StorageError('invalid');
      path.add(current.note.noteId);
      const parentId = current.note.parentNoteId;
      if (!parentId) break;
      let parent = sources.get(parentId);
      if (!parent) {
        try { parent = await stored(parentId); }
        catch (error) {
          // A selected revision can reach the draft owner before its parent work sync.
          if (error instanceof StorageError && error.code === 'missing') throw new StorageError('unavailable');
          throw error;
        }
        sources.set(parentId, parent);
      }
      if (current.note.activityId !== parent.note.activityId || current.note.bindingKey !== parent.note.bindingKey
        || current.note.instanceId !== parent.note.instanceId || current.note.definitionDigest !== parent.note.definitionDigest
        || current.note.requestId !== parent.note.requestId || current.note.inputDigest !== parent.note.inputDigest
        || current.note.executionRef !== parent.note.executionRef) throw new StorageError('invalid');
      current = parent;
    }
    for (const noteId of path) complete.add(noteId);
  }
  return { source, stored, sources, chain };
}

/** Incoming parents are verified before walking the graph, so a batch never waits on its own commit. */
export async function validateAluReflectionFiles(storage: OwnedStorage, activity: LearningActivity, files: WorkFile[]) {
  if (!files.length) return;
  const { rows: known } = await storage.read(`SELECT activity_id,object_id,content_id,encoding,media_type
    FROM work_contents WHERE object_id=ANY($1::uuid[])`, [files.map(file => file.objectId)]);
  for (const file of files) immutableIdentity(activity.activityId, file, known.filter(row => row.object_id === file.objectId));
  if (!files.some(file => file.mediaType === ALU_REFLECTION_MEDIA_TYPE)) return;
  const context = validation(storage, activity);
  for (const file of files) {
    if (file.mediaType !== ALU_REFLECTION_MEDIA_TYPE) continue;
    const source = await context.source(file);
    if (context.sources.has(source.note.noteId)) throw new StorageError('invalid');
    const { rows } = await storage.read('SELECT content_id FROM work_contents WHERE content_id=$1', [file.contentId]);
    if (rows.length && (await context.stored(file.contentId)).file.value !== file.value) throw new StorageError('identity-conflict');
    context.sources.set(source.note.noteId, source);
  }
  for (const source of context.sources.values()) await context.chain(source);
}

/** Historical content is read from this owner's retained resource, including tombstoned objects. */
export async function readAluReflectionSource(storage: OwnedStorage, activity: LearningActivity,
  reference: Pick<WorkFile, 'objectId' | 'contentId'>): Promise<ReflectionSource> {
  if (!z.uuid().safeParse(reference.objectId).success || reference.objectId !== reference.contentId) throw new StorageError('invalid');
  const context = validation(storage, activity);
  const source = await context.stored(reference.contentId);
  context.sources.set(source.note.noteId, source);
  await context.chain(source);
  return source;
}

/** Fixed references can retain explanations that never entered any workspace version. */
export async function validateRetainedAluReflections(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT activity_id,object_id,content_id FROM work_contents WHERE media_type=$1', [ALU_REFLECTION_MEDIA_TYPE]);
  for (const row of rows) {
    const { rows: [activity] } = await storage.read('SELECT body FROM activities WHERE id=$1', [row.activity_id]);
    await readAluReflectionSource(storage, activitySchema.parse(activity?.body),
      { objectId: String(row.object_id), contentId: String(row.content_id) });
  }
}
