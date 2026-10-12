import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  canReplay,
  classifyWriteFailure,
  outcomeMessage,
  reconcileStoredCommand,
  summarizeOriginalRequest,
} from './recovery'
import { CommandConfirmedError, CommandRejectedError, LeaseHeldError } from './confirmationDb'
import { WorkspaceRequestError } from './http'
import type { ApiErrorCode } from './contracts'
import type { CommandContext, FrozenCommand, OutboxRecord } from './frozenCommand'

const context: CommandContext = { mode: 'preparation', userId: 'student-1', assignmentId: 'assignment-1',
  activityVersionId: 'activity-1', attemptId: 'attempt-1', preparationEpoch: 'epoch-1', loadEpoch: 1,
  trustedRecoveryGeneration: 'g1', courseId: 'course-1', scenarioId: 'scene-1' }

const syncBody = JSON.stringify({ recoveryGeneration: 'g1', expectedWorkspaceRevision: 3,
  clientId: 'client-1', clientSeq: 7, operations: [{ kind: 'create', clientFileKey: 'local-1', path: 'main.c', text: 'int main(void){}\n' }] })

function command(overrides: Partial<FrozenCommand> = {}): FrozenCommand {
  return { commandKey: 'key-1', context, kind: 'workspace.sync', path: '/attempts/attempt-1/sync',
    target: '/api/attempts/attempt-1/sync', wireJson: syncBody, requestHash: 'hash-1', createdAt: 5,
    before: null, drafts: [{ localId: 'local-1', path: 'main.c', text: 'int main(void){}\n', draftRevision: 1 }],
    ...overrides }
}
function record(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return { ...command(), state: 'pending', ...overrides }
}
const apiError = (code: ApiErrorCode) => new WorkspaceRequestError(
  { kind: 'api', status: 409, requestId: 'request-1', error: { code, message: code, retryable: false, recovery: 'x' } },
  'POST', '/api/attempts/attempt-1/sync')

describe('写失败分类：不把超时当拒绝或成功', () => {
  it('拿不到服务端信封是「未知」而不是拒绝', () => {
    expect(classifyWriteFailure(new WorkspaceRequestError({ kind: 'transport', message: 'Failed to fetch' }, 'POST', '/x'), { receiptReceived: false }))
      .toEqual({ kind: 'unresolved' })
    expect(classifyWriteFailure(new WorkspaceRequestError({ kind: 'protocol', status: 502, message: '不是 JSON' }, 'POST', '/x'), { receiptReceived: false }))
      .toEqual({ kind: 'unresolved' })
  })
  it('VERSION_CONFLICT 与 RECOVERY_REQUIRED 各自单列，其余错误码如实保留', () => {
    expect(classifyWriteFailure(apiError('VERSION_CONFLICT'), { receiptReceived: false })).toEqual({ kind: 'conflict' })
    expect(classifyWriteFailure(apiError('RECOVERY_REQUIRED'), { receiptReceived: false })).toEqual({ kind: 'recovery-required' })
    expect(classifyWriteFailure(apiError('FORBIDDEN'), { receiptReceived: false })).toEqual({ kind: 'rejected', code: 'FORBIDDEN' })
    expect(classifyWriteFailure(apiError('IDEMPOTENCY_CONFLICT'), { receiptReceived: false }))
      .toEqual({ kind: 'rejected', code: 'IDEMPOTENCY_CONFLICT' })
  })
  it('已收到回执之后的失败只算本机确认未完成', () => {
    expect(classifyWriteFailure(new Error('本机确认事务中断：head'), { receiptReceived: true })).toEqual({ kind: 'local-failed' })
  })
  it('另一标签持有发送租约时不当作原请求失败', () => {
    expect(classifyWriteFailure(new LeaseHeldError(), { receiptReceived: false })).toEqual({ kind: 'lease-held' })
  })
  it('本机事务里读到的已确认/已拒绝事实优先于网络结论', () => {
    expect(classifyWriteFailure(new CommandConfirmedError(), { receiptReceived: false })).toEqual({ kind: 'confirmed' })
    expect(classifyWriteFailure(new CommandRejectedError('VERSION_CONFLICT'), { receiptReceived: false })).toEqual({ kind: 'conflict' })
    expect(classifyWriteFailure(new CommandRejectedError('RECOVERY_REQUIRED'), { receiptReceived: false })).toEqual({ kind: 'recovery-required' })
    expect(classifyWriteFailure(new CommandRejectedError('IDEMPOTENCY_CONFLICT'), { receiptReceived: false }))
      .toEqual({ kind: 'rejected', code: 'IDEMPOTENCY_CONFLICT' })
  })
})

