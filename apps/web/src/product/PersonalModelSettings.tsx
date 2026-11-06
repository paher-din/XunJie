import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { modelAttemptSchema, modelConnectionSchema, type ModelAttempt, type ModelConnection, type ModelCheckInput, type SaveModelConnection } from '@xunjie/contracts/model-connections'
import { teachingModelSwitchSchema } from '@xunjie/contracts/teaching-agent'
import { ModelTab } from '../components/settings/ModelTab'
import { ModelConnectionDialog } from '../components/settings/ModelConnectionDialog'
import { z } from 'zod'
import { ModelSelection, type ModelSelectionController } from './ModelSelection'
import { AgentInteractionSettings, useAgentInteraction } from './AgentInteraction'

const failures: Record<string, string> = { conflict: '配置已被更新，当前输入保留，请核对后重新读取。', 'identity-conflict': '原检查身份与内容冲突，请查询原记录。',
  forbidden: '原空间资格已失效，请重新登录原空间。', 'resource-busy': '检查频次或并发已达上限，请保留原检查记录并稍后再试。',
  unavailable: '连接或相应适配器不可用，请检查配置。', invalid: '请检查地址、协议、模型及密钥填写。', maintenance: '模型服务正在维护，请稍后重试。' }
type PersonalModelSettingsProps = {
  identity: SpaceIdentity; spaceKey: string; namespace: string; onBack(): void; selection: ModelSelectionController; readOnly?: boolean
  activityId?: string
}
export function PersonalModelSettings(props: PersonalModelSettingsProps) {
  const { identity, namespace, spaceKey } = props
  // A subject change must discard old drafts, errors and late async responses together.
  return <PersonalModelSettingsBody key={JSON.stringify([namespace, spaceKey, identity.environmentId, identity.spaceId, identity.principalId])} {...props} />
}
function PersonalModelSettingsBody({ identity, spaceKey, namespace, onBack, selection, activityId, readOnly = false }: PersonalModelSettingsProps) {
  const interaction = useAgentInteraction(identity, spaceKey, namespace, !readOnly)
  const [connections, setConnections] = useState<ModelConnection[]>([]), [attempts, setAttempts] = useState<ModelAttempt[]>([])
  const [dialog, setDialog] = useState<{ connection: ModelConnection | null } | null>(null)
  const [loading, setLoading] = useState(false), [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState<{ key: string; message: string } | null>(null)
  const [switchStatus, setSwitchStatus] = useState('')
  const [switchFailed, setSwitchFailed] = useState(false)
  const actions = useRef(new Map<string, number>())
  const reads = useRef(0)
  // Pending polls must not prevent a completed read from publishing.
  const appliedRead = useRef(0)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const request = useCallback(async (route: string, body?: unknown) => {
    const path = route.startsWith('../') ? '/api/learning/' + route.slice(3) : '/api/learning/models/' + route
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(35000),
      headers: { 'content-type': 'application/json', 'x-xj-space': spaceKey, 'x-xj-namespace': namespace,
        'x-xj-expected-subject': [identity.environmentId, identity.spaceId, identity.principalId].join('.') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json()
    if (!response.ok) throw Object.assign(new Error(failures[result.error] ?? '原请求结果尚未确认，请查询检查记录。'), { code: result.error })
    return result as unknown
  }, [identity.environmentId, identity.spaceId, identity.principalId, spaceKey, namespace])
  const reload = useCallback(async (visible = false) => {
    const generation = ++reads.current
    if (visible) setLoading(true)
    try {
      const [configurations, checks] = await Promise.all([request('connections'), request('checks')])
      if (!live.current || generation < appliedRead.current) return
      appliedRead.current = generation
      setConnections(z.array(modelConnectionSchema).parse(configurations)); setAttempts(z.array(modelAttemptSchema).parse(checks)); setLoadError('')
    } catch (error) {
      if (live.current && generation >= appliedRead.current) {
        appliedRead.current = generation
        setLoadError(error instanceof Error ? error.message : '暂时无法读取原配置。')
      }
    }
    finally { if (live.current && visible) setLoading(false) }
  }, [request])
  useEffect(() => { void reload(true); const timer = setInterval(() => { void reload() }, 1000); return () => clearInterval(timer) }, [reload])
  const check = async (source: ModelCheckInput['source']) => {
    const attemptId = crypto.randomUUID()
    const accepted = modelAttemptSchema.parse(await request('checks', { attemptId, purpose: 'connection-check', source,
      limits: { maxOutputTokens: 64, timeoutMs: 20000 } }))
    if (!live.current) return accepted
    setAttempts(previous => [accepted, ...previous.filter(item => item.attemptId !== attemptId)])
    const result = modelAttemptSchema.parse(await request('checks/' + attemptId + '/dispatch', {}))
    if (live.current) setAttempts(previous => [result, ...previous.filter(item => item.attemptId !== attemptId)])
    return result
  }
  const act = async (key: string, label: string, task: () => Promise<unknown>) => {
    const generation = (actions.current.get(key) ?? 0) + 1
    actions.current.set(key, generation)
    try {
      await task()
      if (live.current && actions.current.get(key) === generation) setActionError(previous => previous?.key === key ? null : previous)
    } catch (error) {
      if (live.current && actions.current.get(key) === generation)
        setActionError({ key, message: label + '：' + (error instanceof Error ? error.message : '操作结果尚未确认。') })
    }
  }
  const cancel = async (attempt: ModelAttempt) => { await request('checks/' + attempt.attemptId + '/cancel', {}); await reload() }
  const readConnection = async (connectionId: string) => {
    const generation = ++reads.current
    const configurations = z.array(modelConnectionSchema).parse(await request('connections'))
    if (live.current && generation >= appliedRead.current) {
      appliedRead.current = generation
      setConnections(configurations)
    }
    return configurations.find(item => item.connectionId === connectionId) ?? null
  }
  const save = async (input: SaveModelConnection) => {
    const saved = modelConnectionSchema.parse(await request('connections', input))
    // The POST receipt is authoritative; a subsequent read failure cannot undo it.
    if (live.current) {
      // Invalidate every read started before this receipt, including explicit reads.
      appliedRead.current = ++reads.current
      setConnections(previous => previous.some(item => item.connectionId === saved.connectionId)
        ? previous.map(item => item.connectionId === saved.connectionId ? saved : item) : [saved, ...previous])
      void reload()
      void selection.reload().catch(() => {})
    }
    return saved
  }
  const switchConversation = async (selectionVersion: number) => {
    if (!activityId) return
    setSwitchFailed(false)
    setSwitchStatus('正在核对原回答与工具边界…')
    try {
      const result = teachingModelSwitchSchema.parse(await request(`../agent/${activityId}/model-switches`, {
        requestId: crypto.randomUUID(), selectionVersion }))
      setSwitchFailed(result.state !== 'completed' && result.reason !== 'segment-busy')
      setSwitchStatus(result.state === 'completed'
        ? `已为当前学习活动切换到「${result.model.modelId}」。已有消息和结果保留原出处。`
        : result.reason === 'segment-busy'
          ? '当前回答或工具仍在收尾；切换请求已保留，完成后将继续核对。'
          : '切换尚未完成；原模型边界和草稿已保留，没有自动回退到其他模型。')
    } catch (error) {
      setSwitchFailed(true)
      setSwitchStatus(error instanceof Error ? `切换结果尚未确认：${error.message}` : '切换结果尚未确认；请重新读取后重试。')
    }
  }
  return <div className="content product-model-settings">
    <div className="sectionhead"><h1>个人模型设置</h1><button type="button" className="outline" onClick={onBack}>返回学习空间</button></div>
    <div className="st-body-in"><AgentInteractionSettings controller={interaction} />
      <ModelSelection controller={selection}
      onSelected={saved => switchConversation(saved.version)}
      onCheck={() => void act('selected', '检查当前模型', () => check({ selected: true, selectionVersion: selection.selection!.version }))} />
      {activityId && <p role={switchFailed ? 'alert' : 'status'} className={switchFailed ? 'learning-error' : 'detail'}>{switchStatus || '从当前学习活动进入设置；新选用会在原调用和工具结清后继续此活动。'}</p>}
      <div role="region" aria-label="个人连接配置"><ModelTab connections={connections} attempts={attempts} loading={loading} error={[loadError, actionError?.message].filter(Boolean).join('；')}
      onReload={() => void reload(true)} onNew={() => setDialog({ connection: null })} onEdit={connection => setDialog({ connection })}
      onCheck={connection => void act('check:' + connection.connectionId, '检查「' + connection.name + '」', () => check({ connectionId: connection.connectionId, version: connection.version }))}
      onCancel={attempt => void act('cancel:' + attempt.attemptId, '停止「' + attempt.connection.name + '」检查', () => cancel(attempt))} /></div></div>
    {dialog && <ModelConnectionDialog connection={dialog.connection} attempts={attempts} onClose={() => setDialog(null)} onSave={save} onRead={readConnection} onCheck={check} onCancel={cancel} />}
  </div>
}
