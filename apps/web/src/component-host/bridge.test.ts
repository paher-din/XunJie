import { describe, expect, it } from 'vitest'
import { componentError, createComponentBridge } from './bridge'
import type { ReliableWorkspace } from '../reliable-workspace'
import { componentManifestSchema, type ComponentBinding } from '@xunjie/contracts/components'
import type { WorkFile } from '@xunjie/contracts/learning-data'

const binding: ComponentBinding = { key: 'notes', configuration: { title: '标注' }, materialIds: [], definition: { digest: 'a'.repeat(64),
  manifest: componentManifestSchema.parse({ formatVersion: 1, componentId: crypto.randomUUID(), version: 1, hostApiVersion: 1, title: '标注',
    entry: { resourceId: crypto.randomUUID(), sha256: 'b'.repeat(64), byteLength: 20, mediaType: 'text/html' },
    stateVersion: 1, stateShape: { type: 'object', properties: { text: { type: 'string', maxLength: 100 } } }, initialState: { text: '' },
    requiredCapabilities: ['workspace.read', 'workspace.change'] }) } }

function fixture() {
  let files: WorkFile[] = [], protectedCount = 0
  let allowed = true
  const receipts = new Map<string, { inputDigest: string; confirmation: 'local-protected'; contentId: string; requestedContentId: string; superseded: boolean }>()
  const workspace = { snapshot: () => ({ ready: true, files }), change: (next: WorkFile[]) => { files = next },
    trackInput: <T>(input: Promise<T>) => input,
    retainConflict: (next: WorkFile[]) => { files = next }, protect: async () => {},
    applyOperation: async (operation: { operationId: string; inputDigest: string; contentId: string }, apply: () => void) => {
      const previous = receipts.get(operation.operationId)
      if (previous) { if (previous.inputDigest !== operation.inputDigest) throw new Error('conflict'); return previous }
      apply(); protectedCount++
      const receipt = { inputDigest: operation.inputDigest, confirmation: 'local-protected' as const, contentId: operation.contentId,
        requestedContentId: operation.contentId, superseded: false }
      receipts.set(operation.operationId, receipt); return receipt
    },
    leave: async () => { protectedCount++ } } as unknown as ReliableWorkspace
  const activityId = crypto.randomUUID()
  const bridge = createComponentBridge(workspace, activityId, binding, () => allowed)
  const message = (method: string, payload: unknown) => ({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
    messageId: crypto.randomUUID(), method, payload })
  return { bridge, message, files: () => files, protectedCount: () => protectedCount, deny: () => { allowed = false },
    reopen: () => createComponentBridge(workspace, activityId, binding, () => allowed) }
}
describe('component host instance and operation boundary', () => {
  it('rejects a different instance, closed mount and unsupported method', async () => {
    const f = fixture()
    await expect(f.bridge.handle({ ...f.message('workspace.read', {}), instanceId: 'other' })).rejects.toThrow('stale-connection')
    await expect(f.bridge.handle(f.message('execution.submit', {}))).rejects.toThrow()
    f.bridge.close()
    await expect(f.bridge.handle(f.message('workspace.read', {}))).rejects.toThrow('stale-connection')
  })
  it('keeps a single operation identity, refuses changed input and stale conditional writes', async () => {
    const f = fixture(), contentId = crypto.randomUUID()
    const change = { operationId: crypto.randomUUID(), expectedContentId: null, contentId, content: { text: '中文\n原文' } }
    const first = await f.bridge.handle(f.message('workspace.change', change))
    expect(first).toMatchObject({ confirmation: 'local-protected', contentId })
    expect(await f.bridge.handle(f.message('workspace.change', change))).toEqual(first)
    expect(f.protectedCount()).toBe(1)
    await expect(f.bridge.handle(f.message('workspace.change', { ...change, content: { text: 'different' } }))).rejects.toThrow('conflict')
    await expect(f.bridge.handle(f.message('workspace.change', { ...change, contentId: crypto.randomUUID(), operationId: crypto.randomUUID() }))).rejects.toThrow('conflict')
    expect(f.files()).toHaveLength(1)
  })
  it('validates the declared structure before protecting any state', async () => {
    const f = fixture()
    await expect(f.bridge.handle(f.message('workspace.change', { operationId: crypto.randomUUID(), contentId: crypto.randomUUID(), expectedContentId: null,
      content: { extra: 'not allowed' } }))).rejects.toThrow('invalid-input')
    expect(f.files()).toHaveLength(0)
  })
  it('delegates old and remounted operation replays to the workspace without reapplying', async () => {
    const f = fixture()
    let previous: string | null = null
    let first: unknown, receipt: unknown
    for (let i = 0; i < 257; i++) {
      const input: { operationId: string; expectedContentId: string | null; contentId: string; content: { text: string } } = {
        operationId: crypto.randomUUID(), expectedContentId: previous, contentId: crypto.randomUUID(), content: { text: String(i) } }
      const result = await f.bridge.handle(f.message('workspace.change', input))
      if (i === 0) { first = input; receipt = result }
      previous = input.contentId
    }
    expect(await f.bridge.handle(f.message('workspace.change', first))).toEqual(receipt)
    f.bridge.close()
    const reopened = f.reopen()
    expect(await reopened.handle({ ...f.message('workspace.change', first), connectionId: reopened.connectionId })).toEqual(receipt)
    expect(f.protectedCount()).toBe(257)
    expect(JSON.parse(f.files()[0].value).content.text).toBe('256')
  })
  it('maps malformed payloads, missing authority and unknown outcomes separately', async () => {
    const f = fixture()
    try { await f.bridge.handle(f.message('workspace.change', {})); throw new Error('Expected validation failure') }
    catch (error) { expect(componentError(error).code).toBe('invalid-input') }
    f.deny()
    await expect(f.bridge.handle(f.message('workspace.read', {}))).rejects.toThrow('forbidden')
    expect(componentError(new Error('forbidden')).code).toBe('forbidden')
    expect(componentError(new Error('outcome-unknown')).code).toBe('outcome-unknown')
    expect(componentError(new Error('I/O failure')).code).toBe('resource-unavailable')
  })
})
