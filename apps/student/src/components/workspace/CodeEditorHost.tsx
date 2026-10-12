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

/**
 * 多文件代码编辑器的宿主：一个编辑器实例 + 每个文件实例一个 model。
 *
 * 身份边界（docs/home-design.md 已确认的「布局切换不销毁草稿与运行会话」在这里落到 model 上）：
 * model 按 `workspaceKey` + `fileId` 命名，存在模块级注册表里，因此切换文件、切换中心标签、
 * 拖动分屏都不销毁正文与撤销栈；只有换工作区（换任务 / 换账号 / 换 Attempt）才释放上一批。
 * 路径不参与身份——同名路径被回收后由新实例占用时，旧实例的 model 不会串。
 *
 * 原文权威（契约 §4）：model 只持有 LF 显示投影；BOM 与每个换行分隔符留在 original 里。
 * 每次内容变更用旧投影把显示范围映回原文打补丁，undo/redo 走可逆原文历史，
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
  saveViewState(): void
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
}

export const CodeEditorHost = forwardRef<CodeEditorHandle, CodeEditorHostProps>(function CodeEditorHost(
  { workspaceKey, fileId, language, initialText, readOnly, readOnlyReason, onTextChange, onCursorChange },
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
  useEffect(() => {
    textChangeRef.current = onTextChange
    cursorRef.current = onCursorChange
    initialTextRef.current = initialText
    readOnlyRef.current = { readOnly, readOnlyReason }
  })

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    saveViewState: () => {
      const editor = editorRef.current
      const model = editor?.getModel()
      if (!editor || !model) return
      viewStates.set(keyOf(workspaceKey, fileOf(model.uri.path)), editor.saveViewState())
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

        disposables.push(
          editor.onDidChangeModelContent((event) => {
            const model = editor?.getModel()
            if (!model || event.isFlush) return
            const key = keyOf(workspaceKey, fileOf(model.uri.path))
            const state = originals.get(key)
            if (!state) return
            if (event.isUndoing) {
              state.history.undo()
            } else if (event.isRedoing) {
              state.history.redo()
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
              state.history.push(next)
            }
            state.projection = projectOriginal(state.history.current)
            textChangeRef.current(fileOf(model.uri.path), state.history.current)
          }),
        )
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
      originals.set(key, { history: new OriginalEditHistory(original), projection })
      models.set(key, model)
    }
    if (model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language)
    }
    editor.setModel(model)
    const saved = viewStates.get(key)
    if (saved) editor.restoreViewState(saved)
    cursorRef.current(null)
  }, [status, workspaceKey, fileId, language])

  /* 3. 只读态跟随工作区可写性变化 */
  useEffect(() => {
    editorRef.current?.updateOptions(editorOptions(readOnly, readOnlyReason))
  }, [readOnly, readOnlyReason])

  if (status === 'failed') {
    return (
      <div className="cw-editor-failed" role="alert">
        <p>代码编辑器加载失败</p>
        <p className="cw-editor-failed-detail">{failure}</p>
        <p className="cw-editor-failed-note">
          正文没有被改动，也不会用降级编辑器顶替：修复加载问题后重新进入即可继续。
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
