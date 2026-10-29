import { IconText } from '../../icons'
import { GenCard } from '../chat/GenCard'
import type { StoredGenCard } from '../../bridge/types'

/**
 * 工作区里的生成卡视图（第 19 条：生成卡开成中心工具区标签页，双轨同壳）。
 * GenToolPane = 标签页内容（卡片壳 + live 沙箱；「收纳」= 取快照 → 标签关闭 → 胶囊收纳）。
 * 钉右缘同样复用 chat/GenCard（live，init 带快照重建）；胶囊收纳封面在 SideDock 的 gen 行内联。
 */

export function GenToolPane({
  card,
  onCollect,
  onStateSync,
  onClose,
}: {
  card: StoredGenCard | null
  onCollect?: (snapshot: unknown) => void
  onStateSync?: (snapshot: unknown) => void
  /** 卡已不在会话里（存储被清）时关闭标签。 */
  onClose?: () => void
}) {
  if (!card) {
    return (
      <div className="ws-gen-missing">
        <p>这张生成卡已不在当前会话里。</p>
        {onClose && (
          <button className="ws-btn ghost" onClick={onClose}>
            <IconText name="close">关闭标签</IconText>
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="ws-gen-pane">
      <GenCard card={card} onCollect={onCollect} onStateSync={onStateSync} />
    </div>
  )
}

