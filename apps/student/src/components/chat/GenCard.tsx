import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons'
import { GenSandboxHost } from '../../bridge/genSandbox'
import type { GenCard as GenCardData } from '../../bridge/types'

/**
 * 生成交互卡（已确认 2026-10-11，docs/agent-page-design.md 第 19 条）：
 * 卡片壳（标题行：标题 + 「收纳」；右上 11px 灰字「仿真结果」仅 claimSim 时显示）
 * + live iframe 沙箱（ready 报高度自适应、上限 480px 内滚）。只在落定挂载（父级控制）。
 * 载体分场景复用同一组件：对话页消息内（收纳分流 + 占位行）、工作区标签页、钉右缘。
 *
 * 失败三型：
 * - 生成失败（契约 genFailure）：失败卡「没有生成可用的交互」+ 错误码 + 重试 / 知道了；
 * - 运行失败（沙箱 error 消息）：卡上琥珀错误条「这个交互出错了，已回到上个可用版本」+ 回滚旧版本续跑；
 * - 协议超时（3 秒不就绪判死）：「这个交互没有响应」+ 重试（改载 fallback 版本）。
 */
export function GenCard({
  card,
  /** 收纳后的任务名（占位行「已收纳到 {任务名} 的卡片收纳」用）。 */
  taskName,
  /** 「收纳」主按钮文案：对话页 / 标签页 = 收纳，钉右缘 = 放回收纳。 */
  collectLabel = '收纳',
  /** 点「收纳」：把收纳时的最新快照交给父级（父级写适配层并切换占位 / 关视图）。 */
  onCollect,
  /** 生成失败卡的「重试」（父级写回 genFailure，如 retryGenCard）。 */
  onRetry,
  /** 占位行「打开」：导航到工作区并取出。 */
  onOpen,
  /** 工作区消息内卡的「在工具区打开」：开成中心工具区标签页。 */
  onOpenInWorkspace,
  /** live 期间的交互状态续写（宿主内存态 → 父级持久化）。 */
  onStateSync,
}: {
  card: GenCardData
  taskName?: string
  collectLabel?: string
  onCollect?: (snapshot: unknown) => void
  onRetry?: () => void
  onOpen?: () => void
  onOpenInWorkspace?: () => void
  onStateSync?: (snapshot: unknown) => void
}) {
  // 收纳后：原位退化为占位行
  if (card.collected) {
    return (
      <div className="gen-ph">
        <Icon name="archive-down" size={13} />
        <span>
          已收纳到 <b>{taskName ?? '任务'}</b> 的卡片收纳 ·{' '}
        </span>
        {onOpen && (
          <button className="gen-ph-open" onClick={onOpen}>
            打开
          </button>
        )}
      </div>
    )
  }
  if (card.genFailure) {
    return <GenFailCard code={card.genFailure.code} onRetry={onRetry} />
  }
  return (
    <GenLiveCard
      card={card}
      collectLabel={collectLabel}
      onCollect={onCollect}
      onOpenInWorkspace={onOpenInWorkspace}
      onStateSync={onStateSync}
    />
  )
}

/** 生成失败：沿用对话页失败卡语言（只说事实与动作，不道歉，不拟人）。 */
function GenFailCard({ code, onRetry }: { code: string; onRetry?: () => void }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) {
    return (
      <div className="gen-fail-collapsed">
        <span>没有生成可用的交互</span>
        {onRetry && (
          <button onClick={onRetry}>
            重试
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="gen-failcard">
      <div className="gen-failhead">
        <span className="gen-failicon">!</span>
        <strong>没有生成可用的交互</strong>
      </div>
      <div className="gen-failcode">错误码 {code}</div>
      <div className="gen-failacts">
        {onRetry && (
          <button className="primary" onClick={onRetry}>
            重试
          </button>
        )}
        <button onClick={() => setDismissed(true)}>知道了</button>
      </div>
    </div>
  )
}

/** live 壳：标题行 + 沙箱（装载 / 自适应高度 / 错误条）。 */
function GenLiveCard({
  card,
  collectLabel,
  onCollect,
  onOpenInWorkspace,
  onStateSync,
}: {
  card: GenCardData
  collectLabel: string
  onCollect?: (snapshot: unknown) => void
  onOpenInWorkspace?: () => void
  onStateSync?: (snapshot: unknown) => void
}) {
  const [boot, setBoot] = useState<'loading' | 'live' | 'dead'>('loading')
  const [errbar, setErrbar] = useState<string | null>(null)
  const [errRetry, setErrRetry] = useState(false)
  const hostRef = useRef<GenSandboxHost | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef<unknown>(card.snapshot ?? null)
  const stateSyncRef = useRef(onStateSync)
  stateSyncRef.current = onStateSync

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const host = new GenSandboxHost({
      label: card.title,
      callbacks: {
        onReady: () => setBoot('live'),
        onState: (s) => {
          stateRef.current = s
          stateSyncRef.current?.(s)
        },
        onRuntimeError: () => {
          // 运行失败：取最近状态 → 回滚上个可用版本续跑 → 琥珀错误条
          void host.snapshot().then((st) => {
            stateRef.current = st
            if (card.fallbackSrcdoc) host.loadVersion(card.fallbackSrcdoc, st)
            setBoot('live')
            setErrbar('这个交互出错了，已回到上个可用版本')
            setErrRetry(false)
          })
        },
        onDead: () => {
          // 协议超时：3 秒不就绪判死
          setBoot('dead')
          setErrbar('这个交互没有响应')
          setErrRetry(true)
        },
      },
    })
    hostRef.current = host
    host.mount(el, card.srcdoc, card.snapshot ?? null)
    return () => {
      host.unmount()
      hostRef.current = null
    }
  }, [card.cardId, card.srcdoc, card.snapshot, card.title])

  const collect = async () => {
    const host = hostRef.current
    const snap = host ? await host.snapshot() : stateRef.current
    onCollect?.(snap)
  }

  const retry = () => {
    const host = hostRef.current
    if (!host) return
    host.reload(card.fallbackSrcdoc ?? card.srcdoc, stateRef.current)
    setBoot('loading')
    setErrbar(null)
    setErrRetry(false)
  }

  return (
    <div className={'gen-card' + (card.claimSim ? ' has-badge' : '')}>
      {card.claimSim && <span className="gen-badge">仿真结果</span>}
      <div className="gen-head">
        <span className="gen-title">{card.title}</span>
        {onOpenInWorkspace && (
          <button className="gen-act" onClick={onOpenInWorkspace}>
            在工具区打开
          </button>
        )}
        {onCollect && (
          <button className="gen-act" onClick={() => void collect()}>
            {collectLabel}
          </button>
        )}
      </div>
      {errbar && (
        <div className="gen-errbar">
          <span>{errbar}</span>
          {errRetry && (
            <button className="gen-errbar-retry" onClick={retry}>
              重试
            </button>
          )}
          <button className="gen-errbar-x" title="知道了" onClick={() => setErrbar(null)}>
            ×
          </button>
        </div>
      )}
      <div className="gen-body">
        {boot === 'loading' && (
          <div className="gen-loading">
            <span className="gen-dots">
              <i />
              <i />
              <i />
            </span>
            装载交互…
          </div>
        )}
        <div
          ref={boxRef}
          className="gen-framebox"
          style={{ height: boot === 'loading' ? 0 : undefined }}
        />
      </div>
    </div>
  )
}
