// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data'
import { componentInstanceId, componentStateMediaType, componentStateName } from '@xunjie/contracts/components'
import { canonicalValue, type ExecutionHistoryEntry } from '@xunjie/contracts/execution'
import { schoolSubmissionInputSchema, type SchoolSubmission, type SchoolSubmissionInput } from '@xunjie/contracts/school-deliveries'
import { teachingArtifactRevisionSchema } from '@xunjie/contracts/teaching-artifacts'
import type { ArtifactEntry } from '../teaching-artifacts/useTeachingArtifacts'
import { ReliableWorkspace } from '../reliable-workspace'
import { ReliableRecordStore } from '../reliable-workspace/record-store'
import { workspaceScope } from './learningTransport'
import { ActivitySubmission, type ActivitySubmissionTransport } from './ActivitySubmission'

let root: Root, host: HTMLDivElement
const workspaces: ReliableWorkspace[] = []
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
async function waitFor(check: () => void) {
  for (let i = 0; i < 150; i++) {
    try { check(); return } catch (error) { if (i === 149) throw error }
    await act(settle)
  }
}
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)!
async function click(label: string) {
  await waitFor(() => { expect(button(label)).toBeDefined(); expect(button(label).disabled).toBe(false) })
  await act(async () => { button(label).click(); await settle() })
}
const hash = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(canonicalValue(value)))))].map(byte => byte.toString(16).padStart(2, '0')).join('')
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); await settle() })
  workspaces.splice(0).forEach(workspace => workspace.dispose())
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function fixture(additionalWorks?: (activity: LearningActivity, workspace: ReliableWorkspace) => WorkFile[]) {
  const identity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), kind: 'school' as const, name: 'Student' }
  const activity: LearningActivity = { activityId: crypto.randomUUID(), identity,
    target: { environmentId: identity.environmentId, serviceId: crypto.randomUUID(), version: 1 }, goal: 'Build', question: '', references: [],
    status: 'open', createdAt: new Date().toISOString(), course: { associationId: crypto.randomUUID(), courseId: crypto.randomUUID(), courseName: 'Course',
      taskId: crypto.randomUUID(), taskTitle: 'Task', releaseId: crypto.randomUUID(), contentDigest: 'a'.repeat(64), objectives: ['Build'], requirements: 'Submit',
      starterWorks: [], capabilities: [], materials: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } } }
  const file: WorkFile = { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: 'answer.txt',
    kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: 'original student work\r\n' }
  let remote = { revision: 0, files: [file] }
  const workspace = new ReliableWorkspace(workspaceScope('submission-test', activity), {
    read: async () => structuredClone(remote), receipt: async () => null,
    sync: async input => { remote = { revision: remote.revision + 1, files: structuredClone(input.files) }; return remote },
  })
  if (additionalWorks) remote.files.push(...additionalWorks(activity, workspace))
  workspaces.push(workspace); await workspace.open()
  const submissions = new Map<string, SchoolSubmission>(), posts: SchoolSubmissionInput[] = []
  let offline = false, drop = false, failPost = false
  const receiptFor = async (input: SchoolSubmissionInput) => {
    const { requestId, works, artifacts, evidence } = schoolSubmissionInputSchema.parse(input)
    const { environmentId, spaceId, principalId } = identity
    const course = activity.course!
    return { version: 1 as const, state: 'accepted' as const, requestId, submissionId: crypto.randomUUID(),
      scope: { environmentId, spaceId, principalId, activityId: activity.activityId },
      course: { courseId: course.courseId, taskId: course.taskId, releaseId: course.releaseId, contentDigest: course.contentDigest },
      receivedAt: new Date().toISOString(), contentDigest: await hash({ works, artifacts, evidence }) }
  }
  const transport: ActivitySubmissionTransport = {
    list: vi.fn(async () => {
      if (offline) throw new Error('offline')
      return { submissions: [...submissions.values()].map(({ works: _works, artifacts: _artifacts, evidence: _evidence, ...receipt }) => receipt) }
    }),
    receipt: vi.fn(async id => {
      if (offline) throw new Error('offline')
      const fixed = submissions.get(id)
      if (!fixed) return null
      const { works: _works, artifacts: _artifacts, evidence: _evidence, ...receipt } = fixed
      return receipt
    }),
    submit: vi.fn(async input => {
      posts.push(structuredClone(input))
      if (offline || failPost) throw new Error('offline')
      const receipt = await receiptFor(input); submissions.set(input.requestId, { ...receipt, ...structuredClone(input) })
      if (drop) throw new Error('response lost')
      return receipt
    }),
    read: vi.fn(async id => structuredClone([...submissions.values()].find(item => item.submissionId === id))),
    history: vi.fn(async () => []), artifact: vi.fn(async () => null),
  }
  const journalKey = JSON.stringify(['school-submissions', workspaceScope('submission-test', activity), activity.target.environmentId,
    activity.target.serviceId, activity.course!.releaseId])
  const readJournal = () => new ReliableRecordStore<{ key: string; entries: { input: SchoolSubmissionInput; receipt?: unknown }[] }>('agentControls').read(journalKey)
  const props = { activity, workspace, authorized: true, namespace: 'submission-test', spaceKey: 'school:test', artifacts: [] as ArtifactEntry[], transport }
  return { props, activity, file, workspace, transport, posts, receiptFor, readJournal, submissions,
    offline: (value: boolean) => { offline = value }, loseResponse: () => { drop = true }, failPost: (value: boolean) => { failPost = value } }
}
function makeArtifact(activity: LearningActivity): ArtifactEntry {
  const artifactId = crypto.randomUUID(), revisionId = crypto.randomUUID(), resourceId = crypto.randomUUID()
  const payload = { formatVersion: 1, title: '互动解释页', display: 'page', html: '<p>Original</p>', css: 'p{color:var(--ink)}', javascript: 'void 0',
    hostApiVersion: 1, stateVersion: 1, stateShape: { type: 'object', properties: {} }, initialState: {}, semanticFields: [], semanticObjects: [], requiredCapabilities: [] }
  const revision = teachingArtifactRevisionSchema.parse({ artifactId, activityId: activity.activityId, revisionId, version: 1,
    parentRevisionId: null, payload, resourceId, sha256: 'b'.repeat(64), byteLength: 15, origin: null, createdAt: new Date().toISOString(), mapping: [],
    binding: { key: `artifact-${artifactId}`, configuration: { title: 'Explanation' }, materialIds: [], definition: { digest: 'c'.repeat(64), manifest: {
      formatVersion: 1, componentId: artifactId, version: 1, title: 'Explanation', hostApiVersion: 1, stateVersion: 1,
      stateShape: payload.stateShape, initialState: {}, requiredCapabilities: [], entry: { resourceId, sha256: 'b'.repeat(64), byteLength: 15, mediaType: 'text/html' } } } } })
  return { artifact: { artifactId, activityId: activity.activityId, title: payload.title, display: 'page', activeRevisionId: revisionId,
    latestRevisionId: revisionId, latestCandidateId: crypto.randomUUID(), shelved: false, relatedArtifactId: null, createdAt: new Date().toISOString() }, revision, issue: '' }
}
function artifactState(activity: LearningActivity, workspace: ReliableWorkspace, entry: ArtifactEntry): WorkFile {
  const binding = entry.revision!.binding, manifest = binding.definition.manifest
  workspace.registerActivityBinding(binding)
  return { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: componentStateName(binding.key), kind: 'state', encoding: 'json',
    mediaType: componentStateMediaType, value: JSON.stringify({ formatVersion: 1, instanceId: componentInstanceId(activity.activityId, binding.key),
      componentId: manifest.componentId, version: manifest.version, definitionDigest: binding.definition.digest,
      stateVersion: manifest.stateVersion, operationId: crypto.randomUUID(), content: {} }) }
}
async function mount(props: Parameters<typeof ActivitySubmission>[0]) {
  await act(async () => { root.render(<ActivitySubmission {...props} />); await settle() })
}

