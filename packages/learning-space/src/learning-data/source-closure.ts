import { createHash } from 'node:crypto';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { agentSessionSchema } from '@xunjie/contracts/agent-sessions';
import { collectSources, validateSources } from '@xunjie/storage/source-closure';
import type { SourceSpec, SourceRow, SourceResourceFact, ReadSourceResource, OwnerSourceClosure } from '@xunjie/storage/source-closure';
import { personalMaterialResourceId } from './personal-materials.js';
import { personalProjectSourceSpecs } from './personal-projects.js';
import { skillSourceSpecs } from './skills.js';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const asRow = (value: unknown): SourceRow =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as SourceRow : {};

const pdfReadingResources: NonNullable<SourceSpec['resources']> = async (row: SourceRow, read: ReadSourceResource) => {
  // A reserved reading without a body has not published a rendition yet.
  if (!row.body) return [];
  const facts: SourceResourceFact[] = [];
  const readingId = typeof row.reading_id === 'string' ? row.reading_id : '';
  if (readingId) facts.push(await read(readingId));
  const body = asRow(row.body), pages = Array.isArray(body.pages) ? body.pages : [];
  for (const [index, value] of pages.entries()) {
    const page = asRow(value);
    if (typeof page.text === 'string') facts.push({ resourceId: `${readingId}:page:${index}:text`,
      sha256: sha256(Buffer.from(page.text, 'utf8')), byteLength: Buffer.byteLength(page.text, 'utf8') });
    const image = asRow(page.image);
    if (typeof image.sha256 === 'string') facts.push({ resourceId: `${readingId}:page:${index}:image`,
      sha256: image.sha256, byteLength: typeof image.byteLength === 'number' ? image.byteLength : 0 });
  }
  return facts;
};

const personalMaterialVersionResources: NonNullable<SourceSpec['resources']> = async (row: SourceRow, read: ReadSourceResource) => {
  const materialId = String(row.material_id ?? ''), version = Number(row.version ?? 0);
  return materialId && version ? [await read(personalMaterialResourceId(materialId, version))] : [];
};

const pdfDocumentResources: NonNullable<SourceSpec['resources']> = async (row: SourceRow, read: ReadSourceResource) =>
  typeof row.document_id === 'string' ? [await read(row.document_id)] : [];

async function releasedMaterials(storage: OwnedStorage) {
  const sessions = new Set<string>(), materials = new Set<string>();
  const { rows: [relation] } = await storage.read('SELECT to_regclass($1) AS relation', ['session_material_releases']);
  if (!relation?.relation) return { sessions, materials };
  const { rows } = await storage.read(`SELECT r.session_id,d.body FROM session_material_releases r
    LEFT JOIN agent_session_directory d ON d.session_id=r.session_id`);
  for (const row of rows) {
    const parsed = agentSessionSchema.safeParse(row.body);
    if (!parsed.success || parsed.data.sessionId !== row.session_id || !parsed.data.deleted) throw new StorageError('corrupt');
    sessions.add(parsed.data.sessionId);
  }
  if (sessions.size) {
    const { rows } = await storage.read('SELECT material_id FROM personal_materials WHERE session_id=ANY($1::uuid[])', [[...sessions]]);
    for (const row of rows) materials.add(String(row.material_id));
  }
  return { sessions, materials };
}

