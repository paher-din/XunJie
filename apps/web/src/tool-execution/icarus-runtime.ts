import manifest from '../../../../components/alu-icarus-runtime/manifest.json'
import { createIcarusRuntime, type FixedFile } from '../../../../components/alu-icarus-runtime/index.mjs'
import { sha256 } from '../component-preparation/device'
import { acquireSlot } from './runner'

export { manifest as icarusManifest }
/** One host adapter owns these fixed ALU operations; the version stays 1 so already-published runs remain executable. */
export const aluOperationIds=['run-single','observe-enabled','check-all'] as const
export type AluOperationId=typeof aluOperationIds[number]
export const icarusProfile={adapterId:'icarus-alu',adapterVersion:1,operationIds:aluOperationIds,memoryMiB:256} as const
/** The product owns the controller code; all six executable assets are fixed, verified course resources. */
export async function verifiedIcarus(identity: string, resources: Record<string, Uint8Array>) {
  if (identity !== manifest.identity) throw new Error('unsupported-version')
  for (const [name, asset] of Object.entries(manifest.assets)) {
    const bytes = resources[name]
    if (!bytes || bytes.length !== asset.bytes || await sha256(bytes) !== asset.sha256) throw new Error('resource-corrupt')
  }
  return createIcarusRuntime({ identity, assets: manifest.assets, adapters: manifest.adapters,
    resources: Object.fromEntries(Object.keys(manifest.assets).map(name => [name, resources[name]])) })
}
/** A separate instance, Worker and resource slot: no student state or observation can be produced here. */
export async function selfCheckIcarus(identity: string, resources: Record<string, Uint8Array>, fixture: {
  path: string; top: string; expect: { result: string; carry: string }
}, timeoutMs: number) {
  const slot = await acquireSlot(1, 15000)
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const runtime = await verifiedIcarus(identity, resources)
    const bytes = resources[fixture.path]
    if (!bytes) throw new Error('resource-missing')
    const sources: FixedFile[] = [{ path: fixture.path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }]
    const compiled = await runtime.compile({ top: fixture.top, sources, entryFiles: [fixture.path] }, {signal: abort.signal, timeoutMs: Math.min(30000, timeoutMs)})
    if (compiled.status !== 'completed') throw new Error([compiled.status, ...(compiled.diagnostics ?? [])].join('\n'))
    const result = await runtime.simulate({artifact: compiled.artifact, expectedIndices:[0]}, {signal:abort.signal,timeoutMs:5000})
    if(result.status !== 'completed') throw new Error(result.status)
    const row=result.observations[0]
    if(result.observationState !== 'complete' || !row || 'invalid' in row || row.f !== fixture.expect.result
      || row.cout !== fixture.expect.carry || !result.vcd?.includes('$enddefinitions')) throw new Error('self-test-failed')
  } finally { clearTimeout(timer); slot.release() }
}
