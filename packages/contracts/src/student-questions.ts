import { z } from 'zod';

export const teachingStudentAskInputSchema = z.object({
  question: z.string().trim().min(1).max(1000), source: z.string().trim().min(1).max(500),
  options: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    label: z.string().trim().min(1).max(200) }).strict()).max(8),
  allowText: z.boolean(), skippable: z.boolean(),
}).strict().superRefine((input, context) => {
  if (!input.allowText && !input.options.length) context.addIssue({ code: 'custom', message: 'A question needs an answer entry.' });
  if (new Set(input.options.map(option => option.id)).size !== input.options.length)
    context.addIssue({ code: 'custom', message: 'Option identities must be unique.' });
});
export type TeachingStudentAskInput = z.infer<typeof teachingStudentAskInputSchema>;

export const teachingStudentAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), optionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(4000).refine(text => text.trim().length > 0) }).strict(),
  z.object({ kind: z.literal('skip') }).strict(),
]);
export type TeachingStudentAnswer = z.infer<typeof teachingStudentAnswerSchema>;
export const teachingStudentResponseInputSchema = z.object({
  requestId: z.uuid(), questionVersion: z.number().int().positive(), waitVersion: z.number().int().positive(),
  answer: teachingStudentAnswerSchema,
}).strict();
export type TeachingStudentResponseInput = z.infer<typeof teachingStudentResponseInputSchema>;
export const teachingStudentResponseReceiptSchema = z.object({
  requestId: z.uuid(), questionId: z.uuid(), questionVersion: z.number().int().positive(), waitVersion: z.number().int().positive(),
  runId: z.uuid().nullable(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['accepted', 'rejected']), reason: z.string().min(1).max(200), processedAt: z.iso.datetime(),
}).strict();
export type TeachingStudentResponseReceipt = z.infer<typeof teachingStudentResponseReceiptSchema>;

export const teachingStudentPresentationInputSchema = teachingStudentResponseInputSchema.omit({ answer: true });
export const teachingStudentPresentationReceiptSchema = z.object({
  requestId: z.uuid(), questionId: z.uuid(), questionVersion: z.number().int().positive(), waitVersion: z.number().int().positive(),
  status: z.enum(['presented', 'ignored']), reason: z.string().max(200), presentedAt: z.iso.datetime().nullable(),
}).strict();

export const teachingStudentQuestionSchema = z.object({
  questionId: z.uuid(), version: z.literal(1), capability: z.literal('student.ask'),
  runId: z.uuid(), stepId: z.uuid(), commandId: z.uuid(), sourceInputId: z.uuid(), waitId: z.uuid(), waitVersion: z.literal(1),
  question: teachingStudentAskInputSchema.shape.question, options: teachingStudentAskInputSchema.shape.options,
  allowText: z.boolean(), skippable: z.boolean(),
  source: z.object({ label: z.string().min(1).max(500), detail: teachingStudentAskInputSchema.shape.source }).strict(),
  state: z.enum(['pending', 'answered', 'skipped', 'expired', 'cancelled']),
  response: z.object({ requestId: z.uuid(), answer: teachingStudentAnswerSchema, text: z.string().max(4000),
    processedAt: z.iso.datetime() }).strict().nullable(),
  presentedAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(), deadline: z.iso.datetime(),
}).strict();
export type TeachingStudentQuestion = z.infer<typeof teachingStudentQuestionSchema>;
