// Source-only cleanup verification; leave the shared unified build untouched.
import './learning-model-source-loader.mjs';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../../../packages/learning-space/package.json', import.meta.url));
const ts = require('typescript');
const directory = new URL('../../../packages/learning-space/', import.meta.url);
const edits = new Map(['checks', 'origins', 'device-choices', 'chat-work', 'paired-grants', 'wire'].map(name => [new URL(`dist/model-connections/${name}.js`, directory).href, new URL(`src/model-connections/${name}.ts`, directory).href]));
registerHooks({
  resolve(specifier, context, next) {
    const url = specifier.startsWith('file:') ? specifier : specifier.startsWith('.') ? new URL(specifier, context.parentURL).href : null;
    if (url && edits.has(url)) return { url: edits.get(url), shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (![...edits.values()].includes(url)) return next(url, context);
    const source = readFileSync(new URL(url), 'utf8').replace(/from '(\.\/[^']+)\.js'/g, (_, name) => `from '${new URL(name + '.js', url.replace('/src/', '/dist/')).href}'`);
    return { format: 'module', source: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText, shortCircuit: true };
  },
});
