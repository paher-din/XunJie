import { copyFileSync, existsSync, globSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function workspaces(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const patterns = manifest.workspaces?.packages ?? manifest.workspaces ?? [];
  return globSync(patterns.map(path => path + '/package.json'), { cwd: root }).map(path => ({
    path, root: dirname(resolve(root, path)), name: JSON.parse(readFileSync(join(root, path), 'utf8')).name,
  }));
}

// Share installed external packages without writing to them. The directories,
// install marker and command shims belong to the acceptance checkout; workspace
// links must resolve its own source/build outputs, including from nested installs.
export function reuseWorkspaceDependencies(source, target) {
  source = resolve(source); target = resolve(target);
  const originals = workspaces(source), locals = workspaces(target);
  const byName = new Map(locals.map(item => [item.name, item.root]));
  const originalByName = new Map(), roots = [];
  for (const item of originals) {
    const installed = join(source, 'node_modules', item.name);
    const installedRoot = existsSync(installed) ? realpathSync(installed) : item.root;
    roots.push({ source: realpathSync(item.root), target: byName.get(item.name) },
      { source: installedRoot, target: byName.get(item.name) });
    originalByName.set(item.name, existsSync(join(item.root, 'node_modules')) ? item.root : installedRoot);
  }
  function relocate(path) {
    for (const item of roots) {
      const suffix = relative(item.source, path);
      if (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep)) {
        // Nested installed packages remain external, even below a workspace.
        if (suffix.split(sep).includes('node_modules')) continue;
        return { workspace: true, path: item.target && join(item.target, suffix) };
      }
    }
    return { workspace: false, path };
  }
  function link(path, destination, directory) {
    symlinkSync(path, destination, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
  }
  function dependencies(from, to) {
    mkdirSync(to);
    for (const name of readdirSync(from)) {
      const path = join(from, name), destination = join(to, name), stat = lstatSync(path);
      if (name === '.bin' || name.startsWith('@') && stat.isDirectory()) {
        dependencies(path, destination);
      } else if (stat.isFile()) {
        copyFileSync(path, destination);
      } else {
        const actual = realpathSync(path);
        const relocated = relocate(actual);
        if (relocated.workspace) {
          if (relocated.path) link(relocated.path, destination, !lstatSync(actual).isFile());
        } else link(actual, destination, !lstatSync(actual).isFile());
      }
    }
  }
  dependencies(join(source, 'node_modules'), join(target, 'node_modules'));
  for (const item of locals) {
    const from = join(originalByName.get(item.name) ?? resolve(source, relative(target, item.root)), 'node_modules');
    if (existsSync(from)) dependencies(from, join(item.root, 'node_modules'));
    const destination = join(target, 'node_modules', item.name);
    if (!existsSync(destination)) {
      mkdirSync(dirname(destination), { recursive: true });
      link(item.root, destination, true);
    }
  }
  for (const path of ['package.json', 'package-lock.json', ...locals.map(item => item.path)]) {
    utimesSync(join(target, path), new Date(0), new Date(0));
  }
}

// Remove owned directories and their links before Git removes a fixture worktree.
// rmSync unlinks package symlinks/junctions without traversing their shared owners.
export function removeWorkspaceDependencies(target) {
  const locals = existsSync(join(target, 'package.json')) ? workspaces(target) : [];
  for (const root of [target, ...locals.map(item => item.root)]) {
    rmSync(join(root, 'node_modules'), { recursive: true, force: true, maxRetries: 3 });
  }
}

// Dev hosts consume storage/learning-space exports as well as contracts. Build
// those outputs from this fixture's source through the shared content cache.
export async function prepareWorkspaceOutputs(target) {
  const { ensureBuild } = await import('../../../scripts/build.mjs');
  await ensureBuild('learning-space', { root: resolve(target), log: () => {} });
}
