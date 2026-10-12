import { useState } from 'react'

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

export interface ConfirmationSnapshot {
  snapshotId: string
  hash: string
  workspaceRevision: number
}

/** 冻结原请求的可核对事实；由调用方从原命令记录生成，不含当前草稿与任何凭据。 */
export interface OriginalRequestSummary {
  commandKey: string
  kind: string
  target: string
  recoveryGeneration: string
  createdAt: number
  /** sync / 快照命令冻结的预期确认版本。 */
  expectedWorkspaceRevision?: number
  /** sync 的公开幂等输入；其它命令没有。 */
  clientId?: string
  clientSeq?: number
  /** 冻结正文的摘要：与编辑器正文比对的是这份值，不是当前草稿。 */
  files: Array<{ label: string; bytes: number; hash: string }>
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
  /** 冻结原请求事实；有它才提供「原请求详情」供核对。 */
  originalRequest?: OriginalRequestSummary | null
  /** 原命令是否仍可原样重放；false 时只显示停止原因与下一步，不提供重放按钮。 */
  canRetry?: boolean
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
  rejected: '原请求已被服务拒绝',
  conflict: '确认版本冲突',
  'recovery-required': '受信代际已变化',
}

const compactControl = { padding: '0 10px', fontSize: 12 }
const relativeBox = { position: 'relative' as const }
const popcard = {
  position: 'absolute' as const,
  top: '100%',
  right: 0,
  maxWidth: '80vw',
  margin: '8px 0 0',
  padding: 16,
  boxSizing: 'border-box' as const,
  fontSize: 13,
  color: 'var(--ink-soft)',
  overflowWrap: 'anywhere' as const,
}
const shortHash = (hash: string) => (hash.length > 16 ? `${hash.slice(0, 16)}…` : hash)

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
  originalRequest,
  canRetry,
}: ConfirmationClusterProps) {
  const [showOriginal, setShowOriginal] = useState(false)
  const busy = phase === 'loading' || phase === 'saving'
  const needsReconciliation = hasPending ?? (phase === 'unknown' || phase === 'local-failed')
  const hasConfirmedHead = hasAttempt && workspaceRevision !== null
  const canWrite = phase === 'ready' && hasConfirmedHead
  const confirmed = canWrite && unconfirmedCount === 0
  // 未决原命令只有在仍可原样重放时才给按钮；拒绝/冲突/换代只显示停止原因，不诱导重发。
  const replayable = canRetry ?? true
  const reloadLabel = phase === 'recovery-required' ? '重读受信上下文' : '重新读取'

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
        {needsReconciliation && replayable && (
          <button type="button" className="ws-btn solid" style={compactControl} onClick={onRetry}>
            核对原请求并重试
          </button>
        )}
        <button type="button" className="ws-btn ghost" style={compactControl} disabled={phase === 'loading'} onClick={onReload}>
          {reloadLabel}
        </button>
      </span>

      {snapshot && (
        <details style={relativeBox}>
          <summary className="ws-btn ghost" style={compactControl}>快照详情 v{snapshot.workspaceRevision}</summary>
          <dl className="ws-popcard" style={popcard}>
            <dt>快照 ID</dt>
            <dd style={{ margin: '0 0 12px' }}><code>{snapshot.snapshotId}</code></dd>
            <dt>内容 hash</dt>
            <dd style={{ margin: '0 0 12px' }}><code>{snapshot.hash}</code></dd>
            <dt>确认作品版本</dt>
            <dd style={{ margin: 0 }}>v{snapshot.workspaceRevision}</dd>
          </dl>
        </details>
      )}

      {(blockedReason || error || originalRequest) && (
        <span style={relativeBox}><span className="ws-popcard"
          style={{ position: 'absolute', top: 20, right: 0, width: 360, maxWidth: '80vw', padding: 12,
            whiteSpace: 'normal', overflowWrap: 'anywhere', fontSize: 13, color: 'var(--ink-soft)' }}>
          {(blockedReason || error) && <span role={error ? 'alert' : undefined}>
            {blockedReason}
            {blockedReason && error && ' · '}
            {error}
          </span>}
          {originalRequest && (
            <span style={{ display: 'block', marginTop: error || blockedReason ? 8 : 0 }}>
              <button
                type="button"
                className="textbtn"
                style={compactControl}
                aria-expanded={showOriginal}
                onClick={() => setShowOriginal(open => !open)}
              >
                {showOriginal ? '收起原请求详情' : '原请求详情'}
              </button>
              {showOriginal && (
                <dl className="ws-request-detail" style={{ margin: '8px 0 0' }}>
                  <dt>原命令</dt>
                  <dd style={{ margin: '0 0 8px' }}><code>{originalRequest.kind}</code> · <code>{originalRequest.commandKey}</code></dd>
                  <dt>目标</dt>
                  <dd style={{ margin: '0 0 8px' }}><code>{originalRequest.target}</code></dd>
                  <dt>受信代际</dt>
                  <dd style={{ margin: '0 0 8px' }}><code>{originalRequest.recoveryGeneration || '(缺)'}</code></dd>
                  {originalRequest.clientId && (
                    <>
                      <dt>clientId / clientSeq</dt>
                      <dd style={{ margin: '0 0 8px' }}><code>{originalRequest.clientId}</code> · #{originalRequest.clientSeq ?? '(缺)'}</dd>
                    </>
                  )}
                  {originalRequest.expectedWorkspaceRevision !== undefined && (
                    <>
                      <dt>冻结时的预期确认版本</dt>
                      <dd style={{ margin: '0 0 8px' }}>v{originalRequest.expectedWorkspaceRevision}</dd>
                    </>
                  )}
                  <dt>冻结正文（与当前草稿分开）</dt>
                  <dd style={{ margin: 0 }}>
                    {originalRequest.files.length === 0
                      ? '此命令没有文件正文'
                      : originalRequest.files.map(file => (
                        <div key={file.label} style={{ margin: '4px 0' }}>
                          <code>{file.label}</code> · {file.bytes} B · <code>{shortHash(file.hash)}</code>
                        </div>
                      ))}
                  </dd>
                </dl>
              )}
            </span>
          )}
        </span></span>
      )}
    </>
  )
}
