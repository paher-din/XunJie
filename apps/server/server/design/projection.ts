import { z } from 'zod';
import { draftSchema, type BlueprintDraft } from './model.ts';
import type { DesignMaterialVersion } from './material.ts';
import { parseRequest } from '../app/validation.ts';

const audienceSchema = z.enum(['student', 'tutor', 'teacher-validator']);
interface PreviewContext {
  materials: DesignMaterialVersion[];
  access: { authorizeTeacher(courseId: string): void };
}

export function projectDraftPreview(input: BlueprintDraft, audienceInput: unknown, context: PreviewContext) {
  const draft = parseRequest(draftSchema, input);
  context.access.authorizeTeacher(draft.courseId);
  return projectContent(draft, audienceInput, context.materials);
}

export function projectActivityContent(input: BlueprintDraft, audienceInput: unknown, context: { materials: DesignMaterialVersion[]; authorizeActivity(courseId: string): void }) {
  const draft = parseRequest(draftSchema, input);
  context.authorizeActivity(draft.courseId);
  return projectContent(draft, audienceInput, context.materials);
}

function projectContent(draft: BlueprintDraft, audienceInput: unknown, materialsInput: DesignMaterialVersion[]) {
  const audience = parseRequest(audienceSchema, audienceInput);
  const c = draft.content;
  const goalRef = (g: { competencyId: string; competencyVersion: number }) => ({ competencyId: g.competencyId, competencyVersion: g.competencyVersion });
  const content = {
    projectTitle: c.projectTitle, problem: c.problem, audience: c.audience, artifact: c.artifact,
    studentBackground: c.studentBackground, timeConstraints: c.timeConstraints, routes: [...c.routes],
    goals: c.goals.map(g => ({ ...goalRef(g), domain: g.domain, title: g.title, core: g.core })),
    tasks: c.tasks.map(t => ({ taskId: t.taskId, title: t.title, goalRefs: t.goalRefs.map(goalRef) })),
    observations: c.observations.map(o => ({ observationId: o.observationId, description: o.description, taskIds: [...o.taskIds], goalRefs: o.goalRefs.map(goalRef) })),
    rubricCriteria: c.rubricCriteria.map(r => ({ criterionId: r.criterionId, description: r.description, observationIds: [...r.observationIds], goalRefs: r.goalRefs.map(goalRef) })),
    milestones: c.milestones.map(m => ({ milestoneId: m.milestoneId, title: m.title, taskIds: [...m.taskIds] })),
    helpPolicyVersionId: c.helpPolicyVersionId,
  };
  const materials = c.resources.map(ref => {
    const matches = materialsInput.filter(r => r.resourceVersionId === ref.resourceVersionId);
    if (matches.length !== 1 || !matches[0]!.available) return { status: 'unavailable' as const };
    const resource = matches[0]!;
    if (resource.courseId !== draft.courseId || !resource.teacherDesignAllowed) return { status: 'redacted' as const };
    const material = resource.material;
    if (audience !== 'teacher-validator' && (material.kind !== 'learning_material' || !material.visibility[audience])) return { status: 'redacted' as const };
    return {
      status: 'available' as const, resourceVersionId: resource.resourceVersionId,
      title: material.title, text: material.text, contentHash: material.contentHash,
      paragraphs: material.paragraphs.map(p => ({ ...('paragraphId' in p && typeof p.paragraphId === 'string' ? { paragraphId: p.paragraphId } : {}), ordinal: p.ordinal, start: p.start, end: p.end, text: p.text, contentHash: p.contentHash })),
    };
  });
  return { blueprintId: draft.blueprintId, revision: draft.revision, audience, content, materials };
}
