import { memo, useState, type ReactNode } from 'react'
import { toast } from '@xunjie/ui/feedback'
import type { TeachingToolRecord as FullTeachingToolRecord } from '@xunjie/contracts/teaching-agent'
import { executionQuerySchema, isTerminalExecutionState } from '@xunjie/contracts/execution'
import { teachingSkillLoadedSchema } from '@xunjie/contracts/agent-skills'
import { materialSearchResultSchema } from '@xunjie/contracts/personal-materials'
import { studentFactsReadResultSchema } from '@xunjie/contracts/student-facts'
import { stateLabel } from '../tool-execution/ledger'
import type { LocateResult } from '../components/workspace/references/model'
import { type IconName } from '@xunjie/ui/icons'
import { AgentTrace, AgentTraceItem } from '@xunjie/ui/chat'
import './teaching-tool-records.css'

export type TeachingToolRecordView = Pick<FullTeachingToolRecord, 'commandId' | 'runId' | 'name' | 'state' | 'outcome' | 'result' | 'feedback' | 'arguments' | 'basis' | 'source'>
type TeachingToolRecord = TeachingToolRecordView
export type TeachingToolLocator = (record: TeachingToolRecord) => LocateResult | Promise<LocateResult>

const outcomeLabels = {
  'not-dispatched': '尚未开始', accepted: '处理中', completed: '已完成',
  failed: '未完成', unknown: '待确认',
}
const stateLabels = {
  prepared: '准备中', dispatching: '进行中',
  waiting: '等待结果', settled: '结果已记录',
}
const toolLabels: Record<string, string> = {
  read_work: '查看作品', read_reference: '查看引用', read_material: '查看课程材料',
  read_personal_material: '查看个人笔记', read_result: '查看实验结果',
  course_operation: '运行课程实验', execution_stop: '停止课程实验',
  skill_load: '使用技能', skill_read: '查看技能资料', read_teaching_artifact: '查看学习页面',
  read_pdf: '查看 PDF', read_pdf_text: '继续阅读 PDF', find_pdf: '查找 PDF 内容',
  search_materials: '查找学习材料', read_student_facts: '查看学习偏好',
  discover_tools: '查找可用工具', load_tools: '准备工具', read_tool_result: '读取工具结果', execution_query: '查看实验状态',
  student_ask: '向你提问', discover_skills: '查找可用技能', list_materials: '查看资料列表',
  read_pdf_images: '查看 PDF 页面', create_workspace: '创建学习项目',
  list_learning_activities: '查看学习项目', read_learning_activity: '了解项目进展',
  list_courses: '查看课程', read_course: '查看课程内容',
  read_course_task: '查看发布任务', list_design_materials: '查看公开材料列表', read_design_material: '阅读公开材料',
}

function toolIcon(name: string): IconName {
  if (name === 'student_ask') return 'chat-round-dots'
  if (name.startsWith('skill_')) return 'skill'
  if (name === 'read_student_facts') return 'user-rounded'
  if (name === 'search_materials' || name === 'discover_tools' || name.startsWith('find_')) return 'minimalistic-magnifier'
  if (name.startsWith('execution_') || name === 'course_operation') return 'code-square'
  return 'clipboard-text'
}

