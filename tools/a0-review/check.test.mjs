import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRepository } from './check.mjs';

const readmeUrl = new URL('../../README.md', import.meta.url);
const readme = readFileSync(readmeUrl, 'utf8');
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
