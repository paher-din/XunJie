import { ApiError } from '../app/errors.ts';
import { parseRequest } from '../app/validation.ts';
import { contentPatchSchema, contentSchema, draftSchema, identitySchema, versionSchema, type BlueprintDraft } from './model.ts';

export function createDraft(identity: unknown, content: unknown = {}): BlueprintDraft {
  const keys = parseRequest(identitySchema, identity);
  const partial = parseRequest(contentPatchSchema, content);
  return { ...keys, revision: 1, content: parseRequest(contentSchema, {
    routes: [], goals: [], tasks: [], observations: [], rubricCriteria: [], milestones: [], resources: [], ...partial,
  }) };
}
export function editDraft(current: BlueprintDraft, expectedRevision: number, patch: unknown): BlueprintDraft {
  const draft = parseRequest(draftSchema, current);
  parseRequest(versionSchema, expectedRevision);
  if (draft.revision !== expectedRevision) throw new ApiError('VERSION_CONFLICT');
  if (draft.revision === Number.MAX_SAFE_INTEGER) throw new ApiError('INVALID_REQUEST');
  const changes = parseRequest(contentPatchSchema, patch);
  const content = parseRequest(contentSchema, { ...draft.content, ...changes });
  for (const goal of content.goals) {
    const previous = draft.content.goals.find(g => g.competencyId === goal.competencyId);
    if (previous && (goal.competencyVersion < previous.competencyVersion || (goal.competencyVersion === previous.competencyVersion && (previous.domain !== goal.domain || previous.title !== goal.title)))) throw new ApiError('INVALID_REQUEST');
  }
  return { ...draft, revision: draft.revision + 1, content };
}
export function copyDraft(source: BlueprintDraft, identity: unknown): BlueprintDraft {
  const original = parseRequest(draftSchema, source);
  const copy = createDraft(identity, original.content);
  if (copy.blueprintId === original.blueprintId) throw new ApiError('INVALID_REQUEST');
  return { ...copy, source: { courseId: original.courseId, blueprintId: original.blueprintId, revision: original.revision } };
}
