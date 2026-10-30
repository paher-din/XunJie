import { describe, expect, it } from 'vitest'
import { lexer } from 'marked'
import { insertIndex } from '../../lib/messageBlocks'
import { blocksOf, realBlocks } from './Markdown'

/** 渲染器实际会拿到什么块：走的就是组件那条管线（空行不进 DOM，只有标记的尾块先当不存在）。 */
const types = (text: string, live?: boolean, truncated?: boolean) =>
  blocksOf(text, live, truncated).map((t) => t.type)

describe('流式正文的块序列', () => {
  it('空行不成块，段落仍按顺序连着', () => {
    expect(types('甲\n\n乙', true)).toEqual(['paragraph', 'paragraph'])
  })

  it('刚起头的标记不闪成空块', () => {
    // 正文第一拍的加粗前导：marked 把单个 * 判成一条空列表，渲染出来是一枚空子弹
    expect(types('*', true)).toEqual([])
    expect(types('**', true)).toEqual([])
    // 围栏起头的三拍：``` 已成 code 块，但还没有一行内容
    expect(types('```', true)).toEqual([])
    expect(types('```verilog\n', true)).toEqual([])
    // 列表起头
    expect(types('- ', true)).toEqual([])
    // 标题 / 引用起头：marked 已经把它判成形块，可那一个字都还没有
    expect(types('#', true)).toEqual([])
    expect(types('## ', true)).toEqual([])
    expect(types('>', true)).toEqual([])
    // 列表项的 `-` 刚落、字还没到：remend 会在它后面补一个零宽空格防 setext 误判，于是 marked
    // 报出一条「末项为空」的列表——整条列表不是空的，按块判「只有标记」判不到它，照原样画就是
    // 一枚没有正文的空子弹（实测一条两段式回复逐字扫 268 拍能扫出 11 个）
    expect(types('甲\n- ', true)).toEqual(['paragraph'])
    expect(types('甲\n\n- 一\n- ', true)).toEqual(['paragraph', 'list'])
    expect(types('甲\n1. ', true)).toEqual(['paragraph'])
  })

  it('有内容就照常成块，不早半拍也不晚半拍', () => {
    expect(types('两点：\n\n- 同步', true)).toEqual(['paragraph', 'list'])
    expect(types('```verilog\n// 注释', true)).toEqual(['code'])
    expect(types('**复位**的作用', true)).toEqual(['paragraph'])
    expect(types('# 差别', true)).toEqual(['heading'])
    expect(types('> 模拟记录', true)).toEqual(['blockquote'])
  })

  it('表格在分隔行打全前不渲染成裸 | 与 ---', () => {
    expect(types('| 状态 | 任务数 |', true)).toEqual([])
    expect(types('甲\n\n| 状态 | 任务数 |\n| --', true)).toEqual(['paragraph'])
    // 分隔行第二个单元格一落定就是表格（marked 不要求收尾那根 |）
    expect(types('| 状态 | 任务数 |\n| --- | ---', true)).toEqual(['table'])
  })

  it('落定后一块不少（半成品不该在最终正文里消失）', () => {
    expect(types('*')).toEqual(['list'])
    expect(types('#')).toEqual(['heading'])
    expect(types('>')).toEqual(['blockquote'])
    expect(types('甲\n\n乙')).toEqual(['paragraph', 'paragraph'])
    expect(types('| 状态 | 任务数 |')).toEqual(['paragraph'])
  })
})

/**
 * 按下「停止」或中途失败：正文停在半路上，而且再也没有下一拍。
 * 空标记那拍藏起来是免费的（它一个字的内容都没有），已经写出来的字则一个都不能少。
 */
describe('停在半路的回复', () => {
  it('空子弹 / 空标题 / 空引用不上屏', () => {
    expect(types('甲\n\n- ', undefined, true)).toEqual(['paragraph'])
    expect(types('#', undefined, true)).toEqual([])
    expect(types('>', undefined, true)).toEqual([])
  })

  it('半截表格留着：那就是它的全部内容了', () => {
    expect(types('| 状态 | 任务', undefined, true)).toEqual(['paragraph'])
  })
})

/** 消息内卡片（概念讲解卡）挂在哪个块之后。 */
describe('消息内卡片的落点', () => {
  // 块序：段落 甲 / 段落 乙 / 列表 / 段落 丙 / 代码 / 段落 丁
  const doc = '甲\n\n乙：\n\n- 一\n- 二\n\n丙\n\n```verilog\nx\n```\n\n丁'
  const blocks = realBlocks(lexer(doc))

  it('挂在讲它的那一段之后', () => {
    expect(blocks.map((t) => t.type)).toEqual([
      'paragraph',
      'paragraph',
      'list',
      'paragraph',
      'code',
      'paragraph',
    ])
    expect(insertIndex(blocks, 1)).toBe(0)
    expect(insertIndex(blocks, 4)).toBe(5)
  })

  it('那段引出的列表 / 代码一并带上：卡片不插进列表中间，也不插进代码前面', () => {
    expect(insertIndex(blocks, 2)).toBe(2)
    expect(insertIndex(blocks, 3)).toBe(4)
  })

  it('缺省或超出段数就附在正文末尾', () => {
    expect(insertIndex(blocks)).toBe(blocks.length - 1)
    expect(insertIndex(blocks, 9)).toBe(blocks.length - 1)
  })

  it('标题不停在这里：它开的是下一节，卡片不能压在节标题前面', () => {
    // 块序：段落 / 列表 / 标题 / 段落
    const withHead = realBlocks(lexer('甲\n\n- 一\n\n### 下一节\n\n乙'))
    expect(withHead.map((t) => t.type)).toEqual(['paragraph', 'list', 'heading', 'paragraph'])
    expect(insertIndex(withHead, 1)).toBe(1)
  })
})
