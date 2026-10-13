import { IconText } from '../../icons'
import { useEffect, useRef, useState } from 'react'
import { CompanionButton } from '../CompanionButton'
import type { CompanionCue } from '../CompanionButton'
import { CARDS } from './cards'
import type { ToolKey } from './CenterToolArea'

/**
 * 浮动 IP 引导层（docs/home-design.md「任务工作区已确认」）：
 * 透明底 IP 在主动引导时自行移动到锚点，头顶气泡呈现——
 * 深色小气泡（简短发话）与白色大卡片（交互式教学）两种形态。
 * 教学卡片可收纳进左侧胶囊的「卡片收纳」（Q4），收纳后气泡退化为提示小气泡。
 * 引导脚本当前为课程包预置 mock；正式版本由 Agent 输出结构化引导描述、前端解释执行。
 */

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

/** 锚点：相对工作区主体的百分比位置。 */
const ANCHORS = {
  dock: { left: '14%', top: '46%' },
  board: { left: '44%', top: '46%' },
  boardRich: { left: '50%', top: '66%' },
  editor: { left: '26%', top: '14%' },
} as const

/** IP 休息位：右下；对话固定到右栏时左移避开右栏。 */
export const IP_REST = { left: 'calc(100% - 90px)', top: 'calc(100% - 78px)' }
export const IP_REST_DOCKED = { left: '68%', top: '78%' }

/** 收纳动效：气泡飞向左侧胶囊「卡片收纳」按钮的落点。 */
const COLLECT_TARGET = { left: '2.6%', top: '55%' }

export function GuideLayer({
  step,
  stepIndex,
  total,
  idle,
  busy,
  milestone,
  docked,
  collected,
  pinned,
  collecting,
  onNext,
  onCollect,
  onIpClick,
}: {
  /** 当前引导步；null 表示引导已结束，IP 休息。 */
  step: GuideStep | null
  stepIndex: number
  total: number
  /** 对话面板打开或已固定时，IP 回休息位且不显示气泡。 */
  idle: boolean
  busy: boolean
  milestone: number
  /** 对话已固定到右栏，休息位左移。 */
  docked: boolean
  /** 已收纳进左侧胶囊的卡片 key。 */
  collected: string[]
  /** 已钉住在右缘的卡片 key（同样视为已收纳，气泡不再重复出卡片）。 */
  pinned: string[]
  /** 正在播放收纳飞行动效的卡片 key。 */
  collecting: string | null
  onNext: (step: GuideStep) => void
  onCollect: (cardKey: string) => void
  onIpClick: () => void
}) {
  const active = step !== null && !idle
  const pos = step === null || idle ? (docked ? IP_REST_DOCKED : IP_REST) : ANCHORS[step.at]
  const cardDef = step?.card ? CARDS[step.card] : null
  const cardCollected = step?.card ? collected.includes(step.card) || pinned.includes(step.card) : false
  const cardPinned = step?.card ? pinned.includes(step.card) : false
  const [cue, setCue] = useState<CompanionCue | undefined>(undefined)
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
  const guideTool = !active ? 'none' : step?.card ? 'chalk' : step?.at === 'editor' ? 'pencil' : step?.at === 'board' ? 'pointer' : 'none'

  return (
    <>
      <CompanionButton className="ws-ip" style={pos} onClick={onIpClick} aria-label="学习助手" aria-expanded={idle}
        attention={idle} working={busy} tool={guideTool} cue={cue} />
      {active && step && (
        <div className="ws-bubble-pos" style={collecting ? COLLECT_TARGET : pos}>
          {cardDef && !cardCollected ? (
            <div
              key={stepIndex}
              className={`ws-bubble rich${step.below ? ' below' : ''}${collecting ? ' collecting' : ''}`}
            >
              <div className="ws-bstep">
                引导 {stepIndex + 1} / {total}
              </div>
              <b className="ws-cardtitle">{cardDef.title}</b>
              <cardDef.Body />
              <div className="ws-brow">
                <button className="ws-collect" onClick={() => onCollect(step.card!)}>
                  <IconText name="archive-down">收纳</IconText>
                </button>
                <button className="ws-bbtn" onClick={() => onNext(step)}>
                  <IconText name="arrow-right" position="end">明白了，下一步</IconText>
                </button>
              </div>
            </div>
          ) : (
            <div key={stepIndex} className={step.below ? 'ws-bubble below' : 'ws-bubble'}>
              <div className="ws-bstep">
                引导 {stepIndex + 1} / {total}
              </div>
              <div className="ws-btext">
                {cardPinned
                  ? '卡片钉在右缘对照中，随时可以放回收纳。'
                  : cardCollected
                    ? '卡片已收进左侧「卡片收纳」，点胶囊上的收纳按钮就能取出钉住对照。'
                    : step.text}
              </div>
              <div className="ws-brow">
                <button className="ws-bbtn" onClick={() => onNext(step)}>
                  <IconText name={stepIndex === total - 1 ? 'check' : 'arrow-right'} position="end">{stepIndex === total - 1 ? '开始动手' : '下一步'}</IconText>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}
