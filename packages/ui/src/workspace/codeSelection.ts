import { projectOriginal, serverRange } from './originalText'

export interface CodeRange {
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}
export interface CodeSelection {
  readonly workspaceKey: string
  readonly fileId: string
  readonly originalText: string
  readonly modelStart: number
  readonly modelEnd: number
}
export type CodeSelectionResult =
  | { ok: true; selection: CodeSelection }
  | { ok: false; reason: string }

/** 与当前服务端 workspace/files.rangeOffsets 相同：LF 分行，行尾 CR 不占可见列。 */
export function codeRangeOffsets(text: string, range: CodeRange): readonly [number, number] | null {
  if ([range.startLine, range.startColumn, range.endLine, range.endColumn]
    .some(n => !Number.isSafeInteger(n) || n < 1)) return null
  const lines = text.split('\n')
  const offset = (line: number, column: number): number | null => {
    const raw = lines[line - 1]
    if (raw === undefined || column > (raw.endsWith('\r') ? raw.length - 1 : raw.length) + 1) return null
    return lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0) + column - 1
  }
  const start = offset(range.startLine, range.startColumn), end = offset(range.endLine, range.endColumn)
  if (start === null || end === null || end < start || splitsPair(text, start) || splitsPair(text, end)) return null
  return [start, end]
}

function splitsPair(text: string, offset: number): boolean {
  const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset)
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff
}

/** 保留原文；只接受可以经公共行列精确映回相同原文 offset 的显示边界。 */
export function codeSelectionRange(text: string, modelStart: number, modelEnd: number): CodeRange | null {
  const projection = projectOriginal(text)
  if (!Number.isSafeInteger(modelStart) || !Number.isSafeInteger(modelEnd) || modelStart < 0 ||
    modelEnd < modelStart || modelEnd > projection.modelText.length) return null
  const mapped = serverRange(text, projection, modelStart, modelEnd)
  if (!mapped) return null
  const range = { startLine: mapped.start.line, startColumn: mapped.start.column,
    endLine: mapped.end.line, endColumn: mapped.end.column }
  const offsets = codeRangeOffsets(text, range)
  if (!offsets || offsets[0] !== projection.toOriginalOffset(modelStart) ||
    offsets[1] !== projection.toOriginalOffset(modelEnd)) return null
  return Object.freeze(range)
}

/** 公共原文范围 → 显示 offset；BOM/CRLF 内部等被投影隐藏的边界不吸附到邻字。 */
export function codeRangeModelOffsets(text: string, range: CodeRange): readonly [number, number] | null {
  const original = codeRangeOffsets(text, range)
  if (!original) return null
  const projection = projectOriginal(text)
  const start = projection.toModelOffset(original[0]), end = projection.toModelOffset(original[1])
  if (projection.toOriginalOffset(start) !== original[0] || projection.toOriginalOffset(end) !== original[1]) return null
  return [start, end]
}
