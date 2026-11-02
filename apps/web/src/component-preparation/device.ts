import type { PreparationDevice } from '@xunjie/contracts/components'

/** Bumped when the preparation implementation changes behaviour; invalidates cached check results. */
export const preparationImplementationVersion = 1
export const hostVersion = '1'

const probes = {
  'message-port': () => typeof MessageChannel === 'function',
  'crypto-subtle': () => typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function',
  'indexeddb': () => typeof indexedDB !== 'undefined',
  'sandboxed-iframe': () => typeof document !== 'undefined' && 'sandbox' in document.createElement('iframe'),
} as const
export type PreparationFeature = keyof typeof probes

/**
 * Real probes of this browser, not a security proof: user-agent strings are self-reported and only recorded
 * as diagnostics. Nothing unrelated to preparation is collected.
 */
export type PreparationDeviceProbe = () => PreparationDevice
export function detectDevice(): PreparationDevice {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const chrome = /Chrome\/([0-9.]+)/.exec(agent)
  const firefox = /Firefox\/([0-9.]+)/.exec(agent)
  const safari = /Version\/([0-9.]+)[\w.]*\s+Safari/.exec(agent)
  return { platform: String(navigator.platform ?? 'unknown').slice(0, 64),
    browser: chrome ? 'chrome' : firefox ? 'firefox' : safari ? 'safari' : 'unknown',
    browserVersion: (chrome?.[1] ?? firefox?.[1] ?? safari?.[1] ?? '').slice(0, 64),
    features: (Object.keys(probes) as PreparationFeature[]).filter(name => probes[name]()),
    preparationImplementationVersion }
}

export function missingFeatures(device: PreparationDevice, required: readonly string[]) {
  return required.filter(name => !device.features.includes(name))
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]))
    : value

export async function fingerprint(value: unknown): Promise<string> {
  return sha256(new TextEncoder().encode(JSON.stringify(canonical(value))))
}

/** Base64 round-trips through the same decode the component uses, so both sides see identical bytes. */
export function decodeBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), value => value.charCodeAt(0))
}

export function encodeBase64(bytes: Uint8Array): string {
  let text = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(text)
}
