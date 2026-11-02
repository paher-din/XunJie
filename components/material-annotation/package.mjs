import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentManifestSchema } from '@xunjie/contracts/components';

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
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? 'dist/material-annotation');
  const input = await annotationPackage();
  await mkdir(out, { recursive: true });
  await copyFile(new URL('./view.html', import.meta.url), resolve(out, 'view.html'));
  await writeFile(resolve(out, 'component.json'), JSON.stringify({ requestId: '88ec2e3d-e700-413b-b757-99299a1a1224', manifest: input.manifest, path: 'view.html' }, null, 2));
  console.log(`Component import: ${resolve(out, 'component.json')}`);
}
