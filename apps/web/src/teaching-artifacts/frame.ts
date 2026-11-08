import { acceptsState, type StateShape } from '@xunjie/contracts/components'
import type { TeachingArtifactRevision } from '@xunjie/contracts/teaching-artifacts'
import { teachingArtifactBootstrapSource } from './sdk'
import type { LearningActivity } from '@xunjie/contracts/learning-data'

export const hashBytes = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map(value => value.toString(16).padStart(2, '0')).join('')
export function frameTheme() {
  const styles = getComputedStyle(document.documentElement)
  const aliases: Record<string, string> = { canvas: 'paper', chip: 'chip-bg', hover: 'hover-bg' }
  return Object.fromEntries(['canvas', 'ink', 'ink-soft', 'muted', 'line', 'line-strong', 'chip', 'hover', 'primary', 'accent', 'accent-deep']
    .map(key => [key, styles.getPropertyValue('--' + (aliases[key] ?? key)).trim()]))
}

/** The same SDK and MessagePort run against a private sample, never a student's work or tools. */
export function artifactViewUrl(revision: TeachingArtifactRevision, activity: LearningActivity, spaceKey: string, namespace: string) {
  const query = new URLSearchParams({ space: spaceKey, namespace, digest: revision.sha256,
    subject: [activity.identity.environmentId, activity.identity.spaceId, activity.identity.principalId].join('.') })
  return `/api/learning/artifacts/${activity.activityId}/${revision.artifactId}/revisions/${revision.revisionId}/view?${query}`
}
export function bootstrapMessage(revision: TeachingArtifactRevision, connectionId: string, instanceId: string, readOnly: boolean) {
  return { method: 'host.bootstrap', payload: { sdk: teachingArtifactBootstrapSource(), javascript: revision.payload.javascript,
    initialize: { hostApiVersion: 1, connectionId, instanceId, messageId: crypto.randomUUID(), method: 'host.initialize', payload: { theme: frameTheme(), readOnly } } } }
}
export async function checkRevision(revision: TeachingArtifactRevision, viewUrl: string): Promise<{ load: boolean; stateRoundtrip: boolean }> {
  const manifestCapabilities = new Set<string>(revision.binding.definition.manifest.requiredCapabilities)
  const capabilities = revision.payload.requiredCapabilities.filter(capability =>
    (capability === 'workspace.read' || capability === 'workspace.change') && manifestCapabilities.has(capability))
  const allowed = new Set<string>(capabilities)
  // The production SDK restores state before exposing controls; a sample cannot grant that missing read.
  if (!allowed.has('workspace.read')) return { load: false, stateRoundtrip: false }
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('aria-hidden', 'true')
  frame.title = '独立内容检查'; frame.style.cssText = 'position:fixed;left:-10000px;width:800px;height:600px;visibility:hidden'
  const channel = new MessageChannel(), connectionId = crypto.randomUUID(), instanceId = 'check:' + crypto.randomUUID()
  let content = sampleState(revision.payload.stateShape, revision.payload.initialState), contentId: string | null = null
  let requestedRead = false, ready = false
  try {
    return await new Promise(resolve => {
      const finish = (result: { load: boolean; stateRoundtrip: boolean }) => { clearTimeout(timer); resolve(result) }
      const timer = setTimeout(() => finish({ load: false, stateRoundtrip: false }), 6000)
      channel.port1.onmessage = event => {
        const message = event.data
        if (message?.connectionId !== connectionId || message.instanceId !== instanceId) return
        let payload: unknown = {}, error: { code: string } | undefined
        if (message.method === 'component.ready') { ready = true; setTimeout(() => channel.port1.postMessage({ connectionId, instanceId, method: 'host.check' }), 50) }
        else if (message.method === 'workspace.read') {
          if (!allowed.has('workspace.read')) error = { code: 'capability-unavailable' }
          else { requestedRead = true; payload = { contentId, content: structuredClone(content) } }
        }
        else if (message.method === 'workspace.change') {
          if (!allowed.has('workspace.change')) error = { code: 'capability-unavailable' }
          else if (message.payload.expectedContentId !== contentId || !acceptsState(revision.payload.stateShape, message.payload.content)) error = { code: 'invalid-input' }
          else { content = structuredClone(message.payload.content); contentId = message.payload.contentId; payload = { contentId } }
        } else if (message.method === 'artifact.checked') finish({ load: ready && requestedRead && message.payload.load === true, stateRoundtrip: message.payload.stateRoundtrip === true })
        else if (message.method === 'artifact.error') finish({ load: false, stateRoundtrip: false })
        else if (message.method === 'artifact.capabilities') payload = { capabilities, readOnly: false }
        else if (message.method !== 'artifact.interaction') error = { code: 'capability-unavailable' }
        channel.port1.postMessage({ connectionId, instanceId, replyTo: message.messageId, method: message.method, payload, ...(error ? { error } : {}) })
      }
      frame.onload = () => frame.contentWindow?.postMessage(bootstrapMessage(revision, connectionId, instanceId, false), '*', [channel.port2])
      frame.src = viewUrl
      document.body.append(frame)
    })
  } finally { channel.port1.close(); channel.port2.close(); frame.remove() }
}

function sampleState(shape: StateShape, initial: unknown): unknown {
  if (shape.type === 'string') return '样例'.slice(0, shape.maxLength)
  if (shape.type === 'number') return typeof initial === 'number' ? initial : 0
  if (shape.type === 'boolean') return !initial
  if (shape.type === 'array') return Array.isArray(initial) && initial.length
    ? initial.slice(0, shape.maxItems).map(item => sampleState(shape.items, item)) : []
  const source = initial as Record<string, unknown>
  return Object.fromEntries(Object.entries(shape.properties).map(([key, child]) => [key, sampleState(child, source[key])]))
}
