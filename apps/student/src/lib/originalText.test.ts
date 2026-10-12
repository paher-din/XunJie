import { describe, expect, it } from 'vitest'
import {
  analyzeOriginal,
  applyModelEdits,
  OriginalEditHistory,
  projectOriginal,
  rebuildOriginal,
  serverPosition,
  serverRange,
} from './originalText'

/** 契约 §4 的原文语料：LF / CRLF / 混合 / 裸 CR / BOM / 空 / 末尾空行 / 非 BMP / 中文。 */
const CORPUS: Array<[string, string]> = [
  ['lf', 'a\nb\n'],
  ['crlf', 'a\r\nb\r\n'],
  ['mixed', 'x\r\ny\nz\rw'],
  ['bare-cr', 'a\rb'],
  ['bom-lf', '\uFEFFa\nb'],
  ['bom-crlf', '\uFEFFline1\r\nline2'],
  ['empty', ''],
  ['trailing-blank', 'a\n\n'],
  ['non-bmp', '中🙂\r\n尾'],
]

describe('打开未编辑 → 序列化：投影不丢信息', () => {
  it.each(CORPUS)('%s 往返逐字相等', (_name, text) => {
    expect(rebuildOriginal(projectOriginal(text))).toBe(text)
  })

  it('显示投影去掉 BOM、把 CRLF 与 CR 投成 LF', () => {
    expect(projectOriginal('\uFEFFa\r\nb').modelText).toBe('a\nb')
    expect(projectOriginal('a\rb').modelText).toBe('a\nb')
    expect(projectOriginal('').modelText).toBe('')
    expect(projectOriginal('a\n\n').modelText).toBe('a\n\n')
  })

  it('分析结果按序记录每个分隔符与 BOM', () => {
    expect(analyzeOriginal('x\r\ny\nz\rw')).toEqual({
      bom: false,
      separators: ['CRLF', 'LF', 'CR'],
      firstSeparator: 'CRLF',
    })
    expect(analyzeOriginal('\uFEFFa\nb')).toEqual({
      bom: true,
      separators: ['LF'],
      firstSeparator: 'LF',
    })
    expect(analyzeOriginal('ab')).toEqual({ bom: false, separators: [], firstSeparator: null })
  })
})

describe('显示 / 原文 UTF-16 offset 双向边界映射', () => {
  // 原文 '\uFEFFa\r\nb'：0=BOM 1=a 2=\r 3=\n 4=b；显示 'a\nb'：0=a 1=\n 2=b
  const p = projectOriginal('\uFEFFa\r\nb')

  it('显示 offset 映到原文：跨 BOM 与 CRLF 边界', () => {
    expect(p.toOriginalOffset(0)).toBe(1)
    expect(p.toOriginalOffset(1)).toBe(2)
    expect(p.toOriginalOffset(2)).toBe(4)
    expect(p.toOriginalOffset(3)).toBe(5)
  })

  it('原文 offset 映到显示：BOM 与分隔符内部落到投影边界', () => {
    expect(p.toModelOffset(0)).toBe(0)
    expect(p.toModelOffset(1)).toBe(0)
    expect(p.toModelOffset(2)).toBe(1)
    expect(p.toModelOffset(3)).toBe(1)
    expect(p.toModelOffset(4)).toBe(2)
    expect(p.toModelOffset(5)).toBe(3)
  })

  it('裸 CR 与混合 EOL 的边界同样对齐', () => {
    const q = projectOriginal('x\r\ny\nz\rw')
    // 显示 'x\ny\nz\nw'：0x 1\n 2y 3\n 4z 5\n 6w
    // 原文：0x 1\r 2\n 3y 4\n 5z 6\r 7w
    expect(q.toOriginalOffset(2)).toBe(3)
    expect(q.toOriginalOffset(4)).toBe(5)
    expect(q.toOriginalOffset(6)).toBe(7)
    expect(q.toOriginalOffset(7)).toBe(8)
    expect(q.toModelOffset(6)).toBe(5)
    expect(q.toModelOffset(7)).toBe(6)
  })

  it('无 BOM 无分隔符时是恒等映射', () => {
    const r = projectOriginal('ab')
    expect(r.toOriginalOffset(0)).toBe(0)
    expect(r.toOriginalOffset(2)).toBe(2)
    expect(r.toModelOffset(1)).toBe(1)
  })
})

