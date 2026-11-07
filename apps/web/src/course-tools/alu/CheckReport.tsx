import { useEffect, useMemo, useState } from 'react'
import { isTerminalExecutionState } from '@xunjie/contracts/execution'
import type { ExecutionRetainedResource } from '@xunjie/contracts/execution'
import type { ExecutionRecord } from '../../tool-execution/ledger'
import type { CheckCounterexample, CounterexampleReason } from '../../tool-execution/adapters/alu-check'
import { checkPassEvidence } from './check-report-reader'

export interface AluCheckReport {
  formatVersion: number
  kind: string
  verdict: 'pass' | 'fail' | 'inconclusive'
  totalInputs: number
  plannedSamples: number
  sampledRows: number
  comparedRows: number
  fullySampledInputs: number
  fullyComparedInputs: number
  reservedInputs: number
  reservedCovered: number
  behaviorErrorInputs: number
  unknownInputs: number
  inconsistentInputs: number
  missingInputs: number
  formatErrors: number
  duplicateRows: number
  outOfRange: number
  roundsCompleted: number
  reasons: string[]
  counterexampleTotal: number
  counterexamples: CheckCounterexample[]
  rounds: Array<{ round: number; precursor: string; sampleTime: number; status: string; rows: number
    invalidRows: number; durationMs: number; vcdBytes: number | null; observationState: string }>
  source: { adapterId: string; adapterVersion: number; bundleIdentity: string; dependencyId: string
    suiteVersion: number; scaffold: { path: string; sha256: string; version: number }
    rule: { version: number; digest: string }; works: Array<{ name: string; contentId: string; sha256: string }> }
  createdAt: string
  reason?: string
}

export interface AluCheckObservations {
  formatVersion: number
  kind: string
  totalInputs: number
  plannedSamples: number
  verdict: string
  rounds: Array<{ round: number; precursor: string; sampleTime: number; status: string
    observationState: string; durationMs: number; rows: Array<[number, string, string]>; invalid: string[] }>
  counterexamples: CheckCounterexample[]
}

const reasonLabel: Record<CounterexampleReason, string> = { behaviour: '行为错误', unknown: '含 X/Z', inconsistent: '跨轮不一致', missing: '缺行' }
const operationLabel: Record<string, string> = { 'run-single': '显式运行', 'observe-enabled': '自由观察', 'check-all': '全部输入检查' }

