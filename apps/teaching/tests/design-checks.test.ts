import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraft, editDraft } from '../server/design/draft.ts';
import { checkDraft, type CheckContext } from '../server/design/checks.ts';
import { prepareMaterial } from '../server/design/material.ts';

test('partial drafts remain editable while checks separately report blockers, teacher concerns and unknown effects', () => {
  const draft = createDraft({ courseId: 'course', blueprintId: 'draft' }, { projectTitle: 'Synthetic' });
  const report = checkDraft(draft, { materials: [], helpPolicyVersionIds: [], checkRuleVersionIds: [], concerns: [{ code: 'rubric_ambiguity', path: 'rubricCriteria', reason: 'Teacher must review' }] });
  assert.equal(report.revision, 1);
  assert.equal(report.blueprintId, 'draft');
  assert.ok(report.blocking.some(i => i.code === 'runtime_not_ready'));
  assert.ok(report.blocking.some(i => i.path === 'problem'));
  assert.equal(report.designConcerns[0]!.status, 'requires_teacher');
  assert.deepEqual(report.unverified.map(i => i.code), ['learning_effect', 'workload_estimate']);
  assert.ok(report.unverified.every(i => i.status === 'unknown'));
  assert.equal(editDraft(draft, 1, { problem: 'Manual next step' }).revision, 2);
});


function completeFixture() {
  const goals = [
    { competencyId: 'k', competencyVersion: 1, domain: 'domain', title: 'Explain pointers' },
    { competencyId: 'p', competencyVersion: 1, domain: 'project', title: 'Compare structures' },
    { competencyId: 'a', competencyVersion: 1, domain: 'ai_collaboration', title: 'Check suggestions' },
  ];
  const refs = goals.map(g => ({ competencyId: g.competencyId, competencyVersion: g.competencyVersion }));
  const draft = createDraft({ courseId: 'course', blueprintId: 'draft' }, {
    projectTitle: 'Synthetic', problem: 'Explore a text problem', audience: 'Course peers', artifact: 'C source',
    routes: ['array', 'tree'], goals,
    tasks: [{ taskId: 't', title: 'Build and compare', goalRefs: refs }],
    observations: [{ observationId: 'o', description: 'Explain and validate decisions', goalRefs: refs, taskIds: ['t'] }],
    rubricCriteria: [{ criterionId: 'r', description: 'Supported reasoning', goalRefs: refs, observationIds: ['o'] }],
    milestones: [{ milestoneId: 'm', title: 'Review', taskIds: ['t'] }],
    resources: [{ resourceVersionId: 'material-v1' }],
    helpPolicyVersionId: 'help-v1', checkRuleVersionId: 'check-v1', runtimeProfileVersionId: 'runtime-v1',
  });
  const context: CheckContext = {
    materials: [{ courseId: 'course', resourceVersionId: 'material-v1', available: true, teacherDesignAllowed: true,
      material: prepareMaterial({ format: 'txt', title: 'Synthetic', content: 'abc', visibility: { student: true, tutor: true } }, 0) }],
    helpPolicyVersionIds: ['help-v1'], checkRuleVersionIds: ['check-v1'],
    runtimeProfile: { versionId: 'runtime-v1', ready: true }, concerns: [],
  };
  return { draft, context };
}

test('valid linked synthetic design passes structure while effects remain unknown and teacher concerns persist', () => {
  const { draft, context } = completeFixture();
  context.concerns = [{ code: 'time', path: 'timeConstraints', reason: 'Estimate needs review', resolution: 'Teacher recorded a plan' }];
  const report = checkDraft(draft, context);
  assert.deepEqual(report.blocking, []);
  assert.equal(report.designConcerns[0]!.status, 'teacher_recorded');
  assert.equal(report.unverified.length, 2);
  assert.ok(report.unverified.every(i => i.status === 'unknown'));
  assert.equal(checkDraft(draft, { ...context, runtimeProfile: { versionId: 'old-runtime', ready: true } }).blocking.some(i => i.code === 'runtime_not_ready'), true);
  assert.equal(checkDraft(draft, { ...context, runtimeProfile: { versionId: 'runtime-v1', ready: false } }).blocking.some(i => i.code === 'runtime_not_ready'), true);
});

test('missing observations, duplicate IDs, old goal versions and broken task/rubric links are blockers', () => {
  const { draft, context } = completeFixture();
  const missing = structuredClone(draft);
  missing.content.observations = [];
  assert.ok(checkDraft(missing, context).blocking.some(i => i.code === 'missing_goal_observation'));
  const duplicate = structuredClone(draft);
  duplicate.content.tasks.push(structuredClone(duplicate.content.tasks[0]!));
  assert.ok(checkDraft(duplicate, context).blocking.some(i => i.code === 'duplicate_reference'));
  const stale = structuredClone(draft);
  stale.content.observations[0]!.goalRefs[0]!.competencyVersion = 2;
  assert.ok(checkDraft(stale, context).blocking.some(i => i.code === 'invalid_reference'));
  const dangling = structuredClone(draft);
  dangling.content.observations[0]!.taskIds = ['missing'];
  dangling.content.rubricCriteria[0]!.observationIds = ['missing'];
  assert.ok(checkDraft(dangling, context).blocking.filter(i => i.code === 'invalid_reference').length >= 2);
  const unrelated = structuredClone(draft);
  unrelated.content.tasks[0]!.goalRefs = [unrelated.content.tasks[0]!.goalRefs[0]!];
  assert.ok(checkDraft(unrelated, context).blocking.some(i => i.code === 'inconsistent_goal_link'));
  const wrongRubric = structuredClone(draft);
  wrongRubric.content.observations[0]!.goalRefs = [wrongRubric.content.observations[0]!.goalRefs[0]!];
  assert.ok(checkDraft(wrongRubric, context).blocking.some(i => i.code === 'inconsistent_goal_link' && i.path.startsWith('rubricCriteria')));
});

test('cross-course, withdrawn, unauthorized, ambiguous resources and unavailable policy versions are blocked', () => {
  const { draft, context } = completeFixture();
  for (const change of [{ courseId: 'other' }, { available: false }, { teacherDesignAllowed: false }]) {
    const invalid = structuredClone(context);
    Object.assign(invalid.materials[0]!, change);
    assert.ok(checkDraft(draft, invalid).blocking.some(i => i.code === 'forbidden_resource' || i.code === 'unavailable_resource'));
  }
  assert.ok(checkDraft(draft, { ...context, materials: [...context.materials, ...context.materials] }).blocking.some(i => i.code === 'unavailable_resource'));
  assert.ok(checkDraft(draft, { ...context, helpPolicyVersionIds: [], checkRuleVersionIds: [] }).blocking.filter(i => i.code === 'missing_version').length === 2);
  const forgedPrivate = structuredClone(context);
  forgedPrivate.materials[0]!.material.kind = 'validation_asset';
  assert.ok(checkDraft(draft, forgedPrivate).blocking.some(i => i.code === 'forbidden_resource'));
});


test('blank solution routes block confirmation without preventing a partial draft edit', () => {
  const { draft, context } = completeFixture();
  const edited = editDraft(draft, 1, { routes: ['  ', '\t'] });
  assert.equal(edited.revision, 2);
  assert.ok(checkDraft(edited, context).blocking.some(i => i.code === 'missing_field' && i.path.startsWith('routes')));
});
