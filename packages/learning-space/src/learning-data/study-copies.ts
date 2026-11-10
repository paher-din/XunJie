import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { activitySchema, type LearningActivity } from '@xunjie/contracts/learning-data';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import type { CourseBindingPointer } from '@xunjie/contracts/courses';
import { studyTransferSchema, type StudyTransfer, type StudyImportReceipt, type StudyExportReceipt } from '@xunjie/contracts/study-copies';
import { resourceReferenceSchema, type ResourceReference } from '@xunjie/contracts/storage';
import { teachingDependencyCallSchema } from '@xunjie/contracts/teaching-agent';

type Row = Record<string, unknown>;
type Reader = Pick<OwnedTransaction, 'query'>;
const scope = (i: SpaceIdentity) => [i.environmentId, i.spaceId, i.principalId];
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const sha = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const key = (i: SpaceIdentity) => hash(scope(i));
const preferenceKey = (i: SpaceIdentity) => createHash('sha256').update(JSON.stringify(scope(i))).digest('hex');
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
function fail(code: 'forbidden' | 'corrupt' | 'invalid' | 'identity-conflict' | 'conflict' | 'missing'): never { throw new StorageError(code); }
function identity(value: SpaceIdentity) { const i = spaceIdentitySchema.parse(value); if (i.kind !== 'school') fail('forbidden'); return i; }
const scoped = (row: Row, i: SpaceIdentity) => row.space_environment_id === i.environmentId && row.space_id === i.spaceId && row.principal_id === i.principalId;
const scopedIdentity = (a: SpaceIdentity, b: SpaceIdentity) => same(scope(a), scope(b)) && a.kind === b.kind;

/** Deliberate owner allowlist. No relation name, join or SQL is supplied by a caller. */
const relations = [
  ['activities', '', ''], ['activity_requests', '', ''], ['course_activity_requests', '', ''],
  ['work_heads', 'activity_id', 'activities.id'], ['work_objects', 'activity_id', 'activities.id'],
  ['work_contents', 'activity_id', 'activities.id'], ['work_versions', 'activity_id', 'activities.id'],
  ['work_receipts', 'activity_id', 'activities.id'], ['question_drafts', 'activity_id', 'activities.id'],
  ['question_draft_revisions', 'draft_id', 'question_drafts.draft_id'], ['question_draft_receipts', 'draft_id', 'question_drafts.draft_id'],
  ['action_intents', 'activity_id', 'activities.id'], ['pdf_documents', 'activity_id', 'activities.id'],
  ['pdf_readings', 'activity_id', 'activities.id'], ['personal_materials', 'activity_id', 'activities.id'],
  ['personal_material_versions', 'material_id', 'personal_materials.material_id'],
  ['teaching_artifacts', 'activity_id', 'activities.id'], ['teaching_artifact_revisions', 'artifact_id', 'teaching_artifacts.artifact_id'],
  ['teaching_artifact_candidates', 'revision_id', 'teaching_artifact_revisions.revision_id'],
  ['teaching_artifact_checks', 'candidate_id', 'teaching_artifact_candidates.candidate_id'],
  ['teaching_artifact_receipts', 'activity_id', 'activities.id'],
  ['execution_records', 'activity_id', 'activities.id'], ['execution_record_facts', 'request_id', 'execution_records.request_id'],
  ['execution_record_observations', 'request_id', 'execution_records.request_id'],
  ['activity_agent_routes', 'activity_id', 'activities.id'], ['conversation_archives', 'activity_id', 'activities.id'],
  ['conversation_labels', 'activity_id', 'activities.id'], ['agent_interaction_preferences', '', ''],
  ['execution_commands', 'activity_id', 'activities.id'], ['execution_stops', 'activity_id', 'activities.id'],
  ['execution_results', 'activity_id', 'activities.id'], ['native_sessions', 'activity_id', 'activities.id'],
  ['native_session_operations', 'session_ref', 'native_sessions.session_ref'],
  ['native_session_stops', 'session_ref', 'native_sessions.session_ref'],
  ['native_session_checkpoints', 'session_ref', 'native_sessions.session_ref'],
  ['channel_executions', 'activity_id', 'activities.id'], ['channel_execution_intents', 'request_id', 'channel_executions.request_id'],
  ['channel_session_checkpoints', 'session_ref', 'channel_executions.execution_ref'],
  ['agent_execution_commands', 'activity_id', 'activities.id'],
  ['agent_execution_origins', 'command_id', 'agent_execution_commands.command_id'],
  ['agent_execution_authorities', 'command_id', 'agent_execution_commands.command_id'],
  ['native_channel_commands', 'activity_id', 'activities.id'],
  ['native_channel_late_reports', 'command_id', 'native_channel_commands.command_id'],
  ['native_channel_cleanups', 'command_id', 'native_channel_commands.command_id'],
  ['agent_chunk_transfers', '', ''], ['agent_chunk_parts', '', ''],
] as const;
const chunkTables = new Set(['agent_chunk_transfers', 'agent_chunk_parts']);
const names = relations.map(([name]) => name);
// These are execution-owner histories, not transferable execution authority. Never populate a runnable queue.
const historical = new Set<string>(names.slice(names.indexOf('execution_commands')));
const official = new Set(['activities', 'activity_requests', 'course_activity_requests']);
const quoted = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const normalize = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const sortRows = (rows: Row[]) => normalize(rows).sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));

function scopePredicate(table: string, expression: string, depth = 0): string {
  if (chunkTables.has(table)) return `EXISTS(SELECT 1 FROM study_copy_chunk_scopes c WHERE c.scope_key=e.scope_key
    AND c.source_key=${expression}->>'source_key' AND c.transfer_id::text=${expression}->>'transfer_id')`;
  if (official.has(table)) return `e.identity->>'environmentId'=${expression}->>'space_environment_id'
    AND e.identity->>'spaceId'=${expression}->>'space_id' AND e.identity->>'principalId'=${expression}->>'principal_id'`;
  if (table === 'agent_interaction_preferences') return `e.identity->>'environmentId'=${expression}->'subject'->>0
    AND e.identity->>'spaceId'=${expression}->'subject'->>1 AND e.identity->>'principalId'=${expression}->'subject'->>2`;
  const [, field, parent] = relations.find(([name]) => name === table)!;
  const [relation, column] = parent.split('.'), alias = `p${depth}`;
  return `EXISTS(SELECT 1 FROM ${quoted(relation!)} ${alias} WHERE ${alias}.${quoted(column!)}::text=${expression}->>'${field}'
    AND (${scopePredicate(relation!, `to_jsonb(${alias})`, depth + 1)}))`;
}
// Database fences cover writers which passed the HTTP gate before export began. The owner-only cleanup
// transaction bypass is scope-specific; public clients never receive arbitrary SQL or transaction access.
const guarded = [...names];
const freezeTriggers = relations.filter(([name]) => guarded.includes(name)).map(([table]) => `
CREATE FUNCTION study_copy_guard_${table}() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE r jsonb;
BEGIN
  IF TG_OP='DELETE' THEN r=to_jsonb(OLD); ELSE r=to_jsonb(NEW); END IF;
  ${table === 'activities' ? `IF TG_OP='INSERT' AND r->'body' ? 'course' AND r->'body'->>'question'='' AND r->'body'->'references'='[]'::jsonb
    AND NOT EXISTS(SELECT 1 FROM study_copy_exports e WHERE e.state='frozen' AND (${scopePredicate(table, 'r')}))
    THEN RETURN NEW; END IF;` : ''}
  IF EXISTS(SELECT 1 FROM study_copy_exports e WHERE (${scopePredicate(table, 'r')})
    ${official.has(table) && table !== 'activities' ? "AND e.state='frozen'" : ''}
    AND e.scope_key IS DISTINCT FROM current_setting('xunjie.study_copy_cleanup',true)) THEN
    RAISE EXCEPTION 'school study process is frozen' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $guard$;
CREATE TRIGGER study_copy_guard BEFORE INSERT OR UPDATE OR DELETE ON ${quoted(table)}
  FOR EACH ROW EXECUTE FUNCTION study_copy_guard_${table}();`).join('\n');

