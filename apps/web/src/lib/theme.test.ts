import { describe, expect, it } from 'vitest'
import {
  createThemeStore,
  parseThemePreference,
  resolveTheme,
  THEME_OPTIONS,
  type ThemeEnv,
  type ThemePreference,
} from './theme'

/** 假环境：把 localStorage / matchMedia / 根节点属性都放进内存，覆盖全部分支。 */
function fakeEnv(init?: {
  stored?: string | null
  systemDark?: boolean
  boot?: ThemePreference | null
  writeThrows?: boolean
}) {
  const state = {
    stored: init?.stored ?? null,
    systemDark: init?.systemDark ?? false,
    applied: [] as Array<{ theme: string; pref: string }>,
  }
  const systemListeners = new Set<() => void>()
  const storageListeners = new Set<() => void>()
  const env: ThemeEnv = {
    read: () => state.stored,
    write: (v) => {
      if (init?.writeThrows) throw new Error('quota')
      state.stored = v
    },
    systemDark: () => state.systemDark,
    watchSystem: (onChange) => {
      systemListeners.add(onChange)
      return () => systemListeners.delete(onChange)
    },
    watchStorage: (onChange) => {
      storageListeners.add(onChange)
      return () => storageListeners.delete(onChange)
    },
    apply: (theme, pref) => state.applied.push({ theme, pref }),
    bootPreference: () => init?.boot ?? null,
  }
  return {
    env,
    state,
    /** 模拟系统由浅转深（跟随系统时才应生效）。 */
    flipSystem(dark: boolean) {
      state.systemDark = dark
      systemListeners.forEach((l) => l())
    },
    /** 模拟其他标签页写入偏好。 */
    externalWrite(value: string) {
      state.stored = value
      storageListeners.forEach((l) => l())
    },
  }
}

describe('主题偏好解析', () => {
  it('缺失或非法值一律按跟随系统处理', () => {
    expect(parseThemePreference(null)).toBe('system')
    expect(parseThemePreference(undefined)).toBe('system')
    expect(parseThemePreference('')).toBe('system')
    expect(parseThemePreference('sepia')).toBe('system')
    expect(parseThemePreference('DARK')).toBe('system')
  })

  it('只接受三个合法值', () => {
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('dark')).toBe('dark')
    expect(parseThemePreference('system')).toBe('system')
  })

  it('跟随系统时由系统深浅决定实际主题', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('三个选项都出现在菜单里', () => {
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(['light', 'dark', 'system'])
  })
})

describe('主题 store', () => {
  it('首次访问跟随系统', () => {
    const dark = createThemeStore(fakeEnv({ systemDark: true }).env)
    expect(dark.getPreference()).toBe('system')
    expect(dark.getResolved()).toBe('dark')
    const light = createThemeStore(fakeEnv({ systemDark: false }).env)
    expect(light.getResolved()).toBe('light')
  })

  it('刷新后恢复已保存的偏好（含首屏内联脚本已写入的情况）', () => {
    const { env } = fakeEnv({ stored: 'dark', systemDark: false })
    const store = createThemeStore(env)
    expect(store.getPreference()).toBe('dark')
    expect(store.getResolved()).toBe('dark')

    const booted = createThemeStore(fakeEnv({ stored: null, boot: 'light' }).env)
    expect(booted.getPreference()).toBe('light')
    expect(booted.getResolved()).toBe('light')
  })

  it('选择后立即生效并持久化', () => {
    const { env, state } = fakeEnv({ systemDark: true })
    const store = createThemeStore(env)
    store.setPreference('light')
    expect(store.getResolved()).toBe('light')
    expect(state.stored).toBe('light')
    // 内联脚本读到的属性与之一致
    expect(state.applied.at(-1)).toEqual({ theme: 'light', pref: 'light' })
  })

  it('手动选择后系统变化不再覆盖', () => {
    const { env, flipSystem } = fakeEnv({ systemDark: false })
    const store = createThemeStore(env)
    store.setPreference('dark')
    flipSystem(false)
    expect(store.getResolved()).toBe('dark')
    expect(store.getPreference()).toBe('dark')
  })

  it('跟随系统时响应系统深浅变化', () => {
    const { env, flipSystem } = fakeEnv({ systemDark: false })
    const store = createThemeStore(env)
    flipSystem(true)
    expect(store.getResolved()).toBe('dark')
    flipSystem(false)
    expect(store.getResolved()).toBe('light')
  })

  it('订阅者在变化时收到通知，快照随变化更新', () => {
    const { env } = fakeEnv({ systemDark: false })
    const store = createThemeStore(env)
    const before = store.getSnapshot()
    let hits = 0
    const off = store.subscribe(() => hits++)
    store.setPreference('dark')
    expect(hits).toBe(1)
    expect(before).not.toBe(store.getSnapshot())
    expect(store.getSnapshot()).toEqual({ preference: 'dark', resolved: 'dark' })
    store.setPreference('dark') // 重复设置不触发
    expect(hits).toBe(1)
    off()
    store.setPreference('light')
    expect(hits).toBe(1)
  })

  it('存储不可用时不抛出，本次会话内仍然生效', () => {
    const { env } = fakeEnv({ writeThrows: true })
    const store = createThemeStore(env)
    expect(() => store.setPreference('dark')).not.toThrow()
    expect(store.getResolved()).toBe('dark')
    expect(store.getPreference()).toBe('dark')
  })

  it('其他标签页改了偏好就跟随（不再回写）', () => {
    const { env, state, externalWrite } = fakeEnv({ stored: 'light' })
    const store = createThemeStore(env)
    externalWrite('dark')
    expect(store.getPreference()).toBe('dark')
    expect(store.getResolved()).toBe('dark')
    expect(state.stored).toBe('dark')
  })

  it('启动即把实际主题写到根节点（内联脚本缺席时的兜底）', () => {
    const { env, state } = fakeEnv({ stored: 'dark', systemDark: false })
    createThemeStore(env)
    expect(state.applied[0]).toEqual({ theme: 'dark', pref: 'dark' })
  })
})
