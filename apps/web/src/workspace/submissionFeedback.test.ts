import { describe, expect, it } from 'vitest'
import { freezeSubmissionCommand, SubmissionFeedbackWorkspace, verifyFeedbackView, verifySubmissionReceipt,
  verifySubmissionRecovery, type FeedbackView, type SubmissionCommand, type SubmissionJournal, type SubmissionRecovery } from './submissionFeedback'
import type { CommandContext } from './frozenCommand'
import type { AttemptView, Receipt, SnapshotView, WorkspaceHead } from './workspaceContracts'
import { textHash } from './confirmation'
import { WorkspaceRequestError } from './http'

const context: CommandContext = { mode: 'real', userId: 'student', courseId: 'course', assignmentId: 'assignment',
  activityVersionId: 'activity', attemptId: 'attempt', trustedRecoveryGeneration: 'generation', preparationEpoch: null, loadEpoch: 1 }
const attempt = (): AttemptView => ({ attemptId: 'attempt', courseId: 'course', studentId: 'student', assignmentId: 'assignment',
  activityVersionId: 'activity', status: 'active', attemptRevision: 3, workspaceRevision: 2, decisionEpoch: 4, captureRevision: 0,
  collecting: false, reminders: false })
const snapshot = (): SnapshotView => ({ snapshotId: 'snapshot', attemptId: 'attempt', activityVersionId: 'activity', workspaceRevision: 2,
  hashFormat: 'sha256-manifest-v1', hash: 'a'.repeat(64), files: [], createdAt: '2026-10-15T00:00:00.000Z' })
const recovery = (): SubmissionRecovery => ({ attempt: attempt(), recoveryGeneration: 'generation', resyncRequired: false,
  submissions: [], reopen: { state: 'none', actionable: false }, runs: [
    { runId: 'check-failed', snapshotId: 'snapshot', mode: 'check', outcome: 'failed' },
    { runId: 'check-older', snapshotId: 'older-snapshot', mode: 'check', outcome: 'confirmed' },
    { runId: 'ordinary-run', snapshotId: 'snapshot', mode: 'run', outcome: 'confirmed' }],
  feedback: { status: 'available', feedbackRevision: 0, entries: [] } })
const receipt = (command: SubmissionCommand): Receipt => ({ receiptId: 'receipt', commandId: 'command', requestHash: command.requestHash,
  serverSeq: 10, committedAt: '2026-10-15T00:01:00.000Z', replayed: false,
  identity: { actorId: 'student', command: command.kind === 'submit' ? 'submission.create' : 'attempt.control', target: command.target,
    idempotencyKey: command.commandKey, recoveryGeneration: 'generation', scope: { courseId: 'course', studentId: 'student', attemptId: 'attempt' } },
  result: command.kind === 'submit' ? { submissionId: 'submission', snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64), workspaceRevision: 2,
    attemptRevision: 4, decisionEpoch: 5, status: 'submitted' } : { attemptRevision: 5, decisionEpoch: 6, status: 'active',
    submissionId: 'submission', grantId: 'grant' } })
