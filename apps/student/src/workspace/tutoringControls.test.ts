import { describe, expect, it } from 'vitest'
import { freezeTutoringControl, TutoringControlsWorkspace, verifyControlReceipt, controlAllowed,
  controlJournalKey, limitedCheckFromHead, type ControlCommand, type ControlJournal } from './tutoringControls'
import type { CommandContext } from './frozenCommand'
import type { AssignmentView } from './contracts'
import type { AttemptView, WorkspaceHead } from './workspaceContracts'
import { WorkspaceRequestError } from './http'
import { createPrepControlHandler, parsePrepControlInput, planPrepControl } from '../../prep/tutoringControls'
import type { readPrepAttempt } from '../../prep/workspace'
import type { PrepSession } from '../../prep/authority'

const context = (): CommandContext => ({ mode: 'preparation', userId: 'student', courseId: 'course',
  assignmentId: 'assignment', activityVersionId: 'activity', attemptId: 'attempt', preparationEpoch: 'prep',
  trustedRecoveryGeneration: 'g1', loadEpoch: 1, scenarioId: 'control-unit' })
const attempt = (): AttemptView => ({ attemptId: 'attempt', courseId: 'course', studentId: 'student',
  assignmentId: 'assignment', activityVersionId: 'activity', status: 'active', attemptRevision: 7,
  workspaceRevision: 3, decisionEpoch: 2, captureRevision: 4, collecting: true, reminders: false })
const assignment = (): AssignmentView => ({ assignmentId: 'assignment', activityVersionId: 'activity', studentId: 'student',
  assignmentRevision: 1, activityControlRevision: 1, status: 'active', active: true, reasons: { individual: '', activity: '' } })
function receipt(command: ControlCommand, replayed = false) {
  const body = JSON.parse(command.wireJson)
  return { receiptId: 'receipt', commandId: 'command', serverSeq: 2, committedAt: '2026-10-13T00:00:00.000Z',
    replayed, requestHash: command.requestHash, identity: { actorId: command.context.userId, command: 'attempt.control',
      target: command.target, idempotencyKey: command.commandKey, recoveryGeneration: command.context.trustedRecoveryGeneration,
      scope: { courseId: command.context.courseId, studentId: command.context.userId, attemptId: command.context.attemptId } },
    result: { attemptRevision: body.expectedAttemptRevision + 1, decisionEpoch: 2, captureRevision: 5,
      cancelledJobIds: [], captureChanged: true } }
}
function harness() {
  const c = context(), rows: ControlCommand[] = [], requests: ControlCommand[] = [], events: string[] = []
  let current = true, rejectStore = false, assignmentState = assignment()
  let authority = attempt()
  let getAssignment = async (): Promise<AssignmentView> => structuredClone(assignmentState)
  let post = async (command: ControlCommand): Promise<unknown> => {
    authority = planPrepControl(authority, JSON.parse(command.wireJson).expectedAttemptRevision,
      JSON.parse(command.wireJson).control, assignmentState.active).attempt
    return receipt(command)
  }
  const journal: ControlJournal = {
    read: async () => structuredClone(rows),
    append: async (command, valid) => {
      if (rejectStore || !valid()) throw new Error('storage disabled')
      if (rows.some(row => row.state === 'pending')) throw new Error('already pending')
      events.push('persist'); rows.push(structuredClone(command))
    },
    update: async (_c, key, change, valid) => {
      if (!valid()) throw new Error('stale')
      const row = rows.find(row => row.commandKey === key)!
      change(row); return structuredClone(row)
    },
  }
  const confirmation = { context: c, commandInFlight: false, isCurrent: (value: CommandContext) => current && value === c,
    readHead: async (): Promise<WorkspaceHead> => {
      events.push('read'); return { attempt: structuredClone(authority), files: [], snapshots: [], jobs: [], runs: [], checks: [], limitedCheck: false }
    } }
  const client = new TutoringControlsWorkspace(confirmation, journal, {
    getAssignment: () => getAssignment(), authorityCurrent: async () => true,
    post: async command => { events.push('post'); requests.push(structuredClone(command)); return post(command) },
  })
  return { c, client, rows, requests, events, confirmation, journal,
    setPost: (value: typeof post) => { post = value }, setCurrent: (value: boolean) => { current = value },
    setStoreFailure: () => { rejectStore = true }, setAuthority: (value: AttemptView) => { authority = value },
    setGetAssignment: (value: typeof getAssignment) => { getAssignment = value },
    setAssignment: (value: AssignmentView) => { assignmentState = value } }
}

