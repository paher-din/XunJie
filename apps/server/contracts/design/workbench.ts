import { z } from 'zod';
import { contentSchema, draftSchema } from './draft.ts';
import { helpPolicySchema } from './inputs.ts';
import { activityViewSchema, resourceSchema } from './results.ts';

const id = z.string().min(1).max(128);
const natural = z.number().int().nonnegative();
/** Teacher-only discovery. All configurable versions originate in a confirmed activity of this course. */
export const teacherWorkbenchSchema = z.strictObject({
  courseId: id,
  courseName: z.string().optional(),
  recoveryGeneration: id,
  members: z.array(z.strictObject({ userId: id, displayName: z.string().optional() })),
  resources: z.array(resourceSchema),
  drafts: z.array(draftSchema),
  activities: z.array(activityViewSchema),
  assignments: z.array(z.strictObject({ assignmentId: id, studentId: id, activityVersionId: id,
    assignmentRevision: natural.min(1), active: z.boolean(), displayTitle: z.string().optional() })),
  attempts: z.array(z.strictObject({
    attemptId: id, courseId: id, studentId: id, assignmentId: id, activityVersionId: id,
    status: z.enum(['ready', 'active', 'paused', 'submitted', 'reviewed']),
    attemptRevision: natural.min(1), workspaceRevision: natural,
    latestSubmission: z.strictObject({ submissionId: id, snapshotId: id, submittedAt: z.iso.datetime() }).nullable(),
  })),
  presets: z.array(z.strictObject({ id, title: z.string().min(1), content: contentSchema, helpPolicy: helpPolicySchema })),
});
export type TeacherWorkbench = z.infer<typeof teacherWorkbenchSchema>;
