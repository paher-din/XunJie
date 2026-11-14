import { StorageError } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import type { ConversationToolContext } from './tools.js';

/** Select by the original kernel step ID. Input sets describe authority, never step identity. */
export function requireConversationModelStep(context: ConversationToolContext, expectedStepId?: string) {
  const step = context.snapshot.steps.find(step => step.stepId === context.basisStepId);
  if (!context.basisStepId || expectedStepId !== undefined && expectedStepId !== context.basisStepId
    || !step || step.operation.kind !== 'model.call'
    || canonicalDigest(step.snapshot.context) !== canonicalDigest(context.context)
    || canonicalDigest(step.snapshot.authorityInputIds ?? step.snapshot.inputIds ?? []) !== canonicalDigest(context.inputIds))
    throw new StorageError('forbidden');
  return step;
}
