import type { ProjectFile } from '../bridge/types'
import { sideFromSnapshot, type VersionFile, type VersionSide } from './comparison'
import type { ConfirmedWorkspace, SnapshotView } from './workspaceContracts'

/**
 * 只读版本比较的**来源装配**（05）。
 *
 * 比较两侧必须落在同一个身份键空间里，否则同名重建的两个实例会被路径撮合成一行，
 * 把旧引用显示成新实例。装配规则只有一条：
 *
 * - 服务侧（快照、确认作品）的身份是服务 fileId，先按本机实例映射换成本机实例 ID；
 *   映射不到的**保持服务 fileId 原样**——它在另一侧没有对应实例，就应该单列，
 *   而不是按路径去找一个"看起来一样"的实例来顶替。
 * - 本机侧（草稿）的身份本来就是本机实例 ID。
 *
 * 路径只用于显示，从不参与对齐。本模块全是纯读取：不请求、不写草稿、不改摘要，
 * 正文一律原样传递（BOM/CRLF/裸 CR 与非 BMP 字符不做任何规范化）。
 */

/** 服务 fileId → 本机实例 ID；只取已知映射，不猜、不按路径推。 */
export function instanceKeys(files: ProjectFile[]): Map<string, string> {
  const keys = new Map<string, string>()
  for (const file of files) {
    if (file.serverFileId && !keys.has(file.serverFileId)) keys.set(file.serverFileId, file.fileId)
  }
  return keys
}

function localKey(fileId: string, keys: Map<string, string>): string {
  return keys.get(fileId) ?? fileId
}

/** 快照一侧：身份换成同一键空间，其余逐字保留。 */
export function snapshotSide(snapshot: SnapshotView, keys: Map<string, string>): VersionSide {
  const side = sideFromSnapshot(snapshot)
  return { ...side, files: side.files.map(file => ({ ...file, fileId: localKey(file.fileId, keys) })) }
}

/** 当前确认作品一侧：含已回收实例（回收是状态，不是消失）。 */
export function confirmedSide(workspace: ConfirmedWorkspace, keys: Map<string, string>): VersionSide {
  return {
    label: `确认作品 v${workspace.workspaceRevision}`,
    revision: workspace.workspaceRevision,
    files: workspace.files.map<VersionFile>(file => ({ fileId: localKey(file.fileId, keys), path: file.path,
      documentVersion: file.documentVersion, contentHash: file.contentHash, text: file.text, lifecycle: file.lifecycle })),
  }
}

/** 本机草稿一侧：正文是学生当前写的东西；未确认草稿没有服务端摘要，contentHash 为 null。 */
export function draftSide(files: ProjectFile[], draftText: (fileId: string) => string): VersionSide {
  return {
    label: '本机草稿（当前）',
    revision: null,
    files: files.map<VersionFile>(file => ({ fileId: file.fileId, path: file.path,
      documentVersion: file.confirmed ? file.confirmed.version : null, contentHash: null,
      text: draftText(file.fileId) })),
  }
}

export const DRAFT_SOURCE = 'draft'
export const CONFIRMED_SOURCE = 'confirmed'
export const snapshotSourceId = (snapshotId: string) => `snapshot:${snapshotId}`
export const isSnapshotSource = (id: string) => id.startsWith('snapshot:')

export interface VersionSourceOption { id: string; label: string; side: VersionSide }

/**
 * 可选来源：本机草稿、当前确认作品，以及按冻结时间升序的每个快照。
 *
 * 快照按 createdAt 排序（同时间用 ID 兜底），因此"较新/较旧"由服务端时间决定，
 * 不用清单顺序推断，也不依赖快照 ID 的字典序。
 */
export function versionSourceOptions(input: {
  snapshots: SnapshotView[]; workspace: ConfirmedWorkspace | null; files: ProjectFile[]
  draftText: (fileId: string) => string
}): VersionSourceOption[] {
  const keys = instanceKeys(input.files)
  const options: VersionSourceOption[] = [
    { id: DRAFT_SOURCE, label: '本机草稿（当前）', side: draftSide(input.files, input.draftText) },
  ]
  if (input.workspace) {
    options.push({ id: CONFIRMED_SOURCE, label: `当前确认作品 v${input.workspace.workspaceRevision}`,
      side: confirmedSide(input.workspace, keys) })
  }
  const ordered = [...input.snapshots].sort((a, b) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.snapshotId.localeCompare(b.snapshotId))
  for (const snapshot of ordered) {
    options.push({ id: snapshotSourceId(snapshot.snapshotId), label: sideFromSnapshot(snapshot).label,
      side: snapshotSide(snapshot, keys) })
  }
  return options
}

/**
 * 默认比较对象：有两个以上快照时比最近两版；只有一个快照时比「那一版 × 当前草稿」
 * （草稿是学生此刻在改的东西，最容易看出差异）；没有快照时比「确认作品 × 本机草稿」。
 */
export function defaultVersionPair(options: VersionSourceOption[]): { left: string; right: string } {
  const snapshots = options.filter(option => isSnapshotSource(option.id))
  if (snapshots.length >= 2) return { left: snapshots[snapshots.length - 2]!.id, right: snapshots[snapshots.length - 1]!.id }
  if (snapshots.length === 1) return { left: snapshots[0]!.id, right: DRAFT_SOURCE }
  return { left: CONFIRMED_SOURCE, right: DRAFT_SOURCE }
}