describe('student controls command boundaries', () => {
  it('reads authority, persists original bytes, sends and rereads without overwriting workspace versions', async () => {
    const h = harness()
    await h.client.refresh(); h.events.length = 0
    await h.client.set({ kind: 'capture', value: false })
    expect(h.events).toEqual(['read', 'persist', 'post', 'read'])
    expect(h.requests).toHaveLength(1)
    expect(JSON.parse(h.requests[0]!.wireJson)).toEqual({ recoveryGeneration: 'g1', expectedAttemptRevision: 7,
      control: { kind: 'capture', value: false } })
    expect(h.client.current.attempt).toMatchObject({ collecting: false, reminders: false, attemptRevision: 8,
      captureRevision: 5, decisionEpoch: 2, workspaceRevision: 3, status: 'active' })
    expect(h.rows[0]?.state).toBe('confirmed')
  })
  it('failure to persist prevents any write and preserves authoritative values', async () => {
    const h = harness(); h.setStoreFailure()
    await h.client.set({ kind: 'reminders', value: true })
    expect(h.requests).toEqual([])
    expect(h.client.current.attempt?.reminders).toBe(false)
    expect(h.client.current.phase).toBe('unavailable')
  })
  it('missing trusted generation prevents a control command', async () => {
    const h = harness(); h.c.trustedRecoveryGeneration = null
    await h.client.set({ kind: 'pause' })
    expect(h.requests).toEqual([]); expect(h.rows).toEqual([])
  })
  it('lost acknowledgement keeps original key and expected revision even after authority advances', async () => {
    const h = harness()
    h.setPost(async () => {
      h.setAuthority({ ...attempt(), collecting: false, captureRevision: 5, attemptRevision: 8 })
      throw new Error('lost ack')
    })
    await h.client.set({ kind: 'capture', value: false })
    expect(h.client.current.phase).toBe('unknown')
    expect(h.rows[0]?.state).toBe('pending')
    await h.client.set({ kind: 'reminders', value: true })
    expect(h.requests).toHaveLength(1)
    h.setPost(async command => receipt(command, true))
    await h.client.retry()
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1]?.commandKey).toBe(h.requests[0]?.commandKey)
    expect(h.requests[1]?.wireJson).toBe(h.requests[0]?.wireJson)
    expect(h.client.current.phase).toBe('ready')
  })
  it('CAS refusal is recorded; no automatic new key/revision or control change', async () => {
    const h = harness()
    h.setPost(async () => { throw new WorkspaceRequestError({ kind: 'api', status: 409, requestId: 'r',
      error: { code: 'VERSION_CONFLICT', message: 'conflict', recovery: 'read', retryable: false } }, 'POST', '/controls') })
    await h.client.set({ kind: 'reminders', value: true }); await h.client.retry()
    expect(h.requests).toHaveLength(1)
    expect(h.rows[0]).toMatchObject({ state: 'rejected', rejection: 'VERSION_CONFLICT' })
    expect(h.client.current.attempt?.reminders).toBe(false)
  })
  it('student cannot resume teacher-paused assignment, but existing-file save permissions are untouched', async () => {
    const h = harness(); h.setAuthority({ ...attempt(), status: 'paused' })
    h.setAssignment({ ...assignment(), active: false, status: 'paused' })
    await h.client.set({ kind: 'resume' })
    expect(h.requests).toEqual([])
    expect(h.client.current.attempt?.status).toBe('paused')
    expect(h.client.current.notice).toContain('教师暂停')
  })
  it('late ACK cannot mutate current UI or command facts after account/context retirement', async () => {
    const h = harness()
    h.setPost(async command => { h.setCurrent(false); return receipt(command) })
    await h.client.set({ kind: 'capture', value: false })
    expect(h.client.current.attempt?.collecting).toBe(true)
    expect(h.rows[0]?.receipt).toBeUndefined()
  })
  it('retains old-generation pending records but never replays or transfers their bytes to a new generation', async () => {
    const h = harness()
    h.rows.push(await freezeTutoringControl({ ...h.c, trustedRecoveryGeneration: 'old' }, attempt(), { kind: 'pause' }))
    await h.client.refresh(); await h.client.retry()
    expect(h.requests).toEqual([])
    expect(h.rows[0]?.context.trustedRecoveryGeneration).toBe('old')
    expect(h.client.current.pending).toBeNull()
  })
  it('rejects a receipt for another account/key/hash instead of claiming success', async () => {
    const command = await freezeTutoringControl(context(), attempt(), { kind: 'pause' })
    const ack = receipt(command); ack.identity.actorId = 'other'
    expect(() => verifyControlReceipt(command, ack)).toThrow('原命令')
    ack.identity.actorId = 'student'; ack.requestHash = 'fake'
    expect(() => verifyControlReceipt(command, ack)).toThrow('原命令')
  })
  it('confirmed command remains confirmed if the following authoritative read fails', async () => {
    const h = harness()
    h.setPost(async command => {
      h.confirmation.readHead = async () => { throw new Error('read unavailable') }
      return receipt(command)
    })
    await h.client.set({ kind: 'capture', value: false })
    expect(h.rows[0]?.state).toBe('confirmed')
    expect(h.client.current.pending).toBeNull()
    expect(h.client.current.phase).toBe('unavailable')
    expect(h.client.current.notice).toContain('原控制已确认')
  })
  it('namespaces account/Attempt/scenario identities; same authority survives page loadEpoch changes', () => {
    expect(controlJournalKey(context())).toBe(controlJournalKey({ ...context(), loadEpoch: 9 }))
    for (const changed of [{ userId: 'other' }, { attemptId: 'other' }, { scenarioId: 'other' }, { mode: 'real' as const }]) {
      expect(controlJournalKey({ ...context(), ...changed })).not.toBe(controlJournalKey(context()))
    }
  })
})

