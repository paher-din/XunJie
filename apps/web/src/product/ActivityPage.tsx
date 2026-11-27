import { ChatViewport } from '@xunjie/ui/chat'
import * as Dialog from '@radix-ui/react-dialog'
import { useConversationScroll } from './conversation-scroll'
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref, type RefObject } from 'react'
import { toast } from '@xunjie/ui/feedback'
import { Button, StatusChip } from '@xunjie/ui/foundation'
import { GuidancePresentation, SideDock, TaskInfo } from '@xunjie/ui/workspace'
import { courseReleaseSchema } from '@xunjie/contracts/courses'
import { workFileSchema, type LearningActivity } from '@xunjie/contracts/learning-data'
import { Icon, IconText } from '../icons'
import { CenterToolArea, type ToolKey, type ToolSpec, type CenterToolAreaHandle } from '../components/workspace/CenterToolArea'
import { questionReferenceInputSchema, questionReferenceSchema, questionReferenceRangeSchema, questionReferenceSourceId, questionReferenceSourceSchema } from '@xunjie/contracts/question-drafts'
import { executionQuerySchema } from '@xunjie/contracts/execution'
import { componentStateName } from '@xunjie/contracts/components'
import type { TeachingToolLocator, TeachingToolRecordView } from './TeachingToolRecords'
import type { CitationRecord } from '@xunjie/ui/chat'
import { ComponentView } from '../component-host/ComponentView'
import { useActivitySession } from './ActivitySession'
import { WorkspacePopover } from '../components/workspace/WorkspacePopover'
import { SelectionToolbar, useWorkspaceReferences } from '../components/workspace/references'
import { ActivityWorkspace, type ActivityWorkspaceHandle } from './ActivityWorkspace'
import { WorkspaceStatus } from './WorkspaceStatus'
import { ActivityActions } from './ActivityActions'
import { ActivityConversation } from './ActivityConversation'
import { ExecutionPanel } from './ExecutionPanel'
import { NativeSessionPanel } from './NativeSessionPanel'
import { learningRequest, workspaceScope } from './learningTransport'
import { ActivityPromptComposer } from './ActivityPromptComposer'
import { ProductComposerDock } from './ProductPromptInput'
import { SessionQuestionBox } from './SessionQuestion'
import type { ModelSelectionController } from './ModelSelection'
import { waitForComposerComposition } from '../components/workspace/references/composer-view'
import { PdfMaterials, PendingCoursePdfs, PersonalPdfLibrary, usePdfMaterials, type PdfOrigin } from './PdfMaterials'
import { PersonalMaterials, usePersonalMaterials } from './PersonalMaterials'
import { CourseMaterialReader, isCoursePdf, useCourseMaterials } from './CourseMaterials'
import { closeTool, panes, type LayoutNode } from '../lib/wsLayout'
import { useTeachingArtifacts } from '../teaching-artifacts/useTeachingArtifacts'
import { ArtifactCard } from '../teaching-artifacts/ArtifactCard'
import { PersonalProjectPlan, usePersonalProject } from './PersonalProjectPlan'
import { ActivitySubmission } from './ActivitySubmission'
import { formatDeadline } from '../lib/tasks'
import { experimentReference, type ExperimentReference } from './experiment-reference'
import { toolResultData } from './workspace-conversation'

// The center already supports injected named tool bodies; PDF shares its existing tab/layout lifecycle.
const PDF_TOOL = 'component:__pdf-materials__' as const
const PERSONAL_TOOL = 'component:__personal-materials__' as const
const COURSE_READER_TOOL = 'component:__course-materials__' as const

function includeCenterTab(taskId: string, key: ToolKey) {
  try {
    const storageKey = `ws-layout:${taskId}`, saved = localStorage.getItem(storageKey)
    if (!saved) return
    let layout = JSON.parse(saved) as LayoutNode
    const legacy = [PERSONAL_TOOL, COURSE_READER_TOOL]
    if (!panes(layout).some(pane => pane.tabs.includes(key))) {
      const append = (node: LayoutNode): LayoutNode => node.kind === 'pane'
        ? { ...node, tabs: [...node.tabs, key] } : { ...node, a: append(node.a) }
      layout = append(layout)
    }
    for (const oldKey of legacy) layout = closeTool(layout, oldKey)
    localStorage.setItem(storageKey, JSON.stringify(layout))
  } catch { /* The center already falls back to a fresh layout for unreadable storage. */ }
}
function toolReference(value: unknown) {
  const received = questionReferenceSchema.safeParse(value)
  return received.success ? received : questionReferenceInputSchema.safeParse(value)
}

