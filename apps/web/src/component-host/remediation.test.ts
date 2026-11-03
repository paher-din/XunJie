import { afterEach, describe, expect, it, vi } from 'vitest'
import { createComponentBridge, componentError } from './bridge'
import { ReliableWorkspace } from '../reliable-workspace'
import { WorkStore } from '../reliable-workspace/store'
import { ComponentInteractions } from './interactions'
import { componentManifestSchema, componentReply, componentHostMessageSchema, componentInitializeSchema, componentRequestSchema, type ComponentBinding } from '@xunjie/contracts/components'

const binding: ComponentBinding = { key: 'notes', materialIds: [], configuration: { title: '标注' }, definition: { digest: 'a'.repeat(64),
  manifest: componentManifestSchema.parse({ formatVersion: 1, componentId: crypto.randomUUID(), version: 1, hostApiVersion: 1, title: '标注',
    entry: { resourceId: crypto.randomUUID(), sha256: 'b'.repeat(64), byteLength: 1, mediaType: 'text/html' }, stateVersion: 1,
    stateShape: { type: 'object', properties: { text: { type: 'string', maxLength: 100 } } }, initialState: { text: '' }, requiredCapabilities: ['workspace.read', 'workspace.change'] }) } }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('retired authority after asynchronous receipt lookup', () => {
  for (const retired of ['closed', 'forbidden'] as const) for (const failure of [false, true]) {
    it(`${retired} with ${failure ? 'failed' : 'successful'} lookup never changes current files/candidates`, async () => {
      vi.stubGlobal('navigator', { locks: { request: async (_: string, callback: () => unknown) => callback() } })
      let resolve!: (value: undefined) => void, reject!: (error: Error) => void
      const lookup = vi.spyOn(WorkStore.prototype, 'operation').mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no }))
      const workspace = new ReliableWorkspace('review-scope', { read: vi.fn(), receipt: vi.fn(), sync: vi.fn() })
      const current = { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: 'current.txt', kind: 'text' as const, encoding: 'utf8' as const, mediaType: 'text/plain', value: 'CURRENT INPUT' }
      workspace.state = { ...workspace.state, files: [current], ready: true }
      const notify = vi.fn(); workspace.subscribe(notify)
      let allowed = true
      const bridge = createComponentBridge(workspace, crypto.randomUUID(), binding, () => allowed)
      const pending = bridge.handle({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
        messageId: crypto.randomUUID(), method: 'workspace.change', payload: { operationId: crypto.randomUUID(), expectedContentId: null,
          contentId: crypto.randomUUID(), content: { text: 'INPUT FROM RETIRED AUTHORITY' } } })
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce())
      if (retired === 'closed') bridge.close(); else allowed = false
      if (failure) reject(new Error('read failed')); else resolve(undefined)
      await expect(pending).rejects.toThrow(retired === 'closed' ? 'stale-connection' : 'forbidden')
      expect(workspace.snapshot().files).toEqual([current]); expect(workspace.snapshot().conflict).toBeUndefined()
      expect(notify).not.toHaveBeenCalled()
    })
  }
})

it('strict v1 consumers accept complete success/error envelopes and reject missing common fields', () => {
  const context = { connectionId: crypto.randomUUID(), instanceId: 'activity:notes' }
  const request = { messageId: crypto.randomUUID(), method: 'workspace.read' }
  const success = componentReply(context, request, { payload: { contentId: null, content: { text: '' } } }, crypto.randomUUID())
  expect(componentHostMessageSchema.parse(success)).toEqual(success)
  const initialize = componentInitializeSchema.parse({ hostApiVersion: 1, ...context, messageId: crypto.randomUUID(), method: 'host.initialize',
    payload: { binding, theme: {}, materials: [], readOnly: false, titleFont: { base64: 'AA==', sha256: 'c'.repeat(64) } } })
  expect(componentHostMessageSchema.safeParse(initialize).success).toBe(true)
  expect(componentRequestSchema.safeParse(initialize).success).toBe(false)
  for (const entry of [{ method: 'component.ready', payload: { ready: true } }, { method: 'component.close', payload: { closed: true } },
    { method: 'workspace.change', payload: { inputDigest: 'b'.repeat(64), confirmation: 'local-protected', contentId: null, requestedContentId: crypto.randomUUID(), superseded: true } },
    { method: 'component.event', payload: { received: true, eventId: crypto.randomUUID(), sequence: 1, kind: 'confirmation' } }]) {
    expect(componentHostMessageSchema.safeParse(componentReply(context, { ...request, method: entry.method }, { payload: entry.payload }, crypto.randomUUID())).success).toBe(true)
  }
  for (const code of ['invalid-input', 'unsupported-version', 'capability-unavailable', 'forbidden', 'stale-connection', 'conflict', 'resource-unavailable', 'outcome-unknown']) {
    const error = componentReply(context, request, { error: componentError(new Error(code)) }, crypto.randomUUID())
    expect(componentHostMessageSchema.safeParse(error).success).toBe(true)
  }
  expect(componentHostMessageSchema.safeParse({ hostApiVersion: 1, ...context, replyTo: request.messageId, payload: {} }).success).toBe(false)
})

