import { useEffect, useRef, type RefObject } from 'react'
import type { QuestionReferenceSource } from '@xunjie/contracts/question-drafts'
import { snapshotReference, type ReferenceSelection } from './model'
import { useWorkspaceReferences } from './WorkspaceReferences'

const excluded = 'input, textarea, select, [contenteditable], [data-reference-ui], [data-reference-exclude]'
function elementOf(node: Node | null): Element | null { return node instanceof Element ? node : node?.parentElement ?? null }
function rangeAtOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let offset = 0, foundStart = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (!foundStart && start <= offset + length) { range.setStart(node, start - offset); foundStart = true }
    if (foundStart && end <= offset + length) { range.setEnd(node, end - offset); return range }
    offset += length
  }
  return null
}
/** Exact textContent offsets; never harvest text from adjacent containers or editable controls. */
export function readTextSelection(root: HTMLElement, text: string, selection: Selection | null): Range | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed || root.textContent !== text) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer) ||
    elementOf(range.startContainer)?.closest(excluded) || elementOf(range.endContainer)?.closest(excluded)) return null
  for (const blocked of root.querySelectorAll(excluded)) if (range.intersectsNode(blocked)) return null
  return range.cloneRange()
}
/** Register a container whose textContent equals the authoritative source text. */
export function useTextReferenceSource(root: RefObject<HTMLElement | null>, sourceId: string, sourceName: string, text: string,
  source?: QuestionReferenceSource) {
  const { workspaceKey, register, select, clearSelection } = useWorkspaceReferences()
  const sourceRef = useRef(source); sourceRef.current = source
  useEffect(() => {
    const element = root.current
    if (!element) return
    const unregister = register({ sourceId, locate: reference => {
      const fixedSource = sourceRef.current
      if (!element.isConnected || element.textContent !== text || text.slice(reference.range.start, reference.range.end) !== reference.text)
        return { ok: false, reason: '来源已改变或不可用；保留的是选择时的原文。' }
      if (reference.source && (!fixedSource || JSON.stringify(reference.source) !== JSON.stringify(fixedSource)))
        return { ok: false, reason: '来源已改变；保留的是选择时的原文。' }
      if (reference.sourceText !== undefined && reference.sourceText !== text)
        return { ok: false, reason: '来源已改变或不可用；保留的是选择时的原文。' }
      const range = rangeAtOffsets(element, reference.range.start, reference.range.end)
      if (!range) return { ok: false, reason: '原位置当前不可用；引用副本仍然保留。' }
      element.scrollIntoView({ block: 'center', behavior: 'instant' })
      element.focus({ preventScroll: true })
      const selected = document.getSelection()
      selected?.removeAllRanges()
      selected?.addRange(range)
      return { ok: true }
    } })
    let gesture: object | undefined, frame = 0
    const capture = (committed?: object) => {
      const range = readTextSelection(element, text, document.getSelection())
      if (!range) { clearSelection(sourceId); return }
      const prefix = document.createRange()
      prefix.selectNodeContents(element)
      prefix.setEnd(range.startContainer, range.startOffset)
      const start = prefix.toString().length, end = start + range.toString().length
      const snapshot = snapshotReference({ workspaceKey, sourceId, sourceName, kind: 'text', sourceText: text, range: { start, end },
        ...(sourceRef.current ? { source: sourceRef.current } : {}) })
      if (!snapshot) { clearSelection(sourceId); return }
      const candidate: ReferenceSelection = { snapshot, anchor: () => {
        if (!element.isConnected || element.textContent !== text) return null
        const rects = Array.from(range.getClientRects())
        const container = element.getBoundingClientRect()
        const rect = rects.find(rect => rect.height > 0 && rect.bottom > Math.max(0, container.top) &&
          rect.top < Math.min(window.innerHeight, container.bottom))
        return rect ?? null
      } }
      select(candidate, committed)
    }
    const changed = () => {
      // Moving focus to reference controls must not destroy the snapshot waiting on the toolbar.
      if (document.activeElement?.closest('[data-reference-ui]')) return
      capture()
    }
    const down = () => { gesture = {} }
    const up = () => {
      if (!gesture) return
      const completed = gesture; gesture = undefined
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => capture(completed))
    }
    const keydown = (event: KeyboardEvent) => {
      if ((event.shiftKey && /^(Arrow|Home|End|Page)/.test(event.key)) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) gesture = {}
    }
    const keyup = () => up()
    element.addEventListener('pointerdown', down)
    document.addEventListener('pointerup', up)
    element.addEventListener('keydown', keydown)
    element.addEventListener('keyup', keyup)
    document.addEventListener('selectionchange', changed)
    return () => {
      cancelAnimationFrame(frame); unregister()
      element.removeEventListener('pointerdown', down); document.removeEventListener('pointerup', up)
      element.removeEventListener('keydown', keydown); element.removeEventListener('keyup', keyup)
      document.removeEventListener('selectionchange', changed)
    }
  }, [root, workspaceKey, sourceId, sourceName, text, register, select, clearSelection])
}
export function TextReferenceSource({ sourceId, sourceName, text, source }: { sourceId: string; sourceName: string; text: string
  source?: QuestionReferenceSource }) {
  const ref = useRef<HTMLDivElement>(null)
  useTextReferenceSource(ref, sourceId, sourceName, text, source)
  return <div ref={ref} className="wr-text-source" tabIndex={0} aria-label={sourceName}>{text}</div>
}