it('hides school submission from personal and read-only activities without issuing requests', async () => {
  const f = await fixture()
  await mount({ ...f.props, activity: { ...f.activity, identity: { ...f.activity.identity, kind: 'personal' } } })
  expect(document.querySelector('button')).toBeNull(); expect(f.transport.list).not.toHaveBeenCalled()
  await mount({ ...f.props, workspace: { snapshot: f.workspace.snapshot, leave: () => f.workspace.leave(), isReadOnly: () => true } })
  expect(document.querySelector('button')).toBeNull()
  await mount({ ...f.props, activity: { ...f.activity, status: 'closed' } })
  await waitFor(() => expect(button('提交记录')).toBeDefined())
  expect(button('提交作品')).toBeUndefined()
})

it('fixes current works before confirmation, excludes private sources by default, and creates a new version only on another explicit submit', async () => {
  const f = await fixture(); await mount(f.props); await click('提交作品')
  await act(async () => { f.workspace.edit(f.file.objectId, 'later student work'); await f.workspace.leave(); await settle() })
  await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校已接收。'))
  expect(f.posts).toHaveLength(1); expect(f.posts[0].works[0].value).toBe(f.file.value)
  expect(Object.keys(f.posts[0]).sort()).toEqual(['artifacts', 'evidence', 'requestId', 'works'])
  expect(f.posts[0].artifacts).toEqual([]); expect(f.posts[0].evidence).toEqual([])
  await click('查看提交内容')
  expect(document.querySelector('[aria-label="已提交作品（只读）"]')?.textContent).toContain(f.file.value)
  expect(document.querySelector('[aria-label="已提交作品（只读）"] input')).toBeNull()
  await click('返回作品'); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(f.posts).toHaveLength(2))
  expect(f.posts[1].requestId).not.toBe(f.posts[0].requestId); expect(f.posts[1].works[0].value).toBe('later student work')
})

