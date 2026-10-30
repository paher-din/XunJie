import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { ProjectAccess, ProjectFile } from '../bridge/types'
import { freezeSync, verifySyncReceipt, type CommandContext, type FrozenCommand, type FrozenDraft } from './frozenCommand'
import { activeFiles, isLifecyclePending, lifecycleProblemMessage, mergedLifecycle, recycleProblem, restoreProblem } from './fileLifecycle'
import type { ConfirmedWorkspace, SyncInput, SyncOperation, WorkspaceFile } from './workspaceContracts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

const context: CommandContext = {
  mode: 'preparation', userId: 'student-1', assignmentId: 'assignment-1', activityVersionId: 'activity-1',
  attemptId: 'attempt-1', preparationEpoch: 'epoch-1', loadEpoch: 1, trustedRecoveryGeneration: 'g1', courseId: 'course-1',
}

function workspaceFile(overrides: Partial<WorkspaceFile> & { fileId: string }): WorkspaceFile {
  const text = overrides.text ?? 'same\n'
  return { attemptId: 'attempt-1', path: 'main.c', documentVersion: 1, lifecycle: 'active', ...overrides, text,
    contentHash: overrides.contentHash ?? hash(text) }
}

const before = (files: WorkspaceFile[], workspaceRevision = 3): ConfirmedWorkspace =>
  ({ attemptId: 'attempt-1', workspaceRevision, files })

const draft = (value: Partial<FrozenDraft> & { localId: string }): FrozenDraft =>
  ({ path: 'main.c', text: '', draftRevision: 1, ...value })

/** 冻结一次保存并取出线上操作；冻结失败时按错误抛出，交给 rejects 断言。 */
async function operationsOf(drafts: FrozenDraft[], files: WorkspaceFile[]): Promise<SyncOperation[]> {
  const frozen = await freezeSync(context, before(files), drafts, 'client-1', 1)
  return (JSON.parse(frozen.wireJson) as SyncInput).operations
}

function receiptOf(frozen: FrozenCommand, metadata: Array<Record<string, unknown>>, workspaceRevision: number) {
  return {
    receiptId: 'receipt-1', commandId: 'command-1', requestHash: frozen.requestHash,
    identity: { actorId: 'student-1', command: 'workspace.sync', target: '/api/attempts/attempt-1/sync',
      scope: { courseId: 'course-1', studentId: 'student-1', attemptId: 'attempt-1' },
      idempotencyKey: frozen.commandKey, recoveryGeneration: 'g1', sync: { clientId: 'client-1', clientSeq: 1 } },
    serverSeq: 1, committedAt: '2026-10-12T00:00:00.000Z', replayed: false,
    result: { workspaceRevision, created: {}, process: { status: 'not_collected' }, files: metadata },
  }
}

