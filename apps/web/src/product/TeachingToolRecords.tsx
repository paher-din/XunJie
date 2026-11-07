import { useRef, useState, type ReactNode } from 'react'
import type { TeachingToolRecord } from '@xunjie/contracts/teaching-agent'
import { executionQuerySchema, isTerminalExecutionState } from '@xunjie/contracts/execution'
import { teachingSkillLoadedSchema } from '@xunjie/contracts/agent-skills'
import { stateLabel } from '../tool-execution/ledger'
import type { LocateResult } from '../components/workspace/references/model'
import './teaching-tool-records.css'

export type TeachingToolLocator = (record: TeachingToolRecord) => LocateResult | Promise<LocateResult>

const outcomeLabels = {
  'not-dispatched': '未派发', accepted: '已接受，等待结果', completed: '已完成',
  failed: '执行失败', unknown: '效果未知',
}
const stateLabels = {
  prepared: '准备中，尚未派发', dispatching: '正在派发，等待回执',
  waiting: '等待核对结果', settled: '结果尚未确认',
}
const toolLabels: Record<string, string> = {
  read_work: '读取作品', read_reference: '读取引用', read_material: '读取材料', read_result: '读取结果',
  course_operation: '课程操作', execution_query: '核对执行', execution_stop: '停止执行',
  skill_load: '加载 Skill', skill_read: '读取 Skill 文件',
}
const sourceLabels: Record<string, string> = {
  'fixed-current': '本次使用固定时的当前版本。',
  'older-version': '本次使用已固定的旧版本，后续编辑不会改变这份依据。',
  'fixed-unpublished': '本次内容已固定，尚未发布到作品。',
  missing: '固定来源缺失。', corrupt: '固定来源无法通过内容校验。', unavailable: '固定来源暂不可用。',
}
const fieldLabels: Record<string, string> = {
  parameters: '参数', groupColumn: '分组列', valueColumn: '数值列', aggregate: '聚合方式',
  table: '表格', columns: '列', rows: '行', groups: '分组', key: '分组名', value: '内容', file: '固定作品',
  count: '数量', sum: '合计', mean: '平均值', min: '最小值', max: '最大值', rejected: '未参与计算的行',
  name: '名称', text: '文本', content: '内容', copy: '固定副本', works: '作品', references: '引用',
  state: '状态', output: '输出', result: '结果', reason: '原因', detail: '详情', error: '错误',
  observation: '实际观察', observations: '观察记录', session: '会话', appliedSeq: '已应用输入序号',
  message: '说明', line: '行号', column: '列号', path: '路径', diagnostics: '诊断',
  operationId: '操作', componentKey: '组件', contentId: '内容版本', requestId: '原请求', expectedSeq: '预期输入序号',
  query: '执行记录', confirmedSeq: '状态序号', stopRequested: '已请求停止', artifact: '结果文件',
  stoppedExecution: '原执行停止结果', cleanupCompleted: '已确认停止', sessionStopped: '会话已停止', stopId: '停止请求',
  loaded: '已读取的 Skill', skillId: 'Skill 身份', version: '固定版本', packageVersion: '包版本', source: '来源',
  packageDigest: '包摘要', digest: '内容摘要', originalDigest: '原文件摘要', encoding: '编码', mediaType: '文件类型', byteLength: '本次读取字节数',
  offset: '起始字节', totalByteLength: '文件总字节数', complete: '已读取完整文件',
}

function learningResult(result: Record<string, unknown>) {
  const query = executionQuerySchema.safeParse(result.query)
  const visible = Object.fromEntries(Object.entries(result).filter(([key]) =>
    !['retained', 'isCurrent', 'everPublished', 'currentRevision', 'sourceState', 'operationCompleted', 'sessionOngoing'].includes(key)))
  if (!query.success) return visible
  return { ...visible, query: { state: stateLabel(query.data),
    ...(query.data.output ? { output: query.data.output } : {}),
    ...(query.data.reason ? { reason: query.data.reason } : {}),
    ...(query.data.session ? { session: query.data.session } : {}) } }
}

/** Readable, lossless details: large originals remain scrollable rather than silently clipped. */
function ToolValue({ value }: { value: unknown }) {
  if (value === null) return <span>无</span>
  if (Array.isArray(value)) return value.length
    ? <ol className="teaching-tool-values">{value.map((item, index) => <li key={index}><ToolValue value={item} /></li>)}</ol>
    : <span>空列表</span>
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    const entries = typeof object.objectId === 'string' && typeof object.contentId === 'string' && typeof object.value === 'string'
      ? ['name', 'value', 'contentId'].filter(key => key in object).map(key => [key, object[key]] as const)
      : Object.entries(object)
    return entries.length ? <dl className="teaching-tool-fields">{entries.map(([key, item]) =>
      <div key={key}><dt>{key === 'value' && typeof item === 'number' ? '数值' : fieldLabels[key] ?? key}</dt><dd><ToolValue value={item} /></dd></div>)}</dl> : <span>无</span>
  }
  return <span className="preserve-lines">{String(value)}</span>
}