export const studyCopyMigration: Migration = { version: 29, name: 'local-school-study-copies', sql: `
CREATE TABLE study_copy_exports(scope_key text PRIMARY KEY,identity jsonb NOT NULL,digest text,
  activity_ids jsonb NOT NULL DEFAULT '[]',resource_ids jsonb NOT NULL DEFAULT '[]',state text NOT NULL CHECK(state IN ('frozen','acknowledged')));
CREATE TABLE study_copy_imports(scope_key text NOT NULL,digest text NOT NULL,identity jsonb NOT NULL,
  source_owner jsonb NOT NULL,target_owner jsonb NOT NULL,manifest jsonb NOT NULL,PRIMARY KEY(scope_key,digest));
CREATE TABLE study_copy_sources(activity_id uuid PRIMARY KEY REFERENCES activities(id),scope_key text NOT NULL,
  source_activity jsonb NOT NULL,source_owner jsonb NOT NULL,target_owner jsonb NOT NULL);
CREATE TABLE study_copy_cache(scope_key text NOT NULL,identity jsonb NOT NULL,cache_key text NOT NULL,value jsonb NOT NULL,
  PRIMARY KEY(scope_key,cache_key));
CREATE TABLE study_copy_chunk_scopes(source_key text NOT NULL,transfer_id uuid NOT NULL,scope_key text NOT NULL
  REFERENCES study_copy_exports(scope_key),resource_ids jsonb NOT NULL,PRIMARY KEY(source_key,transfer_id));
${freezeTriggers}
CREATE FUNCTION study_copy_guard_chunk_resource() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM study_copy_chunk_scopes c WHERE c.resource_ids ? NEW.resource_id::text) THEN
    RAISE EXCEPTION 'school chunk resource is frozen' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER study_copy_guard BEFORE INSERT ON _storage_resources FOR EACH ROW EXECUTE FUNCTION study_copy_guard_chunk_resource();
CREATE FUNCTION study_copy_lock() RETURNS void LANGUAGE plpgsql AS $lock$
BEGIN
  LOCK TABLE ${names.map(quoted).join(',')},_storage_references,_storage_resources,_storage_outbox IN SHARE ROW EXCLUSIVE MODE;
END $lock$;
` };

async function columns(db: Reader, table: string) {
  return (await db.query(`SELECT column_name,data_type,is_generated FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`, [table])).rows;
}
async function checkForeignKeys(db: Reader, tables: Record<string, Row[]>) {
  const constraints = (await db.query(`SELECT c.conrelid::regclass::text AS child,c.confrelid::regclass::text AS parent,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,pos)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.pos) AS child_fields,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,pos)
      JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.pos) AS parent_fields
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE c.contype='f' AND n.nspname=current_schema()`)).rows;
  for (const relation of constraints) {
    const child = String(relation.child), parent = String(relation.parent);
    if (!tables[child] || !tables[parent]) continue;
    const fields = relation.child_fields as string[], parents = relation.parent_fields as string[];
    for (const row of tables[child]!) {
      if (fields.some(f => row[f] === null)) continue;
      if (!tables[parent]!.some(p => fields.every((f, index) => same(row[f], p[parents[index]!])))) fail('forbidden');
    }
  }
}
function checkEmbeddedScope(value: unknown, i: SpaceIdentity, activities: Set<string>): void {
  if (Array.isArray(value)) { for (const v of value) checkEmbeddedScope(v, i, activities); return; }
  if (!value || typeof value !== 'object') return;
  const v = value as Row;
  if (typeof v.environmentId === 'string' && typeof v.spaceId === 'string' && typeof v.principalId === 'string') {
    if (!same([v.environmentId, v.spaceId, v.principalId], scope(i))) fail('forbidden');
    if (typeof v.activityId === 'string' && !activities.has(v.activityId)) fail('forbidden');
  }
  for (const child of Object.values(v)) checkEmbeddedScope(child, i, activities);
}
async function lockTables(tx: Reader) {
  // Fence already-authorized writers as well as future assertWritable calls while taking/comparing the snapshot.
  await tx.query('SELECT study_copy_lock()');
}
function linkedRows(table: string, rows: Row[], tables: Record<string, Row[]>, i: SpaceIdentity) {
  // Transport ownership is established from verified input bytes, never a source service or UUID alone.
  if (chunkTables.has(table)) return true;
  const rule = relations.find(([name]) => name === table)!;
  return rows.every(row => {
    if (official.has(table)) return scoped(row, i);
    if (table === 'agent_interaction_preferences') return row.scope_key === preferenceKey(i) && same(row.subject, scope(i));
    const [parent, column] = rule[2].split('.');
    return (tables[parent!] ?? []).some(p => p[column!] === row[rule[1]])
      && (!('activity_id' in row) || tables.activities!.some(a => a.id === row.activity_id))
      && (!('space_environment_id' in row) || scoped(row, i));
  });
}
const resourcePrefixes = new Set(['work-content', 'question-reference', 'action', 'execution', 'native', 'native-checkpoint',
  'channel', 'agent-execution', 'pdf-document', 'pdf-reading', 'pdf-reading-original', 'teaching-artifact', 'personal-material']);
