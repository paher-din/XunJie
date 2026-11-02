import { useEffect, useRef, useState } from 'react'
import { componentBundleSchema, type ComponentBinding } from '@xunjie/contracts/components'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useActivitySession } from '../product/ActivitySession'
import { learningRequest } from '../product/learningTransport'
import { componentError, createComponentBridge } from './bridge'
import './components.css'

const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map(x => x.toString(16).padStart(2, '0')).join('')

/** Imported code has an opaque origin, no credentials or direct resource URLs, and a fixed bounded capability. */
export function ComponentView({ activity, binding, spaceKey, namespace, authorized }: {
  activity: LearningActivity; binding: ComponentBinding; spaceKey: string; namespace: string; authorized: boolean
}) {
  const { workspace, execution } = useActivitySession()
  const frame = useRef<HTMLIFrameElement>(null)
  const loaded = useRef<() => void>(() => {})
  const [document, setDocument] = useState('')
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const allowed = useRef(authorized)
  allowed.current = authorized
  useEffect(() => {
    let live = true
    const materials: { title: string; text: string }[] = []
    let bridge: ReturnType<typeof createComponentBridge> | undefined
    let port: MessagePort | undefined
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined
    const initialize = () => {
      if (!live || !bridge || !port) return
      const root = window.document.documentElement
      const styles = getComputedStyle(root)
      const aliases: Record<string, string> = { canvas: 'paper', hover: 'hover-bg', chip: 'chip-bg', 'on-solid': 'on-primary' }
      const theme = Object.fromEntries(['canvas', 'ink', 'ink-soft', 'muted', 'line', 'hover', 'chip', 'primary', 'on-solid', 'accent', 'accent-deep']
        .map(key => [key, styles.getPropertyValue('--' + (aliases[key] ?? key)).trim()]))
      return { hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
        messageId: crypto.randomUUID(), method: 'host.initialize', payload: { binding, theme, materials, readOnly: !allowed.current } }
    }
    const retire = () => { bridge?.close(); port?.close(); clearTimeout(handshakeTimer) }
    loaded.current = () => {
      if (!live || !frame.current?.contentWindow) return
      retire()
      const mount = createComponentBridge(workspace, activity.activityId, binding,
        () => live && allowed.current && !workspace.accessDenied(),
        { controller: execution, canRun: () => live && allowed.current && !workspace.accessDenied() && authorized })
      const channel = new MessageChannel()
      bridge = mount; port = channel.port1
      setReady(false); setError('')
      // A port is bound to this document, unlike the WindowProxy, which survives iframe navigation.
      channel.port1.onmessage = async (event: MessageEvent) => {
        if (!live || bridge !== mount) return
        const raw = event.data
        if (!raw || typeof raw !== 'object' || typeof raw.messageId !== 'string') return
        try {
          const payload = await mount.handle(raw)
          if (!live || bridge !== mount) return
          if (raw.method === 'component.ready') { clearTimeout(handshakeTimer); setReady(true) }
          channel.port1.postMessage({ hostApiVersion: 1, connectionId: mount.connectionId, instanceId: mount.instanceId,
            replyTo: raw.messageId, payload })
        } catch (failure) {
          if (!live || bridge !== mount) return
          channel.port1.postMessage({ hostApiVersion: 1, connectionId: mount.connectionId, instanceId: mount.instanceId,
            replyTo: raw.messageId, error: componentError(failure) })
        }
      }
      frame.current.contentWindow.postMessage(initialize(), '*', [channel.port2])
      handshakeTimer = setTimeout(() => {
        if (live && bridge === mount) { retire(); setError('组件未能完成连接。已有作品仍保留，请切换回「作品」核对后重新打开。') }
      }, 10000)
    }
    const observer = new MutationObserver(() => { const message = initialize(); if (message) port?.postMessage(message) })
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
    return () => { live = false; retire(); loaded.current = () => {}; observer.disconnect() }
  }, [activity, binding, namespace, spaceKey, workspace, execution, authorized])
  return <section className="component-view" aria-label={binding.configuration.title}>
    {error ? <p role="alert" className="learning-error">{error}</p> : <>
      {!ready && <p role="status" className="ws-pane-note">正在打开{binding.configuration.title}…</p>}
      {document && <iframe ref={frame} onLoad={() => loaded.current()} title={binding.configuration.title} sandbox="allow-scripts" referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" src={document} />}
    </>}
  </section>
}
