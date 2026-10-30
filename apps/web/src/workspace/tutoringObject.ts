import { projectOriginal, serverRange } from '../lib/originalText'
import { requiredId, verifySnapshot } from './confirmation'
import type { SnapshotFile } from './workspaceContracts'

/** TECH §4.1 / contracts/workspace ObjectRef 的 code 公开投影，无本机身份或教学版本。 */
export interface CodeRange {
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}
export interface CodeObjectRef {
  readonly kind: 'code'
  readonly attemptId: string
  readonly snapshotId: string
  readonly fileId: string
  readonly path: string
  readonly documentVersion: number
  readonly contentHash: string
  readonly range?: CodeRange
}

/** 本机读取结果，不能作为 help wire 正文；fileId 是稳定本机实例。 */
export interface CodeDraft {
  readonly workspaceKey: string
  readonly fileId: string
  readonly serverFileId: string | null
  readonly path: string
  readonly lifecycle: 'active' | 'recycled'
  readonly text: string
  readonly confirmed: Readonly<{ text: string; version: number; lifecycle: 'active' | 'recycled' }> | null
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

const verifiedTarget = Symbol('verified-code-target')
export interface VerifiedCodeTarget {
  readonly [verifiedTarget]: true
  readonly workspaceKey: string
  readonly attemptId: string
  readonly snapshotId: string
  readonly file: Readonly<SnapshotFile>
}

/** 从已获准 GET 快照核正文/hash/完整清单；不读取网络、不保存或创建快照。 */
export async function verifyCodeTarget(snapshot: unknown,
  context: { workspaceKey: string; attemptId: string; activityVersionId: string },
  serverFileId: string): Promise<VerifiedCodeTarget> {
  requiredId(context.attemptId); requiredId(context.activityVersionId); requiredId(serverFileId)
  if (!context.workspaceKey) throw new Error('当前作品尚未载入。')
  // 先复制所有输入：验证中的 await 不能让原对象或上下文的并发修改进入固定结果。
  const { workspaceKey, attemptId, activityVersionId } = context
  const fixed = await verifySnapshot(structuredClone(snapshot), attemptId, activityVersionId)
  const file = fixed.files.find(f => f.fileId === serverFileId)
  if (!file) throw new Error('所选文件不在这份快照中，请重新核对所指版本。')
  return Object.freeze({ [verifiedTarget]: true as const, workspaceKey, attemptId,
    snapshotId: fixed.snapshotId, file: Object.freeze({ ...file }) })
}

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

export type CodeObjectResult =
  | { ok: true; objectRef: Readonly<CodeObjectRef> }
  | { ok: false; reason: string }

/** 纯构造器：学生明确选择 file/selection，不猜当前问题，不自动确认草稿或调用模型。 */
export function createCodeObjectRef(input: {
  workspaceKey: string
  target: VerifiedCodeTarget | null
  draft: CodeDraft | null
  intent: 'file' | 'selection'
  selection?: CodeSelection | null
}): CodeObjectResult {
  const { workspaceKey, target, draft, intent, selection } = input
  const unavailable = (reason: string): CodeObjectResult => ({ ok: false, reason })
  if (!target || target[verifiedTarget] !== true) return unavailable('尚未选择并核对已确认快照，请先明确所指版本。')
  if (target.workspaceKey !== workspaceKey || !draft || draft.workspaceKey !== workspaceKey)
    return unavailable('当前作品或文件已切换，请重新选择所指对象。')
  if (draft.serverFileId !== target.file.fileId || draft.path !== target.file.path)
    return unavailable('所选文件实例与快照不符，同名文件不能代替原实例。')
  if (draft.lifecycle !== 'active' || draft.confirmed?.lifecycle !== 'active')
    return unavailable('这个文件尚未确认或已回收，请重新核对所指对象。')
  if (draft.confirmed.version !== target.file.documentVersion || draft.confirmed.text !== target.file.text)
    return unavailable('确认版本与这份快照不同，请明确选择对应的版本。')
  if (draft.text !== target.file.text)
    return unavailable('当前草稿有未确认修改。请自主确认作品后重选，或明确查看旧快照；求助不会自动保存。')
  let range: CodeRange | undefined
  if (intent === 'selection') {
    if (!selection || selection.workspaceKey !== workspaceKey || selection.fileId !== draft.fileId ||
      selection.originalText !== draft.text) return unavailable('原选区或正文已改变，请重新选择。')
    if (selection.modelStart === selection.modelEnd) return unavailable('请先选择要询问的代码，或明确选择整个文件。')
    range = codeSelectionRange(target.file.text, selection.modelStart, selection.modelEnd) ?? undefined
    if (!range) return unavailable('这个选区无法精确对应快照原文，请重新选择；原文保持不变。')
  }
  const objectRef: CodeObjectRef = Object.freeze({ kind: 'code', attemptId: target.attemptId,
    snapshotId: target.snapshotId, fileId: target.file.fileId, path: target.file.path,
    documentVersion: target.file.documentVersion, contentHash: target.file.contentHash,
    ...(range ? { range } : {}) })
  return { ok: true, objectRef }
}
