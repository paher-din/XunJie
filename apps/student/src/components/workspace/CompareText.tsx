import { useEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor/editor/editor.api'
import { projectOriginal } from '../../lib/originalText'
import { languageOf } from '../../lib/projectFiles'
import { editorOptions, loadMonaco, type MonacoEditor, type MonacoModel } from './monacoSetup'

/**
 * 只读比较共用的两个正文面板（05 从 04A 的 ConflictCompare 提取，行为不变）。
 *
 * 两者都只做展示投影：正文经 `projectOriginal` 投成 LF 显示值（BOM 与原有 EOL 留在原文里，
 * 不写回、不重算摘要），model 匿名创建、卸载时连同编辑器一起 dispose，不进 CodeEditorHost
 * 的模块级注册表，也不与编辑工作区的正文和撤销栈互相干扰。
 */

type MonacoModule = typeof import('monaco-editor/editor/editor.api')
type MonacoDiffEditor = editor.IStandaloneDiffEditor

/**
 * 只读输入提示（Monaco 在只读编辑器里尝试输入时显示的那一句）。
 *
 * 必须由调用方给出：04A 的冲突比较下方有「保留本页正文 / 采用服务端正文」两个选择按钮，
 * 05 的版本比较下方只有「返回编辑」。共用一句指向不存在动作的提示会把学生误导到别处。
 */
export type CompareReadOnlyReason = string

/** 04A 冲突比较的只读提示：选择动作在尾部按钮，不在编辑器里。 */
export const CONFLICT_READ_ONLY_REASON = '比较视图只读；在下方选择要保留的正文后才能继续编辑。'
/** 05 版本比较的只读提示：这里只回答问题，改正文要回编辑器。 */
export const VERSION_READ_ONLY_REASON = '版本比较只读；要改正文请先返回编辑。'

export interface CompareDiffProps {
  path: string
  leftText: string
  rightText: string
  /** 左右两侧的名字（例如「本机正文」「当前作品」），只用于可访问名，不参与正文。 */
  leftLabel: string
  rightLabel: string
  /** 在这个比较里尝试输入时显示的只读提示；两个比较视图的动作不同，不能共用一句。 */
  readOnlyReason: CompareReadOnlyReason
  ariaLabel?: string
}

export interface CompareReadOnlyProps {
  path: string
  text: string
  ariaLabel: string
  readOnlyReason: CompareReadOnlyReason
}

/** 双栏 diff：左=leftText，右=rightText。model 临时创建，卸载时 dispose。 */
export function CompareDiff({ path, leftText, rightText, leftLabel, rightLabel, readOnlyReason, ariaLabel }: CompareDiffProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let diffEditor: MonacoDiffEditor | null = null
    const models: MonacoModel[] = []
    void (async () => {
      try {
        const monaco: MonacoModule = await loadMonaco()
        // diff 编辑器的功能注册按需引入：只有比较界面挂载时才加载（monacoSetup 只登记单栏编辑器）
        await import('monaco-editor/features/diffEditor/register')
        if (disposed || !hostRef.current) return
        const language = languageOf(path)
        // 匿名 model（无 URI）：不进 CodeEditorHost 的注册表，也不与工作区 model 撞 URI
        const original = monaco.editor.createModel(projectOriginal(leftText).modelText, language)
        const modified = monaco.editor.createModel(projectOriginal(rightText).modelText, language)
        models.push(original, modified)
        diffEditor = monaco.editor.createDiffEditor(hostRef.current, {
          ...editorOptions(true, readOnlyReason),
          renderSideBySide: true,
          originalAriaLabel: `${leftLabel} ${path}`,
          modifiedAriaLabel: `${rightLabel} ${path}`,
        })
        diffEditor.setModel({ original, modified })
        setStatus('ready')
      } catch (error: unknown) {
        if (disposed) return
        setFailure(error instanceof Error ? error.message : String(error))
        setStatus('failed')
      }
    })()
    return () => {
      disposed = true
      diffEditor?.dispose()
      for (const model of models) model.dispose()
    }
  }, [path, leftText, rightText, leftLabel, rightLabel, readOnlyReason])

  if (status === 'failed') {
    return (
      <div className="ws-compare-failed" role="alert">
        <p>比较视图加载失败</p>
        <p className="cw-editor-failed-detail">{failure}</p>
      </div>
    )
  }
  return (
    <div className="ws-compare-diff">
      {status === 'loading' && (
        <p className="cw-editor-loading" role="status">
          正在加载比较视图…
        </p>
      )}
      <div className="ws-compare-diff-host" ref={hostRef} aria-label={ariaLabel ?? `正文比较 ${path}`} />
    </div>
  )
}

/** 单侧正文的只读展示：model 同样临时创建、卸载时 dispose。 */
export function CompareReadOnly({ path, text, ariaLabel, readOnlyReason }: CompareReadOnlyProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let editor: MonacoEditor | null = null
    let model: MonacoModel | null = null
    void (async () => {
      try {
        const monaco = await loadMonaco()
        if (disposed || !hostRef.current) return
        model = monaco.editor.createModel(projectOriginal(text).modelText, languageOf(path))
        editor = monaco.editor.create(hostRef.current, editorOptions(true, readOnlyReason))
        editor.setModel(model)
        setStatus('ready')
      } catch (error: unknown) {
        if (disposed) return
        setFailure(error instanceof Error ? error.message : String(error))
        setStatus('failed')
      }
    })()
    return () => {
      disposed = true
      editor?.dispose()
      model?.dispose()
    }
  }, [path, text, readOnlyReason])

  if (status === 'failed') {
    return (
      <div className="ws-compare-failed" role="alert">
        <p>正文展示加载失败</p>
        <p className="cw-editor-failed-detail">{failure}</p>
      </div>
    )
  }
  return (
    <div className="ws-compare-read">
      {status === 'loading' && (
        <p className="cw-editor-loading" role="status">
          正在加载正文…
        </p>
      )}
      <div className="ws-compare-read-host" ref={hostRef} aria-label={ariaLabel} />
    </div>
  )
}
