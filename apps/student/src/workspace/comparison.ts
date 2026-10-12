/**
 * 冲突比较的只读视图模型（04A）。
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
import type { ConfirmedWorkspace } from './workspaceContracts'

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