function download(name: string, text: string, mediaType = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mediaType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function bitText(f: string | null, cout: string | null) {
  if (f === null || cout === null) return '—'
  return `${f} / ${cout}`
}

export function CheckReportTool({ record, active, canStart, report, observations, diagnostics, resources, loading, error,
  onUseInput, onRecheck, onStop, onQuery, onReference, location }: {
  record: ExecutionRecord | undefined
  active: boolean
  canStart: boolean
  report: AluCheckReport | null
  observations: AluCheckObservations | null
  diagnostics: string | null
  resources: ExecutionRetainedResource[]
  loading: boolean
  error: string
  onUseInput: (inputs: CheckCounterexample['inputs']) => void
  onRecheck: () => void
  onStop: () => void
  onQuery: () => void
  onReference?: (counterexample: CheckCounterexample, anchor: HTMLElement) => void
  location?: { index: number; token: string }
}) {
  const [filter, setFilter] = useState<'all' | CounterexampleReason>('all')
  const [page, setPage] = useState(0)
  const terminal = record ? record.query.statusKnowledge === 'confirmed' && isTerminalExecutionState(record.query.state) : false
  const evidenceError = useMemo(() => report?.verdict === 'pass'
    ? checkPassEvidence(report, observations, diagnostics, resources) : '', [report, observations, diagnostics, resources])
  const passConfirmed = !error && !evidenceError && terminal && record?.query.state === 'succeeded'
  const all = (observations?.counterexamples ?? report?.counterexamples ?? []) as CheckCounterexample[]
  const filtered = useMemo(() => filter === 'all' ? all : all.filter(item => item.reasons.includes(filter)), [all, filter])
  const pageSize = 20, pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const current = filtered.slice(page * pageSize, (page + 1) * pageSize)
  useEffect(() => { setPage(0) }, [filter, report, observations])
  useEffect(() => { if (page >= pages) setPage(pages - 1) }, [page, pages])
  useEffect(() => {
    if (!location) return
    const position = all.findIndex(item => item.index === location.index)
    if (position < 0) return
    setFilter('all'); setPage(Math.floor(position / pageSize))
  }, [location, report, observations])
  if (!record) {
    return <section className="alu-check" aria-label="全量行为检查">
      <header className="alu-section-head"><div><h2>全量行为检查</h2><p>检查已启用作品的全部 4096 组公开输入。</p></div>
        <button type="button" className="ws-btn solid" disabled={!canStart} onClick={onRecheck}>检查全部输入</button></header>
      <p className="alu-hint">{canStart
        ? '尚未检查。覆盖全部 4096 组输入，含 1536 组保留控制组合；完成前不会显示通过。'
        : '先点「运行」启用作品。尚无启用依据时不会自动检查，也不会对当前编辑中的代码推断通过。'}</p>
    </section>
  }
  const stateLabel = active ? (record.query.statusKnowledge === 'unknown' ? '检查状态待核实' : record.query.state === 'queued' ? '已接收，等待执行槽' : '正在检查已启用作品…')
    : record.query.state === 'succeeded' ? '检查执行完成' : record.query.state === 'cancelled' ? '检查已停止' : record.query.state === 'failed' ? '检查未完成' : '检查记录'
  return <section className="alu-check" aria-label="全量行为检查" data-check-request-id={record.requestId}>
    <header className="alu-section-head">
      <div><h2>全量行为检查</h2><p>覆盖全部 4096 组输入，含 1536 组保留控制组合；四轮真实采样，不以执行完成代替检查通过。</p></div>
      <div className="alu-check-actions">
        {active && <button type="button" className="ws-btn ghost" onClick={onStop}>停止检查</button>}
        {active && <button type="button" className="ws-btn ghost" onClick={onQuery}>核对状态</button>}
        <button type="button" className="ws-btn solid" disabled={active || !canStart} onClick={onRecheck}>{report ? '再次检查' : '检查全部输入'}</button>
      </div>
    </header>
    <p className="alu-check-state" role="status">{stateLabel}
      {record.query.statusKnowledge === 'unknown' ? '；原请求仍保留，不确定时不会自动重跑。' : ''}</p>
    {record.query.reason && <p role="alert" className="alu-alert">{record.query.reason.detail}</p>}
    {error && <p role="alert" className="alu-alert">{error}</p>}
    {evidenceError && evidenceError !== error && <p role="alert" className="alu-alert">{evidenceError}</p>}
    {loading && <p className="alu-hint">正在读取原检查报告与四轮原始行…</p>}
    {active && !report && <div className="alu-check-progress">
      <p>检查已接收。完成前不推算轮次或进度，也不会用计划行数冒充已确认采样。</p>
      {record.query.stopRequested && <p>已请求停止；确认 Worker 终止后才显示「检查已停止」。</p>}
    </div>}
    {report && <>
      <div className={`alu-verdict alu-verdict-${report.verdict === 'pass' && !passConfirmed ? 'inconclusive' : report.verdict}`} role="status">
        <b>{!passConfirmed && report.verdict === 'pass' ? '检查结果未完整核实，不能显示通过'
          : report.verdict === 'pass' ? '4096 组检查通过'
          : report.verdict === 'fail' ? (report.unknownInputs ? '检查未通过：输出含 X/Z' : report.inconsistentInputs ? '检查未通过：同一输入结果不一致' : '检查未通过：发现行为错误')
          : '检查不完整'}</b>
        <span>{report.reasons?.slice(0, 3).join('；')}</span>
      </div>
      <dl className="alu-check-counts">
        <div><dt>唯一输入</dt><dd>{report.totalInputs}</dd></div>
        <div><dt>计划目标采样</dt><dd>{report.plannedSamples}</dd></div>
        <div><dt>实际合法采样行</dt><dd>{report.sampledRows}</dd></div>
        <div><dt>二值比较行</dt><dd>{report.comparedRows}</dd></div>
        <div><dt>四轮完整输入</dt><dd>{report.fullySampledInputs}/{report.totalInputs}</dd></div>
        <div><dt>四轮二值已比较</dt><dd>{report.fullyComparedInputs}/{report.totalInputs}</dd></div>
        <div><dt>保留组合覆盖</dt><dd>{report.reservedCovered}/{report.reservedInputs}</dd></div>
        <div><dt>行为错误输入</dt><dd>{report.behaviorErrorInputs}</dd></div>
        <div><dt>含 X/Z 输入</dt><dd>{report.unknownInputs}</dd></div>
        <div><dt>跨轮不一致</dt><dd>{report.inconsistentInputs}</dd></div>
        <div><dt>缺行输入</dt><dd>{report.missingInputs}</dd></div>
        <div><dt>格式/重复/越界</dt><dd>{report.formatErrors} / {report.duplicateRows} / {report.outOfRange}</dd></div>
      </dl>
      <p className="alu-hint">检查对应上次运行的作品；再次修改代码不会让这份报告为当前代码背书。完整但错误的检查是“未通过”，缺行或未完成是“不完整”，都不显示通过。</p>
      <details className="alu-rounds"><summary>四轮采样条件与结果</summary>
        <table><thead><tr><th>轮次</th><th>前驱</th><th>采样</th><th>状态</th><th>行数</th><th>格式错误</th><th>耗时</th><th>VCD</th></tr></thead>
          <tbody>{report.rounds?.map(round => <tr key={round.round}>
            <td>{round.round + 1}</td><td>{round.precursor}</td><td>T{round.sampleTime}</td><td>{round.status}</td>
            <td>{round.rows}</td><td>{round.invalidRows}</td><td>{round.durationMs} ms</td>
            <td>{round.vcdBytes === null ? '未取得' : `${Math.round(round.vcdBytes / 1024)} KiB`}</td>
          </tr>)}</tbody></table>
      </details>
      <div className="alu-counterexamples">
        <div className="alu-counter-head">
          <h3>反例</h3>
          <span>显示 {filtered.length ? page * pageSize + 1 : 0}–{Math.min(filtered.length, (page + 1) * pageSize)} / {filtered.length} 条
            {report.counterexampleTotal > all.length ? `（仅载入前 ${all.length} 条，完整资源暂不可读）` : ''}</span>
        </div>
        <div className="alu-filter" role="group" aria-label="反例筛选">
          {(['all', 'behaviour', 'unknown', 'inconsistent', 'missing'] as const).map(value =>
            <button key={value} type="button" className={filter === value ? 'ws-btn solid' : 'ws-btn ghost'}
              aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? '全部' : reasonLabel[value]}</button>)}
        </div>
        {current.length === 0 ? <p className="alu-hint">{all.length ? '当前筛选没有反例。' : '没有可读取的反例；若检查不完整，不能据此声称“没有错误”。'}</p>
          : <ol className="alu-counter-list">{current.map(item => <li key={item.index} data-alu-counterexample-index={item.index} tabIndex={-1}>
            <div className="alu-counter-title"><b>index {item.index}</b>
              <span>{item.reasons.map(reason => reasonLabel[reason]).join(' · ')}</span></div>
            <p className="alu-mono">A={item.inputs.A} B={item.inputs.B} M={item.inputs.M} S={item.inputs.S} Cin={item.inputs.Cin}</p>
            <p>预期 F/Cout：<span className="alu-mono">{bitText(item.expected.f, item.expected.cout)}</span>（来自公开规则，不驱动板卡）</p>
            <ul className="alu-counter-rounds">{item.rounds.map(round => <li key={round.round}>
              <span>{round.precursor}/T{round.sampleTime}</span>
              <span className="alu-mono">{bitText(round.f, round.cout)}</span>
              <span>{round.state === 'binary' ? '二值' : round.state === 'unknown' ? '含 X/Z' : round.state === 'missing' ? '缺行' : '格式错误'}</span>
            </li>)}</ul>
            <button type="button" className="ws-btn ghost" onClick={() => onUseInput(item.inputs)}>将该输入用于实验</button>
            {onReference && <button type="button" className="ws-btn ghost"
              onClick={event => onReference(item, event.currentTarget)}>反例加入问题</button>}
          </li>)}</ol>}
        {pages > 1 && <div className="alu-pager">
          <button type="button" className="ws-btn ghost" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>上一页</button>
          <span>{page + 1} / {pages}</span>
          <button type="button" className="ws-btn ghost" disabled={page + 1 >= pages} onClick={() => setPage(value => Math.min(pages - 1, value + 1))}>下一页</button>
        </div>}
      </div>
      <details className="alu-sources"><summary>报告来源与保留资源</summary>
        <p className="alu-mono">request {record.requestId} · execution {record.executionRef}</p>
        <p>Adapter {report.source?.adapterId}@{report.source?.adapterVersion} · 套件 v{report.source?.suiteVersion}
          · 规则 {report.source?.rule?.digest?.slice(0, 12)}… · 支架 {report.source?.scaffold?.path}（{report.source?.scaffold?.sha256?.slice(0, 12)}…）</p>
        <p>作品文件：{report.source?.works?.map(work => `${work.name} ${work.sha256.slice(0, 10)}…`).join('；')}</p>
        <div className="alu-resource-actions">
          <button type="button" className="ws-btn ghost" onClick={() => download('check-report.json', JSON.stringify(report, null, 2), 'application/json')}>下载 check-report.json</button>
          {observations && <button type="button" className="ws-btn ghost" onClick={() => download('check-observations.json', JSON.stringify(observations), 'application/json')}>下载 check-observations.json</button>}
          {resources.filter(resource => resource.name === 'check-traces.json').map(resource => <button key={resource.contentId} type="button" className="ws-btn ghost"
            onClick={() => download(resource.name, resource.text, resource.mediaType)}>下载 check-traces.json</button>)}
          {diagnostics !== null && <button type="button" className="ws-btn ghost" onClick={() => download('diagnostics.txt', diagnostics)}>下载 diagnostics.txt</button>}
        </div>
        {diagnostics !== null && <details><summary>诊断文本</summary><pre>{diagnostics.slice(0, 4000)}{diagnostics.length > 4000 ? '\n…（完整内容请下载）' : ''}</pre></details>}
        <details><summary>该次运行的只读代码依据</summary>
          {record.action.protocolVersion === 3 && record.action.execution.basis.works.filter(file => file.kind === 'code').map(file =>
            <details key={file.contentId}><summary>{file.name}</summary><pre>{file.value}</pre></details>)}
        </details>
      </details>
    </>}
    {!report && !loading && !active && terminal && record.query.state === 'succeeded' &&
      <p role="alert" className="alu-alert">执行已完成，但原报告资源不可读或摘要损坏；未把执行完成改写为检查通过。</p>}
    {!report && !loading && !active && terminal && record.query.state !== 'succeeded' &&
      <p role="alert" className="alu-alert">{record.query.reason?.detail ?? '检查未完成，保留原请求与状态，不会自动重跑。'}</p>}
    <p className="alu-hint">操作：{operationLabel[record.action.execution.operation.operationId] ?? record.action.execution.operation.operationId}
      · 提交于 {new Date(record.createdAt).toLocaleString('zh-CN')}</p>
  </section>
}