it('recovers a lost POST response by querying its original receipt without creating another submission', async () => {
  const f = await fixture(); f.loseResponse(); await mount(f.props); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校已接收。'))
  expect(f.posts).toHaveLength(1)
  expect(f.transport.receipt).toHaveBeenLastCalledWith(f.posts[0].requestId)
  expect((await f.readJournal())?.entries[0].receipt).toBeDefined()
})

it('uses cached accepted receipt, list and original payload while the school is offline without another POST', async () => {
  const f = await fixture(); f.failPost(true); await mount(f.props); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校尚未确认接收。'))
  const original = structuredClone(f.posts[0]), receipt = await f.receiptFor(original), payload = { ...receipt, ...original }
  // Fake transport models the runtime's persistent school-read cache; IndexedDB remains real.
  f.offline(true)
  vi.mocked(f.transport.receipt).mockResolvedValue(structuredClone(receipt))
  vi.mocked(f.transport.list).mockResolvedValue({ submissions: [structuredClone(receipt)] })
  vi.mocked(f.transport.read).mockResolvedValue(structuredClone(payload))
  await mount({ ...f.props, spaceKey: 'school:offline-rebind' })
  await waitFor(() => expect(button('提交作品').disabled).toBe(false))
  expect((await f.readJournal())!.entries[0].receipt).toEqual(receipt)
  await click('提交作品'); await click('查看提交内容')
  expect(document.querySelector('[aria-label="已提交作品（只读）"]')?.textContent).toContain(f.file.value)
  expect(f.posts).toHaveLength(1)
})

it('keeps an offline cached null receipt unknown and retries only the original ID and input', async () => {
  const f = await fixture(); f.failPost(true); await mount(f.props); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校尚未确认接收。'))
  const original = structuredClone(f.posts[0]); f.offline(true)
  vi.mocked(f.transport.receipt).mockResolvedValue(null)
  await mount({ ...f.props, spaceKey: 'school:cached-null' })
  await waitFor(() => expect(button('核对提交').disabled).toBe(false))
  expect((await f.readJournal())!.entries[0].receipt).toBeUndefined()
  await click('核对提交'); await click('核对并重试原提交')
  expect(f.posts.length).toBeGreaterThanOrEqual(3)
  f.posts.forEach(input => expect(input).toEqual(original))
  expect(document.body.textContent).not.toContain('学校已接收。')
})

