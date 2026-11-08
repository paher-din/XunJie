import { createHash } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { canonicalDigest } from '../teaching-agent/identity.js';
import { personalMaterialResourceId } from './personal-materials.js';

export type SourceRow = Record<string, unknown>;
export interface SourceResourceFact { resourceId: string; sha256: string; byteLength: number; }
export type ReadSourceResource = (resourceId: string) => Promise<SourceResourceFact>;
export interface SourceSpec {
  table: string;
  kind: string;
  /** Columns forming the stable fixedId. Falls back to the row digest when none are present. */
  id: readonly string[];
  /** Columns forming the version. Falls back to the row digest when none are present. */
  version?: readonly string[];
  /** Override the resource bytes/facts attached to a row. */
  resources?: (row: SourceRow, read: ReadSourceResource) => Promise<SourceResourceFact[]>;
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const asRow = (value: unknown): SourceRow =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as SourceRow : {};
const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) if (typeof value === 'string' && value) return value;
  return undefined;
};

const resourceIdShape = z.string().regex(/^[a-f0-9]{64}$/);
export const ownerSourceEntrySchema = z.object({
  kind: z.string().min(1),
  environmentId: z.string(),
  spaceId: z.string().optional(),
  principalId: z.string().optional(),
  activityId: z.string().optional(),
  owner: z.string().min(1),
  fixedId: z.string().min(1),
  version: z.string(),
  digest: resourceIdShape,
  resources: z.array(z.object({
    resourceId: z.string(),
    sha256: z.string(),
    byteLength: z.number().int().nonnegative(),
  }).strict()),
}).strict();
export type OwnerSourceEntry = z.infer<typeof ownerSourceEntrySchema>;

export const ownerSourceClosureSchema = z.object({
  formatVersion: z.literal(1),
  kind: z.literal('xunjie.owner-sources/1'),
  owner: z.string().min(1),
  entries: z.array(ownerSourceEntrySchema),
}).strict();
export type OwnerSourceClosure = z.infer<typeof ownerSourceClosureSchema>;

/** Per-kind counts are derived from the entries, not stored on the closure wire format. */
export function sourceClosureCounts(closure: OwnerSourceClosure): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of closure.entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return counts;
}

/** A referenced original must be present: a dangling reference must not confirm a backup. */
export async function readSourceResource(storage: OwnedStorage, resourceId: string): Promise<SourceResourceFact> {
  const bytes = await storage.readResource(resourceId).catch(error => {
    const code = error instanceof StorageError ? error.code : (error as { code?: unknown } | null)?.code;
    throw code === 'missing' || code === 'resource-gone' ? new StorageError('corrupt') : error;
  });
  return { resourceId, sha256: sha256(bytes), byteLength: bytes.byteLength };
}

const resourceKeys = new Set(['resourceId', 'resource_id']);
function collectResourceIds(value: unknown, found: Set<string>, depth: number): void {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) collectResourceIds(item, found, depth + 1); return; }
  for (const [key, item] of Object.entries(value as SourceRow)) {
    if (resourceKeys.has(key) && typeof item === 'string' && item) found.add(item);
    else if (item && typeof item === 'object') collectResourceIds(item, found, depth + 1);
  }
}
export function resourceIdsFromRow(row: SourceRow): string[] {
  const found = new Set<string>();
  for (const column of ['resource_id', 'content_id'] as const) {
    const value = row[column];
    if (typeof value === 'string' && value) found.add(value);
  }
  collectResourceIds(row, found, 0);
  return [...found];
}

type Scope = Pick<OwnerSourceEntry, 'environmentId' | 'spaceId' | 'principalId' | 'activityId'>;
function scopeOf(row: SourceRow, ownerEnvironmentId: string): Scope {
  const body = asRow(row.body), scope = asRow(body.scope), identity = asRow(body.identity);
  const spaceId = firstString(row.space_id, scope.spaceId, identity.spaceId, body.spaceId);
  const principalId = firstString(row.principal_id, scope.principalId, identity.principalId, body.principalId);
  const activityId = firstString(row.activity_id, scope.activityId, body.activityId);
  const environmentId = firstString(row.space_environment_id, scope.environmentId, identity.environmentId,
    body.environmentId) ?? ownerEnvironmentId;
  return {
    environmentId,
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(principalId !== undefined ? { principalId } : {}),
    ...(activityId !== undefined ? { activityId } : {}),
  };
}

/** Join the source row's key columns into a stable composite ID, falling back to its digest. */
const pickKeyColumns = (row: SourceRow, columns: readonly string[]): string =>
  columns.map(column => row[column]).filter(value => value !== null && value !== undefined).map(String).join(':');

