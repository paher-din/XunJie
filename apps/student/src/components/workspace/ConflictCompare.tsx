import { useEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor/editor/editor.api'
import { projectOriginal } from '../../lib/originalText'
import { languageOf } from '../../lib/projectFiles'
import { editorOptions, loadMonaco, type MonacoEditor, type MonacoModel } from './monacoSetup'
import type { ComparisonFile, ComparisonSource, WorkspaceComparison } from '../../workspace/comparison'

/**
 * 04A：服务版本冲突的只读比较视图。
 *
 * 三个正文都来自落盘事实（`WorkspaceComparison`），这里只做只读投影，不做任何写操作：
 * 学生在尾部按钮里明确选择之后，由页面调用 ConfirmationWorkspace / useProjectWorkspace 落库。
 * diff model 临时创建、卸载时 dispose；不进 CodeEditorHost 的模块级注册表（不用 xunjie-project
 * scheme），与编辑工作区的正文与撤销栈互不干扰。
 */

type MonacoModule = typeof import('monaco-editor/editor/editor.api')
type MonacoDiffEditor = editor.IStandaloneDiffEditor

/** 比较视图整体只读；选择动作在尾部按钮，不在编辑器里。 */
const COMPARE_READ_ONLY_REASON = '比较视图只读；在下方选择要保留的正文后才能继续编辑。'

const SOURCE_NOTES: Record<ComparisonSource, string> = {
  'version-conflict': '这份作品在另一处保存过。比较后选择保留哪一份；选择后需要重新发起保存。',
  recovery: '工作区已重新载入。比较你本机的正文与当前作品后再决定。',
  unresolved: '上次保存的结果还没有确认。比较本机冻结的正文与当前作品后再决定。',
}

export interface ConflictCompareProps {
  comparison: WorkspaceComparison
  busy: boolean
  /** 未决/租约/本机未完成等结论必须走核对，不能在这里丢弃：此时不显示选择按钮。 */
  resolvable: boolean
  onReturn: () => void
  /** 保留本页正文：不改动草稿，退役冲突原命令。 */
  onKeepMine: () => void
  /** 采用服务端正文：先把服务正文写回草稿（页面负责），再退役冲突原命令。 */
  onAdoptServer: () => void
}

export function ConflictCompare({ comparison, busy, resolvable, onReturn, onKeepMine, onAdoptServer }: ConflictCompareProps) {
  return (
    <div className="ws-compare" data-source={comparison.source}>
      <p className="ws-compare-note">{SOURCE_NOTES[comparison.source]}</p>
      <div className="ws-compare-files">
        {comparison.files.map((file) => (
          <CompareFile key={file.localId} file={file} />
        ))}
      </div>
      <div className="ws-compare-actions">
        <button type="button" className="outline" onClick={onReturn}>
          返回编辑
        </button>
        {resolvable && (
          <>
            <button type="button" className="primary" onClick={onKeepMine} disabled={busy}>
              保留本页正文
            </button>
            <button type="button" className="primary" onClick={onAdoptServer} disabled={busy}>
              采用服务端正文
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** 每个文件一节：节头（路径 + 基线说明）+ 只读 diff（或本机新建时的只读展示）。 */
function CompareFile({ file }: { file: ComparisonFile }) {
  return (
    <section className="ws-compare-file" data-path={file.path}>
      <header className="ws-compare-file-head">
        <span className="ws-compare-file-path">{file.path}</span>
        <span className="ws-compare-file-base">{baseNote(file.base)}</span>
      </header>
      {file.theirs === null ? (
        // 本机新建、服务端还没有：没有可对比的双方，只给本机原文的只读展示
        <div className="ws-compare-body" data-missing="theirs">
          <p className="ws-compare-missing">服务端还没有这个文件。</p>
          <ReadOnlyText path={file.path} text={file.mine} ariaLabel={`本机正文 ${file.path}`} />
        </div>
      ) : (
        <div className="ws-compare-body">
          <p className="ws-compare-diff-legend" aria-hidden="true">
            <span>左：本机正文</span>
            <span>右：当前作品</span>
          </p>
          <DiffText path={file.path} mine={file.mine} theirs={file.theirs} />
        </div>
      )}
    </section>
  )
}

/** 原确认基线只以一行说明出现，不展示全文：界面只回答「上次确认时有没有、有多长」。 */
function baseNote(base: string | null): string {
  return base === null ? '上次确认时还没有这个文件。' : `上次确认的正文：${base.length} 字符。`
}

/** 双栏 diff：左=本机正文（mine），右=当前作品（theirs）。model 临时创建，卸载时 dispose。 */
function DiffText({ path, mine, theirs }: { path: string; mine: string; theirs: string }) {
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
        const original = monaco.editor.createModel(projectOriginal(mine).modelText, language)
        const modified = monaco.editor.createModel(projectOriginal(theirs).modelText, language)
        models.push(original, modified)
        diffEditor = monaco.editor.createDiffEditor(hostRef.current, {
          ...editorOptions(true, COMPARE_READ_ONLY_REASON),
          renderSideBySide: true,
          originalAriaLabel: `本机正文 ${path}`,
          modifiedAriaLabel: `当前作品正文 ${path}`,
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
  }, [path, mine, theirs])

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
      <div className="ws-compare-diff-host" ref={hostRef} aria-label={`正文比较 ${path}`} />
    </div>
  )
}

/** 本机新建文件的只读展示：单栏只读编辑器，model 同样临时创建、卸载时 dispose。 */
function ReadOnlyText({ path, text, ariaLabel }: { path: string; text: string; ariaLabel: string }) {
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
        editor = monaco.editor.create(hostRef.current, editorOptions(true, COMPARE_READ_ONLY_REASON))
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
  }, [path, text])

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
