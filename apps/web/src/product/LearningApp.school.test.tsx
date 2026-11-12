// @vitest-environment jsdom
import { transferableAbortController } from 'node:util'
import { act, useImperativeHandle, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LearningApp } from './LearningApp'
import { toast } from '@xunjie/ui/feedback'
import { returnToSchoolClient } from './school-authorization'

vi.mock('./school-authorization', async importOriginal => ({
  ...await importOriginal<typeof import('./school-authorization')>(), returnToSchoolClient: vi.fn(() => false),
}))

vi.mock('../lib/theme', () => ({ useTheme() {} }))
vi.mock('../components/ProductShell', () => ({ ProductShell: ({ children, onSettings }: { children: ReactNode; onSettings(): void }) =>
  <main><button onClick={onSettings}>打开设置</button>{children}</main> }))
vi.mock('./ProductHome', () => ({ ProductHome: ({ onConnectSchool }: { onConnectSchool(): void }) => <button onClick={onConnectSchool}>连接学校</button> }))
vi.mock('./PersonalModelSettings', () => ({ PersonalModelSettings: () => null }))
vi.mock('./ModelSelection', () => ({ useModelSelection: () => ({}) }))
vi.mock('./ProductConversationHistory', () => ({
  conversationTitle: () => '', ProductConversationHistory: () => null,
  useConversationHistory: () => ({ items: [], archivedIds: [], ready: true }),
}))
vi.mock('./ActivityReferences', () => ({ ActivityReferences: ({ children }: { children: ReactNode }) => children,
  CourseMaterialReferences: () => null, CourseRequirementsReference: () => null }))
vi.mock('./ActivityPage', () => ({ ActivityPage: ({ workspaceRef }: { workspaceRef: RefObject<{ leave(): Promise<void> } | null> }) => {
  useImperativeHandle(workspaceRef, () => ({ leave: async () => {} }))
  return <div id="test-personal-activity">个人学习活动</div>
} }))

let root: Root, host: HTMLDivElement
let profile: 'local' | 'school', connected: boolean, failStart: boolean, failRefresh: boolean, failRevoke: boolean, connectionRequest: string, completeCalls: number
let starts: Array<{ requestId: string; schoolEndpoint: string }>
let revoked: Array<{ space: string; connectionId: string }>
let waitForRevoke: Promise<void> | null
let activityAvailable: boolean, failLogin: boolean, failApproval: boolean
let approvals: Array<{ requestId: string }>
const personal = { environmentId: '00000000-0000-4000-8000-000000000001', spaceId: '00000000-0000-4000-8000-000000000002', principalId: '00000000-0000-4000-8000-000000000003', kind: 'personal', name: '个人学习空间' }
const school = { environmentId: '00000000-0000-4000-8000-000000000004', spaceId: '00000000-0000-4000-8000-000000000005', principalId: '00000000-0000-4000-8000-000000000006', kind: 'school', name: '示例学校' }
const activity = { activityId: '00000000-0000-4000-8000-000000000007', identity: personal,
  target: { environmentId: personal.environmentId, serviceId: '00000000-0000-4000-8000-000000000008', version: 1 },
  goal: '个人学习活动', question: '', references: [], status: 'open', createdAt: '2026-01-01T00:00:00.000Z' }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
