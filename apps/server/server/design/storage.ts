import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../app/errors.ts';
import type { Transaction, SqlRow } from '../db/transaction.ts';
import { prepareMaterial } from './material.ts';
import { draftSchema, type BlueprintDraft } from './model.ts';
import { createDraft, copyDraft, editDraft } from './draft.ts';
import { checkDraft, type TeacherConcern } from './checks.ts';

import { resultSchema, resourceSchema, reportSchema } from '../../contracts/design/results.ts';
export { resultSchema, resourceSchema, teacherConcernSchema, reportSchema } from '../../contracts/design/results.ts';
const id = z.string().min(1);
const receiptDataSchema = z.strictObject({
  commandId: id, receiptId: id, serverSeq: z.number().int().positive(),
  recoveryGeneration: id, result: resultSchema,
});
export type DesignResult = z.infer<typeof resultSchema>;

function stored<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid persisted design data.');
  return parsed.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).filter(key => object[key] !== undefined).sort()
      .map(key => JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export function readMaterial(tx: Transaction, courseId: string, resourceId: string) {
  const row = tx.get('SELECT * FROM resource_versions WHERE id=? AND course_id=?', resourceId, courseId);
  if (!row) throw new ApiError('FORBIDDEN');
  return materialFromRow(row);
}
function materialFromRow(row: SqlRow) {
  const version = stored(resourceSchema, {
    courseId: row.course_id, resourceVersionId: row.id, available: true,
    teacherDesignAllowed: row.teacher_design_allowed === 1,
    material: { format: row.format, kind: row.kind, title: row.title, text: row.body,
      byteLength: row.byte_length, contentHash: row.content_hash, visibility: JSON.parse(String(row.visibility_json)),
      paragraphs: JSON.parse(String(row.paragraphs_json)) },
  });
  const m = version.material;
  let expected;
  try { expected = prepareMaterial({ format: m.format, kind: m.kind, title: m.title, content: m.text, visibility: m.visibility }, 0); }
  catch { throw new Error('Invalid persisted material.'); }
  const paragraphs = m.paragraphs.map(({ paragraphId: _id, ...paragraph }) => paragraph);
  if (m.byteLength !== expected.byteLength || m.contentHash !== expected.contentHash
    || canonical(paragraphs) !== canonical(expected.paragraphs)
    || new Set(m.paragraphs.map(p => p.paragraphId)).size !== m.paragraphs.length) throw new Error('Invalid persisted material.');
  return version;
}
export function saveMaterial(tx: Transaction, actor: { userId: string; courseId: string }, input: unknown, teacherDesignAllowed: boolean, now: number): DesignResult {
  const total = tx.get('SELECT COALESCE(SUM(byte_length),0) AS bytes FROM resource_versions WHERE course_id=?', actor.courseId);
  const material = prepareMaterial(input, Number(total!.bytes));
  const resourceVersionId = randomUUID();
  const paragraphs = material.paragraphs.map(p => ({ ...p, paragraphId: randomUUID() }));
  tx.run(`INSERT INTO resource_versions(id,course_id,created_by,created_at_ms,format,kind,title,body,byte_length,content_hash,visibility_json,teacher_design_allowed,paragraphs_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, resourceVersionId, actor.courseId, actor.userId, now,
    material.format, material.kind, material.title, material.text, material.byteLength, material.contentHash,
    JSON.stringify(material.visibility), teacherDesignAllowed ? 1 : 0, JSON.stringify(paragraphs));
  return { kind: 'material', resourceVersion: { courseId: actor.courseId, resourceVersionId, available: true,
    teacherDesignAllowed, material: { ...material, paragraphs } } };
}
export function commitCommand(tx: Transaction, actor: { userId: string; courseId: string },
  command: string, target: string, key: string, input: unknown, generation: string, now: number, work: () => DesignResult) {
  const requestHash = createHash('sha256').update(canonical({ command, target, input }), 'utf8').digest('hex');
  const old = tx.get('SELECT * FROM command_receipts WHERE actor_id=? AND command=? AND target=? AND idempotency_key=?',
    actor.userId, command, target, key);
  if (old) {
    if (old.course_id !== actor.courseId) throw new Error('Invalid persisted receipt scope.');
    if (old.recovery_generation !== generation) throw new ApiError('RECOVERY_REQUIRED');
    if (old.request_hash !== requestHash) throw new ApiError('IDEMPOTENCY_CONFLICT');
    const data = stored(receiptDataSchema, JSON.parse(String(old.result_json)));
    if (data.receiptId !== old.receipt_id || data.commandId !== old.command_id
      || data.serverSeq !== old.server_seq || data.recoveryGeneration !== generation) throw new Error('Invalid persisted receipt.');
    validateReceiptScope(data.result, actor.courseId, command, target);
    return data;
  }
  const result = work();
  const commandId = randomUUID();
  const receiptId = randomUUID();
  const objectRef = result.kind === 'material' ? { kind: result.kind, id: result.resourceVersion.resourceVersionId }
    : result.kind === 'draft' ? { kind: result.kind, id: result.draft.blueprintId, revision: result.draft.revision }
    : { kind: result.kind, id: result.report.blueprintId, revision: result.report.revision };
  tx.run(`INSERT INTO audit_events(event_id,actor_id,course_id,command_id,command,target,object_ref_json,recovery_generation,committed_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?)`, randomUUID(), actor.userId, actor.courseId, commandId, command, target,
    JSON.stringify(objectRef), generation, now);
  const serverSeq = Number(tx.get('SELECT last_insert_rowid() AS seq')!.seq);
  const data = stored(receiptDataSchema, { commandId, receiptId, serverSeq, recoveryGeneration: generation, result });
  tx.run(`INSERT INTO command_receipts(receipt_id,command_id,actor_id,course_id,command,target,idempotency_key,request_hash,recovery_generation,server_seq,result_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, receiptId, commandId, actor.userId, actor.courseId, command, target,
    key, requestHash, generation, serverSeq, JSON.stringify(data));
  return data;
}

export function draftCourse(tx: Transaction, blueprintId: string): string {
  const row = tx.get('SELECT course_id FROM blueprint_drafts WHERE id=?', blueprintId);
  if (!row || typeof row.course_id !== 'string') throw new ApiError('FORBIDDEN');
  return row.course_id;
}
export function readDraft(tx: Transaction, courseId: string, blueprintId: string) {
  const row = tx.get('SELECT id,course_id,revision,draft_json FROM blueprint_drafts WHERE id=? AND course_id=?', blueprintId, courseId);
  if (!row) throw new ApiError('FORBIDDEN');
  const draft = stored(draftSchema, JSON.parse(String(row.draft_json)));
  if (draft.blueprintId !== row.id || draft.courseId !== row.course_id || draft.revision !== row.revision) throw new Error('Invalid persisted draft.');
  return draft;
}
export function createStoredDraft(tx: Transaction, actor: { userId: string; courseId: string },
  input: { mode: 'manual'; content: unknown } | { mode: 'copy'; sourceBlueprintId: string; expectedSourceRevision: number }, now: number): DesignResult {
  const identity = { courseId: actor.courseId, blueprintId: randomUUID() };
  let draft;
  if (input.mode === 'manual') draft = createDraft(identity, input.content);
  else {
    const source = readDraft(tx, actor.courseId, input.sourceBlueprintId);
    if (source.revision !== input.expectedSourceRevision) throw new ApiError('VERSION_CONFLICT');
    draft = copyDraft(source, identity);
  }
  validateMaterialReferences(tx, draft);
  registerCompetencies(tx, draft);
  tx.run('INSERT INTO blueprint_drafts(id,course_id,created_by,created_at_ms,revision,draft_json) VALUES (?,?,?,?,?,?)',
    draft.blueprintId, actor.courseId, actor.userId, now, draft.revision, JSON.stringify(draft));
  return { kind: 'draft', draft };
}
export function patchStoredDraft(tx: Transaction, courseId: string, blueprintId: string, expectedRevision: number, patch: unknown): DesignResult {
  const current = readDraft(tx, courseId, blueprintId);
  const draft = editDraft(current, expectedRevision, patch);
  validateMaterialReferences(tx, draft);
  registerCompetencies(tx, draft);
  const changed = tx.run('UPDATE blueprint_drafts SET revision=?,draft_json=? WHERE id=? AND course_id=? AND revision=?',
    draft.revision, JSON.stringify(draft), blueprintId, courseId, expectedRevision);
  if (changed.changes !== 1) throw new ApiError('VERSION_CONFLICT');
  return { kind: 'draft', draft };
}

function registerCompetencies(tx: Transaction, draft: BlueprintDraft) {
  for (const goal of draft.content.goals) {
    const old = tx.get('SELECT domain,title FROM competency_versions WHERE course_id=? AND competency_id=? AND version=?',
      draft.courseId, goal.competencyId, goal.competencyVersion);
    if (old) {
      if (old.domain !== goal.domain || old.title !== goal.title) throw new ApiError('INVALID_REQUEST');
      continue;
    }
    const maximum = Number(tx.get('SELECT COALESCE(MAX(version),0) AS version FROM competency_versions WHERE course_id=? AND competency_id=?',
      draft.courseId, goal.competencyId)!.version);
    if (goal.competencyVersion <= maximum) throw new ApiError('INVALID_REQUEST');
    tx.run('INSERT INTO competency_versions(course_id,competency_id,version,domain,title) VALUES (?,?,?,?,?)',
      draft.courseId, goal.competencyId, goal.competencyVersion, goal.domain, goal.title);
  }
}

export function draftMaterials(tx: Transaction, draft: BlueprintDraft) {
  return draft.content.resources.flatMap(ref => {
    const row = tx.get('SELECT * FROM resource_versions WHERE id=? AND course_id=?', ref.resourceVersionId, draft.courseId);
    return row ? [materialFromRow(row)] : [];
  });
}
export function checkStoredDraft(tx: Transaction, courseId: string, blueprintId: string, expectedRevision: number, concerns: TeacherConcern[]): DesignResult {
  const draft = readDraft(tx, courseId, blueprintId);
  if (draft.revision !== expectedRevision) throw new ApiError('VERSION_CONFLICT');
  return { kind: 'checks', report: stored(reportSchema, checkDraft(draft, {
    materials: draftMaterials(tx, draft), helpPolicyVersionIds: [], checkRuleVersionIds: [], concerns,
  })) };
}

function validateMaterialReferences(tx: Transaction, draft: BlueprintDraft) {
  for (const ref of draft.content.resources) {
    // Missing and foreign IDs produce the same refusal without exposing their existence.
    if (!tx.get('SELECT id FROM resource_versions WHERE id=? AND course_id=?', ref.resourceVersionId, draft.courseId)) throw new ApiError('FORBIDDEN');
  }
}

export function validateReceiptScope(result: DesignResult, courseId: string, command: string, target: string) {
  const valid = result.kind === 'material'
    ? command === 'material.create' && target === courseId && result.resourceVersion.courseId === courseId
    : result.kind === 'draft'
      ? result.draft.courseId === courseId && (command === 'draft.create' ? target === courseId
        : command === 'draft.patch' && target === result.draft.blueprintId)
      : command === 'draft.checks' && target === result.report.blueprintId;
  if (!valid) throw new Error('Invalid persisted receipt scope.');
}