describe('freezeSync：期望生命周期 × 确认清单的六种映射', () => {
  it('确认清单里没有这个实例：期望 active 生成 create', async () => {
    const operations = await operationsOf([draft({ localId: 'local-1', text: 'int main(void) {}\n' })], [])
    expect(operations).toEqual([{ kind: 'create', clientFileKey: 'local-1', path: 'main.c', text: 'int main(void) {}\n' }])
  })

  it('确认清单里没有这个实例：期望 recycled 被拒（还没确认过的文件不能回收）', async () => {
    const rejected = operationsOf([draft({ localId: 'local-1', lifecycle: 'recycled' })], [])
    await expect(rejected).rejects.toThrow('还没有确认')
    await expect(operationsOf([draft({ localId: 'local-1', lifecycle: 'recycled' })], [])).rejects.toThrow('不能回收')
  })

  it('已确认且 active：正文相同不产生操作，不同才 update', async () => {
    const files = [workspaceFile({ fileId: 'file-1', text: 'same\n' })]
    await expect(operationsOf([draft({ localId: 'local-1', serverFileId: 'file-1', text: 'same\n' })], files))
      .rejects.toThrow('没有需要确认的修改')
    expect(await operationsOf([draft({ localId: 'local-1', serverFileId: 'file-1', text: 'changed\n' })], files))
      .toEqual([{ kind: 'update', fileId: 'file-1', baseVersion: 1, text: 'changed\n' }])
  })

  it('已确认且 active：期望 recycled 生成 recycle（不带正文）', async () => {
    const files = [workspaceFile({ fileId: 'file-1', documentVersion: 2, text: 'same\n' })]
    expect(await operationsOf([draft({ localId: 'local-1', serverFileId: 'file-1', text: 'draft\n', lifecycle: 'recycled' })], files))
      .toEqual([{ kind: 'recycle', fileId: 'file-1', baseVersion: 2 }])
  })

  it('已确认且 recycled：期望 recycled 跳过', async () => {
    const files = [workspaceFile({ fileId: 'file-1', documentVersion: 2, lifecycle: 'recycled' })]
    await expect(operationsOf([draft({ localId: 'local-1', serverFileId: 'file-1', lifecycle: 'recycled' })], files))
      .rejects.toThrow('没有需要确认的修改')
  })

  it('已确认且 recycled：期望 active 且路径空闲生成 restore（正文只认已确认的那份）', async () => {
    const files = [workspaceFile({ fileId: 'file-1', documentVersion: 2, lifecycle: 'recycled', text: 'old\n' })]
    expect(await operationsOf([draft({ localId: 'local-1', serverFileId: 'file-1', text: 'old\n', lifecycle: 'active' })], files))
      .toEqual([{ kind: 'restore', fileId: 'file-1', baseVersion: 2 }])
  })
})

describe('freezeSync：恢复路径占用与路径名额', () => {
  it('确认清单里同路径的另一个 active 实例占着时拒绝恢复', async () => {
    const files = [
      workspaceFile({ fileId: 'file-old', documentVersion: 2, lifecycle: 'recycled', text: 'old\n' }),
      workspaceFile({ fileId: 'file-new', text: 'new\n' }),
    ]
    await expect(operationsOf([draft({ localId: 'local-old', serverFileId: 'file-old', lifecycle: 'active', text: 'old\n' })], files))
      .rejects.toThrow('恢复路径被占用')
  })

  it('同一批里另一个期望 active 的草稿占着同一路径时拒绝恢复', async () => {
    const files = [workspaceFile({ fileId: 'file-old', documentVersion: 2, lifecycle: 'recycled', text: 'old\n' })]
    const drafts = [
      draft({ localId: 'local-old', serverFileId: 'file-old', lifecycle: 'active', text: 'old\n' }),
      draft({ localId: 'local-new', text: 'new\n' }),
    ]
    await expect(operationsOf(drafts, files)).rejects.toThrow('恢复路径被占用')
  })

  it('同一批先把占用者回收掉时，路径在批结束时是空的，恢复成立', async () => {
    const files = [
      workspaceFile({ fileId: 'file-old', documentVersion: 2, lifecycle: 'recycled', text: 'old\n' }),
      workspaceFile({ fileId: 'file-new', text: 'new\n' }),
    ]
    const drafts = [
      draft({ localId: 'local-old', serverFileId: 'file-old', lifecycle: 'active', text: 'old\n' }),
      draft({ localId: 'local-new', serverFileId: 'file-new', lifecycle: 'recycled', text: 'new\n' }),
    ]
    expect(await operationsOf(drafts, files)).toEqual([
      { kind: 'restore', fileId: 'file-old', baseVersion: 2 },
      { kind: 'recycle', fileId: 'file-new', baseVersion: 1 },
    ])
  })

  it('回收意图不占 active 路径名额：同一批「回收 A + 在 A 的路径上新建 B」合法', async () => {
    const files = [workspaceFile({ fileId: 'file-1', documentVersion: 2, text: 'same\n' })]
    const drafts = [
      draft({ localId: 'local-1', serverFileId: 'file-1', lifecycle: 'recycled', text: 'same\n' }),
      draft({ localId: 'local-2', path: 'main.c', text: 'brand new\n' }),
    ]
    expect(await operationsOf(drafts, files)).toEqual([
      { kind: 'recycle', fileId: 'file-1', baseVersion: 2 },
      { kind: 'create', clientFileKey: 'local-2', path: 'main.c', text: 'brand new\n' },
    ])
  })

  it('恢复的限额按**恢复回来的确认正文**算，不按本机草稿算', async () => {
    // 服务端 restore 不带正文：恢复后文件里就是确认清单那一份。用清空过的本机草稿去预检，
    // 会放行一条服务端必然以 CONTENT_LIMIT 拒绝的命令（而且是可重试码 → 重放还是同一个失败）。
    const big = 'x'.repeat(600_000)
    const files = [
      workspaceFile({ fileId: 'file-active', path: 'a.bin', text: big }),
      workspaceFile({ fileId: 'file-old', path: 'b.bin', documentVersion: 2, lifecycle: 'recycled', text: big }),
    ]
    await expect(operationsOf([
      draft({ localId: 'local-active', serverFileId: 'file-active', path: 'a.bin', text: big }),
      // 学生把 b.bin 的草稿清空过，但它恢复回来的是那 600000 字节
      draft({ localId: 'local-old', serverFileId: 'file-old', path: 'b.bin', text: '', lifecycle: 'active' }),
    ], files)).rejects.toThrow('total-bytes')
  })

  it('同一批里两个期望 active 的草稿仍不能共用路径', async () => {
    const drafts = [draft({ localId: 'local-1', text: 'a\n' }), draft({ localId: 'local-2', text: 'b\n' })]
    await expect(operationsOf(drafts, [])).rejects.toThrow('duplicate')
  })

  it('既有校验与文案保持：归属、路径不符、实例不在确认清单', async () => {
    const files = [workspaceFile({ fileId: 'file-1' })]
    // 归属校验在冻结前同步抛出，不是异步 rejection
    expect(() => freezeSync({ ...context, attemptId: 'attempt-2' }, before(files), [], 'client-1', 1))
      .toThrow('确认作品归属不符')
    await expect(operationsOf([draft({ localId: 'local-1', serverFileId: 'file-1', path: 'other.c' })], files))
      .rejects.toThrow('文件路径不符')
    await expect(operationsOf([draft({ localId: 'local-1', serverFileId: 'file-gone' })], files))
      .rejects.toThrow('原文件实例不在当前确认清单，需要重新比较')
    // 生命周期操作同样受这些校验约束：引用对不上时先让学生重新比较，不猜实例。
    await expect(operationsOf([draft({ localId: 'local-1', serverFileId: 'file-gone', lifecycle: 'recycled' })], files))
      .rejects.toThrow('原文件实例不在当前确认清单，需要重新比较')
  })
})

