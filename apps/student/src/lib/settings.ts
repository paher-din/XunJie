import { useSyncExternalStore } from 'react'
import { THEME_KEY } from './theme'

/**
 * 设置 store：应用级设置的单一来源（docs/settings-design.md 已确认）。
 * useSyncExternalStore 订阅 + localStorage 持久化（键 settings.v1）；
 * 桌面宿主落地后迁移到本地偏好存储（docs/frontend-architecture.md §8）。
 */

export interface AccountSettings {
  /** 账号条展示名；默认 Robert（本地学习空间演示账号）。 */
  name: string
  /** 自定义头像 dataURL；null 时按名字哈希取渐变泡泡兜底。 */
  avatar: string | null
}

export interface AgentPersonalization {
  /** Agent 对学生的称呼。 */
  nickname: string
  /** 引导强度 0–100：0 = 多问引导，100 = 直接给答案。 */
  guidance: number
  /** 提示方式：自动（Agent 判断）/ 引导气泡优先 / 教学卡片优先。 */
  hintStyle: 'auto' | 'bubble' | 'card'
  /** 语气：鼓励型 / 简洁型。 */
  tone: 'encouraging' | 'concise'
}

export interface PortraitData {
  tags: string[]
  radar: Array<{ dim: string; value: number }>
  strengths: string[]
  growths: string[]
  prefs: string[]
  /** 画像最近更新时间（ISO 日期），初始值与资料卡 mock 一致。 */
  updatedAt: string
  /** 学生纠正画像留下的真实变更记录（不编造历史）。 */
  changelog: Array<{ at: string; text: string }>
}

export interface ProviderModel {
  /** 模型 ID，如 deepseek-v4.1-pro。 */
  id: string
  contextWindow: string
  maxOutput: string
  /** 输入类型：文本恒有且锁定，此处只记图片 / 视频 / PDF。 */
  inputTypes: Array<'image' | 'video' | 'pdf'>
  /** 推理等级序列（从低到高）。 */
  reasoningLevels: string[]
}

export interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  hasKey?: boolean
  keyHint?: string
  clearKey?: boolean
  models: ProviderModel[]
}

export interface SettingsState {
  account: AccountSettings
  agent: AgentPersonalization
  portrait: PortraitData
  providers: ModelProvider[]
}

const KEY = 'settings.v1'

/**
 * 演示用的自定义供应商：让自定义供应商卡片一进设置页就有东西可看
 * （模型 chip 的 ✎ / ×、「128K 上下文」角标、默认模型里的 custom: 条目、编辑弹窗的回填）。
 * 只在本地没存过设置时随默认值出现；删掉后不会复活——load() 只在缺键时取默认值。
 */
const DEMO_PROVIDER: ModelProvider = {
  id: 'demo-deepseek',
  name: 'DeepSeek 官方',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  models: [
    {
      id: 'deepseek-v4.1-flash',
      contextWindow: '131072',
      maxOutput: '30000',
      inputTypes: ['image'],
      reasoningLevels: [],
    },
    {
      id: 'deepseek-v4.1-pro',
      contextWindow: '131072',
      maxOutput: '30000',
      inputTypes: ['image', 'video'],
      reasoningLevels: ['low', 'high', 'max'],
    },
  ],
}

export const DEFAULT_SETTINGS: SettingsState = {
  account: { name: 'Robert', avatar: null },
  agent: { nickname: '同学', guidance: 35, hintStyle: 'auto', tone: 'encouraging' },
  portrait: {
    // 初始画像与个人资料卡 mock 一致（ProfileCard 常量同源）
    tags: ['动手实践', '视觉型', '提问积极', '节奏稳定'],
    radar: [
      { dim: '组合逻辑', value: 86 },
      { dim: 'Verilog 编程', value: 78 },
      { dim: '实验文档', value: 82 },
      { dim: '问题探究', value: 64 },
      { dim: '时序分析', value: 42 },
      { dim: '波形调试', value: 38 },
    ],
    strengths: ['组合逻辑 · Verilog 编程', '实验文档表达'],
    growths: ['时序分析', '波形调试'],
    prefs: ['先演示后实践', '喜欢类比解释', '单次约 60 分钟'],
    updatedAt: '2026-10-01',
    changelog: [],
  },
  providers: [DEMO_PROVIDER],
}

function load(): SettingsState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<SettingsState>
    return {
      account: { ...DEFAULT_SETTINGS.account, ...parsed.account },
      agent: { ...DEFAULT_SETTINGS.agent, ...parsed.agent },
      portrait: { ...DEFAULT_SETTINGS.portrait, ...parsed.portrait },
      providers: (parsed.providers ?? DEFAULT_SETTINGS.providers).map(p => ({ ...p, apiKey: '' })),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

let state: SettingsState = load()
// 清理旧演示版本遗留的明文凭据；真实配置由当前账号后台持有。
try {
  const raw = localStorage.getItem(KEY)
  const previous = raw ? JSON.parse(raw) : null
  if (Array.isArray(previous?.providers)) {
    const providers = previous.providers.map((p: Record<string, unknown>) => {
      if (!p || typeof p !== 'object') return p
      const { apiKey: _key, ...metadata } = p
      return metadata
    })
    localStorage.setItem(KEY, JSON.stringify({ ...previous, providers }))
  }
} catch { /* 只清理可识别的旧供应商字段，不覆盖其他本机设置。 */ }
const listeners = new Set<() => void>()

function commit(next: SettingsState) {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...state, providers: state.providers.map(({ apiKey: _key, ...p }) => p) }))
  } catch {
    // 存储不可用（隐私模式等）时设置仅在本次会话内生效
  }
  listeners.forEach((l) => l())
}

