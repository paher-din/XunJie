import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { workspaceMode } from '../workspace/mode'
import { PREP_ENTRY_LABEL, PREP_TASK_ID } from '../workspace/prepEntry'
import { signOut } from '../workspace/session'
import { useWorkspaceInit, type InitStatus } from '../workspace/useWorkspaceInit'
import { useTutoringWorkspace } from '../workspace/useTutoringWorkspace'
import { TutoringPane } from '../components/workspace/TutoringPane'
import { createRunHelpObjectRef, type RunHelpTarget } from '../workspace/tutoringRun'
import type { TutorObject } from '../workspace/tutoringContracts'
import { TutoringControls } from '../components/workspace/TutoringControls'
import type { AssignmentView } from '../workspace/contracts'
import type { CodeEditorHandle } from '../components/workspace/CodeEditorHost'
import { createCodeObjectRef, verifyCodeTarget, codeSelectionRange as createReturnRange, type CodeDraft, type CodeRange } from '../workspace/tutoringObject'
import { TutoringExample } from '../components/workspace/TutoringExample'
import { resolveTutoringResource, captureTutoringReturn, validateTutoringReturn,
  type TutoringResourceResult, type TutoringReturnAnchor, type TutoringReturnFile } from '../workspace/tutoringReturn'
import type { TutorMessage } from '../workspace/tutoringStore'

/**
 * I0-A 准备场景的 C / TextScope 工作区。
 *
 * 复用原设计的页面骨架与容器：顶栏（标签槽 + 运行簇槽）、左侧胶囊「任务信息」、中心工具区
 * （胶囊标签 + 分屏）。不新造页面或导航，不接原数字逻辑的模拟构建与主动教学引导。
 *
 * 01 的范围是只读初始化与可用容器：编辑属 02，保存/快照属 03，运行属 06。
 * 载入不创建 Attempt、不开始学习、不写学习记录。
 */
