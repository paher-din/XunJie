/** Read-only display models; identity mapping, reads and commands belong to the caller. */
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
