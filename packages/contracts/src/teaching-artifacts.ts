import { z } from 'zod';
import { acceptsState, stateShapeSchema, componentBindingSchema } from './components.js';
import { aluCaseDraftSchema } from './alu-learning.js';
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,47}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const teachingArtifactOriginSchema = z.object({ runId: z.uuid(), stepId: z.uuid(), snapshotId: z.uuid(), commandId: z.uuid(), segmentId: z.uuid().optional(), attemptId: z.uuid().optional() }).strict();
export type TeachingArtifactOrigin = z.infer<typeof teachingArtifactOriginSchema>;
export const teachingArtifactPayloadSchema = z.object({
  formatVersion: z.literal(1), title: z.string().min(1).max(100), display: z.enum(['card', 'page']),
  html: z.string().min(1).max(500000), css: z.string().max(100000), javascript: z.string().max(250000), hostApiVersion: z.literal(1),
  stateVersion: z.number().int().positive(), stateShape: stateShapeSchema, initialState: z.unknown(),
  semanticFields: z.array(z.object({ key, meaning: z.string().min(1).max(500) }).strict()).max(32),
  semanticObjects: z.array(z.object({ id: key, meaning: z.string().min(1).max(500), summary: z.string().min(1).max(4000) }).strict()).max(64),
  requiredCapabilities: z.array(z.enum(['workspace.read', 'workspace.change', 'execution.submit', 'materials.read', 'observations.read', 'reference.select', 'student.respond'])).max(7),
}).strict().refine(p => acceptsState(p.stateShape, p.initialState), 'Initial state does not match state shape')
  .refine(p => p.stateShape.type === 'object' && Object.keys(p.stateShape.properties).length === p.semanticFields.length
    && p.semanticFields.every(f => p.stateShape.type === 'object' && Object.hasOwn(p.stateShape.properties, f.key))
    && new Set(p.semanticFields.map(f => f.key)).size === p.semanticFields.length, 'Every state field requires a stable semantic meaning')
  .refine(p => new Set(p.semanticObjects.map(f => f.id)).size === p.semanticObjects.length, 'Semantic object identities must be unique')
  .refine(p => new Set(p.requiredCapabilities).size === p.requiredCapabilities.length, 'Capabilities must be unique');
export type TeachingArtifactPayload = z.infer<typeof teachingArtifactPayloadSchema>;
export const teachingArtifactPublishSchema = z.object({ requestId: z.uuid(), payload: teachingArtifactPayloadSchema,
  artifactId: z.uuid().optional(), parentRevisionId: z.uuid().optional(),
  mapping: z.array(z.object({ from: key, to: key }).strict()).max(32).optional(),
}).strict().refine(i => !!i.artifactId === !!i.parentRevisionId, 'Revisions require artifact and parent identities');
export type TeachingArtifactPublish = z.infer<typeof teachingArtifactPublishSchema>;
export const teachingArtifactRevisionSchema = z.object({ artifactId: z.uuid(), activityId: z.uuid(), revisionId: z.uuid(), version: z.number().int().positive(),
  parentRevisionId: z.uuid().nullable(), payload: teachingArtifactPayloadSchema, resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().positive(),
  binding: componentBindingSchema, origin: teachingArtifactOriginSchema.nullable(), createdAt: z.string().datetime(),
  mapping: z.array(z.object({ from: key, to: key }).strict()).max(32),
}).strict();
export type TeachingArtifactRevision = z.infer<typeof teachingArtifactRevisionSchema>;
export const teachingArtifactCandidateSchema = z.object({ candidateId: z.uuid(), artifactId: z.uuid(), revisionId: z.uuid(),
  status: z.enum(['candidate', 'check-failed', 'adoptable', 'adopted']), checks: z.array(z.object({ code: z.string(), passed: z.boolean(), reason: z.string() }).strict()),
  createdAt: z.string().datetime() }).strict();