function ToolDetails({ label, value }: { label: ReactNode; value: unknown }) {
  const [open, setOpen] = useState(false)
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>
    {open && <div className="teaching-tool-data"><ToolValue value={value} /></div>}
  </details>
}

function ToolRecord({ record, onLocate }: { record: TeachingToolRecord; onLocate?: TeachingToolLocator }) {
  const [notice, setNotice] = useState('')
  const [locating, setLocating] = useState(false)
  const title = toolLabels[record.name] ?? record.name
  const skillTool = record.name === 'skill_load' || record.name === 'skill_read'
  const loaded = teachingSkillLoadedSchema.safeParse(skillTool ? record.result?.loaded : undefined)
  const skillSource = useRef<HTMLDetailsElement>(null)
  const query = executionQuerySchema.safeParse(record.result?.query)
  const cleanup = record.result?.stoppedExecution as Record<string, unknown> | undefined
  const stopped = executionQuerySchema.safeParse(cleanup?.query)
  const cancelled = record.name !== 'execution_stop' && record.outcome !== 'completed'
    && (record.result?.cancelled === true || query.success && query.data.statusKnowledge === 'confirmed' && query.data.state === 'cancelled')
  const sessionStopped = stopped.success && stopped.data.statusKnowledge === 'confirmed' && isTerminalExecutionState(stopped.data.state)
  const label = cancelled ? '已取消' : record.outcome === 'completed' && record.result?.sessionOngoing === true
    ? sessionStopped ? '操作完成，会话已停止' : cleanup ? '操作完成，正在停止会话' : '操作完成，会话仍在运行'
    : record.outcome ? outcomeLabels[record.outcome] : stateLabels[record.state]
  const locate = async () => {
    if (loaded.success && skillSource.current) {
      skillSource.current.open = true
      skillSource.current.querySelector('summary')?.focus()
      skillSource.current.scrollIntoView({ block: 'nearest' })
      return
    }
    if (!onLocate) return
    setLocating(true); setNotice('')
    try {
      const result = await onLocate(record)
      if (!result.ok) setNotice(result.reason)
    } catch { setNotice('当前无法定位原来源，固定依据和结果仍保留。') }
    finally { setLocating(false) }
  }
  return <details className="teaching-tool-record" data-outcome={record.outcome ?? record.state}
    data-command-id={record.commandId} data-run-id={record.runId}>
    <summary>
      <span className="teaching-tool-title">{title}{record.source?.label ? ` · ${record.source.label}` : ''}</span>
      <span className="teaching-tool-status">{label}</span>
    </summary>
    <div className="teaching-tool-body">
      <p className="teaching-tool-name">{record.name}</p>
      {typeof record.result?.sourceState === 'string' && sourceLabels[record.result.sourceState] &&
        <p>{sourceLabels[record.result.sourceState]}</p>}
      {record.feedback && <ToolDetails label="工具反馈" value={record.feedback} />}
      <ToolDetails label="参数" value={record.arguments} />
      <ToolDetails label="固定依据" value={Object.fromEntries(Object.entries(record.basis).filter(([key]) => key !== 'scope'))} />
      {record.result !== null && <ToolDetails label={record.outcome === 'failed' ? '错误与实际结果' : '实际结果'} value={learningResult(record.result)} />}
      {loaded.success && <details ref={skillSource} className="teaching-skill-source">
        <summary>固定 Skill 来源 · v{loaded.data.version} · {loaded.data.path}</summary>
        <p>{loaded.data.source} · {loaded.data.packageVersion}</p>
        <p className="detail">字节范围：{loaded.data.offset}–{loaded.data.offset + loaded.data.byteLength} / {loaded.data.totalByteLength}
          {' · '}{loaded.data.complete ? '已读取完整文件' : '本次读取片段'} · {loaded.data.encoding}</p>
        <pre className="teaching-tool-data preserve-lines">{loaded.data.content}</pre>
      </details>}
      {record.source && <div className="teaching-tool-source">
        <span>来源：{record.source.label}</span>
        {(loaded.success || onLocate && !skillTool) &&
          <button type="button" className="outline" disabled={locating} onClick={() => void locate()}>
            {loaded.success ? '查看固定 Skill 来源' : record.source.requestId ? '定位原结果' : '定位来源'}</button>}
      </div>}
      {notice && <p role="status" className="teaching-tool-notice">{notice}</p>}
    </div>
  </details>
}

export function TeachingToolRecords({ records, onLocate }: { records: TeachingToolRecord[]; onLocate?: TeachingToolLocator }) {
  if (!records.length) return null
  return <div className="teaching-tool-records" aria-label="工具记录">
    {records.map(record => <ToolRecord key={record.commandId} record={record} onLocate={onLocate} />)}
  </div>
}
