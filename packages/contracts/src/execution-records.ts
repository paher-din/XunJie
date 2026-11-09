import { z } from 'zod';
import { storageOwnerSchema } from './storage.js';
import { actionReceiverSchema, actionScopeSchema } from './action-intents.js';
import { executionAcceptanceSchema, executionArtifactSchema, executionQuerySchema, executionSessionViewSchema, executionObservationSchema } from './execution.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const executionRecordSessionIdentitySchema = executionSessionViewSchema.pick({ adapterId: true, adapterVersion: true,
  instanceId: true, instanceKey: true, nodeId: true, installGeneration: true, supervisorEpoch: true, executorInstanceId: true }).strip();
/** Original native command storage facts, not a browser broker's ActionReceipt. */
export const nativeExecutionReceptionSchema = z.object({ kind: z.literal('native'), requestId: z.uuid(), inputDigest: digest,
  executionRef: z.uuid(), scope: actionScopeSchema, receiver: actionReceiverSchema,
  receivedSeq: z.number().int().positive(), session: executionRecordSessionIdentitySchema }).strict();
export const executionRecordReceptionSchema = z.union([
  z.object({ kind: z.literal('browser'), acceptance: executionAcceptanceSchema }).strict(), nativeExecutionReceptionSchema,
]);
const common = { version: z.literal(1), sourceOwner: storageOwnerSchema, installationId: z.uuid(), requestId: z.uuid(),
  inputDigest: digest, executionRef: z.uuid() };
export const executionRecordResultSchema = executionArtifactSchema.extend({ contentId: z.uuid() }).strict();
export const executionRecordEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('command'), actionText: z.string().min(1).max(4000000),
    reception: executionRecordReceptionSchema, query: executionQuerySchema,
    createdAt: z.iso.datetime().transform(value => new Date(value).toISOString()) }).strict(),
  z.object({ ...common, kind: z.literal('status'), query: executionQuerySchema }).strict(),
  z.object({ ...common, kind: z.literal('result'), result: executionRecordResultSchema }).strict(),
]);
export type ExecutionRecordEvent = z.infer<typeof executionRecordEventSchema>;
export type ExecutionRecordReception = z.infer<typeof executionRecordReceptionSchema>;
export type ExecutionRecordResult = z.infer<typeof executionRecordResultSchema>;
export const executionRecordSchema = z.object({ version: z.literal(1), sourceOwner: storageOwnerSchema, installationId: z.uuid(),
  target: z.enum(['student-browser', 'student-runtime', 'school-runtime']), requestId: z.uuid(), inputDigest: digest, executionRef: z.uuid(),
  actionText: z.string().min(1).max(4000000), reception: executionRecordReceptionSchema, initialQuery: executionQuerySchema,
  query: executionQuerySchema, observations: z.array(executionObservationSchema), createdAt: z.iso.datetime(), result: executionRecordResultSchema.omit({ text: true, resources: true }).extend({
    resources: executionRecordResultSchema.shape.resources.unwrap().element.omit({ text: true }).array().max(4).optional(),
  }).nullable() }).strict();
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
export const executionRecordPageSchema = z.object({ entries: z.array(executionRecordSchema).max(32), nextCursor: z.uuid().nullable() }).strict();
export type ExecutionRecordPage = z.infer<typeof executionRecordPageSchema>;