const chunkRef = (p: Row) => `chunk:${p.source_key}:${p.transfer_id}:${p.direction}:${p.part_index}`;
function chunkResourceId(p: Row) {
  const h = sha(Buffer.from(chunkRef(p)));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const chunkPair = (a: Row, b: Row) => a.source_key === b.source_key && a.transfer_id === b.transfer_id;
const chunkTransferRow = z.object({ source_key: z.string().regex(/^[a-f0-9]{64}$/), transfer_id: z.uuid(),
  input_bytes: z.number().int().min(1).max(16777216), input_sha: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['receiving', 'unknown', 'completed', 'acknowledged']), reserved_bytes: z.number().int().nonnegative(),
  reply_bytes: z.number().int().min(1).max(16777216).nullable(), reply_sha: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
const chunkPartRow = z.object({ source_key: z.string().regex(/^[a-f0-9]{64}$/), transfer_id: z.uuid(),
  direction: z.enum(['input', 'reply']), part_index: z.number().int().min(0).max(63),
  byte_length: z.number().int().min(1).max(262144), sha256: z.string().regex(/^[a-f0-9]{64}$/), resource_id: z.uuid().nullable() }).strict();
function chunkInput(t: Row, parts: Row[], bytes: Map<string, Uint8Array>) {
  const input = parts.filter(p => p.direction === 'input').sort((a, b) => Number(a.part_index) - Number(b.part_index));
  if (input.length !== Math.ceil(Number(t.input_bytes) / 262144)) fail('missing');
  const chunks = input.map((p, index) => {
    if (p.part_index !== index || p.byte_length !== Math.min(262144, Number(t.input_bytes) - index * 262144)) fail('corrupt');
    const b = bytes.get(chunkRef(p)); if (!b) fail('missing');
    if (b.length !== p.byte_length || sha(b) !== p.sha256) fail('corrupt');
    return b;
  });
  const all = Buffer.concat(chunks);
  if (all.length !== t.input_bytes || sha(all) !== t.input_sha) fail('corrupt');
  try { return teachingDependencyCallSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all))); }
  catch { return fail('invalid'); }
}
function ownsChunk(input: z.infer<typeof teachingDependencyCallSchema>, i: SpaceIdentity, activities: Set<string>) {
  if (!input.identity && !input.scope) return false;
  if (input.identity && !scopedIdentity(input.identity, i)) return false;
  if (input.scope && !same([input.scope.environmentId, input.scope.spaceId, input.scope.principalId], scope(i))) return false;
  if ([input.activityId, input.authority?.activityId].some(id => id && !activities.has(id))) return false;
  try { checkEmbeddedScope(input, i, activities); } catch { return false; }
  return true;
}
async function gatherChunks(db: Reader, storage: OwnedStorage, i: SpaceIdentity, activities: Set<string>, frozenOnly = false) {
  const transfers = (await db.query(frozenOnly ? `SELECT t.* FROM agent_chunk_transfers t JOIN study_copy_chunk_scopes c
    USING(source_key,transfer_id) WHERE c.scope_key=$1` : 'SELECT * FROM agent_chunk_transfers', frozenOnly ? [key(i)] : [])).rows;
  const parts = (await db.query(frozenOnly ? `SELECT p.* FROM agent_chunk_parts p JOIN study_copy_chunk_scopes c
    USING(source_key,transfer_id) WHERE c.scope_key=$1` : 'SELECT * FROM agent_chunk_parts', frozenOnly ? [key(i)] : [])).rows;
  const resourceIds = parts.map(p => String(p.resource_id ?? chunkResourceId(p)));
  const resourceRows = new Map((await db.query('SELECT resource_id,reference,state FROM _storage_resources WHERE resource_id=ANY($1::uuid[])', [resourceIds])).rows
    .map(r => [String(r.resource_id), r]));
  const grouped = new Map<string, Row[]>();
  for (const p of parts) {
    const k = `${p.source_key}:${p.transfer_id}`, group = grouped.get(k) ?? [];
    group.push(p); grouped.set(k, group);
  }
  const selected: Row[] = [], selectedParts: Row[] = [], references: { referenceId: string; resourceId: string }[] = [];
  let scanned = 0;
  for (const t of transfers) {
    // File reads use the owner resource verifier's separate connection. Keep the snapshot transaction
    // active between bounded batches, including large historical schools with thousands of parts.
    if (scanned++ % 32 === 0) await db.query('SELECT 1');
    const group = grouped.get(`${t.source_key}:${t.transfer_id}`) ?? [], bytes = new Map<string, Uint8Array>();
    const available: { referenceId: string; resourceId: string }[] = [];
    // Acknowledgement clears resource_id, not the immutable part checksum or deterministic upload ID.
    for (const p of group) {
      const id = typeof p.resource_id === 'string' ? p.resource_id : chunkResourceId(p), row = resourceRows.get(id);
      if (row?.state !== 'ready') continue;
      try {
        const b = await storage.readResource(id);
        if (b.length !== p.byte_length || sha(b) !== p.sha256) continue;
        bytes.set(chunkRef(p), b); available.push({ referenceId: chunkRef(p), resourceId: id });
      } catch (error) {
        if (!(error instanceof StorageError) || !['missing', 'resource-gone', 'corrupt'].includes(error.code)) throw error;
      }
    }
    let input: z.infer<typeof teachingDependencyCallSchema>;
    try { input = chunkInput(t, group, bytes); } catch (error) {
      if (!(error instanceof StorageError) || !['missing', 'corrupt', 'invalid'].includes(error.code)) throw error;
      if (frozenOnly) throw error;
      continue; // Incomplete/collected/unattributable input is not evidence of this member's ownership.
    }
    if (!ownsChunk(input, i, activities)) { if (frozenOnly) fail('forbidden'); continue; }
    chunkTransferRow.parse(t); group.forEach(p => chunkPartRow.parse(p));
    if (group.some(p => ['uploading', 'deleting'].includes(String(resourceRows.get(String(p.resource_id ?? chunkResourceId(p)))?.state))))
      throw new StorageError('resource-busy');
    if (group.some(p => p.resource_id !== null && !bytes.has(chunkRef(p)))) fail('corrupt');
    selected.push(t); selectedParts.push(...group); references.push(...available);
  }
  return { transfers: sortRows(selected), parts: sortRows(selectedParts), references };
}
function checkChunks(t: StudyTransfer, i: SpaceIdentity) {
  const transfers = t.tables.agent_chunk_transfers!, parts = t.tables.agent_chunk_parts!;
  const bytes = new Map<string, Uint8Array>();
  const resourceMap = new Map(t.resources.map(r => [r.reference.resourceId, r]));
  for (const p of parts) {
    chunkPartRow.parse(p);
    if (!transfers.some(r => chunkPair(r, p))) fail('forbidden');
    const ref = t.references.find(r => r.referenceId === chunkRef(p));
    if (!ref) { if (p.resource_id !== null) fail('corrupt'); continue; }
    if (ref.resourceId !== (p.resource_id ?? chunkResourceId(p))) fail('forbidden');
    const resource = resourceMap.get(ref.resourceId); if (!resource) fail('corrupt');
    const b = Buffer.from(resource.base64, 'base64');
    if (b.length !== p.byte_length || sha(b) !== p.sha256) fail('corrupt');
    bytes.set(ref.referenceId, b);
  }
  const activities = new Set(t.tables.activities!.map(a => String(a.id)));
  for (const row of transfers) {
    chunkTransferRow.parse(row);
    const group = parts.filter(p => chunkPair(p, row));
    if (!ownsChunk(chunkInput(row, group, bytes), i, activities)) fail('forbidden');
    if (row.state === 'completed') {
      const reply = group.filter(p => p.direction === 'reply').sort((a, b) => Number(a.part_index) - Number(b.part_index));
      if (!row.reply_bytes || reply.length !== Math.ceil(Number(row.reply_bytes) / 262144)
        || reply.some((p, index) => p.part_index !== index || !bytes.has(chunkRef(p)))) fail('corrupt');
      const all = Buffer.concat(reply.map(p => bytes.get(chunkRef(p))!));
      if (all.length !== row.reply_bytes || sha(all) !== row.reply_sha) fail('corrupt');
    }
  }
  if (new Set(transfers.map(r => `${r.source_key}:${r.transfer_id}`)).size !== transfers.length
    || new Set(parts.map(chunkRef)).size !== parts.length) fail('invalid');
}
function rowIds(tables: Record<string, Row[]>) {
  const ids = new Set<string>();
  for (const rows of Object.values(tables)) for (const row of rows) for (const [field, value] of Object.entries(row)) {
    if ((field === 'id' || field.endsWith('_id') || field === 'session_ref') && typeof value === 'string'
      && !['space_environment_id', 'space_id', 'principal_id', 'connection_id', 'installation_id', 'release_id', 'association_id'].includes(field)) ids.add(value);
  }
  return ids;
}
function ownReference(ref: string, ids: Set<string>, tables: Record<string, Row[]>) {
  if (ref.startsWith('chunk:')) return (tables.agent_chunk_parts ?? []).some(p => chunkRef(p) === ref);
  const parts = ref.split(/[/:]/); return resourcePrefixes.has(parts[0]!) && ids.has(parts[1]!);
}
function ownRequest(requestId: string, ids: Set<string>, i: SpaceIdentity) {
  return !/^(study-copy|school-deliver|school-submission|school-receipt)/.test(requestId) && (['agent-preferences', 'conversation-archives', 'conversation-history'].some(prefix => requestId.startsWith(`${prefix}:${preferenceKey(i)}:`))
    || requestId.split(/[/:]/).some(part => ids.has(part)));
}
function ownedReceipt(requestId: string, fingerprint: string, result: unknown, ids: Set<string>, i: SpaceIdentity) {
  if (ownRequest(requestId, ids, i)) return true;
  if ((requestId.startsWith('action-state:') || requestId.startsWith('execution-fact:')) && ids.has(fingerprint)) return true;
  // Some internal observation receipts use a random operation UUID; their stored activity/session
  // projection, not that random UUID, establishes ownership. Never claim a mixed-scope result.
  if (!/^(native-|agent-|execution-|pdf-|personal-material-)/.test(requestId)) return false;
  let found = false, foreign = false;
  function visit(v: unknown) {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== 'object') return;
    const r = v as Row;
    for (const field of ['activityId', 'activity_id', 'session_ref', 'sessionRef', 'materialId', 'documentId', 'readingId']) {
      if (typeof r[field] === 'string') { if (ids.has(r[field])) found = true; else foreign = true; }
    }
    if ('space_environment_id' in r && !scoped(r, i)) foreign = true;
    if ('environmentId' in r && 'spaceId' in r && 'principalId' in r
      && !same([r.environmentId, r.spaceId, r.principalId], scope(i))) foreign = true;
    Object.values(r).forEach(visit);
  }
  visit(result); return found && !foreign;
}
async function gather(db: Reader, i: SpaceIdentity, storage: OwnedStorage) {
  const tables: Record<string, Row[]> = {};
  for (const [table, field, parent] of relations) {
    if (chunkTables.has(table)) continue;
    let rows: Row[];
    const projection = (await columns(db, table)).map(c => ['timestamp with time zone', 'timestamp without time zone'].includes(String(c.data_type))
      ? `${quoted(String(c.column_name))}::text AS ${quoted(String(c.column_name))}` : quoted(String(c.column_name))).join(',');
    if (official.has(table)) rows = (await db.query(`SELECT ${projection} FROM ${quoted(table)} WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3`, scope(i))).rows;
    else if (table === 'agent_interaction_preferences') rows = (await db.query('SELECT * FROM agent_interaction_preferences WHERE scope_key=$1', [preferenceKey(i)])).rows;
    else {
      const [relation, column] = parent.split('.');
      const ids = (tables[relation!] ?? []).map(row => row[column!]);
      rows = ids.length ? (await db.query(`SELECT ${projection} FROM ${quoted(table)} WHERE ${quoted(field)}=ANY($1::uuid[])`, [ids])).rows : [];
    }
    tables[table] = sortRows(rows);
  }
  const chunks = await gatherChunks(db, storage, i, new Set(tables.activities!.map(a => String(a.id))), true);
  tables.agent_chunk_transfers = chunks.transfers; tables.agent_chunk_parts = chunks.parts;
  const ids = rowIds(tables);
  const references = (await db.query('SELECT reference_id,resource_id FROM _storage_references')).rows
    .filter(row => !String(row.reference_id).startsWith('chunk:') && ownReference(String(row.reference_id), ids, tables))
    .map(row => ({ referenceId: String(row.reference_id), resourceId: String(row.resource_id) }))
    .concat(chunks.references)
    .sort((a, b) => a.referenceId.localeCompare(b.referenceId));
  const deliveries = new Set<string>();
  for (const table of ['school_acquisitions', 'school_submissions']) {
    if ((await db.query('SELECT to_regclass($1) AS relation', [table])).rows[0]?.relation) {
      for (const row of (await db.query(`SELECT request_id::text FROM ${quoted(table)}`)).rows) deliveries.add(String(row.request_id));
    }
  }
  const receipts = (await db.query('SELECT request_id,fingerprint,result,committed_at::text FROM _storage_requests')).rows
    .filter(row => !deliveries.has(String(row.request_id)))
    .filter(row => ownedReceipt(String(row.request_id), String(row.fingerprint), row.result, ids, i)).map(row => ({ requestId: String(row.request_id),
      fingerprint: String(row.fingerprint), result: row.result ?? null,
      committedAt: row.committed_at ? String(row.committed_at) : null }))
    .sort((a, b) => a.requestId.localeCompare(b.requestId));
  const requests = receipts.map(row => row.requestId);
  const outbox = requests.length ? (await db.query('SELECT intent_id,request_id,payload,completed_at::text FROM _storage_outbox WHERE request_id=ANY($1::text[])', [requests])).rows
    .map(row => ({ intentId: String(row.intent_id), requestId: String(row.request_id), payload: row.payload,
      completedAt: row.completed_at ? String(row.completed_at) : null }))
    .sort((a, b) => a.intentId.localeCompare(b.intentId)) : [];
  return normalize({ tables, references, receipts, outbox });
}
function transferDigest(t: Omit<StudyTransfer, 'digest'> | StudyTransfer) {
  const { digest: _ignored, ...rest } = t as StudyTransfer;
  return hash(rest);
}
async function materialize(storage: OwnedStorage, i: SpaceIdentity, data: Awaited<ReturnType<typeof gather>>): Promise<StudyTransfer> {
  const resources = [];
  for (const id of [...new Set(data.references.map(r => r.resourceId))].sort()) {
    const reference = await storage.resource(id), bytes = await storage.readResource(id);
    if (sha(bytes) !== reference.sha256 || bytes.length !== reference.byteLength) fail('corrupt');
    resources.push({ reference, base64: Buffer.from(bytes).toString('base64') });
  }
  const content = studyTransferSchema.omit({ digest: true }).parse({ version: 1, identity: i, sourceOwner: storage.owner, ...data, resources });
  return { ...content, digest: transferDigest(content) };
}

