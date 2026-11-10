import { z } from 'zod'

const pendingAuthorization = z.object({ requestId: z.uuid(), authorizationUrl: z.url() })
const schoolEntry = z.object({ schoolEndpoint: z.url().refine(value => {
  const endpoint = new URL(value)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
  return !endpoint.username && !endpoint.password && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash
    && (endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && loopback)
    && endpoint.origin !== window.location.origin
}) })

/** Validate the entry and prepare the connection before opening authentication. */
export async function startSchoolAuthorization(input: unknown, request: () => Promise<unknown>) {
  if (!schoolEntry.safeParse(input).success) throw Object.assign(new Error(
    '请填写学校入口根地址（如 https://school.example.edu/），不要使用当前页面或带路径、参数的链接。',
  ), { code: 'invalid' })
  // The runtime assigns connectionId before school login. Only client/complete may
  // promote it to a confirmed connection in the account page's pending state.
  const pending = pendingAuthorization.parse(await request())
  try {
    window.open(pending.authorizationUrl, '_blank', 'noopener,noreferrer')
  } catch {
    // The account page keeps an ordinary link when automatic navigation is unavailable.
  }
  return pending
}
