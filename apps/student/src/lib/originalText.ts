/**
 * 原文本权威适配（契约 §4）：权威是草稿的原始 Unicode 字符串，不是 model.getValue()。
 * Monaco 只拿 LF 显示投影；BOM 与每个换行分隔符（LF/CRLF/CR）留在原文里。
 * 本模块是纯函数层：投影、双向 offset 边界映射、原文补丁、可逆历史与服务端行列。
 */

export type Eol = 'LF' | 'CRLF' | 'CR'

export interface OriginalAnalysis {
  bom: boolean
  /** 原文里每个换行分隔符的种类，按出现顺序。 */
  separators: Eol[]
  firstSeparator: Eol | null
}

export function analyzeOriginal(text: string): OriginalAnalysis {
  const bom = text.charCodeAt(0) === 0xfeff
  const separators: Eol[] = []
  for (let i = bom ? 1 : 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        separators.push('CRLF')
        i++
      } else {
        separators.push('CR')
      }
    } else if (ch === '\n') {
      separators.push('LF')
    }
  }
  return { bom, separators, firstSeparator: separators[0] ?? null }
}

function sepText(sep: Eol): string {
  if (sep === 'CRLF') return '\r\n'
  if (sep === 'CR') return '\r'
  return '\n'
}

export interface OriginalProjection {
  modelText: string
  analysis: OriginalAnalysis
  /** 显示 UTF-16 offset → 原文 UTF-16 offset（边界映射）。 */
  toOriginalOffset: (modelOffset: number) => number
  /** 原文 UTF-16 offset → 显示 offset；BOM 与分隔符内部落到投影边界（分隔符取起始侧）。 */
  toModelOffset: (originalOffset: number) => number
}

/** LF 显示投影：去 BOM、CRLF/CR 投成 LF。原文不动。 */
export function projectOriginal(text: string): OriginalProjection {
  const analysis = analyzeOriginal(text)
  const body = analysis.bom ? text.slice(1) : text
  const modelText = body.replace(/\r\n|\r|\n/g, '\n')

  // toOrig[k] = 显示 offset k 对应的原文 offset；k 遍历 0..modelText.length
  const toOrig: number[] = []
  let i = analysis.bom ? 1 : 0
  let k = 0
  while (i < text.length) {
    toOrig[k] = i
    const ch = text[i]
    if (ch === '\r' && text[i + 1] === '\n') {
      i += 2
      k++
      toOrig[k] = i
    } else if (ch === '\r' || ch === '\n') {
      i++
      k++
      toOrig[k] = i
    } else {
      i++
      k++
    }
  }
  toOrig[k] = i

  const toOriginalOffset = (modelOffset: number): number => toOrig[modelOffset]
  const toModelOffset = (originalOffset: number): number => {
    if (originalOffset <= toOrig[0]) return 0
    if (originalOffset >= toOrig[toOrig.length - 1]) return toOrig.length - 1
    let lo = 0
    let hi = toOrig.length - 1
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (toOrig[mid] <= originalOffset) lo = mid
      else hi = mid
    }
    return lo
  }

  return { modelText, analysis, toOriginalOffset, toModelOffset }
}

/** 由投影重建原文（打开未编辑 → 序列化）；分隔符数量对不上即投影坏掉，直接抛。 */
export function rebuildOriginal(projection: OriginalProjection): string {
  const lines = projection.modelText.split('\n')
  const { separators, bom } = projection.analysis
  if (separators.length !== lines.length - 1) {
    throw new Error(`投影不一致：${lines.length - 1} 个换行对 ${separators.length} 个分隔符`)
  }
  let out = bom ? '\uFEFF' : ''
  for (let i = 0; i < lines.length; i++) {
    out += lines[i]
    if (i < lines.length - 1) out += sepText(separators[i])
  }
  return out
}

/** 一次显示变更：显示坐标半开区间 [start, end) 与被插入的显示文本。 */
export interface ModelEdit {
  start: number
  end: number
  text: string
}

/** 学生新增换行采用的分隔符：原文第一个分隔符，无分隔符则 LF。 */
export function newlineFor(analysis: OriginalAnalysis): string {
  return analysis.firstSeparator === null ? '\n' : sepText(analysis.firstSeparator)
}

/**
 * 用旧投影把显示编辑映回原文并应用：未触及区域的分隔符与 BOM 不变，
 * 新增换行按 newlineFor 改写。多处变更按原坐标逆序应用（同起点按应用顺序逆序）。
 */
export function applyModelEdits(original: string, projection: OriginalProjection, edits: ModelEdit[]): string {
  const nl = newlineFor(projection.analysis)
  const mapped = edits
    .map((edit, idx) => ({
      idx,
      start: projection.toOriginalOffset(edit.start),
      end: projection.toOriginalOffset(edit.end),
      text: edit.text.replace(/\n/g, nl),
    }))
    .sort((a, b) => b.start - a.start || b.idx - a.idx)
  let out = original
  for (const edit of mapped) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}

/**
 * 与 Monaco undo/redo 状态对应的可逆原文历史：每笔编辑记原文前后态，
 * undo/redo 直接取前后态，不用 Monaco 的规范化文本做逆操作（契约 §4）。
 */
export class OriginalEditHistory {
  private entries: Array<{ before: string; after: string }> = []
  private cursor = 0
  private state: string

  constructor(initial: string) {
    this.state = initial
  }

  get current(): string {
    return this.state
  }

  /** 一笔新编辑（或一次含多范围的操作）后的原文；丢弃 redo 分支。 */
  push(next: string): void {
    this.entries.length = this.cursor
    this.entries.push({ before: this.state, after: next })
    this.cursor++
    this.state = next
  }

  undo(): boolean {
    if (this.cursor === 0) return false
    this.cursor--
    this.state = this.entries[this.cursor].before
    return true
  }

  redo(): boolean {
    if (this.cursor === this.entries.length) return false
    this.state = this.entries[this.cursor].after
    this.cursor++
    return true
  }
}

export interface ServerPosition {
  line: number
  column: number
}

/**
 * 当前服务端范围语义的一基行列：LF 分行；CRLF 行尾 CR 不算可见列；裸 CR 不独立分行。
 * 只能对原快照 offset 计算，不能直接用 Monaco 的显示行列（契约 §4）。
 */
export function serverPosition(text: string, offset: number): ServerPosition {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') {
      line++
      lineStart = i + 1
    }
  }
  const lineEnd = text.indexOf('\n', lineStart)
  const contentEnd = lineEnd < 0 ? text.length : lineEnd
  const content = text.slice(lineStart, contentEnd)
  const visibleLen = lineEnd < 0 || !content.endsWith('\r') ? content.length : content.length - 1
  return { line, column: Math.min(offset - lineStart, visibleLen) + 1 }
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

export interface ServerRange {
  start: ServerPosition
  end: ServerPosition
}

/** 显示选择 → 原快照 offset → 服务端行列；边界落在代理项内部时引用不可用（null）。 */
export function serverRange(
  text: string,
  projection: OriginalProjection,
  modelStart: number,
  modelEnd: number,
): ServerRange | null {
  const start = projection.toOriginalOffset(modelStart)
  const end = projection.toOriginalOffset(modelEnd)
  if (splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end)) return null
  return { start: serverPosition(text, start), end: serverPosition(text, end) }
}
