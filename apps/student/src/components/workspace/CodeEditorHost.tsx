import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import {
  applyModelEdits,
  OriginalEditHistory,
  projectOriginal,
  serverPosition,
  type OriginalProjection,
} from '../../lib/originalText'
import {
  editorOptions,
  loadMonaco,
  syncTheme,
  type MonacoEditor,
  type MonacoModel,
  type MonacoViewState,
} from './monacoSetup'
import { codeRangeModelOffsets, codeSelectionRange,
  type CodeRange, type CodeSelectionResult } from '../../workspace/tutoringObject'
import type { EditorDiagnosticMarkers } from '../../workspace/editorDiagnostics'

/**
 * 多文件代码编辑器的宿主：一个编辑器实例 + 每个文件实例一个 model。
 *
 * 身份边界（docs/home-design.md 已确认的「布局切换不销毁草稿与运行会话」在这里落到 model 上）：
 * model 按 `workspaceKey` + `fileId` 命名，存在模块级注册表里，因此切换文件、切换中心标签、
 * 拖动分屏都不销毁正文与撤销栈；只有换工作区（换任务 / 换账号 / 换 Attempt）才释放上一批。
 * 路径不参与身份——同名路径被回收后由新实例占用时，旧实例的 model 不会串。
 *
 * 原文权威（契约 §4）：model 只持有 LF 显示投影；BOM 与每个换行分隔符留在 original 里。
 * 每次内容变更用旧投影把显示范围映回原文打补丁，undo/redo 按模型实际历史版本恢复原文，
 * `onTextChange` 报出的是原文而不是 model.getValue()。
 */

type MonacoModule = typeof import('monaco-editor/editor/editor.api')

interface OriginalState {
  history: OriginalEditHistory
  projection: OriginalProjection
}

const models = new Map<string, MonacoModel>()
const originals = new Map<string, OriginalState>()
const viewStates = new Map<string, MonacoViewState>()
let registryKey: string | null = null

function keyOf(workspaceKey: string, fileId: string): string {
  return `${workspaceKey}\u0000${fileId}`
}