describe('authorized limited-check projection', () => {
  it('consumes the explicit flag and does not mistake a non-limited active check for a restriction', async () => {
    const h = harness(), read = h.confirmation.readHead
    h.confirmation.readHead = async () => ({ ...await read(), limitedCheck: false,
      checks: [{ jobId: 'check-job', runId: 'check-run', policyVersion: 'policy', state: 'active' }] })
    await h.client.refresh()
    expect(h.client.current.limitedCheck).toBe(false)
    expect(h.requests).toEqual([])
    expect(h.rows).toEqual([])
  })
  it('missing or non-boolean fields remain unknown while independent capture control is still available', async () => {
    const h = harness(), read = h.confirmation.readHead
    for (const value of [undefined, null, 'false', 0, {}]) {
      h.confirmation.readHead = async () => {
        const head = await read()
        if (value === undefined) delete head.limitedCheck
        else Object.assign(head, { limitedCheck: value })
        return head
      }
      await h.client.refresh()
      expect(h.client.current.limitedCheck).toBeNull()
      expect(h.client.current.phase).toBe('ready')
    }
    await h.client.set({ kind: 'capture', value: false })
    expect(h.requests).toHaveLength(1)
    expect(h.client.current.attempt?.collecting).toBe(false)
    expect(h.client.current.limitedCheck).toBeNull()
    expect(limitedCheckFromHead({ limitedCheck: true })).toBe(true)
  })
  it('rereads a confirmed check ending even when Attempt revision and epoch have not changed', async () => {
    const h = harness(), read = h.confirmation.readHead
    let limited = true
    h.confirmation.readHead = async () => ({ ...await read(), limitedCheck: limited })
    await h.client.refresh()
    const before = structuredClone(h.client.current.attempt)
    expect(h.client.current.limitedCheck).toBe(true)
    limited = false
    await h.client.refresh()
    expect(h.client.current.limitedCheck).toBe(false)
    expect(h.client.current.attempt).toEqual(before)
    expect(h.requests).toEqual([])
  })
  it('reads the check flag after a delayed Assignment instead of publishing an earlier flag with unchanged revisions', async () => {
    const h = harness(), read = h.confirmation.readHead
    let limited = false, release!: (value: AssignmentView) => void
    h.confirmation.readHead = async () => ({ ...await read(), limitedCheck: limited })
    const pendingAssignment = new Promise<AssignmentView>(resolve => { release = resolve })
    h.setGetAssignment(() => pendingAssignment)
    const refreshed = h.client.refresh()
    await Promise.resolve()
    limited = true; release(assignment())
    await refreshed
    expect(h.client.current.limitedCheck).toBe(true)
    expect(h.client.current.attempt?.attemptRevision).toBe(7)
    expect(h.client.current.attempt?.decisionEpoch).toBe(2)
    expect(h.requests).toEqual([])
  })
  it('a failed read clears an earlier known flag instead of claiming that a restriction has ended', async () => {
    const h = harness(), read = h.confirmation.readHead
    h.confirmation.readHead = async () => ({ ...await read(), limitedCheck: true })
    await h.client.refresh()
    expect(h.client.current.limitedCheck).toBe(true)
    h.confirmation.readHead = async () => { throw new Error('head unavailable') }
    await h.client.refresh()
    expect(h.client.current.phase).toBe('unavailable')
    expect(h.client.current.limitedCheck).toBeNull()
    expect(h.requests).toEqual([])
  })
  it('false neither resumes a paused attempt nor overrides a teacher-paused assignment', async () => {
    const h = harness()
    h.setAuthority({ ...attempt(), status: 'paused' })
    h.setAssignment({ ...assignment(), active: false, status: 'paused' })
    await h.client.refresh()
    expect(h.client.current.limitedCheck).toBe(false)
    expect(controlAllowed(h.client.current.attempt, h.client.current.assignment, { kind: 'resume' })).toBe(false)
    await h.client.set({ kind: 'resume' })
    expect(h.requests).toEqual([])
    expect(h.client.current.attempt?.status).toBe('paused')
  })
  it('a retired account/context cannot publish a delayed check flag', async () => {
    const h = harness(), read = h.confirmation.readHead
    h.confirmation.readHead = async () => { const head = await read(); h.setCurrent(false); return { ...head, limitedCheck: false } }
    await h.client.refresh()
    expect(h.client.current.limitedCheck).toBeNull()
    expect(h.requests).toEqual([])
  })
})

