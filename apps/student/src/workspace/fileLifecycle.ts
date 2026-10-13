import type { ProjectAccess, ProjectFile } from '../bridge/types'

/**
 * 文件实例的生命周期判定（纯函数）。
 *
 * 学生的回收/恢复只表达**本机意图**（`ProjectFile.lifecycle`），真正的业务命令仍由「确认保存」
 * 按 03 的冻结 outbox 发出。所以这里只回答「这次点得动吗、为什么点不动」，不落盘、不发请求。
 * 「未确认」的依据是意图与**最近确认**不一致（含本机新建），不是草稿正文有没有改过。
 */

export type LifecycleProblem =
  | 'not-confirmed'
  | 'already-recycled'
  | 'already-active'
  /** 这个实例不在当前确认清单里（还没确认过，或权威已回退到它出现之前）：恢复没有可带回的正文。 */
  | 'not-in-workspace'
  | 'path-occupied'
  | 'not-allowed'
  | null

/** 这个实例的期望生命周期与最近确认的不一致（含本机新建）：界面标「未确认」。 */
export function isLifecyclePending(file: ProjectFile): boolean {
  // 本机新建还没有确认基线，谈不上「已生效」，一律算未确认。
  if (file.confirmed === null) return true
  return file.confirmed.lifecycle !== file.lifecycle
}

/** 回收能否进行；不能时给出原因码。 */
export function recycleProblem(file: ProjectFile, access: ProjectAccess): LifecycleProblem {
  if (access.kind !== 'editable') return 'not-allowed'
  // 回收的对象是服务端已确认的实例；没有确认基线的本机新建在服务端还不存在，回收无从谈起。
  if (file.confirmed === null) return 'not-confirmed'
  if (file.lifecycle === 'recycled') return 'already-recycled'
  return null
}

/**
 * 恢复能否进行；occupant 是占用该路径的另一个期望 active 实例。
 *
 * 被占用时只拒绝：不覆盖、不改名、不顺手回收占用者——服务端在整批应用后校验同一路径的
 * active 唯一性，客户端的正确做法是让学生先去占用者那一行明确回收。
 */
export function restoreProblem(file: ProjectFile, files: ProjectFile[], access: ProjectAccess):
  { problem: LifecycleProblem; occupant: ProjectFile | null } {
  if (access.kind !== 'editable') return { problem: 'not-allowed', occupant: null }
  if (file.lifecycle === 'active') return { problem: 'already-active', occupant: null }
  // 与回收对称：没有确认基线就没有可恢复的对象。此处放行只会让学生点到一个必然被冻结层拒绝的入口，
  // 还会把「实例不在确认清单」误报成草稿保护失败。
  if (file.confirmed === null) return { problem: 'not-in-workspace', occupant: null }
  const occupant = files.find(f => f.fileId !== file.fileId && f.path === file.path && f.lifecycle === 'active') ?? null
  return occupant ? { problem: 'path-occupied', occupant } : { problem: null, occupant: null }
}

/** 项目里所有期望 active 的实例（含待确认回收/恢复后的投影状态）。 */
export function activeFiles(files: ProjectFile[]): ProjectFile[] {
  return files.filter(file => file.lifecycle === 'active')
}

/**
 * 一次权威确认头推进后，某个实例该显示的生命周期。
 *
 * 只看**权威值有没有变**，不看本机记过什么：
 * - 变了（另一标签回收/恢复并确认，或本页这次确认刚落地）：以权威为准。否则本机残留的旧意图会把
 *   别处刚生效的变更顶回去，学生按「确认保存」就会静默撤销别人的操作；
 * - 没变：保留本页正在表达的生命周期。学生点过回收/恢复、本机记录还没写完的窗口里，这次推进读到的
 *   仍是旧权威，不能拿它把意图抹掉。
 */
export function mergedLifecycle(
  previous: ProjectFile | undefined,
  incoming: ProjectFile,
): 'active' | 'recycled' {
  if (previous === undefined) return incoming.lifecycle
  return previous.confirmed?.lifecycle === incoming.confirmed?.lifecycle ? previous.lifecycle : incoming.lifecycle
}

/** 生命周期被拒时的界面说明；与 `problemMessage` 同一风格：说清为什么不行、怎样才行。 */
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
