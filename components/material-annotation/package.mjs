import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentManifestSchema, componentPreparedManifestSchema } from '@xunjie/contracts/components';

/** Produce importable public teaching assets; no server, accounts or student records. */
export async function annotationPackage() {
  const bytes = await readFile(new URL('./view.html', import.meta.url));
  const manifest = componentManifestSchema.parse({ formatVersion: 1,
    componentId: '6237a554-67ee-4e74-ae33-36faf1223f12', version: 1, hostApiVersion: 1, title: '材料标注',
    entry: { resourceId: '99d9b8e1-885f-4f80-a4f3-a0b21d57843b', mediaType: 'text/html',
      sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length },
    stateVersion: 1, requiredCapabilities: ['workspace.read', 'workspace.change'],
    stateShape: { type: 'object', properties: { annotations: { type: 'array', maxItems: 100,
      items: { type: 'object', properties: { id: { type: 'string', maxLength: 36 },
        quote: { type: 'string', maxLength: 4000 }, note: { type: 'string', maxLength: 4000 } } } } } },
    initialState: { annotations: [] } });
  return { manifest, contentBase64: bytes.toString('base64') };
}

export const highlightDependencyId = 'mark-js';
/** Public sample the host drives the isolated self-test with; the expectations below are written against it, not against observed output. */
export const selfTestMaterial = { title: '自检样例材料',
  text: '观察与解释\n\n阅读材料时，先区分观察到的事实与自己的解释。\n记录问题，再寻找可以核对的依据。\n\n再次核对时，先区分观察到的事实与新的解释。' };
const annotationShape = { type: 'object', properties: { annotations: { type: 'array', maxItems: 100,
  items: { type: 'object', properties: { id: { type: 'string', maxLength: 36 },
    quote: { type: 'string', maxLength: 4000 }, note: { type: 'string', maxLength: 4000 } } } } } };

/**
 * Version 2 of the same component: identical state structure plus a locked browser dependency the view
 * really executes for source highlighting. Version 1 stays byte-identical so its digest never moves.
 */
export async function preparedAnnotationPackage() {
  const entry = await readFile(new URL('./view-v2.html', import.meta.url));
  const library = await readFile(new URL('./vendor/mark.min.js', import.meta.url));
  const manifest = componentPreparedManifestSchema.parse({ formatVersion: 2,
    componentId: '6237a554-67ee-4e74-ae33-36faf1223f12', version: 2,
    hostApiVersion: 1, preparationProtocolVersion: 1, title: '材料标注',
    entry: { resourceId: '702493fc-1bb0-4483-a695-e66694509656', mediaType: 'text/html',
      sha256: createHash('sha256').update(entry).digest('hex'), byteLength: entry.length },
    dependencies: [{ dependencyId: highlightDependencyId, package: 'mark.js', version: '8.11.1', role: 'script',
      resourceId: '0445d39b-51ce-4481-9a60-798b92d3a2e6', mediaType: 'text/javascript', loadOrder: 0,
      preparationTypes: ['browser'],
      sha256: createHash('sha256').update(library).digest('hex'), byteLength: library.length }],
    environment: { preparationType: 'browser', preparationProtocolVersion: 1, selfTestVersion: 1,
      requiredFeatures: ['message-port', 'crypto-subtle', 'indexeddb', 'sandboxed-iframe'],
      capabilityDependencies: [{ capability: 'workspace.read', dependencyIds: [] },
        { capability: 'workspace.change', dependencyIds: [] },
        { capability: 'material.highlight', dependencyIds: [highlightDependencyId] }] },
    budget: { resourceCount: 2, totalResourceBytes: 65536, messageBytes: 131072,
      preparationTimeoutMs: 60000, selfTestTimeoutMs: 30000, parallelism: 1, cacheScope: 'device-local' },
    selfTest: { selfTestVersion: 1, material: selfTestMaterial, steps: [
      { kind: 'dependency-loads', checkId: 'loads-highlight-library', dependencyIds: [highlightDependencyId],
        expect: { globalName: 'Mark' } },
      { kind: 'highlight-matches', checkId: 'highlight-chinese-sentence', quote: '阅读材料时，先区分观察到的事实与自己的解释。',
        expect: { marks: 1, markedText: '阅读材料时，先区分观察到的事实与自己的解释。' } },
      { kind: 'highlight-matches', checkId: 'highlight-repeated-phrase', quote: '先区分观察到的事实',
        expect: { marks: 2, markedText: '先区分观察到的事实' } },
      { kind: 'highlight-matches', checkId: 'highlight-across-newline', quote: '自己的解释。\n记录问题',
        expect: { marks: 1, markedText: '自己的解释。\n记录问题' } },
      { kind: 'highlight-matches', checkId: 'highlight-absent-quote', quote: '这段文字不在样例材料中',
        expect: { marks: 0, markedText: '' } },
      { kind: 'highlight-releases', checkId: 'release-restores-body', quote: '记录问题，再寻找可以核对的依据。',
        expect: { marks: 0, bodyText: selfTestMaterial.text } },
      { kind: 'annotation-roundtrip', checkId: 'annotation-temp-roundtrip', quote: '观察到的事实',
        note: '自检写入的临时笔记', expect: { annotations: 1, note: '自检写入的临时笔记' } },
      { kind: 'invalid-input-rejected', checkId: 'reject-overlong-quote', quote: '字'.repeat(4001),
        expect: { annotations: 1, rejected: true } },
      { kind: 'invalid-input-rejected', checkId: 'reject-blank-quote', quote: '   ',
        expect: { annotations: 1, rejected: true } },
    ] },
    stateVersion: 1, requiredCapabilities: ['workspace.read', 'workspace.change', 'material.highlight'],
    stateShape: annotationShape, initialState: { annotations: [] } });
  return { manifest, contentBase64: entry.toString('base64'),
    dependencies: [{ resourceId: manifest.dependencies[0].resourceId, contentBase64: library.toString('base64') }] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? 'dist/material-annotation');
  const input = await annotationPackage();
  const prepared = await preparedAnnotationPackage();
  await mkdir(resolve(out, 'vendor'), { recursive: true });
  await copyFile(new URL('./view.html', import.meta.url), resolve(out, 'view.html'));
  await copyFile(new URL('./view-v2.html', import.meta.url), resolve(out, 'view-v2.html'));
  await copyFile(new URL('./vendor/mark.min.js', import.meta.url), resolve(out, 'vendor/mark.min.js'));
  await copyFile(new URL('./vendor/LICENSE-mark.js', import.meta.url), resolve(out, 'vendor/LICENSE-mark.js'));
  await writeFile(resolve(out, 'component.json'), JSON.stringify({ requestId: '88ec2e3d-e700-413b-b757-99299a1a1224', manifest: input.manifest, path: 'view.html' }, null, 2));
  await writeFile(resolve(out, 'component-v2.json'), JSON.stringify({ requestId: 'aa411f88-a147-4afb-9f4c-7156260c3b0c',
    manifest: prepared.manifest, path: 'view-v2.html',
    dependencies: [{ dependencyId: highlightDependencyId, path: 'vendor/mark.min.js' }] }, null, 2));
  console.log(`Component import: ${resolve(out, 'component.json')}`);
  console.log(`Prepared component import: ${resolve(out, 'component-v2.json')}`);
}
