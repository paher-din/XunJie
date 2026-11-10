// @vitest-environment jsdom
import { transferableAbortController } from 'node:util'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LearningApp } from './LearningApp'
import { toast } from '@xunjie/ui/feedback'

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
const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }
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
  toast.dismiss()
  await act(async () => { root.unmount(); await settle() })
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function submitSchool(schoolEndpoint = 'https://school.example.edu') {
  await act(async () => { root.render(<LearningApp />); await settle() })
  const add = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === '添加学校')
  if (add) await act(async () => { add.click(); await settle() })
  const input = host.querySelector<HTMLInputElement>('input[type="url"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, schoolEndpoint)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle() })
  await act(async () => { await settle() })
}

it.each([
  'http://127.0.0.1:57417/?space=personal&view=agent&settings=models',
  'https://school.example.edu/login',
  'https://school.example.edu/?settings=models',
  'https://school.example.edu/#account',
  'https://student:password@school.example.edu',
  'http://school.example.edu',
])('rejects an invalid school entry without opening a window or starting a connection: %s', async schoolEndpoint => {
  await submitSchool(schoolEndpoint)
  expect(window.open).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalledWith('/api/learning/client/start', expect.anything())
  expect(host.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('学校入口')
  expect(host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe(schoolEndpoint)
})

it('rejects this product origin as a school even when the URL has no query', async () => {
  await submitSchool(location.origin)
  expect(window.open).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalledWith('/api/learning/client/start', expect.anything())
  expect(host.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('学校入口')
})

it('shows the validation error again when the same address is submitted after dismissing it', async () => {
  await submitSchool('https://school.example.edu/login')
  await act(async () => { toast.dismiss(); await settle() })
  expect(toast.getToasts()).toHaveLength(0)
  const form = host.querySelector('form')!
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle() })
  await act(async () => { await settle() })
  expect(toast.getToasts().some(item => 'type' in item && item.type === 'error')).toBe(true)
  expect(window.open).not.toHaveBeenCalled()
})

it('keeps authentication available when the start response contains a reserved connection ID', async () => {
  await submitSchool()
  await act(async () => { finishStart(pending()); await settle() })
  expect(host.textContent).not.toContain('学校认证已完成')
  expect(host.querySelector<HTMLAnchorElement>('a')?.href).toBe(authorizationUrl)
  expect(fetch).not.toHaveBeenCalledWith('/api/learning/client/complete', expect.anything())
})

it('opens authentication only after the school confirms connection preparation', async () => {
  await submitSchool()
  expect(window.open).not.toHaveBeenCalled()
  await act(async () => { finishStart(pending()); await settle() })
  expect(window.open).toHaveBeenCalledExactlyOnceWith(authorizationUrl, '_blank', 'noopener,noreferrer')
  expect(host.querySelector<HTMLAnchorElement>('a')?.href).toBe(authorizationUrl)
})

it.each([400, 403, 503])('stays on the editable form without opening a window when preparation returns HTTP %s', async status => {
  await submitSchool()
  await act(async () => { finishStart(response({ error: status === 400 ? 'invalid' : status === 403 ? 'forbidden' : 'unavailable' }, status)); await settle() })
  expect(window.open).not.toHaveBeenCalled()
  expect(host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe('https://school.example.edu')
})
