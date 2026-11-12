// @vitest-environment jsdom
import { transferableAbortController } from 'node:util'
import { act, useImperativeHandle, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import type { ActivityWorkspaceHandle } from './ActivityWorkspace'
import { LearningApp } from './LearningApp'
import { toast } from '@xunjie/ui/feedback'

vi.mock('../lib/theme', () => ({ THEME_OPTIONS: [{ value: 'system', label: '跟随系统' }],
  setThemePreference: vi.fn(), useTheme: () => ({ preference: 'system', resolved: 'light' }) }))
vi.mock('./PersonalModelSettings', () => ({ PersonalModelSettings: () => null }))
vi.mock('./ModelSelection', () => ({ useModelSelection: () => ({}) }))
vi.mock('./ProductConversationHistory', () => ({ conversationTitle: () => '',
  ProductConversationHistory: ({ activities, onOpen }: { activities: LearningActivity[] | null; onOpen(id: string): void }) =>
    <div data-testid="history">{activities?.map(item => <button key={item.activityId} onClick={() => onOpen(item.activityId)}>{item.question}</button>)}</div>,
  useConversationHistory: () => ({ items: [], archivedIds: [], ready: true }),
}))
vi.mock('./ActivityReferences', () => ({ ActivityReferences: ({ children }: { children: ReactNode }) => children,
  CourseMaterialReferences: () => null, CourseRequirementsReference: () => null }))
function Workspace({ activity, workspaceRef }: { activity: LearningActivity; workspaceRef: RefObject<ActivityWorkspaceHandle | null> }) {
  useImperativeHandle(workspaceRef, () => ({ leave: async () => { if (rejectLeave) throw new Error('保护失败') } }))
  return <h1 data-testid="workspace">{activity.course?.taskTitle ?? activity.question}</h1>
}
vi.mock('./ActivityPage', () => ({ ActivityPage: (props: Parameters<typeof Workspace>[0]) => <Workspace {...props} /> }))
vi.mock('./ProductConversation', () => ({ ProductConversation: (props: Parameters<typeof Workspace>[0]) => <Workspace {...props} /> }))

const personal: SpaceIdentity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), kind: 'personal', name: '个人学习空间' }
const school: SpaceIdentity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), kind: 'school', name: '学校学习空间' }
const courseId = crypto.randomUUID(), schoolKey = 'school:connection'
const activity = (identity: SpaceIdentity, question: string): LearningActivity => ({ activityId: crypto.randomUUID(), identity,
  target: { environmentId: identity.environmentId, serviceId: crypto.randomUUID(), version: 1 }, question, goal: '', references: [], status: 'open', createdAt: '2026-01-01T00:00:00.000Z' })
