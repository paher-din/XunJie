import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const defaultRoot = fileURLToPath(new URL('../packages/contracts/', import.meta.url));

function publicExports(exports) {
  if (exports == null) throw new Error('Package must declare public exports.');
  if (typeof exports === 'object' && !Array.isArray(exports)) {
    const keys = Object.keys(exports);
    if (keys.some((key) => key.startsWith('.'))) {
      for (const key of keys) {
        if (key.includes('*') || key.endsWith('/')) {
          throw new Error(`Export patterns are unsupported; declare explicit public exports: ${key}`);
        }
        if (key !== '.' && !key.startsWith('./')) throw new Error(`Invalid export key: ${key}`);
      }
      const entries = keys.filter((key) => exports[key] !== null);
      if (!entries.length) throw new Error('Package must declare public exports.');
      return entries;
    }
  }
  return ['.'];
}

async function main() {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/check-contracts-browser.mjs [package-root]');
  const root = resolve(process.argv[2] ?? defaultRoot);
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (typeof manifest.name !== 'string' || !manifest.name) throw new Error('Package must declare its name.');
  const entries = publicExports(manifest.exports);
  for (const key of entries) {
    const specifier = `${manifest.name}${key === '.' ? '' : key.slice(1)}`;
    try {
      // A package self-reference keeps exports visibility and browser/import conditions
      // under esbuild's resolver, including those of transitive dependencies.
      const result = await build({
        absWorkingDir: root,
        stdin: {
          contents: `import * as contract from ${JSON.stringify(specifier)}; export { contract };`,
          resolveDir: root,
          sourcefile: 'contracts-browser-entry.mjs',
          loader: 'js',
        },
        platform: 'browser',
        format: 'esm',
        bundle: true,
        write: false,
        treeShaking: false,
        // Preserve environment branches so dependencies in either mode are checked.
        define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
        metafile: true,
        logLevel: 'silent',
        logOverride: {
          'unsupported-dynamic-import': 'error',
          'unsupported-require-call': 'error',
        },
      });
      const external = Object.values(result.metafile.outputs)
        .flatMap((output) => output.imports)
        .filter((dependency) => dependency.external);
      if (external.length) {
        throw new Error(`Unresolved external runtime dependencies: ${external.map(({ path }) => path).join(', ')}`);
      }
      console.log(`Browser-safe: ${specifier}`);
    } catch (error) {
      throw new Error(`${specifier}: ${error.message}`);
    }
  }
  console.log(`Browser safety checked ${entries.length} public exports.`);
}

main().catch((error) => {
  console.error(`Contracts browser check failed: ${error.message}`);
  process.exitCode = 1;
});
