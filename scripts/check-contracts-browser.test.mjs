import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('./check-contracts-browser.mjs', import.meta.url));

function fixture(t, exports, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'contracts-browser-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contents = {
    'package.json': JSON.stringify({ name: '@fixture/contracts', type: 'module', exports }),
    'dist/index.js': 'export const ready = true;',
    ...files,
  };
  for (const [path, content] of Object.entries(contents)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [checker, root], { encoding: 'utf8' });
}

test('bundles every public export and browser-safe dependency without writing output', (t) => {
  const root = fixture(t, { '.': './dist/index.js', './codec': './dist/codec.js' }, {
    'dist/codec.js': 'export { decode } from "safe-codec";',
    'node_modules/safe-codec/package.json': JSON.stringify({ name: 'safe-codec', exports: './index.js' }),
    'node_modules/safe-codec/index.js': 'export const decode = JSON.parse;',
  });
  const before = readdirSync(root, { recursive: true }).sort();
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@fixture\/contracts\/codec/);
  assert.match(result.stdout, /2 public exports/);
  assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
});

test('resolves browser and import conditions for the package and its dependencies', (t) => {
  const root = fixture(t, {
    '.': {
      types: './dist/types.d.ts',
      browser: { import: './dist/browser.js', require: './dist/node.js' },
      default: './dist/node.js',
    },
    './import-only': { import: './dist/index.js', require: './dist/node.js' },
  }, {
    'dist/browser.js': 'export { decode } from "conditional-codec";',
    'dist/types.d.ts': 'export declare const ready: boolean;',
    'dist/node.js': 'export { readFile } from "node:fs";',
    'node_modules/conditional-codec/package.json': JSON.stringify({
      name: 'conditional-codec',
      exports: { browser: { import: './browser.js', require: './node.js' }, default: './node.js' },
    }),
    'node_modules/conditional-codec/browser.js': 'export const decode = JSON.parse;',
    'node_modules/conditional-codec/node.js': 'export { readFile as decode } from "node:fs";',
  });
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 public exports/);
});

for (const builtin of ['node:fs', 'fs']) {
  test(`fails when an otherwise-unused public export imports ${builtin}`, (t) => {
    const root = fixture(t, { '.': './dist/index.js', './unused': './dist/unused.js' }, {
      'dist/unused.js': `export { readFile } from ${JSON.stringify(builtin)};`,
    });
    const result = check(root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /@fixture\/contracts\/unused/);
    assert.match(result.stderr, /Could not resolve/);
    assert.match(result.stdout, /Browser-safe: @fixture\/contracts\n/);
    assert.doesNotMatch(result.stdout, /Browser safety checked/);
  });
}

for (const environment of ['production', 'development']) {
  test(`checks Node dependencies guarded by the ${environment} environment`, (t) => {
    const root = fixture(t, './dist/index.js', {
      'dist/index.js': `if (process.env.NODE_ENV === ${JSON.stringify(environment)}) require('node:fs'); export const ready = true;`,
    });
    const result = check(root);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Could not resolve "node:fs"/);
  });
}

test('ignores private files and null exports', (t) => {
  const root = fixture(t, { '.': './dist/index.js', './private': null }, {
    'dist/private.js': 'export { readFile } from "node:fs";',
  });
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 public exports/);
});

test('rejects imports hidden by a dependency export map even when the target exists', (t) => {
  const root = fixture(t, { '.': './dist/index.js' }, {
    'dist/index.js': 'export { hidden } from "restricted/private.js";',
    'node_modules/restricted/package.json': JSON.stringify({ name: 'restricted', exports: './index.js' }),
    'node_modules/restricted/index.js': 'export const visible = true;',
    'node_modules/restricted/private.js': 'export const hidden = true;',
  });
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /restricted\/private.js/);
});

test('rejects runtime imports left external by the browser bundler', (t) => {
  const root = fixture(t, './dist/index.js', {
    'dist/index.js': 'export { remote } from "https://example.invalid/runtime.js";',
  });
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Unresolved external runtime dependencies.*https:/);
});

test('rejects unresolved runtime package dependencies', (t) => {
  const root = fixture(t, './dist/index.js', {
    'dist/index.js': 'export { missing } from "contracts-browser-not-installed";',
  });
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Could not resolve "contracts-browser-not-installed"/);
});

for (const expression of ['import(name)', 'require(name)']) {
  test(`rejects runtime dependencies it cannot statically resolve: ${expression}`, (t) => {
    const root = fixture(t, './dist/index.js', {
      'dist/index.js': `export const load = (name) => ${expression};`,
    });
    const result = check(root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /will not be bundled/);
  });
}

test('rejects wildcard exports instead of silently checking only the root', (t) => {
  const root = fixture(t, { '.': './dist/index.js', './*': './dist/*.js' });
  const result = check(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Export patterns are unsupported.*\.\/\*/);
  assert.doesNotMatch(result.stdout, /Browser-safe/);
});

test('rejects packages without an explicit public export map', (t) => {
  const result = check(fixture(t, undefined));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /must declare public exports/);
});
