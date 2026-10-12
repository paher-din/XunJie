import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, IconText } from '../icons'
import { CenterToolArea, type ToolKey } from '../components/workspace/CenterToolArea'
import { SideDock } from '../components/workspace/SideDock'
import { PrepTaskInfo, TextScopeBodyPane } from '../components/workspace/TextScopePanes'
import { ConfirmationCluster } from '../components/workspace/ConfirmationCluster'
import { ConflictCompare } from '../components/workspace/ConflictCompare'
import { CodeWorkspace } from '../components/workspace/CodeWorkspace'
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
  const confirmation = useConfirmationWorkspace(init.init, PREP_TASK_ID)
  const c = confirmation.client?.context
  const draftScope = useMemo<DraftScope | null>(() => c?.attemptId && c.userId
    ? { mode: c.mode, account: c.userId, attemptKey: c.attemptId } : null,
  [c?.mode, c?.userId, c?.attemptId])
  const project = useProjectWorkspace(confirmation.seed, idbDraftRepository, draftScope)
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

  /* ---------- 04A：服务版本冲突的只读比较 ---------- */
  const comparison = confirmation.state.comparison
  const [compareBusy, setCompareBusy] = useState(false)

  /** Esc 关闭比较：只在比较视图打开期间挂监听，行为与「返回编辑」一致。 */
  useEffect(() => {
    if (comparison === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') confirmation.client?.closeComparison()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [comparison === null, confirmation.client])

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
          designBody={comparison !== null
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
            : confirmation.seed && draftScope
              ? <>
                  {draftConflictBar}
                  <CodeWorkspace ws={project} workspaceKey={scopeKey(draftScope)} />
                </>
              : <TextScopeBodyPane init={init.init} onReload={init.reload} />}
          runCluster={<>
            <ConfirmationCluster
            phase={init.status !== 'ready' ? 'loading' : confirmation.state.phase}
            hasAttempt={!!c?.attemptId}
            hasPending={!!confirmation.state.pending}
            unconfirmedCount={project.unconfirmedCount}
            workspaceRevision={confirmation.state.workspace?.workspaceRevision ?? null}
            snapshot={confirmation.state.snapshot}
            canSave={project.loaded && project.unconfirmedCount > 0 && project.access.kind !== 'read-only' &&
              !(project.access.kind === 'paused' && project.files.some(f => f.confirmed === null))}
            canSnapshot={!!confirmation.state.attempt && project.access.kind !== 'read-only'}
            // 恢复结论态（拒绝/版本冲突/换代）的说明由 state.error 呈现，这里不重复同一句话。
            // 结论态（拒绝/冲突/过期/已接收）的具体说明由 state.error 给出，这里只放与状态无关的写入限制，
            // 避免同一张提示卡里两句话互相顶掉。
            blockedReason={!c?.trustedRecoveryGeneration ? '现在还不能保存这件作品。' :
              project.access.kind === 'paused' && project.files.some(f => f.confirmed === null) ? '暂停期间只能保存已有文件的修改。' : null}
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
          />
            {/* 04A 比较入口：只在比较有意义的结论（版本冲突/待重读/业务键冲突/历史）出现；
                其余结论的重试与重读动作在 ConfirmationCluster 里，不提供丢弃比较 */}
            {comparison === null && confirmation.state.pending && confirmation.state.outcome &&
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

        <SideDock
          taskInfo={<PrepTaskInfo init={init.init} onReload={init.reload} />}
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
