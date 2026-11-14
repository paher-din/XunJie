import { z } from 'zod';
export { agentDefinitionSchema, agentToolBindingSchema, resolvedAgentSchema, contextManifestSchema } from './agent-assembly.js';
export type { AgentDefinition, AgentToolBinding, ResolvedAgent, ContextManifest } from './agent-assembly.js';
import { modelToolResultSchema } from './model-connections.js';
import { runtimeServiceSchema } from './product-runtime.js';
import { spaceIdentitySchema } from './spaces.js';

export * from './student-questions.js';
export * from './teaching-inputs.js';
export * from './teaching-input-control.js';

export { teachingHelpPolicySchema } from './course-help.js';

export const teachingToolRecordSchema = z.object({
  commandId: z.uuid(), runId: z.uuid(), stepId: z.uuid(), snapshotId: z.uuid(),
  callId: z.string(), name: z.string(), version: z.literal(1),
  state: z.enum(['prepared', 'dispatching', 'waiting', 'settled']),
  effect: z.enum(['read', 'execute', 'input', 'stop', 'ask']),
  location: z.enum(['owner', 'browser', 'native', 'remote']),
  arguments: z.record(z.string(), z.unknown()), basis: z.record(z.string(), z.unknown()),
  outcome: z.enum(['not-dispatched', 'accepted', 'completed', 'failed', 'unknown']).nullable(),
  feedback: z.string(), result: z.record(z.string(), z.unknown()).nullable(),
  source: z.object({ label: z.string(), componentKey: z.string().optional(),
    requestId: z.uuid().optional(), contentId: z.uuid().optional() }).strict().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type TeachingToolRecord = z.infer<typeof teachingToolRecordSchema>;

export const teachingArtifactPreviewSchema = z.object({
  runId: z.uuid(), stepId: z.uuid(), attemptId: z.uuid(), commandId: z.uuid(), callId: z.string().min(1).max(200),
  name: z.string().min(1).max(64), html: z.string().max(500000), revision: z.number().int().positive(),
  seq: z.number().int().nonnegative(), createdAt: z.iso.datetime(),
}).strict();
export type TeachingArtifactPreview = z.infer<typeof teachingArtifactPreviewSchema>;

/** Maintainer-owned routing facts. Connection secrets never enter this descriptor. */
export const teachingAgentBindingSchema = z.object({
  version: z.literal(1), connectionId: z.uuid(),
  target: runtimeServiceSchema.refine(service => service.unit === 'teaching-agent'),
  installationId: z.uuid(),
  delivery: z.enum(['service', 'client']).optional(),
  grantId: z.uuid().optional(),
  /** Independently approved execution service -> data owner grant; never the Agent grant. */
  executionGrantId: z.uuid().optional(),
  /** Installer-confirmed device modules; never fetched by connecting back to the device. */
  deviceModules: z.array(runtimeServiceSchema).max(10).optional(),
}).strict();
export type TeachingAgentBinding = z.infer<typeof teachingAgentBindingSchema>;
export const teachingAgentBindingInputSchema = teachingAgentBindingSchema.omit({ version: true }).extend({
  requestId: z.uuid(), identity: spaceIdentitySchema,
}).strict();
export const teachingPreparedToolSchema = z.object({ version: z.literal(1), commandId: z.uuid(), name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()), effect: z.enum(['read', 'execute', 'input', 'stop', 'ask']), conflictKey: z.string().min(1),
  location: z.enum(['owner', 'browser', 'native', 'remote']), basis: z.record(z.string(), z.unknown()) }).strict();
export const teachingToolOutcomeSchema = z.object({ state: z.enum(['not-dispatched', 'accepted', 'completed', 'failed', 'unknown']),
  feedback: modelToolResultSchema.omit({ callId: true }), result: z.record(z.string(), z.unknown()),
  source: z.object({ label: z.string(), componentKey: z.string().optional(), requestId: z.uuid().optional(), contentId: z.uuid().optional() }).strict(),
  execution: z.object({ requestId: z.uuid(), executionRef: z.string(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict();
export const teachingDispatchAuthoritySchema = z.object({ runId: z.uuid(), activityId: z.uuid(),
  driverId: z.string().min(1).max(1000), generation: z.number().int().positive() }).strict();
export const teachingDependencyCallSchema = z.object({ version: z.literal(1),
  operation: z.enum(['authorize', 'identityFor', 'activity', 'model', 'data', 'course', 'intent.begin', 'intent.receipt', 'intent.cancel', 'execution.record', 'execution',
    'tool.definitions', 'tool.contributions', 'tool.prepare', 'tool.dispatch', 'tool.reconcile', 'tool.stop']),
  identity: spaceIdentitySchema.optional(),
  activityId: z.uuid().optional(),
  scope: z.object({ environmentId: z.uuid(), spaceId: z.uuid(), principalId: z.uuid() }).strict().optional(),
  authority: teachingDispatchAuthoritySchema.optional(), args: z.array(z.unknown()).max(4) }).strict()
  .refine(input => input.operation !== 'execution.record' || !!input.identity && !!input.activityId
    && input.scope === undefined && input.args.length === 2 && typeof input.args[1] === 'string'
    && /^[a-f0-9]{64}$/.test(input.args[1]) && (!input.authority || input.authority.activityId === input.activityId),
  'Execution record uploads require an actor, activity and fixed event digest');
