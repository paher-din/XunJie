/**
 * Synthetic process-owned authority for I0_UI_03; not a backend implementation.
 * Shapes and behavior are scripted from server/workspace/{application,inputs,commands,files,snapshots}.ts,
 * server/records/commands.ts and runner/snapshot.ts. Never import server code here.
 */
import { randomUUID } from 'node:crypto'
import type { ApiErrorCode } from '../src/workspace/contracts'
import { preparationEpoch, syntheticRecoveryGeneration, type PrepSession } from './authority'
import { REFS, sha256Hex } from './scenario'
import type { JobView, RunView } from '../src/workspace/runContracts'

export class PrepWorkspaceError extends Error {
  constructor(readonly code: ApiErrorCode) { super(code) }
}
function reject(code: ApiErrorCode): never { throw new PrepWorkspaceError(code) }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) reject('INVALID_REQUEST')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 128) reject('INVALID_REQUEST')
  return value
}
function natural(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) reject('INVALID_REQUEST')
  return value as number
}
// Same canonical JSON and hash input as server/records/commands.ts; raw text is not normalized.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

interface Attempt {
  attemptId: string; courseId: string; studentId: string; assignmentId: string; activityVersionId: string
  /** 与公开投影一致：ready/active 可写；paused 只允许更新已有 active 文件；终态只读。 */
  status: 'ready' | 'active' | 'paused' | 'submitted' | 'reviewed'
  attemptRevision: number; workspaceRevision: number
  decisionEpoch: number; captureRevision: number; collecting: boolean; reminders: boolean
}
interface File {
  fileId: string; attemptId: string; path: string; text: string; documentVersion: number
  contentHash: string; lifecycle: 'active' | 'recycled'
}
interface Snapshot {
  snapshotId: string; hashFormat: 'sha256-manifest-v1'; hash: string; files: Omit<File, 'attemptId' | 'lifecycle'>[]
  attemptId: string; activityVersionId: string; workspaceRevision: number; createdAt: string
}
interface Head { attempt: Attempt; files: File[]; snapshots: Snapshot[]; jobs: JobView[]; runs: RunView[]; checks: never[] }
interface Identity {
  actorId: string; command: string; target: string
  scope: { courseId: string; studentId: string; attemptId?: string }
  idempotencyKey: string; recoveryGeneration: string; sync?: { clientId: string; clientSeq: number }
}
interface Receipt {
  receiptId: string; commandId: string; identity: Identity; requestHash: string
  result: unknown; serverSeq: number; committedAt: string
}
interface Checkpoint { head: Head; receipts: Receipt[]; aliases: Map<string, string>; serverSeq: number }
interface Scene { generation: string; head?: Head; receipts: Receipt[]; aliases: Map<string, string>; serverSeq: number; checkpoints: Map<number, Checkpoint> }
const scenes = new Map<string, Scene>()
function sceneOf(scenario: string): Scene {
  let scene = scenes.get(scenario)
  if (!scene) { scene = { generation: syntheticRecoveryGeneration, receipts: [], aliases: new Map(), serverSeq: 0, checkpoints: new Map() }; scenes.set(scenario, scene) }
  return scene
}
export function recoveryGenerationOf(scenario: string): string { return sceneOf(scenario).generation }
export function existingPrepAttemptId(scenario: string, session: PrepSession | null): string | undefined {
  const attempt = sceneOf(scenario).head?.attempt
  return session && attempt?.studentId === session.userId && attempt.courseId === session.courseId ? attempt.attemptId : undefined
}
function trustedGeneration(scene: Scene, value: unknown): string {
  const generation = id(value)
  if (generation !== scene.generation) reject('RECOVERY_REQUIRED')
  return generation
}
function authorizedHead(scene: Scene, session: PrepSession, attemptId: string): Head {
  id(attemptId)
  const head = scene.head
  if (!head || head.attempt.attemptId !== attemptId || head.attempt.studentId !== session.userId
    || head.attempt.courseId !== session.courseId) reject('FORBIDDEN')
  return head
}
function identity(session: PrepSession, command: string, target: string, key: unknown, generation: string, attemptId?: string): Identity {
  const businessKey = id(key)
  if (!/^[\x21-\x7e]+$/.test(businessKey)) reject('INVALID_REQUEST')
  return { actorId: session.userId, command, target,
    scope: { courseId: session.courseId, studentId: session.userId, ...(attemptId ? { attemptId } : {}) },
    idempotencyKey: businessKey, recoveryGeneration: generation }
}
function publicKey(value: Identity): string { return canonical([value.actorId, value.command, value.target, value.idempotencyKey]) }
function syncKey(value: Identity): string | undefined {
  return value.sync ? canonical([value.actorId, value.scope.attemptId, value.sync.clientId, value.sync.clientSeq]) : undefined
}
function original(scene: Scene, command: Identity, hash: string): Receipt | undefined {
  const key = publicKey(command), alias = scene.aliases.get(key)
  const byKey = scene.receipts.find(receipt => publicKey(receipt.identity) === key || receipt.receiptId === alias)
  const bySync = command.sync ? scene.receipts.find(receipt => syncKey(receipt.identity) === syncKey(command)) : undefined
  if (byKey && bySync && byKey.receiptId !== bySync.receiptId) reject('IDEMPOTENCY_CONFLICT')
  const previous = byKey ?? bySync
  if (previous && (previous.requestHash !== hash || canonical(previous.identity.scope) !== canonical(command.scope)
    || previous.identity.command !== command.command || previous.identity.target !== command.target)) reject('IDEMPOTENCY_CONFLICT')
  if (previous && !byKey) { scene.aliases.set(key, previous.receiptId); checkpoint(scene) }
  return previous
}
function receipt(scene: Scene, command: Identity, hash: string, result: unknown): Receipt {
  const committed = { receiptId: randomUUID(), commandId: randomUUID(), identity: command, requestHash: hash,
    result, serverSeq: ++scene.serverSeq, committedAt: new Date().toISOString() }
  scene.receipts.push(committed)
  checkpoint(scene)
  return structuredClone(committed)
}
function checkpoint(scene: Scene): void {
  if (scene.head) scene.checkpoints.set(scene.head.attempt.workspaceRevision, structuredClone({
    head: scene.head, receipts: scene.receipts, aliases: scene.aliases, serverSeq: scene.serverSeq,
  }))
}
export function readPrepAttempt(scenario: string, session: PrepSession, attemptId: string): Head {
  return structuredClone(authorizedHead(sceneOf(scenario), session, id(attemptId)))
}
export function createPrepAttempt(scenario: string, session: PrepSession, assignmentId: string, value: unknown, key: unknown): Receipt {
  id(assignmentId)
  const input = object(value, ['recoveryGeneration'])
  if (assignmentId !== REFS.assignmentId) reject('FORBIDDEN')
  const scene = sceneOf(scenario), generation = trustedGeneration(scene, input.recoveryGeneration)
  const command = identity(session, 'attempt.create', assignmentId, key, generation)
  const hash = sha256Hex(canonical({ target: command.target, fields: input }))
  const previous = original(scene, command, hash)
  if (previous) return structuredClone(previous)
  if (!scene.head) scene.head = { attempt: {
    attemptId: randomUUID(), courseId: session.courseId, studentId: session.userId, assignmentId,
    activityVersionId: REFS.activityVersionId, status: 'ready', attemptRevision: 1, workspaceRevision: 0,
    decisionEpoch: 0, captureRevision: 0, collecting: true, reminders: false,
  }, files: [], snapshots: [], jobs: [], runs: [], checks: [] }
  const attempt = scene.head.attempt
  return receipt(scene, command, hash, { attemptId: attempt.attemptId, assignmentId, activityVersionId: attempt.activityVersionId })
}