it('checks cached payload scope and content digest against the accepted receipt before rendering it', async () => {
  const f = await fixture(); await mount(f.props); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校已接收。'))
  const fixed = structuredClone(f.submissions.get(f.posts[0].requestId)!)
  const invalid = [
    { ...fixed, scope: { ...fixed.scope, principalId: crypto.randomUUID() } },
    { ...fixed, works: [{ ...fixed.works[0], value: 'changed cached payload' }] },
    { ...fixed, contentDigest: '0'.repeat(64) },
  ]
  for (const payload of invalid) {
    vi.mocked(f.transport.read).mockResolvedValueOnce(payload)
    await click('查看提交内容')
    expect(document.querySelector('[aria-label="已提交作品（只读）"]')).toBeNull()
    expect(document.body.textContent).toContain('暂时无法回读这次提交')
  }
  expect(f.posts).toHaveLength(1)
})

it('retains the whole original input through offline POST, refresh and later editing; recovery reuses its request ID', async () => {
  const f = await fixture(); f.failPost(true); await mount(f.props); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校尚未确认接收。'))
  const original = structuredClone(f.posts[0]); expect((await f.readJournal())?.entries[0].input).toEqual(original)
  await act(async () => { root.unmount(); await settle() }); root = createRoot(host)
  await act(async () => { f.workspace.edit(f.file.objectId, 'after refresh edit'); await f.workspace.leave() })
  f.failPost(false); await mount(f.props)
  await waitFor(() => expect(f.posts).toHaveLength(2))
  await waitFor(() => expect(button('提交作品').disabled).toBe(false))
  expect(f.posts[1]).toEqual(original)
  await click('提交作品')
  expect(document.body.textContent).toContain('学校已接收')
})

it('does not send until IndexedDB protection commits, and retains the prepared identity when local protection is retried', async () => {
  const f = await fixture(); await mount(f.props); await click('提交作品')
  const put = IDBObjectStore.prototype.put, attempts: SchoolSubmissionInput[] = []
  const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'agentControls') { attempts.push(structuredClone(value.entries[0].input)); throw new DOMException('quota', 'QuotaExceededError') }
    return put.call(this, value, key)
  })
  await click('确认提交')
  expect(document.body.textContent).toContain('这次提交尚未在本机可靠保留'); expect(f.posts).toHaveLength(0)
  failure.mockRestore(); await click('确认提交')
  await waitFor(() => expect(f.posts).toHaveLength(1)); expect(f.posts[0]).toEqual(attempts[0])
})

it('keeps an offline receipt lookup pending locally and retries that exact request when the connection returns', async () => {
  const f = await fixture(); await mount(f.props); await click('提交作品'); f.offline(true); await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校尚未确认接收。'))
  const original = (await f.readJournal())!.entries[0].input
  expect(f.posts).toHaveLength(0)
  f.offline(false)
  await act(async () => { window.dispatchEvent(new Event('online')); await settle() })
  await waitFor(() => expect(document.body.textContent).toContain('学校已接收。'))
  expect(f.posts).toEqual([original])
})

it('rejects an accepted receipt for a different subject and preserves the original pending input', async () => {
  const f = await fixture()
  vi.mocked(f.transport.submit).mockImplementation(async input => {
    f.posts.push(structuredClone(input))
    const receipt = await f.receiptFor(input)
    return { ...receipt, scope: { ...receipt.scope, principalId: crypto.randomUUID() } }
  })
  await mount(f.props); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校尚未确认接收。'))
  expect((await f.readJournal())!.entries[0].receipt).toBeUndefined()
  expect(document.body.textContent).not.toContain('学校已接收。')
})

