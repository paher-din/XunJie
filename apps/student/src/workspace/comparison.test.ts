import { describe, expect, it } from 'vitest'
import { buildWorkspaceComparison } from './comparison'
import type { OutboxRecord } from './frozenCommand'
import type { ConfirmedWorkspace, WorkspaceFile } from './workspaceContracts'

function file(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return { fileId: 'server-1', attemptId: 'attempt-1', path: 'main.c', documentVersion: 1, text: 'baseline\n',
    contentHash: 'hash-1', lifecycle: 'active', ...overrides }
}
function workspace(files: WorkspaceFile[], workspaceRevision = 2): ConfirmedWorkspace {
  return { attemptId: 'attempt-1', workspaceRevision, files }
}
function command(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    commandKey: 'cmd-1', context: { mode: 'preparation', userId: 'u1', courseId: 'c1', assignmentId: 'a1',
      activityVersionId: 'v1', attemptId: 'attempt-1', preparationEpoch: 'epoch-1', loadEpoch: 1,
      trustedRecoveryGeneration: 'g1' },
    kind: 'workspace.sync', path: '/attempts/attempt-1/sync', target: '/api/attempts/attempt-1/sync',
    wireJson: '{}', requestHash: 'h', createdAt: 1, before: workspace([file()], 1),
    drafts: [{ localId: 'local-1', path: 'main.c', text: 'mine\n', draftRevision: 1, serverFileId: 'server-1' }],
    state: 'pending', ...overrides,
  }
}

describe('冲突比较视图模型', () => {
  it('版本冲突：本机原文、原确认基线与当前 head 的服务正文各自独立', () => {
    const head = workspace([file({ text: 'service\n', documentVersion: 2 })])
    const view = buildWorkspaceComparison(command(), head, 'version-conflict')
    expect(view.files).toHaveLength(1)
    expect(view.files[0]).toEqual({ path: 'main.c', localId: 'local-1', mine: 'mine\n', base: 'baseline\n', theirs: 'service\n' })
  })

  it('本机新建的文件：基线与服务端都还没有时为 null，不编造正文', () => {
    const cmd = command({ drafts: [{ localId: 'local-2', path: 'new.c', text: 'created\n', draftRevision: 1 }] })
    const view = buildWorkspaceComparison(cmd, workspace([]), 'version-conflict')
    expect(view.files[0]).toEqual({ path: 'new.c', localId: 'local-2', mine: 'created\n', base: null, theirs: null })
  })

  it('update 按 serverFileId 匹配，路径不同的同名文件不会串正文', () => {
    const head = workspace([file({ fileId: 'server-1', path: 'renamed.c', text: 'service\n' }),
      file({ fileId: 'server-2', path: 'main.c', text: 'other\n' })])
    const view = buildWorkspaceComparison(command(), head, 'version-conflict')
    expect(view.files[0]!.theirs).toBe('service\n')
  })

  it('多个文件逐个比较；head 尚未读取时不编造服务正文', () => {
    const cmd = command({ drafts: [
      { localId: 'local-1', path: 'main.c', text: 'mine\n', draftRevision: 1, serverFileId: 'server-1' },
      { localId: 'local-2', path: 'util.c', text: 'util\n', draftRevision: 3 }] })
    const view = buildWorkspaceComparison(cmd, null, 'unresolved')
    expect(view.source).toBe('unresolved')
    expect(view.files.map(f => f.theirs)).toEqual([null, null])
    expect(view.files[1]!.base).toBe(null)
  })

  it('旧代际恢复比较：冻结正文与重读后的新上下文可比，基线保留', () => {
    const view = buildWorkspaceComparison(command(), workspace([file({ text: 'recovered\n', documentVersion: 3 })]), 'recovery')
    expect(view.source).toBe('recovery')
    expect(view.files[0]).toMatchObject({ mine: 'mine\n', base: 'baseline\n', theirs: 'recovered\n' })
  })
})
