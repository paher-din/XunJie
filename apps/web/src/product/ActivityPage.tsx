import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { Icon, IconText } from '../icons'
import { CenterToolArea, type ToolKey, type ToolSpec } from '../components/workspace/CenterToolArea'
import { questionReferenceSchema, questionReferenceSourceSchema } from '@xunjie/contracts/question-drafts'
import { executionQuerySchema } from '@xunjie/contracts/execution'
import { componentStateName } from '@xunjie/contracts/components'
import type { TeachingToolLocator } from './TeachingToolRecords'
import { ComponentView } from '../component-host/ComponentView'
import { useActivitySession } from './ActivitySession'
import { WorkspacePopover } from '../components/workspace/WorkspacePopover'
import { SelectionToolbar, WorkspaceReferenceComposer, useWorkspaceReferences } from '../components/workspace/references'
import { ActivityWorkspace, type ActivityWorkspaceHandle } from './ActivityWorkspace'
import { ActivityActions } from './ActivityActions'
import { ActivityConversation, FirstQuestionAutoSend, firstQuestionKey, currentStudentQuestion } from './ActivityConversation'
import { ExecutionPanel } from './ExecutionPanel'
import { NativeSessionPanel } from './NativeSessionPanel'
import { teachingConversationSchema, type TeachingStudentQuestion } from '@xunjie/contracts/teaching-agent'
import { learningRequest, workspaceScope } from './learningTransport'
import { GuidancePresentation } from '../components/workspace/guidance/GuidancePresentation'

async function focusLocation(root: HTMLDivElement | null, selector: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const target = root?.querySelector<HTMLElement>(selector)
    if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }); return { ok: true as const } }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
  return { ok: false as const, reason: '原位置当前无法打开，固定依据和结果仍保留。' }
}

