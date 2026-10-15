import type { ActivityView, ResourceStudentView } from './contracts'
import { textHash } from './confirmation'
import type { WorkspaceContext } from './context'
import type { MaterialRead } from './init'
import type { WorkspaceMode } from './mode'

export type TutoringResourceResult =
  | { kind: 'ready'; resource: ResourceStudentView; nature: 'synthetic-example' | 'course-material'; sourceLabel: string }
  | { kind: 'unavailable'; reason: 'missing-reference' | 'not-readable' | 'load-failed' | 'projection-mismatch'; notice: string }

/** Wire references may mix project/code IDs with paragraph hashes; only an exact public material match opens. */
export async function resolveTutoringReferences(resourceRefs: readonly string[], activity: ActivityView,
  materials: readonly MaterialRead[], mode: WorkspaceMode): Promise<TutoringResourceResult> {
  if (activity.content.audience !== 'student') return resolveTutoringResource('', activity, materials, mode)
  for (const ref of resourceRefs) {
    for (const material of activity.content.materials) {
      if (material.status !== 'available') continue
      // The isolated preparation transport historically supplies bare resource version IDs.
      if (mode === 'preparation' && ref === material.resourceVersionId) {
        return resolveTutoringResource(material.resourceVersionId, activity, materials, mode)
      }
      if (!/^resource:[a-f0-9]{64}$/.test(ref)) continue
      for (const paragraph of material.paragraphs) {
        if (!paragraph.paragraphId) continue
        // apps/teaching/server/tutoring/context.ts: boundedReferenceId('resource', identity).
        const expected = `resource:${await textHash(JSON.stringify([
          material.resourceVersionId, paragraph.paragraphId, paragraph.contentHash,
        ]))}`
        if (ref === expected) return resolveTutoringResource(material.resourceVersionId, activity, materials, mode)
      }
    }
  }
  return resolveTutoringResource(resourceRefs[0] ?? '', activity, materials, mode)
}

/** Only resolves IDs explicitly supplied by resourceRefs, never parses teaching prose into cards.
 * The caller must use init.activity/materials from the same currently valid context as the message.
 * ResourceStudentView has no example/approval flag: readable material is not automatically an example.
 */
export function resolveTutoringResource(resourceVersionId: string, activity: ActivityView,
  materials: readonly MaterialRead[], mode: WorkspaceMode): TutoringResourceResult {
  const unavailable = (reason: Extract<TutoringResourceResult, { kind: 'unavailable' }>['reason'], notice: string): TutoringResourceResult =>
    ({ kind: 'unavailable', reason, notice })
  if (!resourceVersionId || activity.content.audience !== 'student') {
    return unavailable('missing-reference', '没有可核对的学生公开资料引用。')
  }
  const projected = activity.content.materials
  const indices = projected.flatMap((m, index) => m.status === 'available' && m.resourceVersionId === resourceVersionId ? [index] : [])
  if (indices.length !== 1) return unavailable('not-readable', '该引用不在当前活动可读资料中；没有取得获准正文。')
  const index = indices[0]!
  const reads = materials.filter(m => m.index === index)
  if (reads.length !== 1) return unavailable('load-failed', '这份资料尚未取得可核对的读取结果。')
  const read = reads[0]!
  if (read.projectedStatus !== 'available' || read.state.kind === 'not-readable') {
    return unavailable('not-readable', '这份资料不可读取；不补充隐藏或缺失内容。')
  }
  if (read.state.kind === 'failed') return unavailable('load-failed', '这份资料读取失败或未获权限；请重新读取后再查看。')
  const view = read.state.view, source = projected[index]!
  if (source.status !== 'available' || view.status !== 'available' || view.resourceVersionId !== resourceVersionId ||
    typeof view.title !== 'string' || typeof view.text !== 'string' || typeof view.contentHash !== 'string' ||
    !view.contentHash || !Array.isArray(view.paragraphs) || view.contentHash !== source.contentHash || view.text !== source.text) {
    return unavailable('projection-mismatch', '资料版本或正文与当前活动投影不符；不展示未核对的内容。')
  }
  const synthetic = import.meta.env.DEV && mode === 'preparation' && resourceVersionId === 'prep-resource-adjacent-example-01'
  return { kind: 'ready', resource: structuredClone(view), nature: synthetic ? 'synthetic-example' : 'course-material',
    sourceLabel: synthetic ? '共同设计的相邻例子 · 合成准备材料 · 不是 TextScope 答案'
      : import.meta.env.DEV && mode === 'preparation' ? '合成准备课程资料' : '当前活动公开课程资料' }
}