const personalActivity = activity(personal, '个人自主学习')
const schoolActivity: LearningActivity = { ...activity(school, '课程提问'), course: { associationId: crypto.randomUUID(), courseId,
  courseName: '学校课程', taskId: crypto.randomUUID(), taskTitle: '学校任务', releaseId: crypto.randomUUID(), contentDigest: 'a'.repeat(64),
  objectives: ['学习目标'], requirements: '任务要求', materials: [], starterWorks: [], capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } } }
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
let host: HTMLDivElement, root: Root, connected: boolean, offline: boolean, schoolOffline: boolean, rejectLeave: boolean
let legacyContext: boolean, explicitUnbound: boolean, currentSchoolKey: string
let reads: Array<{ route: string; space?: string }>, creates: string[], holdSchool: Promise<void> | undefined, finishSchool: (() => void) | undefined
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const click = async (text: string) => act(async () => {
  const item = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)
  expect(item, text).toBeDefined(); item!.click(); await settle()
})
const clickSelector = async (selector: string) => act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); await settle() })
const mount = async () => act(async () => { root.render(<LearningApp />); await settle(); await settle() })
const remount = async () => { await act(async () => root.unmount()); root = createRoot(host); await mount() }
const accountLabel = () => host.querySelector('.account-pill .account-name')?.textContent
const fill = async (text: string) => act(async () => {
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Agent 提问"]')!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true })); await settle()
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  const abort = transferableAbortController()
  vi.stubGlobal('AbortController', abort.constructor); vi.stubGlobal('AbortSignal', abort.signal.constructor)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('Image', class { src = ''; decode() { return Promise.resolve() } })
  vi.spyOn(window, 'open').mockReturnValue(null)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/?space=personal')
  connected = true; currentSchoolKey = schoolKey; offline = false; schoolOffline = false; rejectLeave = false; legacyContext = false; explicitUnbound = false
  reads = []; creates = []; holdSchool = undefined; finishSchool = undefined
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const route = url.replace('/api/learning/', ''), space = (options.headers as Record<string, string>)?.['x-xj-space']
    reads.push({ route, space })
    if (offline) throw new TypeError('offline')
    if (route === 'context') return response({ clientNamespace: 'account-navigation', profile: 'local',
      ...(!legacyContext ? { account: connected && !explicitUnbound ? { key: currentSchoolKey, accountName: 'Robert', schoolName: '示例大学' } : null } : {}),
      identities: [{ key: 'personal', identity: personal }, ...(connected ? [{ key: currentSchoolKey, identity: school }] : [])] })
    if (space === currentSchoolKey) {
      if (schoolOffline) return response({ error: 'unavailable' }, 503)
      await holdSchool
    }
    if (route === 'activities' && options.method === 'POST') {
      creates.push(space!); return response({ ...personalActivity, question: JSON.parse(options.body as string).question })
    }
    if (route === 'activities') return response(space === currentSchoolKey ? [schoolActivity] : [personalActivity])
    if (route === 'activities/' + schoolActivity.activityId) return response(schoolActivity)
    if (route === 'activities/' + personalActivity.activityId) return response(personalActivity)
    if (route.startsWith('receipts/')) return response(null)
    if (route === 'courses') return response({ courses: [{ courseId, name: '学校课程', tasks: [] }] })
    if (route === 'client/start') { expect(connected).toBe(false); return response({ requestId: crypto.randomUUID(), authorizationUrl: 'https://school.example.edu/authorize' }) }
    if (route === 'client/complete') { connected = true; currentSchoolKey = 'school:reconnected'; return response({ connectionId: 'reconnected' }) }
    if (route === 'connections/revoke') { connected = false; return response({}) }
    throw new Error('Unexpected route ' + route)
  }))
})
afterEach(async () => {
  await act(async () => { finishSchool?.(); await settle(); root.unmount() })
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  toast.dismiss(); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('keeps the bound account across filtering, school entry, personal Agent, settings, profile, refresh and offline reopening', async () => {
  await mount()
  expect(accountLabel()).toBe('Robert')
  expect(host.textContent).toContain('学校课程')
  const search = location.search, beforeFilter = reads.length
  await click('个人')
  expect(host.querySelector('[data-activity-id="' + personalActivity.activityId + '"]')).not.toBeNull()
  expect(location.search).toBe(search); expect(reads).toHaveLength(beforeFilter)
  await click('学校')
  await clickSelector('[data-course-id="' + courseId + '"]')
  expect(new URLSearchParams(location.search).get('space')).toBe(schoolKey)
  expect(new URLSearchParams(location.search).get('course')).toBe(courseId)
  expect(accountLabel()).toBe('Robert')
  await click('Agent 对话')
  expect(new URLSearchParams(location.search).get('space')).toBe('personal')
  expect(host.querySelector('[data-testid="history"]')?.textContent).toBe('个人自主学习')
  expect(accountLabel()).toBe('Robert')
  await remount(); expect(accountLabel()).toBe('Robert')
  await clickSelector('button[aria-label="设置与帮助"]')
  expect(host.querySelector('.product-settings-current')?.textContent).toContain('Robert')
  expect(host.querySelector('.product-settings-current')?.textContent).toContain('示例大学')
  expect(host.textContent).not.toContain('切换到个人空间')
  await click('返回学习空间')
  await clickSelector('.account-pill'); await click('个人资料')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Robert')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('示例大学')
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle() })
  offline = true
  await remount(); expect(accountLabel()).toBe('Robert')
})

it('reserves the workspace layout while a deep-linked activity is still loading', async () => {
  holdSchool = new Promise(resolve => { finishSchool = resolve })
  history.replaceState(null, '', '/?space=' + schoolKey + '&activity=' + schoolActivity.activityId)
  await mount()
  expect(host.querySelector('.product-shell')?.classList.contains('immersive')).toBe(true)
  expect(host.querySelector('[data-testid="workspace"]')).toBeNull()
  await act(async () => { finishSchool?.(); await settle(); await settle() })
  expect(host.querySelector('[data-testid="workspace"]')).not.toBeNull()
  expect(host.querySelector('.product-shell')?.classList.contains('immersive')).toBe(true)
})

