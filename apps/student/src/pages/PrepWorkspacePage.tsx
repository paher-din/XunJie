import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, IconText } from '../icons'
import { CenterToolArea, type ToolKey } from '../components/workspace/CenterToolArea'
import { SideDock } from '../components/workspace/SideDock'
import { PrepTaskInfo, TextScopeBodyPane } from '../components/workspace/TextScopePanes'
import { ConfirmationCluster } from '../components/workspace/ConfirmationCluster'
import { CodeWorkspace } from '../components/workspace/CodeWorkspace'
import { useProjectWorkspace } from '../components/workspace/useProjectWorkspace'
import { useConfirmationWorkspace } from '../workspace/useConfirmationWorkspace'
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

  /** 结束准备会话（学生明确发起）：POST logout 后重读，会建立新的合成会话与新的 loadEpoch。 */
  async function onSignOut() {
    if (signingOut) return
    setSigningOut(true)
    confirmation.client?.dispose()
    init.invalidate()
    try {
      await signOut(workspaceMode)
      showToast('已结束准备会话')
      init.reload()
    } catch (e) {
      showToast(`结束会话失败：${e instanceof Error ? e.message : String(e)}`)
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
          designBody={confirmation.seed && draftScope
            ? <CodeWorkspace ws={project} workspaceKey={scopeKey(draftScope)} />
            : <TextScopeBodyPane init={init.init} onReload={init.reload} />}
          runCluster={<ConfirmationCluster
            phase={init.status !== 'ready' ? 'loading' : confirmation.state.phase}
            hasAttempt={!!c?.attemptId}
            hasPending={!!confirmation.state.pending}
            unconfirmedCount={project.unconfirmedCount}
            workspaceRevision={confirmation.state.workspace?.workspaceRevision ?? null}
            snapshot={confirmation.state.snapshot}
            canSave={project.loaded && project.unconfirmedCount > 0 && project.access.kind !== 'read-only' &&
              !(project.access.kind === 'paused' && project.files.some(f => f.confirmed === null))}
            canSnapshot={!!confirmation.state.attempt && project.access.kind !== 'read-only'}
            blockedReason={!c?.trustedRecoveryGeneration ? '缺少受信代际，禁止写入（H-03）' :
              project.access.kind === 'paused' && project.files.some(f => f.confirmed === null) ? '暂停期间只可确认已有文件正文' : null}
            error={confirmation.state.error}
            onOpen={() => { void confirmation.client?.openAttempt() }}
            onSave={() => {
              const current = confirmation.client
              void project.prepareSave().then(drafts => current?.save(drafts)).catch(e =>
                showToast(`草稿未能保护，未发送保存请求：${e instanceof Error ? e.message : String(e)}`))
            }}
            onSnapshot={() => { void confirmation.client?.snapshot() }}
            onRetry={() => { void confirmation.client?.retry() }}
            onReload={init.reload}
          />}
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
    <span className="ts-badge" data-status={status}>
      <Icon name="shield-check" size={15} tone="neutral" />
      <b>{PREP_ENTRY_LABEL}</b>
      <span className="ts-badge-meta">
        {statusText(status)} · loadEpoch {loadEpoch || '—'}
      </span>
      <button type="button" className="textbtn" disabled={signingOut} onClick={onSignOut}>
        <IconText name="logout-2" position="end">{signingOut ? '结束中…' : '结束准备会话'}</IconText>
      </button>
    </span>
  )
}

function statusText(status: InitStatus): string {
  if (status === 'loading') return '读取中'
  if (status === 'ready') return '就绪'
  return '不可用'
}
