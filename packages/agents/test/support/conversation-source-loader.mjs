// Verify bounded source edits without emitting into the shared dist directories.
import { registerHooks } from 'node:module';
const root = new URL('../../../../', import.meta.url);
const modules = new Map([
  ...['conversation/index', 'conversation/basis', 'conversation/images', 'conversation/capabilities', 'workspace-assistant/index', 'workspace-assistant/tools/module',
    'capabilities/documents/index', 'capabilities/tool-discovery/tool-results', 'transport/session-dependencies'].map(name => ['agents', name]),
  ['contracts', 'agent-dependencies'],
].map(([pkg, name]) => [new URL(`packages/${pkg}/dist/${name}.js`, root).href, new URL(`packages/${pkg}/src/${name}.ts`, root).href]));
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/src/') && specifier.endsWith('.js')) {
    const url = new URL(specifier, context.parentURL.replace('/src/', '/dist/')).href;
    return next(modules.get(url) ?? url, context);
  }
  const resolved = next(specifier, context);
  return modules.has(resolved.url) ? { url: modules.get(resolved.url), shortCircuit: true } : resolved;
} });
