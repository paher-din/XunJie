import './RunPanel.css'
import './RunHistoryPanel.css'
import type { RunHelpTarget } from '../../workspace/tutoringRun'

export interface HistoryFileDisplay {
  id: string
  name: string
  status: 'complete' | 'incomplete' | 'missing'
  contentHash?: string
  bytes?: number
  text?: string
}

export interface HistoryRunDisplay {
  runId: string
  jobId: string
  snapshotId: string
  snapshotHash: string
  profile: string
  image: string
  mode: string
  statusLabel: string
  parameters: string | null
  diagnostics: { stdout?: string; stderr?: string; verdict?: string; failureKind?: string } | null
  files: { status: 'redacted' | 'unavailable' } | { status: 'available'; files: HistoryFileDisplay[] } | null
  filesNotice: string | null
}

export interface HistorySideDisplay {
  runId: string
  busy: boolean
  notice: string | null
  result: HistoryRunDisplay | null
}

export interface RunHistoryPanelProps {
  options: Array<{ id: string; label: string }>
  sides: [HistorySideDisplay, HistorySideDisplay]
  busy: boolean
  notice: string | null
  synthetic: boolean
  onSelect: (side: 0 | 1, runId: string) => void
  onRead: () => void
  onReturn: () => void
  onDownload: (side: 0 | 1, fileId: string) => void
  /** 两侧分别携原结果身份，不从当前控件/另一侧结果补引用。 */
  onHelp?: (target: RunHelpTarget) => void
}

