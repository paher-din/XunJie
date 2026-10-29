import { useEffect, useRef } from 'react'
import { CodeEditorHost, type CodeEditorHandle, type CodeEditorHostProps } from '../CodeEditorHost'
import { projectOriginal } from '../../../lib/originalText'
import { codeSelectionRange, type CodeSelectionResult } from '../../../workspace/tutoringObject'
import { snapshotReference, type ReferenceSelection } from './model'
import { useWorkspaceReferences } from './WorkspaceReferences'

/** Same original-text projection as CodeEditorHost; LF model offsets are never sent as raw offsets. */
export function codeReferenceSelection(result: CodeSelectionResult, sourceName: string,
  anchor: ReferenceSelection['anchor']): ReferenceSelection | null {
  if (!result.ok) return null
  const { workspaceKey, fileId, originalText, modelStart, modelEnd } = result.selection
  if (!codeSelectionRange(originalText, modelStart, modelEnd)) return null
  const projection = projectOriginal(originalText)
  const snapshot = snapshotReference({ workspaceKey, sourceId: fileId, sourceName, kind: 'code', sourceText: originalText,
    range: { start: projection.toOriginalOffset(modelStart), end: projection.toOriginalOffset(modelEnd) } })
  return snapshot ? { snapshot, anchor } : null
}
export type CodeReferenceSourceProps = Omit<CodeEditorHostProps, 'workspaceKey' | 'onSelectionChange'> & { sourceName: string }
export function CodeReferenceSource({ sourceName, ...props }: CodeReferenceSourceProps) {
  const { workspaceKey, register, select, clearSelection } = useWorkspaceReferences()
  const editor = useRef<CodeEditorHandle>(null), root = useRef<HTMLDivElement>(null)
  const latest = useRef({ props, sourceName }); latest.current = { props, sourceName }
  const gesture = useRef<{ fileId: string | null; token: object; kind: 'mouse' | 'keyboard'; changed: boolean; selectAll?: boolean } | undefined>(undefined), frame = useRef(0)
  const capture = (result?: CodeSelectionResult, committed?: object, interaction?: 'mouse' | 'keyboard') => {
    if (gesture.current && gesture.current.kind === interaction) gesture.current.changed = true
    const current = latest.current
    const candidate = codeReferenceSelection(result ?? editor.current?.captureSelection() ?? { ok: false, reason: '' },
      current.sourceName, () => editor.current?.selectionClientRect?.() ?? null)
    if (candidate && candidate.snapshot.workspaceKey === workspaceKey && candidate.snapshot.sourceId === current.props.fileId)
      select(candidate, committed)
    else if (current.props.fileId) clearSelection(current.props.fileId)
  }
  const captureRef = useRef(capture); captureRef.current = capture
  useEffect(() => {
    if (!props.fileId) return
    return register({ sourceId: props.fileId, locate: reference => {
      const current = latest.current.props
      if (reference.sourceId !== current.fileId || reference.sourceText !== current.initialText)
        return { ok: false, reason: '原文件或正文已改变；保留的是选择时的原文。' }
      const projection = projectOriginal(reference.sourceText)
      const range = codeSelectionRange(reference.sourceText, projection.toModelOffset(reference.range.start),
        projection.toModelOffset(reference.range.end))
      if (!range || !editor.current) return { ok: false, reason: '编辑器当前不可用；引用副本仍然保留。' }
      return editor.current.revealOriginalRange({ workspaceKey, fileId: reference.sourceId, originalText: reference.sourceText, range })
    } })
  }, [register, props.fileId, props.initialText, workspaceKey])
  const finish = () => {
    const completed = gesture.current
    if (!completed) return
    gesture.current = undefined
    // Require Monaco's explicit selection event, except reselecting the same full text.
    // Focus checks also exclude find/replace and embedded widget inputs.
    if (completed.kind === 'keyboard' && !editor.current?.hasTextFocus?.()) return
    if (!completed.changed && !completed.selectAll) return
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      if (latest.current.props.fileId === completed.fileId) captureRef.current(undefined, completed.token)
    })
  }
  const finishRef = useRef(finish); finishRef.current = finish
  useEffect(() => {
    const up = () => finishRef.current()
    document.addEventListener('pointerup', up, true)
    return () => { cancelAnimationFrame(frame.current); document.removeEventListener('pointerup', up, true) }
  }, [])
  useEffect(() => () => {
    gesture.current = undefined
    cancelAnimationFrame(frame.current)
  }, [props.fileId])
  return <div ref={root} className="wr-code-source" aria-label={sourceName}
    onKeyUpCapture={finish} onPointerDownCapture={() => { gesture.current = { fileId: props.fileId, token: {}, kind: 'mouse', changed: false } }} onKeyDownCapture={event => {
      if (!editor.current?.hasTextFocus?.() || event.nativeEvent.isComposing) {
        gesture.current = undefined
        return
      }
      const selectAll = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a'
      if ((event.shiftKey && /^(Arrow|Home|End|Page)/.test(event.key)) || selectAll)
        gesture.current = { fileId: props.fileId, token: {}, kind: 'keyboard', changed: false, selectAll }
    }}>
    <CodeEditorHost ref={editor} {...props} workspaceKey={workspaceKey} onSelectionChange={(result, interaction) => capture(result, undefined, interaction)} />
  </div>
}
