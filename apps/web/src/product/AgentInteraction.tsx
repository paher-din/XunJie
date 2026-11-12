import { useCallback, useEffect, useRef, useState } from 'react'
import { SelectField } from '@xunjie/ui/foundation'
import { toast } from '@xunjie/ui/feedback'
import { SettingsStatus } from '@xunjie/ui/settings'
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
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('')
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
      if (notify) toast.success('发送方式已保存')
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
    if (alive.current && current.current === scope) setLoading(true)
    try {
      const value = teachingInteractionSettingsSchema.parse(await request('agent-settings'))
      if (alive.current && current.current === scope && generation === reads.current) {
        setSettings(value); setError('')
      }
    } catch { if (alive.current && current.current === scope) setError('交互设置暂时无法读取，问题与草稿仍保留。') }
    finally {
      if (alive.current && current.current === scope && generation === reads.current) setLoading(false)
    }
  }, [scope, request])
  useEffect(() => {
    if (!enabled) { setLoading(false); return }
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
  return { settings, mode, delivery, ready: !!settings, loading, busy, error, writable, save, reload, reset, choose: setOverride }
}
export type AgentInteractionController = ReturnType<typeof useAgentInteraction>

export function AgentInteractionSettings({ controller }: { controller: AgentInteractionController }) {
  const [pendingMode, setPendingMode] = useState<Mode | null>(null)
  const selectMode = async (mode: Mode) => {
    if (pendingMode || controller.busy || mode === controller.settings?.busyInputMode) return
    setPendingMode(mode)
    try { await controller.save(mode) } finally { setPendingMode(null) }
  }
  return <Section title="运行中发送方式" desc="Agent 正在执行时，新输入默认如何进入当前工作。">
    <div className="agent-interaction-settings">
      {!controller.writable && <SettingsStatus tone="neutral" title="当前学习空间为只读"
        description="已有发送方式仍会显示；当前副本不能修改它。" />}
      {!controller.settings && !controller.error && <SettingsStatus tone="loading" title="正在读取发送方式"
        description="问题、草稿和正在进行的操作不会改变。" />}
      {!controller.settings && controller.error && <SettingsStatus tone="error" title="发送方式暂时无法读取"
        description={controller.error} action={<button type="button" className="outline" disabled={controller.loading}
          aria-busy={controller.loading || undefined} onClick={() => void controller.reload()}>
          {controller.loading ? '正在重新读取…' : '重新读取'}
        </button>} />}
      {controller.settings && <>
        {controller.loading && !pendingMode && <SettingsStatus tone="loading" title="正在重新读取发送方式"
          description="当前选择会保留，读取完成后再更新。" />}
        <RadioCard<Mode> ariaLabel="忙碌时发送的默认方式" value={pendingMode ?? controller.settings.busyInputMode}
          onChange={mode => void selectMode(mode)} options={[
            { value: 'steering', title: '引导当前任务', desc: '在下一步开始前纳入补充；已经开始的操作不会被撤回。', disabled: !!pendingMode || controller.busy || !controller.writable },
            { value: 'queue', title: '排队处理', desc: '等这一轮正常结束后，再按发送顺序处理。', disabled: !!pendingMode || controller.busy || !controller.writable },
          ]} />
        {pendingMode && <SettingsStatus tone="loading" title="正在保存发送方式"
          description="保存成功前保留当前选择；失败时恢复原设置并说明原因。" />}
        {controller.busy && !pendingMode && <SettingsStatus tone="loading" title="正在确认上次设置"
          description="会沿原操作恢复结果；当前选择不会先被改写。" />}
        {controller.error && <SettingsStatus tone="error" title="发送方式尚未保存"
          description={controller.error} action={<button type="button" className="outline"
            disabled={controller.loading || controller.busy} aria-busy={controller.loading || undefined}
            onClick={() => void controller.reload()}>{controller.loading ? '正在重新读取…' : '重新读取'}</button>} />}
      </>}
    </div>
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
