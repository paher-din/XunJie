import { z } from 'zod';

export const versionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1);
export const goalRefSchema = z.strictObject({ competencyId: id, competencyVersion: versionSchema });
const goalSchema = z.strictObject({
  competencyId: id, competencyVersion: versionSchema, domain: z.enum(['domain', 'project', 'ai_collaboration']),
  title: z.string(), core: z.boolean().default(true),
});
const contentShape = {
  projectTitle: z.string(), problem: z.string(), audience: z.string(), artifact: z.string(),
  studentBackground: z.string(), timeConstraints: z.string(), routes: z.array(z.string()),
  goals: z.array(goalSchema),
  tasks: z.array(z.strictObject({ taskId: id, title: z.string(), goalRefs: z.array(goalRefSchema) })),
  observations: z.array(z.strictObject({ observationId: id, description: z.string(), goalRefs: z.array(goalRefSchema), taskIds: z.array(id) })),
  rubricCriteria: z.array(z.strictObject({ criterionId: id, description: z.string(), goalRefs: z.array(goalRefSchema), observationIds: z.array(id) })),
  milestones: z.array(z.strictObject({ milestoneId: id, title: z.string(), taskIds: z.array(id) })),
  resources: z.array(z.strictObject({ resourceVersionId: id })),
  helpPolicyVersionId: id, checkRuleVersionId: id, runtimeProfileVersionId: id,
};
export const contentPatchSchema = z.strictObject(contentShape).partial();
export const contentSchema = z.strictObject({
  ...contentPatchSchema.shape,
  routes: contentShape.routes, goals: contentShape.goals, tasks: contentShape.tasks,
  observations: contentShape.observations, rubricCriteria: contentShape.rubricCriteria,
  milestones: contentShape.milestones, resources: contentShape.resources,
});
export const identitySchema = z.strictObject({ courseId: id, blueprintId: id });
const sourceSchema = z.strictObject({ ...identitySchema.shape, revision: versionSchema });
export const draftSchema = z.strictObject({ ...identitySchema.shape, revision: versionSchema, content: contentSchema, source: sourceSchema.optional() });
export type GoalRef = z.infer<typeof goalRefSchema>;
export type BlueprintContent = z.infer<typeof contentSchema>;
export type BlueprintDraft = z.infer<typeof draftSchema>;
