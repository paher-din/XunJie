import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const binary = fileURLToPath(new URL('../../node_modules/wabt/bin/wat2wasm', import.meta.url));
const source = fileURLToPath(new URL('./algorithm.wat', import.meta.url));
const target = fileURLToPath(new URL('./algorithm.wasm', import.meta.url));

/** Deterministic WAT -> WASM build with the version pinned in the root package-lock. */
async function compile(output) {
  await run(process.execPath, [binary, source, '-o', output]);
  return readFile(output);
}
const committed = await readFile(target).catch(() => null);
if (process.argv.includes('--check')) {
  const directory = await mkdtemp(join(tmpdir(), 'xunjie-wasm-'));
  try {
    const built = await compile(join(directory, 'algorithm.wasm'));
    if (!committed || !built.equals(committed)) {
      console.error('algorithm.wasm 与 algorithm.wat 不一致：请运行 node components/table-aggregation/build.mjs');
      process.exitCode = 1;
    } else console.log(`algorithm.wasm 与源码一致（${committed.length} 字节）`);
  } finally { await rm(directory, { recursive: true, force: true }); }
} else {
  const built = await compile(target);
  console.log(`algorithm.wasm 已生成（${built.length} 字节）`);
}
