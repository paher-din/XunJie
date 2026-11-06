// Refresh only the adapter of an existing source-reproducible toolchain candidate.
// The six compiler/runtime assets must still match the recorded clean builds.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { adapterNames, bundleIdentity } from './runtime/identity.mjs';
const root = new URL('../../components/alu-icarus-runtime/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const hash = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
for (const [name, expected] of Object.entries(manifest.assets)) {
  if (JSON.stringify(hash(await readFile(new URL(name, root)))) !== JSON.stringify(expected)) throw new Error(`Toolchain changed: ${name}`);
}
for (const name of adapterNames) {
  await copyFile(new URL(`runtime/${name}`, import.meta.url), new URL(name, root));
  manifest.files[name] = hash(await readFile(new URL(name, root)));
}
manifest.adapters = Object.fromEntries(adapterNames.map(name => [name, manifest.files[name]]));
manifest.version = '0.3.0';
manifest.identity = await bundleIdentity(manifest.assets, manifest.adapters);
manifest.scope = 'Fixed resources and verified-byte loader; product and platform acceptance recorded separately.';
await writeFile(new URL('manifest.json', root), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ version: manifest.version, identity: manifest.identity }));
