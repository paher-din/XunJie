import { executionActionSchema } from '@xunjie/contracts/execution';
import { createHash } from 'node:crypto';
import { componentInstanceId, componentStateName, matchesComponentState } from '@xunjie/contracts/components';
import { semanticAdapters, semanticReferenceCopy, type QuestionReferenceInput } from '@xunjie/contracts/question-drafts';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
const fail = (): never => { throw new StorageError('invalid'); };
/** Reads immutable facts through their owner, never accepting a caller's digest as proof. */
export async function verifySemanticReference(storage: OwnedStorage, activity: LearningActivity,
  reference: QuestionReferenceInput, historical = false) {
  const source = reference.source, range = reference.range;
  if (source.kind !== 'component' || range.kind !== 'semantic') return fail();
  const binding = activity.course?.components?.find(item => item.key === source.bindingKey);
  if (!binding || source.environmentId !== activity.identity.environmentId || source.spaceId !== activity.identity.spaceId
    || source.principalId !== activity.identity.principalId || source.activityId !== activity.activityId
    || source.instanceId !== componentInstanceId(activity.activityId, binding.key)
    || source.componentId !== binding.definition.manifest.componentId || source.componentVersion !== binding.definition.manifest.version
    || source.definitionDigest !== binding.definition.digest) return fail();
  let bytes: Buffer;
  try { bytes = Buffer.from(await storage.readResource(source.contentId)); }
  catch (error) {
    // The browser may have protected a completed result before its owner upload is acknowledged.
    if (source.origin === 'execution-result' && error instanceof StorageError && error.code === 'missing') throw new StorageError('unavailable');
    throw error;
  }
  let content: unknown;
  if (source.origin === 'state') {
    const { rows: [row] } = await storage.read(`SELECT c.object_id,c.activity_id,c.encoding,c.media_type,o.kind
      FROM work_contents c JOIN work_objects o ON o.object_id=c.object_id WHERE c.content_id=$1`, [source.contentId]);
    if (!row || row.object_id !== source.objectId || row.activity_id !== activity.activityId) return fail();
    const value = bytes.toString('utf8');
    if (!matchesComponentState(binding, activity.activityId, { name: componentStateName(binding.key), kind: String(row.kind),
      encoding: String(row.encoding), mediaType: String(row.media_type), value })) return fail();
    content = JSON.parse(value).content;
  } else {
    const { rows: [row] } = await storage.read(`SELECT r.*,c.body AS action FROM execution_results r JOIN execution_commands c
      ON c.request_id=r.request_id WHERE r.activity_id=$1 AND r.request_id=$2`, [activity.activityId, source.requestId]);
    if (!row) throw new StorageError('unavailable');
    if (row.content_id !== source.contentId || row.execution_ref !== source.executionRef || source.objectId !== source.requestId
      || executionActionSchema.parse(row.action).execution.instance.key !== binding.key || executionActionSchema.parse(row.action).execution.instance.definitionDigest !== binding.definition.digest
      || bytes.length !== Number(row.byte_length) || createHash('sha256').update(bytes).digest('hex') !== row.sha256) return fail();
    content = row.output;
  }
  const adapter = semanticAdapters[range.typeId as keyof typeof semanticAdapters];
  if (!adapter || range.version !== adapter.version) {
    if (!historical) return fail();
    return; // Validated stored envelope/copy only; no unsupported adapter is executed.
  }
  if (adapter.origin !== source.origin) return fail();
  try { if (semanticReferenceCopy(range, content) !== reference.copy) return fail(); } catch { return fail(); }
}
