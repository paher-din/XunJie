import { readFileSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ConfirmationWorkspace } from './confirmationWorkspace'
import type { CommandContext, FrozenCommand, OutboxRecord } from './frozenCommand'
import type { Receipt, WorkspaceHead } from './workspaceContracts'
import { HdlWorkspace } from './hdlWorkspace'
import type { HdlBuildView, HdlExecutionBinding, HdlRuntimeProfile, HdlSessionView, HdlTraceView } from './hdlContracts'
import { textHash } from './confirmation'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), persist: vi.fn(), authority: vi.fn(), rows: new Map<string, OutboxRecord>() }))
vi.mock('./http', async original => ({ ...await original<object>(), apiGet: mocks.get, apiPostFrozen: mocks.post }))
vi.mock('./confirmationDb', async original => ({ ...await original<object>(), confirmationRepository: {
  commands: async () => structuredClone([...mocks.rows.values()]), command: async (key: string) => structuredClone(mocks.rows.get(key) ?? null),
  persist: mocks.persist, isCurrentAuthority: mocks.authority,
  claim: async (key: string, owner: string, valid: () => boolean) => {
    const row = mocks.rows.get(key)!
    if (!valid() || !row || row.receipt || row.lease && row.lease.owner !== owner) throw new Error('原请求不能领取')
    row.lease = { owner, until: Date.now() + 30000 }; return structuredClone(row)
  },
  release: async (key: string, owner: string) => { const row = mocks.rows.get(key); if (row?.lease?.owner === owner) delete row.lease },
  acknowledge: async (command: FrozenCommand, receipt: Receipt, _head: unknown, _mappings: unknown, _snapshot: unknown, valid: () => boolean) => {
    const row = mocks.rows.get(command.commandKey)!
    row.receipt = structuredClone(receipt); row.state = valid() ? 'confirmed' : 'historical'; delete row.lease
  },
  noteRejection: async () => {}, rejectRun: async (key: string) => { mocks.rows.get(key)!.state = 'historical' },
} }))

const raw = JSON.parse(readFileSync(new URL('../../../../docs/tasks/evidence/dla-continuation-20261014/real-hdl-final-frozen.json', import.meta.url), 'utf8'))
type Http = { path: string; method: string; body: { data: Record<string, unknown> } }
const http: Http[] = raw.http, aid = raw.objects.attemptId, sid = raw.session.sessionId, bid = raw.successfulBuild.buildId
const goldenBuild = http.filter(r => r.path === `/api/hdl/builds/${bid}` && r.body.data.status === 'succeeded').at(-1)!.body.data as unknown as HdlBuildView
const goldenSession = http.filter(r => r.path === `/api/hdl/sessions/${sid}` && r.body.data.status === 'active').at(-1)!.body.data as unknown as HdlSessionView
const goldenStopped = http.filter(r => r.path === `/api/hdl/sessions/${sid}`).at(-1)!.body.data as unknown as HdlSessionView
const goldenHead = http.filter(r => r.path === `/api/attempts/${aid}`).at(-1)!.body.data as unknown as WorkspaceHead
const context: CommandContext = { mode: 'real', preparationEpoch: null, loadEpoch: 1, trustedRecoveryGeneration: raw.generation,
  courseId: raw.objects.courseId, userId: raw.objects.studentId, activityVersionId: raw.objects.activityVersionId, assignmentId: raw.objects.assignmentId, attemptId: aid }
const clone = <T,>(value: T): T => structuredClone(value)
const programResponse = http.find(r => r.method === 'POST' && r.path.endsWith('/hdl/programs'))!.body.data as unknown as Receipt
const originalProgram: OutboxRecord = { commandKey: programResponse.identity.idempotencyKey, context, kind: 'hdl.program',
  target: aid, path: `/attempts/${aid}/hdl/programs`, wireJson: JSON.stringify({ recoveryGeneration: raw.generation, expectedAttemptRevision: 3, buildId: bid }),
  requestHash: programResponse.requestHash, createdAt: 1, before: null, drafts: [], state: 'confirmed', receipt: programResponse }

beforeEach(() => {
  mocks.get.mockReset(); mocks.post.mockReset(); mocks.persist.mockReset(); mocks.authority.mockReset(); mocks.rows.clear()
  mocks.authority.mockResolvedValue(true)
  mocks.persist.mockImplementation(async (command: FrozenCommand, valid: () => boolean) => {
    if (!valid()) throw new Error('旧上下文')
    if ([...mocks.rows.values()].some(r => r.state === 'pending')) throw new Error('原请求未确认')
    mocks.rows.set(command.commandKey, { ...clone(command), state: 'pending' })
  })
})