function fixture() {
  const rows: SubmissionCommand[] = [], posted: SubmissionCommand[] = []
  let source = recovery(), valid = true, fail: Error | null = null, delayed: (() => Promise<unknown>) | null = null
  const feedback: FeedbackView = { feedbackRevision: 0, entries: [], reopen: { state: 'none', actionable: false } }
  const journal: SubmissionJournal = {
    read: async () => structuredClone(rows),
    append: async (command, current) => { if (!current() || rows.some(r => r.state === 'pending')) throw new Error('original pending'); rows.push(structuredClone(command)) },
    settle: async (command, current) => { if (!current()) throw new Error('invalid'); rows[rows.findIndex(r => r.commandKey === command.commandKey)] = structuredClone(command) },
  }
  const confirmation = { context, isCurrent: () => valid, commandInFlight: false,
    readHead: async () => ({ attempt: structuredClone(source.attempt) } as WorkspaceHead) }
  const client = new SubmissionFeedbackWorkspace(confirmation, journal, {
    authority: async () => true,
    get: async path => {
      if (path === '/session') return { userId: 'student', courses: [{ courseId: 'course', role: 'student' }], csrfToken: 'csrf' }
      if (path.startsWith('/assignments/')) return { assignmentId: 'assignment', studentId: 'student', activityVersionId: 'activity', active: true }
      if (path.includes('/recovery?')) return structuredClone(source)
      if (path.endsWith('/feedback')) return structuredClone(feedback)
      throw new Error('Unexpected path')
    },
    post: async command => { posted.push(structuredClone(command)); if (delayed) return delayed(); if (fail) throw fail
      source.attempt = { ...source.attempt, status: command.kind === 'submit' ? 'submitted' : 'active', attemptRevision: source.attempt.attemptRevision + 1, decisionEpoch: source.attempt.decisionEpoch + 1 }
      return receipt(command) },
  })
  return { client, rows, posted, source, feedback, invalidate: () => { valid = false },
    setSource: (value: SubmissionRecovery) => { source = value }, fail: (error: Error | null) => { fail = error },
    delay: (fn: () => Promise<unknown>) => { delayed = fn } }
}

