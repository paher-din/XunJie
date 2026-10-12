import { CONFLICT_READ_ONLY_REASON, CompareDiff, CompareReadOnly } from './CompareText'
import type { ComparisonFile, ComparisonSource, WorkspaceComparison } from '../../workspace/comparison'

/**
 * 04A：服务版本冲突的只读比较视图。
 *
 * 三个正文都来自落盘事实（`WorkspaceComparison`），这里只做只读投影，不做任何写操作：
 * 学生在尾部按钮里明确选择之后，由页面调用 ConfirmationWorkspace / useProjectWorkspace 落库。
 * 两个正文面板由 CompareText 提供：diff/单栏 model 都临时创建、卸载时 dispose，不进
 * CodeEditorHost 的模块级注册表，与编辑工作区的正文与撤销栈互不干扰。
 */

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
          <CompareReadOnly path={file.path} text={file.mine} ariaLabel={`本机正文 ${file.path}`}
            readOnlyReason={CONFLICT_READ_ONLY_REASON} />
        </div>
      ) : (
        <div className="ws-compare-body">
          <p className="ws-compare-diff-legend" aria-hidden="true">
            <span>左：本机正文</span>
            <span>右：当前作品</span>
          </p>
          <CompareDiff path={file.path} leftText={file.mine} rightText={file.theirs}
            readOnlyReason={CONFLICT_READ_ONLY_REASON}
            leftLabel="本机正文" rightLabel="当前作品正文" />
        </div>
      )}
    </section>
  )
}

/** 原确认基线只以一行说明出现，不展示全文：界面只回答「上次确认时有没有、有多长」。 */
function baseNote(base: string | null): string {
  return base === null ? '上次确认时还没有这个文件。' : `上次确认的正文：${base.length} 字符。`
}
