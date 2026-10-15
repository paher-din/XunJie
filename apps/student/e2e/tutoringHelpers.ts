import { expect, type Locator } from '@playwright/test'

/** Scroll the actual answer into view; a long source/facts card can exceed its viewport. */
export async function revealTutorBody(message: Locator) {
  const body = message.locator(':scope > .chat-message.agent > .turn-body')
  await expect(body).toHaveText(/\S/)
  await body.scrollIntoViewIfNeeded()
}