/** One retirement view per collection; no lookup is reused across release/GC or restore calls. */
function learningSpecs(storage: OwnedStorage): readonly SourceSpec[] {
  let retirement: ReturnType<typeof releasedMaterials> | undefined;
  const released = () => retirement ??= releasedMaterials(storage);
  return [
  { table: 'agent_session_directory', kind: 'agent_session_directory', id: ['session_id'], version: ['create_digest'] },
  { table: 'session_material_adoptions', kind: 'session_material_adoptions', id: ['request_id'], version: ['state'] },
  { table: 'session_material_releases', kind: 'session_material_releases', id: ['session_id'], version: ['released_at'] },
  ...personalProjectSourceSpecs,
  ...skillSourceSpecs,
  { table: 'study_copy_exports', kind: 'study_copy_exports', id: ['scope_key'], version: ['state', 'digest'] },
  { table: 'study_copy_imports', kind: 'study_copy_imports', id: ['scope_key', 'digest'] },
  { table: 'study_copy_sources', kind: 'study_copy_sources', id: ['activity_id'] },
  { table: 'study_copy_cache', kind: 'study_copy_cache', id: ['scope_key', 'cache_key'] },
  { table: 'study_copy_chunk_scopes', kind: 'study_copy_chunk_scopes', id: ['source_key', 'transfer_id'], version: ['scope_key'] },
  { table: 'school_acquisitions', kind: 'school_acquisitions', id: ['request_id'] },
  { table: 'school_submissions', kind: 'school_submissions', id: ['submission_id'], version: ['request_id'] },
  { table: 'activities', kind: 'activities', id: ['id'] },
  { table: 'teaching_artifacts', kind: 'teaching_artifacts', id: ['artifact_id'] },
  { table: 'teaching_artifact_revisions', kind: 'teaching_artifact_revisions', id: ['revision_id'], version: ['version'], resources: async (row, read) => [await read(String(row.resource_id))] },
  { table: 'teaching_artifact_candidates', kind: 'teaching_artifact_candidates', id: ['candidate_id'] },
  { table: 'teaching_artifact_checks', kind: 'teaching_artifact_checks', id: ['request_id'] },
  { table: 'teaching_artifact_receipts', kind: 'teaching_artifact_receipts', id: ['request_id'] },
  { table: 'activity_requests', kind: 'activity_requests', id: ['request_id'] },
  { table: 'course_activity_requests', kind: 'course_activity_requests', id: ['request_id'], version: ['release_id', 'input_digest'] },
  { table: 'work_heads', kind: 'work_heads', id: ['activity_id'], version: ['revision'] },
  { table: 'work_contents', kind: 'work_contents', id: ['content_id'] },
  { table: 'work_objects', kind: 'work_objects', id: ['object_id'] },
  { table: 'work_receipts', kind: 'work_receipts', id: ['request_id'] },
  { table: 'work_versions', kind: 'work_versions', id: ['activity_id', 'revision'], version: ['revision'] },
  { table: 'question_drafts', kind: 'question_drafts', id: ['draft_id'], version: ['revision'] },
  { table: 'question_draft_revisions', kind: 'question_draft_revisions', id: ['draft_id', 'revision_id'], version: ['revision', 'content_digest'] },
  { table: 'question_draft_receipts', kind: 'question_draft_receipts', id: ['request_id'] },
  { table: '_storage_references', kind: 'question_reference_pins', id: ['reference_id'] },
  { table: 'action_intents', kind: 'action_intents', id: ['request_id'], version: ['request_id', 'input_digest'] },
  { table: 'execution_commands', kind: 'execution_commands', id: ['request_id'], version: ['request_id', 'input_digest', 'execution_ref'] },
  { table: 'execution_stops', kind: 'execution_stops', id: ['stop_id'], version: ['request_id', 'input_digest'] },
  { table: 'execution_results', kind: 'execution_results', id: ['request_id'], version: ['request_id', 'execution_ref'] },
  { table: 'native_sessions', kind: 'native_sessions', id: ['session_ref'], version: ['request_id', 'input_digest'] },
  { table: 'native_session_operations', kind: 'native_session_operations', id: ['control_id'], version: ['session_ref', 'seq'] },
  { table: 'native_session_stops', kind: 'native_session_stops', id: ['stop_id'], version: ['request_id'] },
  { table: 'native_session_checkpoints', kind: 'native_session_checkpoints', id: ['checkpoint_id'] },
  { table: 'channel_executions', kind: 'channel_executions', id: ['request_id'], version: ['request_id', 'input_digest', 'execution_ref'] },
  { table: 'channel_execution_intents', kind: 'channel_execution_intents', id: ['command_id'], version: ['request_id', 'position'] },
  { table: 'channel_session_checkpoints', kind: 'channel_session_checkpoints', id: ['checkpoint_id'], version: ['applied_seq'] },
  { table: 'native_channel_nodes', kind: 'native_channel_nodes', id: ['connection_id'] },
  { table: 'native_channel_commands', kind: 'native_channel_commands', id: ['command_id'] },
  { table: 'native_channel_late_reports', kind: 'native_channel_late_reports', id: ['command_id', 'position'] },
  { table: 'native_channel_cleanups', kind: 'native_channel_cleanups', id: ['command_id'] },
  { table: 'agent_interaction_preferences', kind: 'agent_interaction_preferences', id: ['scope_key'] },
  { table: 'activity_agent_routes', kind: 'activity_agent_routes', id: ['activity_id'] },
  { table: 'agent_execution_commands', kind: 'agent_execution_commands', id: ['command_id'] },
  { table: 'agent_execution_origins', kind: 'agent_execution_origins', id: ['command_id'] },
  { table: 'agent_execution_authorities', kind: 'agent_execution_authorities', id: ['command_id'] },
  { table: 'personal_materials', kind: 'personal_materials', id: ['material_id'], version: ['current_version'] },
  { table: 'personal_material_versions', kind: 'personal_material_versions', id: ['material_id', 'version'],
    version: ['version', 'sha256'], resources: async (row, read) => (await released()).materials.has(String(row.material_id))
      ? [] : personalMaterialVersionResources(row, read) },
  { table: 'pdf_documents', kind: 'pdf_documents', id: ['document_id'], version: ['request_id'], resources: async (row, read) =>
    (await released()).sessions.has(String(row.session_id)) ? [] : pdfDocumentResources(row, read) },
  { table: 'pdf_readings', kind: 'pdf_readings', id: ['reading_id'], version: ['input_digest'], resources: async (row, read) =>
    (await released()).sessions.has(String(row.session_id)) ? [] : pdfReadingResources(row, read) },
  ];
}

export const learningSourceOwner = 'xunjie.learning-data';
const closureFailure = (error: unknown): never => {
  if (error instanceof StorageError && ['missing', 'resource-gone'].includes(error.code)) throw new StorageError('corrupt');
  throw error;
};

export function collectLearningSources(storage: OwnedStorage): Promise<OwnerSourceClosure> {
  return collectSources(storage, learningSourceOwner, learningSpecs(storage)).catch(closureFailure);
}
export function validateLearningSources(storage: OwnedStorage, material: unknown): Promise<void> {
  return validateSources(storage, material, learningSourceOwner, learningSpecs(storage)).catch(closureFailure);
}