export function useSettings(): SettingsState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

/* ---------- 账户 ---------- */

export function setAccountName(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return
  commit({ ...state, account: { ...state.account, name: trimmed } })
}

export function setAccountAvatar(avatar: string | null) {
  commit({ ...state, account: { ...state.account, avatar } })
}

/* ---------- Agent 个性化 ---------- */

export function updateAgent(patch: Partial<AgentPersonalization>) {
  commit({ ...state, agent: { ...state.agent, ...patch } })
}

/* ---------- 学生画像纠正 ---------- */

export type PortraitCorrection =
  | { kind: 'tag' | 'strength' | 'growth' | 'pref'; value: string }

const CORRECT_TEXT: Record<PortraitCorrection['kind'], string> = {
  tag: '校准并移除了特征标签',
  strength: '校准并移除了擅长项',
  growth: '校准并移除了待加强项',
  pref: '校准并移除了引导偏好',
}

export function correctPortrait({ kind, value }: PortraitCorrection) {
  const p = state.portrait
  const listKey = { tag: 'tags', strength: 'strengths', growth: 'growths', pref: 'prefs' } as const
  const key: 'tags' | 'strengths' | 'growths' | 'prefs' = listKey[kind]
  if (!p[key].includes(value)) return
  const today = new Date().toISOString().slice(0, 10)
  commit({
    ...state,
    portrait: {
      ...p,
      [key]: p[key].filter((v) => v !== value),
      updatedAt: today,
      changelog: [{ at: today, text: `${CORRECT_TEXT[kind]}「${value}」` }, ...p.changelog].slice(0, 8),
    },
  })
}

/* ---------- 模型供应商 ---------- */

/** 精确型号参考值；未知供应商/型号不按名称前缀猜能力。实际值优先由供应商模型列表导入。 */
const SMART_MODEL_PRESETS: Array<[RegExp, string, string]> = [
  [/^deepseek-(?:flash|v4-pro)$/, '1048576', '393216'],
]

/** 新建模型的初值：窗口与上限留空，等填 ID 时由智能配置按需回填。 */
export function emptyProviderModel(): ProviderModel {
  return { id: '', contextWindow: '', maxOutput: '', inputTypes: [], reasoningLevels: [] }
}

/** 精确已知模型的能力参考值；未命中返回空串。 */
export function smartModelDefaults(id: string): { contextWindow: string; maxOutput: string } {
  const hit = SMART_MODEL_PRESETS.find(([re]) => re.test(id))
  return hit ? { contextWindow: hit[1], maxOutput: hit[2] } : { contextWindow: '', maxOutput: '' }
}

export function modelConfigurationError(model:ProviderModel):string {
  for(const value of [model.contextWindow,model.maxOutput])
    if(value&&(!/^[1-9][0-9]*$/.test(value)||!Number.isSafeInteger(Number(value))))return '上下文和输出上限须为有效正整数。'
  if((Number(model.maxOutput)||4096)>=(Number(model.contextWindow)||16384))return '最大输出必须小于上下文窗口，才能为输入保留空间。'
  if(model.reasoningLevels.some(level=>!['low','high','max'].includes(level)))return '思考等级仅支持 low、high、max。'
  if(new Set(model.reasoningLevels).size!==model.reasoningLevels.length)return '思考等级不能重复。'
  return ''
}

export function saveProvider(provider: ModelProvider) {
  const idx = state.providers.findIndex((p) => p.id === provider.id)
  const providers = idx >= 0
    ? state.providers.map((p) => (p.id === provider.id ? provider : p))
    : [...state.providers, provider]
  commit({ ...state, providers })
}

export function removeProvider(id: string) {
  commit({ ...state, providers: state.providers.filter((p) => p.id !== id) })
}

export function removeModel(providerId: string, modelId: string) {
  commit({
    ...state,
    providers: state.providers.map((p) =>
      p.id === providerId ? { ...p, models: p.models.filter((m) => m.id !== modelId) } : p,
    ),
  })
}

/* ---------- 数据与隐私 ---------- */

/** 估算本地存储占用（字节）：localStorage + sessionStorage 全量。 */
export function storageUsageBytes(): number {
  let total = 0
  for (const store of [localStorage, sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)!
      total += k.length + (store.getItem(k)?.length ?? 0)
    }
  }
  return total * 2 // UTF-16 每字符两字节
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 日期显示：`2026-10-01` → `10月1日`（与 lib/tasks.ts formatDeadline 同款，无空格、无前导零）。 */
export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  return `${Number(m[2])}月${Number(m[3])}日`
}

/** 清除缓存：sessionStorage 全清 + localStorage 中的运行时缓存，保留设置、外观偏好与模型选择。 */
export function clearCache(): void {
  sessionStorage.clear()
  const keep = [KEY, THEME_KEY, 'agent.model', 'agent.model.effort']
  const remove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    if (!keep.includes(k) && !k.startsWith('dashboard.') && !k.startsWith('ws-')) remove.push(k)
  }
  remove.forEach((k) => localStorage.removeItem(k))
}

/** 重置看板与工作区布局：删除布局与收纳持久化键。 */
export function resetLayouts(): number {
  const remove: string[] = []
  for (const store of [localStorage, sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)!
      if (k === 'dashboard.layout.v3' || k.startsWith('ws-layout:') || k.startsWith('ws-cards:')) {
        remove.push(k)
      }
    }
  }
  remove.forEach((k) => {
    localStorage.removeItem(k)
    sessionStorage.removeItem(k)
  })
  return remove.length
}
