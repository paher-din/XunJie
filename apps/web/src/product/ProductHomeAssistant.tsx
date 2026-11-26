import { useCallback, useEffect, useRef, useState } from 'react'
import { HomeAssistant } from '@xunjie/ui/foundation'

export function ProductHomeAssistant({ onOpen, onSend }: { onOpen(): void; onSend(text: string): void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const assistant = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    assistant.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [])
  const expand = useCallback(() => { onOpen(); setOpen(true) }, [onOpen])
  const toggle = useCallback(() => { if (open) close(); else expand() }, [open, close, expand])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[aria-modal="true"]')) return
      const shortcut = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j'
      if (!shortcut && !(open && event.key === 'Escape')) return
      event.preventDefault()
      if (!event.repeat) toggle()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, toggle])

  return <div ref={assistant}>
    <HomeAssistant open={open} value={draft} onChange={setDraft} onSend={onSend}
      onToggle={toggle} onOpen={expand} onClose={close} />
  </div>
}
