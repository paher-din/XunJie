import { useEffect, useSyncExternalStore } from 'react'
import type { ModelProvider } from './settings'
import { apiGet, apiPost } from '../workspace/http'
import { PREP_BUILD } from '../workspace/mode'
import { getSessionState, subscribeSession } from '../workspace/session'

export interface PersonalModelSettings {
  revision: number
  enabled: boolean
  callsEnabled: boolean
  defaultModelId: string
  providers: ModelProvider[]
  efforts: Record<string, string>
}
interface ModelSettingsState { data: PersonalModelSettings | null; loading: boolean; saving: boolean; error: string }
let state: ModelSettingsState = { data: null, loading: false, saving: false, error: '' }
const listeners = new Set<() => void>()
let generation = 0
let readVersion = 0
let sessionIdentity = identity()
function identity() { const s = getSessionState(); return `${s.epoch}:${s.status}:${s.session?.userId ?? ''}` }
function publish(patch: Partial<ModelSettingsState>) { state = { ...state, ...patch }; listeners.forEach(l => l()) }
export function resetModelSettings() {
  generation++; readVersion++
  state = { data: null, loading: false, saving: false, error: '' }
  listeners.forEach(l => l())
}
subscribeSession(() => {
  const next = identity()
  if (next !== sessionIdentity) { sessionIdentity = next; resetModelSettings() }
})
function project(value: unknown): PersonalModelSettings {
  const v = value as PersonalModelSettings
  if (!v || !Number.isInteger(v.revision) || typeof v.enabled !== 'boolean' || typeof v.callsEnabled !== 'boolean'
    || typeof v.defaultModelId !== 'string' || !Array.isArray(v.providers)) throw new Error('模型配置响应无效')
  const providers = v.providers.map(p => {
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.baseUrl !== 'string'
      || typeof p.hasKey !== 'boolean' || !Array.isArray(p.models) || Object.hasOwn(p, 'apiKey')) throw new Error('模型配置响应无效')
    return { id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: '', hasKey: p.hasKey,
      keyHint: typeof p.keyHint === 'string' ? p.keyHint : '', models: p.models }
  })
  return { revision: v.revision, enabled: v.enabled, callsEnabled: v.callsEnabled,
    defaultModelId: v.defaultModelId, providers, efforts: v.efforts ?? {} }
}
export async function loadModelSettings(): Promise<void> {
  if (PREP_BUILD || getSessionState().status !== 'authenticated') return
  const g = generation, read = ++readVersion
  publish({ loading: true, error: '' })
  try {
    const data = project(await apiGet<unknown>('/model-settings', { mode: 'real', timeoutMs: 15_000 }))
    if (g === generation && read === readVersion) publish({ data, loading: false })
  } catch {
    if (g === generation && read === readVersion) publish({ loading: false, error: '模型配置读取失败，请重试。' })
  }
}
export function getModelSettings() { return state }
export function useModelSettings() {
  const current = useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l) }, () => state)
  useEffect(() => { if (!PREP_BUILD && !state.data && !state.loading) void loadModelSettings() }, [])
  return current
}
type SettingsPatch = Partial<Pick<PersonalModelSettings, 'enabled' | 'defaultModelId' | 'efforts'>> & { providers?: ModelProvider[] }
export async function saveModelSettings(patch: SettingsPatch): Promise<void> {
  if (PREP_BUILD) throw new Error('准备场景不保存真实模型配置')
  if (!state.data || state.loading || state.saving || getSessionState().status !== 'authenticated') throw new Error('请等待模型配置读取或保存完成')
  const g = generation
  readVersion++
  const data = state.data
  const providers = (patch.providers ?? data.providers).map(({ id, name, baseUrl, models, apiKey, clearKey }) => ({
    id, name, baseUrl, models, ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}), ...(clearKey ? { clearKey: true } : {}),
  }))
  const body = { expectedRevision: data.revision, enabled: patch.enabled ?? data.enabled,
    defaultModelId: patch.defaultModelId ?? data.defaultModelId, providers, efforts: patch.efforts ?? data.efforts }
  publish({ saving: true, error: '' })
  try {
    const next = project(await apiPost<unknown>('/model-settings', body, { mode: 'real', timeoutMs: 15_000 }))
    if (g !== generation) throw new Error('原登录状态已改变')
    publish({ data: next, saving: false })
  } catch (error) {
    if (g === generation) publish({ saving: false, error: '模型配置保存未确认，请重新读取后再试。' })
    throw new Error(error instanceof Error && error.message === '原登录状态已改变' ? error.message : '模型配置保存未确认，请重新读取后再试。')
  }
}
export function personalModelOptions(data: PersonalModelSettings | null) {
  return data?.providers.flatMap(p => p.models.map(m => ({ id: `custom:${p.id}:${m.id}`, name: m.id,
    note: p.name, icon: 'model' as const }))) ?? []
}

/** 可操作强度只来自当前保存模型的能力声明。 */
export function reasoningOptions(data: PersonalModelSettings | null) {
  const model = data?.providers.flatMap(p => p.models.map(m => ({ key: `custom:${p.id}:${m.id}`, model: m }))).find(m => m.key === data.defaultModelId)?.model
  const levels = model?.reasoningLevels ?? []
  return ([['低', 'low'], ['高', 'high'], ['最高', 'max']] as const).filter(([label, value]) => levels.includes(value) || levels.includes(label)).map(([label]) => label)
}
