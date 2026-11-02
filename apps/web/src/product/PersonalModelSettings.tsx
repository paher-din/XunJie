import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { modelAttemptSchema, modelConnectionSchema, type ModelAttempt, type ModelConnection, type ModelCheckInput, type SaveModelConnection } from '@xunjie/contracts/model-connections'
import { ModelTab } from '../components/settings/ModelTab'
import { ModelConnectionDialog } from '../components/settings/ModelConnectionDialog'
import { z } from 'zod'

const failures: Record<string, string> = { conflict: '配置已被更新，当前输入保留，请核对后重新读取。', 'identity-conflict': '原检查身份与内容冲突，请查询原记录。',
  forbidden: '原空间资格已失效，请重新登录原空间。', 'resource-busy': '检查频次或并发已达上限，请保留原检查记录并稍后再试。',
  unavailable: '连接或相应适配器不可用，请检查配置。', invalid: '请检查地址、协议、模型及密钥填写。', maintenance: '模型服务正在维护，请稍后重试。' }
export function PersonalModelSettings({ identity, spaceKey, namespace, onBack }: {
  identity: SpaceIdentity; spaceKey: string; namespace: string; onBack(): void
}) {
  const [connections, setConnections] = useState<ModelConnection[]>([]), [attempts, setAttempts] = useState<ModelAttempt[]>([])
  const [dialog, setDialog] = useState<{ connection: ModelConnection | null } | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  const request = useCallback(async (route: string, body?: unknown) => {
    const response = await fetch('/api/learning/models/' + route, { method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(35000),
      headers: { 'content-type': 'application/json', 'x-xj-space': spaceKey, 'x-xj-namespace': namespace,
        'x-xj-expected-subject': [identity.environmentId, identity.spaceId, identity.principalId].join('.') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json()
    if (!response.ok) throw new Error(failures[result.error] ?? '原请求结果尚未确认，请查询检查记录。')
    return result as unknown
  }, [identity.environmentId, identity.spaceId, identity.principalId, spaceKey, namespace])
  const reload = useCallback(async (visible = false) => {
    if (visible) setLoading(true)
    try {
      const [configurations, checks] = await Promise.all([request('connections'), request('checks')])
      if (!live.current) return
      setConnections(z.array(modelConnectionSchema).parse(configurations)); setAttempts(z.array(modelAttemptSchema).parse(checks)); setError('')
    } catch (error) { if (live.current) setError(error instanceof Error ? error.message : '暂时无法读取原配置。') }
    finally { if (live.current && visible) setLoading(false) }
  }, [request])
  useEffect(() => { void reload(true); const timer = setInterval(() => { void reload() }, 1000); return () => clearInterval(timer) }, [reload])
  const check = async (source: ModelCheckInput['source']) => {
    const attemptId = crypto.randomUUID()
    const accepted = modelAttemptSchema.parse(await request('checks', { attemptId, purpose: 'connection-check', source,
      limits: { maxOutputTokens: 64, timeoutMs: 20000 } }))
    if (live.current) setAttempts(previous => [accepted, ...previous.filter(item => item.attemptId !== attemptId)])
    const result = modelAttemptSchema.parse(await request('checks/' + attemptId + '/dispatch', {}))
    if (live.current) setAttempts(previous => [result, ...previous.filter(item => item.attemptId !== attemptId)])
    return result
  }
  const act = async (task: () => Promise<unknown>) => {
    try { await task() } catch (error) { if (live.current) setError(error instanceof Error ? error.message : '操作结果尚未确认。') }
  }
  const cancel = async (attempt: ModelAttempt) => { await request('checks/' + attempt.attemptId + '/cancel', {}); await reload() }
  const save = async (input: Omit<SaveModelConnection, 'requestId'>) => {
    modelConnectionSchema.parse(await request('connections', { ...input, requestId: crypto.randomUUID() }))
    await reload()
  }
  return <div className="content product-model-settings">
    <div className="sectionhead"><h1>个人模型设置</h1><button type="button" className="outline" onClick={onBack}>返回学习空间</button></div>
    <div className="st-body-in"><ModelTab connections={connections} attempts={attempts} loading={loading} error={error}
      onReload={() => void reload(true)} onNew={() => setDialog({ connection: null })} onEdit={connection => setDialog({ connection })}
      onCheck={connection => void act(() => check({ connectionId: connection.connectionId, version: connection.version }))}
      onCancel={attempt => void act(() => cancel(attempt))} /></div>
    {dialog && <ModelConnectionDialog connection={dialog.connection} attempts={attempts} onClose={() => setDialog(null)} onSave={save} onCheck={check} onCancel={cancel} />}
  </div>
}
