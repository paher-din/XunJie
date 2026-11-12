import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'apps/web/package.json'));
const viteRequire = createRequire(require.resolve('vite/package.json'));
const { parseAst } = await import(viteRequire.resolve('rollup/parseAst'));
const sprout = join(root, 'packages/ui/src/assets/brand/sprout/compact');
const compactBytes = (await Promise.all(['master.webp', 'rig/underpaint-v1.webp']
  .map(path => readFile(join(sprout, path))))).reduce((total, buffer) => total + buffer.length, 0);
assert(compactBytes <= 64 * 1024, `Product mascot textures exceed 64 KiB (${compactBytes})`);
console.log(`Product mascot textures: ${(compactBytes / 1024).toFixed(1)} KiB`);
const coreFontBytes = (await readFile(join(root, 'packages/ui/src/assets/fonts/wenkai/core.woff2'))).length;
assert(coreFontBytes <= 64 * 1024, `Core UI font exceeds 64 KiB (${coreFontBytes})`);
console.log(`Core UI font: ${(coreFontBytes / 1024).toFixed(1)} KiB`);
for (const directory of ['dist', 'dist-runtime']) {
  const base = join(root, 'apps/web', directory);
  const html = await readFile(join(base, 'index.html'), 'utf8');
  const entries = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/g)].map(match => match[1]);
  assert(entries.length > 0, `${directory}: missing built entry`);
  const visited = new Set();
  let scriptBytes = 0;
  const visit = async path => {
    const file = resolve(base, path.replace(/^\//, ''));
    if (visited.has(file)) return;
    visited.add(file);
    const source = await readFile(file, 'utf8');
    scriptBytes += gzipSync(source).length;
    for (const item of parseAst(source).body) if (item.type === 'ImportDeclaration' && item.source.value.startsWith('.'))
      await visit(resolve(dirname(file), item.source.value).slice(base.length + 1));
  };
  for (const entry of entries) await visit(entry);
  const stylesheets = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+\.css)"/g)].map(match => match[1]);
  let styleBytes = 0;
  for (const path of stylesheets) {
    const source = await readFile(join(base, path.replace(/^\//, '')));
    assert(!/@font-face\s*\{[^}]*url\(["']?data:/.test(source.toString()), `${directory}: font data must stay outside initial CSS`);
    styleBytes += gzipSync(source).length;
  }
  const scriptBudget = directory === 'dist-runtime' ? 350 : 400;
  assert(scriptBytes <= scriptBudget * 1024, `${directory}: initial JavaScript exceeds ${scriptBudget} KiB gzip (${scriptBytes})`);
  assert(styleBytes <= 82 * 1024, `${directory}: initial CSS including font declarations exceeds 82 KiB gzip (${styleBytes})`);
  assert(![...visited].some(path => /\/(ActivityPage|PersonalModelSettings|ProductAgent|editor\.api)-/.test(path)),
    `${directory}: a deferred surface or editor entered the initial module graph`);
  console.log(`${directory}: initial JS ${(scriptBytes / 1024).toFixed(1)} KiB gzip, CSS ${(styleBytes / 1024).toFixed(1)} KiB gzip`);
}
