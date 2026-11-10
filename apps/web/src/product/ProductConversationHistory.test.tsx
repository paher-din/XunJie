// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConversationHistoryItem, LearningActivity } from '@xunjie/contracts/learning-data'
import { ProductConversationHistory, useConversationHistory } from './ProductConversationHistory'
import { Toaster, toast } from '@xunjie/ui/feedback'

const first = '00000000-0000-4000-8000-000000000001'
const second = '00000000-0000-4000-8000-000000000002'
const activities = [
  { activityId: first, goal: '数字逻辑', question: '', status: 'open', createdAt: new Date().toISOString() },
  { activityId: second, goal: '程序设计', question: '', status: 'open', createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
] as LearningActivity[]
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
type Label = Pick<ConversationHistoryItem, 'title' | 'pinned' | 'deleted'>
type Scope = { archives: Map<string, boolean>; labels: Map<string, Label> }
let host: HTMLDivElement, root: Root
let scopes: Map<string, Scope>

function History({ scope }: { scope: string }) {
  const history = useConversationHistory('legacy-' + scope, scope, 'client', 'subject-' + scope)
  const [open, setOpen] = useState(false), [query, setQuery] = useState('')
  return <ProductConversationHistory activities={activities} labels={history.items} archiveOpen={open} query={query}
    error={history.error} ready={history.ready} busy={history.busy} onRetry={history.retry} scopeKey={scope}
    onNew={vi.fn()} onOpen={vi.fn()} onArchiveOpenChange={setOpen} onQueryChange={setQuery}
    onArchive={id => history.setArchived(id, true)} onRestore={id => history.setArchived(id, false)}
    onRename={history.rename} onPin={history.setPinned} onDelete={history.remove} />
}

function savedScope(scope: string) {
  const saved = scopes.get(scope) ?? { archives: new Map(), labels: new Map() }
  scopes.set(scope, saved); return saved
}
function historyState(saved: Scope) {
  return { items: [...new Set([...saved.archives.keys(), ...saved.labels.keys()])].map(activityId => ({
    activityId, title: null, pinned: false, deleted: false, ...saved.labels.get(activityId), archived: saved.archives.get(activityId) ?? false,
  })) }
}
function serverRequest(url: string, options: RequestInit = {}) {
  const headers = options.headers as Record<string, string>, scope = headers['x-xj-space']
  expect(headers['x-xj-expected-subject']).toBe('subject-' + scope)
  expect(headers['x-xj-namespace']).toBe('client')
  const saved = savedScope(scope), body = JSON.parse(String(options.body ?? '{}'))
  if (url === '/api/learning/conversation-history/update') {
    const label = saved.labels.get(body.activityId) ?? { title: null, pinned: false, deleted: false }
    if (label.deleted && body.action !== 'delete') return response({ error: 'missing' }, 404)
    saved.labels.set(body.activityId, { ...label,
      ...(body.action === 'rename' ? { title: body.title } : body.action === 'pin' ? { pinned: body.pinned } : { deleted: true, pinned: false }) })
    return response(historyState(saved))
  }
  if (url === '/api/learning/conversation-history') return response(historyState(saved))
  if (url.endsWith('/set')) saved.archives.set(body.activityId, body.archived)
  else if (url.endsWith('/import')) {
    for (const id of body.activityIds) if (!saved.archives.has(id)) saved.archives.set(id, true)
  } else throw new Error('Unexpected route ' + url)
  return response({ archivedIds: [...saved.archives].filter(([, archived]) => archived).map(([id]) => id) })
}

async function render(scope: string) { await act(async () => { root.render(<><Toaster /><History scope={scope} /></>); await settle() }) }
async function click(selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector)
  expect(button, selector).not.toBeNull()
  await act(async () => { button!.click(); await settle() })
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
}
async function menuAction(id: string, action: string) {
  await click(`[data-conversation-id="${id}"] .agent-conv-more`)
  const button = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === action)
  expect(button).toBeDefined()
  await act(async () => { button!.click(); await settle() })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  scopes = new Map()
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => serverRequest(url, options)))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { toast.dismiss(); root.unmount(); await settle() })
  host.remove(); localStorage.clear(); vi.unstubAllGlobals()
})

