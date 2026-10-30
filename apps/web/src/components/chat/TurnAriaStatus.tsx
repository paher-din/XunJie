import type { TurnPhase } from '../../bridge/types'

/**
 * 回合状态播报区（2026-10-12，判据见 docs/research/content-output-mechanisms-2026-10-12.md）：
 * 转录区挂 `role="log"` 就已经是一条 polite 直播通道——逐字上屏的内容全都会进读屏队列，
 * 一条 430 字的回复能塞进去几百条。所以转录区改 `aria-live="off"`（能读、不播报），
 * 由这里只报两件事：这一回合开始了、这一回合结束了。焦点始终留在输入框，不抢读屏光标。
 *
 * 文案按「变了吗」播报：waiting / thinking / streaming 折成同一句，相位切换不会连报三声。
 */
const TEXT: Record<TurnPhase, string> = {
  waiting: '正在生成回复',
  thinking: '正在生成回复',
  streaming: '正在生成回复',
  settled: '回复已生成',
  stopped: '已停止生成',
  failed: '生成失败',
}

export function TurnAriaStatus({ phase }: { phase?: TurnPhase }) {
  return (
    <div className="turn-aria" role="status" aria-live="polite">
      {phase ? TEXT[phase] : ''}
    </div>
  )
}
