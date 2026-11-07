import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import current from '../../../../components/alu-icarus-runtime/manifest.json'
import previous from '../../../../components/alu-icarus-runtime/versions/0.3.0/manifest.json'
import { verifiedIcarus } from './icarus-runtime'

afterEach(() => vi.unstubAllGlobals())

describe('fixed Icarus release dispatch', () => {
  it('dispatches old and new approved identities to their own retained Worker modules', async () => {
    const resources = Object.fromEntries(await Promise.all(Object.keys(current.assets).map(async name => [name,
      new Uint8Array(await readFile(new URL(`../../../../components/alu-icarus-runtime/${name}`, import.meta.url))),
    ])))
    const dispatched: Array<{ url: URL; identity: string }> = []
    vi.stubGlobal('Worker', class {
      onmessage?: (event: { data: unknown }) => void
      constructor(private readonly url: URL) {}
      postMessage(data: { bundle: { identity: string } }) {
        dispatched.push({ url: this.url, identity: data.bundle.identity })
        queueMicrotask(() => this.onmessage?.({ data: { kind: 'result', status: 'failed', stage: 'dispatch-probe', diagnostics: [] } }))
      }
      terminate() {}
    })
    for (const manifest of [previous, current]) {
      const runtime = await verifiedIcarus(manifest.identity, resources)
      await runtime.compile({ top: 'tb', sources: [{ path: 'tb.sv', content: 'module tb; endmodule' }] })
    }
    expect(dispatched.map(item => item.identity)).toEqual([previous.identity, current.identity])
    expect(dispatched[0]!.url.pathname).toContain('/versions/0.3.0/worker.mjs')
    expect(dispatched[1]!.url.pathname).toMatch(/alu-icarus-runtime\/worker.mjs$/)
    await expect(verifiedIcarus('0'.repeat(64), resources)).rejects.toThrow('unsupported-version')
    expect(dispatched).toHaveLength(2)
  })
})
