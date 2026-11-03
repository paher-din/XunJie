import { z } from 'zod';
const courseDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** UTF-16 half-open offsets in the selected source's original text. */
const textRangeSchema = z.object({ kind: z.literal('text'),
  start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()
  .refine(range => range.end > range.start, { message: 'range must be half-open and non-empty' });
const codeRangeSchema = z.object({ kind: z.literal('code'),
  start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()
  .refine(range => range.end > range.start, { message: 'range must be half-open and non-empty' });
/** Unknown adapters can be restored read-only; creating a reference still requires a registered validator. */
const semanticRangeSchema = z.object({ kind: z.literal('semantic'), formatVersion: z.literal(1),
  typeId: z.string().min(1).max(80), version: z.number().int().positive(),
  target: z.record(z.string().max(80), z.unknown()).transform(canonicalSemanticTarget).refine(value => JSON.stringify(value).length <= 16000),
  start: z.literal(0), end: z.number().int().positive().max(2000000) }).strict();
export const questionReferenceRangeSchema = z.discriminatedUnion('kind', [textRangeSchema, codeRangeSchema, semanticRangeSchema]);
export type QuestionReferenceRange = z.infer<typeof questionReferenceRangeSchema>;

const workSourceSchema = z.object({ kind: z.literal('work'), objectId: z.uuid(), contentId: z.uuid() }).strict();
const courseMaterialSourceSchema = z.object({ kind: z.literal('course-material'), courseId: z.uuid(),
  taskId: z.uuid(), releaseId: z.uuid(), contentDigest: courseDigestSchema, materialId: z.uuid(),
  materialSha256: courseDigestSchema, mediaType: z.string().min(1).max(200) }).strict();
const courseFieldSourceSchema = z.object({ kind: z.literal('course-field'), courseId: z.uuid(),
  taskId: z.uuid(), releaseId: z.uuid(), contentDigest: courseDigestSchema,
  field: z.enum(['requirements']) }).strict();
export const componentReferenceSourceSchema = z.object({ kind: z.literal('component'), formatVersion: z.literal(1),
  environmentId: z.uuid(), spaceId: z.uuid(), principalId: z.uuid(), activityId: z.uuid(), instanceId: z.string().min(1).max(300),
  componentId: z.uuid(), componentVersion: z.number().int().positive(), definitionDigest: courseDigestSchema,
  bindingKey: z.string().min(1).max(80), objectId: z.uuid(), contentId: z.uuid(),
  origin: z.enum(['state', 'execution-result']), requestId: z.uuid().nullable(), executionRef: z.uuid().nullable(),
}).strict().refine(value => value.origin === 'state' ? value.requestId === null && value.executionRef === null
  : value.requestId !== null && value.executionRef !== null);
/** Stable source object plus immutable content identity. Display names and paths are never identity. */
export const questionReferenceSourceSchema = z.discriminatedUnion('kind',
  [workSourceSchema, courseMaterialSourceSchema, courseFieldSourceSchema, componentReferenceSourceSchema]);
export type QuestionReferenceSource = z.infer<typeof questionReferenceSourceSchema>;

export function questionReferenceSourceId(source: QuestionReferenceSource): string {
  switch (source.kind) {
    case 'component': return `component:${source.activityId}:${source.instanceId}:${source.objectId}`;
    case 'work': return `work:${source.objectId}`;
    case 'course-material': return `course-material:${source.releaseId}:${source.materialId}`;
    case 'course-field': return `course-field:${source.releaseId}:${source.field}`;
  }
}
/** Deduplication covers isolation scope (store key), source object, content identity and typed range. */
export function questionReferenceKey(reference: Pick<QuestionReferenceInput, 'source' | 'range'>): string {
  return JSON.stringify([reference.source, reference.range.kind === 'semantic'
    ? semanticRangeIdentity(reference.range) : [reference.range.start, reference.range.end]]);
}

const sourceNameSchema = z.string().min(1).max(300);
export const questionReferenceInputSchema = z.object({ referenceId: z.uuid(),
  source: questionReferenceSourceSchema, range: questionReferenceRangeSchema,
  copy: z.string().min(1).max(2000000), sourceName: sourceNameSchema }).strict().refine(value => value.range.kind !== 'semantic' || value.range.end === value.copy.length, 'Semantic copy length must match its envelope');
export type QuestionReferenceInput = z.infer<typeof questionReferenceInputSchema>;
/** Received references carry the digest the owner checked against the fixed source content. */
export const questionReferenceSchema = questionReferenceInputSchema.safeExtend({ copyDigest: courseDigestSchema }).strict();
export type QuestionReference = z.infer<typeof questionReferenceSchema>;

/** The owner refuses longer question text; the composer truncates input at the same bound. */
export const QUESTION_TEXT_MAX_LENGTH = 10000;
export const questionTextSchema = z.string().max(QUESTION_TEXT_MAX_LENGTH);
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
  name: z.string().min(1).max(240), kind: z.enum(['text', 'code', 'state']), encoding: z.enum(['utf8', 'json']),
  mediaType: z.string().min(1).max(200), value: z.string().max(2000000) }).strict();
export type QuestionWorkBasis = z.infer<typeof questionWorkBasisSchema>;

export const questionDraftSyncSchema = z.object({ requestId: z.uuid(), draftId: z.uuid(),
  baseRevision: z.number().int().nonnegative(), question: questionTextSchema,
  references: questionReferencesSchema, bases: z.array(questionWorkBasisSchema).max(64) }).strict();
export type QuestionDraftSync = z.infer<typeof questionDraftSyncSchema>;

/** A finite registry, shared by source owners and view adapters; names/coordinates never establish identity. */
const annotationTarget = z.object({ objectIds: z.array(z.uuid()).min(1).max(64) }).strict();
const aggregationTarget = z.object({ groupKeys: z.array(z.string().max(4000)).min(1).max(200),
  fields: z.array(z.enum(['count', 'value', 'sum', 'mean', 'min', 'max'])).min(1).max(6) }).strict();
export const semanticAdapters = {
  'annotation-objects': { version: 1, origin: 'state', target: annotationTarget },
  'aggregation-groups': { version: 1, origin: 'execution-result', target: aggregationTarget },
} as const;
export function normalizeSemanticRange(range: z.infer<typeof semanticRangeSchema>) {
  const adapter = semanticAdapters[range.typeId as keyof typeof semanticAdapters];
  if (!adapter || range.version !== adapter.version) throw new Error('unsupported-version');
  const target = adapter.target.parse(range.target);
  return { typeId: range.typeId, version: range.version, target: Object.fromEntries(Object.entries(target)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, [...new Set(values)].sort()])) };
}
export function semanticReferenceCopy(range: z.infer<typeof semanticRangeSchema>, content: unknown): string {
  const { target } = normalizeSemanticRange(range);
  if (range.typeId === 'annotation-objects') {
    const parsed = z.object({ annotations: z.array(z.object({ id: z.uuid(), quote: z.string().max(4000), note: z.string().max(4000) }).strict()).max(100) }).strict().parse(content);
    const selected = (target.objectIds as string[]).map(id => {
      const item = parsed.annotations.find(item => item.id === id); if (!item) throw new Error('invalid-input'); return item;
    });
    return selected.map(item => `${item.quote}\n标注：${item.note}`).join('\n\n');
  }
  const groups = z.object({ groups: z.array(z.object({ key: z.string(), count: z.number(), value: z.number(), sum: z.number(),
    mean: z.number(), min: z.number(), max: z.number() })).max(200) }).passthrough().parse(content).groups;
  const labels: Record<string, string> = { count: '计数', value: '结果', sum: '求和', mean: '平均', min: '最小', max: '最大' };
  return (target.groupKeys as string[]).map(key => {
    const group = groups.find(group => group.key === key); if (!group) throw new Error('invalid-input');
    return `分组：${key}\n` + (target.fields as string[]).map(field => `${labels[field]}：${group[field as keyof typeof group]}`).join('\n');
  }).join('\n\n');
}

function semanticRangeIdentity(range: z.infer<typeof semanticRangeSchema>): unknown {
  try { return normalizeSemanticRange(range); }
  catch {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    return { typeId: range.typeId, version: range.version, target: canonical(range.target) };
  }
}

/** jsonb can reorder object keys; parsing a semantic envelope must preserve stable action digests. */
function canonicalSemanticTarget(value: Record<string, unknown>): Record<string, unknown> {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item && typeof item === 'object' ? canonicalSemanticTarget(item as Record<string, unknown>) : item;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
}
