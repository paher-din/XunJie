import { lstat, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export async function cleanVerification({ root, keep = [], dryRun = false }) {
  const directory = join(resolve(root), '.verification');
  const retained = [...new Set(keep.map(value => {
    const parts = value.replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
    if (isAbsolute(value) || win32.isAbsolute(value) || !parts.length || parts.includes('..')) {
      throw new Error('--keep requires a path inside .verification');
    }
    return parts.join(sep);
  }))];
  const result = { dryRun, removedEntries: 0, kept: retained };
  let stat;
  try { stat = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return result; throw error; }

  // Validate every selection before deleting anything. Never traverse a link.
  for (const selected of retained) {
    let parent = directory;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Cannot retain paths through a directory link');
    const parts = selected.split(sep);
    for (const [index, part] of parts.entries()) {
      if (!(await readdir(parent)).includes(part)) throw new Error(`Keep path does not exist: ${selected}`);
      parent = join(parent, part);
      const entry = await lstat(parent);
      if (index < parts.length - 1 && (!entry.isDirectory() || entry.isSymbolicLink())) {
        throw new Error(`Keep path traverses a file or link: ${selected}`);
      }
    }
  }

  async function clean(path, relative) {
    if (retained.some(selected => relative === selected || relative.startsWith(selected + sep))) return;
    if (!retained.some(selected => !relative || selected.startsWith(relative + sep))) {
      result.removedEntries++;
      if (!dryRun) await rm(path, { recursive: true, force: true });
      return;
    }
    for (const name of await readdir(path)) await clean(join(path, name), relative ? join(relative, name) : name);
  }
  await clean(directory, '');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      keep: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) console.log('Usage: npm run clean:verification [-- --keep RELATIVE_PATH] [--dry-run]\nClears .verification; repeat --keep for results with a known next use. Never follows links.');
    else {
      const result = await cleanVerification({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        keep: values.keep, dryRun: values['dry-run'] });
      console.log(`verification cleanup: ${result.dryRun ? 'would remove' : 'removed'} ${result.removedEntries} entries; kept ${result.kept.length} selected paths.`);
    }
  } catch (error) {
    console.error(`verification cleanup: ${error.message}`);
    process.exitCode = 1;
  }
}
