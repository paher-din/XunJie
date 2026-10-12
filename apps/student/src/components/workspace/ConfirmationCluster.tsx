export type ConfirmationPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'saving'
  | 'local-failed'
  | 'unknown'
  | 'error'
  | 'readonly'

export interface ConfirmationSnapshot {
  snapshotId: string
  hash: string
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
  /** 核对或重放原命令，不能换键创建替代请求。 */
  onRetry: () => void
  onReload: () => void
}

const phaseLabels: Record<ConfirmationPhase, string> = {
  idle: '尚未开始',
  loading: '正在读取',
  ready: '编辑中',
  saving: '正在确认',
  'local-failed': '服务回执已收到，本机确认未完成',
  unknown: '原请求结果未知',
  error: '操作未完成',
  readonly: '作品只读',
}
const compactControl = { padding: '0 10px', fontSize: 12 }

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
}: ConfirmationClusterProps) {
  const busy = phase === 'loading' || phase === 'saving'
  const needsReconciliation = hasPending ?? (phase === 'unknown' || phase === 'local-failed')
  const hasConfirmedHead = hasAttempt && workspaceRevision !== null
  const canWrite = phase === 'ready' && hasConfirmedHead
  const confirmed = canWrite && unconfirmedCount === 0

  return (
    <>
      {phase !== 'ready' && <span className="ws-run-state" role="status" aria-live="polite" aria-atomic="true">
        {phaseLabels[phase]}
      </span>}

      <span className={`ws-flow${confirmed ? ' synced' : ''}`} style={{ fontSize: 12 }}>
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
        {(!hasAttempt || phase !== 'ready') && <button
          type="button"
          className="ws-btn ghost"
          style={compactControl}
          disabled={busy || needsReconciliation || phase === 'readonly' || (hasAttempt && phase === 'ready')}
          onClick={onOpen}
        >
          {hasAttempt ? '恢复 Attempt' : '开始 Attempt'}
        </button>}
        <button
          type="button"
          className="ws-btn solid"
          style={compactControl}
          disabled={!canWrite || !canSave}
          title={!canWrite || !canSave ? blockedReason ?? '当前不能确认保存' : '确认本次发送的草稿'}
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
        {needsReconciliation && (
          <button type="button" className="ws-btn solid" style={compactControl} onClick={onRetry}>
            核对原请求并重试
          </button>
        )}
        <button type="button" className="ws-btn ghost" style={compactControl} disabled={phase === 'loading'} onClick={onReload}>
          重新读取
        </button>
      </span>

      {snapshot && (
        <details style={{ position: 'relative' }}>
          <summary className="ws-btn ghost" style={compactControl}>快照详情 v{snapshot.workspaceRevision}</summary>
          <dl
            className="ws-popcard"
            style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              maxWidth: '80vw',
              margin: '8px 0 0',
              padding: 16,
              boxSizing: 'border-box',
              fontSize: 13,
              color: 'var(--ink-soft)',
              overflowWrap: 'anywhere',
            }}
          >
            <dt>快照 ID</dt>
            <dd style={{ margin: '0 0 12px' }}><code>{snapshot.snapshotId}</code></dd>
            <dt>内容 hash</dt>
            <dd style={{ margin: '0 0 12px' }}><code>{snapshot.hash}</code></dd>
            <dt>确认作品版本</dt>
            <dd style={{ margin: 0 }}>v{snapshot.workspaceRevision}</dd>
          </dl>
        </details>
      )}

      {(blockedReason || error) && (
        <span style={{ position: 'relative' }}><span className="ws-popcard" role={error ? 'alert' : undefined}
          style={{ position: 'absolute', top: 20, right: 0, width: 360, maxWidth: '80vw', padding: 12,
            whiteSpace: 'normal', overflowWrap: 'anywhere', fontSize: 13, color: 'var(--ink-soft)' }}>
          {blockedReason}
          {blockedReason && error && ' · '}
          {error}
        </span></span>
      )}
    </>
  )
}
