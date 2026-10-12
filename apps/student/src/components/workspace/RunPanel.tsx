import './RunPanel.css'

export interface CoreSelection {
  snapshotId: string
  entryFileId: string
  fileIds: string[]
  operation: 'stats' | 'find' | 'top'
  word: string
  count: string
}
export interface RunSnapshotOption {
  id: string
  label: string
  files: Array<{ id: string; path: string; ascii: boolean }>
}
export interface CoreResultDisplay {
  runId: string
  snapshotId: string
  snapshotHash: string
  snapshotLabel: string
  statusLabel: string
  parameters: string | null
  diagnostics: { stdout?: string; stderr?: string; failureKind?: string; verdict?: string } | null
}
export interface RunPanelProps {
  snapshots: RunSnapshotOption[]
  selection: CoreSelection
  result: CoreResultDisplay | null
  busy: boolean
  canRun: boolean
  notice: string | null
  synthetic: boolean
  /** 06A 纯受控停止/核对：显示条件与异步状态由业务客户端提供。 */
  control?: { canStop: boolean; canReconcile: boolean; busy: boolean; onStop: () => void; onReconcile: () => void }
  onSelect: (selection: CoreSelection) => void
  onRun: () => void
  onRead: () => void
  onReturn: () => void
}

/** 顶栏入口沿用既有运行簇；类名只为窄屏下保持标签、身份标识和操作互不遮挡。 */
export function CoreRunEntry({ onOpen }: { onOpen: () => void }) {
  return <span className="ws-run-actions core-run-entry">
    <button type="button" className="ws-btn ghost" style={{ padding: '0 10px', fontSize: 12 }} onClick={onOpen}>Core 运行</button>
  </span>
}

/** 06 设计交付：纯受控 Core 参数与只读结果。请求、身份、限额和确认由业务调用方负责。 */
export function RunPanel({ snapshots, selection, result, busy, canRun, notice, synthetic, control,
  onSelect, onRun, onRead, onReturn }: RunPanelProps) {
  const fixed = snapshots.find(s => s.id === selection.snapshotId)
  const change = (patch: Partial<CoreSelection>) => onSelect({ ...selection, ...patch })
  return <section className="core-run" aria-label="Core 运行与结果">
    <header className="core-run-head">
      <h2>TextScope Core</h2>
      <button type="button" className="ws-btn ghost" onClick={onReturn}>返回编辑</button>
    </header>
    <p className="core-run-note">{synthetic ? '合成准备运行 · 不编译或执行真实 C 程序。' : '运行已确认的固定快照。'} 后续编辑不会改变这次运行。</p>
    <form className="core-run-form" onSubmit={event => { event.preventDefault(); if (canRun && !busy) onRun() }}>
      <label>确认快照
        <select aria-label="确认快照" value={selection.snapshotId} onChange={e => change({ snapshotId: e.target.value, entryFileId: '', fileIds: [] })}>
          <option value="">请选择已冻结快照</option>
          {snapshots.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <label>C 入口文件
        <select aria-label="C 入口文件" value={selection.entryFileId} onChange={e => change({ entryFileId: e.target.value })}>
          <option value="">请选择入口</option>
          {fixed?.files.filter(f => f.path.endsWith('.c')).map(f => <option key={f.id} value={f.id}>{f.path}</option>)}
        </select>
      </label>
      <label>Core 操作
        <select aria-label="Core 操作" value={selection.operation} onChange={e => change({ operation: e.target.value as CoreSelection['operation'] })}>
          <option value="stats">stats · 统计</option><option value="find">find · 查找</option><option value="top">top · 词频</option>
        </select>
      </label>
      {selection.operation === 'find' && <label>查找词
        <input aria-label="查找词" value={selection.word} onChange={e => change({ word: e.target.value })} autoComplete="off" />
      </label>}
      {selection.operation === 'top' && <label>数量
        <input aria-label="数量" value={selection.count} onChange={e => change({ count: e.target.value })} inputMode="numeric" autoComplete="off" />
      </label>}
      <fieldset className="core-run-inputs">
        <legend>快照输入文件</legend>
        {fixed?.files.map(f => <label key={f.id}>
          <input type="checkbox" disabled={!f.ascii} checked={selection.fileIds.includes(f.id)}
            onChange={e => change({ fileIds: e.target.checked ? [...selection.fileIds, f.id] : selection.fileIds.filter(id => id !== f.id) })} />
          <span>{f.path}{!f.ascii && ' · 不是 ASCII 输入'}</span>
        </label>)}
        {!fixed && <p className="core-run-note">先选择快照，再选择其中的输入文件。</p>}
      </fieldset>
      <div className="core-run-actions">
        <button type="submit" className="ws-btn solid" disabled={!canRun || busy}>{busy ? '正在提交' : '运行此快照'}</button>
        <button type="button" className="ws-btn ghost" onClick={onRead} disabled={busy}>重新读取结果</button>
        {control?.canStop && <button type="button" className="ws-btn ghost" onClick={control.onStop}
          disabled={busy || control.busy}>停止此运行</button>}
        {control?.canReconcile && <button type="button" className="ws-btn ghost" onClick={control.onReconcile}
          disabled={busy || control.busy}>核对原运行请求</button>}
      </div>
    </form>
    {notice && <p className="core-run-notice" role="status">{notice}</p>}
    {result && <section className="core-run-result" aria-label="固定快照结果"
      data-run-id={result.runId} data-snapshot-id={result.snapshotId} data-snapshot-hash={result.snapshotHash}>
      <h3>{result.snapshotLabel}</h3>
      <p role="status" aria-live="polite">{result.statusLabel}</p>
      <p className="core-run-note">{result.parameters === null ? '历史运行参数不可回取' : `本机请求记录 · ${result.parameters}`}</p>
      {result.diagnostics === null ? <p>诊断暂不可回取。</p> : <>
        {result.diagnostics.failureKind && <p>故障：{result.diagnostics.failureKind}</p>}
        {result.diagnostics.verdict && <p>公开检查结果：{result.diagnostics.verdict}</p>}
        {result.diagnostics.stdout !== undefined && <><h3>stdout</h3><pre aria-label="stdout">{result.diagnostics.stdout || '（空输出）'}</pre></>}
        {result.diagnostics.stderr !== undefined && <><h3>stderr</h3><pre aria-label="stderr">{result.diagnostics.stderr || '（空输出）'}</pre></>}
      </>}
      <p className="core-run-note">结果只读，供你修订作品；不作为课程通过或能力评价。</p>
    </section>}
  </section>
}
