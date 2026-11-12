// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useViewPolling } from './useViewPolling'

let root: Root, host: HTMLDivElement, hidden: boolean
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
function Probe({ read, scope = 'one', enabled = true, wake = '' }: {
  read(): Promise<unknown>; scope?: string; enabled?: boolean; wake?: string
}) {
  useViewPolling(read, scope, 1500, enabled, wake)
  return null
}
const mount = async (props: Parameters<typeof Probe>[0]) => act(async () => { root.render(<Probe {...props} />) })
const advance = async (duration: number) => act(async () => { await vi.advanceTimersByTimeAsync(duration) })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.useRealTimers(); vi.unstubAllGlobals()
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden)
  else Reflect.deleteProperty(document, 'hidden')
})

it('keeps one request in flight even when a response takes longer than multiple polling intervals', async () => {
  let finish!: () => void
  const read = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  await mount({ read })
  await advance(10000)
  expect(read).toHaveBeenCalledOnce()
  await act(async () => { finish() })
  await advance(1500)
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => { finish() })
})

it('pauses hidden documents and inactive panes and refreshes immediately when they return', async () => {
  const read = vi.fn(async () => {})
  await mount({ read })
  hidden = true
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await advance(10000)
  expect(read).toHaveBeenCalledOnce()
  hidden = false
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(read).toHaveBeenCalledTimes(2)
  await mount({ read, enabled: false })
  await advance(10000)
  expect(read).toHaveBeenCalledTimes(2)
  await mount({ read })
  expect(read).toHaveBeenCalledTimes(3)
})

it('does not let a stalled old activity block a different activity', async () => {
  const oldRead = vi.fn(() => new Promise(() => {})), newRead = vi.fn(async () => {})
  await mount({ read: oldRead })
  await mount({ read: newRead, scope: 'two' })
  expect(newRead).toHaveBeenCalledOnce()
  await advance(1500)
  expect(newRead).toHaveBeenCalledTimes(2)
})

it('reads again after an action wakes a poll whose previous response is still pending', async () => {
  let finish!: () => void
  const read = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  await mount({ read })
  await mount({ read, wake: 'accepted-input' })
  expect(read).toHaveBeenCalledOnce()
  await act(async () => { finish() })
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => { finish() })
})
