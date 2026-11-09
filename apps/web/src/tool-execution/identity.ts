import { canonicalValue } from '@xunjie/contracts/execution'

export { canonicalValue as canonical }
export async function digestOf(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalValue(value)))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}
