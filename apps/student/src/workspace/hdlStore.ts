import { confirmationRepository, sameGeneration } from './confirmationDb'
import type { CommandContext, FrozenCommand, OutboxRecord } from './frozenCommand'
import type { Receipt, SnapshotView } from './workspaceContracts'
import type { HdlSignal, HdlBoardProfile, HdlIdentity, HdlInputs, HdlFrame, HdlCommandKind, HdlCreated, HdlRuntimeProfile, HdlJobView, HdlBuildView, HdlSessionView, HdlTraceView } from './hdlContracts'
import { record, requiredId, revision, textHash, verifySnapshot } from './confirmation'
import type { ApiErrorCode } from './contracts'

/** One existing outbox/lease/ACK transaction; no new IndexedDB store or schema. */
export const hdlStore = {
  async commands(c: CommandContext): Promise<OutboxRecord[]> {
    const rows = await confirmationRepository.commands(c)
    return rows.filter(row => isHdlCommand(row) && row.context.attemptId === c.attemptId)
      .sort((a, b) => a.createdAt - b.createdAt || a.commandKey.localeCompare(b.commandKey))
  },
  pending(rows: OutboxRecord[]): OutboxRecord[] { return rows.filter(row => row.state === 'pending') },
  confirmed(rows: OutboxRecord[], c: CommandContext): OutboxRecord[] {
    return rows.filter(row => row.state === 'confirmed' && row.receipt && sameGeneration(row.context, c))
      .map(row => { verifyHdlReceipt(row, row.receipt); return row })
  },
  persist(command: FrozenCommand, valid: () => boolean) { return confirmationRepository.persist(command, valid) },
  claim(key: string, owner: string, valid: () => boolean) { return confirmationRepository.claim(key, owner, valid) },
  command(key: string) { return confirmationRepository.command(key) },
  authority(c: CommandContext) { return confirmationRepository.isCurrentAuthority(c) },
  release(key: string, owner: string) { return confirmationRepository.release(key, owner) },
  acknowledge(command: FrozenCommand, receipt: Receipt, valid: () => boolean) {
    return confirmationRepository.acknowledge(command, receipt, null, {}, null, valid)
  },
  rejection(key: string, code: ApiErrorCode, owner: string, replay: boolean) {
    return replay ? confirmationRepository.noteRejection(key, code, owner) : confirmationRepository.rejectRun(key, code, owner)
  },
}

