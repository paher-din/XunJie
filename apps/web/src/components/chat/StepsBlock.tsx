import { useState } from 'react'
import { Icon } from '../../icons'

/**
 * 教学化步骤块（已确认 2026-10-11，docs/agent-page-design.md 第 20 条）：
 * 消息内编号行块，逐步流出（每步落定一行，进行中步带脉冲点，复用活动行视觉语言）；
 * 落定后可折叠成「N 步 · 已讲完」一行，默认展开。
 * 与思考区的区分靠内容性质：思考区是模型自述（灰、折叠），步骤块是教学内容（正文色、编号）。
 */
export function StepsBlock({ steps, running }: { steps: string[]; running: boolean }) {
  const [open, setOpen] = useState(true)
  // 进行中不可折叠（每步落定一行是流式的一部分）；落定后才允许收成摘要行
  const collapsed = !running && !open

  if (collapsed) {
    return (
      <button className="steps-sum" onClick={() => setOpen(true)}>
        <Icon name="route" size={13} />
        <span>
          {steps.length} 步 · 已讲完
        </span>
        <Icon className="arw" name="alt-arrow-right" size={12} />
      </button>
    )
  }

  return (
    <div className="steps-block">
      {steps.map((s, i) => {
        const active = running && i === steps.length - 1
        return (
          <div key={i} className={active ? 'step-row active' : 'step-row done'}>
            <span className="step-n">{active ? undefined : i + 1}</span>
            <span className="step-t">{s}</span>
          </div>
        )
      })}
      {!running && (
        <button className="steps-fold" onClick={() => setOpen(false)}>
          收起 · {steps.length} 步已讲完
        </button>
      )}
    </div>
  )
}
