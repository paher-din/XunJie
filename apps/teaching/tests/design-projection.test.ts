import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraft } from '../server/design/draft.ts';
import { prepareMaterial, type DesignMaterialVersion } from '../server/design/material.ts';
import { projectDraftPreview } from '../server/design/projection.ts';
import { ApiError } from '../server/app/errors.ts';

function fixture() {
  const resources: DesignMaterialVersion[] = [
    { courseId: 'course', resourceVersionId: 'public', available: true, teacherDesignAllowed: true,
      material: prepareMaterial({ format: 'txt', title: 'Visible', content: 'public text', visibility: { student: true, tutor: true } }, 0) },
    { courseId: 'course', resourceVersionId: 'private-id', available: true, teacherDesignAllowed: true,
      material: prepareMaterial({ format: 'txt', title: 'private title', content: 'private answer', kind: 'private_answer' }, 0) },
  ];
  const draft = createDraft({ courseId: 'course', blueprintId: 'draft' }, {
    projectTitle: 'Synthetic', problem: 'Public problem', routes: ['array'],
    resources: resources.map(r => ({ resourceVersionId: r.resourceVersionId })),
    checkRuleVersionId: 'private-rule', runtimeProfileVersionId: 'private-runtime',
  });
  return { draft, resources, access: { authorizeTeacher: (courseId: string) => { if (courseId !== 'course') throw new ApiError('FORBIDDEN'); } } };
}

test('student and tutor previews omit all private asset identifiers, titles, hashes and content', () => {
  const f = fixture();
  for (const audience of ['student', 'tutor'] as const) {
    const preview = projectDraftPreview(f.draft, audience, { materials: f.resources, access: f.access });
    assert.equal(preview.content.problem, 'Public problem');
    assert.deepEqual(preview.materials.filter(m => m.status !== 'available'), [{ status: 'redacted' }]);
    const serialized = JSON.stringify(preview);
    for (const secret of ['private-id', 'private title', 'private answer', 'private-rule', 'private-runtime', f.resources[1]!.material.contentHash]) assert.equal(serialized.includes(secret), false);
  }
  const teacher = projectDraftPreview(f.draft, 'teacher-validator', { materials: f.resources, access: f.access });
  assert.equal(teacher.materials.filter(m => m.status === 'available').length, 2);
});


test('preview audiences cannot grant teacher authorization or bypass a denied course', () => {
  const f = fixture();
  const denied = { authorizeTeacher: (_courseId: string) => { throw new ApiError('FORBIDDEN'); } };
  for (const audience of ['student', 'tutor', 'teacher-validator']) {
    assert.throws(() => projectDraftPreview(f.draft, audience, { materials: f.resources, access: denied }), (e: unknown) => e instanceof ApiError && e.code === 'FORBIDDEN');
  }
  assert.throws(() => projectDraftPreview({ ...f.draft, courseId: 'other' }, 'teacher-validator', { materials: f.resources, access: f.access }), (e: unknown) => e instanceof ApiError && e.code === 'FORBIDDEN');
  for (const audience of ['admin', { role: 'teacher', studentId: 'someone' }]) {
    assert.throws(() => projectDraftPreview(f.draft, audience, { materials: f.resources, access: f.access }), (e: unknown) => e instanceof ApiError && e.code === 'INVALID_REQUEST');
  }
});

test('visibility is purpose-specific and ambiguous, withdrawn or foreign materials expose no metadata', () => {
  const f = fixture();
  f.resources[0]!.material.visibility = { student: true, tutor: false };
  assert.equal(projectDraftPreview(f.draft, 'student', { materials: f.resources, access: f.access }).materials[0]!.status, 'available');
  assert.equal(projectDraftPreview(f.draft, 'tutor', { materials: f.resources, access: f.access }).materials[0]!.status, 'redacted');
  for (const change of [{ courseId: 'other' }, { teacherDesignAllowed: false }, { available: false }]) {
    const resources = structuredClone(f.resources);
    Object.assign(resources[0]!, change);
    const preview = projectDraftPreview(f.draft, 'teacher-validator', { materials: resources, access: f.access });
    assert.deepEqual(Object.keys(preview.materials[0]!), ['status']);
  }
  for (const resources of [[], [...f.resources, f.resources[0]!]]) {
    assert.deepEqual(projectDraftPreview(f.draft, 'student', { materials: resources, access: f.access }).materials[0], { status: 'unavailable' });
  }
  f.resources[1]!.material.visibility = { student: true, tutor: true };
  for (const audience of ['student', 'tutor']) {
    assert.deepEqual(projectDraftPreview(f.draft, audience, { materials: f.resources, access: f.access }).materials[1], { status: 'redacted' });
  }
});

test('preview rejects unknown draft fields, whitelists material metadata and returns independent content', () => {
  const f = fixture();
  f.draft.content.goals = [{ competencyId: 'g', competencyVersion: 1, domain: 'domain', title: 'Public goal', core: true }];
  f.draft.content.tasks = [{ taskId: 't', title: 'Public task', goalRefs: [{ competencyId: 'g', competencyVersion: 1 }] }];
  const withSecret = { ...f.draft, content: { ...f.draft.content, privateAnswer: 'secret' } };
  assert.throws(() => projectDraftPreview(withSecret, 'student', { materials: f.resources, access: f.access }), (e: unknown) => e instanceof ApiError && e.code === 'INVALID_REQUEST');
  Object.assign(f.resources[0]!.material, { internalNotes: 'secret' });
  const preview = projectDraftPreview(f.draft, 'student', { materials: f.resources, access: f.access });
  assert.equal(JSON.stringify(preview).includes('secret'), false);
  preview.content.routes[0] = 'changed';
  preview.content.tasks[0]!.goalRefs[0]!.competencyId = 'changed';
  const visible = preview.materials[0]!;
  if (visible.status !== 'available') assert.fail('Public resource must remain available');
  visible.paragraphs[0]!.text = 'changed';
  assert.equal(f.draft.content.routes[0], 'array');
  assert.equal(f.draft.content.tasks[0]!.goalRefs[0]!.competencyId, 'g');
  assert.equal(f.resources[0]!.material.paragraphs[0]!.text, 'public text');
});