export default function PrepWorkspacePage() {
  const navigate = useNavigate()
  const init = useWorkspaceInit()
  const [assignment, setAssignment] = useState<AssignmentView | null>(null)
  const confirmation = useConfirmationWorkspace(init.init, PREP_TASK_ID, assignment?.active)
  const run = useRunWorkspace(confirmation.client, init.init)
  const [runOpen, setRunOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const history = useRunHistory(confirmation.client, runOpen && historyOpen)
  const [runSelection, setRunSelection] = useState<CoreSelection>({ snapshotId: '', entryFileId: '', fileIds: [], operation: 'stats', word: '', count: '10' })
  const c = confirmation.client?.context
  const tutor = useTutoringWorkspace(confirmation.client)
  const [tutorOpen, setTutorOpen] = useState(false)
  const [tutorObject, setTutorObject] = useState<TutorObject | undefined>(undefined)
  const [tutorObjectLabel, setTutorObjectLabel] = useState('')
  const [codeBasis, setCodeBasis] = useState<CodeDraft | null>(null)
  const [codeSnapshotId, setCodeSnapshotId] = useState('')
  const editorHandle = useRef<CodeEditorHandle>(null)
  useEffect(() => {
    setRunOpen(false)
    setHistoryOpen(false)
    setRunSelection({ snapshotId: '', entryFileId: '', fileIds: [], operation: 'stats', word: '', count: '10' })
    setTutorObject(undefined); setCodeBasis(null); setCodeSnapshotId(''); setExample(null)
  }, [c])
  useEffect(()=> { setAssignment(null) }, [init.init])
  const draftScope = useMemo<DraftScope | null>(() => c?.attemptId && c.userId
    ? { mode: c.mode, account: c.userId, attemptKey: c.attemptId } : null,
  [c?.mode, c?.userId, c?.attemptId])
  const project = useProjectWorkspace(confirmation.seed, idbDraftRepository, draftScope)
  const projectLive = useRef(project)
  projectLive.current = project
  const [example, setExample] = useState<{ resource: TutoringResourceResult; anchor: TutoringReturnAnchor<CodeRange> | null } | null>(null)
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
  function codeObjectCurrent() {
    if (!codeBasis) return true
    const current=projectLive.current.readCodeDraft(codeBasis.fileId)
    return !!current && current.workspaceKey===codeBasis.workspaceKey && current.serverFileId===codeBasis.serverFileId &&
      current.lifecycle==='active' && current.text===codeBasis.text && current.confirmed?.version===codeBasis.confirmed?.version
  }
  async function onCodeHelp(intent:'file'|'selection') {
    const client=confirmation.client, context=client?.context, localId=projectLive.current.activeFile?.fileId
    if(!client || !context?.attemptId || !context.activityVersionId || !draftScope || !localId) {showToast('请先打开一个已确认文件。');return}
    const before=projectLive.current.readCodeDraft(localId), selected=intent==='selection'?editorHandle.current?.captureSelection():null
    if(!before?.serverFileId) {showToast('请先自主确认作品并冻结快照，求助不会自动保存。');return}
    if(intent==='selection' && !selected?.ok) {showToast(selected && !selected.ok?selected.reason:'请明确选择代码。');return}
    const snapshot=confirmation.state.snapshots.find(s=>s.snapshotId===(codeSnapshotId||confirmation.state.snapshot?.snapshotId))
    if(!snapshot) {showToast('请先自主冻结并选择已确认快照。');return}
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
  function onExample(message:TutorMessage) {
    if(init.init?.kind!=='ready' || !c || !confirmation.client?.isCurrent(c)) return
    const resource=resolveTutoringResource(message.payload.resourceRefs?.[0]??'',init.init.activity,init.init.materials,c.mode)
    const file=returnFiles().find(f=>f.fileId===projectLive.current.activeFile?.fileId)
    const selected=editorHandle.current?.captureSelection()
    const range=selected?.ok ? createReturnRange(selected.selection.originalText,selected.selection.modelStart,selected.selection.modelEnd):null
    editorHandle.current?.saveViewState()
    setExample({resource,anchor:file?captureTutoringReturn(c,file,range):null});setTutorOpen(false)
  }
  function onReturnExample() {
    if(!example) return
    const checked=example.anchor && c ? validateTutoringReturn(example.anchor,c,returnFiles()):null
    setExample(null)
    if(checked?.kind==='ready' && example.anchor && draftScope) {
      project.open(checked.fileId)
      // The editor and its saved scroll/fold/undo state remained mounted: focus does not move the view.
      if(projectLive.current.activeFile?.fileId===checked.fileId) editorHandle.current?.focus()
    } else if(checked?.kind==='unavailable') showToast(checked.notice)
    else showToast('未保留精确文件位置，返回当前作品继续自主操作。')
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
  const canRun = run.state.eligible && !run.state.pending && !!runSelection.snapshotId && !!runSelection.entryFileId &&
    runSelection.fileIds.length > 0 && !confirmation.client?.commandInFlight

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

  /** 结束准备会话（学生明确发起）：POST logout 后重读，会建立新的合成会话与新的 loadEpoch。 */
  async function onSignOut() {
    if (signingOut) return
    setSigningOut(true)
    confirmation.client?.dispose()
    init.invalidate()
    try {
      await signOut(workspaceMode)
      showToast('已退出准备场景')
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
        <div className="ws-head-run" ref={setRunSlot} />
      </header>

      <div className="ws-body">
        <CenterToolArea
          taskId={PREP_TASK_ID}
          variant="textscope-c"
          tool={tool}
          onToolChange={setTool}
          onToast={showToast}
          designBody={<div style={{position:'relative',height:'100%',width:'100%',display:'flex',flexDirection:'column'}}>
            {c?.attemptId && <div className="ws-chatbind" style={{display:'flex',gap:8,flexWrap:'wrap',flexShrink:0}}>
            {c?.attemptId && <button type="button" className="ws-btn ghost" onClick={()=>{ setTutorObject(undefined);setCodeBasis(null); setTutorOpen(true) }}>就项目求助</button>}
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
            {versionComparison !== null && versionSelection !== null
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
                  <CodeWorkspace ws={project} workspaceKey={scopeKey(draftScope)} editorHandleRef={editorHandle} />
                </>
              : <TextScopeBodyPane init={init.init} onReload={init.reload} />}</div>
              {example && <div style={{position:'absolute',inset:0,zIndex:4,overflow:'auto',background:'var(--paper)'}}>
                <TutoringExample resource={example.resource} onReturn={onReturnExample}/>
              </div>}
            </div>}
          runCluster={<>
            {c?.attemptId && <CoreRunEntry onOpen={() => { setVersionSelection(null); confirmation.client?.closeComparison(); setHistoryOpen(false); setRunOpen(true) }} />}
            <ConfirmationCluster
            phase={init.status !== 'ready' ? 'loading' : confirmation.state.phase}
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
            onOpen={() => { void confirmation.client?.openAttempt() }}
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
          objectRef={tutorObject} objectLabel={tutorObjectLabel} objectCurrent={codeObjectCurrent}
          objectError={!codeObjectCurrent()?'所指代码或草稿已改变，请重新核对对象；不会自动保存。':undefined}
          onClearObject={()=>{setTutorObject(undefined);setCodeBasis(null)}} onExample={onExample} />
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

        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 顶栏准备标识：模式与载入代次。preparation epoch 在左侧「任务信息」里完整展示，
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
      <b>{PREP_ENTRY_LABEL}</b>
      {/* 学生只需要知道当前是合成准备场景、是否就绪；loadEpoch 等排障值进控制台。 */}
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
