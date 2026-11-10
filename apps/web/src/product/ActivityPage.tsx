import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from 'react'
import { toast } from '@xunjie/ui/feedback'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { Icon, IconText } from '../icons'
import { CenterToolArea, type ToolKey, type ToolSpec, type CenterToolAreaHandle } from '../components/workspace/CenterToolArea'
import { questionReferenceInputSchema, questionReferenceSchema, questionReferenceSourceSchema } from '@xunjie/contracts/question-drafts'
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
import { AgentInputMode } from './AgentInteraction'
import { AgentModelPicker, useAgentModelPicker } from './AgentModelPicker'
import type { ModelSelectionController } from './ModelSelection'
import { waitForComposerComposition } from '../components/workspace/references/composer-view'
import { PdfMaterials, PdfMaterialEntries, usePdfMaterials } from './PdfMaterials'
import { PersonalMaterials, PersonalMaterialEntries, usePersonalMaterials } from './PersonalMaterials'
import { panes, type LayoutNode } from '../lib/wsLayout'
import { useTeachingArtifacts } from '../teaching-artifacts/useTeachingArtifacts'
import { ArtifactCard } from '../teaching-artifacts/ArtifactCard'
import { ActivitySubmission } from './ActivitySubmission'

// The center already supports injected named tool bodies; PDF shares its existing tab/layout lifecycle.
const PDF_TOOL = 'component:__pdf-materials__' as const
const PERSONAL_TOOL = 'component:__personal-materials__' as const

function includeCenterTab(taskId: string, key: ToolKey) {
  try {
    const storageKey = `ws-layout:${taskId}`, saved = localStorage.getItem(storageKey)
    if (!saved) return
    const layout = JSON.parse(saved) as LayoutNode
    if (panes(layout).some(pane => pane.tabs.includes(key))) return
    const append = (node: LayoutNode): LayoutNode => node.kind === 'pane'
      ? { ...node, tabs: [...node.tabs, key] } : { ...node, a: append(node.a) }
    localStorage.setItem(storageKey, JSON.stringify(append(layout)))
  } catch { /* The center already falls back to a fresh layout for unreadable storage. */ }
}
function includePdfTab(taskId: string) {
  includeCenterTab(taskId, PDF_TOOL)
}
function toolReference(value: unknown) {
  const received = questionReferenceSchema.safeParse(value)
  return received.success ? received : questionReferenceInputSchema.safeParse(value)
}

async function focusLocation(root: HTMLDivElement | null, selector: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const target = root?.querySelector<HTMLElement>(selector)
    if (target) { target.focus(); target.scrollIntoView({ block: 'nearest' }); return { ok: true as const } }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
  return { ok: false as const, reason: '原位置当前无法打开，固定依据和结果仍保留。' }
}
import { RuntimeTool, type ComponentResultLocation } from './RuntimeTool'

