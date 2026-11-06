import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { aggregationPackage } from '../../../../components/table-aggregation/package.mjs';

/** Execute the production browser algorithm and published Wasm; callers control only result delivery. */
export async function runPublishedAggregation(action, manifest) {
  const ts = await import('../../../../packages/learning-space/node_modules/typescript/lib/typescript.js');
  const source = await readFile(new URL('../../../web/src/tool-execution/algorithm.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const algorithm = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const published = await aggregationPackage();
  const computed = algorithm.runAggregation({ ...algorithm.jobFromAction(action, action.execution.limits),
    bytes: Buffer.from(published.algorithmBase64, 'base64'), memoryPages: manifest.algorithm.memoryPages, entry: manifest.algorithm.entry });
  const bytes = Buffer.from(computed.artifact.text);
  return { computed, resultInput: { contentId: randomUUID(), output: computed.result, text: computed.artifact.text,
    name: computed.artifact.name, mediaType: computed.artifact.mediaType,
    sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length } };
}