describe('same-authority prep control contract cases', () => {
  it('same-value controls are noops after CAS; capture/reminders do not add general epoch or activate ready', () => {
    const ready = { ...attempt(), status: 'ready' as const }
    const same = planPrepControl(ready, 7, { kind: 'capture', value: true }, true)
    expect(same).toEqual({ attempt: ready, cancelPurposes: [], captureChanged: false })
    const reminders = planPrepControl(ready, 7, { kind: 'reminders', value: true }, true)
    expect(reminders.attempt).toMatchObject({ status: 'ready', collecting: true, reminders: true,
      captureRevision: 4, decisionEpoch: 2, attemptRevision: 8 })
    const capture = planPrepControl(ready, 7, { kind: 'capture', value: false }, true)
    expect(capture.cancelPurposes).toEqual(['passive_analysis'])
    expect(capture.attempt.decisionEpoch).toBe(2)
    expect(() => planPrepControl(ready, 6, { kind: 'capture', value: true }, true)).toThrow('VERSION_CONFLICT')
  })
  it('pause cancels all appropriate purposes; resume and reenable cannot revive old work', () => {
    const pause = planPrepControl(attempt(), 7, { kind: 'pause' }, true)
    expect(pause.cancelPurposes).toContain('student_run')
    expect(pause.attempt).toMatchObject({ status: 'paused', decisionEpoch: 3, collecting: true, reminders: false })
    expect(() => planPrepControl(pause.attempt, 8, { kind: 'resume' }, false)).toThrow('STATE_CONFLICT')
    const resume = planPrepControl(pause.attempt, 8, { kind: 'resume' }, true)
    expect(resume.cancelPurposes).toEqual([])
    expect(resume.attempt.decisionEpoch).toBe(3)
    expect(controlAllowed(pause.attempt, { ...assignment(), active: false }, { kind: 'resume' })).toBe(false)
  })
  it('strict input refuses invented policy/limitedCheck/generation/boolean fields', () => {
    const base = { recoveryGeneration: 'g1', expectedAttemptRevision: 7, control: { kind: 'capture', value: false } }
    expect(parsePrepControlInput(base)).toEqual(base)
    for (const value of [{ ...base, limitedCheck: true }, { ...base, control: { kind: 'pause', value: true } },
      { ...base, control: { kind: 'capture', value: 'false' } }, { ...base, recoveryGeneration: '' }]) {
      expect(() => parsePrepControlInput(value)).toThrow('INVALID_REQUEST')
    }
  })
  it('routes control through the owner command, adapts only internal digest fields and preserves terminal job facts', () => {
    const a = attempt(), calls: unknown[][] = []
    const h: ReturnType<typeof readPrepAttempt> = { attempt: a, files: [], snapshots: [], runs: [], checks: [], jobs: [
      { jobId: 'running', kind: 'run', purpose: 'student_run', scope: { courseId: 'course', studentId: 'student', attemptId: 'attempt' },
        requestReceiptId: 'r', status: 'outcome_unknown', stopRequested: false, expectedRevision: 7, decisionEpoch: 2,
        recoveryGeneration: 'g1', acceptedAt: '2026-10-13T00:00:00Z', deadline: '2026-10-13T00:10:00Z', attemptCount: 1, runId: 'run1' },
      { jobId: 'done', kind: 'run', purpose: 'student_run', scope: { courseId: 'course', studentId: 'student', attemptId: 'attempt' },
        requestReceiptId: 'r2', status: 'succeeded', stopRequested: false, expectedRevision: 7, decisionEpoch: 2,
        recoveryGeneration: 'g1', acceptedAt: '2026-10-13T00:00:00Z', deadline: '2026-10-13T00:10:00Z', attemptCount: 1, runId: 'run2' },
    ] }
    const control = createPrepControlHandler({ assignmentActive: () => true,
      stopTeaching: (_scenario, _attempt, purposes) => { calls.push(purposes); return ['help-job'] },
      prepTeachingCommand: (_scenario, _session, _attempt, name, target, body, key, work) => {
        calls.push([name, target, body, key])
        const result = work(h)
        return { receiptId: 'r', commandId: 'c', requestHash: 'hash', serverSeq: 1, committedAt: '2026-10-13T00:00:00Z',
          identity: { actorId: 'student', command: name, target, scope: { courseId: 'course', studentId: 'student', attemptId: 'attempt' },
            idempotencyKey: String(key), recoveryGeneration: 'g1' }, result }
      } })
    const value = control('scenario', {} as PrepSession, 'attempt', { recoveryGeneration: 'g1', expectedAttemptRevision: 7,
      control: { kind: 'pause' } }, 'original-key')
    expect(calls[0]).toEqual(['attempt.control', '/api/attempts/attempt/controls',
      { recoveryGeneration: 'g1', expectedRevision: 7, control: { kind: 'pause' } }, 'original-key'])
    expect(value.result).toMatchObject({ attemptRevision: 8, cancelledJobIds: ['running', 'done', 'help-job'] })
    expect(h.jobs[0]).toMatchObject({ stopRequested: true, status: 'cancelling' })
    expect(h.jobs[1]).toMatchObject({ stopRequested: true, status: 'succeeded' })
  })
})