const nextFrame = async () => act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
const button = (text: string) => {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === text)
  expect(found, text).toBeDefined()
  return found!
}
const click = async (text: string) => {
  await act(async () => { button(text).click(); await settle() })
  await act(async () => { await settle() })
}
const clickDialog = async (text: string) => {
  await act(async () => {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog).not.toBeNull()
  const found = [...dialog!.querySelectorAll('button')].find(item => item.textContent?.trim() === text)
  expect(found, text).toBeDefined()
  found!.click(); await settle()
  })
  await act(async () => { await settle() })
}
const fill = async (selector: string, value: string) => act(async () => {
  const input = host.querySelector<HTMLInputElement>(selector)!
  expect(input).not.toBeNull()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const abort = transferableAbortController()
  vi.stubGlobal('AbortController', abort.constructor)
  vi.stubGlobal('AbortSignal', abort.signal.constructor)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(window, 'open').mockReturnValue(null)
  vi.mocked(returnToSchoolClient).mockReset().mockReturnValue(false)
  profile = 'local'; connected = false; failStart = false; failRefresh = false; failRevoke = false; connectionRequest = ''; completeCalls = 0; starts = []; revoked = []; waitForRevoke = null; activityAvailable = false
  failLogin = false; failApproval = false; approvals = []
  localStorage.clear(); sessionStorage.clear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const route = url.replace('/api/learning/', '')
    if (route === 'context') {
      if (failRefresh) { failRefresh = false; return response({ error: 'unavailable' }, 503) }
      return response({ clientNamespace: 'test', profile, identities: profile === 'school'
        ? connected ? [{ key: 'school', identity: school }] : []
        : [{ key: 'personal', identity: personal }, ...(connected ? [{ key: 'school:connection', identity: school }] : [])] })
    }
    if (route === 'activities') return response(activityAvailable ? [activity] : [])
    if (route === 'activities/' + activity.activityId) return response(activity)
    if (route === 'courses') return response({ courses: [] })
    if (route === 'client/start') {
      starts.push(JSON.parse(options.body as string))
      if (failStart) { failStart = false; return response({ error: 'unavailable' }, 503) }
      connectionRequest = (JSON.parse(options.body as string) as { requestId: string }).requestId
      return response({ requestId: connectionRequest, authorizationUrl: 'https://school.example.edu/authorize' })
    }
    if (route === 'client/complete') {
      completeCalls++
      expect(JSON.parse(options.body as string)).toEqual({ requestId: connectionRequest })
      connected = true
      return response({ connectionId: 'connection' })
    }
    if (route === 'connections/revoke') {
      revoked.push({ space: (options.headers as Record<string, string>)['x-xj-space'],
        connectionId: (JSON.parse(options.body as string) as { connectionId: string }).connectionId })
      if (waitForRevoke) await waitForRevoke
      if (failRevoke) { failRevoke = false; return response({ error: 'unavailable' }, 503) }
      connected = false
      return response({})
    }
    if (route === 'login') {
      if (failLogin) return response({ error: 'forbidden' }, 403)
      connected = true; return response({})
    }
    if (route === 'connections/approve') {
      approvals.push(JSON.parse(options.body as string))
      return failApproval ? response({ error: 'unavailable' }, 503) : response({})
    }
    throw new Error('Unexpected route ' + route)
  }))
})
afterEach(async () => {
  toast.dismiss()
  await act(async () => { root.unmount(); await settle() })
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('keeps the old school link on the account page and makes connection errors and recovery visible', async () => {
  history.replaceState(null, '', '/?space=personal&settings=school')
  failStart = true
  await act(async () => { root.render(<LearningApp />); await settle() })
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('账户')
  expect(host.querySelector('nav[aria-label="设置导航"]')?.textContent).not.toContain('学校连接')
  expect(button('添加学校')).not.toBeNull()
  expect(host.querySelector('input[type="url"]')).toBeNull()
  await click('添加学校')
  await fill('input[type="url"]', 'https://school.example.edu')
  await click('连接')
  expect(host.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('暂时无法连接原服务')
  await click('连接')
  expect(toast.getToasts().some(item => 'type' in item && item.type === 'error')).toBe(false)
  expect(starts).toHaveLength(2)
  expect(starts[1]).toEqual(starts[0])
  const authorization = new URL(host.querySelector<HTMLAnchorElement>('.product-school-auth-link')!.href)
  expect(authorization.origin + authorization.pathname).toBe('https://school.example.edu/authorize')
  const returned = new URL(authorization.searchParams.get('returnTo')!)
  expect(returned.origin).toBe(location.origin)
  expect(returned.searchParams.get('schoolAuthorization')).toBe(connectionRequest)
  failRefresh = true
  await click('已完成认证，连接学校')
  expect(host.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('暂时无法连接原服务')
  expect(host.textContent).toContain('学校认证已完成')
  await click('重新读取连接')
  expect(completeCalls).toBe(1)
  expect(new URLSearchParams(location.search).get('space')).toBe('school:connection')
  expect(host.textContent).toContain('示例学校')
  expect(host.textContent).toContain('已绑定')
  expect(host.querySelector('.product-school-pending')).toBeNull()
  expect(host.textContent).not.toContain('切换到个人空间')
  expect(button('换绑学校')).not.toBeNull()
})

it('uses the shared login page before a school identity exists, then opens the requested account page', async () => {
  profile = 'school'
  history.replaceState(null, '', '/?settings=school')
  await act(async () => { root.render(<LearningApp />); await settle() })
  expect(host.querySelector('.session-card')).not.toBeNull()
  expect(host.textContent).toContain('登录学习空间')
  expect(host.querySelector('[aria-label="登录身份"]')).toBeNull()
  expect(host.querySelector('.product-school-form')).toBeNull()
  await fill('input[autocomplete="username"]', 'student')
  await fill('input[type="password"]', 'password')
  await click('登录')
  expect(host.querySelector('.session-card')).toBeNull()
  expect(host.textContent).toContain('已登录此学校')
  expect(button('退出学校登录')).not.toBeNull()
})

it('authenticates the original device request during sign-in without an intermediate approval', async () => {
  profile = 'school'
  const requestId = '00000000-0000-4000-8000-000000000021'
  history.replaceState(null, '', '/?authorize=' + requestId)
  await act(async () => { root.render(<LearningApp />); await settle() })
  expect(host.textContent).toContain('使用学校账号登录并认证，完成后将返回客户端。')
  expect(host.textContent).not.toContain('允许连接')
  await fill('input[autocomplete="username"]', 'student')
  await fill('input[type="password"]', 'password')
  await click('登录并认证')
  expect(approvals).toEqual([{ requestId }])
  expect(host.textContent).not.toContain('认证并返回客户端')
  expect(host.querySelector('[data-sonner-toast][data-type="success"]')?.textContent).toContain('学校认证已完成')
})

it('keeps the shared login and entered account available after authentication fails', async () => {
  profile = 'school'; failLogin = true
  history.replaceState(null, '', '/?authorize=original-request')
  await act(async () => { root.render(<LearningApp />); await settle() })
  await fill('input[autocomplete="username"]', 'student')
  await fill('input[type="password"]', 'wrong-password')
  await click('登录并认证')
  expect(host.querySelector('.session-card')).not.toBeNull()
  expect(host.querySelector<HTMLInputElement>('input[autocomplete="username"]')?.value).toBe('student')
  expect(host.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('重新登录')
  expect(new URLSearchParams(location.search).get('authorize')).toBe('original-request')
  expect(approvals).toHaveLength(0)
  failLogin = false
  await click('登录并认证')
  expect(host.querySelector('.session-card')).toBeNull()
  expect(approvals).toEqual([{ requestId: 'original-request' }])
})

it('retries the same authorization after login succeeds but approval fails, without asking for the password again', async () => {
  profile = 'school'; failApproval = true
  const requestId = '00000000-0000-4000-8000-000000000022'
  history.replaceState(null, '', '/?authorize=' + requestId)
  await act(async () => { root.render(<LearningApp />); await settle() })
  await fill('input[autocomplete="username"]', 'student')
  await fill('input[type="password"]', 'password')
  await click('登录并认证')
  expect(host.querySelector('.session-card')).toBeNull()
  expect(new URLSearchParams(location.search).get('authorize')).toBe(requestId)
  expect(host.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('暂时无法连接原服务')
  failApproval = false
  await click('认证并返回客户端')
  expect(approvals).toEqual([{ requestId }, { requestId }])
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/learning/login')).toHaveLength(1)
})

it('returns directly to the originating account page after sign-in and authorization succeed', async () => {
  profile = 'school'
  const requestId = '00000000-0000-4000-8000-000000000023'
  const returnUrl = 'http://127.0.0.1:57417/?settings=account&schoolAuthorization=' + requestId
  history.replaceState(null, '', '/?authorize=' + requestId + '&returnTo=' + encodeURIComponent(returnUrl))
  vi.mocked(returnToSchoolClient).mockReturnValue(true)
  await act(async () => { root.render(<LearningApp />); await settle() })
  await fill('input[autocomplete="username"]', 'student')
  await fill('input[type="password"]', 'password')
  await click('登录并认证')
  expect(approvals).toEqual([{ requestId }])
  expect(returnToSchoolClient).toHaveBeenCalledExactlyOnceWith(returnUrl)
})

it('restores the pending request on return to the client, then completes it only after the client button is pressed', async () => {
  history.replaceState(null, '', '/?settings=account')
  await act(async () => { root.render(<LearningApp />); await settle() })
  await click('添加学校')
  await fill('input[type="url"]', 'https://school.example.edu')
  await click('连接')
  await act(async () => { root.unmount(); await settle() })
  root = createRoot(host)
  history.replaceState(null, '', '/?settings=account&schoolAuthorization=' + connectionRequest)
  await act(async () => { root.render(<LearningApp />); await settle() })
  expect(host.textContent).toContain('学校认证已完成，点击下方按钮完成连接')
  expect(completeCalls).toBe(0)
  await click('已完成认证，连接学校')
  expect(completeCalls).toBe(1)
  expect(host.querySelector('.product-school-list')?.textContent).toContain('示例学校')
  expect(localStorage.getItem('xj.school-authorization.test')).toBeNull()
  expect(toast.getToasts().filter(item => 'type' in item && item.type === 'success')).toHaveLength(1)
})

it('does not complete an unknown returned request', async () => {
  history.replaceState(null, '', '/?settings=account&schoolAuthorization=00000000-0000-4000-8000-000000000024')
  await act(async () => { root.render(<LearningApp />); await settle() })
  expect(completeCalls).toBe(0)
  expect(host.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('不属于此客户端')
  expect(button('添加学校')).not.toBeNull()
})

it('returns to an unfinished authorization and lets the user correct the school address', async () => {
  history.replaceState(null, '', '/?space=personal&settings=account')
  await act(async () => { root.render(<LearningApp />); await settle() })
  await click('添加学校')
  await fill('input[type="url"]', 'https://school.example.edu')
  await click('连接')
  await click('返回学习空间')
  await click('连接学校')
  expect(host.textContent).toContain('请在学校页面完成认证')
  await click('重新填写学校链接')
  expect(host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe('https://school.example.edu')
})

it.each(['personal', 'school:connection'])('manages the one connected school from %s without another switch', async space => {
  connected = true
  history.replaceState(null, '', '/?space=' + encodeURIComponent(space) + '&settings=account')
  await act(async () => { root.render(<LearningApp />); await settle() })
  expect(host.textContent).toContain('示例学校')
  expect(host.textContent).not.toContain('连接其他学校')
  expect(host.textContent).not.toContain('切换到此学校')
  expect(host.querySelector('.product-school-add')).toBeNull()
  expect(host.querySelector('input[type="url"]')).toBeNull()
  await click('断开连接')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('示例学校')
  expect(document.querySelector('[role="dialog"]')?.textContent?.includes('你将返回本地学习空间')).toBe(space === 'school:connection')
  expect(revoked).toEqual([])
  await clickDialog('取消')
  expect(revoked).toEqual([])
  expect(host.textContent).toContain('示例学校')
  await nextFrame()
  expect(document.activeElement).toBe(button('断开连接'))
  await click('断开连接')
  await clickDialog('确认断开')
  expect(revoked).toEqual([{ space: 'school:connection', connectionId: 'connection' }])
  expect(new URLSearchParams(location.search).get('space')).toBe('personal')
  expect(button('添加学校')).not.toBeNull()
  expect(host.querySelector('input[type="url"]')).toBeNull()
  await nextFrame()
  expect(document.activeElement).toBe(button('添加学校'))
})

it('keeps the personal activity mounted when disconnecting a school from personal space', async () => {
  connected = true; activityAvailable = true
  history.replaceState(null, '', '/?space=personal&activity=' + activity.activityId)
  await act(async () => { root.render(<LearningApp />); await settle(); await settle() })
  const original = host.querySelector('#test-personal-activity')
  expect(original).not.toBeNull()
  await click('打开设置')
  await click('断开连接')
  await clickDialog('确认断开')
  expect(host.querySelector('#test-personal-activity')).toBe(original)
  expect(new URLSearchParams(location.search).get('activity')).toBe(activity.activityId)
  await click('返回学习空间')
  expect(host.querySelector('#test-personal-activity')).toBe(original)
})

it('keeps the confirmation open when disconnection fails and allows a retry', async () => {
  connected = true; failRevoke = true
  history.replaceState(null, '', '/?space=personal&settings=account')
  await act(async () => { root.render(<LearningApp />); await settle() })
  await click('断开连接')
  await clickDialog('确认断开')
  expect(host.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('暂时无法连接原服务')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(host.textContent).toContain('示例学校')
  await clickDialog('确认断开')
  expect(revoked).toHaveLength(2)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(button('添加学校')).not.toBeNull()
})

it('prevents duplicate disconnection while the confirmation is pending', async () => {
  connected = true
  let release = () => {}
  waitForRevoke = new Promise<void>(resolve => { release = resolve })
  history.replaceState(null, '', '/?space=personal&settings=account')
  await act(async () => { root.render(<LearningApp />); await settle() })
  await click('断开连接')
  await clickDialog('确认断开')
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.getAttribute('aria-busy')).toBe('true')
  expect([...dialog.querySelectorAll('button')].find(item => item.textContent === '取消')?.disabled).toBe(true)
  const confirm = [...dialog.querySelectorAll('button')].find(item => item.textContent === '确认断开')!
  expect(confirm.getAttribute('aria-disabled')).toBe('true')
  expect(revoked).toHaveLength(1)
  await act(async () => { release(); await settle() })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(button('添加学校')).not.toBeNull()
})

it('opens and cancels the school form without losing the entered link', async () => {
  history.replaceState(null, '', '/?space=personal&settings=account')
  await act(async () => { root.render(<LearningApp />); await settle() })
  expect(host.querySelector('input[type="url"]')).toBeNull()
  await click('添加学校')
  await fill('input[type="url"]', 'https://school.example.edu')
  await click('取消')
  expect(host.querySelector('input[type="url"]')).toBeNull()
  expect(starts).toEqual([])
  await click('添加学校')
  expect(host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe('https://school.example.edu')
})
