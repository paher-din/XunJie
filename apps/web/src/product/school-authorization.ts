import { z } from 'zod'

const pendingAuthorization = z.object({ requestId: z.uuid(), authorizationUrl: z.url() })
const savedAuthorization = pendingAuthorization.extend({ connectionId: z.string().optional(), authenticated: z.boolean().optional(), createdAt: z.number() })
export type PendingSchoolConnection = z.infer<typeof pendingAuthorization> & { connectionId?: string; authenticated?: boolean }
const pendingKey = (namespace: string) => 'xj.school-authorization.' + namespace

/** Store only the public request, never the device verifier or a school credential. */
export function rememberSchoolConnection(namespace: string, pending: PendingSchoolConnection | null) {
  if (!pending) { localStorage.removeItem(pendingKey(namespace)); return }
  let createdAt = Date.now()
  try {
    const previous = savedAuthorization.parse(JSON.parse(localStorage.getItem(pendingKey(namespace)) ?? 'null'))
    if (previous.requestId === pending.requestId) createdAt = previous.createdAt
  } catch { /* A new request replaces an unreadable journal. */ }
  localStorage.setItem(pendingKey(namespace), JSON.stringify({ ...pending, createdAt }))
}

export function restoreSchoolConnection(namespace: string, returnedRequestId: string | null = null): PendingSchoolConnection | null {
  try {
    const saved = savedAuthorization.parse(JSON.parse(localStorage.getItem(pendingKey(namespace)) ?? 'null'))
    if (returnedRequestId && saved.requestId !== returnedRequestId) return null
    // School authorizations expire after five minutes. A confirmed connection can
    // still retry its context read after that window.
    if (!saved.connectionId && Date.now() - saved.createdAt >= 5 * 60 * 1000) return null
    const { createdAt: _, ...pending } = saved
    return { ...pending, authenticated: pending.authenticated || returnedRequestId === saved.requestId }
  } catch { return null }
}

/** Return to one fixed account route, carrying only the public request ID. */
export function schoolAuthorizationReturnUrl(requestId: string, value: string | null) {
  if (value === null) return null
  try {
    const url = new URL(value)
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    const expected = new URL('/?settings=account&schoolAuthorization=' + encodeURIComponent(requestId), url.origin)
    if (!z.uuid().safeParse(requestId).success || url.username || url.password || url.href !== expected.href
      || url.origin === window.location.origin || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error()
    return expected.href
  } catch { throw new Error('客户端返回地址无效，请返回客户端重新发起学校认证。') }
}

export function returnToSchoolClient(url: string | null) {
  if (!url) return false
  window.location.replace(url)
  return true
}
const schoolEntry = z.object({ schoolEndpoint: z.url().refine(value => {
  const endpoint = new URL(value)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
  return !endpoint.username && !endpoint.password && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash
    && (endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && loopback)
    && endpoint.origin !== window.location.origin
}) })

/** Validate the entry and prepare the connection before opening authentication. */
export async function startSchoolAuthorization(input: unknown, request: () => Promise<unknown>, namespace: string) {
  if (!schoolEntry.safeParse(input).success) throw Object.assign(new Error(
    '请填写学校入口根地址（如 https://school.example.edu/），不要使用当前页面或带路径、参数的链接。',
  ), { code: 'invalid' })
  // The runtime assigns connectionId before school login. Only client/complete may
  // promote it to a confirmed connection in the account page's pending state.
  const pending = pendingAuthorization.parse(await request())
  const authorization = new URL(pending.authorizationUrl)
  if (authorization.origin !== new URL(schoolEntry.parse(input).schoolEndpoint).origin
    || authorization.username || authorization.password) throw new Error('学校认证地址与学校入口不一致，请重新填写学校链接。')
  const returnUrl = new URL('/?settings=account&schoolAuthorization=' + pending.requestId, window.location.origin)
  authorization.searchParams.set('returnTo', returnUrl.href)
  pending.authorizationUrl = authorization.href
  rememberSchoolConnection(namespace, pending)
  try {
    window.open(pending.authorizationUrl, '_blank', 'noopener,noreferrer')
  } catch {
    // The account page keeps an ordinary link when automatic navigation is unavailable.
  }
  return pending
}
