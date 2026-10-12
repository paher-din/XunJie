import { describe, expect, it } from 'vitest'
import { projectSeedOf } from './useConfirmationWorkspace'
import type { ConfirmationState } from './confirmationWorkspace'
import type { InstanceRecord } from '../lib/draftStore'
import type { WorkspaceFile } from './workspaceContracts'

const scope = 'preparation\0student-1\0attempt-1'
const key = (localId: string) => `${scope}\0${localId}`

function file(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return { fileId: 'server-1', attemptId: 'attempt-1', path: 'main.c', documentVersion: 1, text: 'int main(void)\n',
    contentHash: 'hash-1', lifecycle: 'active', ...overrides }
}
function instance(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return { clientFileKey: key('local-1'), fileId: 'local-1', path: 'main.c', createdAt: 1, lifecycle: 'active', ...overrides }
}
function state(files: WorkspaceFile[], workspaceRevision = 1): ConfirmationState {
  return { phase: 'ready', workspace: { attemptId: 'attempt-1', workspaceRevision, files }, attempt: null,
    snapshot: null, pending: null, outcome: null, error: null }
}

describe('恢复草稿的实例关联', () => {
  it('丢 ACK 后刷新：同一路径的未映射本机实例仍是这份正文的来源，草稿可继续打开', () => {
    const seed = projectSeedOf(state([file()]), [instance()], 'task-1', true)!
    expect(seed.files).toHaveLength(1)
    // 身份仍是本机实例（草稿按它保存），服务端 fileId 单独保留，不冒充已映射
    expect(seed.files[0]!.fileId).toBe('local-1')
    expect(seed.files[0]!.serverFileId).toBe('server-1')
    expect(seed.files[0]!.confirmed).toEqual({ text: 'int main(void)\n', version: 1 })
  })

  it('已映射的实例按 fileId 关联，不受同路径影响', () => {
    const mapped = instance({ fileId: 'server-1' })
    const seed = projectSeedOf(state([file()]), [mapped], 'task-1', true)!
    expect(seed.files.map(f => f.fileId)).toEqual(['local-1'])
    expect(seed.files[0]!.serverFileId).toBe('server-1')
  })

  it('服务端没有该文件时本机实例仍以未确认文件加入，不被关联吞掉', () => {
    const seed = projectSeedOf(state([]), [instance()], 'task-1', true)!
    expect(seed.files).toHaveLength(1)
    expect(seed.files[0]).toMatchObject({ fileId: 'local-1', serverFileId: undefined, confirmed: null })
  })

  it('同路径存在多个未映射实例时不猜：不关联任何实例，避免把草稿挂错', () => {
    const first = instance({ clientFileKey: key('local-1'), fileId: 'local-1' })
    const second = instance({ clientFileKey: key('local-2'), fileId: 'local-2' })
    const seed = projectSeedOf(state([file()]), [first, second], 'task-1', true)!
    // 确认正文按服务端 fileId 打开；两个本机实例仍作为各自的草稿保留，谁都不吞掉谁
    expect(seed.files.map(f => f.fileId)).toEqual(['server-1', 'local-1', 'local-2'])
    expect(seed.files[0]!.confirmed).toEqual({ text: 'int main(void)\n', version: 1 })
    expect(seed.files[1]!.confirmed).toBeNull()
  })

  it('同路径已回收实例不占用本机活动实例，活动文件只关联一次', () => {
    const recycled = file({ fileId: 'server-old', documentVersion: 2, lifecycle: 'recycled' })
    const active = file({ fileId: 'server-new' })
    const seed = projectSeedOf(state([active, recycled]), [instance()], 'task-1', true)!
    expect(seed.files.find(f => f.serverFileId === 'server-new')!.fileId).toBe('local-1')
    // 回收实例不与本机活动实例抢同一身份
    expect(seed.files.find(f => f.serverFileId === 'server-old')!.fileId).toBe('server-old')
  })
})
