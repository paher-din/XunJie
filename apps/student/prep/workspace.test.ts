/** Real middleware HTTP seam; synthetic scenarios never share mutable authority. */
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { createPrepMiddleware, PREP_ROOT } from './plugin'
import { REFS, SYNTHETIC_ACCOUNT } from './scenario'

let server: Server
let base: string
let scenario: string
let cookie: string
let csrf: string
let generation: string
const errors: string[] = []

beforeAll(async () => {
  const middleware = createPrepMiddleware({ info() {}, error(message) { errors.push(message) } })
  server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  expect(errors).toEqual([])
})

async function call(method: 'GET' | 'POST', path: string, body?: unknown, key?: string, headers: Record<string, string> = {}) {
  const response = await fetch(base + PREP_ROOT + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-i0prep-scenario': scenario,
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(key ? { 'idempotency-key': key } : {}), ...headers },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })
  const envelope = await response.json()
  expect(envelope.requestId).toBe(response.headers.get('x-request-id'))
  return { status: response.status, envelope, headers: response.headers }
}

beforeEach(async () => {
  scenario = randomUUID(); cookie = ''; csrf = ''
  generation = (await call('GET', '/context')).envelope.data.recoveryGeneration
  const login = await call('POST', '/api/sessions', {
    loginName: SYNTHETIC_ACCOUNT.loginName, password: SYNTHETIC_ACCOUNT.password,
  })
  cookie = login.headers.getSetCookie()[0]!.split(';')[0]!
  csrf = login.envelope.data.csrfToken
})

async function createAttempt() {
  const result = await call('POST', `/api/assignments/${REFS.assignmentId}/attempts`, { recoveryGeneration: generation }, randomUUID())
  expect(result.status).toBe(200)
  return result.envelope.data.result.attemptId as string
}

it('06B 公开历史及文件 HTTP 样例只保留既有投影，check 裁剪且 GET 不新增命令', async () => {
  const attemptId = await createAttempt()
  await call('POST', `/api/attempts/${attemptId}/sync`, batch([{ kind: 'create', clientFileKey: 'main', path: 'main.c', text: 'int main(void){return 0;}' }]), randomUUID())
  const frozen = await call('POST', `/api/attempts/${attemptId}/snapshots`, { recoveryGeneration: generation, expectedWorkspaceRevision: 1 }, randomUUID())
  const snapshotId = frozen.envelope.data.result.snapshotId
  for (const sample of ['check', 'complete', 'missing', 'incomplete', 'unavailable', 'unknown']) {
    const seeded = await call('POST', '/history-sample', { attemptId, snapshotId, sample })
    expect(seeded.status).toBe(200)
    const runId = seeded.envelope.data.runId
    const read = await call('GET', `/api/attempts/${attemptId}/runs/${runId}`)
    for (const privateField of ['input', 'entryFileId', 'inputHash']) expect(read.envelope.data).not.toHaveProperty(privateField)
    const files = await call('GET', `/api/attempts/${attemptId}/runs/${runId}/files`)
    expect(files.status).toBe(200)
    if (sample === 'check') {
      expect(files.envelope.data).toEqual({ status: 'redacted' })
      expect(read.envelope.data.diagnostics).toMatchObject({ verdict: 'failed', failureKind: 'mismatch' })
      expect(read.envelope.data.diagnostics).not.toHaveProperty('stdout')
    }
    if (sample === 'complete') {
      const f = files.envelope.data.files[0]
      expect(f.contentHash).toBe(createHash('sha256').update(f.text).digest('hex'))
      expect(f.bytes).toBe(Buffer.byteLength(f.text))
      expect(f.resultFileId).toBe(createHash('sha256').update(JSON.stringify([runId, snapshotId, 0, 'report.txt', f.contentHash])).digest('hex'))
    }
  }
  const head = (await call('GET', `/api/attempts/${attemptId}`)).envelope.data
  expect(head.jobs).toHaveLength(6)
  expect(head.runs).toHaveLength(6)
  expect(head.attempt.workspaceRevision).toBe(1)
})