it('only attaches explicitly selected full artifact payloads and verified original experiment results', async () => {
  const f = await fixture(), entry = makeArtifact(f.activity), revision = entry.revision!, { artifactId, revisionId } = revision
  const requestId = crypto.randomUUID(), executionRef = crypto.randomUUID(), text = 'original result', sha256 = await hash(text)
  const original = { requestId, executionRef, name: '观察结果.json', text, sha256, byteLength: text.length, mediaType: 'application/json',
    resources: [{ contentId: crypto.randomUUID(), name: 'wave.txt', text: 'wave', sha256: await hash('wave'), byteLength: 4, mediaType: 'text/plain' }] }
  vi.mocked(f.transport.history).mockResolvedValue([{ createdAt: new Date().toISOString(), query: { requestId, executionRef, state: 'succeeded',
    output: { artifact: { name: original.name, sha256, byteLength: text.length, mediaType: original.mediaType } } } } as ExecutionHistoryEntry])
  vi.mocked(f.transport.artifact).mockResolvedValue({ ...original, output: null })
  await mount({ ...f.props, artifacts: [entry] }); await click('提交作品')
  await waitFor(() => expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(2))
  expect([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(item => !item.checked)).toBe(true)
  await act(async () => { document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(item => item.click()); await settle() })
  await click('确认提交'); await waitFor(() => expect(f.posts).toHaveLength(1))
  expect(f.posts[0].artifacts).toEqual([{ artifactId, revisionId, payload: revision.payload }])
  expect(f.posts[0].evidence).toEqual([{ requestId, executionRef, mediaType: original.mediaType, text, resources: original.resources }])
  expect(f.transport.artifact).toHaveBeenCalledExactlyOnceWith(requestId)
})

it('keeps composition focused and captures before a slow protection await, excluding later edits', async () => {
  const f = await fixture(); await mount(f.props)
  const input = document.createElement('textarea'); host.append(input); input.focus()
  await act(async () => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); await settle() })
  const pointer = new Event('pointerdown', { bubbles: true, cancelable: true }); button('提交作品').dispatchEvent(pointer)
  expect(pointer.defaultPrevented).toBe(true); await click('提交作品')
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(input)
  await act(async () => { input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await settle() })
  let release!: () => void
  const beforeFreeze = () => new Promise<void>(resolve => { release = resolve })
  await mount({ ...f.props, beforeFreeze }); await click('提交作品')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { f.workspace.edit(f.file.objectId, 'composition committed'); release(); await settle() })
  await click('确认提交'); await waitFor(() => expect(f.posts).toHaveLength(1))
  expect(f.posts[0].works[0].value).toBe(f.file.value)
})

it('recovers a pending submission when the same account rebinds with a different connection ID', async () => {
  const f = await fixture(); f.failPost(true); await mount(f.props); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(f.posts).toHaveLength(1))
  await waitFor(() => expect(document.body.textContent).toContain('学校尚未确认接收。'))
  const original = structuredClone(f.posts[0]); f.failPost(false)
  await mount({ ...f.props, spaceKey: 'school:rebound-connection' })
  await waitFor(() => expect(f.posts).toHaveLength(2))
  expect(f.posts[1]).toEqual(original)
  await waitFor(() => expect(button('提交作品').disabled).toBe(false))
  expect((await f.readJournal())!.entries[0].receipt).toBeDefined()
})

it('migrates an older connection-keyed pending journal even when it is reopened through a new connection', async () => {
  const f = await fixture(), oldKey = JSON.stringify(['school-submissions', workspaceScope('submission-test', f.activity),
    f.activity.target.environmentId, f.activity.target.serviceId, 'school:old-connection', f.activity.course!.releaseId])
  const original = { requestId: crypto.randomUUID(), works: [f.file], artifacts: [], evidence: [] }
  await new ReliableRecordStore<{ key: string; entries: { input: SchoolSubmissionInput }[] }>('agentControls')
    .change(oldKey, () => ({ key: oldKey, entries: [{ input: original }] }))
  await mount({ ...f.props, spaceKey: 'school:new-connection' })
  await waitFor(() => expect(f.posts).toHaveLength(1))
  expect(f.posts[0]).toEqual(original)
  await waitFor(() => expect(button('提交作品').disabled).toBe(false))
  expect((await f.readJournal())!.entries[0].receipt).toBeDefined()
})