describe('verifySyncReceipt：生命周期回执核验', () => {
  it('recycle 回执：path/text/contentHash 不变，版本 +1，lifecycle 为 recycled', async () => {
    const files = [workspaceFile({ fileId: 'file-1', documentVersion: 2, text: 'same\n' })]
    const frozen = await freezeSync(context, before(files),
      [draft({ localId: 'local-1', serverFileId: 'file-1', text: 'same\n', lifecycle: 'recycled' })], 'client-1', 1)
    const metadata = { fileId: 'file-1', path: 'main.c', documentVersion: 3, contentHash: hash('same\n'), lifecycle: 'recycled' }
    const verified = await verifySyncReceipt(frozen, receiptOf(frozen, [metadata], 4))
    expect(verified.workspace.files[0]).toMatchObject({ fileId: 'file-1', text: 'same\n', documentVersion: 3, lifecycle: 'recycled' })
    expect(verified.workspace.workspaceRevision).toBe(4)
  })

  it('restore 回执：正文仍是确认正文，版本 +1，lifecycle 为 active', async () => {
    const files = [workspaceFile({ fileId: 'file-1', documentVersion: 2, lifecycle: 'recycled', text: 'old\n' })]
    const frozen = await freezeSync(context, before(files),
      [draft({ localId: 'local-1', serverFileId: 'file-1', lifecycle: 'active', text: 'old\n' })], 'client-1', 1)
    const metadata = { fileId: 'file-1', path: 'main.c', documentVersion: 3, contentHash: hash('old\n'), lifecycle: 'active' }
    const verified = await verifySyncReceipt(frozen, receiptOf(frozen, [metadata], 4))
    expect(verified.workspace.files[0]).toMatchObject({ text: 'old\n', documentVersion: 3, lifecycle: 'active' })
  })

  it('回执与冻结基线不符时逐项被拒：版本、生命周期、路径、正文摘要', async () => {
    const files = [workspaceFile({ fileId: 'file-1', documentVersion: 2, text: 'same\n' })]
    const frozen = await freezeSync(context, before(files),
      [draft({ localId: 'local-1', serverFileId: 'file-1', text: 'same\n', lifecycle: 'recycled' })], 'client-1', 1)
    const metadata = { fileId: 'file-1', path: 'main.c', documentVersion: 3, contentHash: hash('same\n'), lifecycle: 'recycled' }
    await expect(verifySyncReceipt(frozen, receiptOf(frozen, [{ ...metadata, documentVersion: 4 }], 4))).rejects.toThrow('ACK 文件元数据')
    await expect(verifySyncReceipt(frozen, receiptOf(frozen, [{ ...metadata, lifecycle: 'active' }], 4))).rejects.toThrow('ACK 文件元数据')
    await expect(verifySyncReceipt(frozen, receiptOf(frozen, [{ ...metadata, path: 'other.c' }], 4))).rejects.toThrow('ACK 文件元数据')
    // 生命周期操作不带正文：ACK 里正文若被换掉，只能体现在摘要上（正文本身仍取冻结前的那份）。
    await expect(verifySyncReceipt(frozen, receiptOf(frozen, [{ ...metadata, contentHash: hash('changed\n') }], 4))).rejects.toThrow('ACK 文件元数据')
    await expect(verifySyncReceipt(frozen, receiptOf(frozen, [metadata], 5))).rejects.toThrow('ACK 版本')
  })
})