it('GET does not create; explicit creation yields one readable Attempt and a stable receipt', async () => {
  const missing = await call('GET', '/api/attempts/not-created')
  expect(missing.status).toBe(403)
  const key = randomUUID()
  const path = `/api/assignments/${REFS.assignmentId}/attempts`
  const created = await call('POST', path, { recoveryGeneration: generation }, key)
  expect(created.status).toBe(200)
  const receipt = created.envelope.data
  expect(receipt.identity).toEqual({ actorId: SYNTHETIC_ACCOUNT.userId, command: 'attempt.create', target: REFS.assignmentId,
    scope: { courseId: SYNTHETIC_ACCOUNT.courseId, studentId: SYNTHETIC_ACCOUNT.userId },
    idempotencyKey: key, recoveryGeneration: generation })
  expect(receipt.result.attemptId).toMatch(/^[0-9a-f-]{36}$/)
  expect(receipt).toMatchObject({ serverSeq: 1, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(receipt).not.toHaveProperty('replayed') // A's finishRecordCommand has no replayed field.
  const replay = await call('POST', path, { recoveryGeneration: generation }, key)
  expect(replay.envelope.data).toEqual(receipt)
  expect(await createAttempt()).toBe(receipt.result.attemptId)
  const read = await call('GET', `/api/attempts/${receipt.result.attemptId}`)
  expect(read.status).toBe(200)
  expect(read.envelope.data).toEqual({ attempt: {
    attemptId: receipt.result.attemptId, courseId: SYNTHETIC_ACCOUNT.courseId, studentId: SYNTHETIC_ACCOUNT.userId,
    assignmentId: REFS.assignmentId, activityVersionId: REFS.activityVersionId, status: 'ready',
    attemptRevision: 1, workspaceRevision: 0, decisionEpoch: 0, captureRevision: 0, collecting: true, reminders: false,
  }, files: [], snapshots: [], jobs: [], runs: [], checks: [] })
})

it('scenario-bound sessions isolate authority while another login in the same scenario reads the same head', async () => {
  const attemptId = await createAttempt()
  const foreign = await call('GET', `/api/attempts/${attemptId}`, undefined, undefined, { 'x-i0prep-scenario': randomUUID() })
  expect(foreign.status).toBe(401)
  const credentials = { loginName: SYNTHETIC_ACCOUNT.loginName, password: SYNTHETIC_ACCOUNT.password }
  const login = await call('POST', '/api/sessions', credentials)
  const freshCookie = login.headers.getSetCookie()[0]!.split(';')[0]!
  expect((await call('GET', `/api/attempts/${attemptId}`, undefined, undefined, { Cookie: freshCookie })).status).toBe(200)
  const previousScenario = scenario
  scenario = randomUUID()
  const otherLogin = await call('POST', '/api/sessions', credentials)
  const otherCookie = otherLogin.headers.getSetCookie()[0]!.split(';')[0]!
  const otherCsrf = otherLogin.envelope.data.csrfToken
  expect((await call('GET', `/api/attempts/${attemptId}`, undefined, undefined, { Cookie: otherCookie })).status).toBe(403)
  const otherAttempt = await call('POST', `/api/assignments/${REFS.assignmentId}/attempts`, { recoveryGeneration: generation }, randomUUID(),
    { Cookie: otherCookie, 'x-csrf-token': otherCsrf })
  expect(otherAttempt.envelope.data.result.attemptId).not.toBe(attemptId)
  scenario = previousScenario
})

it('bootstrap offers only the existing scene Attempt reference, so refresh never POSTs to restore', async () => {
  const before = await call('GET', '/context')
  expect(before.envelope.data.scenarioId).toBe(scenario)
  expect(before.envelope.data.refs).not.toHaveProperty('attemptId')
  const attemptId = await createAttempt()
  const after = await call('GET', '/context')
  expect(after.envelope.data.refs.attemptId).toBe(attemptId)
  expect(after.envelope.data.capabilities.attemptCreate).toBe(true)
  expect((await call('GET', `/api/attempts/${after.envelope.data.refs.attemptId}`)).envelope.data.attempt.status).toBe('ready')
})

function batch(operations: unknown[], revision = 0, clientId = 'client-a', clientSeq = 0) {
  return { recoveryGeneration: generation, expectedWorkspaceRevision: revision, clientId, clientSeq, operations }
}

it('sync ACK provides created mapping and metadata; GET preserves exact Unicode and both real versions', async () => {
  const attemptId = await createAttempt()
  const path = `/api/attempts/${attemptId}/sync`
  const text = '\uFEFF中😀\r\nline\nlast\r\r\n'
  const input = batch([{ kind: 'create', clientFileKey: 'local-main', path: 'main.c', text }])
  const key = randomUUID()
  const saved = await call('POST', path, input, key)
  expect(saved.status).toBe(200)
  const receipt = saved.envelope.data
  const fileId = receipt.result.created['local-main']
  expect(receipt.identity).toEqual({ actorId: SYNTHETIC_ACCOUNT.userId, command: 'workspace.sync', target: path,
    scope: { courseId: SYNTHETIC_ACCOUNT.courseId, studentId: SYNTHETIC_ACCOUNT.userId, attemptId },
    idempotencyKey: key, recoveryGeneration: generation, sync: { clientId: 'client-a', clientSeq: 0 } })
  expect(receipt.result).toEqual({ workspaceRevision: 1, files: [{ fileId, path: 'main.c', documentVersion: 1,
    contentHash: 'ae2ee81aed06b99d22a1e44b940dd44c304ea4e2cba80fb40f0db9a14944152c', lifecycle: 'active' }],
    created: { 'local-main': fileId }, process: { status: 'not_collected', reason: 'not_requested' } })
  expect(receipt.replayed).toBe(false)
  expect(receipt.serverSeq).toBe(2)
  const head = (await call('GET', `/api/attempts/${attemptId}`)).envelope.data
  expect(head.attempt).toMatchObject({ status: 'active', attemptRevision: 2, workspaceRevision: 1 })
  expect(head.files[0]).toEqual({ ...receipt.result.files[0], attemptId, text })
  const updated = await call('POST', path, batch([{ kind: 'update', fileId, baseVersion: 1, text: 'next\r\n' }], 1, 'client-a', 1), randomUUID())
  expect(updated.status).toBe(200)
  const next = (await call('GET', `/api/attempts/${attemptId}`)).envelope.data
  expect(next.attempt).toMatchObject({ attemptRevision: 3, workspaceRevision: 2 })
  expect(next.files[0]).toMatchObject({ fileId, documentVersion: 2, text: 'next\r\n' })
})

it('both sync keys resolve one original ACK before CAS, bind aliases, and reject changed bodies atomically', async () => {
  const attemptId = await createAttempt(), path = `/api/attempts/${attemptId}/sync`
  const input = batch([{ kind: 'create', clientFileKey: 'a', path: 'main.c', text: 'original' }])
  const firstKey = randomUUID(), aliasKey = randomUUID()
  const first = (await call('POST', path, input, firstKey)).envelope.data
  const alias = await call('POST', path, input, aliasKey)
  expect(alias.status).toBe(200)
  expect(alias.envelope.data).toEqual({ ...first, replayed: true })
  expect((await call('POST', path, input, firstKey)).envelope.data).toEqual({ ...first, replayed: true })
  const changed = batch([{ kind: 'create', clientFileKey: 'a', path: 'main.c', text: 'changed' }], 1, 'different-client', 3)
  const changedAlias = await call('POST', path, changed, aliasKey)
  expect(changedAlias.status).toBe(409)
  expect(changedAlias.envelope.error.code).toBe('IDEMPOTENCY_CONFLICT')
  const changedSeq = await call('POST', path, { ...input, expectedWorkspaceRevision: 1 }, randomUUID())
  expect(changedSeq.envelope.error.code).toBe('IDEMPOTENCY_CONFLICT')
  const head = (await call('GET', `/api/attempts/${attemptId}`)).envelope.data
  expect(head.attempt.workspaceRevision).toBe(1)
  expect(head.files).toHaveLength(1)
  expect(head.files[0].text).toBe('original')
})

it('recycle/restore use instance versions; a late operation rejection leaves the entire head unchanged', async () => {
  const attemptId = await createAttempt(), path = `/api/attempts/${attemptId}/sync`
  const saved = await call('POST', path, batch([{ kind: 'create', clientFileKey: 'a', path: 'main.c', text: 'keep' }]), randomUUID())
  const fileId = saved.envelope.data.result.created.a
  const before = (await call('GET', `/api/attempts/${attemptId}`)).envelope.data
  const bad = await call('POST', path, batch([
    { kind: 'update', fileId, baseVersion: 1, text: 'must rollback' },
    { kind: 'create', clientFileKey: 'b', path: 'main.c', text: 'duplicate path' },
  ], 1, 'b', 0), randomUUID())
  expect(bad.envelope.error.code).toBe('STATE_CONFLICT')
  expect((await call('GET', `/api/attempts/${attemptId}`)).envelope.data).toEqual(before)
  const recycled = await call('POST', path, batch([{ kind: 'recycle', fileId, baseVersion: 1 }], 1, 'b', 0), randomUUID())
  expect(recycled.status).toBe(200) // failed batch did not consume the seq.
  expect(recycled.envelope.data.result.files[0]).toMatchObject({ fileId, lifecycle: 'recycled', documentVersion: 2 })
  const restored = await call('POST', path, batch([{ kind: 'restore', fileId, baseVersion: 2 }], 2, 'b', 1), randomUUID())
  expect(restored.status).toBe(200)
  expect((await call('GET', `/api/attempts/${attemptId}`)).envelope.data.files[0]).toMatchObject({ fileId, lifecycle: 'active', documentVersion: 3, text: 'keep' })
})

it('snapshot freezes confirmed active files, is retrievable after edits and replays its original identity', async () => {
  const attemptId = await createAttempt(), sync = `/api/attempts/${attemptId}/sync`
  const saved = await call('POST', sync, batch([
    { kind: 'create', clientFileKey: 'z', path: 'z.c', text: '\uFEFF😀\r\n\n' },
    { kind: 'create', clientFileKey: 'a', path: 'a.c', text: 'a\r' },
  ]), randomUUID())
  const ids = saved.envelope.data.result.created
  const snapshotPath = `/api/attempts/${attemptId}/snapshots`, key = randomUUID()
  const input = { recoveryGeneration: generation, expectedWorkspaceRevision: 1 }
  const frozen = await call('POST', snapshotPath, input, key)
  expect(frozen.status).toBe(200)
  const receipt = frozen.envelope.data, snapshotId = receipt.result.snapshotId
  expect(receipt.identity).toMatchObject({ command: 'snapshot.create', target: snapshotPath, idempotencyKey: key })
  expect(receipt.identity).not.toHaveProperty('sync')
  expect(receipt).toMatchObject({ replayed: false, serverSeq: 3, result: { workspaceRevision: 1 } })
  const original = await call('GET', `${snapshotPath}/${snapshotId}`)
  expect(original.status).toBe(200)
  const snapshot = original.envelope.data
  expect(snapshot).toMatchObject({ snapshotId, attemptId, activityVersionId: REFS.activityVersionId, workspaceRevision: 1,
    hashFormat: 'sha256-manifest-v1', hash: receipt.result.snapshotHash })
  // Worked manifest in known path order, with independently captured UTF-8 text digests.
  const expectedManifest = [[ids.a, 'a.c', 1, '961a57df036f6c4f44ca8a054271c45e823f469bcc439f0255c40974c3e3d131'],
    [ids.z, 'z.c', 1, 'e4bd63084f09822e3b598ee41b5cfb33e78eff272aff656f75cf311c4bb70ed2']]
  expect(snapshot.hash).toBe(createHash('sha256').update(JSON.stringify(expectedManifest)).digest('hex'))
  expect(snapshot.files).toEqual([
    { fileId: ids.z, path: 'z.c', documentVersion: 1, text: '\uFEFF😀\r\n\n', contentHash: saved.envelope.data.result.files[0].contentHash },
    { fileId: ids.a, path: 'a.c', documentVersion: 1, text: 'a\r', contentHash: saved.envelope.data.result.files[1].contentHash },
  ])
  const updated = await call('POST', sync, batch([{ kind: 'update', fileId: ids.z, baseVersion: 1, text: 'changed' },
    { kind: 'recycle', fileId: ids.a, baseVersion: 1 }], 1, 'client-a', 1), randomUUID())
  expect(updated.status).toBe(200)
  expect((await call('GET', `${snapshotPath}/${snapshotId}`)).envelope.data).toEqual(snapshot)
  expect((await call('POST', snapshotPath, input, key)).envelope.data).toEqual({ ...receipt, replayed: true })
  const head = (await call('GET', `/api/attempts/${attemptId}`)).envelope.data
  expect(head.snapshots).toEqual([snapshot])
  expect(head.attempt).toMatchObject({ attemptRevision: 3, workspaceRevision: 2 })
  const second = await call('POST', snapshotPath, { ...input, expectedWorkspaceRevision: 2 }, randomUUID())
  expect(second.status).toBe(200)
  const secondSnapshot = (await call('GET', `${snapshotPath}/${second.envelope.data.result.snapshotId}`)).envelope.data
  expect(secondSnapshot.files).toHaveLength(1)
  expect(secondSnapshot.files[0]).toMatchObject({ fileId: ids.z, text: 'changed', documentVersion: 2 })
  expect((await call('GET', `${snapshotPath}/not-existing`)).envelope.error.code).toBe('INVALID_REFERENCE')
})

it('prep recovery restores an earlier head and changes trusted generation; old requests cannot resurrect files', async () => {
  const attemptId = await createAttempt(), path = `/api/attempts/${attemptId}/sync`
  const key = randomUUID(), input = batch([{ kind: 'create', clientFileKey: 'a', path: 'main.c', text: 'g1 saved' }])
  const oldAck = (await call('POST', path, input, key)).envelope.data
  const snapshotPath = `/api/attempts/${attemptId}/snapshots`
  const snapshotKey = randomUUID(), snapshotInput = { recoveryGeneration: generation, expectedWorkspaceRevision: 1 }
  const snapshot = (await call('POST', snapshotPath, snapshotInput, snapshotKey)).envelope.data
  const originalGeneration = generation
  const recover = await call('POST', '/recover', { attemptId, workspaceRevision: 0 })
  expect(recover.status).toBe(200)
  expect(recover.envelope.data.recoveryGeneration).not.toBe(originalGeneration)
  const context = (await call('GET', '/context')).envelope.data
  expect(context.recoveryGeneration).toBe(recover.envelope.data.recoveryGeneration)
  expect(context.authority.recoveryGeneration).toBe(context.recoveryGeneration)
  expect(context.refs.attemptId).toBe(attemptId)
  const rolledBack = (await call('GET', `/api/attempts/${attemptId}`)).envelope.data
  expect(rolledBack).toMatchObject({ attempt: { workspaceRevision: 0, attemptRevision: 1, status: 'ready' }, files: [], snapshots: [], jobs: [], runs: [], checks: [] })
  expect((await call('POST', path, input, key)).envelope.error.code).toBe('RECOVERY_REQUIRED')
  expect((await call('POST', snapshotPath, snapshotInput, snapshotKey)).envelope.error.code).toBe('RECOVERY_REQUIRED')
  expect((await call('POST', `/api/assignments/${REFS.assignmentId}/attempts`, { recoveryGeneration: originalGeneration }, randomUUID())).envelope.error.code).toBe('RECOVERY_REQUIRED')
  expect((await call('GET', `${snapshotPath}/${snapshot.result.snapshotId}`)).envelope.error.code).toBe('INVALID_REFERENCE')
  expect((await call('GET', `/api/attempts/${attemptId}`)).envelope.data).toEqual(rolledBack)
  expect(oldAck.result.files).toHaveLength(1) // original HTTP fact stays intact; browser route controls ACK arrival.
  generation = context.recoveryGeneration
  const explicitNew = await call('POST', path, batch([{ kind: 'create', clientFileKey: 'a', path: 'main.c', text: 'compared g2' }]), randomUUID())
  expect(explicitNew.status).toBe(200)
  expect(explicitNew.envelope.data.result.created.a).not.toBe(oldAck.result.created.a)
})

it('valid UTF-16 changes follow backend raw LF range semantics and overlapping ranges reject atomically', async () => {
  const attemptId = await createAttempt(), path = `/api/attempts/${attemptId}/sync`
  const saved = await call('POST', path, batch([{ kind: 'create', clientFileKey: 'a', path: 'main.c', text: '😀A\r\nB\rC' }]), randomUUID())
  const fileId = saved.envelope.data.result.created.a
  const patches = batch([{ kind: 'update', fileId, baseVersion: 1, changes: [
    { range: { startLine: 1, startColumn: 3, endLine: 1, endColumn: 4 }, text: '中' },
    { range: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 4 }, text: 'Z' },
  ] }], 1, 'client-a', 1)
  const edited = await call('POST', path, patches, randomUUID())
  expect(edited.status).toBe(200)
  const head = (await call('GET', `/api/attempts/${attemptId}`)).envelope.data
  expect(head.files[0].text).toBe('😀中\r\nB\rZ')
  const bad = await call('POST', path, batch([{ kind: 'update', fileId, baseVersion: 2, changes: [
    { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 }, text: 'x' },
    { range: { startLine: 1, startColumn: 2, endLine: 1, endColumn: 4 }, text: 'y' },
  ] }], 2, 'client-a', 2), randomUUID())
  expect(bad.envelope.error.code).toBe('INVALID_REQUEST')
  expect((await call('GET', `/api/attempts/${attemptId}`)).envelope.data).toEqual(head)
})