function checkedSource(storage: OwnedStorage, row: Row, i: SpaceIdentity) {
  const source = activitySchema.parse(row.source_activity), local = activitySchema.parse(row.body);
  if (row.scope_key !== key(i) || !scopedIdentity(source.identity, i) || !scopedIdentity(local.identity, i)) fail('forbidden');
  if (source.activityId !== row.activity_id || local.activityId !== source.activityId
    || !scoped(row, i) || !same(source.course ?? null, local.course ?? null)
    || !same(source.target, { ...(row.source_owner as object), version: 1 })
    || same(row.source_owner, storage.owner) || !same(row.target_owner, storage.owner)
    || !same(local.target, { ...storage.owner, version: 1 })) fail('corrupt');
  return source;
}

/** Only the persisted import proves a move; a caller cannot supply its own source activity. */
async function readSourceActivity(storage: OwnedStorage, value: SpaceIdentity, activityId: string): Promise<LearningActivity | null> {
  const i = identity(value); z.uuid().parse(activityId);
  const rows = (await storage.read(`SELECT s.*,a.body,a.space_environment_id,a.space_id,a.principal_id
    FROM study_copy_sources s LEFT JOIN activities a ON a.id=s.activity_id
    WHERE s.scope_key=$1 AND s.activity_id=$2`, [key(i), activityId])).rows;
  if (!rows.length) {
    if ((await storage.read('SELECT 1 FROM study_copy_sources WHERE activity_id=$1', [activityId])).rows.length) fail('forbidden');
    return null;
  }
  return checkedSource(storage, rows[0]!, i);
}

