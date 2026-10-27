// Build public composition imports against the fixed source checkout, not moving npm releases.
// Usage: node build.mjs <upstream-source> <isolated-consumer>
import { readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
const [source, consumer] = await Promise.all(process.argv.slice(2).map(p => realpath(resolve(p))));
const { build } = await import(pathToFileURL(join(consumer, 'node_modules/esbuild/lib/main.js')));
const here = dirname(fileURLToPath(import.meta.url));
const config = await readFile(join(source, 'tsconfig.base.json'), 'utf8');
const aliases = new Map([...config.matchAll(/"(@deepseek-ai\/[^"*]+)":\s*\["([^"*]+)"\]/g)]
  .map(m => [m[1], resolve(source, m[2])]));
// Native loader/prebuilt is an external dependency; no stubbed locking or persistence.
const plugin = { name: 'fixed-source-public-entries', setup(b) {
  b.onResolve({ filter: /^@deepseek-ai\// }, async args => {
    if (args.path.startsWith('@deepseek-ai/node-addon-system')) return { path: args.path, external: true };
    let path = aliases.get(args.path);
    if (!path) throw new Error(`No fixed-source entry for ${args.path}`);
    if ((await stat(path)).isDirectory()) path = join(path, 'index.ts');
    return { path };
  });
} };
const sourceInputs = new Set();
for (const [entry, outfile, format] of [
  [join(here, 'probe.mjs'), 'probe.mjs', 'esm'],
  [join(source, 'packages/session/session-persistence-jsonl/src/worker.ts'), 'worker.mjs', 'esm'],
]) {
  const result = await build({ entryPoints: [entry], outfile: join(consumer, outfile),
    bundle: true, platform: 'node', target: 'node24', format, packages: 'external',
    plugins: [plugin], tsconfig: join(source, 'tsconfig.base.json'), metafile: true });
  await writeFile(join(consumer, `${outfile}.meta.json`), JSON.stringify(result.metafile, null, 2));
  for (const input of Object.keys(result.metafile.inputs)) sourceInputs.add(resolve(input));
  console.log(JSON.stringify({ outfile, sourceInputs: Object.keys(result.metafile.inputs).length,
    external: [...new Set(Object.values(result.metafile.outputs).flatMap(x => x.imports.filter(i => i.external).map(i => i.path)))] }));
}
// JSONL locates worker.cjs beside the bundle. Preserve ESM import.meta in source dependencies.
await writeFile(join(consumer, 'worker.cjs'), "import('./worker.mjs').catch(error => { console.error(error); process.exitCode = 1; });\n");
await writeFile(join(consumer, 'build-inputs.json'), JSON.stringify(await Promise.all([...sourceInputs].sort().map(async path => ({
  path: path.startsWith(source + '/') ? relative(source, path) : `probe/${path.split('/').at(-1)}`,
  sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
}))), null, 2) + '\n');