describe('fixed submission and teacher feedback', () => {
  it('freezes the real C4 wire and permits a failed matching course check', async () => {
    const command = await freezeSubmissionCommand(context, recovery(), { kind: 'submit', snapshot: snapshot(), reflection: '待验证\r\n保留原文', checkRunIds: ['check-failed'] })
    expect(JSON.parse(command.wireJson)).toEqual({ recoveryGeneration: 'generation', expectedAttemptRevision: 3,
      snapshotId: 'snapshot', reflection: '待验证\r\n保留原文', checkRunIds: ['check-failed'] })
    const fields = { checkRunIds: ['check-failed'], expectedAttemptRevision: 3, reflection: '待验证\r\n保留原文', snapshotId: 'snapshot' }
    expect(command.requestHash).toBe(await textHash(JSON.stringify({ fields, target: '/api/attempts/attempt/submissions' })))
    expect(verifySubmissionReceipt(command, receipt(command)).result).toMatchObject({ submissionId: 'submission', status: 'submitted' })
  })
  it('rejects ordinary runs, other snapshots, duplicate references and terminal stages', async () => {
    for (const checkRunIds of [['ordinary-run'], ['check-older'], ['check-failed', 'check-failed']]) {
      await expect(freezeSubmissionCommand(context, recovery(), { kind: 'submit', snapshot: snapshot(), reflection: '', checkRunIds })).rejects.toThrow('检查引用')
    }
    await expect(freezeSubmissionCommand(context, { ...recovery(), attempt: { ...attempt(), status: 'submitted' } },
      { kind: 'submit', snapshot: snapshot(), reflection: '', checkRunIds: [] })).rejects.toThrow('阶段')
  })
  it('requires an actionable latest-submission grant and preserves the control hash contract', async () => {
    const source = { ...recovery(), attempt: { ...attempt(), status: 'reviewed' as const }, latestSubmissionId: 'submission',
      reopen: { state: 'valid' as const, actionable: true, grantId: 'grant', submissionId: 'submission' } }
    const command = await freezeSubmissionCommand(context, source, { kind: 'resume' })
    expect(JSON.parse(command.wireJson)).toEqual({ recoveryGeneration: 'generation', expectedAttemptRevision: 3, control: { kind: 'resume_revision' } })
    expect(command.requestHash).toBe(await textHash(JSON.stringify({ fields: { control: { kind: 'resume_revision' }, expectedRevision: 3 }, target: '/api/attempts/attempt/controls' })))
    await expect(freezeSubmissionCommand(context, { ...source, reopen: { ...source.reopen, actionable: false } }, { kind: 'resume' })).rejects.toThrow('许可')
    await expect(freezeSubmissionCommand(context, { ...source, latestSubmissionId: 'new-submission' }, { kind: 'resume' })).rejects.toThrow('许可')
  })
  it('does not accept another student or a different selected snapshot in a receipt', async () => {
    const command = await freezeSubmissionCommand(context, recovery(), { kind: 'submit', snapshot: snapshot(), reflection: '', checkRunIds: [] })
    const wrong = receipt(command); wrong.identity.actorId = 'other-student'
    expect(() => verifySubmissionReceipt(command, wrong)).toThrow('原提交')
    const wrongSnapshot = receipt(command); wrongSnapshot.result = { ...(wrongSnapshot.result as object), snapshotId: 'different' }
    expect(() => verifySubmissionReceipt(command, wrongSnapshot)).toThrow('所选快照')
  })
  it('keeps feedback revisions and stale basis separate and rejects cross-student reads', () => {
    const entry = { feedbackId: 'feedback', threadRevision: 2, courseId: 'course', studentId: 'student', attemptId: 'attempt',
      submissionId: 'submission', teacherId: 'teacher', kind: 'submission_review', summary: '核对边界', reason: '缺少验证',
      current: true, disputed: true, createdAt: '2026-10-15T00:00:00.000Z', basis: [{ claimId: 'claim', claimRevision: 1, status: 'withdrawn' }] }
    const view = { feedbackRevision: 3, entries: [entry], reopen: { state: 'none', actionable: false } }
    expect(verifyFeedbackView(view, context).entries[0]).toMatchObject({ threadRevision: 2, disputed: true, basis: [{ status: 'withdrawn' }] })
    expect(() => verifyFeedbackView({ ...view, entries: [{ ...entry, studentId: 'other-student' }] }, context)).toThrow('归属')
    expect(() => verifySubmissionRecovery({ ...recovery(), attempt: { ...attempt(), decisionEpoch: 5 } }, context, attempt())).toThrow('已变化')
  })
  it('reads without creating any submission or revision command', async () => {
    const f = fixture(); await f.client.refresh()
    expect(f.client.current.phase).toBe('ready'); expect(f.posted).toHaveLength(0); expect(f.rows).toHaveLength(0)
  })
  it('keeps an unknown original command and reconciles using the same key and bytes', async () => {
    const f = fixture(); await f.client.refresh(); f.fail(new Error('ACK lost'))
    await f.client.submit(snapshot(), '本人反思', ['check-failed'])
    expect(f.client.current.phase).toBe('unknown'); expect(f.rows).toHaveLength(1)
    await f.client.submit(snapshot(), '不能静默替换', [])
    expect(f.posted).toHaveLength(1)
    await f.client.refresh(); f.fail(null); await f.client.reconcile()
    expect(f.posted).toHaveLength(2)
    expect(f.posted[1]?.commandKey).toBe(f.posted[0]?.commandKey)
    expect(f.posted[1]?.wireJson).toBe(f.posted[0]?.wireJson)
    expect(f.rows[0]?.state).toBe('confirmed'); expect(f.client.current.pending).toBeNull()
    expect(f.client.current.recovery?.attempt.status).toBe('submitted')
  })
  it('a service CAS refusal clears only the refused request and requires an explicit fresh read', async () => {
    const f = fixture(); await f.client.refresh()
    f.fail(new WorkspaceRequestError({ kind: 'api', status: 409, requestId: 'request',
      error: { code: 'VERSION_CONFLICT', message: 'Attempt changed', retryable: false, recovery: 're-read' } }, 'POST', '/api/attempts/attempt/submissions'))
    await f.client.submit(snapshot(), '', [])
    expect(f.rows[0]?.state).toBe('rejected'); expect(f.client.current.pending).toBeNull()
    expect(f.client.current.phase).toBe('unavailable'); expect(f.client.current.recovery).toBeNull()
  })
  it('never accepts a late response after the owning context is invalidated', async () => {
    const f = fixture(); await f.client.refresh()
    let complete!: (value: unknown) => void
    f.delay(() => new Promise(resolve => { complete = resolve }))
    const sending = f.client.submit(snapshot(), '', [])
    while (!f.posted.length) await new Promise(resolve => setTimeout(resolve, 0))
    f.invalidate(); complete(receipt(f.posted[0]!)); await sending
    expect(f.rows[0]?.state).toBe('pending'); expect(f.client.current.pending).not.toBeNull()
  })
})
