import { z } from 'zod';
import { draftSchema, contentSchema } from './draft.ts';
import { helpPolicySchema } from './inputs.ts';
export const materialByteLimit = 256 * 1024;
const id = z.string().min(1);
const paragraphSchema = z.strictObject({
  paragraphId: id, ordinal: z.number().int().positive(), start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(), text: z.string(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const resourceSchema = z.strictObject({
  courseId: id, resourceVersionId: id, available: z.literal(true), teacherDesignAllowed: z.boolean(),
  material: z.strictObject({
    format: z.enum(['txt', 'markdown', 'paste']), kind: z.enum(['learning_material', 'private_answer', 'validation_asset']),
    title: id, text: z.string(), byteLength: z.number().int().min(0).max(materialByteLimit),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    visibility: z.strictObject({ student: z.boolean(), tutor: z.boolean() }), paragraphs: z.array(paragraphSchema),
  }),
});
export const teacherConcernSchema = z.strictObject({
  code: z.enum(['meaning', 'difficulty', 'time', 'solution_space', 'rubric_ambiguity']),
  path: z.string(), reason: z.string(), resolution: z.string().optional(),
});
export const reportSchema = z.strictObject({
  blueprintId: id, revision: z.number().int().positive(),
  blocking: z.array(z.strictObject({ code: id, path: z.string() })),
  designConcerns: z.array(teacherConcernSchema.extend({ status: z.enum(['teacher_recorded', 'requires_teacher']) })),
  unverified: z.array(z.strictObject({ code: z.enum(['learning_effect', 'workload_estimate']), path: z.string(), status: z.literal('unknown') })),
});

export const resultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('material'), resourceVersion: resourceSchema }),
  z.strictObject({ kind: z.literal('draft'), draft: draftSchema }),
  z.strictObject({ kind: z.literal('checks'), report: reportSchema }),
]);
const resultId = z.string().min(1).max(128), revision = z.number().int().positive();
const stopped = { stoppedJobIds: z.array(resultId), attemptIds: z.array(resultId) };
export const activityCommandResults = {
  'activity.release': z.strictObject({ activityVersionId: resultId, sourceRevision: revision, activityControlRevision: revision,
    unverified: reportSchema.shape.unverified, checks: reportSchema }),
  'assignment.create': z.strictObject({ assignments: z.array(z.strictObject({ assignmentId: resultId, studentId: resultId, activityVersionId: resultId, assignmentRevision: revision, status: z.enum(['active','paused']) })) }),
  'activity.control': z.strictObject({ activityVersionId: resultId, activityControlRevision: revision, status: z.enum(['active','paused']), ...stopped }),
  'assignment.control': z.strictObject({ assignmentId: resultId, assignmentRevision: revision, status: z.enum(['active','paused']), ...stopped }),
};

export const projectedMaterialSchema = z.strictObject({ status: z.literal('available'), resourceVersionId: id, title: id,
  text: z.string(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), paragraphs: z.array(paragraphSchema.extend({ paragraphId: id.optional() })) });
const projectedContent = contentSchema.pick({ projectTitle: true, problem: true, audience: true, artifact: true, studentBackground: true,
  timeConstraints: true, routes: true, goals: true, tasks: true, observations: true, rubricCriteria: true, milestones: true, helpPolicyVersionId: true });
const previewContent = { audience: z.enum(['student','tutor','teacher-validator']), content: projectedContent,
  materials: z.array(z.union([projectedMaterialSchema,z.strictObject({ status: z.literal('redacted') }),z.strictObject({ status: z.literal('unavailable') })])) };
export const previewSchema = z.strictObject({ blueprintId: id, revision, ...previewContent });
export const activityViewSchema = z.strictObject({ activityVersionId: id, courseId: id, sourceRevision: revision.optional(),
  activityControlRevision: revision, status: z.enum(['active','paused']), content: z.strictObject(previewContent),
  helpPolicy: helpPolicySchema, runtimeProfileVersionId: id });
export const assignmentViewSchema = z.strictObject({ assignmentId: id, activityVersionId: id, studentId: id, assignmentRevision: revision,
  active: z.boolean(), status: z.enum(['active','paused']), reasons: z.strictObject({ individual: z.string(), activity: z.string() }), activityControlRevision: revision });
export type DesignResult = z.infer<typeof resultSchema>;
export type ActivityReleaseResult = z.infer<typeof activityCommandResults['activity.release']>;
export type AssignmentCreationResult = z.infer<typeof activityCommandResults['assignment.create']>;
export type ActivityControlResult = z.infer<typeof activityCommandResults['activity.control']>;
export type AssignmentControlResult = z.infer<typeof activityCommandResults['assignment.control']>;
export type ActivityView = z.infer<typeof activityViewSchema>;
export type AssignmentView = z.infer<typeof assignmentViewSchema>;
export type BlueprintPreview = z.infer<typeof previewSchema>;