/**
 * Read-only native IME evidence helper for an isolated synthetic dev:prep page.
 * Pass installNativeImeObserver to Playwright context.addInitScript before loading
 * the page. It observes the existing workspace; it never dispatches input events,
 * changes content, saves work, or calls an application API.
 *
 * A trusted composition event is browser evidence, not proof of a human student.
 * Record the operator, installed IME, candidate actions, source and date separately.
 * Plain insertText/typeText or synthetic composition is not native IME acceptance.
 */
export function installNativeImeObserver() {
  if (window.__nativeImeObserverInstalled) return
  window.__nativeImeObserverInstalled = true
  window.__nativeImeEvidence = []
  const types = ['compositionstart', 'compositionupdate', 'compositionend',
    'beforeinput', 'input', 'keydown', 'keyup']
  for (const type of types) {
    document.addEventListener(type, event => {
      if (!(event.target instanceof Element) || !event.target.closest('.cw')) return
      window.__nativeImeEvidence.push({
        time: performance.now(),
        type: event.type,
        trusted: event.isTrusted,
        key: event.key ?? null,
        code: event.code ?? null,
        keyCode: event.keyCode ?? null,
        isComposing: event.isComposing ?? null,
        inputType: event.inputType ?? null,
        data: event.data ?? null,
        field: event.target.getAttribute('aria-label') ?? event.target.className,
        value: 'value' in event.target ? event.target.value : null,
      })
    }, true)
  }
}
