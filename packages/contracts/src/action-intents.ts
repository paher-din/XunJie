import { z } from 'zod';
import { workFilesSchema } from './learning-data.js';
import { questionTextSchema, questionReferencesSchema, questionWorkBasisSchema } from './question-drafts.js';
import { teachingInputDeliverySchema } from './teaching-inputs.js';

export const actionReceiverSchema = z.object({ receiverId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/),
  location: z.enum(['remote', 'local']), kind: z.enum(['question', 'submission', 'execution']) }).strict();
export const actionDraftSchema = z.object({ token: z.string().min(1).max(200), question: questionTextSchema,
  references: questionReferencesSchema, bases: z.array(questionWorkBasisSchema).max(64) }).strict();
/** References to existing evidence, never a fabricated observation or a mutable 'latest' alias. */
export const actionEvidenceSchema = z.object({ ownerServiceId: z.uuid(), recordId: z.uuid(),
  revision: z.number().int().positive(), kind: z.enum(['observation', 'submission', 'guidance']) }).strict();
export const actionScopeSchema = z.object({ environmentId: z.uuid(), spaceId: z.uuid(), principalId: z.uuid(), activityId: z.uuid() }).strict();
export const actionInputSchema = z.object({ requestId: z.uuid(), scope: actionScopeSchema, receiver: actionReceiverSchema,
  draft: actionDraftSchema, works: workFilesSchema, evidence: z.array(actionEvidenceSchema).max(64),
  delivery: teachingInputDeliverySchema.optional() }).strict()
  .refine(value => JSON.stringify(value).length <= 4000000, { message: 'fixed action input exceeds its supported recovery envelope' });
export type ActionInput = z.infer<typeof actionInputSchema>;
export type ActionReceiverIdentity = z.infer<typeof actionReceiverSchema>;

const dependencySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('work'), objectId: z.uuid(), contentId: z.uuid() }).strict(),
  z.object({ kind: z.literal('reference'), referenceId: z.uuid() }).strict(),
  z.object({ kind: z.literal('evidence'), ownerServiceId: z.uuid(), recordId: z.uuid(), revision: z.number().int().positive() }).strict(),
]);
export function actionDependencies(input: ActionInput): z.infer<typeof dependencySchema>[] {
  return [...input.works.map(file => ({ kind: 'work' as const, objectId: file.objectId, contentId: file.contentId })),
    ...input.draft.references.map(reference => ({ kind: 'reference' as const, referenceId: reference.referenceId })),
    ...input.evidence.map(ref => ({ kind: 'evidence' as const, ownerServiceId: ref.ownerServiceId, recordId: ref.recordId, revision: ref.revision }))];
}
export const actionReceiptSchema = z.object({ requestId: z.uuid(), receiver: actionReceiverSchema,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['accepted', 'cancelled', 'rejected']),
  receiptId: z.string().min(1).max(200), detail: z.string().max(1000) }).strict();
export type ActionReceipt = z.infer<typeof actionReceiptSchema>;
export const actionViewSchema = z.object({ input: actionInputSchema,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/), dependencies: z.array(dependencySchema).max(192),
  state: z.enum(['prepared', 'dispatched', 'accepted', 'cancelled', 'failed']),
  cancelRequested: z.boolean(), receipt: actionReceiptSchema.nullable() }).strict().refine(value => {
    const receipt = value.receipt;
    if (!receipt) return value.state === 'prepared' || value.state === 'dispatched' || value.state === 'cancelled' && value.cancelRequested;
    return receipt.requestId === value.input.requestId && receipt.inputDigest === value.inputDigest
      && JSON.stringify(receipt.receiver) === JSON.stringify(value.input.receiver)
      && value.state === (receipt.state === 'rejected' ? 'failed' : receipt.state);
  }, { message: 'business state must agree with the original receiver receipt' });
export type ActionView = z.infer<typeof actionViewSchema>;

/** Registered receiver contract: accept is idempotent; null query alone is not proof of non-acceptance.
 * A cancelled receipt is a durable tombstone preventing a later accept of this identity.
 * receiverId identifies one authority, never a retry-time URL or a user-selected replacement. */
export interface ActionReceiver {
  identity: ActionReceiverIdentity;
  accept(input: ActionInput, inputDigest: string): Promise<ActionReceipt>;
  query(requestId: string, inputDigest: string): Promise<ActionReceipt | null>;
  cancel(requestId: string, inputDigest: string): Promise<ActionReceipt | null>;
}