it('shares initial list reads and shows loaded content immediately across home and Agent navigation', async () => {
  await mount()
  const listReads = () => reads.filter(item => item.route === 'activities' || item.route === 'courses')
  expect(listReads().filter(item => item.route === 'activities' && item.space === 'personal')).toHaveLength(1)
  expect(listReads().filter(item => item.route === 'activities' && item.space === schoolKey)).toHaveLength(1)
  expect(listReads().filter(item => item.route === 'courses')).toHaveLength(1)
  const count = listReads().length
  await click('Agent 对话')
  expect(host.querySelector('[data-testid="history"]')?.textContent).toContain('个人自主学习')
  await click('首页')
  expect(host.textContent).toContain('学校课程')
  expect(host.textContent).not.toContain('正在读取学校课程')
  expect(listReads()).toHaveLength(count)
})

it('opens an activity without waiting for its slower activity list', async () => {
  history.replaceState(null, '', '/?space=personal&view=agent&activity=' + personalActivity.activityId)
  const original = vi.mocked(fetch).getMockImplementation()!
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (String(args[0]) === '/api/learning/activities') await held
    return original(...args)
  })
  try {
    await mount()
    expect(host.querySelector('[data-testid="workspace"]')?.textContent).toBe('个人自主学习')
  } finally { await act(async () => { finish(); await settle() }) }
})

it('refreshes the sidebar on a later visit when its cached activity list has expired', async () => {
  await mount()
  const original = vi.mocked(fetch).getMockImplementation()!
  const added = activity(personal, '其他窗口新增的活动')
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (String(args[0]) === '/api/learning/activities'
      && (args[1]?.headers as Record<string, string>)?.['x-xj-space'] === 'personal') return response([added, personalActivity])
    return original(...args)
  })
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000)
  await click('Agent 对话')
  expect(host.querySelector('[data-testid="history"]')?.textContent).toContain('其他窗口新增的活动')
})

it('defers a hidden activity when entering settings directly and opens it on return', async () => {
  history.replaceState(null, '', '/?space=personal&view=agent&activity=' + personalActivity.activityId + '&settings=models')
  await mount()
  expect(reads.some(item => item.route === 'activities/' + personalActivity.activityId)).toBe(false)
  expect(host.querySelector('[data-testid="workspace"]')).toBeNull()
  await click('返回学习空间')
  expect(host.querySelector('[data-testid="workspace"]')?.textContent).toBe('个人自主学习')
})

it('reuses recently verified activity metadata when reopening a conversation', async () => {
  history.replaceState(null, '', '/?space=personal&view=agent&activity=' + personalActivity.activityId)
  await mount()
  expect(host.querySelector('[data-testid="workspace"]')?.textContent).toBe('个人自主学习')
  const activityReads = () => reads.filter(item => item.route === 'activities/' + personalActivity.activityId)
  expect(activityReads()).toHaveLength(1)
  await click('首页')
  await click('Agent 对话')
  await click('个人自主学习')
  expect(host.querySelector('[data-testid="workspace"]')?.textContent).toBe('个人自主学习')
  expect(activityReads()).toHaveLength(1)
})

it('opens the school activity through its own source and protects it before opening the personal Agent', async () => {
  await mount()
  await clickSelector('[data-activity-id="' + schoolActivity.activityId + '"]')
  expect(host.querySelector('[data-testid="workspace"]')?.textContent).toBe('学校任务')
  expect(new URLSearchParams(location.search).get('space')).toBe(schoolKey)
  rejectLeave = true
  // Immersive workspaces hide navigation but use the same shell callbacks.
  await click('Agent 对话')
  expect(new URLSearchParams(location.search).get('space')).toBe(schoolKey)
  expect(host.querySelector('[data-testid="workspace"]')?.textContent).toBe('学校任务')
  rejectLeave = false
  await click('Agent 对话')
  await fill('个人问题')
  await clickSelector('[aria-label="发送消息"]')
  expect(creates).toEqual(['personal'])
  expect(accountLabel()).toBe('Robert')
})

