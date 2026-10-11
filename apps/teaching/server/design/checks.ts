import { draftSchema, type BlueprintDraft, type GoalRef } from './model.ts';
import type { DesignMaterialVersion } from './material.ts';
import { parseRequest } from '../app/validation.ts';

export interface TeacherConcern {
  code: 'meaning' | 'difficulty' | 'time' | 'solution_space' | 'rubric_ambiguity';
  path: string;
  reason: string;
  resolution?: string;
}
export interface CheckContext {
  materials: DesignMaterialVersion[];
  helpPolicyVersionIds: string[];
  checkRuleVersionIds: string[];
  runtimeProfile?: { versionId: string; ready: boolean };
  concerns: TeacherConcern[];
}
export interface BlockingItem { code: string; path: string }
const goalKey = (ref: GoalRef) => JSON.stringify([ref.competencyId, ref.competencyVersion]);

export function checkDraft(input: BlueprintDraft, context: CheckContext) {
  const draft = parseRequest(draftSchema, input);
  const content = draft.content;
  const blocking: BlockingItem[] = [];
  const block = (code: string, path: string) => { blocking.push({ code, path }); };
  for (const field of ['projectTitle', 'problem', 'audience', 'artifact'] as const) {
    if (!content[field]?.trim()) block('missing_field', field);
  }
  for (const field of ['routes', 'goals', 'tasks', 'observations', 'rubricCriteria', 'milestones'] as const) {
    if (!content[field].length) block('missing_field', field);
  }
  content.routes.forEach((route, index) => { if (!route.trim()) block('missing_field', 'routes.' + index); });
  const unique = (ids: string[], path: string) => {
    if (new Set(ids).size !== ids.length) block('duplicate_reference', path);
  };
  const goals = new Set(content.goals.map(goalKey));
  unique(content.goals.map(g => g.competencyId), 'goals');
  for (const domain of ['domain', 'project', 'ai_collaboration'] as const) {
    if (!content.goals.some(g => g.domain === domain)) block('missing_domain', 'goals.' + domain);
  }
  for (const goal of content.goals) {
    if (!goal.title.trim()) block('missing_field', 'goals.' + goal.competencyId);
    if (goal.core && !content.observations.some(o => o.description.trim() && o.goalRefs.some(ref => goalKey(ref) === goalKey(goal)))) {
      block('missing_goal_observation', 'goals.' + goal.competencyId);
    }
  }
  const validateGoals = (refs: GoalRef[], path: string) => {
    if (!refs.length) block('missing_link', path);
    unique(refs.map(goalKey), path);
    for (const ref of refs) if (!goals.has(goalKey(ref))) block('invalid_reference', path);
  };
  const taskIds = new Set(content.tasks.map(t => t.taskId));
  const observationIds = new Set(content.observations.map(o => o.observationId));
  unique(content.tasks.map(t => t.taskId), 'tasks');
  unique(content.observations.map(o => o.observationId), 'observations');
  unique(content.rubricCriteria.map(r => r.criterionId), 'rubricCriteria');
  unique(content.milestones.map(m => m.milestoneId), 'milestones');
  const validateIds = (ids: string[], known: Set<string>, path: string) => {
    if (!ids.length) block('missing_link', path);
    unique(ids, path);
    for (const id of ids) if (!known.has(id)) block('invalid_reference', path);
  };
  content.tasks.forEach((task, index) => {
    if (!task.title.trim()) block('missing_field', 'tasks.' + index + '.title');
    validateGoals(task.goalRefs, 'tasks.' + index + '.goalRefs');
  });
  content.observations.forEach((observation, index) => {
    if (!observation.description.trim()) block('missing_field', 'observations.' + index + '.description');
    validateGoals(observation.goalRefs, 'observations.' + index + '.goalRefs');
    validateIds(observation.taskIds, taskIds, 'observations.' + index + '.taskIds');
    for (const ref of observation.goalRefs) {
      if (!content.tasks.some(task => observation.taskIds.includes(task.taskId) && task.goalRefs.some(g => goalKey(g) === goalKey(ref)))) block('inconsistent_goal_link', 'observations.' + index + '.goalRefs');
    }
  });
  content.rubricCriteria.forEach((criterion, index) => {
    if (!criterion.description.trim()) block('missing_field', 'rubricCriteria.' + index + '.description');
    validateGoals(criterion.goalRefs, 'rubricCriteria.' + index + '.goalRefs');
    validateIds(criterion.observationIds, observationIds, 'rubricCriteria.' + index + '.observationIds');
    for (const ref of criterion.goalRefs) {
      if (!content.observations.some(observation => criterion.observationIds.includes(observation.observationId) && observation.goalRefs.some(g => goalKey(g) === goalKey(ref)))) block('inconsistent_goal_link', 'rubricCriteria.' + index + '.goalRefs');
    }
  });
  content.milestones.forEach((milestone, index) => {
    if (!milestone.title.trim()) block('missing_field', 'milestones.' + index + '.title');
    validateIds(milestone.taskIds, taskIds, 'milestones.' + index + '.taskIds');
  });
  unique(content.resources.map(r => r.resourceVersionId), 'resources');
  content.resources.forEach((ref, index) => {
    const matches = context.materials.filter(r => r.resourceVersionId === ref.resourceVersionId);
    const path = 'resources.' + index;
    if (matches.length !== 1 || !matches[0]!.available) { block('unavailable_resource', path); return; }
    const resource = matches[0]!;
    if (resource.courseId !== draft.courseId || !resource.teacherDesignAllowed) block('forbidden_resource', path);
    if (resource.material.kind !== 'learning_material' && (resource.material.visibility.student || resource.material.visibility.tutor)) block('forbidden_resource', path);
  });
  if (!content.helpPolicyVersionId || !context.helpPolicyVersionIds.includes(content.helpPolicyVersionId)) block('missing_version', 'helpPolicyVersionId');
  if (!content.checkRuleVersionId || !context.checkRuleVersionIds.includes(content.checkRuleVersionId)) block('missing_version', 'checkRuleVersionId');
  if (!content.runtimeProfileVersionId || !context.runtimeProfile || context.runtimeProfile.versionId !== content.runtimeProfileVersionId || !context.runtimeProfile.ready) block('runtime_not_ready', 'runtimeProfileVersionId');
  return {
    blueprintId: draft.blueprintId, revision: draft.revision, blocking,
    designConcerns: context.concerns.map(concern => ({ ...concern, status: concern.resolution?.trim() ? 'teacher_recorded' as const : 'requires_teacher' as const })),
    unverified: [
      { code: 'learning_effect' as const, path: 'goals', status: 'unknown' as const },
      { code: 'workload_estimate' as const, path: 'timeConstraints', status: 'unknown' as const },
    ],
  };
}
