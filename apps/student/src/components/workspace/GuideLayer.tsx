import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CompanionCue } from '../CompanionButton'
import { CARDS } from './cards'
import type { ToolKey } from './CenterToolArea'
import { GuidancePresentation } from './guidance/GuidancePresentation'
import type { GuidanceItem, GuidanceReceipt } from './guidance/GuidancePresentation'

export interface GuideStep {
  /** 锚点名，见 ANCHORS。 */
  at: 'dock' | 'board' | 'boardRich' | 'editor'
  text?: string
  /** 白色大卡片：cards.tsx 注册表中的卡片 key。 */
  card?: string
  /** 气泡在 IP 下方（默认在头顶）。 */
  below?: boolean
  /** 到达该步时切换中心工具区的标签。 */
  tool?: ToolKey
}

/** Legacy course coordinates stay in this adapter, never in the presentation layer. */
const ANCHORS = { dock: [.14, .46], board: [.44, .46], boardRich: [.50, .66], editor: [.26, .14] } as const
export const IP_REST = { left: 'calc(100% - 90px)', top: 'calc(100% - 78px)' }
export const IP_REST_DOCKED = { left: '68%', top: '78%' }

export function GuideLayer({ step, stepIndex, total, idle, busy, milestone, docked, collected, pinned, collecting, onNext, onCollect, onIpClick, onPresentationAction }: {
  step: GuideStep | null; stepIndex: number; total: number; idle: boolean; busy: boolean; milestone: number; docked: boolean
  collected: string[]; pinned: string[]; collecting: string | null
  onNext: (step: GuideStep) => void; onCollect: (cardKey: string) => void; onIpClick: () => void
  /** Optional observer of the actual presentation receipt, useful to host the adapter in previews. */
  onPresentationAction?: (receipt: GuidanceReceipt) => void
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const active = step !== null && !idle
  const card = step?.card ? CARDS[step.card] : null
  const stored = !!step?.card && (collected.includes(step.card) || pinned.includes(step.card))
  const isPinned = !!step?.card && pinned.includes(step.card)
  const [cue, setCue] = useState<CompanionCue>()
  const lastMilestone = useRef(milestone)
  useEffect(() => {
    if (active) setCue({ key: `guide-${stepIndex}`, motion: 'invite', delay: 500 })
  }, [active, stepIndex])
  useEffect(() => {
    if (milestone !== lastMilestone.current) {
      lastMilestone.current = milestone
      if (!idle && !busy) setCue({ key: `milestone-${milestone}`, motion: 'celebrate' })
    }
  }, [milestone, idle, busy])
  const instance = useId()
  const revision = useRef(0)
  // Step reference catches a new course/script with identical fields; the signature
  // also catches in-place edits and changes to the displayed label/storage copy.
  const signature = JSON.stringify([step, stepIndex, total, stored, isPinned])
  const presentationId = useMemo(() => `${instance}-legacy-${++revision.current}`, [instance, step, signature])
  const item: GuidanceItem = {
    id: presentationId,
    label: `引导 ${stepIndex + 1} / ${total}`,
    content: card && !stored ? { kind: 'card', title: card.title, body: <card.Body /> } : { kind: 'text', text: isPinned
      ? '卡片钉在右缘对照中，随时可以放回收纳。'
      : stored ? '卡片已收进左侧「卡片收纳」，点胶囊上的收纳按钮就能取出钉住对照。' : step?.text ?? '' },
    preferBelow: step?.below,
    target: () => {
      const host = anchor.current?.parentElement?.getBoundingClientRect()
      if (!host || (!active && !docked)) return null
      const [x, y] = active && step ? ANCHORS[step.at] : [.68, .78]
      return { left: host.left + host.width * x, top: host.top + host.height * y, width: 1, height: 1 }
    },
    actions: active ? [
      ...(card && !stored ? [{ id: 'collect', label: collecting ? '正在收纳' : '收纳', disabled: !!collecting }] : []),
      { id: 'next', label: stepIndex === total - 1 ? '开始动手' : '下一步', primary: true, disabled: !!collecting },
    ] : [],
  }
  return <>
    <span ref={anchor} hidden />
    <GuidancePresentation item={item} state={!active ? 'quiet' : busy ? 'busy' : 'showing'}
      appearance={{ cue, attention: idle, tool: !active ? 'none' : step?.card ? 'chalk' : step?.at === 'editor' ? 'pencil' : step?.at === 'board' ? 'pointer' : 'none' }}
      companionAction={{ id: 'chat', label: '学习助手' }} onAction={receipt => {
        onPresentationAction?.(receipt)
        if (receipt.actionId === 'chat') onIpClick()
        else if (receipt.actionId === 'next' && step) onNext(step)
        else if (receipt.actionId === 'collect' && step?.card) onCollect(step.card)
      }} />
  </>
}
