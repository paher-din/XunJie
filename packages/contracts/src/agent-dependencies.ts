import { z } from 'zod';
import { spaceIdentitySchema, learningTargetSchema } from './spaces.js';
import { learningPageSchema, learningSearchSchema, learningReadSchema, learningReferenceSchema, learningProvenanceSchema } from './student-learning.js';
import { activitySchema, workFileSchema } from './learning-data.js';
import { agentDispatchPermitSchema, agentToolResultSchema, agentExecutionModeSchema } from './agent-runtime.js';
import { modelToolSchema, modelToolIntentSchema, modelToolResultSchema } from './model-connections.js';
import { pdfReadingSchema, pdfSearchResultSchema } from './pdf-materials.js';
import { personalMaterialReadResultSchema, personalMaterialVersionContentSchema, materialSearchResultSchema,
  scopedPersonalMaterialReferenceSourceSchema } from './personal-materials.js';
import { scopedPersonalMaterialSchema, scopedPersonalMaterialVersionContentSchema } from './personal-materials.js';
import { scopedPdfDocumentSchema, scopedPdfReadingSchema, scopedPdfSearchResultSchema, scopedPdfReferenceSourceSchema, PDF_LIMITS } from './pdf-materials.js';
import { materialScopeSchema } from './session-materials.js';
import { teachingArtifactSchema, teachingArtifactRevisionSchema, teachingArtifactReceiptSchema } from './teaching-artifacts.js';
import { executionQuerySchema, executionArtifactSchema, executionControlReceiptSchema, agentBrowserCommandSchema, executionStateSchema } from './execution.js';
import { agentSessionSchema, createAgentSessionSchema, updateAgentSessionSchema, markAgentSessionReadySchema } from './agent-sessions.js';
import { sameAgentSubject } from './agent-service.js';
import { executionRecordEventSchema, executionRecordPageSchema, executionRecordSchema } from './execution-records.js';

export const agentDependenciesCapability = 'agent.dependencies.v2' as const;
const base = z.object({ version: z.literal(2), identity: spaceIdentitySchema }).strict();
const session = base.extend({ sessionId: z.uuid(), permit: agentDispatchPermitSchema.optional() });
const empty = z.object({}).strict();
const json = z.json();
export const agentSourceDescriptionSchema = z.object({ learningTarget: learningTargetSchema,
  courseTarget: learningTargetSchema, identity: spaceIdentitySchema, conversationOwner: learningTargetSchema.optional() }).strict();
const ownerConversation = z.object({ objectId: z.string().min(1).max(300), version: z.string().min(1).max(200),
  title: z.string().max(300), text: z.string().max(2_000_000), owner: learningTargetSchema.optional(),
  provenance: learningProvenanceSchema.optional() }).strict();
export const agentSourceReadArgsSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('records.history'), activityId: z.uuid(), cursor: z.uuid().optional() }).strict(),
  z.object({ method: z.literal('records.read'), activityId: z.uuid(), requestId: z.uuid() }).strict(),
  z.object({ method: z.literal('conversations.list'), cursor: z.string().min(1).max(300).optional() }).strict(),
  z.object({ method: z.literal('conversations.read'), objectId: z.string().min(1).max(300), version: z.string().min(1).max(200) }).strict(),
]);
export const agentSourceReadResultSchemas = {
  'records.history': executionRecordPageSchema, 'records.read': executionRecordSchema.nullable(),
  'conversations.list': z.object({ entries: ownerConversation.array(), nextCursor: z.string().min(1).max(300).nullable() }).strict(),
  'conversations.read': ownerConversation,
};
const queryPage = z.object({ items: z.array(z.object({ reference: learningReferenceSchema, title: z.string(), excerpt: z.string(),
  provenance: learningProvenanceSchema.optional(), dueAt: z.string().nullable(), missing: z.array(z.string()) }).strict()), offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(), nextOffset: z.number().int().nonnegative().nullable(),
  unavailable: z.array(z.object({ sourceId: z.string(), kind: learningReferenceSchema.shape.kind, code: z.string() }).strict()) }).strict();
const queryDetail = z.object({ reference: learningReferenceSchema, provenance: learningProvenanceSchema.optional(), text: z.string(), range: z.object({
  offset: z.number().int().nonnegative(), length: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable() }).strict(), missing: z.array(z.string()), role: z.literal('source-data') }).strict();
export const agentDependencyModelMethodSchema = z.enum(['selection.read', 'selection.snapshot', 'selection.resolve',
  'selection.pin', 'selection.pinSource', 'selection.pinned', 'segments.create', 'segments.read', 'segments.settle', 'segments.close',
  'checks.receive', 'checks.read', 'checks.requestPayload', 'checks.progress', 'checks.summary', 'checks.dispatch', 'checks.cancel',
  'images.upload', 'images.read']);