/** The existing workspace container consumes the reliable session; it owns only layout and focus. */
export function ActivityPage({ activity, spaceKey, namespace, authorized, nativeAvailable, workspaceRef, busy, onBack, onStatus, onRefresh, onModels, details, account, requestedArtifactId, selection }: {
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean; nativeAvailable: boolean
  workspaceRef: RefObject<ActivityWorkspaceHandle | null>; busy: boolean
  onBack: () => void; onStatus: () => void; onRefresh: () => void
  onModels?: () => void; selection: ModelSelectionController
  requestedArtifactId?: string | null
  details: (openCoursePdf: (materialId: string) => void) => ReactNode; account: ReactNode
}) {
  const [materialsOpen, setMaterialsOpen] = useState(!!activity.course)
  const [conversationActive, setConversationActive] = useState(false)
  const [tabsSlot, setTabsSlot] = useState<HTMLDivElement | null>(null)
  const references = useWorkspaceReferences()
  const ask = useRef<HTMLButtonElement>(null)
  const { workspace, draft, actions, execution, sessions, inputInteraction } = useActivitySession()
  const root = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<ToolKey>('design')
  const center = useRef<CenterToolAreaHandle>(null)
  const artifactTabs = useRef<string[]>([])
  const artifacts = useTeachingArtifacts(activity, spaceKey, namespace, authorized)
  const openArtifact = async (artifactId: string) => {
    await workspace.leave()
    artifacts.setOpened(artifactId)
    center.current?.openGenTab(artifactId)
  }
  const [workLocation, setWorkLocation] = useState<{ objectId: string }>()
  const [componentLocation, setComponentLocation] = useState<ComponentResultLocation & { key: string }>()
  const readOnly = workspace.isReadOnly()
  const picker = useAgentModelPicker(selection, activity, spaceKey, namespace)
  const scope = workspaceScope(namespace, activity)
  const [layoutReady, setLayoutReady] = useState(false)
  useEffect(() => { const taskId = namespace + ':' + activity.activityId; includePdfTab(taskId); includeCenterTab(taskId, PERSONAL_TOOL); setLayoutReady(true) }, [namespace, activity.activityId])
  const revealPdf = useCallback(async () => { await workspace.leave(); setTool(PDF_TOOL) }, [workspace])
  const pdf = usePdfMaterials({ activity, spaceKey, namespace, authorized, reveal: revealPdf })
  const revealPersonal = useCallback(async () => { await workspace.leave(); setTool(PERSONAL_TOOL) }, [workspace])
  const personal = usePersonalMaterials({ activity, spaceKey, namespace, authorized, reveal: revealPersonal })
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
    await waitForComposerComposition(scope)
    await workspace.leave(); await draft.leave(); await actions.leave()
  } }), [workspace, draft, actions, scope])
  const openedRequest = useRef<string | null>(null)
  const requestedArtifactReady = artifacts.entries.some(entry => entry.artifact.artifactId === requestedArtifactId && entry.revision)
  useEffect(() => {
    if (!layoutReady || !requestedArtifactId || !requestedArtifactReady || openedRequest.current === requestedArtifactId) return
    let current = true
    void workspace.leave().then(() => {
      if (!current) return
      openedRequest.current = requestedArtifactId
      artifacts.setOpened(requestedArtifactId)
      center.current?.openGenTab(requestedArtifactId)
    }).catch(() => { if (current) toast.error('当前输入尚未保护，请保留页面后继续。') })
    return () => { current = false }
  }, [layoutReady, requestedArtifactId, requestedArtifactReady, workspace, artifacts.setOpened])
  const locateTool: TeachingToolLocator = async record => {
    if (record.name === 'search_materials') {
      const search = record.result?.search as { matches?: { source?: Record<string, unknown>;
        locator?: { line?: number; page?: number; start?: number; end?: number } }[] } | undefined
      const match = search?.matches?.[0], source = match?.source
      if (source?.kind === 'pdf' && typeof source.readingId === 'string' && typeof source.documentId === 'string')
        return pdf.locate({ kind: 'pdf', activityId: activity.activityId, documentId: source.documentId,
          documentSha256: String(source.sha256 ?? source.version), readingId: source.readingId },
          typeof match?.locator?.page === 'number' ? match.locator.page : undefined)
      if (source?.kind === 'course-material' && typeof source.materialId === 'string') {
        if (source.releaseId !== activity.course?.releaseId)
          return { ok: false, reason: '课程材料版本已变化，固定片段仍保留。' }
        setMaterialsOpen(true)
        if (window.matchMedia('(width < 1024px)').matches) references.setOpen(false)
        return focusLocation(root.current, `[data-material-id="${CSS.escape(source.materialId)}"]`)
      }
      if (source?.kind === 'skill-attachment')
        return { ok: false, reason: 'Skill 附件没有独立文件面板；命中位置和固定片段保留在本条检索记录中。' }
      if (source?.kind === 'personal-material' && typeof source.materialId === 'string')
        return personal.locate({ kind: 'personal-material', activityId: activity.activityId, materialId: source.materialId,
          version: Number(source.version), sha256: String(source.sha256) },
        match?.locator?.start !== undefined && match.locator.end !== undefined
          ? { start: match.locator.start, end: match.locator.end } : undefined)
    }
    const resultReference = toolReference(record.result?.reference)
    const resultSource = questionReferenceSourceSchema.safeParse(record.result?.source)
    const reference = resultReference.success ? resultReference : toolReference(record.basis.reference)
    const source = resultSource.success ? resultSource : questionReferenceSourceSchema.safeParse(record.basis.source)
    // A read_pdf result can be a new reading of the PDF from its original reference basis.
    const fixed = resultReference.success ? resultReference.data.source : resultSource.success ? resultSource.data
      : reference.success ? reference.data.source : source.success ? source.data : null
    if (fixed?.kind === 'pdf') return pdf.locate(fixed)
    if (fixed?.kind === 'personal-material') {
      const read = record.name === 'read_personal_material' ? record.result as { start?: number; end?: number } | null : null
      const range = reference.success ? reference.data.range : null
      return personal.locate(fixed,
        read?.start !== undefined && read.end !== undefined ? { start: read.start, end: read.end }
          : range?.kind === 'text' ? { start: range.start, end: range.end } : undefined)
    }
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
      if (requestId && binding.definition.manifest.formatVersion === 3) {
        setComponentLocation({ key: binding.key, requestId, token: crypto.randomUUID(),
          ...(reference.success ? { range: reference.data.range } : {}) })
        if (reference.success && reference.data.range.kind === 'semantic' && reference.data.range.typeId === 'alu-counterexample'
          && typeof reference.data.range.target.index === 'number')
          selector = `[data-check-request-id="${CSS.escape(requestId)}"] [data-alu-counterexample-index="${reference.data.range.target.index}"]`
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
    { key: PDF_TOOL, label: 'PDF 资料', icon: 'clipboard-text' },
    { key: PERSONAL_TOOL, label: '个人笔记', icon: 'clipboard-text' },
    ...(activity.course?.components ?? []).map(binding => ({ key: `component:${binding.key}` as const, label: binding.configuration.title, icon: 'clipboard-text' as const }))]
  // A component may declare a restricted run or a native stateful session; both keep their
  // record, query and stop in this area instead of inside the opaque view.
  const toolBodies = Object.fromEntries((activity.course?.components ?? []).map(binding => [`component:${binding.key}`,
    (binding.definition.manifest.formatVersion === 3
      ? <RuntimeTool key={binding.key} activity={activity} binding={binding} spaceKey={spaceKey} namespace={namespace} authorized={authorized}
        location={componentLocation?.key === binding.key ? componentLocation : undefined}/>
      : binding.definition.manifest.formatVersion === 1 && binding.definition.manifest.session
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
  toolBodies[PDF_TOOL] = <PdfMaterials pdf={pdf} onBack={() => setTool('design')} />
  toolBodies[PERSONAL_TOOL] = <PersonalMaterials personal={personal} onBack={() => setTool('design')} />
  for (const entry of artifacts.entries.filter(item => item.revision)) toolBodies[`gen:${entry.artifact.artifactId}`] =
    <ArtifactCard center entry={entry} controller={artifacts} onClose={async () => {
      await workspace.leave(); artifacts.setOpened(null); center.current?.closeGenTab(entry.artifact.artifactId); setTool('design')
    }} />
  const title = activity.course?.taskTitle || activity.goal || activity.question || '资料学习'
  return <div ref={root} className={'ws ws-organized product-workspace' + (references.open ? ' discussion-open' : '')}>
    <header className="ws-head">
      <button type="button" className="ws-navbtn" aria-label="返回活动列表" onClick={onBack}><Icon name="arrow-left" size={18} /></button>
      <div className="product-activity-title"><span>{activity.course?.courseName ?? '自主学习'}</span><h1 id="activity-title">{title}</h1></div>
      <div className="ws-head-utilities">
        <ActivitySubmission activity={activity} spaceKey={spaceKey} namespace={namespace} authorized={authorized}
          workspace={workspace} artifacts={artifacts.entries} beforeFreeze={() => waitForComposerComposition(scope)}
          isComposing={() => [...artifacts.guards.values()].some(guard => guard.composing)} />
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
          {artifacts.entries.some(entry => entry.artifact.shelved) && <div className="teaching-artifact-shelf" aria-label="收纳的学习页面">
            {artifacts.entries.filter(entry => entry.artifact.shelved).map(entry => <button key={entry.artifact.artifactId}
              type="button" className="ws-btn ghost" onClick={() => void openArtifact(entry.artifact.artifactId).catch(() => toast.error('当前输入尚未保护，请保留页面后继续。'))}>{entry.artifact.title}</button>)}
          </div>}
          {account}
        </WorkspacePopover>
      </div>
    </header>
    {readOnly && <div role="status" className="product-workspace-notice">这是还原校验副本，作品与学习对话只读，不会启动 Agent 或实验；请由维护者完成接管后继续。</div>}
    <div className="ws-commandbar"><div className="ws-head-tabs" ref={setTabsSlot} />
      <span className="product-workspace-caption">当前作品{activity.status === 'closed' ? ' · 活动已关闭' : ''}</span></div>
    <div className="ws-body">
      {materialsOpen && <aside className="product-task-details" aria-label="目标与材料">
        {details(materialId => void pdf.openCourse(materialId))}<PdfMaterialEntries pdf={pdf} /><PersonalMaterialEntries personal={personal} />
      </aside>}
      {layoutReady && <CenterToolArea ref={center} taskId={namespace + ':' + activity.activityId} tools={tools} toolBodies={toolBodies}
        genCards={artifacts.entries.flatMap(entry => entry.revision ? [{ cardId: entry.artifact.artifactId, title: entry.artifact.title,
          taskId: activity.activityId, claimSim: false, srcdoc: entry.revision.payload.html, version: entry.revision.version, collectedAt: entry.artifact.createdAt }] : [])}
        onGenTabsChange={ids => {
          artifacts.setCenterIds(previous => JSON.stringify(previous) === JSON.stringify(ids) ? previous : ids)
          if (artifacts.opened && artifactTabs.current.includes(artifacts.opened) && !ids.includes(artifacts.opened)) artifacts.setOpened(null)
          artifactTabs.current = ids
        }}
        beforeToolChange={() => workspace.leave()}
        tool={tool} onToolChange={value => { void workspace.leave().then(() => {
          artifacts.setOpened(value.startsWith('gen:') ? value.slice(4) : null); setTool(value)
        }).catch(() => toast.error('当前输入尚未保护，请保留页面后继续。')) }} onToast={message => toast(message)} tabsSlot={tabsSlot}
        designBody={<>{(activity.course?.components??[]).filter(b=>b.definition.manifest.formatVersion===3).map(binding=>
          <RuntimeTool compact key={binding.key} activity={activity} binding={binding} spaceKey={spaceKey} namespace={namespace} authorized={authorized}/>)}
          <ActivityWorkspace activity={activity} spaceKey={spaceKey} namespace={namespace} authorized={authorized} location={workLocation} /></>} />}
      <aside className="product-discussion" aria-label="问题与引用" inert={!references.open}
        style={references.open ? undefined : { display: 'none' }}>
        <FirstQuestionAutoSend activity={activity} />
        <ActivityConversation activity={activity} spaceKey={spaceKey} namespace={namespace} onModels={onModels}
          onActiveChange={setConversationActive} onLocateTool={locateTool} onQuestionChange={setPendingQuestion}
          focusQuestionId={focusQuestionId} onQuestionFocused={questionFocused} artifacts={artifacts} onOpenArtifact={openArtifact} />
        <AgentInputMode active={conversationActive} />
        <WorkspaceReferenceComposer closeFocusRef={ask}
          modelPicker={<AgentModelPicker controller={picker} disabled={!authorized || readOnly} onSettings={onModels} />}
          sendBlocked={!inputInteraction.ready || picker.blocked}
          blockedHint={picker.blocked ? '正在切换模型，问题与引用仍保留。' : '正在核对本次发送方式，问题与引用仍保留。'}
          blockedLabel={picker.blocked ? '切换模型中…' : '核对发送方式…'}
          submitLabel={conversationActive ? inputInteraction.mode === 'queue' ? '排队发送' : '补充当前任务' : '发送问题'} /><ActivityActions />
      </aside>
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