const editable: ProjectAccess = { kind: 'editable' }
const paused: ProjectAccess = { kind: 'paused', reason: '分配或尝试已暂停' }
const readOnly: ProjectAccess = { kind: 'read-only', reason: '作品已进入终态' }

function projectFile(overrides: Partial<ProjectFile> & { fileId: string }): ProjectFile {
  return { path: 'main.c', lifecycle: 'active', confirmed: { text: 'same\n', version: 1, lifecycle: 'active' }, ...overrides }
}

describe('fileLifecycle：判定矩阵', () => {
  it('isLifecyclePending：本机新建与未确认的回收/恢复都算未确认，已一致的回收不算', () => {
    expect(isLifecyclePending(projectFile({ fileId: 'local-1', confirmed: null }))).toBe(true)
    expect(isLifecyclePending(projectFile({ fileId: 'file-1' }))).toBe(false)
    expect(isLifecyclePending(projectFile({ fileId: 'file-1', lifecycle: 'recycled' }))).toBe(true)
    expect(isLifecyclePending(projectFile({ fileId: 'file-1', lifecycle: 'recycled',
      confirmed: { text: 'same\n', version: 1, lifecycle: 'recycled' } }))).toBe(false)
    expect(isLifecyclePending(projectFile({ fileId: 'file-1',
      confirmed: { text: 'same\n', version: 1, lifecycle: 'recycled' } }))).toBe(true)
  })

  it('activeFiles 只留期望 active 的实例', () => {
    const files = [projectFile({ fileId: 'a' }), projectFile({ fileId: 'b', lifecycle: 'recycled' })]
    expect(activeFiles(files).map((f) => f.fileId)).toEqual(['a'])
  })

  it('recycleProblem：状态、确认基线与重复回收', () => {
    expect(recycleProblem(projectFile({ fileId: 'file-1' }), editable)).toBeNull()
    expect(recycleProblem(projectFile({ fileId: 'local-1', confirmed: null }), editable)).toBe('not-confirmed')
    expect(recycleProblem(projectFile({ fileId: 'file-1', lifecycle: 'recycled' }), editable)).toBe('already-recycled')
    expect(recycleProblem(projectFile({ fileId: 'file-1' }), paused)).toBe('not-allowed')
    expect(recycleProblem(projectFile({ fileId: 'file-1' }), readOnly)).toBe('not-allowed')
  })

  it('restoreProblem：占用者来自同路径的另一个期望 active 实例', () => {
    const recycled = projectFile({ fileId: 'file-old', lifecycle: 'recycled',
      confirmed: { text: 'old\n', version: 2, lifecycle: 'recycled' } })
    const occupant = projectFile({ fileId: 'file-new' })
    expect(restoreProblem(recycled, [recycled, occupant], editable)).toEqual({ problem: 'path-occupied', occupant })
    // 同路径但已经回收的实例不占路径
    expect(restoreProblem(recycled, [recycled, projectFile({ fileId: 'file-new', lifecycle: 'recycled' })], editable))
      .toEqual({ problem: null, occupant: null })
    // 已在使用中，不必看占用者
    expect(restoreProblem(projectFile({ fileId: 'file-1' }), [projectFile({ fileId: 'file-new' })], editable))
      .toEqual({ problem: 'already-active', occupant: null })
    // 不能恢复时也不返回占用者：界面不该提示一个不存在的下一步
    expect(restoreProblem(recycled, [recycled, occupant], paused)).toEqual({ problem: 'not-allowed', occupant: null })
    expect(restoreProblem(recycled, [recycled, occupant], readOnly)).toEqual({ problem: 'not-allowed', occupant: null })
  })

  it('lifecycleProblemMessage：每种问题都指向可行动作', () => {
    expect(lifecycleProblemMessage('path-occupied', 'main.c', 'main.c'))
      .toBe('main.c 现在被另一个文件实例占用；先在它那一行回收，才能恢复这个实例。')
    expect(lifecycleProblemMessage('not-confirmed', 'main.c', null)).toBe('这个文件还没有确认保存过，不能回收。')
    expect(lifecycleProblemMessage('already-recycled', 'main.c', null)).toBe('这个实例已经回收了。')
    expect(lifecycleProblemMessage('already-active', 'main.c', null)).toBe('这个实例已经在使用中。')
    expect(lifecycleProblemMessage('not-allowed', 'main.c', null)).toBe('当前作品状态不允许回收或恢复文件实例。')
    expect(lifecycleProblemMessage('not-in-workspace', 'main.c', null)).toContain('不在当前确认作品里')
    expect(lifecycleProblemMessage(null, 'main.c', null)).toBe('')
  })

  it('restoreProblem：确认清单里没有这个实例时不可恢复（放行只会点到一个必被拒绝的动作）', () => {
    const orphan = projectFile({ fileId: 'local-1', lifecycle: 'recycled', confirmed: null })
    expect(restoreProblem(orphan, [orphan], editable)).toEqual({ problem: 'not-in-workspace', occupant: null })
  })
})

