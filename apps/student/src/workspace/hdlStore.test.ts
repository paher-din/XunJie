import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { freezeHdl, hdlCanonical, verifyHdlBuild, verifyHdlCommand, verifyHdlInputs, verifyHdlOperationCommand, verifyHdlReceipt, verifyHdlSession, verifyHdlTrace } from './hdlStore'
import { textHash } from './confirmation'
import type { CommandContext, OutboxRecord } from './frozenCommand'
import type { HdlJobView, HdlRuntimeProfile, HdlSessionView } from './hdlContracts'

// Archived server/real-node responses are protocol evidence, not a new live acceptance run.
const evidence = JSON.parse(readFileSync(new URL('../../../../docs/tasks/evidence/dla-continuation-20261014/real-hdl-final-frozen.json', import.meta.url), 'utf8'))
type Http = { method: string; path: string; body: { data: Record<string, unknown> } }
const http: Http[] = evidence.http
const context: CommandContext = { mode: 'real', preparationEpoch: null, trustedRecoveryGeneration: evidence.generation, loadEpoch: 1,
  userId: evidence.objects.studentId, courseId: evidence.objects.courseId, activityVersionId: evidence.objects.activityVersionId,
  assignmentId: evidence.objects.assignmentId, attemptId: evidence.objects.attemptId }
const successful = http.filter(r => r.path.startsWith('/api/hdl/builds/') && r.body.data.status === 'succeeded').at(-1)!.body.data
const buildId = evidence.successfulBuild.buildId
const result = successful.result as Record<string, unknown>, mapping = result.board as Record<string, unknown>
const profile: HdlRuntimeProfile = { runtimeProfileVersion: String(result.runtimeProfileVersion), engineVersion: String(result.engineVersion),
  boardProfileVersion: String(mapping.boardProfileVersion), mappingVersion: String(mapping.mappingVersion), buildImage: String(result.imageDigest), recoveryGeneration: evidence.generation }
const stopped = http.filter(r => r.path === `/api/hdl/sessions/${evidence.session.sessionId}`).at(-1)!.body.data
const active = http.filter(r => r.path === `/api/hdl/sessions/${evidence.session.sessionId}` && r.body.data.status === 'active').at(-1)!.body.data
const clone = <T,>(v: T): T => structuredClone(v)
const ack = (command: OutboxRecord) => ({ receiptId: 'r', commandId: 'c', serverSeq: 1, committedAt: '2026-10-14T00:00:00Z', replayed: false,
  requestHash: command.requestHash, identity: { actorId: context.userId!, command: command.kind, target: command.target,
    idempotencyKey: command.commandKey, recoveryGeneration: context.trustedRecoveryGeneration!,
    scope: { courseId: context.courseId, studentId: context.userId!, attemptId: context.attemptId! } },
  result: { sessionId: 's', operationId: 'op', jobId: 'j' } })
function nodeJob(kind: HdlJobView['kind'], runId: string, jobId: string): HdlJobView {
  return { jobId, kind, runId, purpose: 'student_run', scope: { courseId: context.courseId, studentId: context.userId!, attemptId: context.attemptId! },
    requestReceiptId: 'original-receipt', recoveryGeneration: context.trustedRecoveryGeneration!, status: 'succeeded', stopRequested: false,
    expectedRevision: 1, decisionEpoch: 0, attemptCount: 1, acceptedAt: '2026-10-14T00:00:00Z', deadline: '2026-10-14T01:00:00Z',
    execution: { nodeId: 'robert', nodeGeneration: 'node-generation' } }
}

