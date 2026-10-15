import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, IconText } from '../icons'
import { CenterToolArea, type ToolKey } from '../components/workspace/CenterToolArea'
import { SideDock } from '../components/workspace/SideDock'
import { PrepTaskInfo, TextScopeBodyPane } from '../components/workspace/TextScopePanes'
import { ConfirmationCluster } from '../components/workspace/ConfirmationCluster'
import { ConflictCompare } from '../components/workspace/ConflictCompare'
import { VersionCompare } from '../components/workspace/VersionCompare'
import { RunPanel, CoreRunEntry, type CoreSelection } from '../components/workspace/RunPanel'
import { settledJob } from '../workspace/runResults'
import { useRunWorkspace } from '../workspace/useRunWorkspace'
import { RunHistoryPanel, type HistorySideDisplay } from '../components/workspace/RunHistoryPanel'
import { useRunHistory } from '../workspace/useRunHistory'
import { historyLabel } from '../workspace/runHistory'
import type { CoreInput } from '../workspace/runRequest'
import { CodeWorkspace } from '../components/workspace/CodeWorkspace'
import { buildVersionComparison } from '../workspace/comparison'
import { defaultVersionPair, isSnapshotSource, versionSourceOptions } from '../workspace/versionSources'
import { useProjectWorkspace } from '../components/workspace/useProjectWorkspace'
import { useConfirmationWorkspace } from '../workspace/useConfirmationWorkspace'
import { canReplay, comparableOutcome } from '../workspace/recovery'
import { describeError, reportDiagnostic } from '../workspace/diagnostics'
import { idbDraftRepository } from '../workspace/draftDb'
import { scopeKey, type DraftScope } from '../lib/draftStore'
import { PREP_BUILD, workspaceMode } from '../workspace/mode'
import { PREP_ENTRY_LABEL, PREP_TASK_ID } from '../workspace/prepEntry'
import { signOut } from '../workspace/session'
import { useWorkspaceInit, type InitStatus } from '../workspace/useWorkspaceInit'
import { useTutoringWorkspace } from '../workspace/useTutoringWorkspace'
import { TutoringPane } from '../components/workspace/TutoringPane'
import { createRunHelpObjectRef, type RunHelpTarget } from '../workspace/tutoringRun'
import type { TutorObject } from '../workspace/tutoringContracts'
import { TutoringControls } from '../components/workspace/TutoringControls'
import type { AssignmentView } from '../workspace/contracts'
import type { CodeEditorHandle, CodeEditorViewState } from '../components/workspace/CodeEditorHost'
import { createCodeObjectRef, verifyCodeTarget, type CodeDraft } from '../workspace/tutoringObject'
import { TutoringExample } from '../components/workspace/TutoringExample'
import { resolveTutoringReferences, captureTutoringReturn, validateTutoringReturn,
  type TutoringResourceResult, type TutoringReturnAnchor, type TutoringReturnFile } from '../workspace/tutoringReturn'
import type { TutorMessage } from '../workspace/tutoringStore'
import type { CommandContext } from '../workspace/frozenCommand'
import { useHdlWorkspace } from '../workspace/useHdlWorkspace'
import { HdlBoardPane, HdlTracePane, HdlBuildPane, HdlRunCluster } from '../components/workspace/HdlToolArea'
import type { HdlBuildView, HdlDiagnostic, HdlInputs } from '../workspace/hdlContracts'
import { hdlDiagnosticTarget } from '../workspace/hdlDiagnostic'
import { createTutorHdlCurrent, type TutorHdlSelection } from '../workspace/tutoringHdl'
import { SubmissionFeedbackPanel } from '../components/workspace/SubmissionFeedbackPanel'

type ReturnOrigin={fileId:string;path:string;documentVersion:number|null}
const readingMarkerKey=(c:CommandContext)=>`tutor:return:${JSON.stringify([c.mode,c.userId,c.courseId,c.assignmentId,
  c.activityVersionId,c.attemptId,c.trustedRecoveryGeneration,c.preparationEpoch,c.scenarioId??null])}`
const returnOrigin=(file:TutoringReturnFile):ReturnOrigin=>({fileId:file.serverFileId??file.fileId,path:file.path,documentVersion:file.documentVersion})
function clearReadingMarker(c:CommandContext) {try {sessionStorage.removeItem(readingMarkerKey(c))} catch { /* Current-page return remains usable. */ }}

/**
 * 同一工作区按启动模式读取准备场景或获准真实分配，HDL由学生投影的确切execution分流。
 *
 * 复用原设计的页面骨架与容器：顶栏（标签槽 + 运行簇槽）、左侧胶囊「任务信息」、中心工具区
 * （胶囊标签 + 分屏）。不新造页面或导航，不接原数字逻辑的模拟构建与主动教学引导。
 *
 * 01 的范围是只读初始化与可用容器：编辑属 02，保存/快照属 03，运行属 06。
 * 载入不创建 Attempt、不开始学习、不写学习记录。
 */