function rawText(value: unknown): string {
  if (typeof value !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) reject('INVALID_REQUEST')
  return value
}
function projectPath(value: unknown): string {
  if (typeof value !== 'string') reject('INVALID_REQUEST')
  if (/[\\\0]/.test(value) || /^[a-z]:/i.test(value) || value.split('/').some(part => ['', '.', '..'].includes(part))) reject('INVALID_REFERENCE')
  return value
}
function validateActiveFiles(files: File[]): void {
  const active = files.filter(file => file.lifecycle === 'active')
  if (new Set(active.map(file => file.path)).size !== active.length) reject('STATE_CONFLICT')
  if (active.length > 50 || active.reduce((total, file) => total + Buffer.byteLength(file.text), 0) > 1048576) reject('CONTENT_LIMIT')
}
function textChanges(value: unknown): Array<{ range: Record<string, number>; text: string }> {
  if (!Array.isArray(value) || !value.length) reject('INVALID_REQUEST')
  return value.map(value => {
    const change = object(value, ['range', 'text'])
    const range = object(change.range, ['startLine', 'startColumn', 'endLine', 'endColumn'])
    for (const field of ['startLine', 'startColumn', 'endLine', 'endColumn']) if (natural(range[field]) < 1) reject('INVALID_REQUEST')
    return { range: range as Record<string, number>, text: rawText(change.text) }
  })
}
function applyTextChanges(text: string, changes: ReturnType<typeof textChanges>): string {
  const lines = text.split('\n')
  const offset = (line: number, column: number) => {
    const raw = lines[line - 1]
    if (raw === undefined) reject('INVALID_REFERENCE')
    const visible = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (column > visible.length + 1) reject('INVALID_REFERENCE')
    return lines.slice(0, line - 1).reduce((sum, line) => sum + line.length + 1, 0) + column - 1
  }
  const edits = changes.map(change => {
    const start = offset(change.range.startLine!, change.range.startColumn!)
    const end = offset(change.range.endLine!, change.range.endColumn!)
    if (end < start) reject('INVALID_REFERENCE')
    return { start, end, text: change.text }
  }).sort((a, b) => a.start - b.start || a.end - b.end)
  for (let index = 1; index < edits.length; index++) {
    if (edits[index]!.start < edits[index - 1]!.end || edits[index]!.start === edits[index - 1]!.start) reject('INVALID_REQUEST')
  }
  for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  return rawText(text)
}
export function syncPrepWorkspace(scenario: string, session: PrepSession, attemptId: string, value: unknown, key: unknown): Receipt & { replayed: boolean } {
  const input = object(value, ['recoveryGeneration', 'expectedWorkspaceRevision', 'clientId', 'clientSeq', 'operations', 'process'])
  const expectedRevision = natural(input.expectedWorkspaceRevision)
  const clientId = id(input.clientId), clientSeq = natural(input.clientSeq)
  if (!Array.isArray(input.operations) || !input.operations.length || input.operations.length > 100) reject('INVALID_REQUEST')
  const operations = input.operations.map(value => {
    const op = object(value, ['kind', 'clientFileKey', 'path', 'text', 'fileId', 'baseVersion', 'changes'])
    if (op.kind === 'create') {
      object(op, ['kind', 'clientFileKey', 'path', 'text'])
      id(op.clientFileKey); projectPath(op.path); rawText(op.text)
    } else if (op.kind === 'update') {
      object(op, ['kind', 'fileId', 'baseVersion', 'text', 'changes'])
      id(op.fileId); if (natural(op.baseVersion) < 1) reject('INVALID_REQUEST')
      if ((op.text === undefined) === (op.changes === undefined)) reject('INVALID_REQUEST')
      if (op.changes === undefined) rawText(op.text); else textChanges(op.changes)
    } else if (op.kind === 'recycle' || op.kind === 'restore') {
      object(op, ['kind', 'fileId', 'baseVersion'])
      id(op.fileId); if (natural(op.baseVersion) < 1) reject('INVALID_REQUEST')
    } else reject('INVALID_REQUEST')
    return op
  })
  const process = input.process === undefined ? undefined : object(input.process, ['captureRevision'])
  if (process) natural(process.captureRevision)
  const scene = sceneOf(scenario), head = authorizedHead(scene, session, attemptId)
  const generation = trustedGeneration(scene, input.recoveryGeneration)
  const command = { ...identity(session, 'workspace.sync', `/api/attempts/${attemptId}/sync`, key, generation, attemptId),
    sync: { clientId, clientSeq } }
  const { recoveryGeneration: _generation, ...fields } = input
  const hash = sha256Hex(canonical({ target: command.target, fields }))
  const previous = original(scene, command, hash)
  if (previous) return { ...structuredClone(previous), replayed: true }
  if (expectedRevision !== head.attempt.workspaceRevision) reject('VERSION_CONFLICT')
  // 与真实服务同语义（server/workspace/files.ts:57-61）：终态只读；暂停只允许 update。
  // fixture 以前不校验这一层，浏览器就无法证明「暂停不可操作」是客户端挡下的还是服务端拒绝的。
  if (!['ready', 'active', 'paused'].includes(head.attempt.status)) reject('STATE_CONFLICT')
  if (head.attempt.status === 'paused' && operations.some(operation => operation.kind !== 'update')) reject('STATE_CONFLICT')
  const next = structuredClone(head), created: Record<string, string> = Object.create(null)
  const createKeys = new Set<string>(), seen = new Set<string>()
  for (const operation of operations) {
    if (operation.kind === 'create') {
      const clientFileKey = operation.clientFileKey as string
      if (createKeys.has(clientFileKey)) reject('INVALID_REQUEST')
      createKeys.add(clientFileKey)
      const fileId = randomUUID(); created[clientFileKey] = fileId
      next.files.push({ fileId, attemptId, path: operation.path as string, text: operation.text as string,
        documentVersion: 1, contentHash: sha256Hex(operation.text as string), lifecycle: 'active' })
    } else {
      const fileId = operation.fileId as string
      if (seen.has(fileId)) reject('INVALID_REQUEST')
      seen.add(fileId)
      const file = next.files.find(file => file.fileId === fileId)
      if (!file || !head.files.some(file => file.fileId === fileId)) reject('INVALID_REFERENCE')
      if (operation.baseVersion !== file.documentVersion) reject('VERSION_CONFLICT')
      if (operation.kind === 'update') {
        if (file.lifecycle !== 'active') reject('STATE_CONFLICT')
        file.text = operation.changes === undefined ? operation.text as string : applyTextChanges(file.text, textChanges(operation.changes))
        file.contentHash = sha256Hex(file.text)
      } else {
        if (file.lifecycle !== (operation.kind === 'recycle' ? 'active' : 'recycled')) reject('STATE_CONFLICT')
        file.lifecycle = operation.kind === 'recycle' ? 'recycled' : 'active'
      }
      file.documentVersion++
    }
  }
  validateActiveFiles(next.files)
  // 与真实服务 activate() 同语义：只有 ready 会推进到 active，暂停状态不被一次保存悄悄改回。
  if (next.attempt.status === 'ready') next.attempt.status = 'active'
  next.attempt.attemptRevision++; next.attempt.workspaceRevision++
  const eligible = Boolean(process && head.attempt.collecting && process.captureRevision === head.attempt.captureRevision)
  const result = { workspaceRevision: next.attempt.workspaceRevision,
    files: next.files.map(({ fileId, path, documentVersion, contentHash, lifecycle }) => ({ fileId, path, documentVersion, contentHash, lifecycle })), created,
    process: { status: eligible ? 'eligible' : 'not_collected',
      ...(!process ? { reason: 'not_requested' } : !head.attempt.collecting ? { reason: 'capture_paused' } : !eligible ? { reason: 'stale_capture_revision' } : {}) } }
  scene.head = next
  return { ...receipt(scene, command, hash, result), replayed: false }
}

