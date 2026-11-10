// @vitest-environment jsdom
import { transferableAbortController } from 'node:util'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LearningApp } from './LearningApp'

vi.mock('../lib/theme', () => ({ useTheme() {} }))
vi.mock('../components/ProductShell', () => ({ ProductShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }))
vi.mock('./ProductSettings', () => ({ ProductSettings: ({ schoolControls, accountFeedback }: { schoolControls: ReactNode; accountFeedback?: ReactNode }) => <>{accountFeedback}{schoolControls}</> }))
vi.mock('./PersonalModelSettings', () => ({ PersonalModelSettings: () => null }))
vi.mock('./ModelSelection', () => ({ useModelSelection: () => ({}) }))
vi.mock('./ProductConversationHistory', () => ({
  conversationTitle: () => '', ProductConversationHistory: () => null,
  useConversationHistory: () => ({ items: [], archivedIds: [], ready: true }),
}))

let root: Root, host: HTMLDivElement
let finishStart: (response: Response) => void
let start: Promise<Response>
const requestId = '00000000-0000-4000-8000-000000000009'
const authorizationUrl = 'https://school.example.edu/?authorize=' + requestId
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const popup = () => ({ opener: window, closed: false, location: { replace: vi.fn() }, close: vi.fn() })
const pending = () => response({ requestId, connectionId: requestId, schoolEndpoint: 'https://school.example.edu', authorizationUrl })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const abort = transferableAbortController()
  vi.stubGlobal('AbortController', abort.constructor)
  vi.stubGlobal('AbortSignal', abort.signal.constructor)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(window, 'open').mockReturnValue(null)
  localStorage.clear(); sessionStorage.clear()
  history.replaceState(null, '', '/?space=personal&settings=account')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  start = new Promise(resolve => { finishStart = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const route = url.replace('/api/learning/', '')
    if (route === 'context') return response({ clientNamespace: 'test', profile: 'local', identities: [{ key: 'personal', identity: {
      environmentId: '00000000-0000-4000-8000-000000000001', spaceId: '00000000-0000-4000-8000-000000000002',
      principalId: '00000000-0000-4000-8000-000000000003', kind: 'personal', name: '个人学习空间',
    } }] })
    if (route === 'activities') return response([])
    if (route === 'client/start') return start
    throw new Error('Unexpected route ' + route)
  }))
})
afterEach(async () => {
  await act(async () => { root.unmount(); await settle() })
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function submitSchool() {
  await act(async () => { root.render(<LearningApp />); await settle() })
  const add = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === '添加学校')
  if (add) await act(async () => { add.click(); await settle() })
  const input = host.querySelector<HTMLInputElement>('input[type="url"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://school.example.edu')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle() })
}

it('keeps authentication available when the start response contains a reserved connection ID', async () => {
  await submitSchool()
  await act(async () => { finishStart(pending()); await settle() })
  expect(host.textContent).not.toContain('学校认证已完成')
  expect(host.querySelector<HTMLAnchorElement>('a')?.href).toBe(authorizationUrl)
  expect(fetch).not.toHaveBeenCalledWith('/api/learning/client/complete', expect.anything())
})

it('opens the authentication window during the click and navigates after the start response', async () => {
  const authentication = popup()
  vi.mocked(window.open).mockReturnValue(authentication as unknown as Window)
  await submitSchool()
  expect(window.open).toHaveBeenCalledOnce()
  expect(authentication.opener).toBeNull()
  expect(authentication.location.replace).not.toHaveBeenCalled()
  await act(async () => { finishStart(pending()); await settle() })
  expect(authentication.location.replace).toHaveBeenCalledWith(authorizationUrl)
  expect(host.querySelector<HTMLAnchorElement>('a')?.href).toBe(authorizationUrl)
})

it('closes the reserved window when preparation fails and keeps the link editable', async () => {
  const authentication = popup()
  vi.mocked(window.open).mockReturnValue(authentication as unknown as Window)
  await submitSchool()
  await act(async () => { finishStart(response({ error: 'unavailable' }, 503)); await settle() })
  expect(authentication.close).toHaveBeenCalledOnce()
  expect(host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe('https://school.example.edu')
  expect(authentication.location.replace).not.toHaveBeenCalled()
})