/** Stable local model identity and the exact original draft, NOT an editor internal version. */
export interface TutoringReturnFile {
  fileId: string
  serverFileId?: string
  path: string
  lifecycle: 'active' | 'recycled'
  documentVersion: number | null
  contentHash: string | null
  draftText: string
}
/** Business identity and local view remain separate; no server position command is generated. */
export interface TutoringReturnAnchor<V> {
  context: WorkspaceContext
  file: TutoringReturnFile
  view: V | null
}
export type TutoringReturnResult<V> =
  | { kind: 'ready'; fileId: string; view: V }
  | { kind: 'unavailable'; reason: 'context-changed' | 'file-missing' | 'file-recycled' | 'version-changed' | 'draft-changed' | 'view-missing'; notice: string }

/** V is a serializable editor-local view, e.g. cursor/scroll/folds; never contains a model or undo stack.
 * Caller keeps CodeWorkspace mounted and its existing model/history alive beneath the reading slot.
 */
export function captureTutoringReturn<V>(context: WorkspaceContext, file: TutoringReturnFile,
  view: V | null): TutoringReturnAnchor<V> {
  return structuredClone({ context, file, view })
}

/** Reject any stale location. Caller may dismiss the reading slot on failure, but cannot apply the old view. */
export function validateTutoringReturn<V>(anchor: TutoringReturnAnchor<V>, context: WorkspaceContext,
  files: readonly TutoringReturnFile[]): TutoringReturnResult<V> {
  const unavailable = (reason: Extract<TutoringReturnResult<V>, { kind: 'unavailable' }>['reason'], notice: string): TutoringReturnResult<V> =>
    ({ kind: 'unavailable', reason, notice })
  const identityKeys = ['mode', 'userId', 'assignmentId', 'activityVersionId', 'attemptId', 'preparationEpoch',
    'loadEpoch', 'trustedRecoveryGeneration'] as const
  if (!context.userId || !context.attemptId || !context.assignmentId || !context.activityVersionId ||
    !context.trustedRecoveryGeneration || identityKeys.some(key => anchor.context[key] !== context[key])) {
    return unavailable('context-changed', '工作区身份或载入已变化；原位置不用于当前作品，请明确选择当前文件。')
  }
  const matches = files.filter(f => f.fileId === anchor.file.fileId)
  if (matches.length !== 1) return unavailable('file-missing', '原文件实例已缺失；不把同名新文件当作原作品。')
  const file = matches[0]!, before = anchor.file
  if (file.lifecycle !== 'active' || before.lifecycle !== 'active') {
    return unavailable('file-recycled', '原文件实例已回收；保留原引用，请明确选择当前作品。')
  }
  if (file.serverFileId !== before.serverFileId || file.path !== before.path ||
    file.documentVersion !== before.documentVersion || file.contentHash !== before.contentHash) {
    return unavailable('version-changed', '原文件版本或映射已变；不将旧位置贴到新版本。')
  }
  if (file.draftText !== before.draftText) return unavailable('draft-changed', '本机草稿已变化；保留现有草稿，不套用旧位置。')
  if (anchor.view === null) return unavailable('view-missing', '没有保留精确本机视图；可关闭资料继续编辑，不猜测旧位置。')
  return { kind: 'ready', fileId: file.fileId, view: structuredClone(anchor.view) }
}
