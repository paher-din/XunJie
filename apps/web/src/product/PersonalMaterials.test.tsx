// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { PersonalMaterial, PersonalMaterialMediaType, PersonalMaterialSave } from '@xunjie/contracts/personal-materials'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { SelectionToolbar, WorkspaceReferencesProvider, useWorkspaceReferences } from '../components/workspace/references'
import { PersonalMaterialEntries, PersonalMaterials, usePersonalMaterials } from './PersonalMaterials'
import { Toaster, toast } from '@xunjie/ui/feedback'

vi.mock('./learningTransport', async importOriginal => {
  const actual = await importOriginal<typeof import('./learningTransport')>()
  return { ...actual, learningRequest: vi.fn() }
})
import { learningRequest } from './learningTransport'

const request = vi.mocked(learningRequest)
let root: Root, host: HTMLDivElement
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const waitFor = async (check: () => void) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { check(); return } catch (error) { if (attempt === 199) throw error }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  }
}
const button = (label: string) => Array.from(document.querySelectorAll('button')).find(item => item.textContent === label) as HTMLButtonElement
const click = async (label: string) => act(async () => {
  const target = button(label)
  if (!target) throw new Error('missing button: ' + label)
  target.click(); await settle()
})
const setInput = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
})
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(text))), value => value.toString(16).padStart(2, '0')).join('')
const decode = (value: string) => new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0)))
const identity: SpaceIdentity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(),
  principalId: crypto.randomUUID(), name: '测试者', kind: 'personal' }
const makeActivity = (): LearningActivity => ({ activityId: crypto.randomUUID(), identity,
  target: { environmentId: identity.environmentId, serviceId: crypto.randomUUID(), version: 1 },
  goal: '学习个人笔记', question: '', references: [], status: 'open', createdAt: new Date().toISOString() })
async function makeVersion(materialId: string, version: number, name: string, mediaType: PersonalMaterialMediaType,
  text: string, requestId: string = crypto.randomUUID()) {
  return { materialId, version, requestId, name, mediaType, sha256: await digest(text),
    byteLength: new TextEncoder().encode(text).length, createdAt: new Date().toISOString() }
}
async function makeMaterial(activityId: string, name: string, mediaType: PersonalMaterialMediaType, text: string): Promise<PersonalMaterial> {
  const materialId = crypto.randomUUID(), requestId = crypto.randomUUID()
  const version = await makeVersion(materialId, 1, name, mediaType, text, requestId)
  return { materialId, activityId, requestId, name, mediaType, currentVersion: 1,
    createdAt: new Date().toISOString(), removedAt: null, versions: [version] }
}

function Probe({ activity, probe, probeRange, reveal }: { activity: LearningActivity; probe?: unknown;
  probeRange?: { start: number; end: number }; reveal: () => Promise<void> }) {
  const personal = usePersonalMaterials({ activity, spaceKey: 'personal', namespace: 'test', authorized: true, reveal })
  const references = useWorkspaceReferences()
  const [located, setLocated] = useState('')
  return <div>
    <Toaster />
    <PersonalMaterialEntries personal={personal} />
    <PersonalMaterials personal={personal} onBack={() => {}} />
    <button type="button" onClick={() => { void personal.locate(probe, probeRange).then(result => setLocated(JSON.stringify(result))) }}>probe-locate</button>
    <button type="button" onClick={() => references.locate(references.references[0]!)}>probe-reference-locate</button>
    <output data-testid="locate">{located}</output>
    <output data-testid="refs">{JSON.stringify(references.references.map(reference => ({ source: reference.source,
      range: reference.range, copy: reference.text, sourceName: reference.sourceName, kind: reference.kind })))}</output>
    <SelectionToolbar />
  </div>
}

