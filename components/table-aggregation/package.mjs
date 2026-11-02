import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentManifestSchema } from '@xunjie/contracts/components';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** 12 rows students can edit; every value is numeric so the first run is a real one. */
export const sampleTable = { columns: ['姓名', '小组', '得分'], rows: [
  ['林一', 'A', '88'], ['周舟', 'A', '92'], ['方晓', 'A', '79'], ['林禾', 'A', '73'],
  ['许宁', 'B', '75'], ['陈禾', 'B', '81'], ['黎舟', 'B', '88'], ['周宁', 'B', '90'],
  ['苏远', 'C', '67'], ['何清', 'C', '95'], ['许多', 'C', '84'], ['苏清', 'C', '88'],
] };
const cell = { type: 'string', maxLength: 40 };
const stateShape = { type: 'object', properties: {
  table: { type: 'object', properties: {
    columns: { type: 'array', maxItems: 12, items: cell },
    rows: { type: 'array', maxItems: 1000, items: { type: 'array', maxItems: 12, items: cell } } } },
  parameters: { type: 'object', properties: {
    groupColumn: cell, valueColumn: cell, aggregate: { type: 'string', maxLength: 8 } } } } };
const group = { type: 'object', properties: { key: cell, count: { type: 'number' }, value: { type: 'number' },
  sum: { type: 'number' }, mean: { type: 'number' }, min: { type: 'number' }, max: { type: 'number' } } };

/** Public teaching assets for one importable component: no server, accounts or student records. */
export async function aggregationPackage() {
  const [view, wasm] = await Promise.all([readFile(new URL('./view.html', import.meta.url)),
    readFile(new URL('./algorithm.wasm', import.meta.url))]);
  const manifest = componentManifestSchema.parse({ formatVersion: 1,
    componentId: '1d92f3c5-6a44-4f0a-9d2c-3b7e5a0c8f61', version: 1, hostApiVersion: 1, title: '表格聚合',
    entry: { resourceId: '5f0c7a21-9d38-4b6e-8c15-2a4d7e91b0f6', mediaType: 'text/html',
      sha256: hash(view), byteLength: view.length },
    stateVersion: 1, requiredCapabilities: ['workspace.read', 'workspace.change', 'execution.submit'],
    stateShape,
    initialState: { table: sampleTable, parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } },
    algorithm: { resource: { resourceId: 'b3a1e8d0-4c27-4a59-9f63-8d2b6c04e1a7', mediaType: 'application/wasm',
      sha256: hash(wasm), byteLength: wasm.length }, mediaType: 'application/wasm', entry: 'aggregate', memoryPages: 256 },
    operations: [{ operationId: 'aggregate', effect: 'execute',
      parameters: { type: 'object', properties: { groupColumn: cell, valueColumn: cell, aggregate: { type: 'string', maxLength: 8 } } },
      result: { type: 'object', properties: { rows: { type: 'number' }, aggregate: { type: 'string', maxLength: 8 },
        groupColumn: cell, valueColumn: cell, groups: { type: 'array', maxItems: 200, items: group },
        value: { type: 'number' }, rejected: { type: 'array', maxItems: 8, items: { type: 'number' } } } },
      budgets: { timeMs: 5000, outputBytes: 65536 } }] });
  return { manifest, contentBase64: view.toString('base64'), algorithmBase64: wasm.toString('base64') };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? 'dist/table-aggregation');
  const input = await aggregationPackage();
  await mkdir(out, { recursive: true });
  await copyFile(new URL('./view.html', import.meta.url), resolve(out, 'view.html'));
  await copyFile(new URL('./algorithm.wasm', import.meta.url), resolve(out, 'algorithm.wasm'));
  await writeFile(resolve(out, 'component.json'), JSON.stringify({ requestId: 'c4f7d291-58ba-4e03-9a76-1d0e5b83ca24',
    manifest: input.manifest, path: 'view.html', algorithm: { path: 'algorithm.wasm' } }, null, 2));
  console.log(`Component import: ${resolve(out, 'component.json')}`);
}
