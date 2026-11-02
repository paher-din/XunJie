import { describe, expect, it } from 'vitest'
import { createComponentBridge } from './bridge'
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
  const workspace = { snapshot: () => ({ ready: true, files }), change: (next: WorkFile[]) => { files = next },
    retainConflict: (next: WorkFile[]) => { files = next }, protect: async () => {},
    leave: async () => { protectedCount++ } } as unknown as ReliableWorkspace
  const bridge = createComponentBridge(workspace, crypto.randomUUID(), binding, () => true)
  const message = (method: string, payload: unknown) => ({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
    messageId: crypto.randomUUID(), method, payload })
  return { bridge, message, files: () => files, protectedCount: () => protectedCount }
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
})
