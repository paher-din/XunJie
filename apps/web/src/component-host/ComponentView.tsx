import { useEffect, useRef, useState } from 'react'
import { componentBundleSchema, componentInitializeSchema, componentPreparationMessageSchema,
  componentPreparationReplySchema, type ComponentBinding } from '@xunjie/contracts/components'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useActivitySession } from '../product/ActivitySession'
import { learningRequest } from '../product/learningTransport'
import { componentPreparation, componentViewUrl, requiresPreparation, type PreparationSnapshot } from '../component-preparation/preparation'
import { componentError, createComponentBridge } from './bridge'
import './components.css'

const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map(x => x.toString(16).padStart(2, '0')).join('')

const reasonText: Record<string, string> = {
  'resource-missing': '依赖资源暂时取不到', 'resource-corrupt': '依赖资源校验未通过',
  'dependency-version-mismatch': '依赖版本与清单不符', 'dependency-load-failed': '依赖未能在组件中加载',
  'device-feature-missing': '当前浏览器缺少必需能力', 'protocol-unsupported': '当前产品未实现该准备协议',
  'budget-exceeded': '依赖超出组件声明的预算', 'storage-unavailable': '浏览器准备存储不可用',
  'permission-pending': '等待确认浏览器权限', 'self-test-failed': '组件自检未通过',
  'self-test-interrupted': '自检被中断，结果未知', 'self-test-mismatch': '自检结果与固定预期不符',
  'outcome-unknown': '准备结果未知', unsupported: '当前设备不支持该组件依赖',
}
const capabilityText: Record<string, string> = { 'workspace.read': '读取标注', 'workspace.change': '保存标注', 'material.highlight': '原文高亮' }
const stageText: Record<string, string> = {
  resolve: '解析组件声明', identity: '登记准备身份', detect: '检查浏览器能力', fetch: '取得依赖资源',
  verify: '校验依赖摘要', load: '加载依赖', 'self-test': '在独立实例自检', persist: '保存检查结果', activate: '启用已验证环境',
}
const describe = (reason: string) => reasonText[reason] ?? '准备未完成'

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
  const [preparation, setPreparation] = useState<PreparationSnapshot | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [retryIssue, setRetryIssue] = useState('')
  // One identity per mounted view: a retry continues the original preparation instead of minting a second one.
  const requestId = useRef(crypto.randomUUID())
  const preparationId = useRef<string | null>(null)
  const requestScope = useRef('')
  const allowed = useRef(authorized)
  allowed.current = authorized
  const prepared = requiresPreparation(binding)
  useEffect(() => {
    let live = true
    const target = { activity, binding, spaceKey, namespace }
    const scope = prepared ? componentPreparation.scopeKey(target) : `${namespace}:${activity.activityId}:${binding.key}`
    if (requestScope.current !== scope) {
      requestScope.current = scope; requestId.current = crypto.randomUUID(); preparationId.current = null
      setPreparation(null)
    }
    const materials: { title: string; text: string }[] = []
    let bridge: ReturnType<typeof createComponentBridge> | undefined
    let port: MessagePort | undefined
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined
    let dependencyTimer: ReturnType<typeof setTimeout> | undefined
    let dependencyRequestId: string | undefined
    let dependencies: { dependencyId: string; scriptBase64: string }[] = []
    const unsubscribe = prepared ? componentPreparation.subscribe(componentPreparation.scopeKey(target),
      snapshot => { if (live) setPreparation(snapshot) }) : () => {}
    const initialize = () => {
      if (!live || !bridge || !port) return
      const root = window.document.documentElement
      const styles = getComputedStyle(root)
      const aliases: Record<string, string> = { canvas: 'paper', hover: 'hover-bg', chip: 'chip-bg', 'on-solid': 'on-primary' }
      const theme = Object.fromEntries(['canvas', 'ink', 'ink-soft', 'muted', 'line', 'hover', 'chip', 'primary', 'on-solid', 'accent', 'accent-deep']
        .map(key => [key, styles.getPropertyValue('--' + (aliases[key] ?? key)).trim()]))
      return componentInitializeSchema.parse({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
        messageId: crypto.randomUUID(), method: 'host.initialize',
        payload: { binding, theme, materials, readOnly: !allowed.current,
          ...(prepared ? { preparation: { preparationProtocolVersion: 1, mode: 'production' as const } } : {}) } })
    }
    const failDependency = () => setPreparation(snapshot => snapshot && { ...snapshot,
      reason: 'dependency-load-failed', status: 'repairable', capabilities: snapshot.capabilities.map(item => {
        const manifest = binding.definition.manifest
        const needsDependency = manifest.formatVersion === 2 && manifest.environment.capabilityDependencies
          .some(declaration => declaration.capability === item.capability && declaration.dependencyIds.length > 0)
        return needsDependency ? { ...item, availability: 'unavailable', verification: 'failed', reason: 'dependency-load-failed' } : item
      }) })
    const retire = () => { bridge?.close(); port?.close(); clearTimeout(handshakeTimer); clearTimeout(dependencyTimer); dependencyRequestId = undefined }
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
        if (!raw || typeof raw !== 'object') return
        if ((raw as { preparationProtocolVersion?: unknown }).preparationProtocolVersion === 1) {
          // The component reports what the delivered bytes really defined; a failure costs only the gated capability.
          const reply = componentPreparationReplySchema.safeParse(raw)
          if (!reply.success || reply.data.connectionId !== mount.connectionId || reply.data.instanceId !== mount.instanceId
            || reply.data.replyTo !== dependencyRequestId) return
          clearTimeout(dependencyTimer); dependencyRequestId = undefined
          const observation = reply.data.observation
          const manifest = binding.definition.manifest
          if (reply.data.error || observation?.kind !== 'loaded'
            || !dependencies.every(dependency => observation.loaded.some(item => item.dependencyId === dependency.dependencyId))
            || (manifest.formatVersion === 2 && !manifest.selfTest.steps.every(step => step.kind !== 'dependency-loads'
              || step.dependencyIds.every(id => observation.loaded.some(item => item.dependencyId === id && item.globals.includes(step.expect.globalName)))))) failDependency()
          return
        }
        if (typeof (raw as { messageId?: unknown }).messageId !== 'string') return
        try {
          const payload = await mount.handle(raw)
          if (!live || bridge !== mount) return
          if (raw.method === 'component.ready') {
            clearTimeout(handshakeTimer); setReady(true)
            // Sent only after the view initialized, so the component never receives bytes before its connection.
            if (dependencies.length) {
              try {
                dependencyRequestId = crypto.randomUUID()
                const message = componentPreparationMessageSchema.parse({
                  preparationProtocolVersion: 1, connectionId: mount.connectionId, instanceId: mount.instanceId,
                  messageId: dependencyRequestId, request: { method: 'preparation.load', payload: { dependencies } } })
                const manifest = binding.definition.manifest
                if (manifest.formatVersion === 2 && new TextEncoder().encode(JSON.stringify(message)).byteLength > manifest.budget.messageBytes)
                  throw new Error('budget-exceeded')
                channel.port1.postMessage(message)
                dependencyTimer = setTimeout(() => {
                  if (live && bridge === mount) { dependencyRequestId = undefined; failDependency() }
                }, manifest.formatVersion === 2 ? manifest.budget.selfTestTimeoutMs : 10000)
              } catch {
                // Never degrade silently: a delivery that cannot be built is a failed capability, not a passing one.
                dependencyRequestId = undefined; failDependency()
              }
            }
          }
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
      if (prepared) {
        try {
          const result = attempt > 0 && preparationId.current
            ? await componentPreparation.resume(target, preparationId.current, requestId.current)
            : await componentPreparation.prepare(target, requestId.current)
          if (!live) return
          preparationId.current = result.preparationId
          setPreparation(result.snapshot)
          // Without an activated environment nothing mounts: a failed new version never runs in place of the old one.
          if (!result.snapshot.environmentId) return
          dependencies = await componentPreparation.dependencies(target)
        } catch {
          // Preparation could not even record its identity, so there is no snapshot to render: name the real blocker.
          if (live) setError('组件依赖准备未能开始：浏览器准备存储不可用。已有标注仍保留，可在「作品」中读取或导出后重试。')
          return
        }
      }
      if (live) setDocument(componentViewUrl(target))
    })().catch(failure => {
      if (!live) return
      setError(failure instanceof Error && failure.message.startsWith('组件') ? failure.message
        : '组件暂时无法打开。已有作品仍保留，可在「作品」中读取或导出后重试。')
    })
    return () => { live = false; retire(); loaded.current = () => {}; observer.disconnect(); unsubscribe() }
  }, [activity, binding, namespace, spaceKey, workspace, execution, authorized, prepared, attempt])
  const blocked = prepared && !!preparation && !preparation.environmentId
  const working = blocked && (preparation.status === 'preparing' || preparation.status === 'unprepared')
  const degraded = prepared && !!preparation?.environmentId
    ? preparation.capabilities.filter(item => item.availability !== 'available') : []
  const retry = () => {
    const scope = requestScope.current
    void workspace.leave().then(() => {
      if (scope !== requestScope.current) return
      setRetryIssue(''); setAttempt(value => value + 1)
    }).catch(() => {
      if (scope === requestScope.current) setRetryIssue('当前标注尚未受到本机保护，暂不能重新装入组件。请保留当前界面，可复制输入后再继续。')
    })
  }
  return <section className="component-view" aria-label={binding.configuration.title}>
    {retryIssue && <p role="alert" className="learning-error">{retryIssue}</p>}
    {error ? <p role="alert" className="learning-error">{error}</p> : <>
      {working && <p role="status" className="ws-pane-note">
        正在准备{binding.configuration.title}：{stageText[preparation.stage] ?? preparation.stage}…</p>}
      {blocked && !working && <p role="alert" className="learning-error">
        {describe(preparation.reason)}。已有标注仍保留，可在「作品」中读取或导出。
        <span className="component-view-actions">
          <button type="button" className="ws-btn ghost" onClick={retry}>按原准备身份继续</button>
        </span>
      </p>}
      {degraded.length > 0 && <p role="status" className="component-view-note">
        {degraded.map(item => `${capabilityText[item.capability] ?? item.capability}暂不可用（${describe(item.reason)}）`).join('；')}。其余已可用能力不受影响。
        <button type="button" className="ws-btn ghost" onClick={retry}>按原准备身份继续</button>
      </p>}
      {!ready && !blocked && <p role="status" className="ws-pane-note">正在打开{binding.configuration.title}…</p>}
      {document && <iframe ref={frame} onLoad={() => loaded.current()} title={binding.configuration.title} sandbox="allow-scripts" referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" src={document} />}
    </>}
  </section>
}
