export { teachingArtifactSdkApi } from '@xunjie/contracts/teaching-artifacts'

// Serialized into the opaque frame. It has no imported runtime, authority or credentials.
function bootstrap() {
  let port: MessagePort, connectionId = '', instanceId = '', contentId: string | null = null
  let start!: () => void, failed = false
  const ready = new Promise<void>(resolve => { start = resolve })
  let initialRead: Promise<any> | undefined
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const issue = (cause: unknown) => {
    failed = true
    let alert = document.querySelector<HTMLElement>('[data-xunjie-error]')
    if (!alert) { alert = document.createElement('p'); alert.dataset.xunjieError = ''; alert.setAttribute('role', 'alert'); document.body.append(alert) }
    alert.textContent = '这次输入尚未确认，请保留页面中的内容。' + (cause instanceof Error ? `（${cause.message}）` : '')
  }
  const request = async (method: string, payload: unknown = {}, gesture = false): Promise<any> => {
    await ready
    if (pending.size >= 64) throw new Error('budget-exceeded')
    const messageId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(messageId); reject(new Error('outcome-unknown')) }, 10000)
      pending.set(messageId, { resolve, reject, timer })
      port.postMessage({ hostApiVersion: 1, instanceId, connectionId, messageId, method, payload,
        ...(method.startsWith('artifact.') ? { gesture } : {}) })
    })
  }
  const read = async () => { await ready; const value = await (initialRead ?? request('workspace.read')); contentId = value.contentId; return value }
  const changes = new Map<string, { payload: unknown; retry?: ReturnType<typeof setTimeout> }>()
  let gestureAt = 0
  const trustedGesture = (event: Event) => {
    gestureAt = event.isTrusted && event.composedPath().some(target => target instanceof Element
      && target.matches('button,input[type="button"],input[type="submit"]')) ? performance.now() : 0
  }
  document.addEventListener('click', trustedGesture, true)
  document.addEventListener('keydown', () => { gestureAt = 0 }, true)
  document.addEventListener('input', () => { gestureAt = 0 }, true)
  const explicit = (method: string, input: unknown) => {
    return request(method, input, navigator.userActivation.isActive && gestureAt > 0 && performance.now() - gestureAt <= 5000)
  }
  const change = (content: unknown) => {
    const operationId = crypto.randomUUID(), nextId = crypto.randomUUID()
    const payload = { operationId, expectedContentId: contentId, contentId: nextId, content: structuredClone(content) }
    contentId = nextId
    const entry = { payload, retry: undefined as ReturnType<typeof setTimeout> | undefined }
    changes.set(operationId, entry)
    const deliver = (): Promise<any> => request('workspace.change', entry.payload).then(receipt => {
      changes.delete(operationId)
      if (!changes.size) { failed = false; document.querySelector('[data-xunjie-error]')?.remove() }
      return receipt
    }, cause => {
      issue(cause)
      if (['outcome-unknown', 'resource-unavailable', 'budget-exceeded'].includes(cause.message))
        entry.retry = setTimeout(() => { void deliver().catch(() => {}) }, 1000)
      throw cause
    })
    return deliver()
  }
  Object.defineProperty(window, 'xunjie', { value: Object.freeze({ read, change,
    capabilities: () => request('artifact.capabilities'),
    reference: Object.freeze({ select: (input: unknown) => request('artifact.reference', input) }),
    respond: (input: unknown) => explicit('artifact.respond', input),
    materials: Object.freeze({ read: (input: unknown) => request('artifact.material', input) }),
    observations: Object.freeze({ read: (input: unknown) => request('artifact.observation', input) }),
    execution: Object.freeze({ submit: (input: unknown) => explicit('artifact.execute', input), query: (input: unknown) => request('artifact.observation', input) }),
  }), writable: false, configurable: false })
  let composing = false
  const activity = () => { if (port) port.postMessage({ method: 'artifact.interaction', connectionId, instanceId, payload: { composing, focused: document.hasFocus() } }) }
  document.addEventListener('compositionstart', () => { composing = true; activity() })
  document.addEventListener('compositionend', () => { composing = false; activity() })
  window.addEventListener('focus', activity); window.addEventListener('blur', activity)
  window.addEventListener('error', event => { issue(event.error); void request('artifact.error', {}) })
  window.addEventListener('unhandledrejection', event => { issue(event.reason); void request('artifact.error', {}) })
  window.addEventListener('message', event => {
    if (event.source !== parent || port || event.data?.method !== 'host.initialize' || !event.ports[0]) return
    port = event.ports[0]; connectionId = event.data.connectionId; instanceId = event.data.instanceId
    for (const [key, value] of Object.entries(event.data.payload.theme ?? {})) document.documentElement.style.setProperty('--' + key, String(value))
    port.onmessage = event => {
      const reply = event.data
      if (reply.connectionId !== connectionId || reply.instanceId !== instanceId) return
      if (reply.method === 'host.theme') {
        for (const [key, value] of Object.entries(reply.payload)) document.documentElement.style.setProperty('--' + key, String(value))
        return
      }
      if (reply.method === 'host.check') {
        void (async () => {
          try { const before = await read(); await change(before.content); const after = await read()
            await request('artifact.checked', { load: !failed, stateRoundtrip: JSON.stringify(before.content) === JSON.stringify(after.content) })
          } catch { await request('artifact.checked', { load: false, stateRoundtrip: false }) }
        })()
        return
      }
      const callback = pending.get(reply.replyTo)
      if (!callback) return
      clearTimeout(callback.timer); pending.delete(reply.replyTo)
      if (reply.error) callback.reject(new Error(reply.error.code)); else callback.resolve(reply.payload)
    }
    start()
    initialRead = request('workspace.read')
    void initialRead.then(value => {
      contentId = value.contentId
      // Generated await read() continuations bind controls before the ready task exposes the view.
      setTimeout(() => { initialRead = undefined; void request('component.ready') }, 0)
    }).catch(issue)
    if (event.data.payload.readOnly) {
      const freeze = () => document.querySelectorAll<HTMLInputElement>('input,textarea,select,button,[contenteditable]').forEach(element => { element.disabled = true; element.setAttribute('contenteditable', 'false') })
      freeze(); new MutationObserver(freeze).observe(document.body, { subtree: true, childList: true })
    }
  }, { once: false })
}

/** Delivered only over the port-bearing, one-shot parent bootstrap of the fixed HTTP view. */
export function teachingArtifactBootstrapSource() { return `(${bootstrap.toString()})();` }