export const hdlSettled = (status: string): boolean => ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)
export const isHdlCommand = (value: FrozenCommand): boolean => ['hdl.build', 'hdl.program', 'hdl.interact', 'hdl.stop'].includes(value.kind)
export function hdlCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(hdlCanonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${hdlCanonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value)
}
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('HDL 摘要不合法')
  return value
}
const bool = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new Error('HDL 状态不完整'); return value }
const simTime = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{1,32}$/.test(value)) throw new Error('模拟时间不完整')
  return value
}
const bits = (value: unknown, width: number, four = true): string => {
  if (typeof value !== 'string' || !new RegExp(`^[${four ? '01xz' : '01'}]{${width}}$`).test(value)) throw new Error('板卡信号宽度或四态值不合法')
  return value
}
const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled', 'stale', 'timed_out', 'outcome_unknown']
const buildStatuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown']
const sessionStatuses = ['starting', 'active', 'stopping', 'stopped', 'failed', 'outcome_unknown']
export function verifyHdlInputs(value: unknown): HdlInputs {
  const row = record(value)
  if (Object.keys(row).some(k => !['switches', 'buttons', 'resetN'].includes(k))) throw new Error('只能发送已批准的板卡输入')
  return { switches: bits(row.switches, 16, false), buttons: bits(row.buttons, 5, false), resetN: bits(row.resetN, 1, false) }
}
function frame(value: unknown): HdlFrame {
  const f = record(value)
  simTime(f.simTimePs)
  for (const [key, width] of [['switches', 16], ['buttons', 5], ['resetN', 1], ['leds', 16], ['anodes', 8], ['segments', 7], ['dp', 1]] as const) bits(f[key], width)
  return structuredClone(f) as unknown as HdlFrame
}
function identity(value: unknown, c: CommandContext, id: string, generation = c.trustedRecoveryGeneration): HdlIdentity {
  const i = record(value), s = record(i.scope)
  if (i.id !== id || s.courseId !== c.courseId || s.studentId !== c.userId || s.attemptId !== c.attemptId ||
    s.activityVersionId !== c.activityVersionId || i.recoveryGeneration !== generation) throw new Error('HDL 对象身份或代际不符')
  requiredId(i.commandId); hash(i.requestHash)
  return structuredClone(i) as unknown as HdlIdentity
}
function board(value: unknown): HdlBoardProfile {
  const b = record(value), widths: Record<HdlSignal, number> = { clock: 1, switches: 16, buttons: 5, resetN: 1, leds: 16, anodes: 8, segments: 7, dp: 1 }
  requiredId(b.boardProfileVersion); requiredId(b.mappingVersion); requiredId(b.topModule)
  if (!Array.isArray(b.bindings) || b.bindings.length < 1 || b.bindings.length > 128) throw new Error('板卡映射不完整')
  const mapped = new Set<string>(), ports = new Set<string>()
  for (const item of b.bindings) {
    const v = record(item), signal = v.signal as HdlSignal
    if (!Object.hasOwn(widths, signal)) throw new Error('未知板卡信号')
    requiredId(v.port); const offset = revision(v.offset), portOffset = revision(v.portOffset), width = revision(v.width, 1)
    if (offset + width > widths[signal] || width > 16) throw new Error('板卡映射越界')
    for (let n = 0; n < width; n++) {
      const key = `${signal}:${offset + n}`, port = `${v.port}:${portOffset + n}`
      if (mapped.has(key) || ports.has(port)) throw new Error('板卡映射重叠')
      mapped.add(key); ports.add(port)
    }
  }
  for (const signal of ['clock', 'switches', 'leds', 'anodes', 'segments', 'dp'] as const)
    for (let n = 0; n < widths[signal]; n++) if (!mapped.has(`${signal}:${n}`)) throw new Error('板卡映射缺少必需信号')
  return structuredClone(b) as unknown as HdlBoardProfile
}
export async function freezeHdl(c: CommandContext, kind: HdlCommandKind, body: Record<string, unknown>, snapshot?: SnapshotView): Promise<FrozenCommand> {
  if (!c.userId || !c.attemptId || !c.assignmentId || !c.activityVersionId || !c.trustedRecoveryGeneration) throw new Error('当前身份、尝试或代际尚未确认')
  const suffix = { 'hdl.build': 'builds', 'hdl.program': 'programs', 'hdl.interact': 'interactions', 'hdl.stop': 'controls' }[kind]
  const wire = { ...structuredClone(body), recoveryGeneration: c.trustedRecoveryGeneration }
  const fields: Record<string, unknown> = { ...wire }
  // The existing stop route hashes its full validated input; other HDL routes strip generation.
  if (kind !== 'hdl.stop') delete fields.recoveryGeneration
  return { commandKey: crypto.randomUUID(), context: c, kind, path: `/attempts/${encodeURIComponent(c.attemptId)}/hdl/${suffix}`,
    target: c.attemptId, wireJson: JSON.stringify(wire), requestHash: await textHash(hdlCanonical({ target: c.attemptId, fields })),
    createdAt: Date.now(), before: null, drafts: [], ...(snapshot ? { hdlSnapshot: structuredClone(snapshot) } : {}) }
}
/** Recheck the durable wire, not only a receipt's copy of its hash. Never send an edited original command. */
export async function verifyHdlCommand(command: FrozenCommand): Promise<void> {
  const body = record(JSON.parse(command.wireJson)), c = command.context
  const suffix: Record<string, string> = { 'hdl.build': 'builds', 'hdl.program': 'programs', 'hdl.interact': 'interactions', 'hdl.stop': 'controls' }
  if (!isHdlCommand(command) || !c.attemptId || command.target !== c.attemptId ||
    command.path !== `/attempts/${encodeURIComponent(c.attemptId)}/hdl/${suffix[command.kind]}` || body.recoveryGeneration !== c.trustedRecoveryGeneration) throw new Error('原 HDL 请求路径、归属或代际不符')
  revision(body.expectedAttemptRevision, 1)
  const allowed = ['recoveryGeneration', 'expectedAttemptRevision']
  if (command.kind === 'hdl.build') { allowed.push('snapshotId'); requiredId(body.snapshotId) }
  else if (command.kind === 'hdl.program') {
    allowed.push('buildId', 'replaceSessionId', 'expectedSessionRevision'); requiredId(body.buildId)
    if ((body.replaceSessionId === undefined) !== (body.expectedSessionRevision === undefined)) throw new Error('替换会话版本必须成对')
    if (body.replaceSessionId !== undefined) { requiredId(body.replaceSessionId); revision(body.expectedSessionRevision, 1) }
  } else if (command.kind === 'hdl.interact') {
    allowed.push('sessionId', 'expectedSessionRevision', 'expectedSequence', 'inputs', 'advanceCycles')
    requiredId(body.sessionId); revision(body.expectedSessionRevision, 1); revision(body.expectedSequence, 1); verifyHdlInputs(body.inputs)
    if (revision(body.advanceCycles, 1) > 5000000) throw new Error('推进周期超过已批准上限')
  } else {
    allowed.push('action', 'reason')
    if (body.action !== 'stop' || typeof body.reason !== 'string' || body.reason !== body.reason.trim() || !body.reason || body.reason.length > 1024) throw new Error('停止请求不合法')
  }
  if (Object.keys(body).some(k => !allowed.includes(k))) throw new Error('原 HDL 请求有额外字段')
  const fields = { ...body }; if (command.kind !== 'hdl.stop') delete fields.recoveryGeneration
  if (command.requestHash !== await textHash(hdlCanonical({ target: c.attemptId, fields }))) throw new Error('原 HDL 请求正文摘要不符')
}
export function verifyHdlReceipt(command: FrozenCommand, value: unknown): Receipt<HdlCreated> {
  if (!isHdlCommand(command)) throw new Error('缺少原 HDL 命令')
  const r = record(value), i = record(r.identity), scope = record(i.scope), c = command.context
  requiredId(r.receiptId); requiredId(r.commandId); revision(r.serverSeq, 1)
  // HDL exposes the original Receipt; unlike the C run routes, replayed may be absent.
  if (command.target !== c.attemptId || i.actorId !== c.userId || i.command !== command.kind || i.target !== command.target ||
    i.idempotencyKey !== command.commandKey || i.recoveryGeneration !== c.trustedRecoveryGeneration ||
    scope.courseId !== c.courseId || scope.studentId !== c.userId || scope.attemptId !== c.attemptId ||
    r.requestHash !== command.requestHash || r.replayed !== undefined && typeof r.replayed !== 'boolean' ||
    typeof r.committedAt !== 'string' || !Number.isFinite(Date.parse(r.committedAt))) throw new Error('原 HDL 回执归属或摘要不符')
  const input = record(JSON.parse(command.wireJson)), result = record(r.result)
  if (command.kind === 'hdl.stop') {
    if (result.attemptId !== command.context.attemptId || result.stopRequested !== true) throw new Error('停止回执归属不符')
  } else {
    requiredId(result.jobId)
    if (command.kind === 'hdl.build') requiredId(result.buildId)
    else {
      requiredId(result.sessionId); requiredId(result.operationId)
      if (command.kind === 'hdl.interact' && result.sessionId !== input.sessionId ||
        command.kind === 'hdl.program' && result.operationId !== result.sessionId) throw new Error('操作回执归属不符')
    }
  }
  return structuredClone(r) as unknown as Receipt<HdlCreated>
}
export function verifyHdlJob(value: unknown, c: CommandContext, jobId?: string, objectId?: string): HdlJobView {
  const j = record(value), scope = record(j.scope)
  requiredId(j.jobId); requiredId(j.runId); requiredId(j.requestReceiptId); requiredId(j.recoveryGeneration)
  if (scope.courseId !== c.courseId || scope.studentId !== c.userId || scope.attemptId !== c.attemptId ||
    j.purpose !== 'student_run' || !['hdl_build', 'hdl_program', 'hdl_interact'].includes(String(j.kind)) ||
    !statuses.includes(String(j.status)) || (jobId !== undefined && j.jobId !== jobId) ||
    (objectId !== undefined && j.runId !== objectId)) throw new Error('HDL Job 归属不符')
  bool(j.stopRequested); revision(j.expectedRevision, 1); revision(j.decisionEpoch); revision(j.attemptCount)
  if (j.execution !== undefined) {
    const execution = record(j.execution)
    if (typeof execution.nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(execution.nodeId)) throw new Error('HDL Job 执行节点不完整')
    requiredId(execution.nodeGeneration)
  }
  for (const key of ['acceptedAt', 'deadline']) if (!Number.isFinite(Date.parse(String(j[key])))) throw new Error('HDL Job 时间不完整')
  return structuredClone(j) as unknown as HdlJobView
}
function originalJob(value: HdlJobView | undefined, c: CommandContext, kind: HdlJobView['kind'], id: string, jobId?: string): HdlJobView | undefined {
  if (!value) return undefined
  const job = verifyHdlJob(value, c, jobId, id)
  if (job.kind !== kind || job.recoveryGeneration !== c.trustedRecoveryGeneration) throw new Error('HDL 原 Job 业务代际或类型不符')
  return job
}
export async function verifyHdlBuild(value: unknown, c: CommandContext, id: string, profile?: HdlRuntimeProfile, command?: FrozenCommand | null, job?: HdlJobView): Promise<HdlBuildView> {
  const b = record(value), request = record(b.request)
  const boundJob = originalJob(job, c, 'hdl_build', id, requiredId(b.jobId)), generation = boundJob?.execution?.nodeGeneration ?? c.trustedRecoveryGeneration
  const source = identity(request.identity, c, id, generation), snapshot = await verifySnapshot(request.snapshot, c.attemptId!, c.activityVersionId!), mapping = board(request.board)
  requiredId(request.runtimeProfileVersion); requiredId(b.jobId)
  if (!buildStatuses.includes(String(b.status)) || b.result === undefined) throw new Error('Build 状态不完整')
  if (profile && (request.runtimeProfileVersion !== profile.runtimeProfileVersion || mapping.boardProfileVersion !== profile.boardProfileVersion || mapping.mappingVersion !== profile.mappingVersion)) throw new Error('Build 不属于当前获准执行配置')
  if (command) {
    const receipt = verifyHdlReceipt(command, (command as { receipt?: unknown }).receipt), input = JSON.parse(command.wireJson)
    if (command.kind !== 'hdl.build' || receipt.result.buildId !== id || receipt.result.jobId !== b.jobId || input.snapshotId !== snapshot.snapshotId ||
      source.commandId !== receipt.commandId || source.requestHash !== command.requestHash ||
      command.hdlSnapshot && command.hdlSnapshot.hash !== snapshot.hash) throw new Error('Build 与原构建回执不符')
  }
  if (b.result !== null) {
    const r = record(b.result)
    const resultIdentity = identity(r.identity, c, id, generation), resultBoard = board(r.board)
    if (hdlCanonical(resultIdentity) !== hdlCanonical(source) || r.buildId !== id || r.snapshotId !== snapshot.snapshotId ||
      r.snapshotHash !== snapshot.hash || r.runtimeProfileVersion !== request.runtimeProfileVersion || r.status !== b.status ||
      hdlCanonical(resultBoard) !== hdlCanonical(mapping) || r.configurationHash !== await textHash(JSON.stringify(r.board))) throw new Error('Build 结果引用或配置摘要不符')
    requiredId(r.engineVersion); hash(r.snapshotHash); hash(r.configurationHash)
    if (typeof r.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(r.imageDigest) ||
      profile && (r.engineVersion !== profile.engineVersion || profile.buildImage && r.imageDigest !== profile.buildImage)) throw new Error('构建引擎或镜像不符')
    bool(r.terminationConfirmed)
    if (r.artifactHash !== undefined) hash(r.artifactHash)
    if (r.status === 'succeeded' && (!r.artifactHash || !r.terminationConfirmed)) throw new Error('构建成功缺少产物或终止确认')
    if (!Array.isArray(r.diagnostics) || r.diagnostics.length > 100 || typeof r.stdout !== 'string' || r.stdout.length > 65536 || typeof r.stderr !== 'string' || r.stderr.length > 65536) throw new Error('构建诊断不完整或超限')
    for (const item of r.diagnostics) {
      const d = record(item)
      if (!['error', 'warning'].includes(String(d.severity)) || !['line-only', 'unavailable'].includes(String(d.location)) || typeof d.message !== 'string' || d.message.length > 65536) throw new Error('构建诊断精度不合法')
      if (d.line !== undefined) revision(d.line, 1)
      if (d.fileId !== undefined) {
        const file = snapshot.files.find(f => f.fileId === d.fileId)
        if (!file || d.path !== undefined && d.path !== file.path) throw new Error('构建诊断源码引用不符')
      }
    }
  }
  return { ...structuredClone(b), execution: boundJob?.execution && structuredClone(boundJob.execution) } as unknown as HdlBuildView
}
export function verifyHdlSession(value: unknown, c: CommandContext, id: string, build: HdlBuildView, profile?: HdlRuntimeProfile, job?: HdlJobView): HdlSessionView {
  const s = record(value), result = build.result
  const boundJob = originalJob(job, c, 'hdl_program', id), generation = boundJob?.execution?.nodeGeneration ?? c.trustedRecoveryGeneration
  identity(s.identity, c, id, generation)
  if (generation !== build.request.identity.recoveryGeneration || build.execution && hdlCanonical(boundJob?.execution) !== hdlCanonical(build.execution)) throw new Error('Session 与原 Build 执行节点不符')
  if (s.sessionId !== id || s.buildId !== build.request.identity.id || s.snapshotId !== build.request.snapshot.snapshotId ||
    s.snapshotHash !== build.request.snapshot.hash || s.boardProfileVersion !== build.request.board.boardProfileVersion ||
    s.mappingVersion !== build.request.board.mappingVersion || s.runtimeProfileVersion !== build.request.runtimeProfileVersion ||
    !result || s.engineVersion !== result.engineVersion || profile && s.engineVersion !== profile.engineVersion || !sessionStatuses.includes(String(s.status))) throw new Error('Session 与原 Build 或配置不符')
  revision(s.sessionRevision, 1); revision(s.confirmedSequence); simTime(s.simTimePs); bool(s.stopRequested); bool(s.terminationConfirmed)
  for (const key of ['createdAt', 'deadline', 'lastOperationAt']) if (!Number.isFinite(Date.parse(String(s[key])))) throw new Error('Session 时间不完整')
  if (s.pendingOperationId !== undefined) requiredId(s.pendingOperationId)
  return structuredClone(s) as unknown as HdlSessionView
}
export async function verifyHdlOperationCommand(result: import('./hdlContracts').HdlOperationResult, command: OutboxRecord): Promise<void> {
  await verifyHdlCommand(command)
  const ack = verifyHdlReceipt(command, command.receipt), input = record(JSON.parse(command.wireJson))
  if (ack.result.operationId !== result.operationId || ack.result.sessionId !== result.sessionId) throw new Error('Trace 不属于原操作回执')
  if (command.kind === 'hdl.program') {
    if (input.buildId !== result.buildId || result.sequence !== 0 || result.sessionRevision !== 1) throw new Error('装载初始结果引用不符')
  } else if (command.kind === 'hdl.interact') {
    if (input.sessionId !== result.sessionId || input.expectedSequence !== result.sequence || (input.expectedSessionRevision as number) + 1 !== result.sessionRevision) throw new Error('Trace 不属于冻结的操作版本')
    const inputs = verifyHdlInputs(input.inputs)
    if (result.frames.some(f => f.switches !== inputs.switches || f.buttons !== inputs.buttons || f.resetN !== inputs.resetN)) throw new Error('Trace 输入不属于原请求')
  } else throw new Error('该原命令不是 Session 操作')
}
export async function verifyHdlTrace(value: unknown, session: HdlSessionView, cursor: number): Promise<HdlTraceView> {
  const t = record(value), nextSequence = revision(t.nextSequence, -1)
  if (nextSequence < cursor || t.operation === undefined) throw new Error('Trace 游标回退或缺失')
  if (t.operation === null) { if (t.nextSequence !== cursor) throw new Error('空 Trace 不能推进'); return { operation: null, nextSequence: cursor } }
  const o = record(t.operation), seq = revision(o.sequence); requiredId(o.operationId)
  if (seq !== cursor + 1 || !statuses.includes(String(o.status)) || o.result === undefined) throw new Error('Trace 原操作顺序有缺口')
  if (o.result === null) { if (t.nextSequence !== cursor) throw new Error('pending Trace 不能推进游标'); return structuredClone(t) as unknown as HdlTraceView }
  const r = record(o.result), { resultHash, ...body } = r
  if (resultHash !== await textHash(JSON.stringify(body)) || t.nextSequence !== seq || r.sequence !== seq || r.operationId !== o.operationId ||
    r.sessionId !== session.sessionId || r.buildId !== session.buildId || r.snapshotId !== session.snapshotId || r.snapshotHash !== session.snapshotHash ||
    r.boardProfileVersion !== session.boardProfileVersion || r.mappingVersion !== session.mappingVersion || r.engineVersion !== session.engineVersion ||
    seq > session.confirmedSequence || revision(r.sessionRevision, 1) > session.sessionRevision) throw new Error('Trace 结果身份、顺序或摘要不符')
  if (!Array.isArray(r.frames) || r.frames.length < 1 || r.frames.length > 4096 || !['complete', 'incomplete'].includes(String(r.coverage))) throw new Error('Trace 缺失或超出窗口')
  const sampleCount = revision(r.sampleCount), droppedFrames = revision(r.droppedFrames)
  // Unchanged samples are compressed; sampleCount is not the number of emitted change frames.
  if (sampleCount < r.frames.length + droppedFrames || r.coverage === 'complete' && droppedFrames !== 0) throw new Error('Trace 覆盖计数不符')
  const frames = r.frames.map(frame), final = frame(r.finalFrame)
  for (let n = 1; n < frames.length; n++) if (BigInt(frames[n]!.simTimePs) < BigInt(frames[n - 1]!.simTimePs)) throw new Error('模拟时间回退')
  if (hdlCanonical(final) !== hdlCanonical(frames.at(-1)) || BigInt(final.simTimePs) > BigInt(session.simTimePs) ||
    seq === session.confirmedSequence && (final.simTimePs !== session.simTimePs ||
      session.status === 'active' && !session.stopRequested && !session.terminationConfirmed && r.sessionRevision !== session.sessionRevision)) throw new Error('Trace 最后帧不属于当前模拟相位')
  return structuredClone(t) as unknown as HdlTraceView
}
