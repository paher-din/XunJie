import type { CSSProperties } from 'react'

export type ConfirmationPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'saving'
  | 'local-failed'
  | 'unknown'
  | 'error'
  | 'readonly'
  /** 服务明确拒绝原命令：正文保留，停止自动重做。 */
  | 'rejected'
  /** 服务端确认版本已变化：明确比较与选择由后续比较能力提供。 */
  | 'conflict'
  /** 受信代际已变化：停止旧重试，先重读受信上下文。 */
  | 'recovery-required'
  /** 上一次保存属于旧代际且已被服务拒绝：不会生效，学生可以重新保存。 */
  | 'stale'

/** 学生只需要知道「冻结了哪一版」；快照 ID/hash 由调用方写进控制台。 */
export interface ConfirmationSnapshot {
  workspaceRevision: number
}

export interface ConfirmationClusterProps {
  phase: ConfirmationPhase
  hasAttempt: boolean
  unconfirmedCount: number
  /** 已接纳的权威确认头；尚未读取时为 null。 */
  workspaceRevision: number | null
  /** 完整回取并核验过的快照，不随草稿或当前确认头改变。 */
  snapshot?: ConfirmationSnapshot | null
  hasPending?: boolean
  canSave: boolean
  canSnapshot: boolean
  blockedReason?: string | null
  error?: string | null
  onOpen: () => void
  onSave: () => void
  onSnapshot: () => void
  /** 重放**上一次**冻结的保存请求（不是当前草稿），不能换键创建替代请求。 */
  onRetry: () => void
  onReload: () => void
  /** 上一次保存是否仍可重放；false 时只显示下一步，不提供重放按钮。 */
  canRetry?: boolean
}

/**
 * 学生可见的一句话状态。
 *
 * 只回答「能不能写、正在做什么」；错误码、命令、代际、ID/hash 等事实由调用方写进控制台，
 * 不在这里出现（见主仓库 src/workspace/diagnostics.ts）。
 */
const phaseLabels: Record<ConfirmationPhase, string> = {
  idle: '尚未开始',
  loading: '正在读取',
  ready: '编辑中',
  saving: '正在保存',
  'local-failed': '保存待重试',
  unknown: '保存结果待确认',
  error: '操作未完成',
  readonly: '作品只读',
  rejected: '保存未成功',
  conflict: '作品有更新',
  'recovery-required': '需要重新读取',
  stale: '上一次保存已过期',
}

const compactControl = { padding: '0 10px', fontSize: 12 }
const relativeBox: CSSProperties = { position: 'relative' }
const hintCard: CSSProperties = {
  position: 'absolute',
  top: 20,
  right: 0,
  width: 320,
  maxWidth: '80vw',
  padding: 12,
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  fontSize: 13,
  color: 'var(--ink-soft)',
}

/** 直接放入已有顶栏运行簇；所有业务事实、权限和请求均由调用方提供。 */
export function ConfirmationCluster({
  phase,
  hasAttempt,
  unconfirmedCount,
  workspaceRevision,
  snapshot,
  hasPending,
  canSave,
  canSnapshot,
  blockedReason,
  error,
  onOpen,
  onSave,
  onSnapshot,
  onRetry,
  onReload,
  canRetry,
}: ConfirmationClusterProps) {
  const busy = phase === 'loading' || phase === 'saving'
  // stale 不阻塞：它只说明上一次保存没生效，学生可以立刻重新保存。
  const needsReconciliation = (hasPending ?? (phase === 'unknown' || phase === 'local-failed')) && phase !== 'stale'
  const hasConfirmedHead = hasAttempt && workspaceRevision !== null
  const canWrite = (phase === 'ready' || phase === 'stale') && hasConfirmedHead
  const confirmed = canWrite && unconfirmedCount === 0
  // 只有上一次保存仍可原样重放时才给按钮；需要先读取或重新开始时只给「重新读取」。
  const replayable = canRetry ?? true
  const hint = blockedReason || error

  return (
    <>
      {phase !== 'ready' && <span className="ws-run-state" role="status" aria-live="polite" aria-atomic="true">
        {phaseLabels[phase]}
      </span>}

      {/* 恢复结论态下只留「发生了什么 + 能做什么」：草稿流与恢复 Attempt 都是次要信息，
          挤在同一行会把准备标识压住（1280px 实测）。 */}
      <span className={`ws-flow${confirmed ? ' synced' : ''}`} style={{ fontSize: 12, display: needsReconciliation ? 'none' : undefined }}>
        {confirmed ? (
          <>
            <b aria-hidden="true">✓</b>
            确认作品 v{workspaceRevision} · 与草稿一致
          </>
        ) : (
          <>
            <span className="ws-flow-node draft">
              {unconfirmedCount > 0 && <i aria-hidden="true" />}
              {unconfirmedCount > 0 ? `${unconfirmedCount} 个文件未确认` : '草稿状态待核对'}
            </span>
            <span className="ws-flow-link" aria-hidden="true">▸</span>
            <span className="ws-flow-node loaded" style={{ color: 'var(--ink-soft)' }}>
              {hasConfirmedHead ? `确认作品 v${workspaceRevision}` : hasAttempt ? '确认作品待读取' : '尚无确认作品'}
            </span>
          </>
        )}
      </span>

      <span className="ws-run-actions" role="group" aria-label="作品确认操作" aria-busy={busy}>
        {(!hasAttempt || phase !== 'ready') && !needsReconciliation && <button
          type="button"
          className="ws-btn ghost"
          style={compactControl}
          disabled={busy || phase === 'readonly'}
          onClick={onOpen}
        >
          {hasAttempt ? '恢复 Attempt' : '开始 Attempt'}
        </button>}
        <button
          type="button"
          className="ws-btn solid"
          style={compactControl}
          disabled={!canWrite || !canSave}
          title={!canWrite || !canSave ? blockedReason ?? '当前不能保存' : '保存本次发送的草稿'}
          onClick={onSave}
        >
          确认保存
        </button>
        <button
          type="button"
          className="ws-btn ghost"
          style={compactControl}
          disabled={!canWrite || !canSnapshot}
          title={!canWrite || !canSnapshot ? blockedReason ?? '当前不能冻结确认作品' : '仅冻结当前确认作品，不包含未确认草稿'}
          onClick={onSnapshot}
        >
          冻结确认作品
        </button>
        {needsReconciliation && replayable && (
          <button type="button" className="ws-btn solid" style={compactControl} onClick={onRetry}>
            重试上次保存
          </button>
        )}
        <button type="button" className="ws-btn ghost" style={compactControl} disabled={phase === 'loading'} onClick={onReload}>
          重新读取
        </button>
      </span>

      {snapshot && (
        <span className="ws-btn ghost" style={{ ...compactControl, cursor: 'default' }} title="本次冻结的是当时已确认的作品版本">
          已冻结快照 v{snapshot.workspaceRevision}
        </span>
      )}

      {hint && (
        <span style={relativeBox}><span className="ws-popcard" role={error ? 'alert' : undefined} style={hintCard}>
          {hint}
        </span></span>
      )}
    </>
  )
}