/** Read-only legacy facts. They deliberately never enter execution_commands or an executor queue. */
export async function readStudyExecution(storage: OwnedStorage, activity: LearningActivity, requestId: string) {
  if (activity.identity.kind !== 'school') return null;
  // An independent tool-execution owner has no learning-data import ledger.
  if (!(await storage.read("SELECT to_regclass(current_schema() || '.study_copy_sources') AS relation")).rows[0]?.relation) return null;
  const original = await readSourceActivity(storage, activity.identity, activity.activityId);
  if (!original) return null;
  if (!same(activity.target, { ...storage.owner, version: 1 }) || !same(activity.course ?? null, original.course ?? null)) fail('forbidden');
  const rows = (await storage.read(`SELECT * FROM study_copy_imports WHERE scope_key=$1
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(manifest->'tables'->'execution_commands') c
      WHERE c->>'request_id'=$2)`, [key(activity.identity), requestId])).rows;
  if (!rows.length) return null;
  if (rows.length !== 1) fail('corrupt');
  const row = rows[0]!, transfer = studyTransferSchema.parse(row.manifest);
  if (row.digest !== transfer.digest || !scopedIdentity(transfer.identity, activity.identity)
    || !scopedIdentity(spaceIdentitySchema.parse(row.identity), activity.identity)
    || !same(row.source_owner, transfer.sourceOwner) || !same(row.target_owner, storage.owner)
    || !same(original.target, { ...transfer.sourceOwner, version: 1 })) fail('corrupt');
  const saved = transfer.tables.activities?.find(a => a.id === activity.activityId);
  const commands = transfer.tables.execution_commands?.filter(c => c.request_id === requestId) ?? [];
  const results = transfer.tables.execution_results?.filter(r => r.request_id === requestId) ?? [];
  if (!saved || !same(saved.body, original) || commands.length !== 1 || results.length > 1) fail('corrupt');
  const command = commands[0]!;
  if (command.activity_id !== activity.activityId || results.some(r => r.activity_id !== activity.activityId)) fail('forbidden');
  return { activity: original, command, result: results[0] ?? null };
}

export async function studyExecutionRequests(storage: OwnedStorage, activity: LearningActivity, cursor?: string): Promise<string[]> {
  if (activity.identity.kind !== 'school') return [];
  if (!(await storage.read("SELECT to_regclass(current_schema() || '.study_copy_sources') AS relation")).rows[0]?.relation) return [];
  if (!await readSourceActivity(storage, activity.identity, activity.activityId)) return [];
  const rows = (await storage.read(`SELECT c->>'request_id' AS request_id FROM study_copy_imports i,
    jsonb_array_elements(i.manifest->'tables'->'execution_commands') c WHERE i.scope_key=$1
    AND c->>'activity_id'=$2 AND ($3::text IS NULL OR c->>'request_id'>$3)
    ORDER BY c->>'request_id' LIMIT 33`, [key(activity.identity), activity.activityId, cursor ?? null])).rows;
  return rows.map(row => z.uuid().parse(row.request_id));
}

