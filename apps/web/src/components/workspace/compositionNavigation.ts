/**
 * A tool-tab pointer click must not blur an unfinished editor composition. Some Windows
 * IMEs commit the romanised preedit on blur. Keep the editor/candidate focused, then replay
 * the latest requested tab after the user commits or cancels through their input method.
 * This owns only a pending UI gesture; text, history and saving remain with the editor.
 */
export function protectCompositionNavigation(host: HTMLElement): () => void {
  const document = host.ownerDocument, window = document.defaultView!
  let composing = false, disposed = false
  let pending: { tab: HTMLElement; target: HTMLElement } | null = null
  let timer: number | undefined
  const cancelTimer = () => { if (timer !== undefined) window.clearTimeout(timer); timer = undefined }
  const tabOf = (event: Event) => {
    if (!(event.target instanceof Element) || host.contains(event.target)) return null
    return event.target.closest<HTMLElement>('[role="tab"]')
  }
  const start = () => { composing = true; pending = null; cancelTimer() }
  const end = () => {
    composing = false
    const requested = pending
    pending = null
    if (!requested) return
    // A task boundary lets Monaco finish the real compositionend/model/history handlers first.
    timer = window.setTimeout(() => {
      timer = undefined
      if (disposed || composing || !requested.tab.isConnected || !requested.target.isConnected) return
      requested.tab.focus()
      requested.target.click()
    }, 0)
  }
  const pointerDown = (event: Event) => {
    if (!composing) { cancelTimer(); return }
    if (!host.contains(document.activeElement)) return
    if (tabOf(event)) event.preventDefault()
    else pending = null
  }
  const click = (event: Event) => {
    if (!composing) { cancelTimer(); return }
    if (!host.contains(document.activeElement)) return
    const tab = tabOf(event)
    if (!tab) return
    event.preventDefault()
    event.stopImmediatePropagation()
    pending = { tab, target: event.target instanceof HTMLElement ? event.target : tab }
  }
  host.addEventListener('compositionstart', start, true)
  host.addEventListener('compositionend', end, true)
  document.addEventListener('pointerdown', pointerDown, true)
  document.addEventListener('click', click, true)
  return () => {
    disposed = true
    pending = null
    cancelTimer()
    host.removeEventListener('compositionstart', start, true)
    host.removeEventListener('compositionend', end, true)
    document.removeEventListener('pointerdown', pointerDown, true)
    document.removeEventListener('click', click, true)
  }
}