function fixture(existing = true, execution?: HdlExecutionBinding) {
  let valid = true, build = clone(goldenBuild), session = existing ? clone(goldenSession) : null, status = 'succeeded'
  const head = clone(goldenHead); head.jobs = []; head.attempt.status = 'active'
  if (execution) {
    build.request.identity.recoveryGeneration = execution.nodeGeneration
    build.result!.identity.recoveryGeneration = execution.nodeGeneration
    if (session) session.identity.recoveryGeneration = execution.nodeGeneration
    const common = { purpose: 'student_run', scope: { courseId: context.courseId, studentId: context.userId, attemptId: aid },
      recoveryGeneration: context.trustedRecoveryGeneration, status: 'succeeded', stopRequested: false, expectedRevision: head.attempt.attemptRevision,
      decisionEpoch: 0, attemptCount: 1, acceptedAt: '2026-10-14T00:00:00Z', deadline: '2026-10-14T01:00:00Z', execution }
    head.jobs.push({ ...common, kind: 'hdl_build', jobId: build.jobId, runId: bid, requestReceiptId: 'build-receipt' },
      { ...common, kind: 'hdl_program', jobId: (programResponse.result as { jobId: string }).jobId, runId: sid, requestReceiptId: programResponse.receiptId })
  }
  const profile: HdlRuntimeProfile = { runtimeProfileVersion: build.request.runtimeProfileVersion, engineVersion: build.result!.engineVersion,
    boardProfileVersion: build.request.board.boardProfileVersion, mappingVersion: build.request.board.mappingVersion,
    buildImage: build.result!.imageDigest, recoveryGeneration: raw.generation, read: vi.fn().mockResolvedValue(true) }
  const confirmation = { context, current: { attempt: head.attempt }, commandInFlight: false,
    isCurrent: () => valid, readHead: vi.fn(async () => clone(head)), readSnapshot: vi.fn(async () => clone(goldenBuild.request.snapshot)) }
  if (existing) mocks.rows.set(originalProgram.commandKey, clone(originalProgram))
  const job = (jobId: string) => {
    const row = [...mocks.rows.values()].find(r => r.receipt && (r.receipt.result as { jobId?: string }).jobId === jobId)!
    const result = row.receipt!.result as { buildId?: string; operationId?: string }
    return { jobId, kind: row.kind === 'hdl.build' ? 'hdl_build' : row.kind === 'hdl.program' ? 'hdl_program' : 'hdl_interact',
      purpose: 'student_run', scope: { courseId: context.courseId, studentId: context.userId, attemptId: aid },
      runId: result.buildId ?? result.operationId, recoveryGeneration: raw.generation, requestReceiptId: row.receipt!.receiptId,
      status, stopRequested: session?.stopRequested ?? false, expectedRevision: head.attempt.attemptRevision, decisionEpoch: 0,
      acceptedAt: '2026-10-14T00:00:00Z', deadline: '2026-10-14T00:02:00Z', attemptCount: 1 }
  }
  const get = async (path: string) => {
    if (path === '/session') return { userId: context.userId, csrfToken: 'csrf', courses: [{ courseId: context.courseId, role: 'student' }] }
    if (path.startsWith('/hdl/builds/')) return clone(build)
    if (path.includes('/trace?')) {
      const cursor = Number(path.split('afterSequence=')[1])
      // The archive did not request sequence 0. This explicit synthetic initial frame is only a unit fixture.
      const initialFrame = { simTimePs: '0', switches: '0'.repeat(16), buttons: '00000', resetN: '1', leds: 'x'.repeat(16), anodes: 'x'.repeat(8), segments: 'x'.repeat(7), dp: 'x' }
      const initialBody = { ...raw.operations[0], operationId: sid, sequence: 0, sessionRevision: 1, frames: [initialFrame], finalFrame: initialFrame,
        sampleCount: 1, droppedFrames: 0, coverage: 'complete' }
      delete initialBody.resultHash
      const initial = { ...initialBody, resultHash: await textHash(JSON.stringify(initialBody)) }
      const sequence = cursor < 0 ? 0 : cursor + 1
      const result = sequence === 0 ? initial : raw.operations.find((r: { sequence: number }) => r.sequence === sequence)
      if (result) return { operation: { operationId: (result as { operationId: string }).operationId, sequence, status: 'succeeded', result: clone(result) }, nextSequence: sequence } as HdlTraceView
      if (session?.pendingOperationId) return { operation: { operationId: session.pendingOperationId, sequence, status: 'queued', result: null }, nextSequence: cursor }
      return { operation: null, nextSequence: cursor }
    }
    if (path.startsWith('/hdl/sessions/')) return clone(session)
    if (path.startsWith('/jobs/')) return head.jobs.find(j => (j as { jobId: string }).jobId === path.split('/').at(-1)) ?? job(path.split('/').at(-1)!)
    throw new Error(`Unexpected read ${path}`)
  }
  mocks.get.mockImplementation(get)
  const receipt = (wire: string, key: string, replayed = false): Receipt => {
    const command = mocks.rows.get(key)!, input = JSON.parse(wire)
    const response: Receipt = { receiptId: 'new-receipt', commandId: 'new-command', requestHash: command.requestHash, serverSeq: 9,
      committedAt: '2026-10-14T00:00:00Z', replayed,
      identity: { actorId: context.userId!, command: command.kind, target: aid, idempotencyKey: key, recoveryGeneration: raw.generation,
        scope: { courseId: context.courseId, studentId: context.userId!, attemptId: aid } },
      result: command.kind === 'hdl.build' ? { buildId: bid, jobId: 'new-job' } : command.kind === 'hdl.stop' ? { attemptId: aid, stopRequested: true } :
        { sessionId: sid, operationId: command.kind === 'hdl.program' ? sid : 'new-operation', jobId: 'new-job' } }
    if (command.kind === 'hdl.build') {
      build = clone(goldenBuild); build.request.identity.commandId = response.commandId; build.request.identity.requestHash = command.requestHash
      build.result!.identity = clone(build.request.identity); build.jobId = 'new-job'
    } else if (command.kind === 'hdl.interact') { session!.pendingOperationId = 'new-operation'; status = 'running' }
    else if (command.kind === 'hdl.stop') { session = clone(goldenStopped); status = 'cancelled' }
    else if (command.kind === 'hdl.program') {
      if (input.replaceSessionId) expect(input.replaceSessionId).toBe(sid)
      session = clone(goldenSession)
    }
    return response
  }
  mocks.post.mockImplementation(async (_path: string, wire: string, options: { idempotencyKey: string }) => receipt(wire, options.idempotencyKey))
  return { client: new HdlWorkspace(confirmation as unknown as ConfirmationWorkspace, profile), profile, confirmation, head, get, receipt,
    invalidate: () => { valid = false }, setPending: () => { session!.pendingOperationId = 'pending-op' },
    setStopped: () => { session = clone(goldenStopped) } }
}