describe('显示编辑 → 原文补丁', () => {
  it('局部编辑不动未触及区域的分隔符', () => {
    const text = 'x\r\ny\nz\rw'
    const p = projectOriginal(text)
    // 显示 'x\ny\nz\nw'，把首字符换成 X
    expect(applyModelEdits(text, p, [{ start: 0, end: 1, text: 'X' }])).toBe('X\r\ny\nz\rw')
  })

  it('跨行删除整段去掉被删分隔符，其余保留', () => {
    const text = 'a\r\nb\r\nc'
    const p = projectOriginal(text)
    // 显示 'a\nb\nc'：删除 [1,3) 即第一行尾换行与 b
    expect(applyModelEdits(text, p, [{ start: 1, end: 3, text: '' }])).toBe('a\r\nc')
  })

  it('学生新增换行采用原文第一个分隔符，无分隔符则 LF', () => {
    const crlf = projectOriginal('a\r\nb')
    // 显示 'a\nb' 末尾插入一个换行
    expect(applyModelEdits('a\r\nb', crlf, [{ start: 3, end: 3, text: '\n' }])).toBe('a\r\nb\r\n')

    const none = projectOriginal('ab')
    expect(applyModelEdits('ab', none, [{ start: 1, end: 1, text: '\n' }])).toBe('a\nb')

    const cr = projectOriginal('a\rb')
    expect(applyModelEdits('a\rb', cr, [{ start: 3, end: 3, text: '\n' }])).toBe('a\rb\r')
  })

  it('一次操作的多处变更按原坐标逆序应用', () => {
    const text = 'x\r\ny\r\n'
    const p = projectOriginal(text)
    // 显示 'x\ny\n'：[0,1)→'1'，[2,3)→'Y'
    expect(
      applyModelEdits(text, p, [
        { start: 0, end: 1, text: '1' },
        { start: 2, end: 3, text: 'Y' },
      ]),
    ).toBe('1\r\nY\r\n')
  })

  it('BOM 不是可编辑首字符：清空显示正文后 BOM 仍在', () => {
    const text = '\uFEFFa\n'
    const p = projectOriginal(text)
    expect(applyModelEdits(text, p, [{ start: 0, end: 2, text: '' }])).toBe('\uFEFF')
  })
})

describe('可逆原文历史：undo / redo / 分支', () => {
  it('undo 恢复编辑前的原文与分隔符，redo 重放', () => {
    const h = new OriginalEditHistory('a\r\nb\r\n')
    h.push('A\r\nb\r\n')
    h.push('A\r\nb\r\nc')
    expect(h.current).toBe('A\r\nb\r\nc')
    expect(h.undo()).toBe(true)
    expect(h.current).toBe('A\r\nb\r\n')
    expect(h.undo()).toBe(true)
    expect(h.current).toBe('a\r\nb\r\n')
    expect(h.undo()).toBe(false)
    expect(h.redo()).toBe(true)
    expect(h.current).toBe('A\r\nb\r\n')
    expect(h.redo()).toBe(true)
    expect(h.current).toBe('A\r\nb\r\nc')
    expect(h.redo()).toBe(false)
  })

  it('undo 之后新编辑丢弃 redo 分支', () => {
    const h = new OriginalEditHistory('x\r\n')
    h.push('x\r\ny')
    h.undo()
    h.push('x\r\nz')
    expect(h.current).toBe('x\r\nz')
    expect(h.redo()).toBe(false)
    expect(h.undo()).toBe(true)
    expect(h.current).toBe('x\r\n')
  })

  it('跨行删除后 undo 恢复被删的 CRLF 分隔符', () => {
    const text = 'a\r\nb\r\nc'
    const p = projectOriginal(text)
    const edited = applyModelEdits(text, p, [{ start: 1, end: 3, text: '' }])
    expect(edited).toBe('a\r\nc')
    const h = new OriginalEditHistory(text)
    h.push(edited)
    h.undo()
    expect(h.current).toBe(text)
    h.redo()
    expect(h.current).toBe('a\r\nc')
  })
})

describe('服务端行列语义与代码引用可用性', () => {
  it('LF 分行、一基行列', () => {
    expect(serverPosition('ab\ncd', 0)).toEqual({ line: 1, column: 1 })
    expect(serverPosition('ab\ncd', 3)).toEqual({ line: 2, column: 1 })
    expect(serverPosition('ab\ncd', 5)).toEqual({ line: 2, column: 3 })
  })

  it('CRLF 行尾 CR 不算可见列', () => {
    // 0a 1b 2\r 3\n 4c 5d
    expect(serverPosition('ab\r\ncd', 1)).toEqual({ line: 1, column: 2 })
    expect(serverPosition('ab\r\ncd', 2)).toEqual({ line: 1, column: 3 })
    expect(serverPosition('ab\r\ncd', 3)).toEqual({ line: 1, column: 3 })
    expect(serverPosition('ab\r\ncd', 4)).toEqual({ line: 2, column: 1 })
  })

  it('裸 CR 不独立分行，仍占列', () => {
    // 0a 1\r 2b 3\n
    expect(serverPosition('a\rb\n', 1)).toEqual({ line: 1, column: 2 })
    expect(serverPosition('a\rb\n', 2)).toEqual({ line: 1, column: 3 })
    expect(serverPosition('a\rb\n', 3)).toEqual({ line: 1, column: 4 })
    expect(serverPosition('a\rb\n', 4)).toEqual({ line: 2, column: 1 })
  })

  it('显示选择先映回原快照再算行列；代理项内部不可表达', () => {
    const text = '🙂\n尾'
    const p = projectOriginal(text)
    // 显示选整枚 emoji：[0,2) → 原文 [0,2)
    expect(serverRange(text, p, 0, 2)).toEqual({
      start: { line: 1, column: 1 },
      end: { line: 1, column: 3 },
    })
    // 选择起点落在代理项中间：引用不可用
    expect(serverRange(text, p, 1, 2)).toBeNull()
  })
})