it('all writes reuse cookie/CSRF guards, recovery is a strict dev-only command, and public context hides Attempt refs', async () => {
  const attemptId = await createAttempt(), createPath = `/api/assignments/${REFS.assignmentId}/attempts`
  for (const [path, input] of [
    [createPath, { recoveryGeneration: generation }],
    [`/api/attempts/${attemptId}/sync`, batch([{ kind: 'create', clientFileKey: 'a', path: 'a.c', text: '' }])],
    [`/api/attempts/${attemptId}/snapshots`, { recoveryGeneration: generation, expectedWorkspaceRevision: 0 }],
    ['/recover', { attemptId, workspaceRevision: 0 }],
  ] as const) {
    expect((await call('POST', path, input, randomUUID(), { Cookie: '' })).status).toBe(401)
    expect((await call('POST', path, input, randomUUID(), { 'x-csrf-token': '' })).status).toBe(403)
  }
  expect((await call('GET', '/context', undefined, undefined, { Cookie: '' })).envelope.data.refs).not.toHaveProperty('attemptId')
  expect((await call('POST', createPath, { recoveryGeneration: generation })).envelope.error.code).toBe('INVALID_REQUEST')
  const before = (await call('GET', `/api/attempts/${attemptId}`)).envelope.data
  expect((await call('POST', '/recover', { attemptId, workspaceRevision: 100 })).envelope.error.code).toBe('INVALID_REFERENCE')
  expect((await call('POST', '/recover', { attemptId, workspaceRevision: 0, recoveryGeneration: 'client-guessed' })).envelope.error.code).toBe('INVALID_REQUEST')
  expect((await call('GET', '/recover')).envelope.error.code).toBe('INVALID_REQUEST')
  expect((await call('GET', '/context')).envelope.data.recoveryGeneration).toBe(generation)
  expect((await call('GET', `/api/attempts/${attemptId}`)).envelope.data).toEqual(before)
  expect((await call('GET', '/context', undefined, undefined, { 'x-i0prep-scenario': '' })).status).toBe(400)
})

