import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { modelSelectionSchema, modelGrantSchema } from '@xunjie/contracts/model-connections'
import type { z } from 'zod'
import { ModelProviderCard } from '../components/settings/ModelProviderCard'
import { Section } from '../components/settings/controls'

type Selection = z.infer<typeof modelSelectionSchema>
type Choice = Selection['options'][number]
const errors: Record<string, string> = { forbidden: '当前空间资格或模型授权已失效，请重新核对。', conflict: '选用记录已变化，请重新读取后选择。',
  unavailable: '原模型服务暂时不可用，请稍后重新读取。', maintenance: '模型服务正在维护，请稍后重试。' }
const failure = (error: unknown) => error instanceof Error ? error.message : '选用结果尚未确认，请重新读取。'
const choiceKey = (choice: Choice) => choice.kind + ':' + choice.connection.connectionId
export function useModelSelection(identity: SpaceIdentity | undefined, spaceKey: string, namespace: string) {
  const scope = identity ? [namespace, spaceKey, identity.environmentId, identity.spaceId, identity.principalId].join('.') : ''
  const [state, setState] = useState<{ scope: string; selection: Selection | null; error: string; busy: boolean }>({ scope: '', selection: null, error: '', busy: false })
  const current = useRef(scope), epoch = useRef(0)
  const pending = useRef(new Map<string, { grant?: { requestId: string; grantId: string; connectionId: string; owner: 'device' | 'self' };
    select?: { requestId: string; expectedVersion: number; source: { kind: 'school'; connectionId: string } | { kind: 'personal'; connectionId: string; grantId: string } } }>())
  current.current = scope
  const request = useCallback(async (route: string, body?: unknown) => {
    const response = await fetch('/api/learning/models/' + route, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json',
        'x-xj-space': spaceKey, 'x-xj-namespace': namespace, 'x-xj-expected-subject': identity ? [identity.environmentId, identity.spaceId, identity.principalId].join('.') : '' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json()
    if (!response.ok) throw Object.assign(new Error(errors[result.error] ?? '选用结果尚未确认，请重新读取。'), { code: result.error })
    return result as unknown
  }, [scope])
  const reload = useCallback(async () => {
    if (!scope) return
    const generation = ++epoch.current
    try {
      const selection = modelSelectionSchema.parse(await request('selection'))
      if (current.current === scope && generation === epoch.current) setState(previous => ({ scope, selection, busy: previous.scope === scope && previous.busy, error: '' }))
    } catch (error) {
      if (current.current === scope && generation === epoch.current) setState(previous => ({ scope, selection: previous.scope === scope ? previous.selection : null, busy: false, error: failure(error) }))
    }
  }, [scope, request])
  useEffect(() => {
    void reload(); const focus = () => void reload(); window.addEventListener('focus', focus)
    return () => { ++epoch.current; window.removeEventListener('focus', focus) }
  }, [reload])
  async function act(operation: () => Promise<void>) {
    if (!scope || current.current !== scope || state.scope !== scope || state.busy || !state.selection) return
    ++epoch.current
    setState(previous => ({ ...previous, busy: true, error: '' }))
    try { await operation(); if (current.current === scope) await reload() }
    catch (error) { if (current.current === scope) setState(previous => ({ ...previous, error: failure(error) })) }
    finally { if (current.current === scope) setState(previous => ({ ...previous, busy: false })) }
  }
  const choose = (choice: Choice) => act(async () => {
    const operationKey = scope + ':' + choiceKey(choice), operation = pending.current.get(operationKey) ?? {}
    pending.current.set(operationKey, operation)
    let grantId = choice.kind === 'personal' ? choice.grantId : undefined
    if (choice.kind === 'personal' && !grantId) {
      operation.grant ??= { requestId: crypto.randomUUID(), grantId: crypto.randomUUID(), connectionId: choice.connection.connectionId, owner: choice.origin === 'device' ? 'device' : 'self' }
      grantId = modelGrantSchema.parse(await request('grants', operation.grant)).grantId
    }
    operation.select ??= { requestId: crypto.randomUUID(), expectedVersion: state.selection!.version, source: choice.kind === 'school'
      ? { kind: 'school', connectionId: choice.connection.connectionId } : { kind: 'personal', connectionId: choice.connection.connectionId, grantId: grantId! } }
    try { await request('selection', operation.select) }
    catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'conflict' || code === 'identity-conflict') delete operation.select
      else if (code === 'forbidden' || code === 'invalid' || code === 'missing') pending.current.delete(operationKey)
      throw error
    }
    pending.current.delete(operationKey)
  })
  const revoke = (choice: Choice) => act(async () => {
    if (choice.kind !== 'personal' || !choice.grantId) return
    await request('grants/' + choice.grantId + '/revoke', { requestId: crypto.randomUUID(), expectedVersion: 1 })
  })
  return { selection: state.scope === scope ? state.selection : null, error: state.scope === scope ? state.error : '',
    busy: state.scope === scope && state.busy, reload, choose, revoke }
}
export type ModelSelectionController = ReturnType<typeof useModelSelection>
export function ModelSelection({ controller, onCheck }: { controller: ModelSelectionController; onCheck(): void }) {
  const { selection, error, busy, choose, revoke } = controller
  const options = new Map<string, Choice>()
  for (const option of selection?.options ?? []) {
    const prior = options.get(choiceKey(option))
    if (!prior || option.kind === 'personal' && option.grantId) options.set(choiceKey(option), option)
  }
  const selected = selection?.selected
  const capabilities = { unknown: '尚未验证', declared: '服务声明', verified: '已验证', unsupported: '不支持' }
  return <div role="region" aria-label="当前空间模型"><Section title="当前空间模型">
    {error && <p role="alert">{error}</p>}
    <p role="status">{selection?.unavailableReason === 'grant-revoked' ? '原授权已撤销，请重新选用模型。'
      : selected ? selected.kind === 'school' ? '使用学校额度' : '使用个人费用' : selection ? '未选用模型' : '正在读取当前模型…'}</p>
    <p className="detail">个人连接需为这个空间明确授权；未选模型仍可编辑活动和保留问题。</p>
    {[...options.values()].map(choice => {
      const active = !!selected && choiceKey(selected) === choiceKey(choice)
      const usable = choice.connection.enabled && choice.connection.hasCredential && choice.connection.adapterState === 'ready'
      return <ModelProviderCard key={choiceKey(choice)} name={choice.connection.name} address={choice.connection.baseUrl}
        actions={<button type="button" className="outline st-xs" disabled={busy || active || !usable}
          onClick={() => void choose(choice)}>{active ? '当前选用' : choice.kind === 'school' || choice.grantId ? '选用' : '授权并选用'}</button>}>
        <p className="detail">{choice.kind === 'school' ? '学校提供' : choice.origin === 'device' ? '本机持有的个人连接' : '个人连接'} · {choice.connection.modelId}</p>
        <p className="detail">文字：{capabilities[choice.connection.capabilities.text]} · 图片：{capabilities[choice.connection.capabilities.images]} · 工具：{capabilities[choice.connection.capabilities.tools]}</p>
        <details><summary>能力验证范围</summary>
          <p className="detail">JSON 模式：{capabilities[choice.connection.capabilities.jsonMode ?? 'unknown']} · 应用校验：{capabilities[choice.connection.capabilities.applicationSchema ?? 'unknown']} · 原生 strict：{capabilities[choice.connection.capabilities.strictSchema]} · 原生续接：{capabilities[choice.connection.capabilities.nativeReplay ?? 'unknown']}</p>
          {choice.connection.capabilityEvidence && <p className="detail">{choice.connection.capabilityEvidence.observedAt} 的固定路线证据；{choice.connection.capabilityEvidence.testedToolChoice === 'auto' ? '工具选择为 auto。' : choice.connection.capabilityEvidence.testedToolChoice === 'named' ? '已测试具名工具声明；完整往返按能力项判断。' : '工具调用未测试。'}{({
            'paired-text-adjacent-user-image': '图片结果通过配对文本和相邻用户图片发送。',
            'native-function-output-image': '图片结果位于原生 function_call_output 中。',
            'native-tool-result-image': '图片结果位于原生 tool_result 中。',
            'not-applicable': '模型目录未声明此协议支持。',
          } as const)[choice.connection.capabilityEvidence.toolImageStrategy]}</p>}
        </details>
        {!usable && <p className="detail">{!choice.connection.enabled ? '连接已停用' : !choice.connection.hasCredential ? '尚未保存密钥' : choice.connection.capabilities.text === 'unsupported' ? '该目标路线不支持所选协议' : '当前协议、地址或型号组合不可用'}</p>}
        {active && choice.kind === 'personal' && choice.grantId && <button type="button" className="outline st-xs" disabled={busy}
          onClick={() => void revoke(choice)}>撤销此空间授权</button>}
      </ModelProviderCard>
    })}
    <div className="product-model-selection-actions"><button type="button" className="outline" disabled={busy} onClick={() => void controller.reload()}>重新读取选用</button>
      {selected && <button type="button" className="outline" disabled={busy || !selected.policy.checksAllowed || !selected.connection.enabled || !selected.connection.hasCredential || selected.connection.adapterState !== 'ready'} onClick={onCheck}>检查当前模型</button>}</div>
  </Section></div>
}