describe('重试许可', () => {
  it('未知、本机未确认、租约占用与可重试的拒绝都能核对；终态结论不重发', () => {
    expect(canReplay({ kind: 'unresolved' })).toBe(true)
    expect(canReplay({ kind: 'local-failed' })).toBe(true)
    // 租约被另一标签占用只是「现在抢不到」，租约到期后学生仍应能核对同一原命令。
    expect(canReplay({ kind: 'lease-held' })).toBe(true)
    // 限流、依赖/持久化不可用、未认证等按服务端 recovery 提示就是「先核对再显式重试」。
    for (const code of ['FORBIDDEN', 'RATE_LIMITED', 'DEPENDENCY_UNAVAILABLE', 'PERSISTENCE_UNAVAILABLE', 'UNAUTHENTICATED'] as const) {
      expect(canReplay({ kind: 'rejected', code })).toBe(true)
    }
    for (const outcome of [
      { kind: 'conflict' as const },
      { kind: 'recovery-required' as const },
      { kind: 'rejected' as const, code: 'IDEMPOTENCY_CONFLICT' as const },
      { kind: 'confirmed' as const },
      { kind: 'historical' as const },
    ]) expect(canReplay(outcome)).toBe(false)
    expect(canReplay(null)).toBe(false)
  })
  it('每种结论都给出可核对的下一步说明，可重试与终态说清区别', () => {
    for (const outcome of [{ kind: 'unresolved' as const }, { kind: 'local-failed' as const }, { kind: 'conflict' as const },
      { kind: 'recovery-required' as const }, { kind: 'rejected' as const, code: 'FORBIDDEN' as const },
      { kind: 'rejected' as const, code: 'IDEMPOTENCY_CONFLICT' as const },
      { kind: 'lease-held' as const }, { kind: 'confirmed' as const }, { kind: 'historical' as const }]) {
      expect(outcomeMessage(outcome).length).toBeGreaterThan(8)
    }
    expect(outcomeMessage({ kind: 'rejected', code: 'RATE_LIMITED' })).toContain('明确重试')
    expect(outcomeMessage({ kind: 'rejected', code: 'IDEMPOTENCY_CONFLICT' })).toContain('同一键')
  })
})

