import type { HdlBuildView, HdlDiagnostic } from './hdlContracts'
import type { CodeDraft, CodeRange } from './tutoringObject'

/** Whole-line selection is a display aid, never a compiler-provided column or current-version rewrite. */
export function hdlDiagnosticTarget(diagnostic: HdlDiagnostic, build: HdlBuildView, drafts: readonly CodeDraft[]):
  { kind: 'current'; draft: CodeDraft; range: CodeRange } | { kind: 'historical' | 'unavailable'; notice: string } {
  if (diagnostic.location !== 'line-only' || !Number.isSafeInteger(diagnostic.line) || diagnostic.line! < 1)
    return { kind: 'unavailable', notice: '这条诊断没有可用源码行位置；不推断文件或列。' }
  const candidates = build.request.snapshot.files.filter(file =>
    (diagnostic.fileId === undefined || file.fileId === diagnostic.fileId) &&
    (diagnostic.path === undefined || file.path === diagnostic.path))
  if ((!diagnostic.fileId && !diagnostic.path) || candidates.length !== 1)
    return { kind: 'unavailable', notice: '诊断没有唯一的原快照文件；不定位同名的其他实例。' }
  const source = candidates[0]!, draft = drafts.find(file => file.serverFileId === source.fileId)
  if (!draft || draft.lifecycle !== 'active' || draft.path !== source.path || draft.text !== source.text ||
    draft.confirmed?.version !== source.documentVersion)
    return { kind: 'historical', notice: `诊断属于原快照 ${build.request.snapshot.snapshotId} 的 ${source.path} 第 ${diagnostic.line} 行；当前作品已改变。` }
  const lines = source.text.split('\n'), line = lines[diagnostic.line! - 1]?.replace(/\r$/, '')
  if (line === undefined || line.length === 0)
    return { kind: 'unavailable', notice: `原诊断指向第 ${diagnostic.line} 行；这行为空或超出已取得源码，不推断列。` }
  return { kind: 'current', draft, range: { startLine: diagnostic.line!, startColumn: 1,
    endLine: diagnostic.line!, endColumn: line.length + 1 } }
}
