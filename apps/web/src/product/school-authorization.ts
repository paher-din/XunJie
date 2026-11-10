import { z } from 'zod'

const pendingAuthorization = z.object({ requestId: z.uuid(), authorizationUrl: z.url() })

/** Reserve the tab during the user gesture; a start ID does not confirm authentication. */
export async function startSchoolAuthorization(request: () => Promise<unknown>) {
  let authentication: Window | null = null
  try {
    authentication = window.open('about:blank', '_blank')
    if (authentication) authentication.opener = null
  } catch {
    authentication?.close()
    authentication = null
  }
  try {
    // The runtime assigns connectionId before school login. Only client/complete may
    // promote it to a confirmed connection in the account page's pending state.
    const pending = pendingAuthorization.parse(await request())
    try {
      if (authentication && !authentication.closed) authentication.location.replace(pending.authorizationUrl)
    } catch {
      authentication?.close()
      // The account page keeps an ordinary link when automatic navigation is unavailable.
    }
    return pending
  } catch (error) {
    authentication?.close()
    throw error
  }
}