describe('原命令核对结论', () => {
  it('没有原记录时不重发也不新建', () => {
    expect(reconcileStoredCommand(null, context)).toEqual({ action: 'none' })
  })
  it('同一代际的未决原命令可核对或重放', () => {
    expect(reconcileStoredCommand(record(), context, { owner: 'tab-a', now: 10 })).toEqual({ action: 'replay' })
    expect(reconcileStoredCommand(record({ lease: { owner: 'tab-a', until: 1000 } }), context, { owner: 'tab-a', now: 10 }))
      .toEqual({ action: 'replay' })
  })
  it('已确认的原命令不重发，只在本机重新接纳同一回执', () => {
    const confirmed = record({ state: 'confirmed', receipt: { receiptId: 'r1' } as never })
    expect(reconcileStoredCommand(confirmed, context, { owner: 'tab-a', now: 10 })).toEqual({ action: 'accept-local' })
  })
  it('变更受信代际后停止旧重试，只保留事实', () => {
    const older = record({ context: { ...context, trustedRecoveryGeneration: 'g0' } })
    expect(reconcileStoredCommand(older, context, { owner: 'tab-a', now: 10 }))
      .toEqual({ action: 'stop', outcome: { kind: 'recovery-required' } })
  })
  it('另一标签持有未过期租约时不重发', () => {
    expect(reconcileStoredCommand(record({ lease: { owner: 'tab-b', until: 100 } }), context, { owner: 'tab-a', now: 10 }))
      .toEqual({ action: 'stop', outcome: { kind: 'lease-held' } })
    expect(reconcileStoredCommand(record({ lease: { owner: 'tab-b', until: 5 } }), context, { owner: 'tab-a', now: 10 }))
      .toEqual({ action: 'replay' })
  })
  it('重放不能解决的拒绝才停手，可重试的拒绝保留原命令', () => {
    expect(reconcileStoredCommand(record({ rejected: { code: 'VERSION_CONFLICT', at: 1 } }), context, { owner: 'tab-a', now: 10 }))
      .toEqual({ action: 'stop', outcome: { kind: 'conflict' } })
    expect(reconcileStoredCommand(record({ rejected: { code: 'RECOVERY_REQUIRED', at: 1 } }), context, { owner: 'tab-a', now: 10 }))
      .toEqual({ action: 'stop', outcome: { kind: 'recovery-required' } })
    expect(reconcileStoredCommand(record({ rejected: { code: 'IDEMPOTENCY_CONFLICT', at: 1 } }), context, { owner: 'tab-a', now: 10 }))
      .toEqual({ action: 'stop', outcome: { kind: 'rejected', code: 'IDEMPOTENCY_CONFLICT' } })
    // 暂时性拒绝（限流/依赖不可用/未认证）不能把工作区永久封死：保留事实但可明确重试。
    for (const code of ['RATE_LIMITED', 'DEPENDENCY_UNAVAILABLE', 'UNAUTHENTICATED'] as const) {
      expect(reconcileStoredCommand(record({ rejected: { code, at: 1 } }), context, { owner: 'tab-a', now: 10 }))
        .toEqual({ action: 'replay' })
    }
  })
  it('切换账号/模式/Attempt 后的旧原命令不回灌，也不重放', () => {
    for (const changed of [{ userId: 'other-student' }, { attemptId: 'attempt-2' },
      { mode: 'real' as const }, { assignmentId: 'assignment-2' }] as const) {
      const stored = record({ context: { ...context, ...changed } })
      expect(reconcileStoredCommand(stored, context, { owner: 'tab-a', now: 10 }))
        .toEqual({ action: 'stop', outcome: { kind: 'recovery-required' } })
    }
  })
  it('旧代际回执只留历史事实', () => {
    expect(reconcileStoredCommand(record({ state: 'historical', receipt: { receiptId: 'r1' } as never }), context, { owner: 'tab-a', now: 10 }))
      .toEqual({ action: 'stop', outcome: { kind: 'historical' } })
  })
})

describe('冻结原请求的可核对事实', () => {
  it('sync 给出键/序号/代际/预期版本与冻结正文摘要', async () => {
    const summary = await summarizeOriginalRequest(command())
    expect(summary.commandKey).toBe('key-1')
    expect(summary.kind).toBe('workspace.sync')
    expect(summary.clientId).toBe('client-1')
    expect(summary.clientSeq).toBe(7)
    expect(summary.expectedWorkspaceRevision).toBe(3)
    expect(summary.recoveryGeneration).toBe('g1')
    expect(summary.files).toEqual([{ label: 'main.c', bytes: 17,
      hash: createHash('sha256').update('int main(void){}\n', 'utf8').digest('hex') }])
  })
  it('首次创建命令不编造版本与文件', async () => {
    const summary = await summarizeOriginalRequest(command({ kind: 'attempt.create', path: '/assignments/assignment-1/attempts',
      target: 'assignment-1', wireJson: JSON.stringify({ recoveryGeneration: 'g1' }), drafts: [] }))
    expect(summary.clientId).toBeUndefined()
    expect(summary.expectedWorkspaceRevision).toBeUndefined()
    expect(summary.files).toEqual([])
  })
})