it('shares archive and restore across browsers while separating learning spaces', async () => {
  await render('personal-a')
  await menuAction(first, '归档')
  expect(savedScope('personal-a').archives.get(first)).toBe(true)
  expect(activities[0].status).toBe('open')
  await act(async () => root.unmount())
  localStorage.clear()
  root = createRoot(host)
  await render('personal-a')
  expect(host.querySelector(`[data-conversation-id="${first}"]`)).toBeNull()
  await click('.agent-archive-entry')
  expect(host.textContent).toContain('数字逻辑')
  await click('[aria-label="恢复「数字逻辑」"]')
  expect(savedScope('personal-a').archives.get(first)).toBe(false)
  expect(host.querySelector('.agent-archive-entry')).toBeNull()
  await render('personal-b')
  expect(host.querySelector(`[data-conversation-id="${first}"]`)).not.toBeNull()
})

it('uses the library menu and date groups, commits IME-safe renames once and retains pins in another browser', async () => {
  await render('personal-a')
  expect(host.textContent).toContain('今天'); expect(host.textContent).toContain('更早')
  await menuAction(first, '重命名')
  const field = host.querySelector<HTMLInputElement>('[aria-label="重命名对话"]')!
  field.value = '复位问题整理'
  await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); await settle() })
  expect(savedScope('personal-a').labels.has(first)).toBe(false)
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    await settle()
  })
  const updates = vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/learning/conversation-history/update')
  expect(updates).toHaveLength(1)
  expect(host.textContent).toContain('复位问题整理')
  expect(activities[0].goal).toBe('数字逻辑')
  await click(`[data-conversation-id="${first}"] [aria-label="置顶"]`)
  expect(host.querySelector('.agent-group-label.foldable')?.textContent).toContain('置顶')
  await act(async () => root.unmount()); localStorage.clear(); root = createRoot(host)
  await render('personal-a')
  expect(host.querySelector(`[data-conversation-id="${first}"] [aria-pressed="true"]`)).not.toBeNull()
  expect(host.textContent).toContain('复位问题整理')
})

it('supports menu keyboard navigation, Escape cancellation and a real delete confirmation', async () => {
  await render('personal-a')
  await click(`[data-conversation-id="${first}"] .agent-conv-more`)
  expect(document.activeElement?.textContent).toBe('重命名')
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.activeElement?.textContent).toBe('归档')
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.activeElement?.classList.contains('agent-conv-more')).toBe(true)
  const outerEscape = vi.fn()
  document.addEventListener('keydown', outerEscape)
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(outerEscape).toHaveBeenCalledOnce()
  document.removeEventListener('keydown', outerEscape)
  await menuAction(first, '重命名')
  expect(host.querySelector('[aria-label="重命名对话"]')).not.toBeNull()
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="重命名对话"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await menuAction(second, '重命名')
  const field = host.querySelector<HTMLInputElement>('[aria-label="重命名对话"]')!
  field.value = '应当取消'
  await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await settle() })
  expect(savedScope('personal-a').labels.has(second)).toBe(false)
  await menuAction(second, '删除')
  expect(savedScope('personal-a').labels.has(second)).toBe(false)
  await click('.agent-conv-confirm .danger')
  expect(savedScope('personal-a').labels.get(second)?.deleted).toBe(true)
  expect(host.querySelector(`[data-conversation-id="${second}"]`)).toBeNull()
  expect(activities[1].status).toBe('open')
  await act(async () => root.unmount()); localStorage.clear(); root = createRoot(host)
  await render('personal-a')
  expect(host.textContent).not.toContain('程序设计')
})

