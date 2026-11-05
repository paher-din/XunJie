import { describe, expect, it } from 'vitest'
import { componentManifestSchema, componentTestInstanceId, type ComponentBinding } from '@xunjie/contracts/components'
import { createPreparationBridge } from './bridge'

const componentId = crypto.randomUUID()
const digest = 'a'.repeat(64)
const binding: ComponentBinding = { key: 'annotation', configuration: { title: '材料标注' }, materialIds: [],
  definition: { digest, manifest: componentManifestSchema.parse({ formatVersion: 1, componentId, version: 2, hostApiVersion: 1,
    title: '材料标注', entry: { resourceId: crypto.randomUUID(), sha256: 'b'.repeat(64), byteLength: 20, mediaType: 'text/html' },
    stateVersion: 1, stateShape: { type: 'object', properties: { annotations: { type: 'array', maxItems: 2,
      items: { type: 'object', properties: { id: { type: 'string', maxLength: 36 }, quote: { type: 'string', maxLength: 4000 },
        note: { type: 'string', maxLength: 4000 } } } } } }, initialState: { annotations: [] },
    requiredCapabilities: ['workspace.read', 'workspace.change'] }) } }

function fixture() {
  const preparationId = crypto.randomUUID()
  const bridge = createPreparationBridge(preparationId, binding, { annotations: [] })
  const message = (method: string, payload: unknown) => ({ hostApiVersion: 1, connectionId: bridge.connectionId,
    instanceId: bridge.instanceId, messageId: crypto.randomUUID(), method, payload })
  return { bridge, message, preparationId }
}

describe('preparation bridge isolation', () => {
  it('addresses a preparation instance, never a student activity instance', () => {
    const { bridge, preparationId } = fixture()
    expect(bridge.instanceId).toBe(componentTestInstanceId(preparationId, binding.key))
    expect(bridge.instanceId).not.toBe(`${crypto.randomUUID()}:${binding.key}`)
    expect(bridge.instanceId.startsWith('preparation:')).toBe(true)
  })

  it('refuses execution, reference and unknown methods, a foreign instance and a closed mount', async () => {
    const { bridge, message } = fixture()
    for (const method of ['execution.submit', 'execution.query', 'execution.stop', 'execution.control', 'execution.capabilities',
      'reference.select', 'reference.locate'])
      await expect(bridge.handle(message(method, {}))).rejects.toThrow('capability-unavailable')
    await expect(bridge.handle({ ...message('workspace.read', {}), instanceId: 'other' })).rejects.toThrow('stale-connection')
    await expect(bridge.handle({ ...message('workspace.read', {}), connectionId: crypto.randomUUID() })).rejects.toThrow('stale-connection')
    await expect(bridge.handle({ ...message('workspace.read', {}), hostApiVersion: 2 })).rejects.toThrow('unsupported-version')
    bridge.close()
    await expect(bridge.handle(message('workspace.read', {}))).rejects.toThrow('stale-connection')
  })

  it('round-trips temporary state with one operation identity and refuses changed input under it', async () => {
    const { bridge, message } = fixture()
    expect(await bridge.handle(message('workspace.read', {}))).toEqual({ contentId: null, content: { annotations: [] } })
    const contentId = crypto.randomUUID()
    const change = { operationId: crypto.randomUUID(), expectedContentId: null, contentId,
      content: { annotations: [{ id: crypto.randomUUID(), quote: '观察', note: '临时笔记' }] } }
    const first = await bridge.handle(message('workspace.change', change))
    expect(first).toMatchObject({ confirmation: 'local-protected', contentId })
    expect(await bridge.handle(message('workspace.change', change))).toEqual(first)
    expect(bridge.observed().writes).toBe(1)
    await expect(bridge.handle(message('workspace.change', { ...change, content: { annotations: [] } }))).rejects.toThrow('conflict')
    expect(await bridge.handle(message('workspace.read', {}))).toEqual({ contentId, content: change.content })
  })

  it('rejects a stale baseline, unbounded content and content outside the declared shape', async () => {
    const { bridge, message } = fixture()
    const contentId = crypto.randomUUID()
    await expect(bridge.handle(message('workspace.change', { operationId: crypto.randomUUID(), expectedContentId: contentId,
      contentId: crypto.randomUUID(), content: { annotations: [] } }))).rejects.toThrow('conflict')
    await expect(bridge.handle(message('workspace.change', { operationId: crypto.randomUUID(), expectedContentId: null,
      contentId: crypto.randomUUID(), content: { annotations: [], extra: true } }))).rejects.toThrow('invalid-input')
    // maxItems is 2 in this fixture: the declared bound is enforced on the temporary store too.
    await expect(bridge.handle(message('workspace.change', { operationId: crypto.randomUUID(), expectedContentId: null,
      contentId: crypto.randomUUID(), content: { annotations: [{ id: 'a', quote: 'q', note: '' }, { id: 'b', quote: 'q', note: '' },
        { id: 'c', quote: 'q', note: '' }] } }))).rejects.toThrow('invalid-input')
  })

  it('acknowledges transport events without producing learning evidence', async () => {
    const { bridge, message } = fixture()
    expect(await bridge.handle(message('component.event', { eventId: crypto.randomUUID(), sequence: 0, kind: 'interaction' })))
      .toEqual({ received: true })
    expect(await bridge.handle(message('component.ready', {}))).toEqual({ ready: true })
    expect(await bridge.handle(message('component.close', {}))).toEqual({ closed: true })
    await expect(bridge.handle(message('workspace.read', {}))).rejects.toThrow('stale-connection')
  })
})
