// Refresh only the adapter of an existing source-reproducible toolchain candidate.
// The six compiler/runtime assets must still match the recorded clean builds.
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { adapterNames, bundleIdentity } from './runtime/identity.mjs';
const root = new URL('../../components/alu-icarus-runtime/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('usage: node refresh-adapter.mjs <new-version>');
const hash = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
for (const [name, expected] of Object.entries(manifest.assets)) {
  if (JSON.stringify(hash(await readFile(new URL(name, root)))) !== JSON.stringify(expected)) throw new Error(`Toolchain changed: ${name}`);
}
const adapters = {};
for (const name of adapterNames) adapters[name] = hash(await readFile(new URL(`runtime/${name}`, import.meta.url)));
const nextIdentity = await bundleIdentity(manifest.assets, adapters);
if (nextIdentity !== manifest.identity) {
  if (version === manifest.version) throw new Error('Changed adapter bytes require a new release version');
  // Keep the complete immutable old package. Existing activities retain its identity
  // and must dispatch its original Worker, even after new courses use this release.
  const previous = new URL(`versions/${manifest.version}/`, root);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL(name, root));
    if (JSON.stringify(hash(bytes)) !== JSON.stringify(expected)) throw new Error(`Previous release changed: ${name}`);
    const destination = new URL(name, previous);
    await mkdir(new URL('.', destination), { recursive: true });
    try { await writeFile(destination, bytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST' || !bytes.equals(await readFile(destination))) throw error;
    }
  }
  const original = await readFile(new URL('manifest.json', root));
  try { await writeFile(new URL('manifest.json', previous), original, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || !original.equals(await readFile(new URL('manifest.json', previous)))) throw error;
  }
} else if (version !== manifest.version) throw new Error('Unchanged adapter bytes keep their release version');
for (const name of adapterNames) {
  await copyFile(new URL(`runtime/${name}`, import.meta.url), new URL(name, root));
  manifest.files[name] = hash(await readFile(new URL(name, root)));
}
manifest.adapters = Object.fromEntries(adapterNames.map(name => [name, manifest.files[name]]));
manifest.version = version;
manifest.identity = nextIdentity;
manifest.scope = 'Fixed resources and verified-byte loader; product and platform acceptance recorded separately.';
await writeFile(new URL('manifest.json', root), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ version: manifest.version, identity: manifest.identity }));