/** The existing workspace container consumes the reliable session; it owns only layout and focus. */
export function ActivityPage({ activity, spaceKey, namespace, authorized, nativeAvailable, workspaceRef, busy, onBack, onStatus, onRefresh, onModels, details, account, error }: {
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean; nativeAvailable: boolean
  workspaceRef: RefObject<ActivityWorkspaceHandle | null>; busy: boolean
  onBack: () => void; onStatus: () => void; onRefresh: () => void
  onModels?: () => void
  details: ReactNode; account: ReactNode; error: ReactNode
}) {
  const [materialsOpen, setMaterialsOpen] = useState(!!activity.course)
  const [conversationActive, setConversationActive] = useState(false)
  const [tabsSlot, setTabsSlot] = useState<HTMLDivElement | null>(null)
  const references = useWorkspaceReferences()
  const ask = useRef<HTMLButtonElement>(null)
  const { workspace, draft, actions, execution, sessions } = useActivitySession()
  const root = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<ToolKey>('design')
  const [workLocation, setWorkLocation] = useState<{ objectId: string }>()
  const readOnly = workspace.isReadOnly()
  const scope = workspaceScope(namespace, activity)
  const [pendingQuestion, setPendingQuestion] = useState<TeachingStudentQuestion | null>(null)
  const [focusQuestionId, setFocusQuestionId] = useState<string | null>(null)
  const questionFocused = useCallback(() => setFocusQuestionId(null), [])
  useEffect(() => { setPendingQuestion(null); setFocusQuestionId(null) }, [scope])
  useEffect(() => {
    if (references.open || !authorized || readOnly) return
    let current = true
    const read = async () => {
      try {
        const value = teachingConversationSchema.parse(await learningRequest(activity, spaceKey, namespace, `agent/${activity.activityId}/conversation`))
        if (current) setPendingQuestion(currentStudentQuestion(value))
      } catch { if (current) setPendingQuestion(null) }
    }
    void read()
    const timer = setInterval(() => { void read() }, 5000)
    return () => { current = false; clearInterval(timer) }
  }, [scope, references.open, authorized, readOnly, activity, spaceKey, namespace])
  const firstQuestionOpened = useRef<string | null>(null)
  useEffect(() => {
    if (firstQuestionOpened.current === activity.activityId) return
    firstQuestionOpened.current = activity.activityId
    if (activity.question || localStorage.getItem(firstQuestionKey(activity.activityId))) references.setOpen(true)
  }, [activity.activityId, references])
  useImperativeHandle(workspaceRef, () => ({ leave: async () => {
    await workspace.leave(); await draft.leave(); await actions.leave()
  } }), [workspace, draft, actions])
  const [toolError, setToolError] = useState('')
  const locateTool: TeachingToolLocator = async record => {
    const reference = questionReferenceSchema.safeParse(record.result?.reference ?? record.basis.reference)
    const source = questionReferenceSourceSchema.safeParse(record.result?.source ?? record.basis.source)
    const fixed = reference.success ? reference.data.source : source.success ? source.data : null
    const objectId = fixed?.kind === 'work' ? fixed.objectId : record.name === 'read_work' ? record.arguments.objectId : null
    const contentId = fixed?.kind === 'work' ? fixed.contentId : record.arguments.contentId
    if (typeof objectId === 'string') {
      const file = workspace.snapshot().files.find(item => item.objectId === objectId)
      if (!file || file.contentId !== contentId) return { ok: false, reason: '来源已变化或不可用，保留的是本次使用的固定原文。' }
      await workspace.leave(); setWorkLocation({ objectId }); setTool('design')
      return focusLocation(root.current, `[data-work-object-id="${CSS.escape(objectId)}"][data-work-content-id="${CSS.escape(String(contentId))}"]`)
    }
    const requestId = record.source?.requestId ?? (fixed?.kind === 'component' ? fixed.requestId : null)
    const local = requestId ? execution.snapshot().records.find(item => item.requestId === requestId) : null
    const componentKey = record.source?.componentKey ?? (fixed?.kind === 'component' ? fixed.bindingKey : null)
      ?? local?.action.execution.instance.key
    const binding = activity.course?.components?.find(item => item.key === componentKey)
    if (binding) {
      if (fixed?.kind === 'component' && (fixed.definitionDigest !== binding.definition.digest
        || (fixed.origin === 'state' && workspace.snapshot().files.find(item => item.name === componentStateName(binding.key))?.contentId !== fixed.contentId)))
        return { ok: false, reason: '组件来源版本已变化，固定副本仍保留。' }
      await workspace.leave()
      let selector = requestId ? `[data-execution-request-id="${CSS.escape(requestId)}"]`
        : `[data-component-key="${CSS.escape(binding.key)}"]`
      if (requestId && binding.definition.manifest.formatVersion === 1 && binding.definition.manifest.session) {
        const current = await sessions.refresh(requestId)
        if (!current) return { ok: false, reason: '原会话当前无法读取，固定结果仍保留。' }
        const fixedQuery = executionQuerySchema.safeParse(record.result?.query)
        const seq = fixedQuery.success ? fixedQuery.data.session?.appliedSeq : undefined
        if (seq === 0 && current.session?.appliedSeq !== 0)
          return { ok: false, reason: '原会话已推进，启动时的观察保留在本条工具记录中。' }
        if (seq && seq > 0) selector += ` [data-observation-seq="${seq}"]`
        await sessions.select(requestId)
      }
      setTool(`component:${binding.key}`)
      return focusLocation(root.current, selector)
    }
    if (fixed?.kind === 'course-material' || fixed?.kind === 'course-field') {
      if (fixed.releaseId !== activity.course?.releaseId) return { ok: false, reason: '材料版本已变化，固定副本仍保留。' }
      setMaterialsOpen(true)
      if (window.matchMedia('(width < 1024px)').matches) references.setOpen(false)
      return focusLocation(root.current, fixed.kind === 'course-material'
        ? `[data-material-id="${CSS.escape(fixed.materialId)}"]` : '[data-course-requirements]')
    }
    return { ok: false, reason: '原来源当前无法定位，固定依据和结果仍保留。' }
  }
  const tools: ToolSpec[] = [{ key: 'design', label: '作品', icon: 'code-square' },
    ...(activity.course?.components ?? []).map(binding => ({ key: `component:${binding.key}` as const, label: binding.configuration.title, icon: 'clipboard-text' as const }))]
  // A component may declare a restricted run or a native stateful session; both keep their
  // record, query and stop in this area instead of inside the opaque view.
  const toolBodies = Object.fromEntries((activity.course?.components ?? []).map(binding => [`component:${binding.key}`,
    (binding.definition.manifest.formatVersion === 1 && binding.definition.manifest.session
      ? <div key={binding.key} className="component-tool" data-component-key={binding.key} tabIndex={-1}>
        <ComponentView activity={activity} binding={binding} spaceKey={spaceKey} namespace={namespace} authorized={authorized} />
        {nativeAvailable || activity.course?.executionPlan ? <NativeSessionPanel activity={activity} binding={binding} authorized={authorized} spaceKey={spaceKey} namespace={namespace} />
          : <p className="execution-hint">当前运行方式不提供原生会话；已有作品与记录仍保留。</p>}
      </div>
      : binding.definition.manifest.formatVersion === 1 && binding.definition.manifest.operations?.length
        ? <div key={binding.key} className="component-tool" data-component-key={binding.key} tabIndex={-1}>
          <ComponentView activity={activity} binding={binding} spaceKey={spaceKey} namespace={namespace} authorized={authorized} />
          <ExecutionPanel activity={activity} binding={binding} authorized={authorized} />
        </div>
        : <div key={binding.key} style={{ height: '100%' }} data-component-key={binding.key} tabIndex={-1}>
          <ComponentView activity={activity} binding={binding} spaceKey={spaceKey} namespace={namespace} authorized={authorized} /></div>)]))
  const title = activity.course?.taskTitle || activity.goal || activity.question || '资料学习'
  return <div ref={root} className={'ws ws-organized product-workspace' + (references.open ? ' discussion-open' : '')}>
    <header className="ws-head">
      <button type="button" className="ws-navbtn" aria-label="返回活动列表" onClick={onBack}><Icon name="arrow-left" size={18} /></button>
      <div className="product-activity-title"><span>{activity.course?.courseName ?? '自主学习'}</span><h1 id="activity-title">{title}</h1></div>
      <div className="ws-head-utilities">
        <button type="button" className="ws-btn ghost" aria-expanded={materialsOpen} onClick={() => {
          if (window.matchMedia('(width < 1024px)').matches && references.open) { references.setOpen(false); setMaterialsOpen(true) }
          else setMaterialsOpen(value => !value)
        }}>
          <IconText name="clipboard-text">目标与材料</IconText></button>
        <button ref={ask} type="button" className="ws-btn ghost" aria-label={references.open ? '问题与引用' : '打开对话'}
          aria-expanded={references.open} onClick={() => references.setOpen(!references.open)}><IconText name="chat-round-dots">询问 Agent</IconText></button>
        <WorkspacePopover label="活动" icon="menu-dots">
          <p>{activity.status === 'closed' ? '活动已关闭，可随时重新开始。' : '继续围绕这个目标学习。'}</p>
          <button type="button" className="ws-btn ghost" disabled={busy || readOnly} onClick={onStatus}>{activity.status === 'closed' ? '重新开始活动' : '关闭活动'}</button>
          <button type="button" className="ws-btn ghost" disabled={busy} onClick={onRefresh}>刷新列表</button>
          {account}
        </WorkspacePopover>
      </div>
    </header>
    {readOnly && <div role="status" className="product-workspace-notice">这是还原校验环境，作品与历史只读，实验尚未启用。</div>}
    {error && <div className="product-workspace-notice">{error}</div>}
    {toolError && <div role="alert" className="product-workspace-notice">{toolError}</div>}
    <div className="ws-commandbar"><div className="ws-head-tabs" ref={setTabsSlot} />
      <span className="product-workspace-caption">当前作品{activity.status === 'closed' ? ' · 活动已关闭' : ''}</span></div>
    <div className="ws-body">
      {materialsOpen && <aside className="product-task-details" aria-label="目标与材料">{details}</aside>}
      <CenterToolArea taskId={namespace + ':' + activity.activityId} tools={tools} toolBodies={toolBodies}
        beforeToolChange={() => workspace.leave()}
        tool={tool} onToolChange={value => { setTool(value); setToolError('') }} onToast={setToolError} tabsSlot={tabsSlot}
        designBody={<ActivityWorkspace activity={activity} spaceKey={spaceKey} namespace={namespace} authorized={authorized} location={workLocation} />} />
      {references.open && <aside className="product-discussion" aria-label="问题与引用">
        <FirstQuestionAutoSend activity={activity} />
        <ActivityConversation activity={activity} spaceKey={spaceKey} namespace={namespace} onModels={onModels}
          onActiveChange={setConversationActive} onLocateTool={locateTool} onQuestionChange={setPendingQuestion}
          focusQuestionId={focusQuestionId} onQuestionFocused={questionFocused} />
        {/* Steering is deferred; a new question waits as a reliable draft until the current run settles. */}
        <WorkspaceReferenceComposer closeFocusRef={ask} sendBlocked={conversationActive} /><ActivityActions />
      </aside>}
    </div>
    <SelectionToolbar />
    {pendingQuestion && !references.open && authorized && !readOnly && <GuidancePresentation
      item={{ id: scope + ':' + pendingQuestion.questionId, label: '等你回应',
        content: { kind: 'text', text: 'Agent 有一个关于当前学习目标的问题。你可以继续编辑作品，准备好后再回应。' },
        actions: [{ id: 'answer', label: '回答当前问题', primary: true }] }} state="waiting"
      companionAction={{ id: 'answer', label: '学习助手：回答当前问题' }} onAction={() => {
        setFocusQuestionId(pendingQuestion.questionId); references.setOpen(true)
      }} />}
  </div>
}
