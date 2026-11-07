import { z } from 'zod';
import { executionActionSchema, executionRetainedResourceSchema, canonicalValue } from '@xunjie/contracts/execution';
import { createHash } from 'node:crypto';
import { componentInstanceId, componentStateName, matchesComponentState } from '@xunjie/contracts/components';
import type { ComponentBinding } from '@xunjie/contracts/components';
import { aluReferenceAdapters } from '@xunjie/contracts/alu-references';
import { ALU_REFLECTION_MEDIA_TYPE } from '@xunjie/contracts/alu-learning';
import { semanticAdapters, semanticReferenceCopy, type QuestionReferenceInput } from '@xunjie/contracts/question-drafts';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { readAluReflectionSource } from './alu-reflections.js';
import { readExecutionSource } from './execution-source.js';
const fail = (): never => { throw new StorageError('invalid'); };
const corrupt = (): never => { throw new StorageError('corrupt'); };
type ComponentSource = Extract<QuestionReferenceInput['source'], { kind: 'component' }>;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const canonicalHash = (value: unknown) => hash(JSON.stringify(canonicalValue(value)));
const artifactMetadata = z.object({ name: z.string().min(1).max(120), mediaType: z.string().min(1).max(120),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative().max(1048576),
  resources: z.array(executionRetainedResourceSchema.omit({ text: true })).max(4).optional() }).strict();
const commandOutput = z.object({ contentId: z.uuid(), output: z.unknown(), artifact: artifactMetadata.omit({ resources: true }) }).strict();

