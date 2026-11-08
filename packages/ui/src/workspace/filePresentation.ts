/** Public display of file identity, intent and confirmed state; no store or persistence. */
export interface WorkspaceFile {
  fileId: string
  /** 服务实例映射；fileId 继续是稳定本机身份，以保留 model/草稿/视图。 */
  serverFileId?: string
  path: string
  /**
   * 学生当前**意图**的生命周期（05）：本机实例记录优先，没有本机记录时取权威 head。
   * 「与最近确认的不一致」就是未确认的回收/恢复，界面如实标注，不冒充已生效。
   */
  lifecycle: 'active' | 'recycled'
  /**
   * 已确认的正文、版本与生命周期；本机新建、还没确认保存的文件为 null。
   * 草稿与它比较得出「未确认修改」——本机草稿与确认作品是两份内容，不共用一个值。
   */
  confirmed: { text: string; version: number; lifecycle: 'active' | 'recycled' } | null
}

/**
 * 工作区可写性。正式版由 Attempt 状态与分配状态决定（暂停时只能继续编辑已有 active 文件，
 * 终态只读）；mock 里逐项目声明，界面按 kind 与 reason 如实显示，不从昵称或本地设置推断权限。
 */
export type WorkspaceAccess =
  | { kind: 'editable' }
  | { kind: 'paused'; reason: string }
  | { kind: 'read-only'; reason: string }


export type ProtectionStatus = 'saving' | 'protected' | 'failed'
export interface DraftProtectionDisplay { status: ProtectionStatus; reason: string | null }

export type LifecycleProblem =
  | 'not-confirmed'
  | 'already-recycled'
  | 'already-active'
  /** 这个实例不在当前确认清单里（还没确认过，或权威已回退到它出现之前）：恢复没有可带回的正文。 */
  | 'not-in-workspace'
  | 'path-occupied'
  | 'not-allowed'
  | null

export function lifecycleProblemMessage(problem: LifecycleProblem, path: string, occupantPath: string | null): string {
  switch (problem) {
    case 'not-confirmed':
      return '这个文件还没有确认保存过，不能回收。'
    case 'not-in-workspace':
      return '这个实例不在当前确认作品里；先重新读取，再决定怎么恢复。'
    case 'already-recycled':
      return '这个实例已经回收了。'
    case 'already-active':
      return '这个实例已经在使用中。'
    case 'path-occupied':
      // 学生要腾空的是自己这一行；占用者路径只在拿不到实例路径时兜底（正常情况下两者同值）。
      return `${path || occupantPath || ''} 现在被另一个文件实例占用；先在它那一行回收，才能恢复这个实例。`
    case 'not-allowed':
      return '当前作品状态不允许回收或恢复文件实例。'
    default:
      return ''
  }
}