export function freezePrepSnapshot(scenario: string, session: PrepSession, attemptId: string, value: unknown, key: unknown): Receipt & { replayed: boolean } {
  const input = object(value, ['recoveryGeneration', 'expectedWorkspaceRevision'])
  const expectedWorkspaceRevision = natural(input.expectedWorkspaceRevision)
  const scene = sceneOf(scenario), head = authorizedHead(scene, session, attemptId)
  const generation = trustedGeneration(scene, input.recoveryGeneration)
  const command = identity(session, 'snapshot.create', `/api/attempts/${attemptId}/snapshots`, key, generation, attemptId)
  const hash = sha256Hex(canonical({ target: command.target, fields: { expectedWorkspaceRevision } }))
  const previous = original(scene, command, hash)
  if (previous) return { ...structuredClone(previous), replayed: true }
  if (expectedWorkspaceRevision !== head.attempt.workspaceRevision) reject('VERSION_CONFLICT')
  const files = head.files.filter(file => file.lifecycle === 'active').map(({ fileId, path, documentVersion, text, contentHash }) => ({ fileId, path, documentVersion, text, contentHash }))
  const manifest = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map(file => [file.fileId, file.path, file.documentVersion, file.contentHash])
  const snapshot: Snapshot = { snapshotId: randomUUID(), attemptId, activityVersionId: head.attempt.activityVersionId,
    workspaceRevision: expectedWorkspaceRevision, createdAt: new Date().toISOString(),
    hashFormat: 'sha256-manifest-v1', hash: sha256Hex(JSON.stringify(manifest)), files }
  const next = structuredClone(head)
  next.snapshots.push(snapshot)
  if (next.attempt.status === 'ready') { next.attempt.status = 'active'; next.attempt.attemptRevision++ }
  scene.head = next
  return { ...receipt(scene, command, hash, { snapshotId: snapshot.snapshotId, snapshotHash: snapshot.hash, workspaceRevision: expectedWorkspaceRevision }), replayed: false }
}
export function readPrepSnapshot(scenario: string, session: PrepSession, attemptId: string, snapshotId: string): Snapshot {
  id(snapshotId)
  const head = authorizedHead(sceneOf(scenario), session, id(attemptId))
  const snapshot = head.snapshots.find(snapshot => snapshot.snapshotId === snapshotId)
  if (!snapshot) reject('INVALID_REFERENCE')
  return structuredClone(snapshot)
}