describe('mergedLifecycle：一次权威推进后该显示哪一侧的生命周期', () => {
  const active = (over = {}) => projectFile({ fileId: 'file-1', ...over })

  it('权威值没变：保留本页意图（学生刚点过、本机记录还没写完的窗口）', () => {
    // 本页已点回收（lifecycle=recycled），权威仍是 active：这次 head 推进不能把意图抹掉
    expect(mergedLifecycle(active({ lifecycle: 'recycled' }), active())).toBe('recycled')
  })

  it('权威值变了：以权威为准，不把别处刚生效的回收顶回去', () => {
    const recycledByOtherTab = projectFile({ fileId: 'file-1', lifecycle: 'recycled',
      confirmed: { text: 'same\n', version: 2, lifecycle: 'recycled' } })
    // 本页内存里还停在 active（未确认恢复），权威已经是 recycled → 显示 recycled，不写「待确认恢复」
    expect(mergedLifecycle(active(), recycledByOtherTab)).toBe('recycled')
  })

  it('第一次拿到确认基线：以权威为准', () => {
    const confirmed = projectFile({ fileId: 'file-1',
      confirmed: { text: 'same\n', version: 1, lifecycle: 'active' } })
    expect(mergedLifecycle(undefined, confirmed)).toBe('active')
  })
})
