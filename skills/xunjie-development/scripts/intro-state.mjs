#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This receipt records a delivered explanation, never environment readiness.
const SCHEMA = 'xunjie-development/intro-v1';

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!['status', 'mark-shown'].includes(action) || args.length && (args.length !== 2 || args[0] !== '--worktree' || !args[1])) {
    throw new Error('INTRO_ARGUMENTS_INVALID');
  }
  const git = (...flags) => execFileSync('git', ['-C', resolve(args[1] ?? process.cwd()), ...flags],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const worktree = realpathSync(git('rev-parse', '--show-toplevel'));
  const common = realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/xj-dev/src');
  const modules = existsSync(join(source, 'paths.mjs')) ? source : join(worktree, 'tools/xj-dev/src');
  const { toolHome } = await import(pathToFileURL(join(modules, 'paths.mjs')));
  const { ensurePrivateDirectory, privateJson, writePrivateJson } = await import(pathToFileURL(join(modules, 'enrollment-protocol.mjs')));
  const home = toolHome();
  // Reject a home inside any checkout before creating user state.
  let ancestor = home;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const probe = spawnSync('git', ['-C', realpathSync(ancestor), 'rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (probe.status === 0 && probe.stdout.trim().split(/\s+/).includes('true')) throw new Error('INTRO_HOME_MUST_BE_OUTSIDE_GIT');
  const directory = join(home, 'onboarding');
  const file = join(directory, createHash('sha256').update(common).digest('hex') + '.json');
  let receipt;
  try {
    const folder = lstatSync(directory);
    if (folder.isSymbolicLink() || !folder.isDirectory()) throw new Error('INTRO_DIRECTORY_INVALID');
    // lstat also catches a dangling symlink, which existsSync would miss.
    lstatSync(file);
    receipt = privateJson(file);
    if (Object.keys(receipt).sort().join(',') !== 'schema,shownAt' || receipt.schema !== SCHEMA
      || typeof receipt.shownAt !== 'string' || !Number.isFinite(Date.parse(receipt.shownAt))) {
      throw new Error('INTRO_RECEIPT_INVALID');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (action === 'mark-shown' && !receipt) {
    ensurePrivateDirectory(directory);
    receipt = { schema: SCHEMA, shownAt: new Date().toISOString() };
    writePrivateJson(file, receipt);
  }
  return { ok: true, introShown: Boolean(receipt), ...(receipt ? { shownAt: receipt.shownAt } : {}),
    markerFile: file, readiness: 'not-checked' };
}

try {
  process.stdout.write(JSON.stringify(await main()) + '\n');
} catch (error) {
  // Avoid leaking arbitrary filesystem contents or upstream command output.
  const code = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : error.code ?? 'INTRO_STATE_FAILED';
  process.stdout.write(JSON.stringify({ ok: false, code, readiness: 'not-checked' }) + '\n');
  process.exitCode = 1;
}
