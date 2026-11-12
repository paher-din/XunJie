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
  for (const path of stylesheets) styleBytes += gzipSync(await readFile(join(base, path.replace(/^\//, '')))).length;
  const scriptBudget = directory === 'dist-runtime' ? 350 : 400;
  assert(scriptBytes <= scriptBudget * 1024, `${directory}: initial JavaScript exceeds ${scriptBudget} KiB gzip (${scriptBytes})`);
  assert(styleBytes <= 80 * 1024, `${directory}: initial CSS exceeds 80 KiB gzip (${styleBytes})`);
  assert(![...visited].some(path => /\/(ActivityPage|PersonalModelSettings|ProductAgent|editor\.api)-/.test(path)),
    `${directory}: a deferred surface or editor entered the initial module graph`);
  console.log(`${directory}: initial JS ${(scriptBytes / 1024).toFixed(1)} KiB gzip, CSS ${(styleBytes / 1024).toFixed(1)} KiB gzip`);
}
