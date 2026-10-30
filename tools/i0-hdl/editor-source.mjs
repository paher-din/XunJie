// Preserve relative runner/backend imports and materialize browser-safe public exports.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function editorSourceFiles(staging) {
  const files = new Map();
  const copy = (directory, destination) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', 'test', 'tests', '__tests__', 'fixtures', '__fixtures__'].includes(entry.name)
        || /\.(?:test|spec)\./.test(entry.name)) continue;
      const source = join(directory, entry.name), target = destination + '/' + entry.name;
      if (entry.isDirectory()) copy(source, target);
      else if (entry.isFile()) files.set(target, readFileSync(source));
      else throw new Error('EDITOR_SOURCE_REGULAR_FILES_REQUIRED');
    }
  };
  for (const name of ['editor-diagnostics.ts', 'editor-diagnostics-service.ts', 'editor-diagnostics-entry.ts', 'docker.ts', 'snapshot.ts', 'node-files.ts']) {
    files.set('runner/' + name, readFileSync(join(staging, 'runner', name)));
  }
  copy(join(staging, 'contracts/internal'), 'contracts/internal');
  copy(join(staging, 'contracts/runner'), 'contracts/runner');
  files.set('contracts/workspace/editor-diagnostics.ts', readFileSync(join(staging, 'contracts/workspace/editor-diagnostics.ts')));
  const copied = new Set();
  const copyPackage = (name, loader) => {
    if (copied.has(name)) return;
    copied.add(name);
    // Public exports intentionally have no CommonJS condition; locate the installed manifest.
    const manifestFile = loader.resolve.paths(name).map(root => join(root, name, 'package.json')).find(existsSync);
    if (!manifestFile) throw new Error('EDITOR_PUBLIC_PACKAGE_REQUIRED');
    const directory = dirname(realpathSync(manifestFile));
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (manifest.name !== name) throw new Error('EDITOR_PUBLIC_PACKAGE_REQUIRED');
    if (name === '@xunjie/contracts') {
      files.set('node_modules/' + name + '/package.json', readFileSync(manifestFile));
      copy(join(directory, 'dist'), 'node_modules/' + name + '/dist');
    } else copy(directory, 'node_modules/' + name);
    const requireFromPackage = createRequire(join(directory, 'package.json'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copyPackage(dependency, requireFromPackage);
  };
  copyPackage('@xunjie/contracts', createRequire(join(staging, 'package.json')));
  return files;
}