it('includes the active artifact payload required by a submitted state and does not default-select an unadopted candidate', async () => {
  const entries: ArtifactEntry[] = []
  const f = await fixture((activity, workspace) => {
    const active = makeArtifact(activity), candidate = makeArtifact(activity)
    candidate.artifact.activeRevisionId = null; candidate.artifact.title = '尚未采用的候选页'; candidate.revision!.payload.title = candidate.artifact.title
    entries.push(active, candidate)
    return [artifactState(activity, workspace, active)]
  })
  await mount({ ...f.props, artifacts: entries }); await click('提交作品')
  const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  expect(boxes).toHaveLength(2); expect(boxes[0].checked).toBe(true); expect(boxes[0].disabled).toBe(true)
  expect(boxes[1].checked).toBe(false)
  const originalPayload = structuredClone(entries[0].revision!.payload)
  entries[0].revision!.payload.html = '<p>Changed after opening</p>'
  await click('确认提交'); await waitFor(() => expect(f.posts).toHaveLength(1))
  expect(f.posts[0].works.some(file => file.mediaType === componentStateMediaType)).toBe(true)
  expect(f.posts[0].artifacts).toEqual([{ artifactId: entries[0].artifact.artifactId, revisionId: entries[0].revision!.revisionId, payload: originalPayload }])
})

it('keeps the explicit school retry entry usable before current artifact templates finish loading', async () => {
  const entries: ArtifactEntry[] = []
  const f = await fixture((activity, workspace) => {
    const entry = makeArtifact(activity); entries.push(entry); return [artifactState(activity, workspace, entry)]
  })
  f.failPost(true); await mount({ ...f.props, artifacts: entries }); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校尚未确认接收。'))
  const original = structuredClone(f.posts[0])
  await click('返回作品'); await mount({ ...f.props, artifacts: [] }); await click('核对提交')
  expect(document.querySelector('[aria-label="待确认的原提交"]')?.textContent).toContain(entries[0].artifact.title)
  // A school process can recover without a browser online event; the manual entry must be sufficient.
  f.failPost(false); await click('核对并重试原提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校已接收。'))
  expect(f.posts).toEqual([original, original])
})

it('can query an existing school receipt after the activity closes, without resending to a closed activity', async () => {
  const f = await fixture(); f.failPost(true); await mount(f.props); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校尚未确认接收。'))
  const original = structuredClone(f.posts[0])
  await mount({ ...f.props, activity: { ...f.activity, status: 'closed' } })
  await waitFor(() => expect(button('核对提交').disabled).toBe(false))
  expect(f.posts).toHaveLength(1)
  f.submissions.set(original.requestId, { ...await f.receiptFor(original), ...original })
  await click('核对提交'); await click('核对并重试原提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校已接收。'))
  expect(f.posts).toHaveLength(1)
})

it('does not offer a new submission whose artifact state lacks the corresponding adopted payload', async () => {
  const f = await fixture((activity, workspace) => [artifactState(activity, workspace, makeArtifact(activity))])
  await mount(f.props); await click('提交作品')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.body.textContent).toContain('作品中的教学页面尚未就绪')
  expect(f.posts).toHaveLength(0); expect(await f.readJournal()).toBeUndefined()
})

it('reads submitted pages as inert static previews and uses their fixed workstate without exposing the implementation payload', async () => {
  const entries: ArtifactEntry[] = []
  const f = await fixture((activity, workspace) => {
    const entry = makeArtifact(activity), revision = entry.revision!
    revision.payload = { ...revision.payload, html: '<h2>结果解释</h2><button>重新运行</button><script>window.shouldNotRun=true</script>',
      javascript: 'window.implementationOnly=true', requiredCapabilities: ['workspace.read'],
      stateShape: { type: 'object', properties: { answer: { type: 'string', maxLength: 100 } } },
      initialState: { answer: 'initial template text' }, semanticFields: [{ key: 'answer', meaning: '你的解答' }] }
    revision.binding.definition.manifest.stateShape = revision.payload.stateShape
    revision.binding.definition.manifest.initialState = revision.payload.initialState
    const file = artifactState(activity, workspace, entry)
    file.value = JSON.stringify({ ...JSON.parse(file.value), content: { answer: 'submitted student answer' } })
    entries.push(entry); return [file]
  })
  await mount({ ...f.props, artifacts: entries }); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校已接收。'))
  expect(f.posts[0].artifacts[0].payload.javascript).toBe('window.implementationOnly=true')
  entries[0].revision!.payload.initialState = { answer: 'later template text' }
  await click('查看提交内容')
  const section = document.querySelector('[aria-label="已提交作品（只读）"]')!
  expect(section.textContent).toContain('你的解答'); expect(section.textContent).toContain('submitted student answer')
  for (const internal of ['hostApiVersion', 'requiredCapabilities', 'javascript', 'initial template text', 'later template text', 'definitionDigest'])
    expect(section.textContent).not.toContain(internal)
  const frame = section.querySelector('iframe')!
  expect(frame.getAttribute('sandbox')).toBe('')
  const preview = new DOMParser().parseFromString(frame.srcdoc, 'text/html')
  expect(preview.querySelector('h2')?.textContent).toBe('结果解释')
  expect(preview.querySelector('script')).toBeNull(); expect(preview.querySelector('button')?.disabled).toBe(true)
})

