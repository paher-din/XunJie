import type { ExecutionDevice } from '@xunjie/contracts/execution'

/**
 * Real probes of this page. They answer only what a page can answer: whether the browser can run a
 * restricted job at all. `platform` and `native` stay `null` because a browser cannot attest its own
 * CPU architecture and this page has asked no local runtime anything, and a null fact is never
 * treated as "unsupported" by the placement rule.
 */
const probes = {
  worker: () => typeof Worker === 'function',
  webassembly: () => typeof WebAssembly === 'object' && WebAssembly !== null
    && typeof WebAssembly.instantiate === 'function',
  sandboxedFrame: () => typeof document !== 'undefined' && 'sandbox' in document.createElement('iframe'),
} as const

export function observeExecutionDevice(): ExecutionDevice {
  return { platform: null,
    browser: { worker: probes.worker(), webassembly: probes.webassembly(), sandboxedFrame: probes.sandboxedFrame() },
    native: null }
}