export default function PrepWorkspacePage({ assignmentId }: { assignmentId?: string }) {
  const navigate = useNavigate()
  const init = useWorkspaceInit(assignmentId)
  const taskId = PREP_BUILD ? PREP_TASK_ID : assignmentId ?? ''
  const [assignment, setAssignment] = useState<AssignmentView | null>(null)
  const confirmation = useConfirmationWorkspace(init.init, taskId, assignment?.active)
  const hdlExecution = init.init?.kind === 'ready' ? init.init.activity.execution : undefined
  const isHdl = hdlExecution?.kind === 'hdl_board'
  const run = useRunWorkspace(confirmation.client, init.init, !isHdl)
  const hdl = useHdlWorkspace(confirmation.client, init.init)
  const [hdlSnapshotId, setHdlSnapshotId] = useState('')
  const [hdlSelection, setHdlSelection] = useState<TutorHdlSelection | undefined>()
  const [replaceTarget, setReplaceTarget] = useState<{ sessionId: string; sessionRevision: number; buildId: string } | null>(null)
  const [runOpen, setRunOpen] = useState(false)
  const [submissionOpen, setSubmissionOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const history = useRunHistory(confirmation.client, runOpen && historyOpen)
  const [runSelection, setRunSelection] = useState<CoreSelection>({ snapshotId: '', entryFileId: '', fileIds: [], operation: 'stats', word: '', count: '10' })
  const c = confirmation.client?.context
  const tutor = useTutoringWorkspace(confirmation.client, isHdl)
  const [tutorOpen, setTutorOpen] = useState(false)
  const [tutorObject, setTutorObject] = useState<TutorObject | undefined>(undefined)
  const [tutorObjectLabel, setTutorObjectLabel] = useState('')
  const [codeBasis, setCodeBasis] = useState<CodeDraft | null>(null)
  const [codeSnapshotId, setCodeSnapshotId] = useState('')
  const editorHandle = useRef<CodeEditorHandle>(null)
  useEffect(() => {
    setRunOpen(false)
    setSubmissionOpen(false)
    setHistoryOpen(false)
    setRunSelection({ snapshotId: '', entryFileId: '', fileIds: [], operation: 'stats', word: '', count: '10' })
    setTutorObject(undefined); setCodeBasis(null); setCodeSnapshotId(''); setExample(null)
    setHdlSnapshotId(''); setHdlSelection(undefined); setReplaceTarget(null)
  }, [c])
  useEffect(()=> { setAssignment(null) }, [init.init])
  const draftScope = useMemo<DraftScope | null>(() => c?.attemptId && c.userId
    ? { mode: c.mode, account: c.userId, attemptKey: c.attemptId } : null,
  [c?.mode, c?.userId, c?.attemptId])
  const project = useProjectWorkspace(confirmation.seed, idbDraftRepository, draftScope)
  const projectLive = useRef(project)
  projectLive.current = project
  const hdlSelectedBuild = hdlSelection?.sessionId ? hdl.state.sessionBuild ?? hdl.state.build : hdl.state.build
  useLayoutEffect(() => {
    if (!isHdl || !tutor.client) return
    tutor.client.setHdlCurrent(null)
    let cancelled = false
    // Startup/restore has not authorized a current Build yet. Keep provenance
    // unknown until the complete original read settles; missing initial data
    // is not a witnessed source change that permanently retires a delivery.
    if (!c?.trustedRecoveryGeneration || !confirmation.state.workspace || hdl.state.phase !== 'ready' || hdl.state.pending || hdl.state.unknown || hdl.state.busy) return
    void createTutorHdlCurrent({ workspaceRevision: confirmation.state.workspace.workspaceRevision,
      hasDraftChanges: project.unconfirmedCount > 0 || project.lifecyclePendingCount > 0,
      generation: c.trustedRecoveryGeneration, build: hdlSelectedBuild?.result ?? null, session: hdl.state.session, operation: hdl.state.operation })
      .then(current => { if (!cancelled) tutor.client?.setHdlCurrent(current) })
      .catch(() => { /* Unknown provenance stays unavailable; never construct a replacement basis. */ })
    return () => { cancelled = true }
  }, [isHdl, tutor.client, c, confirmation.state.workspace, project.unconfirmedCount, project.lifecyclePendingCount,
    hdlSelectedBuild, hdl.state.session, hdl.state.operation, hdl.state.phase, hdl.state.pending, hdl.state.unknown, hdl.state.busy])
  const [example, setExample] = useState<{ resource: TutoringResourceResult; anchor: TutoringReturnAnchor<NonNullable<CodeEditorViewState>> | null } | null>(null)
  const [returnNotice,setReturnNotice]=useState<{notice:string;origin?:ReturnOrigin}|null>(null)
  useEffect(()=> {
    setReturnNotice(null)
    if(!c?.attemptId || !c.userId)return
    const key=readingMarkerKey(c)
    try {
      const raw=sessionStorage.getItem(key)
      if(!raw)return
      const value=JSON.parse(raw),origin=value?.origin
      if(value?.key===key && typeof origin?.fileId==='string' && origin.fileId && typeof origin.path==='string' && origin.path &&
        (origin.documentVersion===null || Number.isSafeInteger(origin.documentVersion)&&origin.documentVersion>=1))
        setReturnNotice({notice:'上次阅读的精确位置未保留；原引用仅供核对，请明确选择当前作品。',origin})
      else setReturnNotice({notice:'上次阅读的本机引用不可用，精确位置未保留；请明确选择当前作品。'})
      clearReadingMarker(c)
    } catch {
      setReturnNotice({notice:'本机阅读引用不可回取，无法确认旧精确位置；请明确选择当前作品。'})
      clearReadingMarker(c)
    }
  },[c])
  const [tool, setTool] = useState<ToolKey>('design')
  const [tabsSlot, setTabsSlot] = useState<HTMLElement | null>(null)
  const [runSlot, setRunSlot] = useState<HTMLElement | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((text: string) => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])
  function onRunHelp(target: RunHelpTarget) {
    if (!confirmation.client) return
    const detail = history.state.sides.find(s=>s.detail?.run.runId===target.runId)?.detail
    const job = target.runId===run.state.run?.runId ? run.state.job : detail?.job
    const originalRun = target.runId===run.state.run?.runId ? run.state.run : detail?.run
    try {
      const ref = createRunHelpObjectRef(confirmation.client.context, target, job, originalRun)
      setCodeBasis(null)
      setTutorObject({ ...ref }); setTutorObjectLabel(`原运行 ${ref.runId} · 原快照 ${ref.snapshotId}（不重跑）`); setTutorOpen(true)
    } catch(e) { showToast(describeError(e)) }
  }
  function onHdlHelp(board = false) {
    const build = board ? hdl.state.sessionBuild ?? hdl.state.build : hdl.state.build
    const result = build?.result, session = hdl.state.session, operation = hdl.state.operation
    if (!build || !result || !['succeeded', 'failed'].includes(result.status) || hdl.state.pending || hdl.state.unknown || project.unconfirmedCount > 0) {
      showToast('请先核对所选构建和确认作品；求助不会自动保存或构建。'); return
    }
    if (board && (!session || !operation || session.pendingOperationId || session.stopRequested || session.terminationConfirmed ||
      session.status !== 'active' || operation.sessionId !== session.sessionId || operation.sequence !== session.confirmedSequence)) {
      showToast('原板卡会话或采样尚未核对，请先读取结果。'); return
    }
    const selection: TutorHdlSelection = { snapshotId: build.request.snapshot.snapshotId, buildId: result.buildId,
      ...(board ? { sessionId: session!.sessionId, operationId: operation!.operationId } : {}) }
    setHdlSelection(selection); setTutorObject(undefined); setCodeBasis(null)
    setCodeSnapshotId(selection.snapshotId)
    setTutorObjectLabel(board ? `原板卡采样 · 序号 ${operation!.sequence}` : `所选构建 · 确认作品 v${build.request.snapshot.workspaceRevision}`)
    setTutorOpen(true)
  }
  function onHdlDiagnostic(diagnostic: HdlDiagnostic, build: HdlBuildView) {
    if (!draftScope) return
    const drafts = projectLive.current.files.map(file => projectLive.current.readCodeDraft(file.fileId)).filter((v): v is CodeDraft => !!v)
    const target = hdlDiagnosticTarget(diagnostic, build, drafts)
    if (target.kind !== 'current') { showToast(target.notice); return }
    setTool('design'); setRunOpen(false); project.open(target.draft.fileId)
    const location = { workspaceKey: scopeKey(draftScope), fileId: target.draft.fileId, originalText: target.draft.text, range: target.range }
    window.requestAnimationFrame(() => {
      const result = editorHandle.current?.revealOriginalRange(location)
      if (result && !result.ok) showToast(result.reason)
    })
  }
  function onHdlBuild() {
    if (!hdlSnapshotId) { showToast('请明确选择确认快照。'); return }
    tutor.client?.setHdlCurrent(null); void hdl.client?.build(hdlSnapshotId)
  }
  function onHdlLoad() {
    const buildId = hdl.state.build?.result?.buildId
    if (!buildId) return
    if (hdl.state.session && !hdl.state.session.terminationConfirmed) {
      setReplaceTarget({ sessionId: hdl.state.session.sessionId, sessionRevision: hdl.state.session.sessionRevision, buildId }); return
    }
    tutor.client?.setHdlCurrent(null); void hdl.client?.program(buildId)
  }
  function onHdlInteract(inputs: HdlInputs, advanceCycles: number) {
    tutor.client?.setHdlCurrent(null); void hdl.client?.interact(inputs, advanceCycles)
  }
  function onHdlStop() {
    tutor.client?.setHdlCurrent(null); void hdl.client?.stop('学生显式停止虚拟板会话')
  }
  function codeObjectCurrent() {
    if (!codeBasis) return true
    const current=projectLive.current.readCodeDraft(codeBasis.fileId)
    return !!current && current.workspaceKey===codeBasis.workspaceKey && current.serverFileId===codeBasis.serverFileId &&
      current.lifecycle==='active' && current.text===codeBasis.text && current.confirmed?.version===codeBasis.confirmed?.version
  }
  function messageSourceStatus(ref:TutorObject) {
    if(ref.kind!=='code')return '只核对原对象，不定位或替换当前作品。'
    const file=projectLive.current.files.find(f=>f.serverFileId===ref.fileId)
    const draft=file?projectLive.current.readCodeDraft(file.fileId):null
    const confirmed=confirmation.client?.current.workspace?.files.find(f=>f.fileId===ref.fileId)
    if(!draft||draft.lifecycle!=='active')return '原文件当前不可用；同名文件不承接这份回答。'
    if(!draft.confirmed||draft.path!==ref.path||draft.confirmed.version!==ref.documentVersion||confirmed?.contentHash!==ref.contentHash)
      return '当前文件或确认版本已改变；回答仍依据原快照。'
    if(draft.text!==draft.confirmed.text)return '本机草稿已修改；回答仍依据原快照，不代表当前草稿。'
    return '当前文件仍对应该确认版本；回答依据原快照，不自动定位或修改。'
  }
  async function onCodeHelp(intent:'file'|'selection') {
    const client=confirmation.client, context=client?.context, localId=projectLive.current.activeFile?.fileId
    if(!client || !context?.attemptId || !context.activityVersionId || !draftScope || !localId) {showToast('请先打开一个已确认文件。');return}
    const before=projectLive.current.readCodeDraft(localId), selected=intent==='selection'?editorHandle.current?.captureSelection():null
    if(!before?.serverFileId) {showToast('请先自主确认作品并冻结快照，求助不会自动保存。');return}
    if(intent==='selection' && !selected?.ok) {showToast(selected && !selected.ok?selected.reason:'请明确选择代码。');return}
    const snapshot=confirmation.state.snapshots.find(s=>s.snapshotId===(codeSnapshotId||confirmation.state.snapshot?.snapshotId))
    if(!snapshot) {showToast('请先自主冻结并选择已确认快照。');return}
    if (isHdl && (!hdlSelection || hdlSelection.snapshotId !== snapshot.snapshotId)) {
      showToast('请先引用同一确认快照的真实构建，再选择代码求助。'); return
    }
    try {
      const target=await verifyCodeTarget(snapshot,{workspaceKey:scopeKey(draftScope),attemptId:context.attemptId,activityVersionId:context.activityVersionId},before.serverFileId)
      if(!client.isCurrent(context)) return
      const current=projectLive.current.readCodeDraft(localId), selection=intent==='selection'?editorHandle.current?.captureSelection():null
      if(selected?.ok && (!selection?.ok || JSON.stringify(selection.selection)!==JSON.stringify(selected.selection))) {showToast('选区已改变，请重新核对。');return}
      const result=createCodeObjectRef({workspaceKey:scopeKey(draftScope),target,draft:current,intent,selection:selected?.ok?selected.selection:null})
      if(!result.ok) {showToast(result.reason);return}
      setCodeBasis(current);setTutorObject({...result.objectRef});setTutorObjectLabel(`${result.objectRef.path} · 文件版本 ${result.objectRef.documentVersion} · 快照 ${result.objectRef.snapshotId}${result.objectRef.range?` · 行 ${result.objectRef.range.startLine}–${result.objectRef.range.endLine}`:' · 整个文件'}`);setTutorOpen(true)
    }catch(e) {if(client.isCurrent(context))showToast(describeError(e))}
  }
  function returnFiles():TutoringReturnFile[] {
    return projectLive.current.files.map(f=>({fileId:f.fileId,serverFileId:f.serverFileId,path:f.path,lifecycle:f.lifecycle,
      documentVersion:f.confirmed?.version??null,contentHash:confirmation.client?.current.workspace?.files.find(s=>s.fileId===f.serverFileId)?.contentHash??null,
      draftText:projectLive.current.draftText(f.fileId)}))
  }
  async function onExample(message:TutorMessage) {
    const client=confirmation.client
    if(init.init?.kind!=='ready' || !c || !client?.isCurrent(c)) return
    try {
      const resource=await resolveTutoringReferences(message.payload.resourceRefs??[],init.init.activity,init.init.materials,c.mode)
      if(!client.isCurrent(c)) return
      const file=returnFiles().find(f=>f.fileId===projectLive.current.activeFile?.fileId)
      const view=editorHandle.current?.saveViewState()??null
      const anchor=file?captureTutoringReturn(c,file,view):null
      if(resource.kind==='ready' && anchor) {
        try {sessionStorage.setItem(readingMarkerKey(c),JSON.stringify({key:readingMarkerKey(c),origin:returnOrigin(anchor.file)}))}
        catch {setReturnNotice({notice:'本机阅读引用未保留；刷新后不能恢复原精确位置。',origin:returnOrigin(anchor.file)})}
      }
      setExample({resource,anchor});setTutorOpen(false)
    } catch(e) {if(client.isCurrent(c))showToast(describeError(e))}
  }
  function onReturnExample() {
    if(!example) return
    const checked=example.anchor && c ? validateTutoringReturn(example.anchor,c,returnFiles()):null
    setExample(null)
    if(c)clearReadingMarker(c)
    if(checked?.kind==='ready' && example.anchor && draftScope) {
      setReturnNotice(null)
      project.open(checked.fileId)
      // The editor and its saved scroll/fold/undo state remained mounted: focus does not move the view.
      if(projectLive.current.activeFile?.fileId===checked.fileId) editorHandle.current?.focus()
    } else if(checked?.kind==='unavailable') setReturnNotice({notice:checked.notice,
      ...(example.anchor?{origin:returnOrigin(example.anchor.file)}:{})})
    else setReturnNotice({notice:'未保留精确文件位置，返回当前作品继续自主操作。'})
    setTutorOpen(true)
  }

  /* ---------- 04A：服务版本冲突的只读比较 ---------- */
  const comparison = confirmation.state.comparison
  const [compareBusy, setCompareBusy] = useState(false)

  /* ---------- 05：只读版本比较（快照 × 快照 / 草稿 × 确认作品） ---------- */
  /**
   * 比较来源全部来自已经在内存里的已核验事实（确认头、head.snapshots、本机草稿），
   * 打开、切换、离开都只改页面状态：**不发任何请求**，因此不存在隐式写副作用。
   */
  const versionOptions = useMemo(
    () => confirmation.state.workspace === null ? [] : versionSourceOptions({
      snapshots: confirmation.state.snapshots, workspace: confirmation.state.workspace,
      files: project.files, draftText: project.draftText,
    }),
    [confirmation.state.snapshots, confirmation.state.workspace, project.files, project.draftText],
  )
  const [versionSelection, setVersionSelection] = useState<{ left: string; right: string } | null>(null)
  const versionComparison = useMemo(() => {
    if (versionSelection === null) return null
    const left = versionOptions.find(option => option.id === versionSelection.left)
    const right = versionOptions.find(option => option.id === versionSelection.right)
    if (!left || !right) return null
    const bothSnapshots = isSnapshotSource(left.id) && isSnapshotSource(right.id)
    return buildVersionComparison(bothSnapshots ? 'snapshots' : 'draft-confirmed', left.side, right.side)
  }, [versionSelection, versionOptions])
  const versionChoices = useMemo(() => versionOptions.map(({ id, label }) => ({ id, label })), [versionOptions])
  const compareOpen = comparison !== null || versionComparison !== null
  const previousReadingView = useRef({ open: false, context: c })
  useEffect(() => {
    const previous = previousReadingView.current
    const open = compareOpen || runOpen
    if (previous.context !== c) {
      previousReadingView.current = { open: false, context: c }
      return
    }
    if (previous.open && !open) editorHandle.current?.focus()
    previousReadingView.current = { open, context: c }
  }, [compareOpen, runOpen, c])
  const runSnapshots = confirmation.state.snapshots.map(snapshot => ({ id: snapshot.snapshotId,
    label: `确认作品 v${snapshot.workspaceRevision} · ${new Date(snapshot.createdAt).toLocaleTimeString()}`,
    files: snapshot.files.map(file => ({ id: file.fileId, path: file.path, ascii: /^[\x00-\x7f]*$/.test(file.text) })) }))
  const runBusy = run.state.phase === 'submitting' || run.state.phase === 'reading' || run.state.controlBusy
  const historySides = history.state.sides.map(side => {
    const detail = side.detail
    return { runId: side.runId, busy: side.busy, notice: side.notice,
      result: detail ? { ...detail.result, jobId: detail.job.jobId, profile: detail.run.runtimeProfileVersion,
        image: detail.run.imageDigest, mode: detail.run.mode, filesNotice: detail.filesNotice,
        files: detail.files?.status === 'available' ? { status: 'available', files: detail.files.files.map(f => ({
          id: f.resultFileId, name: f.relativeName, status: f.status, contentHash: f.contentHash, bytes: f.bytes, text: f.text,
        })) } : detail.files } : null }
  }) as [HistorySideDisplay, HistorySideDisplay]
  const runPermitted=(assignment??(init.init?.kind==='ready'?init.init.assignment:null))?.active===true &&
    !!confirmation.state.attempt && ['ready','active'].includes(confirmation.state.attempt.status)
  const canRun = runPermitted && run.state.eligible && !run.state.pending && !!runSelection.snapshotId && !!runSelection.entryFileId &&
    runSelection.fileIds.length > 0 && !confirmation.client?.commandInFlight
  const hdlPending = hdl.state.pending || hdl.state.busy || !!hdl.state.session?.pendingOperationId ||
    !!hdl.state.job && !settledJob(hdl.state.job.status)
  const hdlFrame = hdl.state.operation?.finalFrame
  const hdlInputs: HdlInputs = hdlFrame ? { switches: hdlFrame.switches, buttons: hdlFrame.buttons, resetN: hdlFrame.resetN }
    : { switches: '', buttons: '', resetN: '' }
  const hdlResultCurrent = !!hdl.state.session && !!hdl.state.operation && hdl.state.operation.sessionId === hdl.state.session.sessionId &&
    hdl.state.operation.sequence === hdl.state.session.confirmedSequence && hdl.state.operation.sessionRevision === hdl.state.session.sessionRevision
  const hdlSnapshot = confirmation.state.snapshots.find(snapshot => snapshot.snapshotId === hdlSnapshotId)
  const hdlNotice = [hdl.state.notice, project.unconfirmedCount > 0 ? '新草稿尚未确认；已有构建与板卡仍使用各自原快照。' : null]
    .filter(Boolean).join(' ') || null

  /** Esc 关闭比较：只在比较视图打开期间挂监听，行为与「返回编辑」一致。 */
  useEffect(() => {
    if (!compareOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // 服务版本冲突的比较（04A）优先；它没开时才关版本比较。
      if (comparison !== null) confirmation.client?.closeComparison()
      else setVersionSelection(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [compareOpen, comparison !== null, confirmation.client])

  /** 打开比较：从落盘原命令与重读 head 构造比较；内部失败已发布为 state.error，这里兜 toast。 */
  async function onOpenComparison() {
    const pending = confirmation.state.pending
    if (!pending || !confirmation.client) return
    try {
      await confirmation.client.openComparison(pending.commandKey)
    } catch (e) {
      showToast(describeError(e))
    }
  }

  /** 保留本页正文：草稿不动，退役冲突原命令，之后学生重新发起保存。 */
  async function onKeepMine() {
    if (comparison === null || compareBusy) return
    setCompareBusy(true)
    try {
      const result = await confirmation.client?.resolveConflict(comparison.commandKey)
      showToast(result === 'retired' ? '已保留本页正文，可以重新保存了。' : '这次处理没有完成，请重新读取后再试。')
    } catch (e) {
      showToast(describeError(e))
    } finally {
      setCompareBusy(false)
    }
  }

  /** 采用服务端正文：先把服务正文写回对应草稿实例，再退役冲突原命令。 */
  async function onAdoptServer() {
    if (comparison === null || compareBusy) return
    setCompareBusy(true)
    try {
      for (const file of comparison.files) {
        if (file.theirs !== null && file.theirs !== file.mine) project.setDraft(file.localId, file.theirs)
      }
      const result = await confirmation.client?.resolveConflict(comparison.commandKey)
      showToast(result === 'retired' ? '已采用当前作品的正文，可以重新保存了。' : '这次处理没有完成，请重新读取后再试。')
    } catch (e) {
      showToast(describeError(e))
    } finally {
      setCompareBusy(false)
    }
  }

  /* ---------- 04A：本机草稿 CAS 冲突条（与比较视图相互独立） ---------- */
  const [draftConflictBusy, setDraftConflictBusy] = useState(false)

  /** 学生明确选择保留哪一份正文；同一时间只允许一个在途处理。 */
  async function onResolveDraftConflict(fileId: string, choice: 'mine' | 'stored') {
    if (draftConflictBusy) return
    setDraftConflictBusy(true)
    try {
      const result = await project.resolveConflict(fileId, choice)
      showToast(result === 'resolved' ? '已按你的选择更新了草稿。' : '选择期间另一处又写入了新的修订，请重新选择。')
    } catch (e) {
      showToast(describeError(e))
    } finally {
      setDraftConflictBusy(false)
    }
  }

  /** 编辑区上方的冲突条：每个冲突文件一行，两个按钮各选一份正文。 */
  const draftConflictBar = project.conflictedFileIds.length > 0 ? (
    <div className="ws-draft-conflicts">
      <p className="ws-draft-conflicts-note">这份草稿在另一处也被修改过，请选择保留哪一份正文。</p>
      {project.conflictedFileIds.map((fileId) => (
        <div key={fileId} className="ws-draft-conflict" data-fileid={fileId}>
          <span className="ws-draft-conflict-path">
            {project.files.find((f) => f.fileId === fileId)?.path ?? fileId}
          </span>
          <span className="ws-draft-conflict-actions">
            <button
              type="button"
              className="outline"
              disabled={draftConflictBusy}
              onClick={() => { void onResolveDraftConflict(fileId, 'mine') }}
            >
              用本页正文继续
            </button>
            <button
              type="button"
              className="outline"
              disabled={draftConflictBusy}
              onClick={() => { void onResolveDraftConflict(fileId, 'stored') }}
            >
              载入另一处正文
            </button>
          </span>
        </div>
      ))}
    </div>
  ) : null

  /** 正常退出由全局会话入口接管；准备模式继续重建隔离合成会话。 */
  async function onSignOut() {
    if (signingOut) return
    if (!PREP_BUILD) {
      // 不再在旧页面 await 之后重启初始化；它的 401 不能打断下一次登录。
      await signOut(workspaceMode)
      return
    }
    setSigningOut(true)
    confirmation.client?.dispose()
    init.invalidate()
    try {
      await signOut(workspaceMode)
      showToast(PREP_BUILD ? '已退出准备场景' : '已退出当前会话')
      init.reload()
    } catch (e) {
      reportDiagnostic('command.failed', { reason: 'sign out failed', error: describeError(e) })
      showToast('退出没有成功，请稍后再试。')
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="ws">
      <header className="ws-head">
        <div className="ws-navbtns">
          <button
            className="ws-navbtn"
            aria-label="返回"
            onClick={() => {
              if ((window.history.state?.idx ?? 0) > 0) navigate(-1)
              else navigate('/')
            }}
          >
            <Icon name="arrow-left" size={18} />
          </button>
        </div>
        <div className="ws-head-tabs" ref={setTabsSlot} />
        <PrepBadge
          status={init.status}
          loadEpoch={init.loadEpoch}
          signingOut={signingOut}
          onSignOut={onSignOut}
        />
        <div className="ws-head-run" ref={setRunSlot}
          style={isHdl ? { minWidth: 0, flex: '1 1 0', overflowX: 'auto' } : undefined} />
      </header>

      <div className="ws-body">
        <CenterToolArea
          taskId={taskId}
          variant={isHdl ? 'digital-logic-real' : 'textscope-c'}
          tool={tool}
          onToolChange={setTool}
          onToast={showToast}
          boardBody={isHdl ? <HdlBoardPane session={hdl.state.session} result={hdl.state.operation} inputs={hdlInputs}
            pending={hdlPending} disabled={!runPermitted || !hdl.state.canInteract || !hdlResultCurrent}
            bindings={hdlExecution?.configuration.board.bindings} currentNotice={hdlNotice} onInteract={onHdlInteract}
            canLoad={runPermitted && hdl.state.canProgram} onLoad={onHdlLoad}
            readBusy={hdl.state.busy || hdl.state.phase === 'reading'} onRead={hdl.read} /> : undefined}
          waveBody={isHdl ? <HdlTracePane session={hdl.state.session} result={hdl.state.operation} pending={hdlPending}
            currentNotice={hdlNotice} /> : undefined}
          designBody={<div style={{position:'relative',height:'100%',width:'100%',display:'flex',flexDirection:'column'}}>
            {c?.attemptId && <div className="ws-chatbind" style={{display:'flex',gap:8,flexWrap:'wrap',flexShrink:0}}>
            {c.mode === 'real' && <button type="button" className="ws-btn ghost" onClick={() => {
              setVersionSelection(null); confirmation.client?.closeComparison(); setRunOpen(false); setSubmissionOpen(true)
            }}>提交与反馈</button>}
            {c?.attemptId && <button type="button" className="ws-btn ghost" onClick={()=>{ setTutorObject(undefined);setCodeBasis(null);setHdlSelection(undefined); setTutorOpen(true) }}>就项目求助</button>}
            {isHdl && <button type="button" className="ws-btn ghost" disabled={hdlPending || !hdlResultCurrent || !hdl.state.canInteract}
              onClick={() => onHdlHelp(true)}>引用当前板卡求助</button>}
            {c?.attemptId && !runOpen && <>
              <select aria-label="代码求助快照" value={codeSnapshotId||confirmation.state.snapshot?.snapshotId||''} onChange={e=>setCodeSnapshotId(e.target.value)}>
                {!confirmation.state.snapshots.length && <option value="">尚无确认快照</option>}
                {confirmation.state.snapshots.map(s=><option key={s.snapshotId} value={s.snapshotId}>求助快照 v{s.workspaceRevision}</option>)}
              </select>
              <button type="button" className="ws-btn ghost" onClick={()=>void onCodeHelp('file')}>就这个文件求助</button>
              <button type="button" className="ws-btn ghost" onClick={()=>void onCodeHelp('selection')}>就所选代码求助</button>
            </>}
            {!tutorOpen && tutor.state.ledger?.job && !tutor.state.ledger.job.stopRequested && <button type="button" className="ws-btn ghost" onClick={()=>void tutor.client?.stop()}>停止这次帮助</button>}
            </div>}
            <div style={{flex:1,minHeight:0,display:'flex',flexDirection:'column'}} inert={!!example} aria-hidden={!!example}>
            {submissionOpen && confirmation.client
            ? <SubmissionFeedbackPanel confirmation={confirmation.client} snapshots={confirmation.state.snapshots}
                unconfirmedCount={project.unconfirmedCount} onReturn={() => setSubmissionOpen(false)} onAssignmentChange={setAssignment} />
            : versionComparison !== null && versionSelection !== null
            ? <VersionCompare
                comparison={versionComparison}
                options={versionChoices}
                leftId={versionSelection.left}
                rightId={versionSelection.right}
                onSelect={(side, id) => setVersionSelection(current => current === null ? current
                  : side === 'left' ? { ...current, left: id } : { ...current, right: id })}
                onReturn={() => setVersionSelection(null)}
              />
            : comparison !== null
            ? <ConflictCompare
                comparison={comparison}
                busy={compareBusy}
                // 未决（未知结果）、租约占用、本机未完成与可重试拒绝只能核对，不能在这里丢弃；
                // 只有 comparableOutcome 圈定的结论才由学生明确选择退役。
                resolvable={confirmation.state.outcome !== null && comparableOutcome(confirmation.state.outcome)}
                onReturn={() => confirmation.client?.closeComparison()}
                onKeepMine={() => { void onKeepMine() }}
                onAdoptServer={() => { void onAdoptServer() }}
              />
            : runOpen
              ? historyOpen
                ? <RunHistoryPanel options={history.state.jobs.map(j => ({ id: j.runId, label: historyLabel(j) }))}
                    onHelp={onRunHelp}
                    sides={historySides} busy={history.state.busy} notice={history.state.notice} synthetic={c?.mode === 'preparation'}
                    onSelect={(side, id) => { void history.client?.select(side, id) }}
                    onRead={() => { void history.client?.initialize() }} onReturn={() => setHistoryOpen(false)}
                    onDownload={(side, id) => { void history.download(side, id) }} />
                : <RunPanel snapshots={runSnapshots} selection={runSelection} result={run.result}
                  onHelp={onRunHelp}
                  busy={runBusy} canRun={canRun} notice={run.state.notice} synthetic={c?.mode === 'preparation'}
                  control={{ canStop: !!run.state.job && !settledJob(run.state.job.status) && !run.state.job.stopRequested && !run.state.pending,
                    canReconcile: run.state.pending || run.state.phase === 'read-unknown' ||
                      run.state.job?.status === 'outcome_unknown' || run.state.job?.status === 'stale',
                    busy: run.state.controlBusy, onStop: () => { void run.client?.cancel() },
                    onReconcile: () => { void run.client?.reconcile() } }}
                  onSelect={setRunSelection} onReturn={() => setRunOpen(false)} onRead={run.read}
                  onOpenHistory={() => setHistoryOpen(true)}
                  onRun={() => {
                    const input: CoreInput = runSelection.operation === 'find'
                      ? { operation: 'find', fileIds: runSelection.fileIds, word: runSelection.word }
                      : runSelection.operation === 'top' ? { operation: 'top', fileIds: runSelection.fileIds, count: runSelection.count }
                        : { operation: 'stats', fileIds: runSelection.fileIds }
                    void run.client?.run(runSelection.snapshotId, runSelection.entryFileId, input)
                  }} />
            : confirmation.seed && draftScope
              ? <>
                  {draftConflictBar}
                  <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}><CodeWorkspace ws={project} workspaceKey={scopeKey(draftScope)} editorHandleRef={editorHandle} /></div>
                  {isHdl && <div style={{ maxHeight: '34vh', overflow: 'auto', flexShrink: 0 }}>
                    <HdlBuildPane build={hdl.state.build} busy={hdlPending} notice={hdl.state.notice}
                      canHelp={!!hdl.state.build?.result && ['succeeded', 'failed'].includes(hdl.state.build.result.status) && project.unconfirmedCount === 0 && !hdl.state.unknown}
                      onDiagnostic={onHdlDiagnostic} onHelp={() => onHdlHelp()} onRead={hdl.read} />
                  </div>}
                </>
              : <TextScopeBodyPane init={init.init} onReload={init.reload} />}</div>
              {example && <div style={{position:'absolute',inset:0,zIndex:4,overflow:'auto',background:'var(--paper)'}}>
                <TutoringExample resource={example.resource} onReturn={onReturnExample}/>
              </div>}
            </div>}
          runCluster={<>
            {c?.attemptId && !isHdl && <CoreRunEntry onOpen={() => { setSubmissionOpen(false); setVersionSelection(null); confirmation.client?.closeComparison(); setHistoryOpen(false); setRunOpen(true) }} />}
            {isHdl && c?.attemptId && <>
              <select aria-label="HDL 确认快照" value={hdlSnapshotId} onChange={event => setHdlSnapshotId(event.target.value)} disabled={hdlPending}>
                <option value="">选择确认快照</option>
                {confirmation.state.snapshots.map(snapshot => <option key={snapshot.snapshotId} value={snapshot.snapshotId}>确认作品 v{snapshot.workspaceRevision}</option>)}
              </select>
              <HdlRunCluster build={hdl.state.build} session={hdl.state.session} busy={hdlPending} unknown={hdl.state.unknown}
                readBusy={hdl.state.busy || hdl.state.phase === 'reading'}
                notice={hdl.state.notice} snapshotLabel={hdlSnapshot ? `所选确认作品 v${hdlSnapshot.workspaceRevision}` : undefined}
                canBuild={runPermitted && hdl.state.canBuild && !!hdlSnapshot} canLoad={runPermitted && hdl.state.canProgram}
                canStop={runPermitted && hdl.state.canStop} onBuild={onHdlBuild} onLoad={onHdlLoad} onStop={onHdlStop} onRefresh={hdl.read} />
              {hdl.state.pending && <button type="button" className="ws-btn ghost" disabled={hdl.state.busy}
                onClick={() => { tutor.client?.setHdlCurrent(null); void hdl.client?.reconcile() }}>核对原 HDL 请求</button>}
            </>}
            <ConfirmationCluster
            phase={init.status !== 'ready' ? 'loading' : !confirmation.state.attempt && !(assignment ?? (init.init?.kind === 'ready' ? init.init.assignment : null))?.active
              ? 'readonly' : confirmation.state.phase}
            hasAttempt={!!c?.attemptId}
            hasPending={!!confirmation.state.pending}
            unconfirmedCount={project.unconfirmedCount}
            workspaceRevision={confirmation.state.workspace?.workspaceRevision ?? null}
            snapshot={confirmation.state.snapshot}
            // 暂停期间服务端只接受已有 active 文件的 update：本机新建与未确认的回收/恢复都发不出去，
            // 客户端不提供这个按钮，而不是让服务端整批拒绝后再解释（理由与确认客户端同一处判定）。
            canSave={project.loaded && project.unconfirmedCount > 0 && project.access.kind !== 'read-only' &&
              !(project.access.kind === 'paused' && (project.files.some(f => f.confirmed === null) || project.lifecyclePendingCount > 0))}
            canSnapshot={!!confirmation.state.attempt && project.access.kind !== 'read-only'}
            // 恢复结论态（拒绝/版本冲突/换代）的说明由 state.error 呈现，这里不重复同一句话。
            // 结论态（拒绝/冲突/过期/已接收）的具体说明由 state.error 给出，这里只放与状态无关的写入限制，
            // 避免同一张提示卡里两句话互相顶掉。
            blockedReason={!c?.trustedRecoveryGeneration ? '现在还不能保存这件作品。' :
              project.access.kind === 'paused' && (project.files.some(f => f.confirmed === null) || project.lifecyclePendingCount > 0)
                ? '暂停期间只能保存已有文件的修改。' : null}
            error={confirmation.state.error}
            canRetry={canReplay(confirmation.state.outcome)}
            onOpen={() => {
              if (init.init?.kind !== 'ready') return
              if (!confirmation.state.attempt && !(assignment ?? init.init.assignment).active) return
              void confirmation.client?.openAttempt()
            }}
            onSave={() => {
              const current = confirmation.client
              void project.prepareSave().then(drafts => current?.save(drafts)).catch(e => {
                reportDiagnostic('command.failed', { reason: 'draft not protected before saving', error: describeError(e) })
                // 草稿 CAS 冲突这条路径重试不会成功：冲突条已出现，学生明确选择后才能继续保存。
                showToast('草稿没有保存到本机，这次没有发送。如有冲突提示，请先选择保留哪一份正文。')
              })
            }}
            onSnapshot={() => { void confirmation.client?.snapshot() }}
            onRetry={() => { void confirmation.client?.retry() }}
            onReload={init.reload}
            canCompareVersions={project.loaded && versionOptions.length > 0 && !compareOpen}
            onCompareVersions={() => setVersionSelection(defaultVersionPair(versionOptions))}
          />
            {/* 04A 比较入口：只在比较有意义的结论（版本冲突/待重读/业务键冲突/历史）出现；
                其余结论的重试与重读动作在 ConfirmationCluster 里，不提供丢弃比较 */}
            {comparison === null && versionComparison === null && confirmation.state.pending && confirmation.state.outcome &&
              comparableOutcome(confirmation.state.outcome) && confirmation.state.phase !== 'saving' && (
              <span className="ws-run-actions">
                <button
                  type="button"
                  className="ws-btn ghost"
                  style={{ padding: '0 10px', fontSize: 12 }}
                  onClick={() => { void onOpenComparison() }}
                >
                  比较双方正文
                </button>
              </span>
            )}
          </>}
          tabsSlot={tabsSlot}
          runSlot={runSlot}
        />

        <TutoringPane client={tutor.client} state={tutor.state} open={tutorOpen} onClose={()=>setTutorOpen(false)}
          hdlSelection={isHdl ? hdlSelection : undefined}
          helpAllowed={init.init?.kind==='ready'&&init.init.activity.helpPolicy.helpAllowed}
          assignmentActive={init.init?.kind==='ready'&&(assignment??init.init.assignment).active} sourceStatus={messageSourceStatus}
          objectRef={tutorObject} objectLabel={tutorObjectLabel} objectCurrent={codeObjectCurrent}
          objectError={!codeObjectCurrent()?'所指代码或草稿已改变，请重新核对对象；不会自动保存。':undefined}
          onClearObject={()=>{setTutorObject(undefined);setCodeBasis(null);setHdlSelection(undefined)}} onExample={onExample} />
        {replaceTarget && <div role="dialog" aria-modal="true" aria-label="确认替换虚拟板会话"
          style={{ position: 'fixed', inset: '25% 25% auto', zIndex: 20, background: 'var(--paper)', padding: 24, border: '1px solid var(--line)' }}>
          <p>替换会停止原虚拟板并按新构建重新初始化；原实例退出确认前不会显示新装载成功。</p>
          <p>原会话 {replaceTarget.sessionId} · 版本 {replaceTarget.sessionRevision}</p>
          <button type="button" className="ws-btn ghost" onClick={() => setReplaceTarget(null)}>保留原会话</button>
          <button type="button" className="ws-btn solid" disabled={hdlPending || !hdl.state.canProgram} onClick={() => {
            const target = replaceTarget; setReplaceTarget(null); tutor.client?.setHdlCurrent(null)
            void hdl.client?.program(target.buildId, { sessionId: target.sessionId, sessionRevision: target.sessionRevision })
          }}>确认替换装载</button>
        </div>}
        <SideDock
          taskInfo={<><PrepTaskInfo init={init.init} onReload={init.reload} />
            {init.init?.kind==='ready' && <TutoringControls confirmation={confirmation.client} activity={init.init.activity}
              assignment={assignment??init.init.assignment} coverage={tutor.state.ledger?.coverage} onAssignmentChange={setAssignment}/>}</>}
          stash={[]}
          onPin={() => {
            // 准备场景没有可收纳的课程卡片；生成卡属 I0-B，不在 01 范围
          }}
          onToast={showToast}
        />

        {(toast || returnNotice&&confirmation.state.attempt) && (
          <div className="toast" role="status">
            {toast}
            {returnNotice&&confirmation.state.attempt && <><p data-testid="tutor-return-notice">{returnNotice.notice}</p>
              {returnNotice.origin && <p data-testid="tutor-return-origin" data-file-id={returnNotice.origin.fileId}>
                本机保留的原引用：{returnNotice.origin.path} · {returnNotice.origin.documentVersion===null?'本机未确认实例':`原文件版本 ${returnNotice.origin.documentVersion}`}
              </p>}</>}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 顶栏模式标识与载入代次。preparation epoch 仅准备模式在「任务信息」展示，
 * 顶栏不重复，避免窄视口下指挥栏溢出。
 */
function PrepBadge({
  status,
  loadEpoch,
  signingOut,
  onSignOut,
}: {
  status: InitStatus
  loadEpoch: number
  signingOut: boolean
  onSignOut: () => void
}) {
  return (
    <span className="ts-badge" data-status={status} style={{ flex: '0 0 auto' }}>
      <Icon name="shield-check" size={15} tone="neutral" />
      <b>{PREP_BUILD ? PREP_ENTRY_LABEL : '真实分配'}</b>
      {/* 模式与就绪状态可见；loadEpoch 排障值不充当服务端版本。 */}
      <span className="ts-badge-meta" data-load-epoch={loadEpoch || undefined}>
        {statusText(status)}
      </span>
      <button type="button" className="textbtn" disabled={signingOut} onClick={onSignOut}>
        <IconText name="logout-2" position="end">{signingOut ? '结束中…' : '退出'}</IconText>
      </button>
    </span>
  )
}

function statusText(status: InitStatus): string {
  if (status === 'loading') return '读取中'
  if (status === 'ready') return '就绪'
  return '不可用'
}