function isMissingResource(error: unknown): boolean {
  const code = error instanceof StorageError ? error.code : (error as { code?: unknown } | null)?.code;
  return code === 'missing' || code === 'resource-gone';
}

/**
 * Bodies may embed references to bytes another owner holds (course component entry/algorithm
 * manifests inside an execution action). This owner attests only bytes its own storage has staged;
 * a foreign reference stays in the row digest, and its owning owner covers the bytes. A reference
 * this owner once staged but can no longer read is a genuine dangling original and must fail.
 */
async function isForeignReference(storage: OwnedStorage, resourceId: string): Promise<boolean> {
  const { rows } = await storage.read('SELECT resource_id FROM _storage_resources WHERE resource_id=$1', [resourceId]);
  return rows.length === 0;
}

async function defaultResources(storage: OwnedStorage, row: SourceRow): Promise<SourceResourceFact[]> {
  const facts: SourceResourceFact[] = [];
  for (const resourceId of resourceIdsFromRow(row)) {
    try {
      const bytes = await storage.readResource(resourceId);
      facts.push({ resourceId, sha256: sha256(bytes), byteLength: bytes.byteLength });
    } catch (error) {
      if (!isMissingResource(error) || !(await isForeignReference(storage, resourceId))) throw error;
    }
  }
  return facts;
}

/** Reads only the owner's own tables. Never runs a model, tool, PDF render or network call. */
export async function collectSources(storage: OwnedStorage, owner: string, specs: readonly SourceSpec[]): Promise<OwnerSourceClosure> {
  const entries: OwnerSourceEntry[] = [];
  const read: ReadSourceResource = resourceId => readSourceResource(storage, resourceId);
  for (const spec of specs) {
    const { rows: [relation] } = await storage.read('SELECT to_regclass($1) AS relation', [spec.table]);
    if (!relation?.relation) continue;
    const { rows } = await storage.read(`SELECT * FROM ${spec.table}`);
    // pg timestamptz/bytea must become stable JSON values before the canonical digest.
    const facts = JSON.parse(JSON.stringify(rows)) as SourceRow[];
    for (const row of facts) {
      const resources = spec.resources ? await spec.resources(row, read) : await defaultResources(storage, row);
      resources.sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0);
      entries.push({
        kind: spec.kind,
        ...scopeOf(row, storage.owner.environmentId),
        owner,
        fixedId: pickKeyColumns(row, spec.id) || canonicalDigest(row),
        version: (spec.version && pickKeyColumns(row, spec.version)) || canonicalDigest(row),
        digest: canonicalDigest(row),
        resources,
      });
    }
  }
  entries.sort((a, b) => {
    for (const key of ['kind', 'owner', 'fixedId', 'version'] as const) {
      if (a[key] < b[key]) return -1;
      if (a[key] > b[key]) return 1;
    }
    return 0;
  });
  // Entries are plain JSON: fixedId/version/digest/resources are strings and numbers only.
  return { formatVersion: 1, kind: 'xunjie.owner-sources/1', owner, entries };
}

/** Re-derive the closure from the restored owner and require a canonical-equal match. */
export async function validateSources(storage: OwnedStorage, material: unknown,
  owner: string, specs: readonly SourceSpec[]): Promise<void> {
  const parsed = ownerSourceClosureSchema.safeParse(material);
  if (!parsed.success) throw new StorageError('corrupt');
  const actual = await collectSources(storage, owner, specs);
  if (canonicalDigest(parsed.data) !== canonicalDigest(actual)) throw new StorageError('corrupt');
}

const pdfReadingResources: NonNullable<SourceSpec['resources']> = async (row: SourceRow, read: ReadSourceResource) => {
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

const learningSpecs: readonly SourceSpec[] = [
  { table: 'activities', kind: 'activities', id: ['id'] },
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
    version: ['version', 'sha256'], resources: personalMaterialVersionResources },
  { table: 'pdf_documents', kind: 'pdf_documents', id: ['document_id'], version: ['request_id'], resources: pdfDocumentResources },
  { table: 'pdf_readings', kind: 'pdf_readings', id: ['reading_id'], version: ['input_digest'], resources: pdfReadingResources },
];

export const learningSourceOwner = 'xunjie.learning-data';

export function collectLearningSources(storage: OwnedStorage): Promise<OwnerSourceClosure> {
  return collectSources(storage, learningSourceOwner, learningSpecs);
}
export function validateLearningSources(storage: OwnedStorage, material: unknown): Promise<void> {
  return validateSources(storage, material, learningSourceOwner, learningSpecs);
}
