import { createHash, randomUUID } from 'node:crypto'
import { expect, type Page, type Route } from '@playwright/test'
import { REAL_URL } from './env'
import type { ActivityView, AssignmentView, SessionView } from '../src/workspace/contracts'
import type { HdlActivityExecution } from '../src/workspace/hdlActivityContracts'
import type { HdlBuildView, HdlFrame, HdlInputs, HdlOperationResult, HdlSessionView, HdlTraceOperation } from '../src/workspace/hdlContracts'
import type { Receipt, SnapshotView, WorkspaceHead } from '../src/workspace/workspaceContracts'
import type { JobView } from '../src/workspace/runContracts'

/**
 * Isolated public-HTTP protocol fixture for the normal Vite application.
 * It never uses the prep plugin/endpoint and is never loaded by product code.
 * Login, persistence and HDL engine are substitutes here: these tests prove
 * browser wiring and causal state handling, not real TLS/SQLite/PAHER/RTL/model.
 */
export interface HdlFixturePost { path: string; key: string; wire: string; kind: string }
export interface HdlHeldRead { arrived: Promise<void>; completed: Promise<void>; release: () => void }
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const now = () => new Date().toISOString()
const image = `sha256:${'b'.repeat(64)}`
const widths = { clock: 1, switches: 16, buttons: 5, resetN: 1, leds: 16, anodes: 8, segments: 7, dp: 1 } as const

