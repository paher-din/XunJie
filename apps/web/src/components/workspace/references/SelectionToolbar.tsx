import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceReferences } from './WorkspaceReferences'

export function SelectionToolbar() {
  const { pending, open, ask, clearSelection, draftReady } = useWorkspaceReferences()
  const button = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useEffect(() => {
    if (!pending || open) { setPosition(null); return }
    let frame = 0
    const update = () => {
      const rect = pending.anchor(), viewport = window.visualViewport
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight
      const size = button.current?.getBoundingClientRect()
      const w = size?.width ?? 160, h = size?.height ?? 36
      let next: typeof position = null
      if (rect && rect.bottom >= y && rect.top <= y + height && rect.right >= x && rect.left <= x + width) {
        const above = rect.top - h - 8
        next = { left: Math.max(x + 8, Math.min(rect.left, x + width - w - 8)),
          top: Math.max(y + 8, Math.min(above >= y + 8 ? above : rect.bottom + 8, y + height - h - 8)) }
      }
      setPosition(old => old?.left === next?.left && old?.top === next?.top ? old : next)
      // Monaco scrolls a virtual surface, not necessarily a DOM scroll container.
      frame = requestAnimationFrame(update)
    }
    update()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { clearSelection(pending.snapshot.sourceId); return }
      if (event.altKey && event.key === 'Enter' && !event.isComposing && draftReady !== false) { event.preventDefault(); ask() }
    }
    document.addEventListener('keydown', key)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', key) }
  }, [pending, open, ask, clearSelection, draftReady])
  if (!pending || open) return null
  return createPortal(<div className="wr-toolbar" data-reference-ui style={{ left: position?.left ?? 8,
    top: position?.top ?? 8, visibility: position ? 'visible' : 'hidden' }}>
    <button ref={button} type="button" aria-keyshortcuts="Alt+Enter" disabled={draftReady === false}
      title={draftReady === false ? '正在读取原问题草稿，请稍候' : '询问 Agent（Alt + Enter）'}
      onPointerDown={event => event.preventDefault()} onClick={ask}>询问 Agent</button>
  </div>, document.body)
}
