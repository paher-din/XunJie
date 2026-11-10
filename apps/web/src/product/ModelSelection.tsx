import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { modelSelectionSchema, selectModelSchema } from '@xunjie/contracts/model-connections'
import type { z } from 'zod'

export type Selection = z.infer<typeof modelSelectionSchema>
export type Choice = Selection['options'][number]
const errors: Record<string, string> = { forbidden: '当前空间或模型连接已不可用。请检查学校连接或模型配置。', conflict: '选用记录已变化，请刷新模型后重试。',
  unavailable: '原模型服务暂时不可用，请稍后重新读取。', maintenance: '模型服务正在维护，请稍后重试。' }
const failure = (error: unknown) => error instanceof Error ? error.message : '选用结果尚未确认，请重新读取。'
const choiceKey = (choice: Choice) => choice.kind + ':' + choice.connection.connectionId
export function useModelSelection(identity: SpaceIdentity | undefined, spaceKey: string, namespace: string) {
  const scope = identity ? [namespace, spaceKey, identity.environmentId, identity.spaceId, identity.principalId].join('.') : ''
  const [state, setState] = useState<{ scope: string; selection: Selection | null; error: string; busy: boolean; stale: boolean }>({ scope: '', selection: null, error: '', busy: false, stale: false })
  const current = useRef(scope), epoch = useRef(0)
  const pending = useRef(new Map<string, z.infer<typeof selectModelSchema>>())
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
      if (current.current === scope && generation === epoch.current) setState(previous => ({ scope, selection, busy: previous.scope === scope && previous.busy, error: '', stale: false }))
    } catch (error) {
      if (current.current === scope && generation === epoch.current) setState(previous => ({ scope, selection: previous.scope === scope ? previous.selection : null,
        busy: false, stale: true, error: error instanceof TypeError ? '暂时无法连接模型服务。恢复连接后，请刷新模型。' : failure(error) }))
    }
  }, [scope, request])
  useEffect(() => {
    void reload(); const focus = () => void reload(); window.addEventListener('focus', focus)
    return () => { ++epoch.current; window.removeEventListener('focus', focus) }
  }, [reload])
  async function act<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (!scope || current.current !== scope || state.scope !== scope || state.busy || state.stale || !state.selection) return
    ++epoch.current
    setState(previous => ({ ...previous, busy: true, error: '' }))
    try { const result = await operation(); if (current.current === scope) await reload(); return result }
    catch (error) { if (current.current === scope) setState(previous => ({ ...previous, error: failure(error) })) }
    finally { if (current.current === scope) setState(previous => ({ ...previous, busy: false })) }
  }
  const choose = async (choice: Choice, onSaved?: (selection: Selection) => void | Promise<void>) => { await act(async () => {
    const operationKey = scope + ':' + choiceKey(choice)
    const operation = pending.current.get(operationKey) ?? {
      requestId: crypto.randomUUID(), expectedVersion: state.selection!.version,
      source: choice.kind === 'school' ? { kind: 'school' as const, connectionId: choice.connection.connectionId }
        : { kind: 'personal' as const, connectionId: choice.connection.connectionId, owner: choice.origin === 'device' ? 'device' as const : 'self' as const },
    }
    pending.current.set(operationKey, operation)
    let saved: Selection
    try { saved = modelSelectionSchema.parse(await request('selection', operation)) }
    catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'conflict' || code === 'identity-conflict') { pending.current.delete(operationKey); await reload() }
      else if (code === 'forbidden' || code === 'invalid' || code === 'missing') pending.current.delete(operationKey)
      throw error
    }
    pending.current.delete(operationKey)
    if (current.current !== scope) return
    setState(previous => ({ ...previous, selection: saved }))
    await onSaved?.(saved)
  }) }
  return { selection: state.scope === scope ? state.selection : null, error: state.scope === scope ? state.error : '',
    busy: state.scope === scope && state.busy, stale: state.scope === scope && state.stale, reload, choose }
}
export type ModelSelectionController = ReturnType<typeof useModelSelection>