describe('existing HDL HTTP protocol and immutable result provenance', () => {
  it('requires the original authorized Job binding for a node generation different from the business generation', async () => {
    const value = clone(successful) as unknown as import('./hdlContracts').HdlBuildView
    value.request.identity.recoveryGeneration = 'node-generation'
    value.result!.identity.recoveryGeneration = 'node-generation'
    const job = nodeJob('hdl_build', buildId, value.jobId)
    const build = await verifyHdlBuild(value, context, buildId, profile, null, job)
    expect(build.execution).toEqual(job.execution)
    await expect(verifyHdlBuild(value, context, buildId, profile)).rejects.toThrow('身份或代际')
    await expect(verifyHdlBuild(value, context, buildId, profile, null, { ...job, execution: { nodeId: 'robert', nodeGeneration: 'another-node-generation' } })).rejects.toThrow()
    await expect(verifyHdlBuild(value, context, buildId, profile, null, { ...job, recoveryGeneration: 'wrong-business-generation' })).rejects.toThrow('业务代际')
    await expect(verifyHdlBuild(value, context, buildId, profile, null, { ...job, runId: 'another-build' })).rejects.toThrow()
    const session = clone(active) as unknown as HdlSessionView
    session.identity.recoveryGeneration = 'node-generation'
    const program = nodeJob('hdl_program', session.sessionId, 'program-job')
    const verified = verifyHdlSession(session, context, session.sessionId, build, profile, program)
    expect(verified.identity.recoveryGeneration).toBe('node-generation')
    expect(() => verifyHdlSession(session, context, session.sessionId, build, profile)).toThrow()
    expect(() => verifyHdlSession(session, context, session.sessionId, build, profile, { ...program, execution: { nodeId: 'member', nodeGeneration: 'node-generation' } })).toThrow('执行节点')
    const operation = evidence.operations.at(-1)
    expect((await verifyHdlTrace({ operation: { operationId: operation.operationId, sequence: operation.sequence, status: 'succeeded', result: operation }, nextSequence: operation.sequence },
      verified, operation.sequence - 1)).operation?.result?.resultHash).toBe(operation.resultHash)
  })
  it('uses the actual Attempt target and route-specific hash fields', async () => {
    const build = await freezeHdl(context, 'hdl.build', { expectedAttemptRevision: 2, snapshotId: 'snapshot' })
    expect(build.path).toBe(`/attempts/${context.attemptId}/hdl/builds`)
    expect(build.target).toBe(context.attemptId)
    expect(build.requestHash).toBe(await textHash(hdlCanonical({ target: context.attemptId, fields: { expectedAttemptRevision: 2, snapshotId: 'snapshot' } })))
    const stop = await freezeHdl(context, 'hdl.stop', { expectedAttemptRevision: 2, action: 'stop', reason: 'Explicit stop' })
    expect(stop.requestHash).toBe(await textHash(hdlCanonical({ target: context.attemptId, fields: JSON.parse(stop.wireJson) })))
    expect(stop.path).toBe(`/attempts/${context.attemptId}/hdl/controls`)
    expect(JSON.parse(stop.wireJson)).not.toHaveProperty('sessionId')
  })
  it('rejects another key/scope/hash/session in the command receipt', async () => {
    const command: OutboxRecord = { ...await freezeHdl(context, 'hdl.interact', { expectedAttemptRevision: 2, sessionId: 's',
      expectedSessionRevision: 1, expectedSequence: 1, inputs: { switches: '0'.repeat(16), buttons: '00000', resetN: '1' }, advanceCycles: 1 }), state: 'pending' }
    expect(verifyHdlReceipt(command, ack(command)).result.sessionId).toBe('s')
    expect(() => verifyHdlReceipt(command, { ...ack(command), requestHash: 'a'.repeat(64) })).toThrow()
    expect(() => verifyHdlReceipt(command, { ...ack(command), identity: { ...ack(command).identity, idempotencyKey: 'other' } })).toThrow()
    expect(() => verifyHdlReceipt(command, { ...ack(command), result: { sessionId: 'other', operationId: 'op', jobId: 'j' } })).toThrow()
    expect(() => verifyHdlReceipt(command, { ...ack(command), identity: { ...ack(command).identity, scope: { courseId: 'other' } } })).toThrow()
  })
  it('rejects modified durable wire and nonapproved paths before replay', async () => {
    const command = await freezeHdl(context, 'hdl.build', { expectedAttemptRevision: 2, snapshotId: 'snapshot' })
    await expect(verifyHdlCommand(command)).resolves.toBeUndefined()
    await expect(verifyHdlCommand({ ...command, wireJson: command.wireJson.replace('snapshot', 'changed') })).rejects.toThrow()
    await expect(verifyHdlCommand({ ...command, path: '/hdl/operations/not-a-route' })).rejects.toThrow()
  })
  it('accepts actual failed and succeeded server Builds including exact snapshot bytes', async () => {
    for (const response of http.filter(r => r.path.startsWith('/api/hdl/builds/') && r.body.data.result !== null)) {
      const id = response.path.split('/').at(-1)!
      const value = await verifyHdlBuild(response.body.data, context, id, profile)
      expect(value.request.snapshot.hash).toHaveLength(64)
      if (value.status === 'failed') expect(value.result?.diagnostics.some(d => d.line === 5 && d.location === 'line-only')).toBe(true)
    }
  })
  it('does not treat queued/null as a successful Build and rejects malformed missing result', async () => {
    const request = clone(successful)
    request.status = 'queued'; request.result = null
    expect((await verifyHdlBuild(request, context, buildId, profile)).result).toBeNull()
    delete request.result
    await expect(verifyHdlBuild(request, context, buildId, profile)).rejects.toThrow()
  })
  it('rejects stale scope/generation, altered snapshot text and unapproved profile', async () => {
    const tampered = clone(successful)
    const req = tampered.request as { snapshot: { files: Array<{ text: string }> }; identity: { scope: { studentId: string } } }
    req.snapshot.files[0]!.text += '\n'
    await expect(verifyHdlBuild(tampered, context, buildId, profile)).rejects.toThrow()
    const stranger = clone(successful)
    ;(stranger.request as typeof req).identity.scope.studentId = 'someone-else'
    await expect(verifyHdlBuild(stranger, context, buildId, profile)).rejects.toThrow()
    await expect(verifyHdlBuild(successful, { ...context, trustedRecoveryGeneration: 'other' }, buildId, profile)).rejects.toThrow()
    await expect(verifyHdlBuild(successful, context, buildId, { ...profile, mappingVersion: 'other' })).rejects.toThrow()
  })
  it('reads actual active and stopped Sessions without relabeling old output current', async () => {
    const build = await verifyHdlBuild(successful, context, buildId, profile)
    const session = verifyHdlSession(stopped, context, evidence.session.sessionId, build, profile)
    expect(session.terminationConfirmed).toBe(true)
    expect(session.sessionRevision).toBeGreaterThan(evidence.operations.at(-1).sessionRevision)
    verifyHdlSession(active, context, evidence.session.sessionId, build, profile)
    for (const operation of evidence.operations) {
      const trace = { operation: { operationId: operation.operationId, sequence: operation.sequence, status: 'succeeded', result: operation }, nextSequence: operation.sequence }
      expect((await verifyHdlTrace(trace, session, operation.sequence - 1)).operation?.result?.resultHash).toBe(operation.resultHash)
    }
  })
  it('preserves four-state bits and exact big simulation time; detects a recomputed cross-object forgery', async () => {
    const build = await verifyHdlBuild(successful, context, buildId, profile)
    const session = verifyHdlSession(active, context, evidence.session.sessionId, build, profile)
    const operation = clone(evidence.operations.at(-1))
    operation.frames.at(-1).segments = 'x0z1010'; operation.finalFrame.segments = 'x0z1010'
    operation.frames.at(-1).simTimePs = '90071992547409930000'; operation.finalFrame.simTimePs = '90071992547409930000'
    const changed: HdlSessionView = { ...session, simTimePs: '90071992547409930000' }
    const { resultHash: _old, ...body } = operation
    operation.resultHash = await textHash(JSON.stringify(body))
    const trace = { operation: { operationId: operation.operationId, sequence: operation.sequence, status: 'succeeded', result: operation }, nextSequence: operation.sequence }
    expect((await verifyHdlTrace(trace, changed, operation.sequence - 1)).operation?.result?.finalFrame.segments).toBe('x0z1010')
    operation.sessionId = 'other'
    const { resultHash: _changed, ...cross } = operation
    operation.resultHash = await textHash(JSON.stringify(cross))
    await expect(verifyHdlTrace(trace, changed, operation.sequence - 1)).rejects.toThrow()
  })
  it('keeps pending/null cursor unchanged and refuses forged advance', async () => {
    const session = stopped as unknown as HdlSessionView
    const pending = { operation: { operationId: 'pending', sequence: 3, status: 'queued', result: null }, nextSequence: 2 }
    expect((await verifyHdlTrace(pending, session, 2)).nextSequence).toBe(2)
    await expect(verifyHdlTrace({ ...pending, nextSequence: 3 }, session, 2)).rejects.toThrow()
    await expect(verifyHdlTrace({ operation: null, nextSequence: 3 }, session, 2)).rejects.toThrow()
  })
  it('binds an acknowledged operation to its original sequence/revision/input without relabeling later results', async () => {
    const operation = clone(evidence.operations.at(-1))
    const body = { expectedAttemptRevision: 3, sessionId: operation.sessionId, expectedSessionRevision: operation.sessionRevision - 1,
      expectedSequence: operation.sequence, inputs: { switches: operation.finalFrame.switches, buttons: operation.finalFrame.buttons, resetN: operation.finalFrame.resetN }, advanceCycles: 4 }
    const command: OutboxRecord = { ...await freezeHdl(context, 'hdl.interact', body), state: 'confirmed' }
    command.receipt = { ...ack(command), result: { sessionId: operation.sessionId, operationId: operation.operationId, jobId: 'j' } }
    await expect(verifyHdlOperationCommand(operation, command)).resolves.toBeUndefined()
    const wrong: OutboxRecord = { ...await freezeHdl(context, 'hdl.interact', { ...body, inputs: { ...body.inputs, buttons: '10000' } }), state: 'confirmed' }
    wrong.receipt = { ...ack(wrong), result: { sessionId: operation.sessionId, operationId: operation.operationId, jobId: 'j' } }
    await expect(verifyHdlOperationCommand(operation, wrong)).rejects.toThrow()
  })
  it('accepts compressed unchanged samples but preserves dropped-frame coverage', async () => {
    const operation = clone(evidence.operations.at(-1)), session = stopped as unknown as HdlSessionView
    operation.sampleCount = 100; operation.droppedFrames = 20; operation.coverage = 'incomplete'
    const { resultHash: _hash, ...body } = operation
    operation.resultHash = await textHash(JSON.stringify(body))
    const trace = { operation: { operationId: operation.operationId, sequence: operation.sequence, status: 'succeeded', result: operation }, nextSequence: operation.sequence }
    expect((await verifyHdlTrace(trace, session, operation.sequence - 1)).operation?.result?.droppedFrames).toBe(20)
    operation.coverage = 'complete'
    const { resultHash: _old, ...wrong } = operation
    operation.resultHash = await textHash(JSON.stringify(wrong))
    await expect(verifyHdlTrace(trace, session, operation.sequence - 1)).rejects.toThrow()
  })
  it('rejects nonbinary/X input, extra fields and wrong widths before any HTTP', () => {
    expect(verifyHdlInputs({ switches: '0'.repeat(16), buttons: '00000', resetN: '1' }).resetN).toBe('1')
    expect(() => verifyHdlInputs({ switches: '0'.repeat(15) + 'x', buttons: '00000', resetN: '1' })).toThrow()
    expect(() => verifyHdlInputs({ switches: '0'.repeat(16), buttons: '0000', resetN: '1' })).toThrow()
    expect(() => verifyHdlInputs({ switches: '0'.repeat(16), buttons: '00000', resetN: '1', shell: 'none' })).toThrow()
  })
})
