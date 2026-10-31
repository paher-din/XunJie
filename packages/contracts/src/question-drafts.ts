import { z } from 'zod';
import { courseDigestSchema } from './courses.js';

/** UTF-16 half-open offsets in the selected source's original text. */
const textRangeSchema = z.object({ kind: z.literal('text'),
  start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()
  .refine(range => range.end > range.start, { message: 'range must be half-open and non-empty' });
const codeRangeSchema = z.object({ kind: z.literal('code'),
  start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()
  .refine(range => range.end > range.start, { message: 'range must be half-open and non-empty' });
/** Component-specific ranges are a future version; unknown kinds are rejected, not treated as opaque JSON. */
export const questionReferenceRangeSchema = z.discriminatedUnion('kind', [textRangeSchema, codeRangeSchema]);
export type QuestionReferenceRange = z.infer<typeof questionReferenceRangeSchema>;

const workSourceSchema = z.object({ kind: z.literal('work'), objectId: z.uuid(), contentId: z.uuid() }).strict();
const courseMaterialSourceSchema = z.object({ kind: z.literal('course-material'), courseId: z.uuid(),
  taskId: z.uuid(), releaseId: z.uuid(), contentDigest: courseDigestSchema, materialId: z.uuid(),
  materialSha256: courseDigestSchema, mediaType: z.string().min(1).max(200) }).strict();
const courseFieldSourceSchema = z.object({ kind: z.literal('course-field'), courseId: z.uuid(),
  taskId: z.uuid(), releaseId: z.uuid(), contentDigest: courseDigestSchema,
  field: z.enum(['requirements']) }).strict();
/** Stable source object plus immutable content identity. Display names and paths are never identity. */
export const questionReferenceSourceSchema = z.discriminatedUnion('kind',
  [workSourceSchema, courseMaterialSourceSchema, courseFieldSourceSchema]);
export type QuestionReferenceSource = z.infer<typeof questionReferenceSourceSchema>;

export function questionReferenceSourceId(source: QuestionReferenceSource): string {
  switch (source.kind) {
    case 'work': return `work:${source.objectId}`;
    case 'course-material': return `course-material:${source.releaseId}:${source.materialId}`;
    case 'course-field': return `course-field:${source.releaseId}:${source.field}`;
  }
}
/** Deduplication covers isolation scope (store key), source object, content identity and typed range. */
export function questionReferenceKey(reference: Pick<QuestionReferenceInput, 'source' | 'range'>): string {
  return JSON.stringify([reference.source, reference.range.start, reference.range.end]);
}

const sourceNameSchema = z.string().min(1).max(300);
export const questionReferenceInputSchema = z.object({ referenceId: z.uuid(),
  source: questionReferenceSourceSchema, range: questionReferenceRangeSchema,
  copy: z.string().min(1).max(2000000), sourceName: sourceNameSchema }).strict();
export type QuestionReferenceInput = z.infer<typeof questionReferenceInputSchema>;
/** Received references carry the digest the owner checked against the fixed source content. */
export const questionReferenceSchema = questionReferenceInputSchema.extend({ copyDigest: courseDigestSchema }).strict();
export type QuestionReference = z.infer<typeof questionReferenceSchema>;

export const questionTextSchema = z.string().max(10000);
export const questionReferencesSchema = z.array(questionReferenceInputSchema).max(64)
  .refine(references => new Set(references.map(item => item.referenceId)).size === references.length
    && new Set(references.map(item => questionReferenceKey(item))).size === references.length
    && references.reduce((sum, item) => sum + item.copy.length, 0) <= 1000000);

/** Revision zero means no draft has been saved; it has no revision identity yet. */
export const questionDraftViewSchema = z.object({ draftId: z.uuid(),
  revision: z.number().int().nonnegative(), revisionId: z.uuid().nullable(),
  question: questionTextSchema, references: z.array(questionReferenceSchema).max(64) }).strict()
  .refine(view => view.revision === 0
    ? view.revisionId === null && view.question === '' && view.references.length === 0
    : view.revisionId !== null, { message: 'revision zero is the empty draft' });
export type QuestionDraftView = z.infer<typeof questionDraftViewSchema>;

/** A work text/code snapshot selected before its content identity was accepted by the server. */
export const questionWorkBasisSchema = z.object({ objectId: z.uuid(), contentId: z.uuid(),
  name: z.string().min(1).max(240), kind: z.enum(['text', 'code']), encoding: z.literal('utf8'),
  mediaType: z.string().min(1).max(200), value: z.string().max(2000000) }).strict();
export type QuestionWorkBasis = z.infer<typeof questionWorkBasisSchema>;

export const questionDraftSyncSchema = z.object({ requestId: z.uuid(), draftId: z.uuid(),
  baseRevision: z.number().int().nonnegative(), question: questionTextSchema,
  references: questionReferencesSchema, bases: z.array(questionWorkBasisSchema).max(64) }).strict();
export type QuestionDraftSync = z.infer<typeof questionDraftSyncSchema>;
