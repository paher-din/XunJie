import { globSync, readFileSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

// Reuse a prepared graph without allowing an acceptance checkout to reinstall its owner.
export function reuseWorkspaceDependencies(source, target) {
  symlinkSync(join(source, 'node_modules'), join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  const patterns = manifest.workspaces?.packages ?? manifest.workspaces;
  for (const path of ['package.json', 'package-lock.json', ...globSync(patterns.map(path => path + '/package.json'), { cwd: target })]) {
    utimesSync(join(target, path), new Date(0), new Date(0));
  }
}