it('keeps personal learning available when school reads fail and clears late school data on unbinding', async () => {
  schoolOffline = true
  await mount()
  expect(accountLabel()).toBe('Robert')
  await click('个人')
  expect(host.querySelector('[data-activity-id="' + personalActivity.activityId + '"]')).not.toBeNull()
  schoolOffline = false
  holdSchool = new Promise(resolve => { finishSchool = resolve })
  await remount()
  await clickSelector('[aria-label="设置与帮助"]')
  // The revoke itself must complete while the stale list read remains in flight.
  holdSchool = undefined
  await click('断开连接'); await click('确认断开')
  expect(accountLabel()).toBe('本地学习空间')
  await act(async () => { finishSchool!(); await settle() })
  await click('返回学习空间')
  expect(host.textContent).not.toContain('学校课程')
  await click('学校')
  expect(host.textContent).toContain('尚未绑定学校')
  await click('个人')
  expect(host.textContent).toContain('个人自主学习')
})

it('rejects an old school deep link without selecting a different school account', async () => {
  history.replaceState(null, '', '/?space=school:old&activity=' + schoolActivity.activityId)
  await mount()
  expect(accountLabel()).toBe('Robert')
  expect(host.querySelector('[data-testid="workspace"]')).toBeNull()
  expect(host.textContent).toContain('绑定原账号后打开')
  expect(reads.some(item => item.space === 'school:old')).toBe(false)
  expect(reads.some(item => item.route === 'activities/' + schoolActivity.activityId)).toBe(false)
})

it('reopens a known old activity after the same account rebinds, using its current connection', async () => {
  sessionStorage.setItem(`xj.works-activity.account-navigation.school:old.${schoolActivity.activityId}`, JSON.stringify(schoolActivity))
  history.replaceState(null, '', '/?space=school:old&activity=' + schoolActivity.activityId)
  await mount()
  expect(accountLabel()).toBe('Robert')
  expect(host.querySelector('[data-testid="workspace"]')).not.toBeNull()
  expect(reads.some(item => item.space === 'school:old')).toBe(false)
  expect(reads.some(item => item.route === 'activities/' + schoolActivity.activityId && item.space === schoolKey)).toBe(true)
})

it('does not reuse an old activity link for a different school principal', async () => {
  sessionStorage.setItem(`xj.works-activity.account-navigation.school:old.${schoolActivity.activityId}`,
    JSON.stringify({ ...schoolActivity, identity: { ...schoolActivity.identity, principalId: crypto.randomUUID() } }))
  history.replaceState(null, '', '/?space=school:old&activity=' + schoolActivity.activityId)
  await mount()
  expect(host.querySelector('[data-testid="workspace"]')).toBeNull()
  expect(reads.some(item => item.route === 'activities/' + schoolActivity.activityId)).toBe(false)
})

it('uses a legacy school name only when account is omitted; explicit null hides stale school identities', async () => {
  legacyContext = true
  await mount(); expect(accountLabel()).toBe('学校学习空间')
  legacyContext = false; explicitUnbound = true; reads = []
  await remount(); expect(accountLabel()).toBe('本地学习空间')
  expect(reads.some(item => item.space === schoolKey)).toBe(false)
  await click('学校'); expect(host.textContent).toContain('尚未绑定学校')
})

it('unbinds before rebinding, keeps local data, and restores the same account courses after completion', async () => {
  const localDraftKey = `xj.course-activity-request.account-navigation.${school.environmentId}.${school.spaceId}.${school.principalId}`
  const pendingCourse = JSON.stringify({ requestId: crypto.randomUUID(), releaseId: schoolActivity.course!.releaseId })
  localStorage.setItem(localDraftKey, pendingCourse)
  await mount()
  await clickSelector('[aria-label="设置与帮助"]')
  await click('换绑学校')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('先解绑当前账号')
  expect(reads.some(item => item.route === 'client/start')).toBe(false)
  await click('确认解绑并换绑')
  expect(accountLabel()).toBe('本地学习空间')
  expect(connected).toBe(false)
  expect(localStorage.getItem(localDraftKey)).toBe(pendingCourse)
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="url"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://school.example.edu')
    input.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  })
  await click('连接')
  expect(accountLabel()).toBe('本地学习空间')
  await click('已完成认证，连接学校')
  expect(accountLabel()).toBe('Robert')
  expect(localStorage.getItem(localDraftKey)).toBe(pendingCourse)
  await click('返回学习空间')
  expect(host.textContent).toContain('学校课程')
  expect(host.querySelector('[data-activity-id="' + schoolActivity.activityId + '"]')).not.toBeNull()
  await clickSelector('[data-activity-id="' + schoolActivity.activityId + '"]')
  expect(host.querySelector('[data-testid="workspace"]')?.textContent).toBe('学校任务')
  expect(new URLSearchParams(location.search).get('space')).toBe('school:reconnected')
})