it('rejects an empty selection locally with the shared schema before protecting or posting an invalid request', async () => {
  const f = await fixture()
  await act(async () => { f.workspace.remove(f.file.objectId); await f.workspace.leave() })
  await mount(f.props); await click('提交作品'); await click('确认提交')
  expect(document.body.textContent).toContain('请至少选择一份作品或结果')
  expect(f.posts).toHaveLength(0); expect(await f.readJournal()).toBeUndefined()
})

it('ignores a late accepted reply after switching activities and does not expose the old scope in the new dialog', async () => {
  const f = await fixture(); let resolve!: (value: unknown) => void
  vi.mocked(f.transport.submit).mockImplementation(input => { f.posts.push(structuredClone(input)); return new Promise(done => { resolve = done }) })
  await mount(f.props); await click('提交作品'); await click('确认提交')
  await waitFor(() => expect(f.posts).toHaveLength(1))
  const next = await fixture(); await mount(next.props)
  await act(async () => { resolve(await f.receiptFor(f.posts[0])); await settle() })
  expect(document.body.textContent).not.toContain('学校已接收。')
  expect(await next.readJournal()).toBeUndefined()
  await click('提交作品'); expect(document.body.textContent).toContain('还没有学校已确认的提交。')
})

it('offers stopped native observations only by explicit selection and retains their original reference', async () => {
  const f = await fixture(), requestId = crypto.randomUUID(), executionRef = crypto.randomUUID(), controlId = crypto.randomUUID()
  f.transport.nativeSessions = vi.fn(async () => [{ requestId, executionRef, inputDigest: 'a'.repeat(64),
    scope: { environmentId: f.activity.identity.environmentId, spaceId: f.activity.identity.spaceId,
      principalId: f.activity.identity.principalId, activityId: f.activity.activityId },
    state: 'cancelled' as const, statusKnowledge: 'confirmed' as const, stopRequested: true, confirmedSeq: 2, reason: null, output: null,
    session: { adapterId: 'four-state-accumulator', adapterVersion: 1, instanceId: f.activity.activityId + ':counter',
      instanceKey: 'counter', nodeId: 'local-darwin', installGeneration: '1', supervisorEpoch: crypto.randomUUID(),
      executorInstanceId: crypto.randomUUID(), appliedSeq: 1, lastControlId: controlId, observation: { value: 3 },
      observations: [{ seq: 1, controlId, state: { value: 3 }, at: new Date().toISOString() }] } }])
  await mount(f.props); await click('提交作品')
  await waitFor(() => expect(document.body.textContent).toContain('本机会话观察'))
  const choice = [...document.querySelectorAll('label')].find(label => label.textContent?.includes('本机会话观察'))!.querySelector('input')!
  expect(choice.checked).toBe(false)
  await act(async () => { choice.click(); await settle() })
  await click('确认提交')
  await waitFor(() => expect(document.body.textContent).toContain('学校已接收'))
  expect(f.posts[0].evidence).toHaveLength(1)
  expect(f.posts[0].evidence[0]).toMatchObject({ requestId, executionRef, mediaType: 'application/json' })
  expect(JSON.parse(f.posts[0].evidence[0].text).observations[0]).toMatchObject({ seq: 1, controlId, state: { value: 3 } })
  expect(f.transport.artifact).not.toHaveBeenCalled()
  await click('查看提交内容')
  await waitFor(() => expect(document.body.textContent).toContain('第 1 次观察'))
  expect(document.body.textContent).not.toContain(controlId)
})