/** Host calls these methods only for its authenticated current school identity. */
export function createStudyCopies(storage: OwnedStorage) {
  const db: Reader = { query: storage.read.bind(storage) };
  const localTarget = { ...storage.owner, version: 1 as const };
  async function assertWritable(value: SpaceIdentity) {
    const i = identity(value);
    if ((await db.query('SELECT 1 FROM study_copy_exports WHERE scope_key=$1', [key(i)])).rows.length) fail('forbidden');
  }
  async function exportScope(value: SpaceIdentity): Promise<StudyTransfer> {
    const i = identity(value);
    await storage.request({ requestId: `study-copy:freeze:${key(i)}`, fingerprint: key(i) }, async tx => {
      await lockTables(tx);
      await tx.query(`INSERT INTO study_copy_exports(scope_key,identity,state) VALUES($1,$2,'frozen') ON CONFLICT DO NOTHING`, [key(i), JSON.stringify(i)]);
      const activities = (await tx.query('SELECT id FROM activities WHERE space_environment_id=$1 AND space_id=$2 AND principal_id=$3', scope(i))).rows;
      const chunks = await gatherChunks(tx, storage, i, new Set(activities.map(a => String(a.id))));
      for (const c of chunks.transfers) {
        const resourceIds = chunks.parts.filter(p => chunkPair(p, c)).map(p => String(p.resource_id ?? chunkResourceId(p)));
        await tx.query(`INSERT INTO study_copy_chunk_scopes VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [c.source_key, c.transfer_id, key(i), JSON.stringify(resourceIds)]);
        const assigned = (await tx.query('SELECT scope_key FROM study_copy_chunk_scopes WHERE source_key=$1 AND transfer_id=$2', [c.source_key, c.transfer_id])).rows[0];
        if (assigned?.scope_key !== key(i)) fail('forbidden');
      }
      // Temporarily pin verified orphan bytes until the local durable import is acknowledged.
      for (const r of chunks.references) await tx.reference(r.referenceId, r.resourceId);
      return { frozen: true };
    });
    let data: Awaited<ReturnType<typeof gather>> | undefined;
    await storage.request({ requestId: `study-copy:snapshot:${randomUUID()}`, fingerprint: key(i) }, async tx => {
      await lockTables(tx);
      const row = (await tx.query('SELECT state FROM study_copy_exports WHERE scope_key=$1 FOR UPDATE', [key(i)])).rows[0];
      if (row?.state !== 'frozen') fail('conflict');
      data = await gather(tx, i, storage);
      return null;
    });
    const transfer = await materialize(storage, i, data!);
    await storage.request({ requestId: `study-copy:export:${key(i)}:${transfer.digest}`, fingerprint: transfer.digest }, async tx => {
      await tx.query(`UPDATE study_copy_exports SET digest=$2,activity_ids=$3,identity=$4 WHERE scope_key=$1 AND state='frozen'`,
        [key(i), transfer.digest, JSON.stringify(transfer.tables.activities!.map(a => a.id)), JSON.stringify(i)]);
      return { digest: transfer.digest };
    });
    return transfer;
  }
  async function checkTransfer(i: SpaceIdentity, value: StudyTransfer) {
    const t = studyTransferSchema.parse(value);
    if (!scopedIdentity(i, t.identity) || same(t.sourceOwner, storage.owner)) fail('forbidden');
    if (t.digest !== transferDigest(t)) fail('corrupt');
    if (!same(Object.keys(t.tables).sort(), [...names].sort())) fail('invalid');
    for (const [table] of relations) {
      const fields = (await columns(db, table)).map(c => c.column_name as string).sort();
      for (const row of t.tables[table]!) if (!same(Object.keys(row).sort(), fields)) fail('invalid');
      if (!linkedRows(table, t.tables[table]!, t.tables, i)) fail('forbidden');
    }
    await checkForeignKeys(db, t.tables);
    const activityIds = new Set(t.tables.activities!.map(a => String(a.id)));
    checkEmbeddedScope(t.tables, i, activityIds);
    checkEmbeddedScope(t.receipts, i, activityIds);
    checkEmbeddedScope(t.outbox, i, activityIds);
    for (const row of t.tables.activities!) {
      const a = activitySchema.parse(row.body);
      if (a.activityId !== row.id || !scopedIdentity(a.identity, i) || !same(a.target, { ...t.sourceOwner, version: 1 })) fail('forbidden');
    }
    const ids = rowIds(t.tables), resources = new Map(t.resources.map(r => [r.reference.resourceId, r]));
    if (resources.size !== t.resources.length || new Set(t.references.map(r => r.referenceId)).size !== t.references.length) fail('invalid');
    for (const r of t.resources) {
      const bytes = Buffer.from(r.base64, 'base64');
      if (!same(r.reference.owner, t.sourceOwner) || bytes.toString('base64') !== r.base64
        || sha(bytes) !== r.reference.sha256 || bytes.length !== r.reference.byteLength) fail('corrupt');
      if (!t.references.some(x => x.resourceId === r.reference.resourceId)) fail('invalid');
    }
    for (const r of t.references) if (!ownReference(r.referenceId, ids, t.tables) || !resources.has(r.resourceId)) fail('forbidden');
    checkChunks(t, i);
    if (new Set(t.receipts.map(r => r.requestId)).size !== t.receipts.length) fail('invalid');
    for (const r of t.receipts) if (!ownedReceipt(r.requestId, r.fingerprint, r.result, ids, i)) fail('forbidden');
    for (const r of t.outbox) if (!t.receipts.some(x => x.requestId === r.requestId)) fail('forbidden');
    return t;
  }
  async function insertRow(tx: Reader, table: string, row: Row) {
    const fields = (await columns(tx, table)).filter(c => c.is_generated === 'NEVER');
    const record = Object.fromEntries(fields.map(c => [String(c.column_name), row[String(c.column_name)]]));
    // json_populate_record uses the owner's exact SQL types, including arrays, timestamps and JSON.
    const result = await tx.query(`INSERT INTO ${quoted(table)} (${fields.map(c => quoted(String(c.column_name))).join(',')})
      SELECT ${fields.map(c => quoted(String(c.column_name))).join(',')} FROM json_populate_record(NULL::${quoted(table)},$1::json)
      ON CONFLICT DO NOTHING RETURNING *`, [JSON.stringify(record)]);
    if (!result.rowCount) fail('identity-conflict');
  }
  async function importScope(value: SpaceIdentity, input: StudyTransfer): Promise<StudyImportReceipt> {
    const i = identity(value), t = await checkTransfer(i, input);
    const previous = (await db.query('SELECT digest FROM study_copy_imports WHERE scope_key=$1 AND digest=$2', [key(i), t.digest])).rows[0];
    if (previous) return { digest: t.digest, activityIds: t.tables.activities!.map(a => String(a.id)) };
    const mapped = new Map<string, ResourceReference>();
    for (const r of t.resources) {
      const local = await storage.stageResource({ uploadId: r.reference.resourceId, scope: r.reference.scope,
        bytes: Buffer.from(r.base64, 'base64'), mediaType: r.reference.mediaType, contentVersion: r.reference.contentVersion });
      if (sha(await storage.readResource(local.resourceId)) !== r.reference.sha256) fail('corrupt');
      mapped.set(local.resourceId, local);
    }
    function relocate(v: unknown): unknown {
      if (Array.isArray(v)) return v.map(relocate);
      if (!v || typeof v !== 'object') return v;
      const ref = resourceReferenceSchema.safeParse(v);
      if (ref.success && same(ref.data.owner, t.sourceOwner) && mapped.has(ref.data.resourceId)) return mapped.get(ref.data.resourceId);
      const a = activitySchema.safeParse(v);
      if (a.success && scopedIdentity(a.data.identity, i)) return { ...a.data, target: localTarget };
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, relocate(x)]));
    }
    const result = await storage.request({ requestId: `study-copy:import:${key(i)}:${t.digest}`, fingerprint: t.digest }, async tx => {
      await lockTables(tx);
      for (const [table] of relations) {
        if (historical.has(table)) continue;
        for (const row of t.tables[table]!) await insertRow(tx, table, relocate(row) as Row);
      }
      for (const r of t.receipts) {
        // Preserve fingerprints and unknown outcomes. A receipt is not permission to redispatch.
        await insertRow(tx, '_storage_requests', { request_id: r.requestId, fingerprint: r.fingerprint,
          result: relocate(r.result), committed_at: r.committedAt });
      }
      for (const r of t.references) await tx.reference(r.referenceId, r.resourceId);
      for (const row of t.tables.activities!) await tx.query(`INSERT INTO study_copy_sources VALUES($1,$2,$3,$4,$5)`,
        [row.id, key(i), JSON.stringify(row.body), JSON.stringify(t.sourceOwner), JSON.stringify(storage.owner)]);
      // Original execution ledgers/outbox and receipt identities remain auditable, without executable local queues.
      const manifest = { ...t, resources: t.resources.map(r => ({ ...r, base64: '' })) };
      await tx.query('INSERT INTO study_copy_imports VALUES($1,$2,$3,$4,$5,$6)',
        [key(i), t.digest, JSON.stringify(i), JSON.stringify(t.sourceOwner), JSON.stringify(storage.owner), JSON.stringify(manifest)]);
      return { digest: t.digest, activityIds: t.tables.activities!.map(a => String(a.id)) };
    });
    return result.result as StudyImportReceipt;
  }
  async function collectReleased(resourceIds: string[]) {
    // Never widen to an owner-wide sweep. A formal submission or backup pin can still retain a resource.
    for (let offset = 0; offset < resourceIds.length; offset += 1000) {
      await storage.collect({ olderThan: new Date(Date.now() + 1000), resourceIds: resourceIds.slice(offset, offset + 1000), limit: 1000 });
    }
  }
  async function acknowledgeExport(value: SpaceIdentity, input: { digest: string }): Promise<StudyExportReceipt> {
    const i = identity(value), digest = z.string().regex(/^[a-f0-9]{64}$/).parse(input.digest);
    const existing = (await db.query('SELECT * FROM study_copy_exports WHERE scope_key=$1', [key(i)])).rows[0];
    if (!existing || existing.digest !== digest) fail('conflict');
    if (existing.state === 'acknowledged') {
      await collectReleased(z.array(z.uuid()).parse(existing.resource_ids));
      return { digest, activityIds: existing.activity_ids as string[], state: 'acknowledged' };
    }
    // Resource bytes are immutable and verified before entering the deletion transaction.
    const expected = await materialize(storage, spaceIdentitySchema.parse(existing.identity), await gather(db, i, storage));
    if (expected.digest !== digest) fail('conflict');
    const result = await storage.request({ requestId: `study-copy:ack:${key(i)}:${digest}`, fingerprint: digest }, async tx => {
      await lockTables(tx);
      const row = (await tx.query('SELECT * FROM study_copy_exports WHERE scope_key=$1 FOR UPDATE', [key(i)])).rows[0];
      if (!row || row.digest !== digest) fail('conflict');
      if (row.state === 'acknowledged') return { digest, activityIds: row.activity_ids, state: 'acknowledged' };
      const current = await gather(tx, i, storage);
      if (!same(current, { tables: expected.tables, references: expected.references, receipts: expected.receipts, outbox: expected.outbox })) fail('conflict');
      await tx.query("SELECT set_config('xunjie.study_copy_cleanup',$1,true)", [key(i)]);
      for (const [table] of [...relations].reverse()) {
        if (official.has(table)) continue;
        if (table === 'agent_chunk_transfers') {
          for (const record of current.tables[table]!) {
            // Keep a non-replayable tombstone. An unknown effect stays unknown, never a successful ack.
            await tx.query(`UPDATE agent_chunk_transfers SET state=CASE WHEN state='completed' THEN 'acknowledged' ELSE state END,
              reserved_bytes=0 WHERE source_key=$1 AND transfer_id=$2`, [record.source_key, record.transfer_id]);
          }
          continue;
        }
        // Exact selected records, not a caller-provided predicate; concurrent foreign scopes are untouched.
        for (const record of current.tables[table]!) await tx.query(`DELETE FROM ${quoted(table)} t WHERE t IS NOT DISTINCT FROM json_populate_record(NULL::${quoted(table)},$1::json)`, [JSON.stringify(record)]);
      }
      for (const r of current.references) await tx.unreference(r.referenceId);
      for (const r of current.outbox) await tx.query('DELETE FROM _storage_outbox WHERE intent_id=$1 AND request_id=$2', [r.intentId, r.requestId]);
      for (const r of current.receipts) {
        if (current.tables.activity_requests!.some(x => x.request_id === r.requestId)) continue;
        await tx.query('DELETE FROM _storage_requests WHERE request_id=$1 AND fingerprint=$2', [r.requestId, r.fingerprint]);
      }
      // The official course registration remains, including original school data binding. Private initial text does not.
      for (const record of current.tables.activities!) {
        const a = activitySchema.parse(record.body), clean = { ...a, question: '', references: [], goal: a.course?.taskTitle ?? '',
          // Closing/reopening learning is local; the retained official course registration must still accept submissions.
          ...(a.course ? { status: 'open' as const } : {}) };
        await tx.query('UPDATE activities SET body=$2 WHERE id=$1', [a.activityId, JSON.stringify(clean)]);
        await tx.query(`UPDATE _storage_requests SET result=$2 WHERE result->>'activityId'=$1
          AND request_id IN (SELECT request_id::text FROM activity_requests WHERE space_environment_id=$3 AND space_id=$4 AND principal_id=$5)`,
          [a.activityId, JSON.stringify(clean), ...scope(i)]);
        await tx.query('UPDATE course_activity_requests SET result=$2 WHERE activity_id=$1 AND state=\'accepted\'', [a.activityId, JSON.stringify(clean)]);
      }
      await tx.query("UPDATE study_copy_exports SET state='acknowledged',resource_ids=$2 WHERE scope_key=$1",
        [key(i), JSON.stringify(expected.resources.map(r => r.reference.resourceId))]);
      return { digest, activityIds: row.activity_ids, state: 'acknowledged' };
    });
    await collectReleased(expected.resources.map(r => r.reference.resourceId));
    return result.result as StudyExportReceipt;
  }
  async function importActivities(value: SpaceIdentity, values: LearningActivity[]) {
    const i = identity(value), activities = z.array(activitySchema).parse(values);
    for (const a of activities) if (!scopedIdentity(a.identity, i) || same(a.target, localTarget)) fail('forbidden');
    const digest = hash(activities);
    const receipt = await storage.request({ requestId: `study-copy:activities:${key(i)}:${digest}`, fingerprint: digest }, async tx => {
      for (const a of activities) {
        const found = (await tx.query('SELECT scope_key,source_activity FROM study_copy_sources WHERE activity_id=$1', [a.activityId])).rows[0];
        if (found) {
          const source = activitySchema.parse(found.source_activity);
          if (found.scope_key !== key(i) || !same(source.course ?? null, a.course ?? null) || !same(source.target, a.target)) fail('identity-conflict');
          continue;
        }
        await insertRow(tx, 'activities', { id: a.activityId, space_environment_id: i.environmentId, space_id: i.spaceId,
          principal_id: i.principalId, body: { ...a, target: localTarget } });
        await tx.query('INSERT INTO study_copy_sources VALUES($1,$2,$3,$4,$5)', [a.activityId, key(i), JSON.stringify(a),
          JSON.stringify({ environmentId: a.target.environmentId, serviceId: a.target.serviceId }), JSON.stringify(storage.owner)]);
      }
      return { digest, activityIds: activities.map(a => a.activityId) };
    });
    return receipt.result as StudyImportReceipt;
  }
  async function cache(value: SpaceIdentity, cacheKey: string, input: unknown) {
    const i = identity(value), name = z.string().min(1).max(1000).parse(cacheKey), valueJson = z.json().parse(input);
    await storage.request({ requestId: `study-copy:cache:${randomUUID()}`, fingerprint: hash([key(i), name, valueJson]) }, async tx => {
      await tx.query(`INSERT INTO study_copy_cache VALUES($1,$2,$3,$4) ON CONFLICT(scope_key,cache_key)
        DO UPDATE SET value=EXCLUDED.value`, [key(i), JSON.stringify(i), name, JSON.stringify(valueJson)]);
      return null;
    });
  }
  async function cached<T = unknown>(value: SpaceIdentity, cacheKey: string): Promise<T | null> {
    const i = identity(value);
    return ((await db.query('SELECT value FROM study_copy_cache WHERE scope_key=$1 AND cache_key=$2', [key(i), cacheKey])).rows[0]?.value ?? null) as T | null;
  }
  async function hasIdentity(value: SpaceIdentity) {
    const i = identity(value);
    return !!(await db.query(`SELECT 1 FROM study_copy_sources WHERE scope_key=$1 UNION ALL
      SELECT 1 FROM study_copy_imports WHERE scope_key=$1 LIMIT 1`, [key(i)])).rows.length;
  }
  async function assertCourse(value: SpaceIdentity, pointer: CourseBindingPointer) {
    const i = identity(value);
    const rows = (await db.query('SELECT source_activity FROM study_copy_sources WHERE scope_key=$1', [key(i)])).rows;
    if (!rows.some(row => { const c = activitySchema.parse(row.source_activity).course; return c && c.associationId === pointer.associationId
      && c.releaseId === pointer.releaseId && c.contentDigest === pointer.contentDigest; })) fail('forbidden');
  }
  async function hasExecutionRequest(value: SpaceIdentity, activityId: string, requestId: string) {
    const i = identity(value); z.uuid().parse(activityId); z.uuid().parse(requestId);
    // Native/channel/Agent ledgers may have no display projection. Their old request identities
    // still forbid new dispatch; checking this ledger does not restore a runnable session.
    const tables = ['execution_commands', 'native_sessions', 'channel_executions', 'agent_execution_commands'];
    const rows = (await db.query(`SELECT * FROM study_copy_imports i WHERE scope_key=$1 AND EXISTS(
      SELECT 1 FROM jsonb_each(i.manifest->'tables') t, jsonb_array_elements(t.value) r
      WHERE t.key=ANY($2::text[]) AND r->>'request_id'=$3)`, [key(i), tables, requestId])).rows;
    if (!rows.length) return false;
    const source = await readSourceActivity(storage, i, activityId);
    if (!source) fail('forbidden');
    for (const row of rows) {
      const transfer = studyTransferSchema.parse(row.manifest);
      if (row.digest !== transfer.digest || !scopedIdentity(transfer.identity, i)
        || !scopedIdentity(spaceIdentitySchema.parse(row.identity), i) || !same(row.source_owner, transfer.sourceOwner)
        || !same(row.target_owner, storage.owner) || !same(source.target, { ...transfer.sourceOwner, version: 1 })) fail('corrupt');
      const original = transfer.tables.activities?.find(a => a.id === activityId);
      if (!original || !same(original.body, source)) fail('forbidden');
      for (const table of tables) for (const record of transfer.tables[table] ?? [])
        if (record.request_id === requestId && record.activity_id !== activityId) fail('forbidden');
    }
    return true;
  }
  return { exportScope, importScope, acknowledgeExport, assertWritable, cache, cached, hasIdentity, assertCourse, importActivities,
    hasExecutionRequest, sourceActivity: (value: SpaceIdentity, activityId: string) => readSourceActivity(storage, value, activityId) };
}

/** Every new table participates in backup validation, including original (non-runnable) execution histories. */
export async function validateStudyCopies(storage: OwnedStorage) {
  const guards = (await storage.read(`SELECT c.relname,t.tgenabled FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND t.tgname='study_copy_guard' AND NOT t.tgisinternal`)).rows;
  if (!same(guards.filter(g => g.tgenabled === 'O' || g.tgenabled === 'A').map(g => g.relname).sort(),
    [...guarded, '_storage_resources'].sort())) fail('corrupt');
  for (const row of (await storage.read('SELECT * FROM study_copy_exports')).rows) {
    const i = identity(spaceIdentitySchema.parse(row.identity));
    if (row.scope_key !== key(i) || !['frozen', 'acknowledged'].includes(String(row.state))) fail('corrupt');
    if (row.digest !== null) z.string().regex(/^[a-f0-9]{64}$/).parse(row.digest);
    z.array(z.uuid()).parse(row.activity_ids); z.array(z.uuid()).parse(row.resource_ids);
  }
  for (const row of (await storage.read(`SELECT c.*,e.identity FROM study_copy_chunk_scopes c
    LEFT JOIN study_copy_exports e ON e.scope_key=c.scope_key`)).rows) {
    z.string().regex(/^[a-f0-9]{64}$/).parse(row.source_key); z.uuid().parse(row.transfer_id);
    const resources = z.array(z.uuid()).parse(row.resource_ids);
    if (new Set(resources).size !== resources.length) fail('corrupt');
    if (row.scope_key !== key(identity(spaceIdentitySchema.parse(row.identity)))) fail('corrupt');
    const found = (await storage.read('SELECT 1 FROM agent_chunk_transfers WHERE source_key=$1 AND transfer_id=$2', [row.source_key, row.transfer_id])).rows;
    if (found.length !== 1) fail('corrupt');
  }
  for (const row of (await storage.read('SELECT s.*,a.body FROM study_copy_sources s LEFT JOIN activities a ON a.id=s.activity_id')).rows) {
    const source = activitySchema.parse(row.source_activity), local = activitySchema.parse(row.body);
    if (row.scope_key !== key(source.identity) || source.activityId !== row.activity_id || local.activityId !== source.activityId
      || !scopedIdentity(source.identity, local.identity) || !same(source.course ?? null, local.course ?? null) || !same(row.source_owner, { environmentId: source.target.environmentId, serviceId: source.target.serviceId })
      || !same(row.target_owner, storage.owner) || !same(local.target, { ...storage.owner, version: 1 })) fail('corrupt');
  }
  for (const row of (await storage.read('SELECT * FROM study_copy_imports')).rows) {
    const t = studyTransferSchema.parse(row.manifest), i = identity(spaceIdentitySchema.parse(row.identity));
    if (row.scope_key !== key(i) || !scopedIdentity(t.identity, i) || row.digest !== t.digest
      || !same(row.source_owner, t.sourceOwner) || !same(row.target_owner, storage.owner)
      || !same(Object.keys(t.tables).sort(), [...names].sort())) fail('corrupt');
    for (const [table] of relations) if (!linkedRows(table, t.tables[table]!, t.tables, i)) fail('corrupt');
    for (const r of t.resources) {
      const bytes = await storage.readResource(r.reference.resourceId);
      if (sha(bytes) !== r.reference.sha256 || bytes.length !== r.reference.byteLength) fail('corrupt');
      r.base64 = Buffer.from(bytes).toString('base64');
    }
    checkChunks(t, i);
    if (transferDigest(t) !== t.digest) fail('corrupt');
  }
  for (const row of (await storage.read('SELECT * FROM study_copy_cache')).rows) {
    if (row.scope_key !== key(identity(spaceIdentitySchema.parse(row.identity)))) fail('corrupt');
    z.string().min(1).max(1000).parse(row.cache_key); z.json().parse(row.value);
  }
}
