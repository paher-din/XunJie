import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConceptCard as ConceptCardData } from '../../bridge/types'
import { ConceptCard } from './ConceptCard'

/**
 * 概念讲解卡的一块一块：卡片是随正文长出来的，画完之前不给动作。
 * 走 SSR 静态渲染，只断言落进 DOM 的结构；描线 / 淡入这类观感由实屏复验（第 27 条）。
 */
const SHELL: ConceptCardData = { title: '同步复位 vs 异步复位', afterPara: 2, points: [] }
const WAVE: NonNullable<ConceptCardData['wave']> = {
  rows: [{ name: 'CLK', clk: true }, { name: 'rst_n', segs: [[140, 0]] }],
}
const FULL: ConceptCardData = {
  ...SHELL,
  points: ['判别标准：要不要等时钟的有效边沿。', '同步复位：等到下一个上升沿才归零。'],
  note: '读图：rst_n 在两个上升沿之间拉低。',
  wave: WAVE,
}
const html = (card: ConceptCardData, stage?: 'drawing' | 'paused' | 'ready') =>
  renderToStaticMarkup(<ConceptCard card={card} stage={stage} onTogglePin={() => {}} />)

describe('概念讲解卡按阶段给内容给动作', () => {
  it('生成中只有壳的那一拍不摆空 body：头部之外一块不少也不多', () => {
    const out = html(SHELL, 'drawing')
    expect(out).toContain('concept-head')
    expect(out).not.toContain('concept-body')
    expect(out).toContain('同步复位 vs 异步复位')
    expect(out).toContain('concept-live')
    expect(out).toContain('生成中')
  })

  it('动作只给落定态：生成中与停在半张卡都不给收纳、不给收起', () => {
    for (const stage of ['drawing', 'paused'] as const) {
      const out = html(FULL, stage)
      expect(out).not.toContain('concept-keep')
      expect(out).not.toContain('concept-fold')
    }
    const done = html(FULL)
    expect(done).toContain('concept-keep')
    expect(done).toContain('concept-fold')
    expect(done).not.toContain('生成中')
    // 停在半张卡：不写「生成中」（已经不在生成），但内容原样留着
    const paused = html(FULL, 'paused')
    expect(paused).not.toContain('生成中')
    expect(paused).toContain('判别标准')
  })

  it('要点一条一条写出来：有几条就画几行', () => {
    const one = html({ ...SHELL, points: [FULL.points[0]] }, 'drawing')
    expect(one.match(/<li>/g)).toHaveLength(1)
    expect(html(FULL, 'drawing').match(/<li>/g)).toHaveLength(2)
  })

  it('波形按送来的行画：几条信号几行，描线用的 pathLength 归一成 1', () => {
    const out = html({ ...SHELL, wave: WAVE }, 'drawing')
    expect(out).toContain('concept-wave')
    expect(out.match(/pathLength="1"/g)).toHaveLength(2)
    expect(out).toContain('>CLK</text>')
  })
})