/** 06 脚本结果；没有 GCC/worker/runner，输出从固定公开形状脚本取，不评判作品正确性。 */
export type PrepRunScript = 'success' | 'compile_failed' | 'runtime_failed' | 'timed_out' | 'output_limit' | 'running' | 'unavailable' | 'node_failed' | 'not_ready' | 'outcome_unknown' | 'stale' | 'cancelled'
const scripts = new Map<string, PrepRunScript>()
const polls = new Map<string, number>()
const runScripts = new Map<string, PrepRunScript>()
export function setPrepRunScript(scenario: string, value: unknown) {
  const input = object(value, ['outcome'])
  if (!['success', 'compile_failed', 'runtime_failed', 'timed_out', 'output_limit', 'running', 'unavailable', 'node_failed', 'not_ready', 'outcome_unknown', 'stale', 'cancelled'].includes(String(input.outcome))) reject('INVALID_REQUEST')
  scripts.set(scenario, input.outcome as PrepRunScript)
  // 同一开发脚本可推进尚未结束的原 Job；不会新建运行或改变快照/公开 wire。
  for (const job of sceneOf(scenario).head?.jobs ?? []) {
    if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) runScripts.set(`${scenario}:${job.runId}`, input.outcome as PrepRunScript)
  }
  return { outcome: input.outcome }
}
export function createPrepRun(scenario: string, session: PrepSession, attemptId: string, value: unknown, key: unknown) {
  const input = object(value, ['recoveryGeneration', 'expectedAttemptRevision', 'snapshotId', 'runtimeProfileVersion', 'entryFileId', 'input', 'mode'])
  const scene = sceneOf(scenario), head = authorizedHead(scene, session, id(attemptId))
  const generation = trustedGeneration(scene, input.recoveryGeneration)
  const command = identity(session, 'run.create', `/api/attempts/${attemptId}/runs`, key, generation, attemptId)
  const { recoveryGeneration: _generation, ...fields } = input
  const hash = sha256Hex(canonical({ target: command.target, fields }))
  const previous = original(scene, command, hash)
  if (previous) return { ...structuredClone(previous), replayed: true }
  const script = scripts.get(scenario) ?? 'success'
  if (script === 'not_ready' || input.runtimeProfileVersion !== REFS.runtimeProfileVersionId || input.mode !== 'run') reject('RUNTIME_NOT_READY')
  if (natural(input.expectedAttemptRevision) !== head.attempt.attemptRevision) reject('VERSION_CONFLICT')
  if (!['ready', 'active'].includes(head.attempt.status) || head.jobs.some(j => !['succeeded', 'failed', 'cancelled', 'timed_out'].includes(j.status))) reject('STATE_CONFLICT')
  const snapshot = head.snapshots.find(s => s.snapshotId === id(input.snapshotId))
  if (!snapshot || !snapshot.files.some(f => f.fileId === input.entryFileId && f.path.endsWith('.c'))) reject('INVALID_REFERENCE')
  const core = object(input.input, ['operation', 'fileIds', 'word', 'count'])
  const operation = core.operation
  if (!['stats', 'find', 'top'].includes(String(operation)) || Object.keys(core).some(k => !['operation', 'fileIds', ...(operation === 'find' ? ['word'] : operation === 'top' ? ['count'] : [])].includes(k))) reject('INVALID_REQUEST')
  if (!Array.isArray(core.fileIds) || core.fileIds.length < 1 || core.fileIds.length > 50 || new Set(core.fileIds).size !== core.fileIds.length) reject('INVALID_REQUEST')
  for (const fileId of core.fileIds) {
    const file = snapshot.files.find(f => f.fileId === id(fileId))
    if (!file || !/^[\x00-\x7f]*$/.test(file.text)) reject('INVALID_REFERENCE')
  }
  if (operation === 'find' && (typeof core.word !== 'string' || !/^[A-Za-z0-9]+$/.test(core.word))) reject('INVALID_REQUEST')
  if (operation === 'top' && (typeof core.count !== 'string' || !/^[1-9][0-9]{0,9}$/.test(core.count) || BigInt(core.count) > 2147483647n)) reject('INVALID_REQUEST')
  const next = structuredClone(head), runId = randomUUID(), jobId = randomUUID(), requestReceiptId = randomUUID()
  if (next.attempt.status === 'ready') { next.attempt.status = 'active'; next.attempt.attemptRevision++ }
  const now = new Date().toISOString()
  next.jobs.push({ jobId, runId, kind: 'run', purpose: 'student_run', scope: { courseId: session.courseId, studentId: session.userId, attemptId },
    requestReceiptId, status: 'queued', stopRequested: false, expectedRevision: next.attempt.attemptRevision,
    decisionEpoch: next.attempt.decisionEpoch, recoveryGeneration: generation, acceptedAt: now,
    deadline: new Date(Date.now() + 120_000).toISOString(), attemptCount: 0 })
  next.runs.push({ runId, jobId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.hash, mode: 'run',
    runtimeProfileVersion: REFS.runtimeProfileVersionId, imageDigest: `sha256:${'a'.repeat(64)}`,
    diagnostics: { runId, snapshotId: snapshot.snapshotId, snapshotHash: snapshot.hash, source: 'runner_diagnostics', status: 'unavailable' } })
  scene.head = next
  runScripts.set(`${scenario}:${runId}`, script)
  const ack = receipt(scene, command, hash, { runId, jobId, snapshotId: snapshot.snapshotId })
  // requestReceiptId 必须关联实际回执，与真实 readWorkspace 投影一致。
  next.jobs[next.jobs.length - 1]!.requestReceiptId = ack.receiptId
  checkpoint(scene)
  return { ...ack, replayed: false }
}
export function readPrepJob(scenario: string, session: PrepSession, jobId: string): JobView {
  const scene = sceneOf(scenario), head = scene.head
  if (!head) reject('FORBIDDEN')
  authorizedHead(scene, session, head.attempt.attemptId)
  const job = head.jobs.find(j => j.jobId === id(jobId))
  if (!job) reject('FORBIDDEN')
  const key = `${scenario}:${job.runId}`, script = runScripts.get(key) ?? 'running'
  if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return structuredClone(job)
  // 06A：停止意图与整个单元停止确认分开。脚本是合成外部事实，GET 才返回权威状态。
  if (job.stopRequested) {
    if (script === 'cancelled' && ['cancelling', 'outcome_unknown'].includes(job.status)) job.status = 'cancelled'
    return structuredClone(job)
  }
  if (script === 'outcome_unknown' || script === 'stale') {
    job.status = script
    return structuredClone(job)
  }
  if (script === 'cancelled') return structuredClone(job)
  const count = (polls.get(key) ?? 0) + 1
  polls.set(key, count)
  if (count >= 2 && job.status === 'queued') { job.status = 'running'; job.attemptCount = 1 }
  if (count >= 3 && script !== 'running') {
    // reconcileRun 回取到结果即调度 succeeded；程序错误仅由公开诊断表达。
    job.status = script === 'node_failed' ? 'failed' : 'succeeded'
    const run = head.runs.find(r => r.runId === job.runId)!
    if (script !== 'unavailable' && script !== 'node_failed') run.diagnostics = { ...run.diagnostics, status: 'available',
      stdout: script === 'success' ? 'SYNTHETIC Core result\n' : '',
      stderr: script === 'compile_failed' ? 'SYNTHETIC compiler diagnostic\n' : script === 'runtime_failed' ? 'SYNTHETIC execution diagnostic\n' : '',
      ...(script !== 'success' ? { failureKind: script === 'compile_failed' ? 'compile_error' : script === 'runtime_failed' ? 'program_error' : script === 'timed_out' ? 'timeout' : 'output_limit' } : {}) }
  }
  return structuredClone(job)
}
/** cancelRunCommand/cancelJob 的公开行为；不执行真实节点取消或证明槽位释放。 */
export function cancelPrepRun(scenario: string, session: PrepSession, jobId: string, value: unknown, key: unknown) {
  const scene = sceneOf(scenario), head = scene.head
  if (!head) reject('FORBIDDEN')
  authorizedHead(scene, session, head.attempt.attemptId)
  const input = object(value, ['recoveryGeneration']), generation = trustedGeneration(scene, input.recoveryGeneration)
  const command = identity(session, 'job.cancel', `/api/jobs/${jobId}/cancel`, key, generation, head.attempt.attemptId)
  const hash = sha256Hex(canonical({ target: command.target, fields: { jobId } }))
  const previous = original(scene, command, hash)
  if (previous) return { ...structuredClone(previous), replayed: true }
  const job = head.jobs.find(j => j.jobId === id(jobId))
  if (!job) reject('FORBIDDEN')
  job.stopRequested = true
  if (!['succeeded', 'failed', 'cancelled', 'timed_out', 'stale'].includes(job.status)) job.status = 'cancelling'
  const ack = receipt(scene, command, hash, { jobId, status: job.status, stopRequested: true })
  checkpoint(scene)
  return { ...ack, replayed: false }
}
export function readPrepRun(scenario: string, session: PrepSession, attemptId: string, runId: string): RunView {
  const head = authorizedHead(sceneOf(scenario), session, id(attemptId))
  const run = head.runs.find(r => r.runId === id(runId))
  if (!run) reject('FORBIDDEN')
  return structuredClone(run)
}