export async function installHdlProtocolFixture(page: Page) {
  const userId = `isolated-student-${randomUUID()}`, courseId = `isolated-hdl-${randomUUID()}`
  const assignmentId = `isolated-hdl-assignment-${randomUUID()}`, activityVersionId = `isolated-hdl-activity-${randomUUID()}`
  const cAssignmentId = `isolated-c-assignment-${randomUUID()}`, cActivityId = `isolated-c-activity-${randomUUID()}`, cCourseId = `isolated-c-${randomUUID()}`
  const generation = `isolated-generation-${randomUUID()}`, csrfToken = `isolated-csrf-${randomUUID()}`
  const loginName = 'isolated-hdl-student', password = randomUUID()
  const configuration: HdlActivityExecution['configuration'] = {
    versionId: 'isolated-hdl-configuration-v1', board: { boardProfileVersion: 'nexys4-ddr-rev-c-v1', mappingVersion: 'isolated-nexys-ddr-v1', topModule: 'top',
      bindings: Object.entries(widths).map(([signal, width]) => ({ signal: signal as keyof typeof widths, offset: 0, port: signal, portOffset: 0, width })) },
    runtime: { runtimeProfileVersion: 'isolated-hdl-runtime-v1', engineVersion: 'isolated-public-protocol-v1', buildImage: image, runtimeImage: image, sourceHash: 'c'.repeat(64) },
    signals: { bitOrder: 'msb_first', clockHz: 100000000, initialClock: '0', initialSwitches: '0000000000000000', initialButtons: '00000', initialResetN: '1',
      stableSampling: 'low_phase', anodesActive: 'low', segmentsActive: 'low', dpActive: 'low' },
    alu: { fixture: 'no ALU grading or decoder' }, structuralCoverage: 'board_bindings_and_defined_alu_domain',
  }
  const execution: HdlActivityExecution = { kind: 'hdl_board', runtimeProfileVersion: configuration.runtime.runtimeProfileVersion,
    configuration, contentHash: sha(JSON.stringify(configuration)) }
  const assignment = (id: string): AssignmentView => ({ assignmentId: id, activityVersionId: id === cAssignmentId ? cActivityId : activityVersionId,
    studentId: userId, assignmentRevision: 1, active: true, status: 'active', reasons: { individual: '', activity: '' }, activityControlRevision: 1 })
  const activity = (isC: boolean): ActivityView => ({ activityVersionId: isC ? cActivityId : activityVersionId, courseId: isC ? cCourseId : courseId,
    activityControlRevision: 1, status: 'active', runtimeProfileVersionId: isC ? 'isolated-c-runtime' : execution.runtimeProfileVersion,
    ...(isC ? {} : { execution }), helpPolicy: { versionId: 'help-v1', helpAllowed: true, wholeSolutionAllowed: false, limitedCheckHelpAllowed: false, description: 'Isolated browser protocol test.' },
    content: { audience: 'student', materials: [], content: { projectTitle: isC ? '隔离 C 工作区' : '隔离 HDL 板卡实验', problem: '编辑、确认并构建，观察原返回信号。',
      audience: '合成开发账号', artifact: isC ? 'C 源码' : 'HDL 源码', studentBackground: '合成验证', timeConstraints: '', routes: ['自行实验'],
      goals: [], tasks: [], observations: [], rubricCriteria: [], milestones: [], helpPolicyVersionId: 'help-v1' } } })
  const sessionView: SessionView = { userId, courses: [{ courseId, role: 'student' }, { courseId: cCourseId, role: 'student' }], csrfToken }
  let signedIn = false, head: WorkspaceHead | null = null, serverSeq = 0, holdInteraction = false, dropNextAck = false
  let stopping: HdlSessionView | null = null
  const builds = new Map<string, HdlBuildView>(), sessions = new Map<string, HdlSessionView>(), results = new Map<string, HdlOperationResult>()
  const jobs = new Map<string, JobView>(), receipts = new Map<string, { wire: string; receipt: Receipt }>()
  const posts: HdlFixturePost[] = [], effects = { builds: 0, programs: 0, interactions: 0, stops: 0 }
  const readCounts = { session: 0, trace: 0, job: 0 }
  let heldSessionRead: { sessionId: string; gate: Promise<void>; arrived: () => void; completed: () => void } | null = null
  const pendingOperations = new Map<string, { jobId: string; sessionId: string; operationId: string; inputs: HdlInputs; cycles: number; sequence: number }>()
  const paths: string[] = []
  const success = (route: Route, data: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ requestId: randomUUID(), data }) })
  const failure = (route: Route, status: number, code: string) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ requestId: randomUUID(), error: { code,
    message: 'Isolated protocol fixture.', retryable: false, recovery: 'Re-read the original object.' } }) })
  const identity = (id: string, receipt: Receipt, c = courseId) => ({ id, commandId: receipt.commandId, requestHash: receipt.requestHash,
    recoveryGeneration: generation, scope: { courseId: c, studentId: userId, attemptId: head!.attempt.attemptId, activityVersionId: head!.attempt.activityVersionId } })
  function makeReceipt(path: string, kind: string, key: string, body: Record<string, unknown>, result: object): Receipt {
    const fields = { ...body }
    if (kind !== 'attempt.create' && kind !== 'hdl.stop') delete fields.recoveryGeneration
    const target = kind === 'attempt.create' ? path.split('/')[3]! : kind.startsWith('hdl.') ? head!.attempt.attemptId : path
    return { receiptId: randomUUID(), commandId: randomUUID(), requestHash: sha(canonical({ target, fields })), result, serverSeq: ++serverSeq,
      committedAt: now(), replayed: false, identity: { actorId: userId, command: kind, target, idempotencyKey: key, recoveryGeneration: generation,
        scope: { courseId: head?.attempt.courseId ?? courseId, studentId: userId, ...(kind === 'attempt.create' ? {} : { attemptId: head!.attempt.attemptId }) },
        ...(kind === 'workspace.sync' ? { sync: { clientId: body.clientId as string, clientSeq: body.clientSeq as number } } : {}) } }
  }
  function job(kind: 'hdl_build' | 'hdl_program' | 'hdl_interact', id: string, receipt: Receipt): JobView {
    const item: JobView = { jobId: String((receipt.result as Record<string, unknown>).jobId), kind, purpose: 'student_run',
      scope: { courseId, studentId: userId, attemptId: head!.attempt.attemptId }, requestReceiptId: receipt.receiptId,
      status: 'succeeded', stopRequested: false, expectedRevision: head!.attempt.attemptRevision, decisionEpoch: 0,
      recoveryGeneration: generation, acceptedAt: now(), deadline: new Date(Date.now() + 60_000).toISOString(), attemptCount: 1, runId: id }
    jobs.set(item.jobId, item)
    return item
  }
  function finishOperation(operation: { jobId: string; sessionId: string; operationId: string; inputs: HdlInputs; cycles: number; sequence: number }) {
    const state = sessions.get(operation.sessionId)!
    const time = (BigInt(state.simTimePs) + BigInt(operation.cycles) * 10000n).toString()
    const frame: HdlFrame = { ...operation.inputs, simTimePs: time, leds: operation.inputs.switches, anodes: '11111100', segments: 'x0z1010', dp: 'z' }
    state.sessionRevision++; state.confirmedSequence = operation.sequence; state.simTimePs = time; delete state.pendingOperationId
    const body = { operationId: operation.operationId, sessionId: state.sessionId, buildId: state.buildId, snapshotId: state.snapshotId,
      snapshotHash: state.snapshotHash, boardProfileVersion: state.boardProfileVersion, mappingVersion: state.mappingVersion,
      engineVersion: state.engineVersion, sequence: state.confirmedSequence, sessionRevision: state.sessionRevision,
      frames: [frame], finalFrame: frame, sampleCount: operation.cycles, droppedFrames: 0, coverage: 'complete' as const }
    results.set(body.operationId, { ...body, resultHash: sha(JSON.stringify(body)) })
    jobs.get(operation.jobId)!.status = 'succeeded'
    pendingOperations.delete(operation.operationId)
  }
  await page.route(`${REAL_URL}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method()
    if (!path.startsWith('/api/') && path !== '/health/ready') return route.continue()
    paths.push(path)
    if (path === '/api/sessions' && method === 'POST') {
      const body = request.postDataJSON()
      if (body.loginName !== loginName || body.password !== password) return failure(route, 401, 'UNAUTHENTICATED')
      signedIn = true
      return success(route, { csrfToken })
    }
    if (path === '/api/session') return signedIn ? success(route, sessionView) : failure(route, 401, 'UNAUTHENTICATED')
    if (!signedIn) return failure(route, 401, 'UNAUTHENTICATED')
    if (path === '/health/ready') return success(route, { status: 'ready' })
    if (path === '/api/execution-nodes' && method === 'GET') return success(route, { nodes: [] })
    if (method === 'GET' && path.match(/^\/api\/assignments\/[^/]+(?:\/bootstrap)?$/)) {
      const id = path.split('/')[3]!
      if (![assignmentId, cAssignmentId].includes(id)) return failure(route, 403, 'FORBIDDEN')
      return success(route, path.endsWith('/bootstrap') ? { assignment: assignment(id), recoveryGeneration: generation } : assignment(id))
    }
    if (method === 'GET' && path.match(/^\/api\/activities\/[^/]+$/)) return success(route, activity(path.endsWith(cActivityId)))
    if (method === 'GET' && path.match(/^\/api\/attempts\/[^/]+$/)) return head ? success(route, { ...head, jobs: [...jobs.values()] }) : failure(route, 422, 'INVALID_REFERENCE')
    if (method === 'GET' && path.endsWith('/teaching-records')) return success(route, { messages: [], actions: [] })
    if (method === 'GET' && path.endsWith('/events')) return success(route, { nextServerSeq: Number(url.searchParams.get('afterServerSeq') ?? 0), hasMore: false, resyncRequired: false, events: [],
      control: { attemptRevision: head!.attempt.attemptRevision, decisionEpoch: 0, captureRevision: 1, generation, status: head!.attempt.status, collecting: true, reminders: true } })
    if (method === 'GET' && /\/snapshots\/[^/]+$/.test(path)) return success(route, head!.snapshots.find(snapshot => path.endsWith(snapshot.snapshotId)))
    if (method === 'GET' && /\/api\/hdl\/builds\/[^/]+$/.test(path)) return success(route, builds.get(path.split('/').at(-1)!))
    if (method === 'GET' && /\/api\/hdl\/sessions\/[^/]+$/.test(path)) {
      readCounts.session++
      const id = path.split('/').at(-1)!, fixed = structuredClone(sessions.get(id))
      const held = heldSessionRead?.sessionId === id ? heldSessionRead : null
      if (held) { heldSessionRead = null; held.arrived(); await held.gate }
      try { return await success(route, fixed) } finally { held?.completed() }
    }
    if (method === 'GET' && /\/api\/hdl\/sessions\/[^/]+\/trace$/.test(path)) {
      readCounts.trace++
      const id = path.split('/')[4]!, cursor = Number(url.searchParams.get('afterSequence'))
      const state = sessions.get(id)!
      const next = [...results.values()].filter(value => value.sessionId === id && value.sequence > cursor).sort((a, b) => a.sequence - b.sequence)[0]
      const pending = [...pendingOperations.values()].find(value => value.sessionId === id && value.sequence > cursor)
      const operation: HdlTraceOperation | null = next ? { operationId: next.operationId, sequence: next.sequence, status: 'succeeded', result: next }
        : pending ? { operationId: pending.operationId, sequence: pending.sequence, status: 'running', result: null } : null
      expect(state).toBeDefined()
      return success(route, { operation, nextSequence: next?.sequence ?? cursor })
    }
    if (method === 'GET' && /\/api\/jobs\/[^/]+$/.test(path)) { readCounts.job++; return success(route, jobs.get(path.split('/').at(-1)!)) }
    if (method !== 'POST') return failure(route, 422, 'INVALID_REFERENCE')
    const body = request.postDataJSON() as Record<string, unknown>, key = request.headers()['idempotency-key']!
    if (!key || request.headers()['x-csrf-token'] !== csrfToken || body.recoveryGeneration !== generation) return failure(route, 403, 'FORBIDDEN')
    // Explicit model-disabled public refusal. No accepted message, generated AI
    // body, C3 basis or receipt is invented by this browser protocol substitute.
    if (/^\/api\/attempts\/[^/]+\/help$/.test(path)) {
      posts.push({ path, key, wire: request.postData()!, kind: 'help' })
      return failure(route, 429, 'BUDGET_EXHAUSTED')
    }
    const kind = path.endsWith('/sync') ? 'workspace.sync' : path.endsWith('/snapshots') ? 'snapshot.create'
      : path.endsWith('/hdl/builds') ? 'hdl.build' : path.endsWith('/hdl/programs') ? 'hdl.program'
        : path.endsWith('/hdl/interactions') ? 'hdl.interact' : path.endsWith('/hdl/controls') ? 'hdl.stop'
          : /^\/api\/assignments\/[^/]+\/attempts$/.test(path) ? 'attempt.create' : null
    if (!kind) return failure(route, 422, 'INVALID_REFERENCE')
    const wire = request.postData()!, previous = receipts.get(key)
    posts.push({ path, key, wire, kind })
    if (previous) return previous.wire === wire ? success(route, { ...previous.receipt, replayed: true }) : failure(route, 409, 'IDEMPOTENCY_CONFLICT')
    let receipt: Receipt
    if (kind === 'attempt.create') {
      const isC = path.split('/')[3] === cAssignmentId
      head = { attempt: { attemptId: randomUUID(), courseId: isC ? cCourseId : courseId, studentId: userId,
        assignmentId: isC ? cAssignmentId : assignmentId, activityVersionId: isC ? cActivityId : activityVersionId, status: 'ready', attemptRevision: 1,
        workspaceRevision: 0, decisionEpoch: 0, captureRevision: 1, collecting: true, reminders: true }, files: [], snapshots: [], jobs: [], runs: [], checks: [], limitedCheck: false }
      receipt = makeReceipt(path, kind, key, body, { attemptId: head.attempt.attemptId, assignmentId: head.attempt.assignmentId, activityVersionId: head.attempt.activityVersionId })
    } else if (kind === 'workspace.sync') {
      expect(body.expectedWorkspaceRevision).toBe(head!.attempt.workspaceRevision)
      const created: Record<string, string> = {}
      for (const operation of body.operations as Array<{ kind: string; clientFileKey?: string; fileId?: string; path?: string; text?: string; baseVersion?: number }>) {
        if (operation.kind === 'create') {
          const id = randomUUID(); created[operation.clientFileKey!] = id
          head!.files.push({ fileId: id, path: operation.path!, text: operation.text!, contentHash: sha(operation.text!), documentVersion: 1, lifecycle: 'active', attemptId: head!.attempt.attemptId })
        } else {
          const file = head!.files.find(item => item.fileId === operation.fileId)!
          expect(operation.baseVersion).toBe(file.documentVersion)
          if (operation.kind === 'update') { file.text = operation.text!; file.contentHash = sha(file.text) }
          else file.lifecycle = operation.kind === 'recycle' ? 'recycled' : 'active'
          file.documentVersion++
        }
      }
      head!.attempt.workspaceRevision++; head!.attempt.attemptRevision++; head!.attempt.status = 'active'
      receipt = makeReceipt(path, kind, key, body, { workspaceRevision: head!.attempt.workspaceRevision,
        files: head!.files.map(({ text: _text, attemptId: _attemptId, ...file }) => file), created, process: { status: 'not_collected', reason: 'not_requested' } })
    } else if (kind === 'snapshot.create') {
      expect(body.expectedWorkspaceRevision).toBe(head!.attempt.workspaceRevision)
      const files = head!.files.filter(file => file.lifecycle === 'active').map(({ lifecycle: _lifecycle, attemptId: _attemptId, ...file }) => file)
      const snapshot: SnapshotView = { snapshotId: randomUUID(), attemptId: head!.attempt.attemptId, activityVersionId, workspaceRevision: head!.attempt.workspaceRevision,
        hashFormat: 'sha256-manifest-v1', hash: sha(JSON.stringify([...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map(file => [file.fileId, file.path, file.documentVersion, file.contentHash]))),
        files, createdAt: now() }
      head!.snapshots.push(snapshot)
      receipt = makeReceipt(path, kind, key, body, { snapshotId: snapshot.snapshotId, snapshotHash: snapshot.hash, workspaceRevision: snapshot.workspaceRevision })
    } else {
      expect(body.expectedAttemptRevision).toBe(head!.attempt.attemptRevision)
      if (kind === 'hdl.build') {
        const buildId = randomUUID(), jobId = randomUUID(), snapshot = head!.snapshots.find(value => value.snapshotId === body.snapshotId)!
        expect(snapshot).toBeDefined()
        receipt = makeReceipt(path, kind, key, body, { buildId, jobId })
        const source = snapshot.files.find(file => file.path === 'top.sv')!, failed = source.text.includes('assign led = ;')
        const request = { identity: identity(buildId, receipt), snapshot: structuredClone(snapshot), board: configuration.board, runtimeProfileVersion: execution.runtimeProfileVersion }
        builds.set(buildId, { request, result: { buildId, identity: request.identity, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.hash,
          board: configuration.board, runtimeProfileVersion: execution.runtimeProfileVersion, engineVersion: configuration.runtime.engineVersion,
          imageDigest: image, configurationHash: sha(JSON.stringify(configuration.board)), status: failed ? 'failed' : 'succeeded', terminationConfirmed: true,
          ...(failed ? { failureKind: 'compile_error' } : { artifactHash: sha(source.text) }), stdout: '', stderr: failed ? 'top.sv:3: syntax error' : '',
          diagnostics: failed ? [{ severity: 'error', message: 'syntax error', fileId: source.fileId, path: source.path, line: 3, location: 'line-only' }] : [] }, status: failed ? 'failed' : 'succeeded', jobId })
        job('hdl_build', buildId, receipt); effects.builds++
      } else if (kind === 'hdl.program') {
        const build = builds.get(String(body.buildId))!
        expect(build.result!.status).toBe('succeeded')
        const sessionId = randomUUID(), jobId = randomUUID()
        receipt = makeReceipt(path, kind, key, body, { sessionId, operationId: sessionId, jobId })
        const state: HdlSessionView = { sessionId, identity: identity(sessionId, receipt), buildId: String(body.buildId), snapshotId: build.request.snapshot.snapshotId,
          snapshotHash: build.request.snapshot.hash, boardProfileVersion: configuration.board.boardProfileVersion, mappingVersion: configuration.board.mappingVersion,
          engineVersion: configuration.runtime.engineVersion, runtimeProfileVersion: execution.runtimeProfileVersion, sessionRevision: 1, confirmedSequence: 0,
          simTimePs: '0', status: 'active', terminationConfirmed: false, stopRequested: false, createdAt: now(), deadline: new Date(Date.now() + 1800000).toISOString(), lastOperationAt: now() }
        sessions.set(sessionId, state)
        const frame: HdlFrame = { switches: '0'.repeat(16), buttons: '00000', resetN: '1', simTimePs: '0', leds: '0'.repeat(16), anodes: '11111110', segments: '1111111', dp: '1' }
        const output = { operationId: sessionId, sessionId, buildId: state.buildId, snapshotId: state.snapshotId, snapshotHash: state.snapshotHash, boardProfileVersion: state.boardProfileVersion,
          mappingVersion: state.mappingVersion, engineVersion: state.engineVersion, sequence: 0, sessionRevision: 1, frames: [frame], finalFrame: frame, sampleCount: 1, droppedFrames: 0, coverage: 'complete' as const }
        results.set(sessionId, { ...output, resultHash: sha(JSON.stringify(output)) }); job('hdl_program', sessionId, receipt); effects.programs++
      } else if (kind === 'hdl.interact') {
        const sessionId = String(body.sessionId), state = sessions.get(sessionId)!
        expect(body.expectedSessionRevision).toBe(state.sessionRevision); expect(body.expectedSequence).toBe(state.confirmedSequence + 1)
        expect(state.pendingOperationId).toBeUndefined(); expect(state.stopRequested).toBe(false)
        const operationId = randomUUID(), jobId = randomUUID()
        receipt = makeReceipt(path, kind, key, body, { sessionId, operationId, jobId }); job('hdl_interact', operationId, receipt)
        const operation = { sessionId, operationId, jobId, inputs: body.inputs as HdlInputs, cycles: Number(body.advanceCycles), sequence: Number(body.expectedSequence) }
        effects.interactions++
        if (holdInteraction) { state.pendingOperationId = operationId; jobs.get(jobId)!.status = 'running'; pendingOperations.set(operationId, operation) }
        else finishOperation(operation)
      } else {
        receipt = makeReceipt(path, kind, key, body, { attemptId: head!.attempt.attemptId, stopRequested: true })
        stopping = [...sessions.values()].at(-1)!
        stopping.stopRequested = true; stopping.status = 'stopping'; effects.stops++
      }
    }
    receipts.set(key, { wire, receipt })
    if (dropNextAck && kind === 'hdl.interact') { dropNextAck = false; return route.abort('failed') }
    return success(route, receipt)
  })
  return { isolated: true as const, url: `${REAL_URL}/#/task/${assignmentId}`, cUrl: `${REAL_URL}/#/task/${cAssignmentId}`,
    loginName, password, paths, posts, effects, readCounts, get head() { return head }, get sessions() { return [...sessions.values()] }, get builds() { return [...builds.values()] },
    holdInputs(value: boolean) { holdInteraction = value }, dropInteractionAck() { dropNextAck = true },
    finishInputs() { for (const operation of [...pendingOperations.values()]) finishOperation(operation) },
    confirmStop() { if (stopping) { stopping.status = 'stopped'; stopping.terminationConfirmed = true; stopping.sessionRevision++ } },
    holdNextSessionRead(sessionId: string): HdlHeldRead {
      if (heldSessionRead || !sessions.has(sessionId)) throw new Error('Isolated original Session required')
      let arrive!: () => void, complete!: () => void, release!: () => void
      const arrived = new Promise<void>(resolve => { arrive = resolve })
      const completed = new Promise<void>(resolve => { complete = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      heldSessionRead = { sessionId, gate, arrived: arrive, completed: complete }
      return { arrived, completed, release }
    },
  }
}