export function isStudentVisibleTool(name: string) {
  return name.length > 0
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function primaryValue(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  const object = objectValue(value)
  return object ? textValue(object.value) ?? (typeof object.value === 'number' ? String(object.value) : undefined) : undefined
}

function skillName(record: TeachingToolRecord) {
  const loaded = teachingSkillLoadedSchema.safeParse(record.result?.loaded)
  if (!loaded.success || loaded.data.encoding !== 'utf8') return undefined
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(loaded.data.content)?.[1]
  return frontmatter && /^name:\s*["']?([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)["']?\s*$/mu.exec(frontmatter)?.[1]
}

function studentTarget(record: TeachingToolRecord) {
  const result = record.result ?? {}, file = objectValue(result.file), reading = objectValue(result.reading)
  const reference = objectValue(result.reference), source = objectValue(result.source)
  if (record.name === 'search_materials') return textValue(record.arguments.query)
  if (record.name === 'read_work') return textValue(file?.name)
  if (record.name === 'read_course_task') return textValue(result.taskTitle)
  if (record.name === 'read_design_material') return textValue(result.title)
  if (record.name === 'read_material') return textValue(source?.name) ?? textValue(source?.title)
  if (record.name === 'read_personal_material' || record.name === 'read_reference') {
    return textValue(result.name) ?? textValue(reference?.sourceName)
  }
  if (['read_pdf', 'read_pdf_text', 'find_pdf'].includes(record.name)) return textValue(reading?.documentName)
  if (record.name.startsWith('skill_')) return skillName(record)
  return undefined
}

function studentToolTitle(record: TeachingToolRecord) {
  const label = toolLabels[record.name] ?? '完成学习操作'
  const target = studentTarget(record)
  return target ? `${label} · ${target}` : label
}

function cancelledRecord(record: TeachingToolRecord) {
  const query = executionQuerySchema.safeParse(record.result?.query)
  return record.name !== 'execution_stop' && record.outcome !== 'completed'
    && (record.result?.cancelled === true || query.success && query.data.statusKnowledge === 'confirmed' && query.data.state === 'cancelled')
}

function studentStatus(record: TeachingToolRecord) {
  if (cancelledRecord(record)) return '已停止'
  if (record.outcome === 'completed' && record.result?.sessionOngoing === true) return '实验进行中'
  return record.outcome ? outcomeLabels[record.outcome] : stateLabels[record.state]
}

function StudentNote({ children }: { children: ReactNode }) {
  return <p className="teaching-tool-summary">{children}</p>
}

function StudentExcerpt({ children }: { children: string }) {
  return <pre className="teaching-tool-excerpt">{children}</pre>
}

function failedStudentNote(record: TeachingToolRecord) {
  const sourceState = record.result?.sourceState
  if (sourceState === 'missing') return '需要读取的内容暂时找不到了。'
  if (sourceState === 'corrupt') return '需要读取的内容已损坏，暂时无法使用。'
  if (sourceState === 'unavailable') return '这份内容暂时无法读取，可以稍后重试。'
  return '这次操作没有完成，已有内容仍然保留。'
}

function StudentToolResult({ record }: { record: TeachingToolRecord }) {
  if (record.outcome === 'failed') return <StudentNote>{failedStudentNote(record)}</StudentNote>
  if (record.name === 'read_course_task' && record.result?.status === 'missing') return <StudentNote>没有找到匹配的发布任务。</StudentNote>
  if (record.name === 'read_course_task' && record.result?.status === 'ambiguous') {
    const candidates = Array.isArray(record.result.candidates) ? record.result.candidates : []
    return <StudentNote>找到 {candidates.length}{record.result.more ? ' 条以上' : ' 条'}匹配的任务发布，请确认要查看哪一版。</StudentNote>
  }
  if (record.name === 'list_design_materials') {
    const titles = Array.isArray(record.result?.materials)
      ? record.result.materials.flatMap(item => textValue(objectValue(item)?.title) ?? []) : []
    return <StudentNote>{titles.length ? titles.join('、') : '这次没有返回公开材料。'}</StudentNote>
  }
  if (record.name === 'read_design_material' && record.result?.status === 'unsupported-format')
    return <StudentNote>当前无法作为文本读取这份材料。</StudentNote>
  if (record.name === 'read_design_material' || record.name === 'read_course_task') {
    const content = record.name === 'read_course_task' ? objectValue(record.result?.requirements)?.text : record.result?.text
    const excerpt = textValue(content)
    return excerpt ? <StudentExcerpt>{excerpt}</StudentExcerpt> : null
  }
  if (record.name === 'student_ask') return <StudentNote>已在对话中提出问题，可在对应的问题卡片中查看和回应。</StudentNote>
  if (record.outcome && !['completed', 'unknown'].includes(record.outcome))
    return <StudentNote>{record.outcome === 'accepted' ? '正在等待结果。' : '这项操作还没有开始。'}</StudentNote>

  if (record.outcome === 'completed' && record.name === 'discover_tools') return <StudentNote>已找到适合本次任务的工具。</StudentNote>
  if (record.outcome === 'completed' && record.name === 'load_tools') return <StudentNote>工具已准备好，可以继续处理当前任务。</StudentNote>
  if (record.outcome === 'completed' && record.name === 'read_tool_result') return <StudentNote>已继续读取工具返回的结果。</StudentNote>

  if (record.name === 'read_student_facts') {
    const facts = studentFactsReadResultSchema.safeParse(record.result)
    if (facts.success) {
      if (!facts.data.facts.length) return <StudentNote>
        {facts.data.unknown[0] ?? '暂时没有找到与本次学习目标相关的学习偏好。'}
      </StudentNote>
      const visible = facts.data.facts.slice(0, 6), remaining = facts.data.facts.length - visible.length
      return <>
        <StudentNote>本次参考了你保存的学习偏好：</StudentNote>
        <ul className="teaching-tool-summary-list">{visible.map(fact =>
          <li key={fact.factId}>{fact.statement}</li>)}</ul>
        {remaining > 0 && <StudentNote>还有 {remaining} 条偏好未展开显示。</StudentNote>}
      </>
    }
  }

  if (record.name === 'search_materials') {
    const search = materialSearchResultSchema.safeParse(record.result?.search)
    if (search.success) {
      const matches = search.data.matches.slice(0, 4), remaining = search.data.matches.length - matches.length
      if (matches.length) return <>
        <StudentNote>找到 {search.data.matches.length} 处与「{search.data.query}」相关的内容。</StudentNote>
        <ul className="teaching-tool-summary-list">{matches.map((match, index) => <li key={`${match.source.id}-${index}`}>
          <span className="teaching-tool-item-source">{match.source.label ?? match.source.path ?? '学习资料'}</span>
          <span>{match.excerpt}</span>
        </li>)}</ul>
        {remaining > 0 && <StudentNote>还有 {remaining} 处相关内容未展开显示。</StudentNote>}
      </>
      const examined = search.data.coverage.searchedSourceCount
      return <StudentNote>{examined
        ? `检查了 ${examined} 份可用资料，没有找到与「${search.data.query}」直接相关的内容。`
        : '当前没有可以检查的学习资料。'}</StudentNote>
    }
  }

  if (record.name === 'read_work') {
    const file = objectValue(record.result?.file), name = textValue(file?.name), content = textValue(file?.value)
    return <>
      <StudentNote>{name ? `已读取你提交的作品「${name}」。` : '已读取你提交的作品。'}</StudentNote>
      {content && <StudentExcerpt>{content}</StudentExcerpt>}
    </>
  }

  if (record.name === 'read_material' || record.name === 'read_personal_material') {
    const result = record.result ?? {}, name = textValue(result.name), content = textValue(result.text) ?? textValue(result.content)
    return <>
      <StudentNote>{name ? `已查看学习资料「${name}」。` : '已查看这份学习资料。'}</StudentNote>
      {content && <StudentExcerpt>{content}</StudentExcerpt>}
    </>
  }

  if (record.name === 'read_reference') {
    const reference = objectValue(record.result?.reference), name = textValue(reference?.sourceName)
    return <StudentNote>{name ? `已查看你选择的引用「${name}」。` : '已查看你选择的引用。'}</StudentNote>
  }

  if (record.name === 'read_pdf_text') {
    const page = typeof record.result?.page === 'number' ? `第 ${record.result.page} 页` : ''
    return <>
      <StudentNote>{`已继续阅读 PDF ${page}。`}</StudentNote>
      {textValue(record.result?.text) && <StudentExcerpt>{String(record.result!.text)}</StudentExcerpt>}
    </>
  }

  if (record.name === 'read_pdf') {
    const reading = objectValue(record.result?.reading), pages = Array.isArray(reading?.pages) ? reading.pages : []
    const text = pages.flatMap(page => {
      const value = objectValue(page)
      return value?.state === 'ready' && typeof value.text === 'string' ? [value.text] : []
    }).join('\n\n')
    return <>
      <StudentNote>已查看 PDF 中你选择的页面。</StudentNote>
      {text && <StudentExcerpt>{text}</StudentExcerpt>}
    </>
  }

  if (record.name === 'find_pdf') {
    const matches = Array.isArray(record.result?.matches) ? record.result.matches : []
    if (!matches.length) return <StudentNote>没有找到与这次查找直接相关的内容。</StudentNote>
    return <>
      <StudentNote>在 PDF 中找到 {matches.length} 处相关内容。</StudentNote>
      <ul className="teaching-tool-summary-list">{matches.slice(0, 4).map((match, index) => {
        const item = objectValue(match), page = typeof item?.page === 'number' ? `第 ${item.page} 页` : '相关内容'
        return <li key={index}><span className="teaching-tool-item-source">{page}</span>
          <span>{textValue(item?.excerpt) ?? textValue(item?.text) ?? ''}</span></li>
      })}</ul>
    </>
  }

  if (record.name === 'read_teaching_artifact') {
    return <StudentNote>已查看当前学习页面上的内容，并把它作为本次回答的依据。</StudentNote>
  }

  if (record.name.startsWith('skill_')) {
    const loaded = teachingSkillLoadedSchema.safeParse(record.result?.loaded)
    return <StudentNote>{loaded.success
      ? '已根据这项技能整理本次回答，不需要你再次操作。'
      : '这项技能已经用于本次回答。'}</StudentNote>
  }

  if (record.name === 'course_operation' || record.name === 'execution_stop' || record.name === 'execution_query') {
    const query = executionQuerySchema.safeParse(record.result?.query)
    if (!query.success) return <StudentNote>这项课程实验的状态已记录。</StudentNote>
    const state = query.data.statusKnowledge === 'unknown' ? '暂时无法确认这次实验的最终状态。'
      : `这次课程实验${stateLabel(query.data)}。`
    const observed = primaryValue(query.data.session?.observation) ?? primaryValue(query.data.output?.output)
    return <>
      <StudentNote>{state}</StudentNote>
      {observed && <StudentNote>当前结果：{observed}</StudentNote>}
    </>
  }

  if (record.outcome === 'unknown') return <StudentNote>暂时无法确认这项操作是否完成，可以稍后查看原记录。</StudentNote>
  return <StudentNote>这次学习操作已完成，相关内容已用于本次回答。</StudentNote>
}

function sourceActionLabel(record: TeachingToolRecord) {
  if (['course_operation', 'execution_query', 'execution_stop'].includes(record.name)) return '查看实验记录'
  if (!record.source || !['read_work', 'read_reference', 'read_material', 'read_personal_material',
    'read_result', 'read_teaching_artifact', 'read_pdf', 'read_pdf_text', 'find_pdf'].includes(record.name)) return undefined
  return '查看原内容'
}

const ToolRecord = memo(function ToolRecord({ record, onLocate }: { record: TeachingToolRecord; onLocate?: TeachingToolLocator }) {
  const [locating, setLocating] = useState(false)
  const cleanup = record.result?.stoppedExecution as Record<string, unknown> | undefined
  const stopped = executionQuerySchema.safeParse(cleanup?.query)
  const sessionStopped = stopped.success && stopped.data.statusKnowledge === 'confirmed' && isTerminalExecutionState(stopped.data.state)
  const cancelled = cancelledRecord(record)
  const label = cancelled ? '已停止' : record.outcome === 'completed' && record.result?.sessionOngoing === true
    ? sessionStopped ? '实验已结束' : cleanup ? '正在停止实验' : '实验进行中'
    : studentStatus(record)
  const action = sourceActionLabel(record)
  const locate = async () => {
    if (!onLocate) return
    setLocating(true)
    try {
      const result = await onLocate(record)
      if (!result.ok) toast.error(result.reason)
    } catch { toast.error('暂时找不到原始内容，已有答复仍会保留。') }
    finally { setLocating(false) }
  }
  return <AgentTraceItem className="teaching-tool-record" data-outcome={record.outcome ?? record.state}
    data-command-id={record.commandId} data-run-id={record.runId} data-tool-name={record.name} icon={toolIcon(record.name)}
    tone={cancelled ? 'neutral' : record.outcome === 'completed' ? 'done' : record.outcome === 'failed' ? 'error' : record.state === 'dispatching' ? 'running' : 'waiting'}
    title={<span className="teaching-tool-title">{studentToolTitle(record)}</span>}
    status={<span className="teaching-tool-status">{label}</span>}>
    <div className="teaching-tool-body">
      <StudentToolResult record={record} />
      {action && onLocate && <div className="teaching-tool-source">
        <button type="button" className="outline" disabled={locating} onClick={() => void locate()}>{action}</button>
      </div>}
    </div>
  </AgentTraceItem>
})

export function TeachingToolRecords({ records, onLocate, embedded = false }: { records: TeachingToolRecord[]; onLocate?: TeachingToolLocator; embedded?: boolean }) {
  if (!records.length) return null
  const items = records.map(record => <ToolRecord key={record.commandId} record={record} onLocate={onLocate} />)
  return embedded ? <>{items}</> : <AgentTrace className="teaching-tool-records" aria-label="工具记录">{items}</AgentTrace>
}