export const agentDependencyMaterialResultSchemas = {
  'personal.list': scopedPersonalMaterialSchema.array(), 'personal.material': scopedPersonalMaterialSchema,
  'personal.original': scopedPersonalMaterialVersionContentSchema, 'personal.versionContent': scopedPersonalMaterialVersionContentSchema,
  'personal.readRange': personalMaterialReadResultSchema, 'pdf.list': scopedPdfDocumentSchema.array(), 'pdf.document': scopedPdfDocumentSchema,
  'pdf.original': z.object({ document: scopedPdfDocumentSchema, dataBase64: z.string().max(Math.ceil(4 * 1024 * 1024 / 3) * 4),
    offset: z.number().int().min(0).max(PDF_LIMITS.inputBytes), total: z.number().int().positive().max(PDF_LIMITS.inputBytes),
    nextOffset: z.number().int().positive().max(PDF_LIMITS.inputBytes).nullable() }).strict(),
  'pdf.reading': scopedPdfReadingSchema.nullable(), 'pdf.read': scopedPdfReadingSchema, 'pdf.find': scopedPdfSearchResultSchema,
  search: materialSearchResultSchema,
};
/** Fixed source lists only. Runtime callbacks, skill libraries and selection expansion are not wire inputs. */
export const agentDependencyMaterialSelectionSchema = z.object({
  personalReferences: z.array(z.object({ source: scopedPersonalMaterialReferenceSourceSchema }).strict()).max(64).default([]),
  pdfReferences: z.array(z.object({ source: scopedPdfReferenceSourceSchema }).strict()).max(16).default([]),
}).strict();
export const agentDependencyMaterialMethodSchema = z.enum(Object.keys(agentDependencyMaterialResultSchemas) as [keyof typeof agentDependencyMaterialResultSchemas, ...(keyof typeof agentDependencyMaterialResultSchemas)[]]);
const facts = z.record(z.string(), json);
/** A task fact the owner can authorize and read; no arbitrary text or target identity is trusted. */
export const agentTaskRecordSchema = z.object({
  taskId: z.string().min(1).max(200), activityId: z.uuid(), identity: spaceIdentitySchema,
  sessionId: z.uuid(), originTurnId: z.uuid(), state: executionStateSchema,
  statusKnowledge: z.enum(['confirmed', 'unknown']), confirmedSeq: z.number().int().nonnegative(),
  name: z.string().max(500), summary: z.string().max(2000), resultRef: z.string().max(1000).nullable(),
}).strict();
export const agentTaskMethodSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('read'), taskId: z.string().min(1).max(200) }).strict(),
  z.object({ method: z.literal('list'), turnId: z.uuid() }).strict(),
  z.object({ method: z.literal('cancel'), taskId: z.string().min(1).max(200) }).strict(),
]);
export const agentDependencyToolContextSchema = z.object({
  sessionId: z.uuid(), turnId: z.uuid(), stepId: z.uuid(), toolCallId: z.uuid(),
  context: z.object({ system: z.string(), facts, sources: z.array(facts) }).strict(), inputIds: z.array(z.uuid()),
  /** The verified kernel session snapshot: workspace actions/answers this Step actually saw. */
  sessionState: facts.optional() }).strict();
export const agentDependencyToolOfferSchema = z.object({ definition: modelToolSchema, supportsBackground: z.boolean(), scope: facts }).strict();
export const agentDependencyToolCallSchema = z.object({ toolCallId: z.uuid(), nativeCallId: z.string().min(1).max(200),
  callIndex: z.number().int().nonnegative(), name: z.string().min(1).max(200), input: facts, executionMode: agentExecutionModeSchema }).strict();
export const agentDependencyToolOutcomeSchema = agentToolResultSchema;
const moduleDescriptor = z.object({ id: z.string().min(1).max(200), version: z.number().int().positive() }).strict();
const moduleArgs = z.object({ module: moduleDescriptor, context: agentDependencyToolContextSchema }).strict();
const callArgs = moduleArgs.extend({ call: agentDependencyToolCallSchema });
export const agentWorkspaceDataMethodSchema = z.enum(['open', 'works.content', 'works.inspectVersion', 'drafts.verifyReferences',
  'pdf.read', 'pdf.reading', 'pdf.find', 'materials.original', 'materials.readRange',
  'artifacts.list', 'artifacts.read', 'artifacts.revision', 'artifacts.receipt', 'artifacts.publish',
  'executions.read', 'executions.artifact', 'executions.controlReceipt', 'executions.agent.dispatch', 'executions.agent.control',
  'executions.agent.original', 'executions.agent.read', 'executions.agent.status', 'executions.agent.cleanupStatus', 'executions.agent.cleanup']);
