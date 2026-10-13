import { useSyncExternalStore } from 'react'

/**
 * 主题 store：偏好（浅色 / 深色 / 跟随系统）+ 实际生效主题。
 *
 * 首屏不闪由 `index.html` 的内联脚本负责——它在 React 启动前就把 `data-theme`
 * 与 `data-theme-pref` 写到 `<html>` 上；本模块启动时读回同一份状态后接管，
 * 因此「刷新恢复」与「首次跟随系统」两条路径只有一处判定逻辑（resolveTheme）。
 *
 * 环境读写抽成 ThemeEnv，便于在无 DOM 的测试环境里验证全部分支。
 */

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

/** localStorage 键（清缓存保留清单见 lib/settings.ts clearCache）。 */
export const THEME_KEY = 'theme.v1'
export const THEME_ATTR = 'data-theme'
export const THEME_PREF_ATTR = 'data-theme-pref'
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

export const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system'
}

/** 缺失或非法（历史值 / 手改）一律按跟随系统处理。 */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  return isThemePreference(raw) ? raw : 'system'
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

export interface ThemeEnv {
  /** 读持久化偏好；存储不可用时返回 null。 */
  read(): string | null
  /** 写持久化偏好；失败不抛出（本次会话内仍然生效）。 */
  write(value: string): void
  systemDark(): boolean
  /** 订阅系统深浅变化，返回取消订阅。 */
  watchSystem(onChange: () => void): () => void
  /** 订阅其他标签页的偏好写入（storage 事件），返回取消订阅。 */
  watchStorage(onChange: () => void): () => void
  /** 把实际主题写到根节点（属性 + color-scheme）。 */
  apply(theme: ResolvedTheme, pref: ThemePreference): void
  /** 首屏内联脚本已写入的偏好；没有则为 null。 */
  bootPreference(): ThemePreference | null
}

export interface ThemeStore {
  getPreference(): ThemePreference
  getResolved(): ResolvedTheme
  getSnapshot(): { preference: ThemePreference; resolved: ResolvedTheme }
  subscribe(listener: () => void): () => void
  setPreference(pref: ThemePreference): void
  /** 重新对齐系统 / 外部存储状态（系统变化与其他标签页写入都走这里）。 */
  sync(): void
}

export function createThemeStore(env: ThemeEnv): ThemeStore {
  let preference: ThemePreference =
    env.bootPreference() ?? parseThemePreference(env.read())
  let resolved: ResolvedTheme = resolveTheme(preference, env.systemDark())
  let snapshot = { preference, resolved }
  const listeners = new Set<() => void>()

  function emit() {
    snapshot = { preference, resolved }
    listeners.forEach((l) => l())
  }

  function align(nextPref: ThemePreference, persist: boolean) {
    const nextResolved = resolveTheme(nextPref, env.systemDark())
    if (nextPref === preference && nextResolved === resolved) return
    preference = nextPref
    resolved = nextResolved
    env.apply(resolved, preference)
    if (persist) {
      try {
        env.write(preference)
      } catch {
        // 存储不可用（隐私模式 / 配额）：偏好只在本次会话内生效，不阻断切换
      }
    }
    emit()
  }

  // 启动即对齐一次：内联脚本已写过同样的结果，这里是幂等的兜底
  //（例如无 index.html 的嵌入场景、或内联脚本被 CSP 拦下）。
  env.apply(resolved, preference)

  env.watchSystem(() => {
    if (preference !== 'system') return
    align('system', false)
  })
  env.watchStorage(() => {
    // 别的标签页改了偏好：跟随它，但不再写回（避免回声）
    const external = parseThemePreference(env.read())
    if (external !== preference) align(external, false)
  })

  return {
    getPreference: () => preference,
    getResolved: () => resolved,
    getSnapshot: () => snapshot,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    setPreference(pref) {
      align(pref, true)
    },
    sync() {
      align(preference, false)
    },
  }
}

/* ---------- 浏览器环境 ---------- */

function browserEnv(): ThemeEnv {
  const root = () => document.documentElement
  return {
    read() {
      try {
        return localStorage.getItem(THEME_KEY)
      } catch {
        return null // 隐私模式等：设置只在本次会话内生效
      }
    },
    write(value) {
      try {
        localStorage.setItem(THEME_KEY, value)
      } catch {
        // 存储不可用时不阻断切换
      }
    },
    systemDark: () => window.matchMedia(SYSTEM_DARK_QUERY).matches,
    watchSystem(onChange) {
      const mq = window.matchMedia(SYSTEM_DARK_QUERY)
      mq.addEventListener('change', onChange)
      // 补一次核对：挂起 / bfcache / 被丢弃的标签页恢复后，系统主题可能已经变过而事件没到。
      // 核对是幂等的（store 在偏好与实际主题都没变时直接返回），不会造成额外渲染。
      document.addEventListener('visibilitychange', onChange)
      window.addEventListener('pageshow', onChange)
      return () => {
        mq.removeEventListener('change', onChange)
        document.removeEventListener('visibilitychange', onChange)
        window.removeEventListener('pageshow', onChange)
      }
    },
    watchStorage(onChange) {
      const on = (e: StorageEvent) => {
        if (e.key === null || e.key === THEME_KEY) onChange()
      }
      window.addEventListener('storage', on)
      return () => window.removeEventListener('storage', on)
    },
    apply(theme, pref) {
      root().setAttribute(THEME_ATTR, theme)
      root().setAttribute(THEME_PREF_ATTR, pref)
      root().style.colorScheme = theme
    },
    bootPreference() {
      const attr = root().getAttribute(THEME_PREF_ATTR)
      return isThemePreference(attr) ? attr : null
    },
  }
}

/**
 * 单例延迟创建：浏览器启动时 index.html 的内联脚本已写好实际主题，
 * 这里等第一次取用时再接管；也让纯函数能在无 DOM 的测试环境里直接测。
 */
let singleton: ThemeStore | null = null

function store(): ThemeStore {
  if (!singleton) singleton = createThemeStore(browserEnv())
  return singleton
}

// 传引用而不是内联箭头：useSyncExternalStore 需要在多次渲染间拿到稳定的 subscribe
const subscribe = (listener: () => void) => store().subscribe(listener)
const snapshot = () => store().getSnapshot()

export function useTheme(): { preference: ThemePreference; resolved: ResolvedTheme } {
  return useSyncExternalStore(subscribe, snapshot)
}

export function setThemePreference(pref: ThemePreference): void {
  store().setPreference(pref)
}