it('restores the original Session/output using GET only; stop revision keeps original last frame', async () => {
  const f = fixture(); f.setStopped()
  await f.client.initialize()
  expect(f.client.current.notice).toBeNull()
  expect(mocks.post).not.toHaveBeenCalled()
  expect(f.client.current.session?.sessionId).toBe(sid)
  expect(f.client.current.operation?.resultHash).toBe(raw.operations.at(-1).resultHash)
  expect(f.client.current.session?.terminationConfirmed).toBe(true)
  expect(f.client.current.canInteract).toBe(false)
})
it('restores a node-bound Build/Session/Trace from authorized head Jobs in a browser with no local outbox', async () => {
  const f = fixture(true, { nodeId: 'robert', nodeGeneration: 'separate-node-generation' })
  mocks.rows.clear()
  await f.client.initialize()
  expect(f.client.current.phase).toBe('ready')
  expect(f.client.current.build?.execution).toEqual({ nodeId: 'robert', nodeGeneration: 'separate-node-generation' })
  expect(f.client.current.session?.identity.recoveryGeneration).toBe('separate-node-generation')
  expect(f.client.current.operation?.sessionId).toBe(sid)
  expect(f.client.current.canInteract).toBe(true)
  expect(mocks.post).not.toHaveBeenCalled()
})
it('keeps a Build destination through lost ACK and selection changes, without routing Session controls by the new selection', async () => {
  const f = fixture(false)
  let selected = 'robert'
  f.profile.executionNodeId = () => selected
  f.profile.readBuild = async () => true
  await f.client.initialize()
  let first = true
  mocks.post.mockImplementation(async (_path: string, wire: string, options: { idempotencyKey: string }) => {
    const receipt = f.receipt(wire, options.idempotencyKey, !first)
    if (first) { first = false; throw new Error('lost ACK') }
    return receipt
  })
  await f.client.build(goldenBuild.request.snapshot.snapshotId)
  selected = 'member'
  await f.client.reconcile()
  expect(mocks.post.mock.calls.map(call => call[2].executionNodeId)).toEqual(['robert', 'robert'])
  expect(JSON.parse(mocks.post.mock.calls[0]![1])).not.toHaveProperty('executionNodeId')
  await f.client.program(bid)
  expect(mocks.post.mock.calls.at(-1)![2].executionNodeId).toBeUndefined()
})
it('allows original Session controls when the newly selected Build node is unavailable', async () => {
  const f = fixture()
  f.profile.readBuild = async () => false
  await f.client.initialize()
  expect(f.client.current.canBuild).toBe(false)
  expect(f.client.current.canInteract).toBe(true)
  expect(f.client.current.canStop).toBe(true)
})
it('preserves a lost ACK in the original outbox; reads/new builds never silently replay or replace it', async () => {
  const f = fixture(false); await f.client.initialize()
  expect(f.client.current.canBuild).toBe(true)
  let first = true
  mocks.post.mockImplementation(async (_path: string, wire: string, options: { idempotencyKey: string }) => {
    const receipt = f.receipt(wire, options.idempotencyKey, !first)
    if (first) { first = false; throw new Error('lost ACK after accept') }
    return receipt
  })
  await f.client.build(goldenBuild.request.snapshot.snapshotId)
  expect(f.client.current.pending).toBe(true)
  const original = clone([...mocks.rows.values()][0]!)
  await f.client.read(); await f.client.build(goldenBuild.request.snapshot.snapshotId)
  expect(mocks.post).toHaveBeenCalledTimes(1)
  expect(mocks.rows.size).toBe(1)
  await f.client.reconcile()
  expect(mocks.post).toHaveBeenCalledTimes(2)
  expect(mocks.post.mock.calls[0]![1]).toBe(original.wireJson)
  expect(mocks.post.mock.calls[1]![1]).toBe(original.wireJson)
  expect(mocks.post.mock.calls[1]![2].idempotencyKey).toBe(original.commandKey)
  expect(f.client.current.pending).toBe(false)
  expect(f.client.current.build?.result?.status).toBe('succeeded')
  expect(mocks.rows.get(original.commandKey)?.receipt?.replayed).toBe(true)
})
it('does not send when the original command cannot be persisted', async () => {
  const f = fixture(false); await f.client.initialize()
  mocks.persist.mockRejectedValueOnce(new Error('storage unavailable'))
  await f.client.build(goldenBuild.request.snapshot.snapshotId)
  expect(mocks.post).not.toHaveBeenCalled()
  expect(mocks.rows.size).toBe(0)
  expect(f.client.current.phase).toBe('rejected')
})
it('preserves an old-generation unknown command and never migrates it into a new request', async () => {
  const f = fixture(false)
  mocks.rows.set('old-key', { ...clone(originalProgram), commandKey: 'old-key', receipt: undefined, state: 'pending',
    context: { ...context, trustedRecoveryGeneration: 'old-generation' } })
  await f.client.initialize(); await f.client.reconcile()
  expect(mocks.post).not.toHaveBeenCalled()
  expect(f.client.current.pending).toBe(true)
  expect(mocks.rows.size).toBe(1)
  expect(mocks.rows.get('old-key')?.context.trustedRecoveryGeneration).toBe('old-generation')
})
it('requires readiness even with valid .sv source, and keeps model-independent readonly results', async () => {
  const f = fixture(); (f.profile.read as ReturnType<typeof vi.fn>).mockResolvedValue(false)
  await f.client.initialize(); await f.client.build(goldenBuild.request.snapshot.snapshotId)
  expect(mocks.post).not.toHaveBeenCalled()
  expect(f.client.current.canBuild).toBe(false)
  expect(f.client.current.operation?.finalFrame).toEqual(raw.operations.at(-1).finalFrame)
  expect(f.client.current.canStop).toBe(true)
})
it('rejects pending interactions and invalid/X input; explicit stop waits for actual termination', async () => {
  const f = fixture(); await f.client.initialize()
  await f.client.interact({ switches: 'x'.repeat(16), buttons: '00000', resetN: '1' }, 1)
  expect(mocks.post).not.toHaveBeenCalled()
  f.setPending(); await f.client.read()
  expect(f.client.current.canInteract).toBe(false)
  await f.client.interact({ switches: '0'.repeat(16), buttons: '00000', resetN: '1' }, 1)
  expect(mocks.post).not.toHaveBeenCalled()
  await f.client.stop('Explicit stop')
  expect(mocks.post).toHaveBeenCalledTimes(1)
  const body = JSON.parse(mocks.post.mock.calls[0]![1])
  expect(body).toMatchObject({ action: 'stop', reason: 'Explicit stop' }); expect(body).not.toHaveProperty('sessionId')
  expect(f.client.current.session?.terminationConfirmed).toBe(true)
  expect(f.client.current.operation?.resultHash).toBe(raw.operations.at(-1).resultHash)
})
it('requires explicit replacement of a current Session and does not auto-program on refresh', async () => {
  const f = fixture(); await f.client.initialize()
  await f.client.program(bid)
  expect(mocks.post).not.toHaveBeenCalled()
  await f.client.program(bid, { sessionId: sid, sessionRevision: goldenSession.sessionRevision })
  expect(mocks.post).toHaveBeenCalledTimes(1)
  expect(JSON.parse(mocks.post.mock.calls[0]![1])).toMatchObject({ replaceSessionId: sid, expectedSessionRevision: goldenSession.sessionRevision })
})
it('keeps a newer other-tab Session/Trace and never sends the old selected input with its fresh revision', async () => {
  const f = fixture(); await f.client.initialize()
  expect(f.client.current.canInteract).toBe(true)
  const before = clone(f.client.current.session!)
  const oldFrame = clone(f.client.current.operation!.finalFrame)
  // This page selected SW0 off before another page confirmed SW15 on.
  const selectedInputs = { switches: oldFrame.switches.slice(0, 15) + '0', buttons: oldFrame.buttons, resetN: oldFrame.resetN }
  const freshFrame = { ...oldFrame, switches: '1' + oldFrame.switches.slice(1), simTimePs: (BigInt(before.simTimePs) + 10000n).toString() }
  expect(selectedInputs.switches).not.toBe(freshFrame.switches)
  const freshSession: HdlSessionView = { ...before, sessionRevision: before.sessionRevision + 1,
    confirmedSequence: before.confirmedSequence + 1, simTimePs: freshFrame.simTimePs }
  const body = { ...clone(raw.operations.at(-1)), operationId: 'fresh-other-tab-operation',
    sequence: freshSession.confirmedSequence, sessionRevision: freshSession.sessionRevision,
    frames: [freshFrame], finalFrame: freshFrame, sampleCount: 1, droppedFrames: 0, coverage: 'complete' }
  delete body.resultHash
  const freshOperation = { ...body, resultHash: await textHash(JSON.stringify(body)) }
  const commandsBefore = clone([...mocks.rows.values()])
  mocks.get.mockClear()
  mocks.get.mockImplementation(async (path: string) => {
    if (path === `/hdl/sessions/${sid}`) return clone(freshSession)
    if (path.includes('/trace?')) return { operation: { operationId: freshOperation.operationId,
      sequence: freshOperation.sequence, status: 'succeeded', result: clone(freshOperation) }, nextSequence: freshOperation.sequence }
    return f.get(path)
  })

  await f.client.interact(selectedInputs, 1)

  expect(mocks.get).toHaveBeenCalledWith(`/hdl/sessions/${sid}`, expect.anything())
  expect(f.client.current.session).toEqual(freshSession)
  expect(f.client.current.operation).toEqual(freshOperation)
  expect(f.client.current.phase).toBe('blocked')
  expect(f.client.current.notice).toBe('原会话已改变、正在处理或已停止，请重新读取')
  expect(f.client.current.pending).toBe(false)
  expect(f.client.current.unknown).toBe(false)
  expect(mocks.persist).not.toHaveBeenCalled()
  expect(mocks.post).not.toHaveBeenCalled()
  expect([...mocks.rows.values()]).toEqual(commandsBefore)
})
it('stores a late ACK as historical without binding the disposed context', async () => {
  const f = fixture(false); await f.client.initialize()
  let reply!: (value: Receipt) => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  mocks.post.mockImplementation(async (_path: string, wire: string, options: { idempotencyKey: string }) => {
    const r = f.receipt(wire, options.idempotencyKey)
    entered(); return new Promise<Receipt>(resolve => { reply = () => resolve(r) })
  })
  const operation = f.client.build(goldenBuild.request.snapshot.snapshotId)
  await waiting; f.invalidate(); f.client.dispose(); reply({} as Receipt); await operation
  expect([...mocks.rows.values()][0]?.state).toBe('historical')
  expect(f.client.current.build).toBeNull()
})
it('does not let an older Build read overwrite a later accepted state', async () => {
  const f = fixture(); await f.client.initialize()
  let release!: (value: unknown) => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }); let first = true
  mocks.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/hdl/builds/') && first) { first = false; entered(); return new Promise(resolve => { release = resolve }) }
    return f.get(path)
  })
  const old = f.client.read(); await ready; await f.client.read()
  release({ ...clone(goldenBuild), result: null, status: 'queued' }); await old
  expect(f.client.current.build?.status).toBe('succeeded')
  expect(f.client.current.operation?.resultHash).toBe(raw.operations.at(-1).resultHash)
  expect(f.client.current.unknown).toBe(false)
})