/** 06B 纯 props 交付：调用方提供已校验的公开事实，组件只呈现和转交显式操作。 */
export function RunHistoryPanel({ options, sides, busy, notice, synthetic,
  onSelect, onRead, onReturn, onDownload, onHelp }: RunHistoryPanelProps) {
  return <section className="core-run run-history" aria-label="历史运行与产物" aria-busy={busy}>
    <header className="core-run-head">
      <h2>历史运行与产物</h2>
      <div className="core-run-actions">
        <button type="button" className="ws-btn ghost" onClick={onRead}
          disabled={busy}>重新读取历史</button>
        <button type="button" className="ws-btn ghost" onClick={onReturn}>返回运行</button>
      </div>
    </header>
    <p className="core-run-note">{synthetic ? '合成准备运行 · 不编译或执行真实 C 程序。' : '比较已有运行的固定快照与公开结果。'} 历史结果只读，不会写回作品。</p>
    <p className="core-run-note">当前活动未交付 Report 运行能力。</p>
    {busy && <p role="status">正在读取历史运行。</p>}
    {notice && <p className="core-run-notice" role="status">{notice}</p>}
    {options.length === 0 && !busy && <p className="core-run-note">没有可选择的历史运行。</p>}
    <div className="run-history-columns">
      {([0, 1] as const).map(index => {
        const side = sides[index]
        const result = side.result
        const label = index === 0 ? '运行 A' : '运行 B'
        return <section key={index} className="run-history-side" aria-label={label} aria-busy={side.busy}>
          <label className="run-history-select">{label}
            <select aria-label={label} value={side.runId} disabled={busy || options.length === 0}
              onChange={event => onSelect(index, event.target.value)}>
              <option value="">请选择已有运行</option>
              {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          {side.busy && <p role="status">正在读取{label}。</p>}
          {side.notice && <p className="core-run-notice" role="status">{side.notice}</p>}
          {!result && !side.busy && <p className="core-run-note">{side.runId ? '历史结果暂不可回取，请重新读取历史。' : '请选择已有运行。'}</p>}
          {result && <div key={result.runId} className="core-run-result run-history-result"
            data-run-id={result.runId} data-job-id={result.jobId} data-snapshot-id={result.snapshotId} data-snapshot-hash={result.snapshotHash}>
            <p role="status" aria-live="polite">{result.statusLabel}</p>
            {onHelp && <button type="button" className="ws-btn ghost"
              disabled={busy || side.busy || !!side.notice || side.runId !== result.runId || !result.runId || !result.snapshotId}
              onClick={() => onHelp({ runId: result.runId, snapshotId: result.snapshotId })}>就这次运行求助</button>}
            <dl className="run-history-fields">
              <dt>运行 ID</dt><dd>{result.runId}</dd>
              <dt>作业 ID</dt><dd>{result.jobId}</dd>
              <dt>快照 ID</dt><dd>{result.snapshotId}</dd>
              <dt>快照摘要</dt><dd>{result.snapshotHash}</dd>
              <dt>运行配置</dt><dd>{result.profile}</dd>
              <dt>执行镜像</dt><dd>{result.image}</dd>
              <dt>运行模式</dt><dd>{result.mode}</dd>
            </dl>
            {result.parameters ? <><p className="core-run-note">本机请求记录</p><pre aria-label={`${label}参数`}>{result.parameters}</pre></>
              : <p className="core-run-note">历史运行参数不可回取</p>}
            <h3>公开诊断</h3>
            {result.diagnostics === null ? <p className="core-run-note">诊断暂不可回取。</p> : <>
              {result.diagnostics.verdict !== undefined && <p>公开检查结果：{result.diagnostics.verdict}</p>}
              {result.diagnostics.failureKind !== undefined && <p>故障：{result.diagnostics.failureKind}</p>}
              {result.mode === 'run' && <>
                {result.diagnostics.stdout !== undefined && <details>
                  <summary>查看 stdout</summary>
                  <pre aria-label={`${label} stdout`}>{result.diagnostics.stdout || '（空输出）'}</pre>
                </details>}
                {result.diagnostics.stderr !== undefined && <details>
                  <summary>查看 stderr</summary>
                  <pre aria-label={`${label} stderr`}>{result.diagnostics.stderr || '（空输出）'}</pre>
                </details>}
              </>}
            </>}
            <section className="run-history-files" aria-label={`${label}公开结果文件`}>
              <h3>公开结果文件</h3>
              {result.filesNotice && <p className="core-run-notice" role="status">{result.filesNotice}</p>}
              {result.files === null && <p className="core-run-note">产物不可回取。</p>}
              {result.files?.status === 'redacted' && <p className="core-run-note">检查产物已裁剪（redacted），不提供正文或下载。</p>}
              {result.files?.status === 'unavailable' && <p className="core-run-note">产物不可回取（unavailable）。</p>}
              {result.files?.status === 'available' && (result.files.files.length === 0
                ? <p className="core-run-note">没有公开结果文件</p>
                : result.files.files.map(file => <article key={`${file.id}:${file.contentHash ?? ''}`}
                  className="run-history-file" data-result-file-id={file.id}>
                  <h4>{file.name}</h4>
                  <p className="core-run-note">{file.status === 'complete' ? '完整（complete）'
                    : file.status === 'incomplete' ? '文件不完整（incomplete），不提供正文或下载。'
                    : '文件缺失（missing），不提供正文或下载。'}</p>
                  <dl className="run-history-fields">
                    <dt>文件 ID</dt><dd>{file.id}</dd>
                    {file.contentHash !== undefined && <><dt>内容摘要</dt><dd>{file.contentHash}</dd></>}
                    {file.bytes !== undefined && <><dt>字节数</dt><dd>{file.bytes}</dd></>}
                  </dl>
                  {file.status === 'complete' && (file.text !== undefined ? <>
                    <details>
                      <summary>查看 {file.name}</summary>
                      <pre aria-label={`${label} ${file.name} 完整文本`}>{file.text}</pre>
                    </details>
                    <button type="button" className="ws-btn ghost" aria-label={`下载 ${file.name}`}
                      onClick={() => onDownload(index, file.id)} disabled={busy || side.busy}>下载</button>
                  </> : <p className="core-run-note">完整文本暂不可回取，无法查看或下载。</p>)}
                </article>))}
            </section>
          </div>}
        </section>
      })}
    </div>
    <p className="core-run-note">公开输出与产物供你修订作品；不作为课程通过或能力评价。</p>
  </section>
}
