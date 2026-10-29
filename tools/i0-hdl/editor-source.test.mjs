import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { editorSourceFiles } from './editor-source.mjs';

test('isolated editor source loads internal errors and compiled public validation without workspace ancestry', t => {
  const target = mkdtempSync(join(tmpdir(), 'xj-editor-source-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  for (const [path, bytes] of editorSourceFiles(resolve(import.meta.dirname, '../../apps/server'))) {
    const file = join(target, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { RunnerError, validatePath } from './runner/snapshot.ts';
    import { editorDiagnosticsInput } from './contracts/workspace/editor-diagnostics.ts';
    validatePath('main.c');
    console.log(JSON.stringify([new RunnerError('INVALID_SNAPSHOT', 'invalid fixture').code, editorDiagnosticsInput.safeParse({}).success]));
  `], { cwd: target, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), ['INVALID_SNAPSHOT', false]);
});
