import { useEffect, useRef, useState } from 'react'
import { componentBundleSchema, type ComponentBinding } from '@xunjie/contracts/components'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useActivitySession } from '../product/ActivitySession'
import { learningRequest } from '../product/learningTransport'
import { createComponentBridge } from './bridge'
import './components.css'

const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map(x => x.toString(16).padStart(2, '0')).join('')

/** Imported code has an opaque origin, no credentials or direct resource URLs, and a fixed bounded capability. */
export function ComponentView({ activity, binding, spaceKey, namespace, authorized }: {
  activity: LearningActivity; binding: ComponentBinding; spaceKey: string; namespace: string; authorized: boolean
}) {
  const { workspace } = useActivitySession()
  const frame = useRef<HTMLIFrameElement>(null)
  const [document, setDocument] = useState('')
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const allowed = useRef(authorized)
  allowed.current = authorized
  useEffect(() => {
    let live = true
    const materials: { title: string; text: string }[] = []
    const bridge = createComponentBridge(workspace, activity.activityId, binding, () => live && allowed.current && !workspace.accessDenied())
    const initialize = () => {
      if (!live) return
      const root = window.document.documentElement
      const styles = getComputedStyle(root)
      const aliases: Record<string, string> = { canvas: 'paper', hover: 'hover-bg', chip: 'chip-bg', 'on-solid': 'on-primary' }
      const theme = Object.fromEntries(['canvas', 'ink', 'ink-soft', 'muted', 'line', 'hover', 'chip', 'primary', 'on-solid', 'accent', 'accent-deep']
        .map(key => [key, styles.getPropertyValue('--' + (aliases[key] ?? key)).trim()]))
      frame.current?.contentWindow?.postMessage({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
        messageId: crypto.randomUUID(), method: 'host.initialize', payload: { binding, theme, materials, readOnly: !allowed.current } }, '*')
    }
    const message = async (event: MessageEvent) => {
      if (!live || event.source !== frame.current?.contentWindow || event.origin !== 'null') return
      // A freshly loaded opaque frame requests initialization without claiming any instance authority.
      if (event.data?.method === 'component.hello') { initialize(); return }
      const raw = event.data
      if (!raw || typeof raw !== 'object' || typeof raw.messageId !== 'string') return
      try {
        const payload = await bridge.handle(raw)
        if (!live) return
        if (raw.method === 'component.ready') setReady(true)
        frame.current?.contentWindow?.postMessage({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
          replyTo: raw.messageId, payload }, '*')
      } catch (failure) {
        if (!live) return
        const code = failure instanceof Error && ['stale-connection', 'conflict', 'capability-unavailable', 'invalid-input', 'unsupported-version'].includes(failure.message)
          ? failure.message : 'resource-unavailable'
        frame.current?.contentWindow?.postMessage({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
          replyTo: raw.messageId, error: { code, next: '保留当前内容，可在作品中导出并重新打开核对。' } }, '*')
      }
    }
    window.addEventListener('message', message)
    const observer = new MutationObserver(initialize)
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    setDocument(''); setError(''); setReady(false)
    void (async () => {
      const bundle = componentBundleSchema.parse(await learningRequest(activity, spaceKey, namespace,
        `releases/${activity.course!.releaseId}/components/${binding.key}`))
      const text = new TextEncoder().encode(JSON.stringify(bundle.definition.manifest))
      if (bundle.definition.digest !== binding.definition.digest || await hash(text) !== binding.definition.digest) throw new Error('组件版本校验未通过。')
      const bytes = Uint8Array.from(atob(bundle.contentBase64), value => value.charCodeAt(0))
      if (bytes.length !== binding.definition.manifest.entry.byteLength || await hash(bytes) !== binding.definition.manifest.entry.sha256) throw new Error('组件资源校验未通过。')
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      for (const id of binding.materialIds) {
        const material = await learningRequest(activity, spaceKey, namespace, `releases/${activity.course!.releaseId}/materials/${id}`) as { title: string; contentBase64: string; sha256: string }
        const expected = activity.course!.materials.find(item => item.materialId === id)
        const content = Uint8Array.from(atob(material.contentBase64), char => char.charCodeAt(0))
        if (!expected || content.length !== expected.byteLength || await hash(content) !== expected.sha256) throw new Error('resource-unavailable')
        materials.push({ title: expected.title, text: new TextDecoder('utf-8', { fatal: true }).decode(content) })
      }
      const query = new URLSearchParams({ space: spaceKey, digest: binding.definition.digest,
        subject: [activity.identity.environmentId, activity.identity.spaceId, activity.identity.principalId].join('.') })
      if (live) setDocument(`/api/learning/releases/${activity.course!.releaseId}/components/${binding.key}/view?${query}`)
    })().catch(() => { if (live) setError('组件暂时无法打开。已有作品仍保留，可在「作品」中读取或导出后重试。') })
    return () => { live = false; bridge.close(); observer.disconnect(); window.removeEventListener('message', message) }
  }, [activity, binding, namespace, spaceKey, workspace])
  return <section className="component-view" aria-label={binding.configuration.title}>
    {error ? <p role="alert" className="learning-error">{error}</p> : <>
      {!ready && <p role="status" className="ws-pane-note">正在打开{binding.configuration.title}…</p>}
      {document && <iframe ref={frame} title={binding.configuration.title} sandbox="allow-scripts" referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" src={document} />}
    </>}
  </section>
}
