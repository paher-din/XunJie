import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentManifestSchema } from '@xunjie/contracts/components';
import { build } from 'esbuild';
let protocol;

/** Produce importable public teaching assets; no server, accounts or student records. */
export async function annotationPackage() {
  protocol ??= build({ stdin: { contents: "export { componentHostMessageSchema, componentRequestSchema } from '@xunjie/contracts/components';",
    resolveDir: dirname(fileURLToPath(import.meta.url)) }, bundle: true, write: false, format: 'iife', globalName: 'XunJieComponentProtocol',
    platform: 'browser', target: 'es2022', minify: true, legalComments: 'none' });
  const runtime = (await protocol).outputFiles[0].text.replaceAll('</script', '<\\/script');
  const source = await readFile(new URL('./view.html', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../shared/host.css', import.meta.url), 'utf8');
  const bytes = Buffer.from(source.replace('/* xunjie-host-styles */', () => styles).replace('<!-- xunjie-contracts -->', () => `<script>${runtime}</script>`));
  const manifest = componentManifestSchema.parse({ formatVersion: 1,
    componentId: '6237a554-67ee-4e74-ae33-36faf1223f12', version: 2, hostApiVersion: 1, title: '材料标注',
    entry: { resourceId: '5c1960f3-e2ca-4c5b-baa8-c99a61cf56a7', mediaType: 'text/html',
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
  await writeFile(resolve(out, 'view.html'), Buffer.from(input.contentBase64, 'base64'));
  await writeFile(resolve(out, 'component.json'), JSON.stringify({ requestId: '690d56f5-413e-45ee-aac6-8cd9bbf56dab', manifest: input.manifest, path: 'view.html' }, null, 2));
  console.log(`Component import: ${resolve(out, 'component.json')}`);
}