it('snapshot CAS and process coverage stay separate from confirmed saving; empty manifest uses the published hash format', async () => {
  const attemptId = await createAttempt(), snapshotPath = `/api/attempts/${attemptId}/snapshots`
  const empty = await call('POST', snapshotPath, { recoveryGeneration: generation, expectedWorkspaceRevision: 0 }, randomUUID())
  expect(empty.status).toBe(200)
  expect(empty.envelope.data.result.snapshotHash).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
  const path = `/api/attempts/${attemptId}/sync`
  const saved = await call('POST', path, { ...batch([{ kind: 'create', clientFileKey: 'a', path: 'main.c', text: '' }]),
    process: { captureRevision: 99 } }, randomUUID())
  expect(saved.status).toBe(200)
  expect(saved.envelope.data.result.process).toEqual({ status: 'not_collected', reason: 'stale_capture_revision' })
  const fileId = saved.envelope.data.result.created.a
  const accepted = await call('POST', path, { ...batch([{ kind: 'update', fileId, baseVersion: 1, text: 'accepted' }], 1, 'client-a', 1),
    process: { captureRevision: 0 } }, randomUUID())
  expect(accepted.envelope.data.result.process).toEqual({ status: 'eligible' })
  const before = (await call('GET', `/api/attempts/${attemptId}`)).envelope.data
  expect((await call('POST', snapshotPath, { recoveryGeneration: generation, expectedWorkspaceRevision: 1 }, randomUUID())).envelope.error.code).toBe('VERSION_CONFLICT')
  expect((await call('GET', `/api/attempts/${attemptId}`)).envelope.data).toEqual(before)
})

