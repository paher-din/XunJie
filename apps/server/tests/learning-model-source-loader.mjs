// Exercise edited sources without rebuilding shared dist while another task owns the build.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../packages/model-gateway/package.json', import.meta.url));
const ts = require('typescript');
const root = new URL('../../../', import.meta.url);
const files = ['packages/model-gateway/src/service.ts', 'packages/model-gateway/src/paired-learning.ts', 'packages/model-gateway/src/index.ts', 'packages/model-gateway/src/selection.ts', 'packages/model-gateway/src/device-tasks.ts', 'packages/model-gateway/src/origins.ts', 'packages/model-gateway/src/session-permits.ts', 'packages/product-runtime/src/model-origin-authority.ts', 'packages/product-runtime/src/school-client.ts'];
const edited = new Map(files.map(file => [new URL(file.replace('/src/', '/dist/').replace(/\.ts$/, '.js'), root).href, new URL(file, root).href]));
registerHooks({
  resolve(specifier, context, next) {
    const candidate = specifier.startsWith('file:') ? specifier : specifier.startsWith('.') ? new URL(specifier, context.parentURL).href : null;
    if (candidate && edited.has(candidate)) return { url: edited.get(candidate), shortCircuit: true };
    const result = next(specifier, context);
    return edited.has(result.url) ? { ...result, url: edited.get(result.url) } : result;
  },
  load(url, context, next) {
    if (!files.some(file => new URL(file, root).href === url)) return next(url, context);
    // Source-relative JS siblings continue to use the unified build's unmodified dependencies.
    const source = readFileSync(new URL(url), 'utf8').replace(/from '(\.\/[^']+)\.js'/g, (_, name) => {
      const sibling = new URL(name + '.js', url.replace('/src/', '/dist/')).href;
      return `from '${sibling}'`;
    });
    return { format: 'module', source: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText, shortCircuit: true };
  },
});
