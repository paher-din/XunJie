import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkDocLinks } from './check-doc-links.mjs';

const checker = fileURLToPath(new URL('./check-doc-links.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-doc-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const write = (path, text = '') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const run = (...files) => spawnSync(process.execPath, [checker, ...files], {
    cwd: root, encoding: 'utf8',
  });
  return { root, write, run };
}

test('checks nested file, directory, image, angle and encoded targets with references', t => {
  const { root, write } = fixture(t);
  write('docs/target.md');
  write('docs/folder/readme.md');
  write('docs/image space.png');
  write('docs/中文 #?.md');
  write('docs/nested/README.md', [
    '[file](../target.md#heading)',
    '[directory](../folder/)',
    '![image](../image%20space.png)',
    '[angle](<../image space.png>)',
    '[encoded](../%E4%B8%AD%E6%96%87%20%23%3F.md?raw=1#heading)',
    '[reference][doc]',
    '![reference image][image]',
    '[shortcut]',
    '> - [nested](../target.md)',
    '',
    '[doc]: ../target.md "title"',
    '[image]: <../image space.png>',
    '[shortcut]: ../target.md',
  ].join('\n'));
  const result = checkDocLinks({ root, files: ['docs/nested/README.md'] });
  assert.equal(result.checked, 9);
  assert.deepEqual(result.failures, []);
});

test('ignores fenced/inline code and remote or fragment-only links, preserves failure lines', t => {
  const { root, write } = fixture(t);
  write('README.md', [
    '```md',
    '[broken](missing.md)',
    '```',
    '`[broken](missing.md)`',
    '[web](https://example.com/no-network) [mail](mailto:user@example.com)',
    '[custom](project-file:123) [fragment](#missing-heading)',
    '[cdn](//example.com/image) [absolute](/outside.md)',
    '',
    '[broken](missing.md)',
    '',
    '    [indented code](also-missing.md)',
  ].join('\n'));
  const result = checkDocLinks({ root });
  assert.equal(result.checked, 1);
  assert.deepEqual(result.failures, [
    'README.md:9: missing local target "missing.md" (missing.md)',
  ]);
});

test('CLI reports reference/image failures and malformed encoding with nonzero exit', t => {
  const { write, run } = fixture(t);
  write('README.md', '# title\n\n[bad][ref]\n![bad image](missing.png)\n[bad encoding](bad%zz.md)\n\n[ref]: gone.md\n');
  const result = run('README.md');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md:3: missing local target "gone\.md"/);
  assert.match(result.stderr, /README\.md:4: missing local target "missing\.png"/);
  assert.match(result.stderr, /README\.md:5: invalid percent encoding/);
  assert.match(result.stdout, /1 Markdown files, 3 local targets, 3 failures/);
});

test('default discovery includes tracked and moved/untracked docs, skips caches and aliases', t => {
  const { root, write, run } = fixture(t);
  write('README.md');
  write('old.md');
  execFileSync('git', ['add', 'README.md', 'old.md'], { cwd: root });
  rmSync(join(root, 'old.md'));
  write('docs/moved.md', '[bad](lost.md)');
  write('.gitignore', 'cache/\n');
  for (const path of ['node_modules/pkg/README.md', 'dist/README.md', 'cache/README.md',
    'test-results/run/README.md', 'apps/server/tests/evidence/README.md']) {
    write(path, '[bad](lost.md)');
  }
  mkdirSync(join(root, '.agents/skills'), { recursive: true });
  symlinkSync(join(root, 'docs'), join(root, '.agents/skills/alias'), 'dir');
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/moved\.md:1: missing local target/);
  assert.match(result.stdout, /2 Markdown files, 1 local targets, 1 failures/);
  assert.equal(checkDocLinks({ root, files: ['.agents/skills/alias/moved.md'] }).files, 0);
});

test('archive inputs are excluded while links into archive are checked by existence', t => {
  const { root, write, run } = fixture(t);
  write('docs/archive/old.md', '[stale](missing.md)');
  write('README.md', '[archive](docs/archive/old.md#unknown-anchor)');
  const result = checkDocLinks({ root });
  assert.equal(result.files, 1);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.failures, []);
  assert.equal(checkDocLinks({ root, files: ['docs/archive/old.md'] }).files, 0);
  assert.equal(run().status, 0);
  rmSync(join(root, 'docs/archive/old.md'));
  assert.match(checkDocLinks({ root }).failures[0], /README\.md:1: missing local target/);
});

test('CLI focuses on explicit inputs and reports missing input files', t => {
  const { write, run } = fixture(t);
  write('good.md', '[self](good.md)');
  write('bad.md', '[broken](missing.md)');
  assert.equal(run('good.md').status, 0);
  const missing = run('absent.md');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /absent\.md:1: Markdown input does not exist/);
});