function fileOf(uriPath: string): string {
  return decodeURIComponent(uriPath.replace(/^\//, ''))
}

/** 换工作区时释放上一批 model；同一工作区内反复挂载不释放，撤销栈与视图状态才留得住。 */
function resetRegistryFor(workspaceKey: string): void {
  if (registryKey !== workspaceKey) {
    for (const model of models.values()) model.dispose()
    models.clear()
    originals.clear()
    viewStates.clear()
    registryKey = workspaceKey
  }
}

export interface CodeEditorHandle {
  focus(): void
  /** 记下当前文件的视图状态（光标 / 滚动 / 折叠），切换与卸载时调用。 */
  saveViewState(): CodeEditorViewState
  /** 只读捕获当前单选区与原文，不暴露 Monaco model 作为服务端身份。 */
  captureSelection(): CodeSelectionResult
  /** 仅定位当前同一实例/原文；不打开别的文件，不修改正文或保存。 */
  revealOriginalRange(location: CodeEditorLocation): { ok: true } | { ok: false; reason: string }
}

/** Monaco 的本机视图，与服务端代码范围无关；无 model 时为 null。 */
export type CodeEditorViewState = ReturnType<MonacoEditor['saveViewState']>

export interface CodeEditorLocation {
  workspaceKey: string
  fileId: string
  originalText: string
  range: CodeRange
}

export interface CodeEditorHostProps {
  /** 隔离命名空间：mock 用 taskId，正式版是模式 / 账号 / Attempt 的组合。 */
  workspaceKey: string
  /** 当前文件实例；null = 没有打开的文件。 */
  fileId: string | null
  language: string
  /** 仅在创建 model 时使用；后续正文变化以 model 为准。 */
  initialText: string
  readOnly: boolean
  readOnlyReason: string | null
  onTextChange: (fileId: string, text: string) => void
  onCursorChange: (position: { line: number; column: number } | null) => void
  onSelectionChange?: (result: CodeSelectionResult) => void
  diagnostics?: EditorDiagnosticMarkers
}

export const CodeEditorHost = forwardRef<CodeEditorHandle, CodeEditorHostProps>(function CodeEditorHost(
  { workspaceKey, fileId, language, initialText, readOnly, readOnlyReason, onTextChange, onCursorChange, onSelectionChange, diagnostics },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MonacoEditor | null>(null)
  const monacoRef = useRef<MonacoModule | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [failure, setFailure] = useState<string | null>(null)

  // 回调用 ref 转发：父组件每次渲染都会给新函数，不能因此重订阅编辑器事件
  const textChangeRef = useRef(onTextChange)
  const cursorRef = useRef(onCursorChange)
  const initialTextRef = useRef(initialText)
  const readOnlyRef = useRef({ readOnly, readOnlyReason })
  const selectionRef = useRef(onSelectionChange)
  const identityRef = useRef({ workspaceKey, fileId })
  const pendingFocus = useRef<{ workspaceKey: string; fileId: string | null } | null>(null)
  identityRef.current = { workspaceKey, fileId }
  useEffect(() => {
    textChangeRef.current = onTextChange
    cursorRef.current = onCursorChange
    initialTextRef.current = initialText
    readOnlyRef.current = { readOnly, readOnlyReason }
    selectionRef.current = onSelectionChange
  })

  const currentOriginal = () => {
    const editor = editorRef.current, model = editor?.getModel()
    const identity = identityRef.current
    if (!editor || !model || registryKey !== identity.workspaceKey || identity.fileId === null ||
      fileOf(model.uri.path) !== identity.fileId) return null
    const key = keyOf(identity.workspaceKey, identity.fileId), state = originals.get(key)
    if (!state || models.get(key) !== model || model.getValue() !== state.projection.modelText) return null
    return { editor, model, state, identity }
  }
  const captureSelection = (): CodeSelectionResult => {
    const current = currentOriginal()
    if (!current) return { ok: false, reason: '编辑器或原文件实例尚不可用，请重新选择。' }
    const selections = current.editor.getSelections()
    if (!selections || selections.length !== 1) return { ok: false, reason: '请明确选择一个连续选区，多选区不能合并成一次代码引用。' }
    const selected = selections[0]
    const modelStart = current.model.getOffsetAt(selected.getStartPosition())
    const modelEnd = current.model.getOffsetAt(selected.getEndPosition())
    const originalText = current.state.history.current
    if (!codeSelectionRange(originalText, modelStart, modelEnd))
      return { ok: false, reason: '这个选区无法精确对应原文，请重新选择；原文保持不变。' }
    return { ok: true, selection: Object.freeze({ workspaceKey: current.identity.workspaceKey,
      fileId: current.identity.fileId!, originalText, modelStart, modelEnd }) }
  }
  const notifySelection = () => selectionRef.current?.(captureSelection())

  useImperativeHandle(ref, () => ({
    focus: () => {
      const editor = editorRef.current
      const model = editor?.getModel(), identity = identityRef.current
      if (editor && model && registryKey === identity.workspaceKey && identity.fileId !== null &&
        fileOf(model.uri.path) === identity.fileId) {
        pendingFocus.current = null
        editor.focus()
      } else pendingFocus.current = { ...identity }
    },
    saveViewState: () => {
      const editor = editorRef.current
      const model = editor?.getModel()
      if (!editor || !model) return null
      const view = editor.saveViewState()
      viewStates.set(keyOf(workspaceKey, fileOf(model.uri.path)), view)
      return view
    },
    captureSelection,
    revealOriginalRange: (location) => {
      const current = currentOriginal()
      if (!current || location.workspaceKey !== current.identity.workspaceKey ||
        location.fileId !== current.identity.fileId || location.originalText !== current.state.history.current)
        return { ok: false, reason: '原文件或正文已改变，不能把旧位置定位到当前代码。' }
      const offsets = codeRangeModelOffsets(location.originalText, location.range)
      if (!offsets) return { ok: false, reason: '原位置无法在编辑器中精确表示，原文保持不变。' }
      const start = current.model.getPositionAt(offsets[0]), end = current.model.getPositionAt(offsets[1])
      const range = { startLineNumber: start.lineNumber, startColumn: start.column,
        endLineNumber: end.lineNumber, endColumn: end.column }
      current.editor.setSelection(range)
      current.editor.revealRangeInCenter(range)
      current.editor.focus()
      return { ok: true }
    },
  }))

  /* 1. 加载 Monaco 并创建唯一的编辑器实例 */
  useEffect(() => {
    let disposed = false
    let editor: MonacoEditor | null = null
    const disposables: Array<{ dispose(): void }> = []

    loadMonaco()
      .then((monaco) => {
        if (disposed || !hostRef.current) return
        monacoRef.current = monaco
        resetRegistryFor(workspaceKey)
        const { readOnly: ro, readOnlyReason: reason } = readOnlyRef.current
        editor = monaco.editor.create(hostRef.current, editorOptions(ro, reason))
        editorRef.current = editor

        let contentSubscription: { dispose(): void } | null = null
        const watchModel = () => {
          contentSubscription?.dispose()
          const model = editor?.getModel()
          contentSubscription = model?.onDidChangeContent((event) => {
            monaco.editor.setModelMarkers(model, 'xunjie-editor-diagnostics', [])
            if (editor?.getModel() !== model || event.isFlush) return
            const key = keyOf(workspaceKey, fileOf(model.uri.path))
            const state = originals.get(key)
            if (!state) return
            try {
              // 订阅模型：编辑器会排队转发多条事件，届时读取版本可能已越过当前事件。
              // 模型先安装组的结果版本，再发内容事件；一次 undo 不等于一次普通编辑。
              const version = model.getAlternativeVersionId()
              if (event.isUndoing || event.isRedoing) {
                if (!state.history.restore(version)) throw new Error('原文历史版本缺失，已保护的草稿保留，请重新进入编辑器。')
              } else {
                const next = applyModelEdits(
                  state.history.current,
                  state.projection,
                  event.changes.map((change) => ({
                    start: change.rangeOffset,
                    end: change.rangeOffset + change.rangeLength,
                    text: change.text,
                  })),
                )
                state.history.push(next, version)
              }
              state.projection = projectOriginal(state.history.current)
              // 仅核对显示投影；模型的 LF 正文绝不能覆盖权威原文的 BOM/混合 EOL。
              if (model.getValue() !== state.projection.modelText) throw new Error('编辑器与原文历史不一致，已保护的草稿保留，请重新进入编辑器。')
            } catch (error: unknown) {
              setFailure(error instanceof Error ? error.message : String(error))
              setStatus('failed')
              selectionRef.current?.({ ok: false, reason: '原文历史尚不可用，请重新进入编辑器后选择。' })
              return
            }
            textChangeRef.current(fileOf(model.uri.path), state.history.current)
            notifySelection()
          }) ?? null
        }
        disposables.push(
          editor.onDidChangeModel(watchModel),
          { dispose: () => contentSubscription?.dispose() },
        )
        disposables.push(editor.onDidChangeCursorSelection(notifySelection))
        disposables.push(
          editor.onDidChangeCursorPosition((event) => {
            const model = editor?.getModel()
            if (!model) {
              cursorRef.current(null)
              return
            }
            const state = originals.get(keyOf(workspaceKey, fileOf(model.uri.path)))
            if (!state) {
              cursorRef.current(null)
              return
            }
            // 状态栏与后续代码引用都用服务端行列语义，不直接送 Monaco 显示行列（契约 §4）
            const offset = state.projection.toOriginalOffset(model.getOffsetAt(event.position))
            cursorRef.current(serverPosition(state.history.current, offset))
          }),
        )
        // 浅深主题切换时重新取 tokens.css 的值，编辑器颜色不写死
        const observer = new MutationObserver(() => syncTheme(monaco))
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        disposables.push({ dispose: () => observer.disconnect() })

        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (disposed) return
        // 编辑器加载失败不回退成 textarea：那会把「专业编辑器不可用」伪装成还能编辑
        setFailure(error instanceof Error ? error.message : String(error))
        setStatus('failed')
      })

    return () => {
      disposed = true
      for (const item of disposables) item.dispose()
      if (editor) {
        const model = editor.getModel()
        if (model) viewStates.set(keyOf(workspaceKey, fileOf(model.uri.path)), editor.saveViewState())
      }
      editor?.dispose()
      editorRef.current = null
      monacoRef.current = null
      selectionRef.current?.({ ok: false, reason: '编辑器已离开原文件，请重新选择。' })
    }
  }, [workspaceKey])

  /* 2. 按当前文件挂 model（切文件 = 换 model，正文与撤销栈留在各自 model 上） */
  useEffect(() => {
    const monaco = monacoRef.current
    const editor = editorRef.current
    if (status !== 'ready' || !monaco || !editor) return
    resetRegistryFor(workspaceKey)

    const previous = editor.getModel()
    if (previous) {
      viewStates.set(keyOf(workspaceKey, fileOf(previous.uri.path)), editor.saveViewState())
    }
    if (fileId === null) {
      editor.setModel(null)
      cursorRef.current(null)
      notifySelection()
      return
    }

    const key = keyOf(workspaceKey, fileId)
    let model = models.get(key)
    if (!model) {
      const uri = monaco.Uri.from({
        scheme: 'xunjie-project',
        authority: encodeURIComponent(workspaceKey),
        path: `/${encodeURIComponent(fileId)}`,
      })
      // model 只拿 LF 显示投影；原文与可逆历史登记在 originals，编辑时打补丁回原文
      const original = initialTextRef.current
      const projection = projectOriginal(original)
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(projection.modelText, language, uri)
      model.setEOL(monaco.editor.EndOfLineSequence.LF)
      originals.set(key, { history: new OriginalEditHistory(original, model.getAlternativeVersionId()), projection })
      models.set(key, model)
    }
    if (model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language)
    }
    editor.setModel(model)
    const saved = viewStates.get(key)
    if (saved) editor.restoreViewState(saved)
    // Returning from a read-only pane can request focus before Monaco has mounted its model.
    // Apply that request only to the same workspace/file, without changing its saved view.
    const requestedFocus = pendingFocus.current
    pendingFocus.current = null
    if (requestedFocus?.workspaceKey === workspaceKey && requestedFocus.fileId === fileId) editor.focus()
    // restoreViewState 可能已发光标事件；不能随后清空刚恢复的行列读数。
    // 首次挂载和位置未变时也主动报告，状态栏与编辑器当前原文位置保持一致。
    const position = editor.getPosition()
    const original = originals.get(key)
    cursorRef.current(position && original
      ? serverPosition(original.history.current, original.projection.toOriginalOffset(model.getOffsetAt(position)))
      : null)
    notifySelection()
  }, [status, workspaceKey, fileId, language])

  // 调用方保留脏草稿；只在其权威原文确实改变时更新同一 model，避免显示陈旧正文却标为一致。
  useEffect(() => {
    if (status !== 'ready' || fileId === null) return
    const key = keyOf(workspaceKey, fileId), model = models.get(key), state = originals.get(key)
    const monaco = monacoRef.current
    if (!model || !state || !monaco || state.history.current === initialText) return
    const projection = projectOriginal(initialText)
    model.setValue(projection.modelText)
    model.setEOL(monaco.editor.EndOfLineSequence.LF)
    originals.set(key, { history: new OriginalEditHistory(initialText, model.getAlternativeVersionId()), projection })
    notifySelection()
  }, [status, workspaceKey, fileId, initialText])

  useEffect(() => {
    const monaco = monacoRef.current, model = editorRef.current?.getModel()
    if (status !== 'ready' || !monaco || !model) return
    for (const registered of models.values()) monaco.editor.setModelMarkers(registered, 'xunjie-editor-diagnostics', [])
    const state = fileId && originals.get(keyOf(workspaceKey, fileId))
    if (!diagnostics || diagnostics.fileId !== fileId || !state || state.history.current !== diagnostics.originalText) return
    const markers: import('monaco-editor/editor/editor.api').editor.IMarkerData[] = []
    for (const issue of diagnostics.diagnostics) {
      const line = issue.line ? diagnostics.originalText.split('\n')[issue.line - 1]?.replace(/\r$/, '') : undefined
      const range = issue.range ?? (line !== undefined && issue.line ? {
        startLine: issue.line, startColumn: 1, endLine: issue.line, endColumn: Math.max(2, line.length + 1),
      } : undefined)
      const offsets = range && codeRangeModelOffsets(diagnostics.originalText, range)
      if (!offsets) continue
      const start = model.getPositionAt(offsets[0]), end = model.getPositionAt(offsets[1])
      markers.push({ startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column,
        message: issue.message, source: issue.range ? '编辑检查' : '编辑检查（整行定位）',
        severity: issue.severity === 'warning' ? monaco.MarkerSeverity.Warning : issue.severity === 'info' ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Error })
    }
    monaco.editor.setModelMarkers(model, 'xunjie-editor-diagnostics', markers)
    return () => { if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'xunjie-editor-diagnostics', []) }
  }, [status, workspaceKey, fileId, initialText, diagnostics])

  /* 3. 只读态跟随工作区可写性变化 */
  useEffect(() => {
    editorRef.current?.updateOptions(editorOptions(readOnly, readOnlyReason))
  }, [readOnly, readOnlyReason])

  if (status === 'failed') {
    return (
      <div className="cw-editor-failed" role="alert">
        <p>代码编辑器不可用</p>
        <p className="cw-editor-failed-detail">{failure}</p>
        <p className="cw-editor-failed-note">
          已保护的正文保留，不会用降级编辑器顶替：排除问题后重新进入即可继续。
        </p>
      </div>
    )
  }

  return (
    <div className="cw-editor-wrap">
      {status === 'loading' && (
        <p className="cw-editor-loading" role="status">
          正在加载代码编辑器…
        </p>
      )}
      <div className="cw-editor" ref={hostRef} aria-label="代码编辑器" />
    </div>
  )
})