/**
 * Dev-only state script: POST /__i0prep/attempt-state { attemptId, status }.
 *
 * 05 的验收要求「暂停/终态不可操作」。准备 authority 只会把 Attempt 变成 ready/active，
 * 没有控制端点就无法在浏览器里复现暂停与终态，因此这里给一个**开发专用**的状态开关：
 * 只改 status（与真实控制命令一样不推进 workspaceRevision），不伪造回执、不产生学习记录。
 * 客户端仍然必须通过 GET 权威 Attempt 才看到它。
 */
export function setPrepAttemptState(scenario: string, session: PrepSession, value: unknown) {
  const input = object(value, ['attemptId', 'status'])
  const attemptId = id(input.attemptId)
  const status = String(input.status)
  if (!['ready', 'active', 'paused', 'submitted', 'reviewed'].includes(status)) reject('INVALID_REQUEST')
  const scene = sceneOf(scenario), head = authorizedHead(scene, session, attemptId)
  const next = structuredClone(head)
  next.attempt.status = status as Attempt['status']
  scene.head = next
  checkpoint(scene)
  return { attemptId, status }
}

/** Dev-only rollback script: POST /__i0prep/recover { attemptId, workspaceRevision }.
 * Restores the head/receipts together, then rotates generation. No fake ACKs or runs are produced.
 */
export function recoverPrepWorkspace(scenario: string, session: PrepSession, value: unknown) {
  const input = object(value, ['attemptId', 'workspaceRevision'])
  const attemptId = id(input.attemptId), revision = natural(input.workspaceRevision)
  const scene = sceneOf(scenario)
  authorizedHead(scene, session, attemptId)
  const saved = scene.checkpoints.get(revision)
  if (!saved) reject('INVALID_REFERENCE')
  const restored = structuredClone(saved)
  scene.head = restored.head; scene.receipts = restored.receipts; scene.aliases = restored.aliases; scene.serverSeq = restored.serverSeq
  scene.checkpoints = new Map([...scene.checkpoints].filter(([version]) => version <= revision))
  scene.generation = `prep-gen-${randomUUID()}`
  return { preparationEpoch, recoveryGeneration: scene.generation, attemptId, workspaceRevision: revision }
}
