// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import type { ModelConnection } from '@xunjie/contracts/model-connections'
import { useModelSelection, type ModelSelectionController, type Selection } from './ModelSelection'
import { ProductAgent } from './ProductAgent'
import { Toaster, toast } from '@xunjie/ui/feedback'

const identity: SpaceIdentity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), kind: 'personal', name: '个人' }
const connection: ModelConnection = { connectionId: crypto.randomUUID(), name: '同一供应商', modelId: 'first-model',
  protocol: 'messages', baseUrl: 'https://synthetic.invalid', path: '/v1/messages', dialect: 'standard', parameterMode: 'plain',
  version: 1, routeId: crypto.randomUUID(), enabled: true, hasCredential: true, adapterState: 'ready',
  capabilities: { text: 'unknown', images: 'unknown', tools: 'unknown', strictSchema: 'unknown' } }
const policy = { checksAllowed: true, maxChecksPerHour: 6, maxOutputTokens: 64, timeoutMs: 10000 }
let root: Root, host: HTMLDivElement, controller: ModelSelectionController
let server: Selection, loseReceipt: boolean, holdReceipt: Promise<void> | undefined
let requests: { path: string; body: any }[], receipts: Map<string, Selection>
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
function Harness({ subject = identity }: { subject?: SpaceIdentity }) {
  controller = useModelSelection(subject, 'personal', 'test')
  return <><Toaster /><ProductAgent identity={subject} spaceKey="personal" namespace="test"
    onSession={() => {}} onWorkspace={() => {}} onWorkspaceCreated={() => {}}
    onSettings={() => {}} selection={controller} readOnly={false} /></>
}
const render = async (subject = identity) => act(async () => { root.render(<Harness subject={subject} />); await settle() })
async function choose(index: number) {
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="切换模型"]')!.click(); await settle() })
  await act(async () => { host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[index]!.click(); await settle() })
  await act(async () => { await settle() })
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: () => Promise.resolve() })
  localStorage.clear()
  localStorage.setItem('xj.agent-draft.' + JSON.stringify(['test', 'personal', identity.environmentId, identity.spaceId, identity.principalId]) + '.new', '原问题')
  requests = []; receipts = new Map(); loseReceipt = false; holdReceipt = undefined
  server = { version: 0, selected: null, options: [
    { kind: 'personal', origin: 'self', connection, policy },
    { kind: 'personal', origin: 'device', connection: { ...connection, connectionId: crypto.randomUUID(), modelId: 'second-model' }, policy },
    { kind: 'school', connection: { ...connection, connectionId: crypto.randomUUID(), name: '学校服务', modelId: 'school-model' }, policy },
  ] }
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const body = options.body ? JSON.parse(String(options.body)) : undefined
    requests.push({ path: url, body })
    expect(url).not.toContain('/grants')
    if (!body) return response(server)
    let saved = receipts.get(body.requestId)
    if (!saved) {
      const selected = server.options.find(choice => choice.connection.connectionId === body.source.connectionId)!
      server = { ...server, version: server.version + 1, selected }; saved = structuredClone(server); receipts.set(body.requestId, saved)
    }
    await holdReceipt
    if (loseReceipt) { loseReceipt = false; throw new TypeError('lost receipt') }
    return response(saved)
  }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await render()
})
afterEach(async () => { await act(async () => { toast.dismiss(); root.unmount() }); host.remove(); vi.unstubAllGlobals() })

it('shows specific models and selects configured self/device models without a grant request', async () => {
  await choose(0)
  expect(requests.find(request => request.body)?.body.source).toEqual({ kind: 'personal', connectionId: connection.connectionId, owner: 'self' })
  expect(host.querySelector('.prompt-model-label')?.textContent).toBe('first-model')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
  await choose(1)
  expect(requests.filter(request => request.body).at(-1)!.body.source).toEqual({ kind: 'personal', connectionId: server.options[1]!.connection.connectionId, owner: 'device' })
  expect(host.querySelector('.prompt-model-label')?.textContent).toBe('second-model')
  expect(host.querySelector('textarea')?.value).toBe('原问题')
})

it('retries a lost selection receipt with the same request and leaves the question intact', async () => {
  loseReceipt = true
  await choose(0)
  expect(host.querySelector('[data-sonner-toast][data-type="error"]')).not.toBeNull()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
  await choose(0)
  const writes = requests.filter(request => request.body)
  expect(writes).toHaveLength(2)
  expect(writes[0]!.body).toEqual(writes[1]!.body)
  expect(server.version).toBe(1)
  expect(controller.selection?.selected?.connection.modelId).toBe('first-model')
  expect(host.querySelector('textarea')?.value).toBe('原问题')
})

it('does not apply a late receipt or its activity callback after changing space identity', async () => {
  let release!: () => void
  holdReceipt = new Promise(resolve => { release = resolve })
  const onSaved = vi.fn()
  let choosing!: Promise<void>
  await act(async () => { choosing = controller.choose(controller.selection!.options[0]!, onSaved); await settle() })
  await render({ ...identity, principalId: crypto.randomUUID(), name: '另一个空间身份' })
  await act(async () => { release(); await choosing; await settle() })
  expect(onSaved).not.toHaveBeenCalled()
  expect(controller.busy).toBe(false)
})
