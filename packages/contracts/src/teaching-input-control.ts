import { z } from 'zod';
import { actionInputSchema } from './action-intents.js';
import { teachingInputModeSchema } from './teaching-inputs.js';
import { questionTextSchema } from './question-drafts.js';

export const teachingInputSchema = z.object({
  inputId: z.uuid(), requestId: z.uuid(), sequence: z.number().int().positive(), version: z.number().int().positive(),
  mode: teachingInputModeSchema, state: z.enum(['pending', 'adopted', 'removed', 'paused', 'superseded']),
  receivedRunId: z.uuid(), adoptedRunId: z.uuid().nullable(), adoptedStepId: z.uuid().nullable(),
  reason: z.string(), input: actionInputSchema,
  basis: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime(),
}).strict();
export type TeachingInput = z.infer<typeof teachingInputSchema>;

export const teachingInputControlSchema = z.object({ version: z.literal(1), requestId: z.uuid(),
  expectedVersion: z.number().int().positive(), operation: z.enum(['revise', 'remove', 'promote']), text: questionTextSchema.optional(),
}).strict().refine(input => input.operation === 'revise' ? input.text !== undefined : input.text === undefined,
  { message: 'Only an input revision carries replacement text.' });
export type TeachingInputControl = z.infer<typeof teachingInputControlSchema>;
export const teachingInputControlReceiptSchema = z.object({ version: z.literal(1), requestId: z.uuid(), inputId: z.uuid(),
  status: z.enum(['accepted', 'rejected']), reason: z.string(), input: teachingInputSchema.nullable(),
  replacementInputId: z.uuid().nullable(),
}).strict();
export type TeachingInputControlReceipt = z.infer<typeof teachingInputControlReceiptSchema>;

export const teachingContinueSelectionSchema = z.object({ version: z.literal(2), requestId: z.uuid(),
  inputs: z.array(z.object({ inputId: z.uuid(), expectedVersion: z.number().int().positive() }).strict()).max(64),
}).strict().refine(input => new Set(input.inputs.map(item => item.inputId)).size === input.inputs.length,
  { message: 'A continuation cannot select an input twice.' });
export const teachingRunControlReceiptSchema = z.object({ version: z.literal(1), requestId: z.uuid(),
  operation: z.enum(['stop', 'continue']), status: z.enum(['accepted', 'rejected']), reason: z.string(),
  runId: z.uuid(), continuedRunId: z.uuid().nullable(),
}).strict();
export type TeachingRunControlReceipt = z.infer<typeof teachingRunControlReceiptSchema>;
export const teachingControlReceiptSchema = z.union([teachingInputControlReceiptSchema, teachingRunControlReceiptSchema]);
export type TeachingControlReceipt = z.infer<typeof teachingControlReceiptSchema>;
