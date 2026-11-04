import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentManifestSchema } from '@xunjie/contracts/components';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cell = { type: 'number' };
const observation = { type: 'object', properties: { value: cell, total: cell, applied: cell } };

/** One importable component: an opaque view plus a product-shipped native adapter declaration. */
export async function accumulatorPackage({ version = 2 } = {}) {
  if (![1, 2].includes(version)) throw new Error('Unsupported accumulator version');
  const modern = version === 2;
  const source = await readFile(new URL(modern ? './view-v2.html' : './view.html', import.meta.url));
  const view = Buffer.from(source.toString('utf8').replaceAll('\r\n', '\n'));
  const manifest = componentManifestSchema.parse({ formatVersion: 1,
    componentId: '4d0e1c8a-7b52-4a1e-9f3c-2d6b8a0c5e71', version, hostApiVersion: 1, title: '四态累加模拟',
    entry: { resourceId: modern ? '61478492-74fc-4839-9556-e882ed94096a' : 'a3c7f2e9-58b4-4d16-8c2a-6f9e1d0b7a43', mediaType: 'text/html',
      sha256: hash(view), byteLength: view.length },
    stateVersion: 1, requiredCapabilities: modern ? ['execution.submit', 'workspace.change'] : ['execution.submit'],
    stateShape: { type: 'object', properties: modern ? { pendingInput: { type: 'string', maxLength: 16 } } : {} },
    initialState: modern ? { pendingInput: '' } : {},
    session: {
      adapterId: 'four-state-accumulator', adapterVersion: modern ? 2 : 1,
      ...(modern ? { controls: ['pause', 'resume', 'step', 'reset', 'checkpoint'], checkpointVersion: 1,
        lifecycle: { acrossViews: true, pageClose: 'continue', activityClose: 'stop', reconnect: 'query' } } : {}),
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
  await writeFile(resolve(out, 'component.json'), JSON.stringify({ requestId: '7e6b3bac-630b-4ecf-8533-16cac83e90de',
    manifest: input.manifest, path: 'view.html' }, null, 2));
  console.log(`Component import: ${resolve(out, 'component.json')}`);
}
