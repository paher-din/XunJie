// @vitest-environment jsdom
import { transferableAbortController } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CourseMaterial, CourseRelease } from '@xunjie/contracts/courses'
import { toast } from '@xunjie/ui/feedback'
import { LearningApp } from './LearningApp'

vi.mock('../lib/theme', () => ({ useTheme() {} }))
vi.mock('../components/ProductShell', () => ({ ProductShell: ({ children }: { children: ReactNode }) => children }))
vi.mock('./ActivityPage', () => ({ ActivityPage: () => null }))
vi.mock('./ActivityReferences', () => ({ ActivityReferences: () => null,
  CourseMaterialReferences: () => null, CourseRequirementsReference: () => null }))
vi.mock('./ProductConversation', () => ({ ProductConversation: () => null }))

let root: Root, host: HTMLDivElement, release: CourseRelease
let reads: { material: CourseMaterial; resolve(response: Response): void }[]
let downloads: { name: string; url: string }[]
const visibleErrorToast = '[data-sonner-toast][data-type="error"][data-removed="false"]'
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const materialResponse = (material: CourseMaterial) => response({ ...material, contentBase64: btoa('test') })
function button(text: string) {
  const found = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text)
  expect(found, text).toBeDefined()
  return found!
}
async function click(text: string) { await act(async () => { button(text).click(); await settle() }) }
function downloadButton(name: string) {
  return document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="下载 ${name}"]`)!
}
async function download(name: string) {
  await act(async () => { downloadButton(name).click(); await settle() })
}
async function finish(index: number, failure = false) {
  await act(async () => { reads[index].resolve(failure ? response({ error: 'forbidden' }, 403) : materialResponse(reads[index].material)); await settle() })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('Image', class { src = ''; decode() { return Promise.resolve() } })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  Element.prototype.scrollIntoView ??= vi.fn()
  const abort = transferableAbortController()
  vi.stubGlobal('AbortController', abort.constructor)
  vi.stubGlobal('AbortSignal', abort.signal.constructor)
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:material-' + crypto.randomUUID())
    static revokeObjectURL = vi.fn()
  })
  localStorage.clear(); sessionStorage.clear()
  const identity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(),
    kind: 'school', name: '材料验收学校' }
  const namespace = crypto.randomUUID()
  release = { formatVersion: 1, courseId: crypto.randomUUID(), taskId: crypto.randomUUID(), releaseId: crypto.randomUUID(),
    contentDigest: 'a'.repeat(64), courseName: '测试课程', taskTitle: '测试任务', publishedAt: '2026-11-10T00:00:00Z',
    objectives: ['阅读材料'], requirements: '核对两份材料', starterWorks: [], capabilities: [],
    helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
    materials: ['first.md', 'second.md'].map(title => ({ materialId: crypto.randomUUID(), title,
      mediaType: 'text/plain', byteLength: 4, sha256: 'b'.repeat(64) })) }
  reads = []
  downloads = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, url: this.href })
  })
  history.replaceState(null, '', `/?space=school&course=${release.courseId}`)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const route = url.replace('/api/learning/', '')
    if (route === 'context') return response({ clientNamespace: namespace, profile: 'school', identities: [{ key: 'school', identity }] })
    if (route === 'models/selection') return response({ version: 0, selected: null, options: [] })
    if (route === 'conversation-archives') return response({ archivedIds: [] })
    if (route === 'conversation-history') return response({ items: [] })
    if (route === 'activities') return response([])
    if (route === 'courses') return response({ courses: [{ courseId: release.courseId, name: release.courseName,
      tasks: [{ taskId: release.taskId, title: release.taskTitle, summary: '', releases: [{ releaseId: release.releaseId,
        contentDigest: release.contentDigest, publishedAt: release.publishedAt, objectives: release.objectives }] }] }] })
    if (route === `releases/${release.releaseId}`) return response(release)
    const material = release.materials.find(item => route === `releases/${release.releaseId}/materials/${item.materialId}`)
    if (material) return new Promise<Response>(resolve => reads.push({ material, resolve }))
    throw new Error('Unexpected route ' + route)
  }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root.render(createElement(LearningApp)); await settle() })
  await act(async () => { host.querySelector<HTMLButtonElement>('.course-region .task-card')!.click(); await settle() })
})

afterEach(async () => {
  await act(async () => {
    toast.dismiss()
    reads.forEach(read => read.resolve(materialResponse(read.material)))
    await settle()
    root.unmount()
    await settle()
  })
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('does not read or download when a file row is clicked', async () => {
  await act(async () => { document.querySelector<HTMLElement>('[role="dialog"] [title="first.md"]')!.click(); await settle() })
  expect(reads).toHaveLength(0)
  expect(downloads).toHaveLength(0)
  expect(document.querySelector('[role="dialog"] .material-action[data-reading="true"]')).toBeNull()
  expect(downloadButton('first.md').disabled).toBe(false)
})

it('keeps unrelated actions available while a material request is pending', async () => {
  await download('first.md')
  expect(reads).toHaveLength(1)
  expect(downloadButton('first.md').getAttribute('aria-disabled')).toBe('true')
  expect(downloadButton('second.md').disabled).toBe(false)
  expect(button('开始任务').disabled).toBe(false)
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="关闭任务预览"]')?.disabled).toBe(false)
  await finish(0)
  expect(downloadButton('first.md').getAttribute('aria-disabled')).toBeNull()
  await download('first.md')
  expect(reads).toHaveLength(1)
  expect(downloads[0].name).toBe('first.md')
})

it('keeps the newer material when responses arrive out of order', async () => {
  await download('first.md')
  await download('second.md')
  expect(reads).toHaveLength(2)
  await finish(1)
  const currentUrl = downloads[0].url
  await finish(0)
  await download('second.md')
  expect(downloads).toEqual([{ name: 'second.md', url: currentUrl }, { name: 'second.md', url: currentUrl }])
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
})

it('reports a current read failure and allows a retry without blocking other actions', async () => {
  await download('first.md')
  await finish(0, true)
  await act(settle)
  expect(host.querySelector(visibleErrorToast)?.textContent).toContain('访问资格已失效')
  expect(downloadButton('first.md').getAttribute('aria-disabled')).toBeNull()
  expect(button('开始任务').disabled).toBe(false)
  await download('first.md')
  await finish(1)
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  expect(host.querySelector(visibleErrorToast)).toBeNull()
  await download('first.md')
  expect(reads).toHaveLength(2)
  expect(downloads[0].name).toBe('first.md')
})

it.each([false, true])('does not download or report a stale response after leaving the course (failure=%s)', async failure => {
  await download('first.md')
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="关闭任务预览"]')!.click(); await settle() })
  await click('全部课程')
  await finish(0, failure)
  expect(new URLSearchParams(location.search).has('course')).toBe(false)
  expect(host.querySelector(visibleErrorToast)).toBeNull()
  expect(downloads).toHaveLength(0)
})

it('reads and downloads an unprepared material with one download action', async () => {
  expect(reads).toHaveLength(0)
  await download('first.md')
  expect(reads).toHaveLength(1)
  expect(downloads).toHaveLength(0)
  expect(button('开始任务').disabled).toBe(false)
  await finish(0)
  expect(downloads).toEqual([{ name: 'first.md', url: expect.stringMatching(/^blob:material-/) }])
  await download('first.md')
  expect(reads).toHaveLength(1)
  expect(downloads[1]).toEqual(downloads[0])
})
