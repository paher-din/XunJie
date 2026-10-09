import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRepository } from './check.mjs';

const readmeUrl = new URL('../../README.md', import.meta.url);
const readme = readFileSync(readmeUrl, 'utf8');
const technicalPath = 'docs/product/TECH_DESIGN.md';
const technical = readFileSync(new URL('../../docs/product/TECH_DESIGN.md', import.meta.url), 'utf8');
const absolutePath = fileURLToPath(readmeUrl);
const errorsFor = (target) => checkRepository(undefined, {
  'README.md': `${readme}\n[fixture](${target})\n`,
}).errors;

test('current repository passes structural checks', () => {
  assert.deepEqual(checkRepository().errors, []);
});

test('encoded relative paths remain valid', () => {
  assert.deepEqual(errorsFor(encodeURIComponent('docs/product/PRD.md')), []);
});

test('existing repository directory links remain valid', () => {
  assert.deepEqual(errorsFor('skills/'), []);
  assert.deepEqual(errorsFor('course_matrial/'), []);
});

test('directory links cannot claim a document heading', () => {
  assert.ok(errorsFor('skills/#missing').some((error) => error.includes('directory heading')));
});

for (const [name, target, expected] of [
  ['absolute path', absolutePath, 'absolute document link'],
  ['encoded absolute path inside repository', encodeURIComponent(absolutePath), 'absolute document link'],
  ['encoded file URL', encodeURIComponent(readmeUrl.href), 'absolute document link'],
  ['encoded parent traversal', encodeURIComponent('../README.md'), 'document link escapes repository'],
  ['malformed encoding', '%ZZ', 'cannot read link'],
]) {
  test(`rejects ${name}`, () => {
    assert.ok(errorsFor(target).some((error) => error.includes(expected)));
  });
}

test('legacy proposal routes remain valid before G0 adoption', () => {
  const newRoutes = ['feedback', 'rubric-trials', 'sample-runs', 'snapshots'];
  const legacy = technical.split(/\r?\n/).filter((line) =>
    !line.startsWith('| POST /api/activities/:id/controls') &&
    !newRoutes.some((name) => line.startsWith('| POST ') && line.includes(`/:id/${name} |`)),
  ).join('\n').replace(/^状态：.*$/m, '状态：推荐技术基线；尚未批准。');
  const result = checkRepository(undefined, { [technicalPath]: legacy });
  assert.deepEqual(result.errors, []);
  assert.equal(result.g0Approved, false);
  assert.equal(result.baselineMutationRoutes, 22);
  assert.equal(result.additionalProposedRoutes.length, 2);
});

for (const route of [
  'POST /api/attempts/:id/feedback',
  'POST /api/blueprints/:id/rubric-trials',
  'POST /api/activities/:id/controls',
  'POST /api/blueprints/:id/sample-runs',
  'POST /api/attempts/:id/snapshots',
]) {
  test(`rejects missing approved route ${route}`, () => {
    const broken = technical.split(/\r?\n/).filter((line) => !line.startsWith(`| ${route} |`)).join('\n');
    assert.ok(checkRepository(undefined, { [technicalPath]: broken }).errors.some((error) => error.includes(route)));
  });
}

test('G0 adoption does not allow arbitrary command additions', () => {
  const broken = technical.replace('## 6. 教学决策与上下文', 'POST /api/unsupported\n\n## 6. 教学决策与上下文');
  assert.ok(checkRepository(undefined, { [technicalPath]: broken }).errors.some((error) => error.includes('POST /api/unsupported')));
});
