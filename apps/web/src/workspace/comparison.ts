/**
 * 冲突比较的只读视图模型（04A）与只读版本比较（05）。
 *
 * 三个正文都来自落盘事实，不在这里构造或改写：
 * - 本机原文（mine）：outbox 里冻结原命令的草稿正文；
 * - 原确认基线（base）：同一条原命令的 `before` 确认作品正文；
 * - 新服务正文（theirs）：比较打开时重读的当前获准 head 正文。
 *
 * 比较是只读投影；学生明确选择之后由 useProjectWorkspace（写回本机草稿）与
 * ConfirmationWorkspace（退役冲突原命令）落库，这里不做任何写操作。
 */

import type { OutboxRecord } from './frozenCommand'
import type { ConfirmedWorkspace, SnapshotView } from './workspaceContracts'

/** 比较来源：同代际版本冲突 / 旧代际恢复比较 / 旧代际结果未知的比较。 */
export type ComparisonSource = 'version-conflict' | 'recovery' | 'unresolved'

export interface ComparisonFile {
  path: string
  /** 本机实例 ID：学生选择后把对应正文写回草稿时使用。 */
  localId: string
  /** 本机原文：当时冻结并尝试保存的正文。 */
  mine: string
  /** 原确认基线：命令发出前该文件的确认正文；当时还不存在则为 null。 */
  base: string | null
  /** 新服务正文：当前 head 中该文件的正文；服务端还没有这个文件则为 null（例如将新建）。 */
  theirs: string | null
}

export interface WorkspaceComparison {
  commandKey: string
  source: ComparisonSource
  files: ComparisonFile[]
}

/**
 * head 中找同文件：优先按服务端 fileId（update 操作总是带），否则按活动路径
 * （create 的文件服务端可能已由别处建立）。按路径匹配只用于只读展示，不建立映射。
 */
function matchingFile(workspace: ConfirmedWorkspace, serverFileId: string | undefined, path: string) {
  return workspace.files.find(f => f.fileId === serverFileId) ??
    workspace.files.find(f => f.lifecycle === 'active' && f.path === path) ?? null
}

export function buildWorkspaceComparison(command: OutboxRecord, head: ConfirmedWorkspace | null,
  source: ComparisonSource): WorkspaceComparison {
  return {
    commandKey: command.commandKey,
    source,
    files: command.drafts.map(draft => {
      const baseFile = command.before ? matchingFile(command.before, draft.serverFileId, draft.path) : null
      const theirsFile = head ? matchingFile(head, draft.serverFileId, draft.path) : null
      return { path: draft.path, localId: draft.localId, mine: draft.text,
        base: baseFile ? baseFile.text : null, theirs: theirsFile ? theirsFile.text : null }
    }),
  }
}

/*
 * 05：只读版本比较（快照×快照、本机草稿×确认作品）。
 *
 * 每一行只按 **fileId** 对齐，不按路径：同名重建得到的是新 fileId，绝不能因为路径相同
 * 就当成旧引用合并；路径只出现在展示里，不是身份。投影本身不改任何东西——正文直接取自
 * 调用方已经核验过的快照/确认作品/本机草稿，不规范化 EOL 与 BOM、不重算摘要、不发请求、
 * 不改源 model，也不写草稿或存储。
 *
 * 两侧的身份键必须由调用方映射到同一键空间（本机实例 ID 对服务端 fileId）：这里不猜
 * 哪两个实例是同一个，也不替调用方做映射。
 */

/** 一侧里的一个文件实例；documentVersion/contentHash 是读数，本机草稿尚未确认时为 null。 */
export interface VersionFile {
  fileId: string
  path: string
  documentVersion: number | null
  contentHash: string | null
  text: string
  /**
   * 这一侧记录的实例生命周期。只有**权威事实**才带它（当前确认作品）；快照清单本身没有 lifecycle，
   * 本机草稿侧的生命周期是意图而不是事实，两者都留空——比较只回答「这一侧是什么」，不替学生猜。
   * 回收后的实例仍会出现在当前确认作品里（回收是状态不是删除），这一行因此要能说明它被回收了。
   */
  lifecycle?: 'active' | 'recycled'
}

export interface VersionSide {
  label: string
  revision: number | null
  files: VersionFile[]
}

/** 快照之间的比较，还是本机草稿与最近确认作品的比较。 */
export type VersionSource = 'snapshots' | 'draft-confirmed'

export interface VersionRow {
  key: string
  fileId: string
  path: string
  left: VersionFile | null
  right: VersionFile | null
}

export interface VersionComparison {
  kind: 'versions'
  source: VersionSource
  leftLabel: string
  rightLabel: string
  rows: VersionRow[]
  /** 两侧都有且原文不同、或只有一侧有的行数。 */
  changedCount: number
}

export function buildVersionComparison(source: VersionSource, left: VersionSide, right: VersionSide): VersionComparison {
  const rightById = new Map<string, VersionFile>()
  for (const file of right.files) {
    // 同一 fileId 在快照清单里只应出现一次；真出现重复时保留第一条，避免同一身份出两行
    if (!rightById.has(file.fileId)) rightById.set(file.fileId, file)
  }
  const rows: VersionRow[] = []
  const seen = new Set<string>()
  // 行序 = 左侧顺序，再接只在右侧出现的（按右侧顺序），保证同一输入重复调用结果一致
  for (const leftFile of left.files) {
    const rightFile = rightById.get(leftFile.fileId) ?? null
    seen.add(leftFile.fileId)
    rows.push(versionRow(leftFile.fileId, leftFile.path, leftFile, rightFile))
  }
  for (const rightFile of right.files) {
    if (seen.has(rightFile.fileId)) continue
    seen.add(rightFile.fileId)
    rows.push(versionRow(rightFile.fileId, rightFile.path, null, rightFile))
  }
  return {
    kind: 'versions', source, leftLabel: left.label, rightLabel: right.label, rows,
    changedCount: rows.filter(changedRow).length,
  }
}

/** 行的 path 取有正文那一侧的路径：两侧都有时以左侧为主，右侧路径在组件里另外显示。 */
function versionRow(fileId: string, path: string, left: VersionFile | null, right: VersionFile | null): VersionRow {
  return { key: fileId, fileId, path, left, right }
}

/** 路径不是身份：同一 fileId 两侧路径不同时各自保留，正文相同就算没变化。 */
function changedRow(row: VersionRow): boolean {
  if (row.left === null || row.right === null) return true
  return row.left.text !== row.right.text
}

/** 快照 → 一侧；身份是快照里的 fileId（旧快照/运行引用同一身份）。 */
export function sideFromSnapshot(snapshot: SnapshotView): VersionSide {
  return {
    label: `快照 v${snapshot.workspaceRevision}`,
    revision: snapshot.workspaceRevision,
    files: snapshot.files.map(file => ({
      fileId: file.fileId, path: file.path, documentVersion: file.documentVersion,
      contentHash: file.contentHash, text: file.text,
    })),
  }
}
