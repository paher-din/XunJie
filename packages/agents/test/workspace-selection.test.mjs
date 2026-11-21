import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceMaterials } from '../dist/workspace-assistant/index.js';

const file = {
  objectId: '11111111-1111-4111-8111-111111111111',
  contentId: '22222222-2222-4222-8222-222222222222',
  name: 'alu.sv', kind: 'code', encoding: 'utf8', mediaType: 'text/plain',
  value: 'SELECTED_MARKER\nOUTSIDE_MARKER',
};
const fixed = {
  referenceId: '33333333-3333-4333-8333-333333333333',
  source: { kind: 'work', objectId: file.objectId, contentId: file.contentId },
  range: { kind: 'text', start: 0, end: 15 }, copy: 'SELECTED_MARKER', sourceName: 'alu.sv',
};
const workspace = question => ({
  actions: [{ action: { works: [file], draft: { question, references: [fixed], bases: [file] } } }],
  unavailable: new Set(), unavailableReferences: new Set(),
});

test('选区提问只内联获准片段，不把同一作品快照全文再次装入', () => {
  const materials = workspaceMaterials(workspace('解释选中的代码'), new Map());
  assert.equal(materials.some(item => item.kind === 'student-reference'
    && item.content === 'SELECTED_MARKER'), true);
  assert.equal(materials.some(item => item.source.kind === 'work'
    && item.content?.includes('OUTSIDE_MARKER')), false);
});

test('学生明确要求通读时仍可按固定快照装入全文', () => {
  const materials = workspaceMaterials(workspace('请通读全文并指出问题'), new Map());
  assert.equal(materials.some(item => item.source.kind === 'work'
    && item.content?.includes('OUTSIDE_MARKER')), true);
});