it('public workspace mutations protect component identities and reserved paths while ordinary rename works', () => {
  const activityId = crypto.randomUUID()
  const workspace = new ReliableWorkspace('protected-files', { read: vi.fn(), receipt: vi.fn(), sync: vi.fn() }, { activityId, bindings: [binding] })
  const state = { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: 'components/notes.json', kind: 'state' as const,
    encoding: 'json' as const, mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
      instanceId: `${activityId}:notes`, componentId: binding.definition.manifest.componentId, version: 1, stateVersion: 1,
      definitionDigest: binding.definition.digest, operationId: crypto.randomUUID(), content: { text: '原始状态' } }) }
  workspace.state = { ...workspace.state, files: [state], ready: true }
  expect(() => workspace.rename(state.objectId, 'renamed.json')).toThrow()
  expect(() => workspace.remove(state.objectId)).toThrow()
  expect(() => workspace.edit(state.objectId, '{}')).toThrow()
  expect(() => workspace.create('components/notes.json', 'text')).toThrow()
  expect(workspace.snapshot().files).toEqual([state])
  const ordinary = workspace.create('ordinary.txt', 'text'); workspace.rename(ordinary, 'renamed.txt')
  expect(workspace.snapshot().files.find(file => file.objectId === ordinary)?.name).toBe('renamed.txt')
})

it('consumes four typed non-execution events once, rejects identity reuse and out-of-order events', async () => {
  const workspace = new ReliableWorkspace('events', { read: vi.fn(), receipt: vi.fn(), sync: vi.fn() })
  const interactions = new ComponentInteractions(), consumed = vi.fn(); interactions.subscribe(consumed)
  const bridge = createComponentBridge(workspace, crypto.randomUUID(), binding, () => true,
    event => interactions.accept({ instanceId: bridge.instanceId, connectionId: bridge.connectionId, event }))
  const payloads = [{ kind: 'control-change', controlId: 'note', value: '中文' }, { kind: 'answer', promptId: 'question', value: '回答' },
    { kind: 'prediction', promptId: 'question', value: '预测' }, { kind: 'confirmation', targetId: 'selection', confirmed: true }]
  for (const [index, value] of payloads.entries()) {
    const event = { formatVersion: 1, eventId: crypto.randomUUID(), sequence: index + 1, ...value }
    const request = { hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId, messageId: crypto.randomUUID(), method: 'component.event', payload: event }
    expect(componentRequestSchema.safeParse(request).success).toBe(true)
    expect(componentRequestSchema.safeParse({ ...request, payload: { ...event, unexpected: true } }).success).toBe(false)
    await expect(bridge.handle({ ...request, instanceId: 'other' })).rejects.toThrow('stale-connection')
    await expect(bridge.handle({ ...request, connectionId: crypto.randomUUID() })).rejects.toThrow('stale-connection')
    const receipt = await bridge.handle(request)
    expect(await bridge.handle({ ...request, messageId: crypto.randomUUID() })).toEqual(receipt)
    await expect(bridge.handle({ ...request, payload: { ...event, sequence: 99 } })).rejects.toThrow('conflict')
    expect(interactions.read(bridge.instanceId)?.event).toEqual(event)
  }
  expect(consumed).toHaveBeenCalledTimes(4)
  await expect(bridge.handle({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
    messageId: crypto.randomUUID(), method: 'component.event', payload: { formatVersion: 1, eventId: crypto.randomUUID(), sequence: 6, kind: 'confirmation', targetId: 'x', confirmed: true } })).rejects.toThrow('conflict')
  expect(componentRequestSchema.safeParse({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
    messageId: crypto.randomUUID(), method: 'component.event', payload: { eventId: crypto.randomUUID(), sequence: 5, kind: 'interaction' } }).success).toBe(false)
})
