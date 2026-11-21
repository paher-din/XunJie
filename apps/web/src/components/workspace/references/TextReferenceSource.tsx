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

export function locateTextRange(element: HTMLElement, start: number, end: number, scroll?: HTMLElement): boolean {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > (element.textContent?.length ?? 0)) return false
  const range = rangeAtOffsets(element, start, end)
  return range ? locateDomRange(element, range, scroll) : false
}

export function locateDomRange(element: HTMLElement, range: Range, scroll?: HTMLElement): boolean {
  const selection = element.ownerDocument.getSelection()
  if (!selection) return false
  if (scroll) {
    const first = range.getClientRects()[0]
    if (first) scroll.scrollTop += first.top - scroll.getBoundingClientRect().top - scroll.clientHeight / 3
  } else element.scrollIntoView({ block: 'center', behavior: 'instant' })
  element.focus({ preventScroll: true })
  selection.removeAllRanges()
  selection.addRange(range)
  return true
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

function textOffsets(root: HTMLElement, range: Range) {
  const prefix = document.createRange()
  prefix.selectNodeContents(root)
  prefix.setEnd(range.startContainer, range.startOffset)
  const start = prefix.toString().length
  return { start, end: start + range.toString().length }
}

/** The rendered selection can supply original offsets when the displayed text includes formatting. */
export function useTextReferenceSource(root: RefObject<HTMLElement | null>, sourceId: string, sourceName: string, text: string,
  source?: QuestionReferenceSource, { registerSource = true, renderedOffsets }: {
    registerSource?: boolean
    renderedOffsets?: (root: HTMLElement, text: string, range: Range) => { start: number; end: number } | null
  } = {}) {
  const { workspaceKey, register, select, clearSelection } = useWorkspaceReferences()
  const sourceRef = useRef(source); sourceRef.current = source
  useEffect(() => {
    const element = root.current
    if (!element) return
    const unregister = registerSource ? register({ sourceId, locate: reference => {
      const fixedSource = sourceRef.current
      if (!element.isConnected || element.textContent !== text || text.slice(reference.range.start, reference.range.end) !== reference.text)
        return { ok: false, reason: '来源已改变或不可用；保留的是选择时的原文。' }
      if (reference.source && (!fixedSource || JSON.stringify(reference.source) !== JSON.stringify(fixedSource)))
        return { ok: false, reason: '来源已改变；保留的是选择时的原文。' }
      if (reference.sourceText !== undefined && reference.sourceText !== text)
        return { ok: false, reason: '来源已改变或不可用；保留的是选择时的原文。' }
      if (!locateTextRange(element, reference.range.start, reference.range.end))
        return { ok: false, reason: '原位置当前不可用；引用副本仍然保留。' }
      return { ok: true }
    } }) : undefined
    let gesture: object | undefined, frame = 0
    const capture = (committed?: object) => {
      const displayedText = renderedOffsets ? (element.textContent ?? '') : text
      const range = readTextSelection(element, displayedText, document.getSelection())
      if (!range) { clearSelection(sourceId); return }
      const offsets = renderedOffsets && displayedText !== text ? renderedOffsets(element, text, range) : textOffsets(element, range)
      if (!offsets) { clearSelection(sourceId); return }
      const snapshot = snapshotReference({ workspaceKey, sourceId, sourceName, kind: 'text', sourceText: text, range: offsets,
        ...(sourceRef.current ? { source: sourceRef.current } : {}) })
      if (!snapshot) { clearSelection(sourceId); return }
      const candidate: ReferenceSelection = { snapshot, anchor: () => {
        if (!element.isConnected || element.textContent !== displayedText) return null
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
      cancelAnimationFrame(frame)
      if (unregister) unregister()
      else clearSelection(sourceId)
      element.removeEventListener('pointerdown', down); document.removeEventListener('pointerup', up)
      element.removeEventListener('keydown', keydown); element.removeEventListener('keyup', keyup)
      document.removeEventListener('selectionchange', changed)
    }
  }, [root, workspaceKey, sourceId, sourceName, text, register, registerSource, renderedOffsets, select, clearSelection])
}
export function TextReferenceSource({ sourceId, sourceName, text, source, registerSource }: { sourceId: string; sourceName: string; text: string
  source?: QuestionReferenceSource; registerSource?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useTextReferenceSource(ref, sourceId, sourceName, text, source, { registerSource })
  return <div ref={ref} className="wr-text-source" tabIndex={0} aria-label={sourceName}>{text}</div>
}
