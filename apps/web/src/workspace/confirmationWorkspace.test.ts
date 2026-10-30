import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationWorkspace } from './confirmationWorkspace'
import type { CommandContext, FrozenCommand, FrozenDraft, OutboxRecord } from './frozenCommand'
import type { RequestOptions } from './http'
import type { ConfirmedWorkspace, Receipt, SyncInput, SyncResult, WorkspaceHead } from './workspaceContracts'

const mocked = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), head: vi.fn(), read: vi.fn(), installHead: vi.fn(),
  reserveSeq: vi.fn(), persist: vi.fn(), claim: vi.fn(), command: vi.fn(),
  acknowledge: vi.fn(), release: vi.fn(), isCurrentAuthority: vi.fn(), reference: vi.fn(), commands: vi.fn(),
}))
vi.mock('./http', async original => ({
  ...await original<typeof import('./http')>(), apiGet: mocked.get, apiPostFrozen: mocked.post,
}))
vi.mock('./confirmationDb', async original => ({
  ...await original<typeof import('./confirmationDb')>(),
  confirmationRepository: {
    read: mocked.read, installHead: mocked.installHead, reserveSeq: mocked.reserveSeq,
    persist: mocked.persist, claim: mocked.claim, command: mocked.command,
    acknowledge: mocked.acknowledge, release: mocked.release, isCurrentAuthority: mocked.isCurrentAuthority,
    reference: mocked.reference, commands: mocked.commands,
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const originalText = 'int main(void) { return 0; }\n'
const savedText = 'int main(void) { return 1; }\n'
const drafts: FrozenDraft[] = [{ localId: 'local-file', serverFileId: 'file', path: 'main.c', text: savedText, draftRevision: 2 }]
const context: CommandContext = {
  mode: 'preparation', userId: 'student', courseId: 'course', assignmentId: 'assignment',
  activityVersionId: 'activity', attemptId: 'attempt', preparationEpoch: 'prep',
  trustedRecoveryGeneration: 'g1', loadEpoch: 1,
}
function head(): WorkspaceHead {
  return {
    attempt: { attemptId: 'attempt', courseId: 'course', studentId: 'student', assignmentId: 'assignment',
      activityVersionId: 'activity', status: 'active', attemptRevision: 7, workspaceRevision: 3,
      decisionEpoch: 2, captureRevision: 4, collecting: true, reminders: false },
    files: [{ fileId: 'file', attemptId: 'attempt', path: 'main.c', documentVersion: 1,
      contentHash: hash(originalText), text: originalText, lifecycle: 'active' }],
    snapshots: [], jobs: [], runs: [], checks: [], limitedCheck: false,
  }
}
function pausedHead(): WorkspaceHead {
  const value = head()
  Object.assign(value.attempt, { status: 'paused', attemptRevision: 8, decisionEpoch: 3,
    captureRevision: 5, collecting: false })
  return value
}
function savedHead(): WorkspaceHead {
  const value = pausedHead()
  Object.assign(value.attempt, { attemptRevision: 9, workspaceRevision: 4 })
  Object.assign(value.files[0]!, { documentVersion: 2, text: savedText, contentHash: hash(savedText) })
  return value
}
function workspaceOf(value: WorkspaceHead): ConfirmedWorkspace {
  return { attemptId: value.attempt.attemptId, workspaceRevision: value.attempt.workspaceRevision, files: value.files }
}
function receiptFor(command: FrozenCommand): Receipt<SyncResult> {
  const input = JSON.parse(command.wireJson) as SyncInput
  return {
    receiptId: 'receipt', commandId: 'command', requestHash: command.requestHash,
    serverSeq: 20, committedAt: '2026-10-14T00:00:00.000Z', replayed: false,
    identity: { actorId: 'student', command: 'workspace.sync', target: '/api/attempts/attempt/sync',
      idempotencyKey: command.commandKey, recoveryGeneration: 'g1',
      scope: { courseId: 'course', studentId: 'student', attemptId: 'attempt' },
      sync: { clientId: input.clientId, clientSeq: input.clientSeq } },
    result: { workspaceRevision: 4, created: {}, process: { status: 'not_collected' },
      files: [{ fileId: 'file', path: 'main.c', documentVersion: 2,
        contentHash: hash(savedText), lifecycle: 'active' }] },
  }
}

const clients: ConfirmationWorkspace[] = []
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  clients.splice(0).forEach(client => client.dispose())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Only HTTP and the durable repository are substitutes; guards, freezing and receipt verification are real. */
async function harness() {
  let remote = head(), local: ConfirmedWorkspace | null = null, sequence = 0
  const commands = new Map<string, OutboxRecord>()
  const requireCommand = (key: string) => {
    const command = commands.get(key)
    if (!command) throw new Error('missing original command')
    return command
  }
  const install = (incoming: ConfirmedWorkspace) => {
    if (!local || incoming.workspaceRevision >= local.workspaceRevision) local = structuredClone(incoming)
    return structuredClone(local)
  }
  mocked.head.mockImplementation(async () => structuredClone(remote))
  mocked.get.mockImplementation((path: string) => {
    if (path === '/session') return Promise.resolve({ userId: 'student',
      courses: [{ courseId: 'course', role: 'student' }], csrfToken: 'synthetic-csrf' })
    if (path === '/attempts/attempt') return mocked.head()
    throw new Error(`unexpected GET ${path}`)
  })
  mocked.read.mockImplementation(async () => ({ workspace: structuredClone(local),
    commands: structuredClone([...commands.values()]), instances: [], drafts: [], candidates: [] }))
  mocked.installHead.mockImplementation(async (_c: CommandContext, incoming: ConfirmedWorkspace, valid: () => boolean) => {
    if (!valid()) throw new Error('retired head')
    return install(incoming)
  })
  mocked.isCurrentAuthority.mockResolvedValue(true)
  mocked.reserveSeq.mockImplementation(async () => ++sequence)
  mocked.persist.mockImplementation(async (command: FrozenCommand, valid: () => boolean) => {
    if (!valid()) throw new Error('retired command')
    commands.set(command.commandKey, { ...structuredClone(command), state: 'pending' })
  })
  mocked.claim.mockImplementation(async (key: string, _owner: string, valid: () => boolean) => {
    if (!valid()) throw new Error('retired lease')
    return structuredClone(requireCommand(key))
  })
  mocked.command.mockImplementation(async (key: string) => structuredClone(commands.get(key) ?? null))
  mocked.release.mockResolvedValue(undefined)
  mocked.post.mockImplementation(async (path: string, wire: string, options: RequestOptions) => {
    const command = requireCommand(options.idempotencyKey!)
    if (path !== command.path || wire !== command.wireJson) throw new Error('original request changed')
    remote = savedHead()
    return receiptFor(command)
  })
  mocked.acknowledge.mockImplementation(async (command: FrozenCommand, receipt: Receipt,
    incoming: ConfirmedWorkspace | null, _mappings: Record<string, string>, _snapshot: unknown, valid: () => boolean) => {
    if (!valid()) throw new Error('retired ACK')
    const original = requireCommand(command.commandKey)
    if (original.wireJson !== command.wireJson) throw new Error('original command changed')
    commands.set(command.commandKey, { ...original, state: 'confirmed', receipt: structuredClone(receipt) })
    return incoming ? install(incoming) : null
  })
  const client = new ConfirmationWorkspace(context)
  clients.push(client)
  await client.readHead()
  expect(client.current.workspace?.files[0]?.text).toBe(originalText)
  return {
    client, setRemote: (value: WorkspaceHead) => { remote = structuredClone(value) },
    // Another tab retries the previously undelivered original command and commits the atomic ACK.
    confirmOriginalElsewhere: () => {
      const original = [...commands.values()][0]!
      remote = savedHead()
      install(workspaceOf(remote))
      commands.set(original.commandKey, { ...original, state: 'confirmed', receipt: receiptFor(original) })
    },
  }
}

describe('real Attempt reference recovery', () => {
  it('reads the server-authorized Attempt instead of a stale local reference', async () => {
    const current = 'current-attempt'
    const realContext: CommandContext = { ...context, mode: 'real', attemptId: current, preparationEpoch: null }
    const remote = head()
    remote.attempt.attemptId = current
    remote.files[0]!.attemptId = current
    mocked.reference.mockResolvedValue({ attemptId: 'stale-attempt', changed: true })
    mocked.commands.mockResolvedValue([])
    mocked.read.mockResolvedValue({ workspace: null, commands: [], instances: [], drafts: [], candidates: [] })
    mocked.get.mockImplementation(async (path: string) => {
      if (path === `/attempts/${current}`) return remote
      if (path === '/assignments/assignment/bootstrap') return {
        assignment: { assignmentId: 'assignment', studentId: 'student', activityVersionId: 'activity' },
        recoveryGeneration: 'g1', currentAttemptId: current,
      }
      throw new Error(`unexpected GET ${path}`)
    })
    mocked.installHead.mockImplementation(async (_c: CommandContext, incoming: ConfirmedWorkspace,
      valid: () => boolean, currentAuthority: () => Promise<boolean>) => {
      expect(valid()).toBe(true)
      expect(await currentAuthority()).toBe(true)
      return incoming
    })
    const client = new ConfirmationWorkspace(realContext)
    clients.push(client)
    await client.initialize()
    expect(client.context.attemptId).toBe(current)
    expect(client.current).toMatchObject({ phase: 'ready', error: null, attempt: { attemptId: current } })
    expect(mocked.get.mock.calls.map(([path]) => path)).toEqual([`/attempts/${current}`, '/assignments/assignment/bootstrap'])
    expect(mocked.persist).not.toHaveBeenCalled()
  })

  it('does not resurrect a stale local Attempt when the server reports none', async () => {
    const realContext: CommandContext = { ...context, mode: 'real', attemptId: null, preparationEpoch: null }
    mocked.reference.mockResolvedValue({ attemptId: 'stale-attempt', changed: true })
    mocked.commands.mockResolvedValue([])
    const client = new ConfirmationWorkspace(realContext)
    clients.push(client)
    await client.initialize()
    expect(client.context.attemptId).toBeNull()
    expect(client.current).toMatchObject({ phase: 'idle', attempt: null, workspace: null, error: null })
    expect(mocked.get).not.toHaveBeenCalled()
    expect(mocked.persist).not.toHaveBeenCalled()
  })
})

describe('confirmation head/control interleavings through the public workspace', () => {
  it.each(['save', 'retry'] as const)('%s ACK retires an already in-flight controls read without undoing the saved work', async operation => {
    const h = await harness(), oldControl = deferred<WorkspaceHead>()
    if (operation === 'retry') {
      mocked.post.mockRejectedValueOnce(new Error('original request did not reach the service'))
      await h.client.save(drafts)
      expect(h.client.current.phase).toBe('unknown')
      expect(h.client.current.pending?.state).toBe('pending')
    }
    mocked.head.mockImplementationOnce(() => oldControl.promise)
    const oldReading = h.client.readHead({ controlsOnly: true })
    h.setRemote(pausedHead())
    await h.client.readHead()
    expect(h.client.current.attempt?.status).toBe('paused')
    if (operation === 'retry') h.confirmOriginalElsewhere()

    const reread = deferred<WorkspaceHead>(), reachedReread = deferred<void>()
    mocked.head.mockImplementationOnce(() => { reachedReread.resolve(); return reread.promise })
    const saving = operation === 'save' ? h.client.save(drafts) : h.client.retry()
    await reachedReread.promise
    try {
      expect(h.client.current.workspace).toMatchObject({ workspaceRevision: 4,
        files: [{ fileId: 'file', documentVersion: 2, text: savedText }] })
      expect(h.client.current.pending).toBeNull()
      oldControl.resolve(head())
      expect(await oldReading).toBeNull()
      expect(h.client.current.workspace?.files[0]?.text).toBe(savedText)
    } finally {
      oldControl.resolve(head())
      reread.resolve(savedHead())
      await saving
    }
    expect(h.client.current.attempt).toMatchObject({ status: 'paused', attemptRevision: 9,
      decisionEpoch: 3, captureRevision: 5, collecting: false })
    expect(mocked.post).toHaveBeenCalledTimes(1)
  })

  it('a late controls failure cannot clear a newer successful full-head control publication', async () => {
    const h = await harness(), failed = deferred<WorkspaceHead>()
    mocked.head.mockImplementationOnce(() => failed.promise)
    const earlier = h.client.readHead({ controlsOnly: true })
    h.setRemote(pausedHead())
    await h.client.readHead()
    expect(h.client.current.attempt?.status).toBe('paused')
    failed.reject(new Error('earlier controls connection failed'))
    expect(await earlier).toBeNull()
    expect(h.client.current.attempt).toMatchObject({ status: 'paused', attemptRevision: 8,
      decisionEpoch: 3, captureRevision: 5, collecting: false })
    expect(h.client.current.phase).toBe('ready')
  })

  it('a current full-head failure leaves controls unknown but cannot erase the watermark for a pending old controls success', async () => {
    const h = await harness(), oldControl = deferred<WorkspaceHead>()
    mocked.head.mockImplementationOnce(() => oldControl.promise)
    const earlier = h.client.readHead({ controlsOnly: true })
    h.setRemote(pausedHead())
    await h.client.readHead()
    mocked.head.mockRejectedValueOnce(new Error('current full-head read unavailable'))
    expect(await h.client.readHead()).toBeNull()
    expect(h.client.current.attempt).toBeNull()
    oldControl.resolve(head())
    expect(await earlier).toBeNull()
    expect(h.client.current.attempt).toBeNull()
    expect(h.client.current.workspace?.files[0]?.text).toBe(originalText)
    await h.client.readHead()
    expect(h.client.current.attempt?.status).toBe('paused')
  })

  it('same-version controls polling neither installs unseen work nor retires an explicit full-head read', async () => {
    const h = await harness(), full = deferred<WorkspaceHead>()
    h.setRemote(savedHead())
    mocked.head.mockImplementationOnce(() => full.promise)
    const explicitReading = h.client.readHead()
    expect(await h.client.readHead({ controlsOnly: true })).not.toBeNull()
    expect(h.client.current.workspace).toMatchObject({ workspaceRevision: 3, files: [{ text: originalText }] })
    full.resolve(savedHead())
    expect(await explicitReading).not.toBeNull()
    expect(h.client.current.workspace).toMatchObject({ workspaceRevision: 4, files: [{ text: savedText }] })
    expect(mocked.post).not.toHaveBeenCalled()
  })
})
