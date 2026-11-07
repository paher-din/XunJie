export const resourceNames = Object.freeze(['ivl.js', 'ivl.wasm', 'ivlpp.js', 'ivlpp.wasm', 'vvp.js', 'vvp.wasm']);
export const adapterNames = Object.freeze(['index.mjs', 'worker.mjs', 'identity.mjs', 'index.d.mts']);
export const compilerConfiguration = Object.freeze({ pipelineVersion: 1, generations: Object.freeze(['2012', 'no-specify']),
  iwidth: 32, widthcap: 65536, functors: Object.freeze(['cprop', 'nodangle']), target: 'vvp.tgt', systemModule: 'system.vpi' });
export const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
export async function bundleIdentity(assets, adapters) {
  if (!assets || Object.keys(assets).length !== resourceNames.length || !adapters || Object.keys(adapters).length !== adapterNames.length) throw new Error('Expected fixed runtime and adapter assets');
  const canonical = [...resourceNames.map(name => [name, assets[name]]), ...adapterNames.map(name => [name, adapters[name]])].map(([name, asset]) => {
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 16 * 1024 * 1024) throw new Error('Invalid asset manifest');
    return [name, asset.sha256, asset.bytes];
  });
  return sha256(new TextEncoder().encode(JSON.stringify(canonical)));
}
export function dependencyIdentity(bundle, task) {
  return sha256(new TextEncoder().encode(JSON.stringify({ version: 1, configuration: compilerConfiguration, bundle, sources: task.sources, top: task.top,
    entryFiles: task.entryFiles ?? (Array.isArray(task.sources) ? task.sources.filter(file => /\.(sv|v)$/.test(file?.path)).map(file => file.path) : []),
    options: { includeDirs: task.options?.includeDirs ?? [], strictExprWidth: task.options?.strictExprWidth === true } })));
}