it.each([
  ['unsafe path', [{ kind: 'create', clientFileKey: 'a', path: '../escape.c', text: '' }], 'INVALID_REFERENCE'],
  ['invalid Unicode', [{ kind: 'create', clientFileKey: 'a', path: 'a.c', text: '\uD800' }], 'INVALID_REQUEST'],
  ['duplicate clientFileKey', [{ kind: 'create', clientFileKey: 'a', path: 'a.c', text: '' }, { kind: 'create', clientFileKey: 'a', path: 'b.c', text: '' }], 'INVALID_REQUEST'],
  ['foreign instance', [{ kind: 'create', clientFileKey: 'a', path: 'a.c', text: '' }, { kind: 'update', fileId: 'unknown', baseVersion: 1, text: '' }], 'INVALID_REFERENCE'],
  ['UTF-8 limit', [{ kind: 'create', clientFileKey: 'a', path: 'a.c', text: '中'.repeat(349526) }], 'CONTENT_LIMIT'],
  ['active file count', Array.from({ length: 51 }, (_, index) => ({ kind: 'create', clientFileKey: `f${index}`, path: `${index}.c`, text: '' })), 'CONTENT_LIMIT'],
])('%s rejects the entire sync without changing the head or consuming its keys', async (_description, operations, errorCode) => {
  const attemptId = await createAttempt(), path = `/api/attempts/${attemptId}/sync`
  const before = (await call('GET', `/api/attempts/${attemptId}`)).envelope.data
  const key = randomUUID()
  const rejected = await call('POST', path, batch(operations), key)
  expect(rejected.envelope.error).toMatchObject({ code: errorCode, retryable: false, recovery: expect.any(String) })
  expect((await call('GET', `/api/attempts/${attemptId}`)).envelope.data).toEqual(before)
  expect((await call('POST', path, batch([{ kind: 'create', clientFileKey: 'a', path: 'main.c', text: 'valid retry after rejection' }]), key)).status).toBe(200)
})

it('route references obey backend id bounds even when the snapshot collection is empty', async () => {
  const attemptId = await createAttempt(), oversized = 'x'.repeat(129)
  for (const [method, path, input] of [
    ['GET', `/api/attempts/${oversized}`, undefined],
    ['POST', `/api/assignments/${oversized}/attempts`, { recoveryGeneration: generation }],
    ['POST', `/api/attempts/${oversized}/sync`, batch([{ kind: 'create', clientFileKey: 'a', path: 'a.c', text: '' }])],
    ['POST', `/api/attempts/${oversized}/snapshots`, { recoveryGeneration: generation, expectedWorkspaceRevision: 0 }],
    ['GET', `/api/attempts/${attemptId}/snapshots/${oversized}`, undefined],
  ] as const) {
    const result = await call(method, path, input, randomUUID())
    expect(result.status).toBe(400)
    expect(result.envelope.error.code).toBe('INVALID_REQUEST')
  }
})