const mount = async (activity: LearningActivity, probe?: unknown, reveal: () => Promise<void> = async () => {},
  probeRange?: { start: number; end: number }) => act(async () => {
  root.render(<WorkspaceReferencesProvider workspaceKey="test-workspace" onSubmit={() => {}}>
    <Probe activity={activity} probe={probe} probeRange={probeRange} reveal={reveal} />
  </WorkspaceReferencesProvider>)
  await settle()
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  request.mockReset()
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
  if (typeof globalThis.CSS === 'undefined') vi.stubGlobal('CSS', {
    escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`) })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { toast.dismiss(); root.unmount(); await settle() })
  host.remove(); vi.unstubAllGlobals()
})

it('lists personal materials and opens a fixed version', async () => {
  const activity = makeActivity()
  const material = await makeMaterial(activity.activityId, '课堂笔记', 'text/plain', '第一版正文')
  const content = { material, version: material.versions[0], text: '第一版正文' }
  request.mockImplementation(async (_activity, _spaceKey, _namespace, route) => {
    if (route === `materials/${activity.activityId}`) return [material]
    if (route === `materials/${activity.activityId}/${material.materialId}/versions/1`) return content
    throw Object.assign(new Error('missing'), { code: 'missing' })
  })
  const reveal = vi.fn(async () => {})
  await mount(activity, undefined, reveal)
  await waitFor(() => { expect(host.textContent).toContain('课堂笔记'); expect(host.textContent).toContain('第 1 版') })
  await click('打开')
  await waitFor(() => expect(host.querySelector('.personal-material-reading .wr-text-source')?.textContent).toBe('第一版正文'))
  expect(reveal).toHaveBeenCalled()
})

it('retains an add request and verifies the original requestId after an unknown acknowledgement', async () => {
  const activity = makeActivity()
  const receipts = new Map<string, PersonalMaterial>()
  const posts: PersonalMaterialSave[] = []
  request.mockImplementation(async (_activity, _spaceKey, _namespace, route, body) => {
    if (route === `materials/${activity.activityId}` && body === undefined) return []
    const receipt = /^materials\/[^/]+\/requests\/([0-9a-f-]{36})$/.exec(route)
    if (receipt) return receipts.get(receipt[1]) ?? null
    if (route === `materials/${activity.activityId}` && body) {
      const input = body as PersonalMaterialSave
      posts.push(input)
      const text = decode(input.dataBase64)
      const version = await makeVersion(input.materialId, 1, input.name, input.mediaType, text, input.requestId)
      const material: PersonalMaterial = { materialId: input.materialId, activityId: activity.activityId,
        requestId: input.requestId, name: input.name, mediaType: input.mediaType, currentVersion: 1,
        createdAt: new Date().toISOString(), removedAt: null, versions: [version] }
      receipts.set(input.requestId, material)
      throw new TypeError('synthetic ACK loss')
    }
    throw new Error('unexpected route ' + route)
  })
  await mount(activity)
  await click('添加笔记')
  await setInput(host.querySelector<HTMLInputElement>('[aria-label="个人笔记名称"]')!, '我的笔记')
  await setInput(host.querySelector<HTMLTextAreaElement>('[aria-label="个人笔记正文"]')!, '第一条正文')
  await click('保存笔记')
  await waitFor(() => {
    expect(host.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('尚未确认原服务结果')
    expect(host.textContent).toContain('保存尚未确认')
  })
  expect(posts).toHaveLength(1)
  await click('核对并继续原请求')
  await waitFor(() => {
    expect(host.querySelectorAll('.personal-material-list li')).toHaveLength(1)
    expect(host.querySelector('[data-sonner-toast][data-type="success"]')?.textContent).toContain('已保存「我的笔记」')
  })
  expect(posts).toHaveLength(1)
  expect(posts[0].requestId).toBe([...receipts.keys()][0])
  expect(posts[0].name).toBe('我的笔记')
  expect(decode(posts[0].dataBase64)).toBe('第一条正文')
})

it('appends a new version and keeps the reading content visible', async () => {
  const activity = makeActivity()
  const material = await makeMaterial(activity.activityId, '学习记录', 'text/markdown', '第一版内容')
  const content = { material, version: material.versions[0], text: '第一版内容' }
  const updates: Record<string, unknown>[] = []
  request.mockImplementation(async (_activity, _spaceKey, _namespace, route, body) => {
    if (route === `materials/${activity.activityId}` && body === undefined) return [material]
    if (route === `materials/${activity.activityId}/${material.materialId}/versions/1` && body === undefined) return content
    if (route === `materials/${activity.activityId}/requests/${(body as { requestId?: string })?.requestId ?? 'none'}`) return null
    if (route === `materials/${activity.activityId}/${material.materialId}` && body) {
      const input = body as { requestId: string; expectedVersion: number; dataBase64: string }
      updates.push(input)
      const text = decode(input.dataBase64)
      const version = await makeVersion(material.materialId, 2, material.name, material.mediaType, text, input.requestId)
      return { ...material, currentVersion: 2, versions: [...material.versions, version] }
    }
    const receipt = /\/requests\/([0-9a-f-]{36})$/.exec(route)
    if (receipt) return null
    throw new Error('unexpected route ' + route)
  })
  await mount(activity)
  await waitFor(() => expect(host.querySelectorAll('.personal-material-list li')).toHaveLength(1))
  await click('打开')
  await waitFor(() => expect(host.querySelector('.personal-material-reading .wr-text-source')?.textContent).toBe('第一版内容'))
  await click('更新为当前文本')
  const editor = host.querySelector<HTMLTextAreaElement>('[aria-label="更新个人笔记正文"]')!
  expect(editor.value).toBe('第一版内容')
  await setInput(editor, '第二版内容')
  await click('保存新版本')
  await waitFor(() => { expect(host.querySelector('.personal-material-version')?.textContent).toBe('第 2 版'); expect(host.querySelector('.personal-material-reading .wr-text-source')?.textContent).toBe('第二版内容') })
  expect(updates).toHaveLength(1)
  expect(updates[0]).toMatchObject({ materialId: material.materialId, expectedVersion: 1 })
  expect(decode(updates[0].dataBase64 as string)).toBe('第二版内容')
})

it('locates an older fixed-version reference after the material gets a new version', async () => {
  const activity = makeActivity()
  const material = await makeMaterial(activity.activityId, '版本笔记', 'text/plain', '第一版正文内容')
  const content = { material, version: material.versions[0], text: '第一版正文内容' }
  request.mockImplementation(async (_activity, _spaceKey, _namespace, route, body) => {
    if (route === `materials/${activity.activityId}` && body === undefined) return [material]
    if (route === `materials/${activity.activityId}/${material.materialId}/versions/1` && body === undefined) return content
    if (route === `materials/${activity.activityId}/${material.materialId}` && body) {
      const input = body as { requestId: string; dataBase64: string }
      const text = decode(input.dataBase64)
      const version = await makeVersion(material.materialId, 2, material.name, material.mediaType, text, input.requestId)
      return { ...material, currentVersion: 2, versions: [...material.versions, version] }
    }
    if (/\/requests\/[0-9a-f-]{36}$/.test(route)) return null
    throw new Error('unexpected route ' + route)
  })
  await mount(activity)
  await waitFor(() => expect(host.querySelectorAll('.personal-material-list li')).toHaveLength(1))
  await click('打开')
  const source = await (async () => { let found: HTMLElement | null = null
    await waitFor(() => { found = host.querySelector<HTMLElement>('.personal-material-reading .wr-text-source'); expect(found).not.toBeNull() })
    return found! })()
  const start = content.text.indexOf('第一版'), end = start + '第一版'.length
  await act(async () => {
    const range = document.createRange()
    range.setStart(source.firstChild!, start); range.setEnd(source.firstChild!, end)
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange')); await settle()
  })
  await waitFor(() => expect(button('询问 Agent')).toBeTruthy())
  await click('询问 Agent')
  await click('更新为当前文本')
  await setInput(host.querySelector<HTMLTextAreaElement>('[aria-label="更新个人笔记正文"]')!, '第二版正文内容')
  await click('保存新版本')
  await waitFor(() => expect(host.querySelector('.personal-material-version')?.textContent).toBe('第 2 版'))
  await click('probe-reference-locate')
  await waitFor(() => { expect(host.querySelector('.personal-material-version')?.textContent).toBe('第 1 版')
    expect(document.getSelection()?.toString()).toBe('第一版') })
})

it('removes a personal material with its expected version', async () => {
  const activity = makeActivity()
  const material = await makeMaterial(activity.activityId, '待移除笔记', 'text/plain', '准备移除')
  const removes: Record<string, unknown>[] = []
  request.mockImplementation(async (_activity, _spaceKey, _namespace, route, body) => {
    if (route === `materials/${activity.activityId}` && body === undefined) return [material]
    if (route === `materials/${activity.activityId}/${material.materialId}/remove` && body) {
      removes.push(body as Record<string, unknown>)
      return { ...material, removedAt: new Date().toISOString() }
    }
    if (/\/requests\/[0-9a-f-]{36}$/.test(route)) return null
    throw new Error('unexpected route ' + route)
  })
  await mount(activity)
  await waitFor(() => expect(host.querySelectorAll('.personal-material-list li')).toHaveLength(1))
  await click('移除')
  await waitFor(() => expect(host.querySelectorAll('.personal-material-list li')).toHaveLength(0))
  expect(removes).toHaveLength(1)
  expect(removes[0]).toMatchObject({ materialId: material.materialId, expectedVersion: 1 })
})

it('creates a personal-material text reference from a selection', async () => {
  const activity = makeActivity()
  const text = '个人笔记的正文内容，用来测试选区引用。'
  const material = await makeMaterial(activity.activityId, '课堂笔记', 'text/plain', text)
  const content = { material, version: material.versions[0], text }
  request.mockImplementation(async (_activity, _spaceKey, _namespace, route) => {
    if (route === `materials/${activity.activityId}`) return [material]
    if (route === `materials/${activity.activityId}/${material.materialId}/versions/1`) return content
    throw Object.assign(new Error('missing'), { code: 'missing' })
  })
  await mount(activity)
  await waitFor(() => expect(host.querySelectorAll('.personal-material-list li')).toHaveLength(1))
  await click('打开')
  const source = await (async () => { let found: HTMLElement | null = null
    await waitFor(() => { found = host.querySelector<HTMLElement>('.personal-material-reading .wr-text-source'); expect(found).not.toBeNull() })
    return found! })()
  const start = text.indexOf('正文内容'), end = start + '正文内容'.length
  await act(async () => {
    const range = document.createRange()
    range.setStart(source.firstChild!, start)
    range.setEnd(source.firstChild!, end)
    const selection = document.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    await settle()
  })
  await waitFor(() => expect(button('询问 Agent')).toBeTruthy())
  await click('询问 Agent')
  await waitFor(() => expect(host.querySelector('[data-testid="refs"]')?.textContent).toContain('personal-material'))
  const references = JSON.parse(host.querySelector('[data-testid="refs"]')!.textContent!) as {
    kind: string; source: Record<string, unknown>; range: { start: number; end: number }; copy: string; sourceName: string
  }[]
  expect(references).toHaveLength(1)
  expect(references[0]).toMatchObject({ kind: 'text', source: { kind: 'personal-material', activityId: activity.activityId,
    materialId: material.materialId, version: 1, sha256: material.versions[0].sha256 }, range: { start, end },
    copy: '正文内容', sourceName: '课堂笔记' })
})

it('opens the fixed version on locate and reports a missing fixed version without pretending success', async () => {
  const activity = makeActivity()
  const first = await makeVersion(crypto.randomUUID(), 1, '历史笔记', 'text/plain', '历史版本正文')
  const material: PersonalMaterial = { materialId: first.materialId, activityId: activity.activityId,
    requestId: first.requestId, name: '历史笔记', mediaType: 'text/plain', currentVersion: 1,
    createdAt: new Date().toISOString(), removedAt: null, versions: [first] }
  const fixedContent = { material, version: first, text: '历史版本正文' }
  request.mockImplementation(async (_activity, _spaceKey, _namespace, route) => {
    if (route === `materials/${activity.activityId}`) return [material]
    if (route === `materials/${activity.activityId}/${material.materialId}/versions/1`) return fixedContent
    if (route === `materials/${activity.activityId}/${material.materialId}/versions/9`)
      throw Object.assign(new Error('missing'), { code: 'missing' })
    throw new Error('unexpected route ' + route)
  })
  const source = { kind: 'personal-material' as const, activityId: activity.activityId, materialId: material.materialId,
    version: 1, sha256: first.sha256 }
  await mount(activity, source, async () => {}, { start: 0, end: 4 })
  await click('probe-locate')
  await waitFor(() => expect(JSON.parse(host.querySelector('[data-testid="locate"]')!.textContent!)).toEqual({ ok: true }))
  expect(host.querySelector('.personal-material-reading .wr-text-source')?.textContent).toBe('历史版本正文')
  expect(document.getSelection()?.toString()).toBe('历史版本')

  await act(async () => {
    root.render(<WorkspaceReferencesProvider workspaceKey="test-workspace-2" onSubmit={() => {}}>
      <Probe activity={activity} probe={{ ...source, version: 9 }} reveal={async () => {}} />
    </WorkspaceReferencesProvider>)
    await settle()
  })
  await click('probe-locate')
  await waitFor(() => expect(host.querySelector('[data-testid="locate"]')?.textContent).toContain('原服务尚未找到'))
  expect(JSON.parse(host.querySelector('[data-testid="locate"]')!.textContent!)).toMatchObject({ ok: false })
})