export const agentWorkspaceCourseMethodSchema = z.enum(['referenceText', 'verifyComponentReference', 'readComponent', 'readComponentAlgorithm', 'readMaterial']);
export const agentDependencyDataResultSchemas = {
  open: activitySchema, 'works.content': workFileSchema.omit({ name: true }),
  'works.inspectVersion': z.object({ retained: z.boolean(), currentRevision: z.number().int().nonnegative(), isCurrent: z.boolean(), everPublished: z.boolean() }).strict(),
  'drafts.verifyReferences': z.null(), 'pdf.read': pdfReadingSchema, 'pdf.reading': pdfReadingSchema.nullable(), 'pdf.find': pdfSearchResultSchema,
  'materials.original': personalMaterialVersionContentSchema, 'materials.readRange': personalMaterialReadResultSchema,
  'artifacts.list': z.array(teachingArtifactSchema), 'artifacts.read': teachingArtifactSchema,
  'artifacts.revision': teachingArtifactRevisionSchema, 'artifacts.receipt': teachingArtifactReceiptSchema.nullable(), 'artifacts.publish': teachingArtifactReceiptSchema,
  'executions.read': executionQuerySchema.nullable(), 'executions.artifact': executionArtifactSchema.nullable(),
  'executions.controlReceipt': executionControlReceiptSchema.nullable(), 'executions.agent.dispatch': executionQuerySchema.nullable(),
  'executions.agent.control': executionQuerySchema, 'executions.agent.read': executionQuerySchema.nullable(), 'executions.agent.cleanup': executionQuerySchema.nullable(),
  'executions.agent.original': agentBrowserCommandSchema.nullable(),
  'executions.agent.status': z.object({ cancelled: z.boolean(), claimed: z.boolean(), browserId: z.string().nullable() }).strict().nullable(),
  'executions.agent.cleanupStatus': z.object({ cancelled: z.boolean(), claimed: z.boolean(), browserId: z.string().nullable() }).strict().nullable(),
};
export const agentDependencyCallSchema = z.discriminatedUnion('operation', [
  base.extend({ operation: z.literal('execution.record'), args: z.object({ activityId: z.uuid(), event: executionRecordEventSchema }).strict() }),
  base.extend({ operation: z.literal('source.describe'), args: empty }),
  base.extend({ operation: z.literal('source.read'), args: agentSourceReadArgsSchema }),
  session.extend({ operation: z.literal('query.list'), args: learningPageSchema }),
  session.extend({ operation: z.literal('query.search'), args: learningSearchSchema }),
  session.extend({ operation: z.literal('query.read'), args: learningReadSchema }),
  session.extend({ operation: z.literal('model'), args: z.object({ method: agentDependencyModelMethodSchema, args: z.array(json).max(4) }).strict() }),
  session.extend({ operation: z.literal('materials.read'), args: z.object({ method: agentDependencyMaterialMethodSchema,
    scope: materialScopeSchema, args: z.array(json).max(3) }).strict() }),
  session.extend({ operation: z.literal('tools.describe'), args: empty }),
  session.extend({ operation: z.literal('tools.list'), args: moduleArgs }),
  session.extend({ operation: z.literal('tools.execute'), args: callArgs }),
  session.extend({ operation: z.literal('tools.validateAnswer'), args: moduleArgs.extend({ presentation: facts, answer: facts }) }),
  session.extend({ operation: z.literal('sessions.create'), args: createAgentSessionSchema }),
  session.extend({ operation: z.literal('sessions.read'), args: empty }),
  base.extend({ operation: z.literal('sessions.list'), args: empty }),
  session.extend({ operation: z.literal('sessions.update'), args: updateAgentSessionSchema }),
  session.extend({ operation: z.literal('sessions.markReady'), args: markAgentSessionReadySchema }),
  session.extend({ operation: z.literal('authorize'), args: empty }),
  session.extend({ operation: z.literal('tasks'), args: agentTaskMethodSchema }),
  session.extend({ operation: z.literal('workspace.activity'), args: empty }),
  session.extend({ operation: z.literal('workspace.data'), args: z.object({ method: agentWorkspaceDataMethodSchema, args: z.array(json).max(8) }).strict() }),
  session.extend({ operation: z.literal('workspace.course'), args: z.object({ method: agentWorkspaceCourseMethodSchema, args: z.array(json).max(4) }).strict() }),
]).superRefine((call, context) => {
  if (['sessions.create', 'sessions.update', 'sessions.markReady'].includes(call.operation)
    && 'sessionId' in call.args && call.args.sessionId !== (call as { sessionId: string }).sessionId)
    context.addIssue({ code: 'custom', path: ['args', 'sessionId'], message: 'Directory operation must retain its session identity.' });
  if ('permit' in call && call.permit && call.permit.sessionId !== call.sessionId)
    context.addIssue({ code: 'custom', path: ['permit', 'sessionId'], message: 'Permit belongs to another session.' });
  if ('context' in call.args && call.args.context.sessionId !== (call as { sessionId: string }).sessionId)
    context.addIssue({ code: 'custom', path: ['args', 'context'], message: 'Tool context must retain the session identity.' });
});
export type AgentDependencyCall = z.infer<typeof agentDependencyCallSchema>;
export const agentDependencyResultSchemas = {
  'execution.record': z.null(),
  'source.describe': agentSourceDescriptionSchema, 'query.list': queryPage, 'query.search': queryPage, 'query.read': queryDetail,
  'source.read': json,
  'sessions.create': agentSessionSchema, 'sessions.read': agentSessionSchema, 'sessions.list': z.array(agentSessionSchema),
  'sessions.update': agentSessionSchema, 'sessions.markReady': agentSessionSchema,
  authorize: z.object({ authorized: z.literal(true) }).strict(), tasks: json, 'workspace.activity': activitySchema,
  'workspace.data': json, 'workspace.course': json, model: json, 'materials.read': json,
  'tools.describe': moduleDescriptor.array(), 'tools.list': agentDependencyToolOfferSchema.array(),
  'tools.execute': agentDependencyToolOutcomeSchema, 'tools.validateAnswer': z.null(),
};
export type AgentDependencyResults = { [K in keyof typeof agentDependencyResultSchemas]: z.infer<(typeof agentDependencyResultSchemas)[K]> };
export function parseAgentDependencyResult<C extends AgentDependencyCall>(call: C, value: unknown): AgentDependencyResults[C['operation']] {
  const result = agentDependencyResultSchemas[call.operation].parse(value);
  if (call.operation === 'source.describe' && !sameAgentSubject(agentSourceDescriptionSchema.parse(result).identity, call.identity))
    throw new Error('Source identity changed.');
  if (call.operation === 'workspace.data') agentDependencyDataResultSchemas[call.args.method].parse(result);
  if (call.operation === 'tasks') {
    if (call.args.method === 'read') agentTaskRecordSchema.nullable().parse(result);
    else if (call.args.method === 'list') agentTaskRecordSchema.array().parse(result);
    else z.null().parse(result);
  }
  if (call.operation === 'source.read') agentSourceReadResultSchemas[call.args.method].parse(result);
  if (call.operation === 'materials.read') agentDependencyMaterialResultSchemas[call.args.method].parse(result);
  if (call.operation.startsWith('sessions.')) {
    const sessions = call.operation === 'sessions.list' ? agentSessionSchema.array().parse(result) : [agentSessionSchema.parse(result)];
    if (!sessions.every(session => sameAgentSubject(session.identity, call.identity)
      && (call.operation === 'sessions.list' || session.sessionId === (call as { sessionId: string }).sessionId)))
      throw new Error('Directory result does not retain the requested identity/session.');
  }
  return result as AgentDependencyResults[C['operation']];
}
export function isAgentDependencyRead(call: AgentDependencyCall): boolean {
  if (call.operation === 'materials.read') return !['pdf.read', 'pdf.find'].includes(call.args.method);
  if (call.operation.startsWith('tools.')) return ['tools.describe', 'tools.list', 'tools.validateAnswer'].includes(call.operation);
  if (call.operation === 'model') return ['selection.read', 'selection.snapshot', 'selection.resolve', 'selection.pinned',
    'segments.read', 'checks.read', 'checks.requestPayload', 'checks.progress', 'checks.summary', 'images.read'].includes(call.args.method);
  if (call.operation === 'workspace.data') return !['pdf.read', 'pdf.find', 'artifacts.publish', 'executions.agent.dispatch', 'executions.agent.control', 'executions.agent.cleanup'].includes(call.args.method);
  if (call.operation === 'workspace.course') return true;
  if (call.operation === 'tasks') return call.args.method !== 'cancel';
  return ['source.describe', 'source.read', 'query.list', 'query.search', 'query.read', 'materials.read', 'sessions.read', 'sessions.list', 'authorize', 'workspace.activity'].includes(call.operation);
}
export function requiresAgentDependencyDispatch(call: AgentDependencyCall): boolean {
  if (call.operation === 'materials.read') return ['pdf.read', 'pdf.find'].includes(call.args.method);
  if (call.operation === 'tools.execute') return true;
  if (call.operation === 'model') return ['checks.receive', 'checks.dispatch'].includes(call.args.method);
  return call.operation === 'workspace.data' && ['pdf.read', 'pdf.find', 'artifacts.publish', 'executions.agent.dispatch', 'executions.agent.control'].includes(call.args.method);
}
