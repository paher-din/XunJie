import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ApiError } from '../app/errors.ts';
import type { Transaction } from '../db/transaction.ts';
import { canonical } from '../records/commands.ts';
import { readJobs } from '../db/records-adapter.ts';
import { contentSchema, type BlueprintContent } from '../../contracts/design/draft.ts';
import { referenceSelectionSchema, teacherBodySchema } from '../../contracts/design/proposals.ts';
import type { ModelUsage, TrustedModelContext } from '../../contracts/tutoring/index.ts';
import { readDraft, readMaterial } from './storage.ts';

const id = z.string().min(1);
export const modelVersionsSchema = z.strictObject({ modelConfig: id, prompt: id, schema: id, policy: id });
const usageSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unknown') }),
  z.strictObject({ status: z.literal('actual'), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }),
]);
const approvedReference = referenceSelectionSchema.extend({
  id, content: z.string(), visibility: z.strictObject({ student:z.boolean(), tutor:z.boolean() }),
});
export const teacherRequestSchema = z.strictObject({
  jobId:id, courseId:id, actorId:id, blueprintId:id.nullable(), baseRevision:z.number().int().nonnegative(),
  mode:z.enum(['candidates','blueprint','patch','rubric_trial']), request:z.string(),
  references:z.array(approvedReference), allowedFields:z.array(z.string()), sampleReferenceIds:z.array(id),
  baseline:contentSchema.nullable(), versions:modelVersionsSchema,
});
export type StoredTeacherRequest = z.infer<typeof teacherRequestSchema>;
export const proposalSchema = z.strictObject({
  proposalId:id, jobId:id, courseId:id, blueprintId:id.nullable(), baseRevision:z.number().int().nonnegative(),
  body:teacherBodySchema, resultHash:z.string().regex(/^[a-f0-9]{64}$/), rawResultRef:id,
  diff:z.array(z.strictObject({ path:id, before:z.json(), after:z.json() })),
  modelResult:z.strictObject({calls:z.number().int().min(1).max(3),elapsedMs:z.number().nonnegative(),usage:usageSchema,versions:modelVersionsSchema}),
  rationale:z.string(), affectedReferences:z.array(z.string()), createdAt:z.string(),
});
export type DesignProposal = z.infer<typeof proposalSchema>;
export const hashResultBytes = (bodyJson:string) => createHash('sha256').update(bodyJson,'utf8').digest('hex');
function persisted<S extends z.ZodType>(schema:S,value:unknown):z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('Invalid persisted teacher design data.');
  return result.data;
}
export function loadTeacherRequest(tx:Transaction,jobId:string) {
  const row = tx.get('SELECT * FROM teacher_design_requests WHERE job_id=?',jobId);
  if (!row) throw new ApiError('FORBIDDEN');
  const input = persisted(teacherRequestSchema,JSON.parse(String(row.request_json)));
  if (input.jobId !== row.job_id || input.courseId !== row.course_id || input.actorId !== row.actor_id
    || input.blueprintId !== row.blueprint_id || input.baseRevision !== row.base_revision) throw new Error('Invalid request scope.');
  const job = readJobs(tx,input.courseId).find(j => j.jobId === jobId);
  if (!job || job.purpose !== 'teacher_design' || job.scope.courseId !== input.courseId
    || job.scope.blueprintId !== input.blueprintId || job.scope.attemptId || job.scope.studentId
    || job.expectedRevision !== input.baseRevision || job.kind !== input.mode) throw new Error('Invalid teacher job association.');
  const receipt = tx.get('SELECT actor_id FROM command_receipts WHERE receipt_id=?',job.requestReceiptId);
  if (receipt?.actor_id !== input.actorId) throw new Error('Invalid teacher request actor.');
  const usages = persisted(z.array(usageSchema).max(3),JSON.parse(String(row.usage_json))) as ModelUsage[];
  if (usages.length !== job.attemptCount) throw new Error('Invalid persisted call budget.');
  return { input,job,usages };
}
export function saveTeacherRequest(tx:Transaction,input:StoredTeacherRequest) {
  const checked = persisted(teacherRequestSchema,input);
  tx.run('INSERT INTO teacher_design_requests(job_id,course_id,actor_id,blueprint_id,base_revision,request_json,usage_json) VALUES (?,?,?,?,?,?,?)',
    checked.jobId,checked.courseId,checked.actorId,checked.blueprintId,checked.baseRevision,JSON.stringify(checked),'[]');
}
export function saveUsages(tx:Transaction,jobId:string,usages:ModelUsage[]) {
  const checked = persisted(z.array(usageSchema).max(3),usages);
  if (tx.run('UPDATE teacher_design_requests SET usage_json=? WHERE job_id=?',JSON.stringify(checked),jobId).changes !== 1)
    throw new ApiError('PERSISTENCE_UNAVAILABLE');
}
export function selectReferences(tx:Transaction,courseId:string,selections:z.infer<typeof referenceSelectionSchema>[]) {
  const ids = new Set<string>();
  return selections.map(selection => {
    const material = readMaterial(tx,courseId,selection.resourceVersionId);
    const paragraph = material.material.paragraphs.find(p => p.paragraphId === selection.paragraphId);
    if (!material.teacherDesignAllowed || !paragraph || paragraph.contentHash !== selection.contentHash) throw new ApiError('INVALID_REFERENCE');
    const refId = selection.paragraphId;
    if (ids.has(refId)) throw new ApiError('INVALID_REQUEST');
    ids.add(refId);
    return { ...selection,id:refId,content:paragraph.text,visibility:material.material.visibility };
  });
}
export function teacherContextCurrent(tx:Transaction,input:StoredTeacherRequest,versions:TrustedModelContext['versions']) {
  const member = tx.get("SELECT user_id FROM course_memberships WHERE course_id=? AND user_id=? AND role='teacher' AND active=1",input.courseId,input.actorId);
  const user = tx.get('SELECT disabled_at_ms FROM users WHERE id=?',input.actorId);
  if (!member || !user || user.disabled_at_ms !== null) return false;
  if (canonical(input.versions) !== canonical(versions)) return false;
  if (input.blueprintId && readDraft(tx,input.courseId,input.blueprintId).revision !== input.baseRevision) return false;
  try {
    const refs = selectReferences(tx,input.courseId,input.references.map(({resourceVersionId,paragraphId,contentHash}) => ({resourceVersionId,paragraphId,contentHash})));
    return canonical(refs) === canonical(input.references);
  } catch (error) {
    if (error instanceof ApiError) return false;
    throw error;
  }
}
export function readProposal(tx:Transaction,proposalId:string) {
  const row = tx.get('SELECT * FROM teacher_design_proposals WHERE proposal_id=?',proposalId);
  if (!row) throw new ApiError('FORBIDDEN');
  const proposal = persisted(proposalSchema,JSON.parse(String(row.proposal_json)));
  const rawBody = persisted(teacherBodySchema,JSON.parse(String(row.raw_result_json)));
  if (canonical(rawBody) !== canonical(proposal.body)) throw new Error('Original body mismatch.');
  if (proposal.proposalId !== row.proposal_id || proposal.jobId !== row.job_id || proposal.courseId !== row.course_id
    || proposal.blueprintId !== row.blueprint_id || proposal.baseRevision !== row.base_revision
    || proposal.resultHash !== row.result_hash || proposal.resultHash !== hashResultBytes(String(row.raw_result_json))
    || Date.parse(proposal.createdAt) !== row.created_at_ms) throw new Error('Invalid persisted proposal scope.');
  const { input,job } = loadTeacherRequest(tx,proposal.jobId);
  if (input.courseId !== proposal.courseId || input.blueprintId !== proposal.blueprintId || input.baseRevision !== proposal.baseRevision
    || job.resultRef !== proposal.rawResultRef || job.resultHash !== proposal.resultHash) throw new Error('Invalid original proposal association.');
  return proposal;
}
export function proposalForJob(tx:Transaction,jobId:string) {
  const row = tx.get('SELECT proposal_id FROM teacher_design_proposals WHERE job_id=?',jobId);
  return row ? readProposal(tx,String(row.proposal_id)) : undefined;
}
export function saveProposal(tx:Transaction,proposal:DesignProposal,rawBodyJson:string) {
  const p = persisted(proposalSchema,proposal);
  const rawBody = persisted(teacherBodySchema,JSON.parse(rawBodyJson));
  if (p.resultHash !== hashResultBytes(rawBodyJson) || canonical(rawBody) !== canonical(p.body)) throw new ApiError('INVALID_REFERENCE');
  tx.run('INSERT INTO teacher_design_proposals(proposal_id,job_id,course_id,blueprint_id,base_revision,result_hash,proposal_json,raw_result_json,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)',
    p.proposalId,p.jobId,p.courseId,p.blueprintId,p.baseRevision,p.resultHash,JSON.stringify(p),rawBodyJson,Date.parse(p.createdAt));
}
export function simpleContent(body:{problem:string;audience:string;artifact:string;routes:string[]},resourceVersionIds:string[]):Partial<BlueprintContent> {
  return { problem:body.problem,audience:body.audience,artifact:body.artifact,routes:body.routes,
    resources:[...new Set(resourceVersionIds)].map(resourceVersionId => ({resourceVersionId})) };
}
