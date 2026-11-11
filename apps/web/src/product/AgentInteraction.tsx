import { useCallback, useEffect, useRef, useState } from 'react'
import { SelectField } from '@xunjie/ui/foundation'
import { toast } from '@xunjie/ui/feedback'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { teachingInteractionSettingsSchema, type TeachingInteractionSettings } from '@xunjie/contracts/teaching-agent'
import type { ActionInput } from '@xunjie/contracts/action-intents'
import { Section, RadioCard } from '../components/settings/controls'
import { agentControlStore, protectAgentOperation, confirmAgentOperation, deliverAgentOperation,
  type PendingAgentOperation } from '../reliable-workspace/agent-controls'
import { learningSubjectRequest } from './learningTransport'
import { useActivitySession } from './ActivitySession'
import './agent-interaction.css'

type Mode = 'steering' | 'queue'
export function useAgentInteraction(identity: SpaceIdentity, spaceKey: string, namespace: string, writable = true, enabled = true) {
  const scope = JSON.stringify([namespace, spaceKey, identity.environmentId, identity.spaceId, identity.principalId])
  const key = JSON.stringify([scope, 'agent-settings'])
  const [settings, setSettings] = useState<TeachingInteractionSettings | null>(null)
  const [override, setOverride] = useState<Mode | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const alive = useRef(false), saving = useRef(false), current = useRef(scope), canWrite = useRef(writable)
  const channel = useRef<BroadcastChannel | null>(null), reads = useRef(0)
  canWrite.current = writable; current.current = scope
  const request = useCallback((route: string, body?: unknown) => learningSubjectRequest(identity, spaceKey, namespace, route, body), [scope])
  const deliver = useCallback(async (pending: PendingAgentOperation, notify = false) => {
    if (!alive.current || current.current !== scope || !canWrite.current || saving.current) return
    saving.current = true; setBusy(true)
    try {
      const value = await deliverAgentOperation(pending, request, raw => {
        const saved = teachingInteractionSettingsSchema.parse(raw)
        if (saved.version !== Number(pending.input.expectedVersion) + 1 || saved.busyInputMode !== pending.input.busyInputMode)
          throw new Error('交互设置回执不属于原操作。')
        return saved
      })
      await confirmAgentOperation(key, pending, value)
      if (alive.current && current.current === scope) {
        setSettings(previous => previous && previous.version > value.version ? previous : value); setError('')
        channel.current?.postMessage({ version: value.version })
      }
    } catch (cause) {
      if (['conflict', 'identity-conflict', 'invalid'].includes((cause as { code?: string }).code ?? ''))
        await agentControlStore.change(key, saved => ({ ...saved!, rejected: saved?.pending, pending: undefined }))
      if (alive.current && current.current === scope) {
        const failure = '交互设置尚未保存，原选择已保留；请重新读取后重试。'
        setError(failure); if (notify) toast.error(failure)
      }
    } finally { saving.current = false; if (alive.current && current.current === scope) setBusy(false) }
  }, [key, scope, request])
  const reload = useCallback(async () => {
    const generation = ++reads.current
    try {
      const value = teachingInteractionSettingsSchema.parse(await request('agent-settings'))
      if (alive.current && current.current === scope && generation === reads.current) {
        setSettings(value); setError('')
      }
    } catch { if (alive.current && current.current === scope) setError('交互设置暂时无法读取，问题与草稿仍保留。') }
  }, [scope, request])
  useEffect(() => {
    if (!enabled) return
    alive.current = true; current.current = scope
    setSettings(null); setOverride(null); setError('')
    void reload()
    void agentControlStore.read(key).then(saved => {
      if (alive.current && current.current === scope && saved?.scope === scope && saved.pending && canWrite.current) void deliver(saved.pending)
    }).catch(() => { if (alive.current) setError('本机操作保护暂不可用，请保留当前页面后重试。') })
    const broadcast = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('xunjie-agent-settings:' + scope)
    channel.current = broadcast
    if (broadcast) broadcast.onmessage = () => { void reload() }
    const focus = () => { void reload() }
    window.addEventListener('focus', focus)
    return () => { alive.current = false; broadcast?.close(); channel.current = null; window.removeEventListener('focus', focus) }
  }, [scope, key, reload, deliver, writable, enabled])
  const save = async (mode: Mode) => {
    if (!settings || !writable || saving.current) return
    const requestId = crypto.randomUUID()
    const pending: PendingAgentOperation = { requestId, route: 'agent-settings', queryRoute: 'agent-settings/receipts/' + requestId,
      input: { requestId, expectedVersion: settings.version, busyInputMode: mode } }
    try { await protectAgentOperation(key, scope, pending); await deliver(pending, true) }
    catch { if (alive.current) {
      const failure = '上一设置操作尚未核实，原选择仍保留。'
      setError(failure); toast.error(failure)
    } }
  }
  const reset = useCallback(() => setOverride(null), [])
  const mode = override ?? settings?.busyInputMode ?? 'steering'
  const delivery: ActionInput['delivery'] = settings ? { version: 1, mode,
    basis: { source: override === null ? 'preference' : 'explicit', preferenceVersion: settings.version } } : undefined
  return { settings, mode, delivery, ready: !!settings, busy, error, writable, save, reload, reset, choose: setOverride }
}
export type AgentInteractionController = ReturnType<typeof useAgentInteraction>

export function AgentInteractionSettings({ controller }: { controller: AgentInteractionController }) {
  return <Section title="运行中发送方式" desc="设置在 Agent 执行期间发送的新输入默认引导或排队。">
    {controller.settings ? <RadioCard<Mode> ariaLabel="忙碌时发送的默认方式" value={controller.settings.busyInputMode}
      onChange={mode => void controller.save(mode)} options={[
        { value: 'steering', title: '引导当前任务', desc: '在下一步纳入补充，已开始的操作保留真实状态。', disabled: controller.busy || !controller.writable },
        { value: 'queue', title: '排队处理', desc: '完整一轮正常结束后，按接收顺序处理。', disabled: controller.busy || !controller.writable },
      ]} /> : <p role="status" className="detail">正在读取交互设置…</p>}
    {controller.busy && <p role="status" className="detail">正在保存交互设置…</p>}
    {controller.error && <p role="alert" className="learning-error">{controller.error}</p>}
    {controller.error && <button className="outline" type="button" onClick={() => void controller.reload()}>重新读取交互设置</button>}
  </Section>
}

export function AgentInputMode({ active }: { active: boolean }) {
  const { inputInteraction: controller } = useActivitySession()
  return <div className="agent-input-mode">
    <label>本次发送方式<SelectField label="本次发送方式" value={controller.mode} disabled={!controller.ready || !controller.writable}
      onChange={value => controller.choose(value as Mode)}
      options={[{ value: 'steering', label: '引导当前任务' }, { value: 'queue', label: '本轮结束后处理' }]} /></label>
    <p className="detail">{active ? controller.mode === 'queue' ? '完整一轮结束后处理；等待结果期间继续排队。'
      : '收到后会在下一步纳入；已开始的操作保留实际状态。' : '当前可以开始新的学习请求。'}</p>
    {controller.error && <p role="alert" className="learning-error">{controller.error}</p>}
  </div>
}
