import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentManifestSchema } from '@xunjie/contracts/components';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cell = { type: 'number' };
const observation = { type: 'object', properties: { value: cell, total: cell, applied: cell } };

/** One importable component: an opaque view plus a product-shipped native adapter declaration. */
export async function accumulatorPackage() {
  const source = await readFile(new URL('./view.html', import.meta.url));
  const view = Buffer.from(source.toString('utf8').replaceAll('\r\n', '\n'));
  const manifest = componentManifestSchema.parse({ formatVersion: 1,
    componentId: '4d0e1c8a-7b52-4a1e-9f3c-2d6b8a0c5e71', version: 1, hostApiVersion: 1, title: '四态累加模拟',
    entry: { resourceId: 'a3c7f2e9-58b4-4d16-8c2a-6f9e1d0b7a43', mediaType: 'text/html',
      sha256: hash(view), byteLength: view.length },
    stateVersion: 1, requiredCapabilities: ['execution.submit'],
    stateShape: { type: 'object', properties: {} },
    initialState: {},
    session: {
      adapterId: 'four-state-accumulator', adapterVersion: 1,
      parameters: { type: 'object', properties: {} },
      operation: {
        operationId: 'advance',
        parameters: { type: 'object', properties: { value: cell } },
        result: observation,
      },
      budgets: { operationTimeoutMs: 5000, idleMs: 600000, maxMs: 3600000, memoryMiB: 64,
        inputBytes: 1024, outputBytes: 65536, concurrentSessions: 2, queuedSessions: 0 },
    } });
  return { manifest, contentBase64: view.toString('base64') };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? 'dist/state-accumulator');
  const input = await accumulatorPackage();
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, 'view.html'), Buffer.from(input.contentBase64, 'base64'));
  await writeFile(resolve(out, 'component.json'), JSON.stringify({ requestId: '0f5a1e8c-3d74-4b92-8a61-5c2f9e7d0b34',
    manifest: input.manifest, path: 'view.html' }, null, 2));
  console.log(`Component import: ${resolve(out, 'component.json')}`);
}
