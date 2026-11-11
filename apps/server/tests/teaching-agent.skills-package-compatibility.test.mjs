import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parseTeachingSkillPackage, validateTeachingSkillVersion } from '../../../packages/learning-space/dist/teaching-agent/skills-package.js';

for (const [label, header, expected] of [
  ['Chinese names', 'name: 编程手\ndescription: 按任务编写与调试程序', { name: '编程手' }],
  ['long source descriptions', `name: api-guidance\ndescription: ${'A'.repeat(1068)}`, { description: 'A'.repeat(1068) }],
  ['opaque author metadata', 'name: authored-guidance\ndescription: 原始指导\nmetadata:\n  credits:\n    author: Example\n  related-skills: null\n  openclaw:\n    requires:\n      bins: [python3]\n  verified: true\n  revision: 2',
    { metadata: { credits: { author: 'Example' }, 'related-skills': null, openclaw: { requires: { bins: ['python3'] } }, verified: true, revision: 2 } }],
]) {
  test(`imports ${label} without changing the original document`, () => {
    const content = `---\n${header}\n---\n# 原始指导\n正文不变。\n`;
    const input = { requestId: randomUUID(), source: 'local:compatibility', packageVersion: '1',
      files: [{ path: 'SKILL.md', encoding: 'utf8', content }] };
    const parsed = parseTeachingSkillPackage(input);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(parsed.metadata[key], value);
    assert.equal(parsed.files[0].content, content);
    const fixed = { ...parsed, skillId: randomUUID(), version: 1 };
    assert.deepEqual(validateTeachingSkillVersion(fixed), fixed);
  });
}

test('author metadata does not replace supported dependency and tool declarations', () => {
  const input = { requestId: randomUUID(), source: 'local:compatibility', packageVersion: '1',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: invalid-tools\ndescription: 指导\nallowed-tools: {invalid: declaration}\nmetadata:\n  openclaw: {requires: {bins: [python3]}}\n---\n正文' }] };
  assert.throws(() => parseTeachingSkillPackage(input), error => error.reason === 'metadata');
});

test('imports UTF-8 BOM and Windows line endings while preserving the original bytes', () => {
  const content = '\uFEFF---\r\nname: bom-guidance\r\ndescription: 原始说明\r\n---\r\n# 正文\r\n';
  const parsed = parseTeachingSkillPackage({ requestId: randomUUID(), source: 'local:compatibility', packageVersion: '1',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content }] });
  assert.equal(parsed.metadata.name, 'bom-guidance');
  assert.equal(parsed.files[0].content, content);
  const fixed = { ...parsed, skillId: randomUUID(), version: 1 };
  assert.deepEqual(validateTeachingSkillVersion(fixed), fixed);
});