async function focusLocation(root: HTMLDivElement | null, selector: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const target = root?.querySelector<HTMLElement>(selector)
    if (target) {
      target.focus()
      target.scrollIntoView({ block: 'nearest' })
      return { ok: true as const }
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
  return { ok: false as const, reason: '原位置当前无法打开，固定依据和结果仍保留。' }
}
import { RuntimeTool, type ComponentResultLocation } from './RuntimeTool'

/** The existing workspace container consumes the reliable session; it owns only layout and focus. */
export function ActivityPage({ activity, spaceKey, namespace, authorized, nativeAvailable, workspaceRef, busy, onBack, onStatus, onRefresh,
  onModels, onAskHome, details, courseResources, account, requestedArtifactId, requestedExperiment, selection, taskInfoEntryRef, taskProgress }: {
  activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean; nativeAvailable: boolean
  workspaceRef: RefObject<ActivityWorkspaceHandle | null>; busy: boolean
  onBack: () => void; onStatus: () => void; onRefresh: () => void
  onModels?: () => void; selection: ModelSelectionController
  onAskHome?: (reference: ExperimentReference) => void | Promise<void>
  requestedArtifactId?: string | null
  requestedExperiment?: { requestId: string; bindingKey: string } | undefined
  taskInfoEntryRef?: Ref<HTMLButtonElement>
  taskProgress?: { percent: number; done: boolean }
  details: ReactNode; account: ReactNode
  courseResources?: (openCourseMaterial: (materialId: string) => void) => ReactNode
}) {
  const project = usePersonalProject(activity, spaceKey, namespace, authorized)
  const course = activity.course
  const courseWorkspace = !!course
  const [detailsOpen, setDetailsOpen] = useState(courseWorkspace)
  const [detailsMounted, setDetailsMounted] = useState(courseWorkspace)
  const hasToggledDetails = useRef(false)
  useEffect(() => { if (project.project) setDetailsOpen(true) }, [project.project])
  useEffect(() => {
    if (detailsOpen) {
      setDetailsMounted(true)
      return
    }
    if (!detailsMounted) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDetailsMounted(false)
      return
    }
    const timer = window.setTimeout(() => setDetailsMounted(false), 240)
    return () => window.clearTimeout(timer)
  }, [detailsOpen, detailsMounted])
  const detailsToggle = useRef<HTMLButtonElement>(null)
  const detailsCollapse = useRef<HTMLButtonElement>(null)
  const detailsRailToggle = useRef<HTMLButtonElement>(null)
  const returnDetailsFocus = useRef(false)
  useLayoutEffect(() => {
    if (!returnDetailsFocus.current) return
    returnDetailsFocus.current = false
    const target = detailsOpen ? detailsCollapse.current : (courseWorkspace ? detailsRailToggle.current : detailsToggle.current)
    target?.focus({ preventScroll: true })
  }, [detailsOpen])
  const [dockPanel, setDockPanel] = useState<'task' | 'stash' | null>(null)
  const [releaseDeadline, setReleaseDeadline] = useState<{ releaseId: string; deadlineAt?: string }>()
  const deadline = releaseDeadline?.releaseId === course?.releaseId ? releaseDeadline : undefined
  useEffect(() => {
    if (dockPanel !== 'task' || !authorized || !course || deadline) return
    let current = true
    void learningRequest(activity, spaceKey, namespace, 'releases/' + course.releaseId).then(value => {
      const result = courseReleaseSchema.safeParse(value)
      if (current && result.success && result.data.releaseId === course.releaseId && result.data.contentDigest === course.contentDigest)
        setReleaseDeadline({ releaseId: course.releaseId, deadlineAt: result.data.deadlineAt })
    }).catch(() => { /* The activity still has its basic details if the release is unavailable. */ })
    return () => { current = false }
  }, [dockPanel, authorized, activity, course, deadline, spaceKey, namespace])
  const [tabsSlot, setTabsSlot] = useState<HTMLDivElement | null>(null)
  const references = useWorkspaceReferences()
  const conversationScroll = useConversationScroll()
  const ask = useRef<HTMLButtonElement>(null)
  const { workspace, draft, actions, execution, sessions, agent, agentSessionError, retryAgentSession } = useActivitySession()
  const conversationActive = !!agent?.active
  const executionState = useSyncExternalStore(execution.subscribe, execution.snapshot)
  const latestExperiment = executionState.records.find(record => record.action.protocolVersion === 3
    && record.query.statusKnowledge === 'confirmed' && record.query.state === 'succeeded' && !!record.query.output)
  const latestExperimentReference = latestExperiment ? experimentReference(activity, latestExperiment) : null
  const root = useRef<HTMLDivElement>(null)
  const requestedRun = requestedExperiment?.requestId, requestedBinding = requestedExperiment?.bindingKey
  const experimentTool = requestedBinding && requestedRun && /^[0-9a-f-]{36}$/i.test(requestedRun)
    && activity.course?.components?.some(item => item.key === requestedBinding)
    ? `component:${requestedBinding}` as const : undefined
  const [tool, setTool] = useState<ToolKey>(experimentTool ?? 'design')
  const resourceTitle = course ? '课程材料' : activity.references.length ? '学习链接' : null
  const [coursePdfOpen, setCoursePdfOpen] = useState(false)
  const [selectedResource, setResourceSection] = useState<'course' | 'pdf' | 'notes'>(resourceTitle ? 'course' : 'pdf')
  const resourceSection = !resourceTitle && selectedResource === 'course' ? 'pdf' : selectedResource
  const center = useRef<CenterToolAreaHandle>(null)
  const artifactTabs = useRef<string[]>([])
  const artifacts = useTeachingArtifacts(activity, spaceKey, namespace, authorized)
  const openArtifact = async (artifactId: string) => {
    await workspace.leave()
    artifacts.setOpened(artifactId)
    center.current?.openGenTab(artifactId)
  }
  const [workLocation, setWorkLocation] = useState<{ objectId: string }>()
  const [fixedWork, setFixedWork] = useState<{ name: string; version: string; text: string } | null>(null)
  const [componentLocation, setComponentLocation] = useState<ComponentResultLocation & { key: string }>()
  const readOnly = workspace.isReadOnly()
  const sending = useRef<Promise<void> | null>(null)
  const scope = workspaceScope(namespace, activity)
  const [layoutReady, setLayoutReady] = useState(false)
  useEffect(() => {
    if (!authorized || !experimentTool || !requestedRun || !requestedBinding) return
    setComponentLocation({ key: requestedBinding, requestId: requestedRun, token: requestedRun })
    setTool(experimentTool)
  }, [authorized, experimentTool, requestedRun, requestedBinding])
  useEffect(() => {
    const taskId = namespace + ':' + activity.activityId
    includeCenterTab(taskId, PDF_TOOL)
    setLayoutReady(true)
  }, [namespace, activity.activityId, resourceTitle])
  const showResource = useCallback(() => {
    if (window.matchMedia('(width < 1024px)').matches) setDetailsOpen(false)
    if (window.matchMedia('(width <= 760px)').matches) references.setOpen(false)
    setTool(PDF_TOOL)
  }, [references.setOpen])
  const revealPdf = useCallback(async (origin: PdfOrigin) => {
    await workspace.leave()
    if (origin === 'course') {
      setCoursePdfOpen(true)
      setResourceSection('course')
    } else setResourceSection('pdf')
    showResource()
  }, [workspace, showResource])
  const pdf = usePdfMaterials({ activity, spaceKey, namespace, authorized, reveal: revealPdf })
  const revealPersonal = useCallback(async () => {
    await workspace.leave()
    setResourceSection('notes'); showResource()
  }, [workspace, showResource])
  const personal = usePersonalMaterials({ activity, spaceKey, namespace, authorized, reveal: revealPersonal })
  const revealCourse = async (isCurrent: () => boolean) => {
    try { await workspace.leave() }
    catch (cause) {
      if (isCurrent()) toast.error('当前输入尚未保护，请保留页面后继续。')
      throw cause
    }
    if (!isCurrent()) return
    setCoursePdfOpen(false)
    setResourceSection('course'); showResource()
    if (window.matchMedia('(width < 1024px)').matches) references.setOpen(false)
  }
  const courseMaterials = useCourseMaterials({ activity, spaceKey, namespace, authorized, reveal: revealCourse })
  const openCourseMaterial = (materialId: string) => {
    const material = activity.course?.materials.find(item => item.materialId === materialId)
    if (!material) return
    if (!authorized) toast.error('请重新连接学习空间后查看课程材料。')
    else if (isCoursePdf(material.mediaType)) {
      if (pdf.writable) void pdf.openCourse(materialId)
      else toast.error('还原校验副本可下载课程 PDF。')
    } else void courseMaterials.open(materialId)
  }
  const pendingQuestion = agent?.conversation?.questions.find(question => question.state === 'pending')
  const waitText = typeof pendingQuestion?.presentation.question === 'string' ? pendingQuestion.presentation.question : 'Agent 有一个问题想与你确认。'
  const [focusQuestionId, setFocusQuestionId] = useState<string | null>(null)
  const questionBox = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (!references.open || !focusQuestionId) return
    if (focusQuestionId === pendingQuestion?.questionId) questionBox.current?.focus({ preventScroll: true })
    setFocusQuestionId(null)
  }, [references.open, focusQuestionId, pendingQuestion?.questionId])
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
        return courseMaterials.locateResult(source.materialId,
          typeof match?.locator?.start === 'number' && typeof match.locator.end === 'number'
            ? { start: match.locator.start, end: match.locator.end } : undefined)
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
    if (typeof objectId === 'string' && typeof contentId === 'string') {
      const file = workspace.snapshot().files.find(item => item.objectId === objectId)
      const range = questionReferenceRangeSchema.safeParse(record.basis.range ?? (reference.success ? reference.data.range : null))
      if (!file || file.contentId !== contentId || range.success && range.data.kind === 'text') {
        try {
          const original = workFileSchema.parse(await learningRequest(activity, spaceKey, namespace,
            `workspaces/${activity.activityId}/contents/${encodeURIComponent(contentId)}`))
          if (original.objectId !== objectId || original.contentId !== contentId || original.encoding === 'base64')
            return { ok: false, reason: '这份作品的固定版本当前不可显示。' }
          const text = range.success && range.data.kind === 'text'
            ? original.value.slice(range.data.start, range.data.end) : original.value
          setFixedWork({ name: original.name, version: contentId, text })
          return { ok: true }
        } catch { return { ok: false, reason: '这份作品的固定版本当前不可读取。' } }
      }
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
    if (fixed?.kind === 'course-material') {
      const range = reference.success && reference.data.range.kind === 'text' && reference.data.source.kind === 'course-material'
        && questionReferenceSourceId(reference.data.source) === questionReferenceSourceId(fixed)
        && reference.data.source.materialSha256 === fixed.materialSha256
        ? { ...reference.data.range, copy: reference.data.copy } : undefined
      const citedRange = questionReferenceRangeSchema.safeParse(record.basis.range)
      return courseMaterials.locate(fixed, range ?? (citedRange.success && citedRange.data.kind === 'text' ? citedRange.data : undefined))
    }
    if (fixed?.kind === 'course-field') {
      if (fixed.releaseId !== activity.course?.releaseId) return { ok: false, reason: '材料版本已变化，固定副本仍保留。' }
      setDetailsOpen(true)
      if (window.matchMedia('(width < 1024px)').matches) references.setOpen(false)
      return focusLocation(root.current, '[data-course-requirements]')
    }
    return { ok: false, reason: '原来源当前无法定位，固定依据和结果仍保留。' }
  }
  const openCitation = async (item: CitationRecord) => {
    const source = item.citation.source
    if (source.kind === 'tool-call') {
      const toolCallId = typeof source.toolCallId === 'string' ? source.toolCallId : null
      const tool = toolCallId ? agent?.conversation?.tools.find(candidate => candidate.toolCallId === toolCallId) : undefined
      if (!tool) { toast.error('原工具记录在当前会话中不可用。'); return }
      const data = toolResultData(tool)
      const file = data?.file && typeof data.file === 'object' && !Array.isArray(data.file)
        ? data.file as Record<string, unknown> : null
      const reference = data?.reference && typeof data.reference === 'object' && !Array.isArray(data.reference)
        ? data.reference as Record<string, unknown> : null
      const resultSource = data?.source && typeof data.source === 'object' && !Array.isArray(data.source)
        ? data.source as Record<string, unknown> : null
      const query = data?.query && typeof data.query === 'object' && !Array.isArray(data.query)
        ? data.query as Record<string, unknown> : null
      const view: TeachingToolRecordView = { commandId: tool.toolCallId, runId: tool.turnId, name: tool.name,
        state: tool.state === 'closed' ? 'settled' : tool.state === 'started' ? 'dispatching' : 'prepared',
        outcome: tool.state === 'closed' ? 'completed' : null, result: data,
        feedback: '', arguments: file && typeof file.objectId === 'string' && typeof file.contentId === 'string'
          ? { objectId: file.objectId, contentId: file.contentId } : {},
        basis: { ...(reference ? { reference } : {}), ...(resultSource ? { source: resultSource } : {}) },
        source: typeof query?.requestId === 'string' ? { label: item.citation.label, requestId: query.requestId,
          ...(typeof query.contentId === 'string' ? { contentId: query.contentId } : {}) } : null }
      const result = await locateTool(view)
      if (!result.ok) toast.error(result.reason)
      return
    }
    const name = source.kind === 'work' ? 'read_work'
      : source.kind === 'component' ? 'read_result'
        : source.kind === 'personal-material' ? 'read_personal_material' : 'read_reference'
    const view: TeachingToolRecordView = { commandId: item.citation.citationId, runId: item.turnId,
      name, state: 'settled', outcome: 'completed', result: { source }, feedback: '',
      arguments: source.kind === 'work' ? { objectId: source.objectId, contentId: source.contentId } : {},
      basis: { source, range: item.citation.range }, source: source.kind === 'component'
        ? { label: item.citation.label, ...(typeof source.requestId === 'string' ? { requestId: source.requestId } : {}),
          ...(typeof source.bindingKey === 'string' ? { componentKey: source.bindingKey } : {}) }
        : source.kind === 'personal-material' && typeof source.requestId === 'string'
          ? { label: item.citation.label, requestId: source.requestId } : null }
    const result = await locateTool(view)
    if (!result.ok) toast.error(result.reason)
  }
  const tools: ToolSpec[] = [{ key: 'design', label: '作品', icon: 'code-square' },
    { key: PDF_TOOL, label: '学习资料', icon: 'file-text' },
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
  const pdfContent = pdf.document && !pdf.document.courseSource
    ? <PdfMaterials pdf={pdf} active={tool === PDF_TOOL && resourceSection === 'pdf'} onBackToList={pdf.closeDocument} />
    : <PersonalPdfLibrary pdf={pdf} />
  let courseContent: ReactNode = null
  if (resourceTitle) {
    courseContent = coursePdfOpen && pdf.document?.courseSource
      ? <PdfMaterials pdf={pdf} active={tool === PDF_TOOL && resourceSection === 'course'} onBackToList={() => {
        pdf.closeDocument()
        courseMaterials.close()
        setCoursePdfOpen(false)
      }} />
      : <CourseMaterialReader reader={courseMaterials} title={resourceTitle}
        description={course ? `${course.materials.length} 份随课程发布的材料` : `${activity.references.length} 条学习链接`}
        library={course ? <>
          {courseResources?.(openCourseMaterial)}
          <PendingCoursePdfs pdf={pdf} materials={course.materials} />
        </> : <ul className="workspace-study-links">
          {activity.references.map((item, index) => <li key={index}><a href={item.url} target="_blank" rel="noreferrer">{item.label}</a></li>)}
        </ul>} />
  }
  toolBodies[PDF_TOOL] = <section className="workspace-resources" aria-label="学习资料">
    <div className="workspace-resource-nav" role="group" aria-label="资料分类">
      {resourceTitle && <button type="button" aria-pressed={resourceSection === 'course'} onClick={() => setResourceSection('course')}>{resourceTitle}</button>}
      <button type="button" aria-pressed={resourceSection === 'pdf'} onClick={() => setResourceSection('pdf')}>个人 PDF</button>
      <button type="button" aria-pressed={resourceSection === 'notes'} onClick={() => setResourceSection('notes')}>个人笔记</button>
    </div>
    {courseContent && <div className="workspace-resource-content" hidden={resourceSection !== 'course'}>{courseContent}</div>}
    <div className="workspace-resource-content" hidden={resourceSection !== 'pdf'}>{pdfContent}</div>
    <div className="workspace-resource-content" hidden={resourceSection !== 'notes'}>
      <PersonalMaterials personal={personal} />
    </div>
  </section>
  for (const entry of artifacts.entries.filter(item => item.revision)) toolBodies[`gen:${entry.artifact.artifactId}`] =
    <ArtifactCard center entry={entry} controller={artifacts} onClose={async () => {
      await workspace.leave(); artifacts.setOpened(null); center.current?.closeGenTab(entry.artifact.artifactId); setTool('design')
    }} />
  const title = activity.course?.taskTitle || project.project?.content.title || activity.goal || activity.question || '资料学习'
  const shelvedEntries = artifacts.entries.filter(entry => entry.artifact.shelved)
  const artifactShelf = shelvedEntries.length > 0 && <div className="teaching-artifact-shelf" aria-label="收纳的学习页面">
    {shelvedEntries.map(entry => <button key={entry.artifact.artifactId} type="button" className="ws-btn ghost"
      disabled={!entry.revision} onClick={() => void openArtifact(entry.artifact.artifactId).then(() => {
        if (courseWorkspace) setDockPanel(panel => panel === 'stash' ? null : panel)
      }).catch(() => toast.error('当前输入尚未保护，请保留页面后继续。'))}>{entry.artifact.title}</button>)}
  </div>
  const detailsLabel = course ? '目标与要求' : '学习目标'
  const detailsCovered = () => references.open && window.matchMedia('(width < 1024px)').matches
  const openDetails = () => {
    hasToggledDetails.current = true
    if (detailsCovered()) references.setOpen(false)
    setDetailsOpen(true)
  }
  const personalDetailsEntry = !courseWorkspace && <button ref={detailsToggle} type="button" className="ws-btn ghost product-task-details-toggle" aria-expanded={detailsOpen}
    aria-controls={detailsOpen ? 'activity-details' : undefined} onClick={() => {
      hasToggledDetails.current = true
      if (detailsOpen && !detailsCovered()) setDetailsOpen(false)
      else openDetails()
    }}><IconText name="clipboard-text">{detailsLabel}</IconText></button>
  const detailsContent = <>
    {project.project ? <PersonalProjectPlan project={project.project} /> : details}
    {project.error && <p role="alert">项目清单暂时无法读取。<button type="button" onClick={() => void project.retry()}>重试</button></p>}
  </>
  const detailsShellVisible = detailsOpen || detailsMounted
  return <div ref={root} className={'ws ws-organized product-workspace' + (references.open ? ' discussion-open' : '')}>
    <header className="ws-head">
      <button type="button" className="ws-navbtn" aria-label="返回活动列表" onClick={onBack}><Icon name="arrow-left" size={18} /></button>
      <div className="product-activity-title"><span>{activity.course?.courseName ?? '自主学习'}</span><h1 id="activity-title">{title}</h1></div>
      <div className="ws-head-utilities">
        <ActivitySubmission activity={activity} spaceKey={spaceKey} namespace={namespace} authorized={authorized}
          workspace={workspace} execution={execution} artifacts={artifacts.entries} beforeFreeze={() => waitForComposerComposition(scope)}
          isComposing={() => [...artifacts.guards.values()].some(guard => guard.composing)} />
        {personalDetailsEntry}
        <button ref={ask} type="button" className="ws-btn ghost" aria-label={references.open ? '问题与引用' : '打开对话'}
          aria-expanded={references.open} onClick={() => references.setOpen(!references.open)}><IconText name="chat-round-dots">询问 Agent</IconText></button>
        {latestExperimentReference && onAskHome && <button type="button" className="ws-btn ghost"
          onClick={() => void onAskHome(latestExperimentReference)}><IconText name="chat-round-dots">到主页追问</IconText></button>}
        <WorkspacePopover label="活动" icon="menu-dots">
          <p>{activity.status === 'closed' ? '活动已关闭，可随时重新开始。' : '继续围绕这个目标学习。'}</p>
          <button type="button" className="ws-btn ghost" disabled={busy || readOnly} onClick={onStatus}>{activity.status === 'closed' ? '重新开始活动' : '关闭活动'}</button>
          <button type="button" className="ws-btn ghost" disabled={busy} onClick={onRefresh}>刷新列表</button>
          {!courseWorkspace && artifactShelf}
          {account}
        </WorkspacePopover>
      </div>
    </header>
    {readOnly && <div role="status" className="product-workspace-notice">这是还原校验副本，作品与学习对话只读，不会启动 Agent 或实验；请由维护者完成接管后继续。</div>}
    <div className="ws-commandbar">
      <div className="ws-head-tabs" ref={setTabsSlot} />
      <WorkspaceStatus closed={activity.status === 'closed'} hasTools={!!course?.components?.length} />
    </div>
    <div className="ws-body" data-task-dock={courseWorkspace || undefined}>
      {courseWorkspace && (
        <button
          ref={detailsRailToggle}
          type="button"
          className="product-task-details-rail-toggle"
          aria-expanded={detailsOpen}
          aria-controls={detailsOpen ? 'activity-details' : undefined}
          aria-label={detailsOpen ? `收起${detailsLabel}` : `展开${detailsLabel}`}
          data-tip={detailsOpen ? `收起${detailsLabel}` : `展开${detailsLabel}`}
          onClick={() => {
            hasToggledDetails.current = true
            if (detailsOpen && !detailsCovered()) setDetailsOpen(false)
            else openDetails()
          }}
        >
          <Icon name="panel-left-close" className={detailsOpen ? undefined : 'panel-left-open'} />
        </button>
      )}
      {detailsShellVisible && <div className="product-task-details-shell" data-open={detailsOpen ? 'true' : 'false'}
        data-animate={hasToggledDetails.current || undefined}>
        {detailsOpen ? (
          <aside id="activity-details" className="product-task-details" aria-label={detailsLabel}>
            <div className="product-task-details-bar">
              <span className="product-task-details-label">{detailsLabel}</span>
              {!courseWorkspace && (
                <button
                  ref={detailsCollapse}
                  type="button"
                  className="product-task-details-collapse"
                  aria-label={`收起${detailsLabel}`}
                  data-tip={`收起${detailsLabel}`}
                  onClick={() => {
                    hasToggledDetails.current = true
                    returnDetailsFocus.current = true
                    setDetailsOpen(false)
                  }}
                >
                  <Icon name="panel-left-close" size={16} variant="linear" tone="neutral" />
                </button>
              )}
            </div>
            <div className="product-task-details-body">
              {detailsContent}
            </div>
          </aside>
        ) : (
          <div className="product-task-details" aria-hidden="true" inert={true}>
            <div className="product-task-details-bar">
              <span className="product-task-details-label">{detailsLabel}</span>
              {!courseWorkspace && (
                <button type="button" className="product-task-details-collapse" tabIndex={-1} aria-hidden="true">
                  <Icon name="panel-left-close" size={16} variant="linear" tone="neutral" />
                </button>
              )}
            </div>
            <div className="product-task-details-body">
              {detailsContent}
            </div>
          </div>
        )}
      </div>}
      {layoutReady && <CenterToolArea ref={center} taskId={namespace + ':' + activity.activityId} tools={tools} toolBodies={toolBodies}
        {...(experimentTool ? { initialTool: experimentTool } : {})}
        genCards={artifacts.entries.flatMap(entry => entry.revision ? [{ cardId: entry.artifact.artifactId, title: entry.artifact.title,
          taskId: activity.activityId, claimSim: false, srcdoc: entry.revision.payload.html, version: entry.revision.version, collectedAt: entry.artifact.createdAt }] : [])}
        onGenTabsChange={ids => {
          artifacts.setCenterIds(previous => JSON.stringify(previous) === JSON.stringify(ids) ? previous : ids)
          if (artifacts.opened && artifactTabs.current.includes(artifacts.opened) && !ids.includes(artifacts.opened)) artifacts.setOpened(null)
          artifactTabs.current = ids
        }}
        beforeToolChange={() => workspace.leave()}
        tool={tool} onToolChange={value => { void workspace.leave().then(() => {
          artifacts.setOpened(value.startsWith('gen:') ? value.slice(4) : null)
          if (value === PDF_TOOL) showResource()
          else setTool(value)
        }).catch(() => toast.error('当前输入尚未保护，请保留页面后继续。')) }} onToast={message => toast(message)} tabsSlot={tabsSlot}
        designBody={<>{(activity.course?.components??[]).filter(b=>b.definition.manifest.formatVersion===3).map(binding=>
          <RuntimeTool compact key={binding.key} activity={activity} binding={binding} spaceKey={spaceKey} namespace={namespace} authorized={authorized}/>)}
          <ActivityWorkspace activity={activity} spaceKey={spaceKey} namespace={namespace} authorized={authorized} location={workLocation} /></>} />}
      <aside className="product-discussion" aria-label="问题与引用" inert={!references.open}
        style={references.open ? undefined : { display: 'none' }}>
        <header className="product-discussion-header">
          <h2><Icon name="chat-round-dots" size={17} />与 Agent 对话</h2>
          <Button type="button" variant="outline" onClick={() => { references.setOpen(false); ask.current?.focus() }}>
            <Icon name="close" size={14} />收起对话
          </Button>
        </header>
        <ActivityActions activity={activity} />
        <ChatViewport scrollerRef={conversationScroll.scroller} onScroll={conversationScroll.onScroll} onJump={conversationScroll.onJump}
          busy={conversationActive} phase={conversationActive ? 'streaming' : undefined} padSuggestions={false} queued={false}>
          <ActivityConversation activity={activity} onLocateTool={locateTool} onOpenCitation={openCitation}
            artifacts={artifacts} onOpenArtifact={openArtifact} />
          {agentSessionError && <p role="alert" className="learning-error product-discussion-error">
            {agentSessionError}<Button type="button" variant="outline" onClick={retryAgentSession}>重新打开对话</Button>
          </p>}
        </ChatViewport>
        <div className="product-discussion-input">
          <ProductComposerDock atBottom={conversationScroll.atBottom} onBackToBottom={conversationScroll.backToBottom}>
            {agent && pendingQuestion && references.open
              ? <SessionQuestionBox key={pendingQuestion.questionId + ':' + pendingQuestion.version} focusRef={questionBox}
                question={pendingQuestion} controller={agent} readOnly={readOnly || !authorized || activity.status !== 'open'} />
              : <ActivityPromptComposer activity={activity} spaceKey={spaceKey} namespace={namespace} authorized={authorized}
                selection={selection} onModels={onModels} active={conversationActive}
                sending={sending} closeFocusRef={ask} onSend={conversationScroll.backToBottom} />}
          </ProductComposerDock>
        </div>
      </aside>
      {course && <SideDock taskButtonRef={taskInfoEntryRef} openPanel={dockPanel} onOpenPanelChange={setDockPanel}
        taskInfo={<TaskInfo name={title} course={course.courseName}
          status={<StatusChip status={activity.status === 'closed' ? '已关闭' : '进行中'} />}
          percent={taskProgress?.percent} done={taskProgress?.done}
          deadline={deadline?.deadlineAt ? <time dateTime={deadline.deadlineAt}>{formatDeadline(deadline.deadlineAt)}</time>
            : deadline ? '无截止时间' : undefined} />}
        stashPanel={{ count: shelvedEntries.length, content: <section className="ws-dock-content">
          <h2>卡片收纳</h2>
          {artifactShelf || <p>{artifacts.error || '在学习页面点「收纳」后，卡片会显示在这里。'}</p>}
        </section> }} />}
    </div>
    <SelectionToolbar />
    <Dialog.Root open={!!fixedWork} onOpenChange={open => { if (!open) setFixedWork(null) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="xj-confirm-overlay" />
        <Dialog.Content className="xj-confirm-dialog activity-submission-dialog">
          <Dialog.Title className="xj-confirm-title">{fixedWork?.name}</Dialog.Title>
          <Dialog.Description className="xj-confirm-description">固定作品版本 {fixedWork?.version.slice(0, 8)}</Dialog.Description>
          <pre className="teaching-tool-excerpt">{fixedWork?.text}</pre>
          <Dialog.Close className="ws-btn">关闭</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {!references.open && pendingQuestion && <GuidancePresentation item={{ id: pendingQuestion.questionId, content: { kind: 'text', text: waitText }, target: () => ask.current,
      actions: [{ id: 'respond', label: '回应 Agent', primary: true }] }} onAction={() => { references.setOpen(true); setFocusQuestionId(pendingQuestion.questionId) }} />}


  </div>
}