it('retains an unconfirmed rename for retry after a network failure', async () => {
  let offline = true
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/update') && offline) throw new Error('offline')
    return serverRequest(url, options)
  }))
  await render('personal-a'); await menuAction(first, '重命名')
  const field = host.querySelector<HTMLInputElement>('[aria-label="重命名对话"]')!
  field.value = '断网后继续的标题'
  await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle() })
  expect(field.isConnected).toBe(true); expect(field.value).toBe('断网后继续的标题')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(host.querySelector('[data-sonner-toast]')?.textContent).toContain('对话操作未确认')
  expect(host.querySelector('.agent-side-empty')?.textContent).not.toContain('对话操作未确认')
  const attempts = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/update'))
  expect(attempts).toHaveLength(2)
  expect(JSON.parse(String(attempts[0][1]?.body)).requestId).toBe(JSON.parse(String(attempts[1][1]?.body)).requestId)
  offline = false
  await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle() })
  expect(savedScope('personal-a').labels.get(first)?.title).toBe('断网后继续的标题')
})

it('keeps the menu open when the conversation scrolls and closes it when its own sidebar scrolls', async () => {
  await act(async () => { root.render(<><div className="side-nav"><History scope="personal-a" /></div><main /></>); await settle() })
  await click(`[data-conversation-id="${first}"] .agent-conv-more`)
  const more = host.querySelector<HTMLButtonElement>(`[data-conversation-id="${first}"] .agent-conv-more`)!
  await act(async () => host.querySelector('main')!.dispatchEvent(new Event('scroll')))
  expect(more.getAttribute('aria-expanded')).toBe('true')
  await act(async () => host.querySelector('.side-nav')!.dispatchEvent(new Event('scroll')))
  expect(more.getAttribute('aria-expanded')).toBe('false')
})

it('imports old browser archives without overriding a later restore', async () => {
  savedScope('personal-a').archives.set(first, false)
  localStorage.setItem('legacy-personal-a', JSON.stringify([first, second]))
  await render('personal-a')
  expect(savedScope('personal-a').archives.get(first)).toBe(false)
  expect(savedScope('personal-a').archives.get(second)).toBe(true)
  expect(localStorage.getItem('legacy-personal-a')).toBeNull()
  expect(host.querySelector(`[data-conversation-id="${first}"]`)).not.toBeNull()
  expect(host.querySelector(`[data-conversation-id="${second}"]`)).toBeNull()
})

it('retains the old browser archive after a network failure and imports it on retry', async () => {
  localStorage.setItem('legacy-personal-a', JSON.stringify([first]))
  let offline = true
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (offline) throw new Error('offline')
    return serverRequest(url, options)
  }))
  await render('personal-a')
  expect(localStorage.getItem('legacy-personal-a')).toBe(JSON.stringify([first]))
  expect(host.textContent).toContain('无法读取对话列表')
  offline = false
  await click('[role="alert"] button')
  expect(localStorage.getItem('legacy-personal-a')).toBeNull()
  expect(savedScope('personal-a').archives.get(first)).toBe(true)
})

it('ignores a delayed response after switching accounts or spaces', async () => {
  let resolveFirst: ((value: Response) => void) | undefined
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    const scope = (options?.headers as Record<string, string>)['x-xj-space']
    if (scope === 'personal-a') return new Promise<Response>(resolve => { resolveFirst = resolve })
    return Promise.resolve(serverRequest(url, options))
  }))
  await render('personal-a')
  await render('personal-b')
  expect(host.querySelector(`[data-conversation-id="${first}"]`)).not.toBeNull()
  await act(async () => { resolveFirst!(response({ items: [{ activityId: first, title: '另一个账号', pinned: true, archived: true, deleted: false }] })); await settle() })
  expect(host.textContent).not.toContain('另一个账号')
  expect(host.querySelector(`[data-conversation-id="${first}"]`)).not.toBeNull()
})