export type TeachingArtifactCandidate = z.infer<typeof teachingArtifactCandidateSchema>;
export const teachingArtifactSchema = z.object({ artifactId: z.uuid(), activityId: z.uuid(), title: z.string(), display: z.enum(['card', 'page']),
  activeRevisionId: z.uuid().nullable(), latestRevisionId: z.uuid(), latestCandidateId: z.uuid(), shelved: z.boolean(), relatedArtifactId: z.uuid().nullable(), createdAt: z.string().datetime(),
}).strict();
export type TeachingArtifact = z.infer<typeof teachingArtifactSchema>;
export const teachingArtifactAdoptSchema = z.object({ requestId: z.uuid(), candidateId: z.uuid(), expectedRevisionId: z.uuid().nullable(),
  expectedWorkRevision: z.number().int().nonnegative(), expectedContentId: z.uuid().nullable(),
}).strict();
export type TeachingArtifactAdopt = z.infer<typeof teachingArtifactAdoptSchema>;
export const teachingArtifactShelfSchema = z.object({ requestId: z.uuid(), artifactId: z.uuid(), shelved: z.boolean() }).strict();
export const teachingArtifactReceiptSchema = z.object({ requestId: z.uuid(), artifactId: z.uuid(), revisionId: z.uuid(), candidateId: z.uuid().nullable(),
  kind: z.enum(['publish', 'adopt', 'shelf']), outcome: z.enum(['candidate', 'adopted', 'forked', 'shelved']),
  workRevision: z.number().int().nonnegative().nullable(), contentId: z.uuid().nullable(), relatedArtifactId: z.uuid().nullable(), reason: z.string().nullable(),
}).strict();
export type TeachingArtifactReceipt = z.infer<typeof teachingArtifactReceiptSchema>;
/** Browser checks operate on isolated sample state, never the student's current workspace. */
export const teachingArtifactCheckSchema = z.object({ requestId: z.uuid(), candidateId: z.uuid(), revisionId: z.uuid(), resourceSha256: digest,
  load: z.boolean(), stateRoundtrip: z.boolean() }).strict();
export const teachingArtifactResourceSchema = z.object({ resourceId: z.uuid(), sha256: digest, byteLength: z.number().int().positive().max(1000000),
  mediaType: z.literal('text/html'), contentBase64: z.string().max(1400000) }).strict();

/** A generated view names an original successful run; the host re-derives its work and provenance. */
export const teachingArtifactExecutionInputSchema = z.object({ requestId: z.uuid(), componentKey: z.string().max(48),
  operationId: z.string().max(64), parameters: z.unknown(), enabledByRequestId: z.uuid().optional(),
  caseDraft: aluCaseDraftSchema.optional() }).strict();
export type TeachingArtifactExecutionInput = z.infer<typeof teachingArtifactExecutionInputSchema>;

/** Public host API documentation shared by model tools and the browser adapter; no SDK runtime. */
export const teachingArtifactSdkApi = `window.xunjie v1:
await read() -> {contentId, content}; restore content before accepting input.
await change(content) -> receipt; submit the entire declared state on input. The SDK serializes changes and fixes expectedContentId, operationId, contentId.
await capabilities() -> {capabilities: string[], readOnly: boolean, execution?: unknown}.
await reference.select({text}) or reference.select({objectId}) -> {selected:true}; selected text must exist in the fixed page; objectId must be declared in semanticObjects.
await respond({requestId, text, questionId?, optionId?}) -> the original response/action receipt. Explicit student click only; keep the same requestId when querying/retrying.
await materials.read({materialId, version?}) -> an authorized fixed course material, or an activity personal note at the explicitly supplied positive version. Never substitute a latest personal version.
await observations.read({requestId}) -> original execution observation.
await execution.submit({requestId, componentKey, operationId, parameters, enabledByRequestId?, caseDraft?}) -> {requestId}; explicit student click only.
ALU run-single freezes the current code. ALU observe-enabled requires enabledByRequestId of a successful run-single plus caseDraft {formatVersion:1,caseId:uuid,revisionId:uuid,purpose:'unspecified'|'boundary'|'operation'|'custom',predictedF:string,predictedCout:string,reason:string,helpReported:boolean,priorSources:[]}. Capture actual student text before requesting results; never fill predictions for the student. The host fixes original code and prior sources and records generated-page assistance. ALU check-all uses parameters:{} and the original successful enabledByRequestId, without caseDraft.
await execution.query({requestId}) -> original execution record. Query unknown outcomes; never mint another request to retry.
No fetch, storage, custom postMessage, external dependencies or undeclared capabilities. Use an async IIFE; local controls call change, never respond automatically. CSS uses --canvas,--ink,--ink-soft,--muted,--line,--accent. All assets are fixed in the payload.`;
