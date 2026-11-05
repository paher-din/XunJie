import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireSlot } from './runner'

/** The real API resolves a request only once its callback settles, which is what admission must handle. */
function locksApi() {
  const held = new Set<string>()
  return { held, locks: { request(name: string, options: { ifAvailable?: boolean } | undefined,
    callback: (lock: { name: string } | null) => unknown) {
    if (options?.ifAvailable && held.has(name)) return Promise.resolve(callback(null))
    held.add(name)
    return Promise.resolve(callback({ name })).finally(() => { held.delete(name) })
  } } }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('browser execution admission', () => {
  it('admits a run without waiting for its own slot to be released', async () => {
    const api = locksApi()
    vi.stubGlobal('navigator', { locks: api.locks })
    const slot = await acquireSlot(1, 1000)
    // The slot is really held: a different label cannot take the same origin-wide maximum.
    expect(api.held.has('xunjie-execution-slot:0')).toBe(true)
    slot.release()
    await Promise.resolve()
    expect(api.held.has('xunjie-execution-slot:0')).toBe(false)
  })
  it('keeps the declared maximum of concurrent runs and frees a slot for the next one', async () => {
    const api = locksApi()
    vi.stubGlobal('navigator', { locks: api.locks })
    const first = await acquireSlot(2, 1000)
    const second = await acquireSlot(2, 1000)
    expect([...api.held].sort()).toEqual(['xunjie-execution-slot:0', 'xunjie-execution-slot:1'])
    await expect(acquireSlot(2, 150)).rejects.toThrow(/并行计算/)
    first.release(); await Promise.resolve()
    const next = await acquireSlot(2, 1000)
    expect(api.held.has('xunjie-execution-slot:0')).toBe(true)
    second.release(); next.release()
  })
  it('keeps the declared maximum inside the page when the browser exposes no lock manager', async () => {
    vi.stubGlobal('navigator', {})
    const first = await acquireSlot(1, 10)
    // Cross-tab admission needs Web Locks; the page still refuses to exceed its own maximum.
    await expect(acquireSlot(1, 150)).rejects.toThrow(/并行计算/)
    first.release()
    const next = await acquireSlot(1, 50)
    expect(() => next.release()).not.toThrow()
  })
})