function pending(error: unknown): never {
  if (error instanceof StorageError && ['missing', 'resource-busy', 'upload-unknown'].includes(error.code))
    throw new StorageError('unavailable');
  throw error;
}
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return corrupt(); }
}
async function originalResource(storage: OwnedStorage, id: string, scope: string,
  expected?: { sha256: string; byteLength: number; mediaType: string }) {
  try {
    const resource = await storage.resource(id);
    if (resource.resourceId !== id || resource.scope !== scope || resource.contentVersion !== 1
      || resource.owner.environmentId !== storage.owner.environmentId || resource.owner.serviceId !== storage.owner.serviceId) return fail();
    if (expected && (resource.sha256 !== expected.sha256 || resource.byteLength !== expected.byteLength || resource.mediaType !== expected.mediaType)) return corrupt();
    const bytes = await storage.readResource(id);
    if (bytes.byteLength !== resource.byteLength || hash(bytes) !== resource.sha256) return corrupt();
    return { bytes, resource };
  } catch (error) { return pending(error); }
}
async function originalPin(storage: OwnedStorage, referenceId: string, contentId: string) {
  const { rows: [pin] } = await storage.read('SELECT resource_id FROM _storage_references WHERE reference_id=$1', [referenceId]);
  if (!pin || pin.resource_id !== contentId) return corrupt();
}
async function originalState(storage: OwnedStorage, activity: LearningActivity, binding: ComponentBinding, source: ComponentSource) {
  const { rows: [row] } = await storage.read(`SELECT c.object_id,c.activity_id,c.encoding,c.media_type,o.kind,o.activity_id AS object_activity_id
    FROM work_contents c LEFT JOIN work_objects o ON o.object_id=c.object_id WHERE c.content_id=$1`, [source.contentId]);
  if (!row) throw new StorageError('unavailable');
  if (row.object_id !== source.objectId || row.activity_id !== activity.activityId || row.object_activity_id !== activity.activityId) return fail();
  const { bytes, resource } = await originalResource(storage, source.contentId, `works/${activity.activityId}/${source.objectId}`);
  if (resource.mediaType !== row.media_type) return corrupt();
  const value = decode(bytes);
  if (!matchesComponentState(binding, activity.activityId, { name: componentStateName(binding.key), kind: String(row.kind),
    encoding: String(row.encoding), mediaType: String(row.media_type), value })) return fail();
  return JSON.parse(value).content as unknown;
}
async function originalReflection(storage: OwnedStorage, activity: LearningActivity, source: ComponentSource) {
  try {
    const material = await readAluReflectionSource(storage, activity, { objectId: source.objectId, contentId: source.contentId });
    if (material.note.bindingKey !== source.bindingKey || material.note.instanceId !== source.instanceId
      || material.note.definitionDigest !== source.definitionDigest) return fail();
    return { note: material.note, action: material.action };
  } catch (error) { return pending(error); }
}
async function originalV3Result(storage: OwnedStorage, activity: LearningActivity, binding: ComponentBinding,
  source: ComponentSource, requireAlu: boolean) {
  if (source.objectId !== source.requestId || !source.requestId || !source.executionRef) return fail();
  const { action, query } = await readExecutionSource(storage, activity, { requestId: source.requestId, executionRef: source.executionRef });
  const instance = action.execution.instance, manifest = binding.definition.manifest;
  if (action.protocolVersion !== 3 || instance.key !== source.bindingKey || instance.instanceId !== source.instanceId || instance.componentId !== source.componentId
    || instance.componentVersion !== source.componentVersion || instance.definitionDigest !== source.definitionDigest
    || instance.stateVersion !== manifest.stateVersion || instance.hostApiVersion !== manifest.hostApiVersion
    || requireAlu && action.execution.basis.runtime.adapterId !== 'icarus-alu') return fail();
  const { rows: [row] } = await storage.read('SELECT * FROM execution_results WHERE request_id=$1', [source.requestId]);
  if (!row) throw new StorageError('unavailable');
  if (row.activity_id !== activity.activityId || row.request_id !== source.requestId || row.content_id !== source.contentId
    || row.execution_ref !== source.executionRef) return fail();
  const metadata = artifactMetadata.safeParse(row.artifact), reported = commandOutput.safeParse(query.output);
  if (!metadata.success || !reported.success) return corrupt();
  const expected = metadata.data;
  if (reported.data.contentId !== source.contentId || reported.data.artifact.sha256 !== row.sha256
    || reported.data.artifact.byteLength !== row.byte_length || reported.data.artifact.name !== expected.name
    || reported.data.artifact.mediaType !== expected.mediaType || canonicalHash(reported.data.output) !== canonicalHash(row.output)
    || expected.sha256 !== row.sha256 || expected.byteLength !== row.byte_length) return corrupt();
  const refs = expected.resources ?? [];
  if (new Set(refs.map(ref => ref.contentId)).size !== refs.length || refs.some(ref => ref.contentId === source.contentId)) return corrupt();
  const scopeName = `execution/${source.requestId}`;
  await originalResource(storage, source.contentId, scopeName, expected);
  await originalPin(storage, `${scopeName}/result`, source.contentId);
  const resources = [];
  for (const ref of refs) {
    const { bytes } = await originalResource(storage, ref.contentId, scopeName, ref);
    await originalPin(storage, `${scopeName}/resource/${ref.contentId}`, ref.contentId);
    resources.push({ ...ref, text: decode(bytes) });
  }
  return { action, output: row.output, state: query.statusKnowledge === 'confirmed' ? query.state : 'unknown', resources };
}
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
  const adapter = Object.hasOwn(semanticAdapters, range.typeId) ? semanticAdapters[range.typeId as keyof typeof semanticAdapters] : undefined;
  const alu = Object.hasOwn(aluReferenceAdapters, range.typeId);
  if (alu) {
    if (adapter!.origin !== source.origin) return fail();
    const content = source.origin === 'execution-result' ? await originalV3Result(storage, activity, binding, source, true)
      : range.typeId === 'alu-reflection' ? await originalReflection(storage, activity, source)
      : await originalState(storage, activity, binding, source);
    if (range.version !== adapter!.version) { if (historical) return; return fail(); }
    try {
      if (semanticReferenceCopy(range, content) === reference.copy) return;
      // The draft owner has already proved this exact historical envelope/copy. Receiver
      // knowledge may have advanced; rebuild only the old nonterminal/unknown presentation
      // from the same immutable facts, without exposing new actual values or allowing edits.
      if (historical && source.origin === 'execution-result') {
        for (const state of ['unknown', 'queued', 'running', 'paused']) {
          if (semanticReferenceCopy(range, { ...(content as Record<string, unknown>), state }) === reference.copy) return;
        }
      }
    } catch { return fail(); }
    // The original result bytes can arrive before the receiver's terminal report. Scope,
    // resources and target have already been verified; keep this exact draft eligible to retry.
    if (source.origin === 'execution-result'
      && ['unknown', 'queued', 'running', 'paused'].includes((content as { state: string }).state))
      throw new StorageError('unavailable');
    return fail();
  }
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
    if (historical && !adapter && row.media_type === ALU_REFLECTION_MEDIA_TYPE) {
      await originalReflection(storage, activity, source);
      return;
    }
    if (!matchesComponentState(binding, activity.activityId, { name: componentStateName(binding.key), kind: String(row.kind),
      encoding: String(row.encoding), mediaType: String(row.media_type), value })) return fail();
    content = JSON.parse(value).content;
  } else {
    const { rows: [row] } = await storage.read(`SELECT r.*,c.body AS action FROM execution_results r JOIN execution_commands c
      ON c.request_id=r.request_id WHERE r.activity_id=$1 AND r.request_id=$2`, [activity.activityId, source.requestId]);
    if (!row) throw new StorageError('unavailable');
    if ((row.action as { protocolVersion?: unknown })?.protocolVersion === 3) {
      const original = await originalV3Result(storage, activity, binding, source, false);
      content = original.output;
    } else {
      if (row.content_id !== source.contentId || row.execution_ref !== source.executionRef || source.objectId !== source.requestId
      || executionActionSchema.parse(row.action).execution.instance.key !== binding.key || executionActionSchema.parse(row.action).execution.instance.definitionDigest !== binding.definition.digest
      || bytes.length !== Number(row.byte_length) || createHash('sha256').update(bytes).digest('hex') !== row.sha256) return fail();
      content = row.output;
    }
  }
  if (!adapter || range.version !== adapter.version) {
    if (!historical) return fail();
    return; // Validated stored envelope/copy only; no unsupported adapter is executed.
  }
  if (adapter.origin !== source.origin) return fail();
  try { if (semanticReferenceCopy(range, content) !== reference.copy) return fail(); } catch { return fail(); }
}
