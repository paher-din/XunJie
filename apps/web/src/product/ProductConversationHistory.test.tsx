// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { ProductConversationHistory, useConversationArchive } from './ProductConversationHistory'

const first = '00000000-0000-4000-8000-000000000001'
const second = '00000000-0000-4000-8000-000000000002'
const activities = [
  { activityId: first, goal: '数字逻辑', question: '', status: 'open' },
  { activityId: second, goal: '程序设计', question: '', status: 'open' },
] as LearningActivity[]
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const response = (archivedIds: string[]) => new Response(JSON.stringify({ archivedIds }), { status: 200 })
let host: HTMLDivElement, root: Root
let scopes: Map<string, Map<string, boolean>>

function History({ scope }: { scope: string }) {
  const archive = useConversationArchive('legacy-' + scope, scope, 'client', 'subject-' + scope)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  return <ProductConversationHistory activities={activities} archivedIds={archive.ids} archiveOpen={open} query={query}
    error={archive.error} ready={archive.ready} busy={archive.busy} onRetry={archive.retry}
    onNew={vi.fn()} onOpen={vi.fn()} onArchiveOpenChange={setOpen} onQueryChange={setQuery}
    onArchive={id => { void archive.setArchived(id, true) }} onRestore={id => { void archive.setArchived(id, false) }} />
}

function serverRequest(url: string, options: RequestInit = {}) {
  const headers = options.headers as Record<string, string>
  const scope = headers['x-xj-space']
  expect(headers['x-xj-expected-subject']).toBe('subject-' + scope)
  expect(headers['x-xj-namespace']).toBe('client')
  const saved = scopes.get(scope) ?? new Map<string, boolean>()
  scopes.set(scope, saved)
  const body = JSON.parse(String(options.body ?? '{}'))
  if (url.endsWith('/set')) saved.set(body.activityId, body.archived)
  else if (url.endsWith('/import')) {
    for (const id of body.activityIds) if (!saved.has(id)) saved.set(id, true)
  }
  else expect(url).toBe('/api/learning/conversation-archives')
  return response([...saved].filter(([, archived]) => archived).map(([id]) => id))
}

async function render(scope: string) { await act(async () => { root.render(<History scope={scope} />); await settle() }) }
async function click(selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector)
  expect(button, selector).not.toBeNull()
  await act(async () => { button!.click(); await settle() })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  scopes = new Map()
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => serverRequest(url, options)))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); await settle() })
  host.remove(); localStorage.clear(); vi.unstubAllGlobals()
})

it('shares archive and restore across browsers while separating learning spaces', async () => {
  await render('personal-a')
  await click('[aria-label="归档「数字逻辑」"]')
  expect(scopes.get('personal-a')?.get(first)).toBe(true)
  expect(activities[0].status).toBe('open')
  await act(async () => root.unmount())
  localStorage.clear() // A second browser has independent local storage.
  root = createRoot(host)
  await render('personal-a')
  expect(host.querySelector('[aria-label="归档「数字逻辑」"]')).toBeNull()
  await click('.agent-archive-entry')
  expect(host.textContent).toContain('数字逻辑')
  await click('[aria-label="恢复「数字逻辑」"]')
  expect(scopes.get('personal-a')?.get(first)).toBe(false)
  await render('personal-b')
  await click('.agent-archive-entry') // History's open state persists while the scope changes.
  expect(host.querySelector('[aria-label="归档「数字逻辑」"]')).not.toBeNull()
  await render('personal-a')
  expect(host.querySelector('[aria-label="归档「数字逻辑」"]')).not.toBeNull()
})

it('imports old browser archives without overriding a later restore', async () => {
  scopes.set('personal-a', new Map([[first, false]]))
  localStorage.setItem('legacy-personal-a', JSON.stringify([first, second]))
  await render('personal-a')
  expect(scopes.get('personal-a')?.get(first)).toBe(false)
  expect(scopes.get('personal-a')?.get(second)).toBe(true)
  expect(localStorage.getItem('legacy-personal-a')).toBeNull()
  expect(host.querySelector('[aria-label="归档「数字逻辑」"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="归档「程序设计」"]')).toBeNull()
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
  expect(host.textContent).toContain('无法读取归档')
  expect(host.querySelector('[aria-label="归档「数字逻辑」"]')).toBeNull()
  offline = false
  await click('[role="alert"] button')
  expect(localStorage.getItem('legacy-personal-a')).toBeNull()
  expect(scopes.get('personal-a')?.get(first)).toBe(true)
})

it('ignores a delayed response after switching accounts or spaces', async () => {
  let resolveFirst: ((value: Response) => void) | undefined
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    const scope = (options?.headers as Record<string, string>)['x-xj-space']
    if (scope === 'personal-a') return new Promise<Response>(resolve => { resolveFirst = resolve })
    return Promise.resolve(serverRequest(url, options))
  }))
  await render('personal-a')
  expect(host.textContent).toContain('正在读取对话')
  await render('personal-b')
  expect(host.querySelector('[aria-label="归档「数字逻辑」"]')).not.toBeNull()
  await act(async () => { resolveFirst!(response([first])); await settle() })
  expect(host.querySelector('[aria-label="归档「数字逻辑」"]')).not.toBeNull()
})
