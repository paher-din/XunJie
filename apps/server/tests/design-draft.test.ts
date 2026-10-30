import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraft, editDraft, copyDraft } from '../server/design/draft.ts';

test('a teacher can start a partial draft and edit one field without losing other manual content', () => {
  const current = createDraft({ courseId: 'course', blueprintId: 'draft' }, { projectTitle: 'Synthetic', problem: 'Manual problem', routes: ['array', 'tree'] });
  assert.equal(current.revision, 1);
  const edited = editDraft(current, 1, { projectTitle: 'Revised' });
  assert.equal(edited.revision, 2);
  assert.equal(edited.content.projectTitle, 'Revised');
  assert.equal(edited.content.problem, 'Manual problem');
  assert.deepEqual(edited.content.routes, ['array', 'tree']);
  assert.equal(current.content.projectTitle, 'Synthetic');
  edited.content.routes.push('hash');
  assert.deepEqual(current.content.routes, ['array', 'tree']);
  assert.equal(createDraft({ courseId: 'course', blueprintId: 'empty' }).revision, 1);
});


test('stale revisions and identity/role injection fail without changing manual edits', () => {
  const current = createDraft({ courseId: 'course', blueprintId: 'draft' }, { problem: 'Manual' });
  const edited = editDraft(current, 1, { problem: 'Changed' });
  assert.throws(() => editDraft(edited, 1, { problem: 'Stale AI candidate' }), { code: 'VERSION_CONFLICT' });
  for (const patch of [{ courseId: 'other' }, { blueprintId: 'forged' }, { revision: 1 }, { role: 'teacher' }, { studentId: 'other' }, { unknown: 'x' }]) {
    assert.throws(() => editDraft(edited, 2, patch), { code: 'INVALID_REQUEST' });
  }
  assert.equal(edited.content.problem, 'Changed');
  for (const revision of [0, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => editDraft(current, revision, {}), { code: 'INVALID_REQUEST' });
});

test('copy creates a new draft at revision one and keeps an independent source reference', () => {
  const source = editDraft(createDraft({ courseId: 'course', blueprintId: 'source' }, { routes: ['array'], problem: 'Original' }), 1, { problem: 'Manual revision' });
  const copy = copyDraft(source, { courseId: 'course', blueprintId: 'copy' });
  assert.equal(copy.revision, 1);
  assert.deepEqual(copy.source, { courseId: 'course', blueprintId: 'source', revision: 2 });
  copy.content.routes.push('tree');
  assert.deepEqual(source.content.routes, ['array']);
  assert.equal(source.content.problem, 'Manual revision');
  assert.throws(() => copyDraft(source, { courseId: 'course', blueprintId: 'source' }), { code: 'INVALID_REQUEST' });
});

test('goal semantics cannot silently change while retaining the same competency version', () => {
  const goal = { competencyId: 'knowledge', competencyVersion: 1, domain: 'domain', title: 'Explain pointers', core: true };
  const draft = createDraft({ courseId: 'course', blueprintId: 'draft' }, { goals: [goal] });
  assert.throws(() => editDraft(draft, 1, { goals: [{ ...goal, title: 'Implement allocation' }] }), { code: 'INVALID_REQUEST' });
  assert.throws(() => editDraft(draft, 1, { goals: [{ ...goal, domain: 'project' }] }), { code: 'INVALID_REQUEST' });
  const changed = editDraft(draft, 1, { goals: [{ ...goal, competencyVersion: 2, title: 'Implement allocation' }] });
  assert.equal(changed.content.goals[0]!.competencyVersion, 2);
  assert.equal(draft.content.goals[0]!.title, 'Explain pointers');
});

test('an edit cannot reuse a lower competency version for changed goal semantics', () => {
  const goal = { competencyId: 'knowledge', competencyVersion: 2, domain: 'domain', title: 'Explain pointers', core: true };
  const draft = createDraft({ courseId: 'course', blueprintId: 'draft' }, { goals: [goal] });
  assert.throws(() => editDraft(draft, 1, { goals: [{ ...goal, competencyVersion: 1, title: 'Implement allocation' }] }), { code: 'INVALID_REQUEST' });
  assert.equal(draft.content.goals[0]!.competencyVersion, 2);
});
