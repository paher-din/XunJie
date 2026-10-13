import { Icon, type IconName } from '../icons'
import { useEffect, useRef, type CSSProperties } from 'react'
import { THEME_OPTIONS, setThemePreference, useTheme, type ThemePreference } from '../lib/theme'

/** 选项图标：浅色（太阳）/ 深色（月亮）/ 跟随系统（本机）。 */
const THEME_ICONS: Record<ThemePreference, IconName> = {
  light: 'sun',
  dark: 'moon',
  system: 'laptop',
}

/** 入场级联（app.css .theme-menu.on）：与账号菜单同一套节奏。 */
const delay = (ms: number) => ({ '--d': `${ms}ms` }) as CSSProperties

/**
 * 外观菜单（侧栏月亮按钮）：浅色 / 深色 / 跟随系统三选一，选中即时生效并持久化。
 * 键盘：开启后焦点落在当前项，↑↓ 移动、Enter/Space 选中、Esc 或 Tab 关闭，
 * 关闭后焦点回到触发按钮（由调用方在 onClose 里处理）。
 */
export function ThemeMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { preference } = useTheme()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const items = () =>
      Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]') ?? [])
    // 打开即把焦点交给当前项，键盘用户不必再 Tab 进来
    items()[THEME_OPTIONS.findIndex((o) => o.value === preference)]?.focus()
    const onKey = (e: KeyboardEvent) => {
      const list = items()
      const i = list.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'Tab') {
        onClose()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        list[(i + step + list.length) % list.length]?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, preference, onClose])

  return (
    <div className={'theme-menu' + (open ? ' on' : '')} role="menu" aria-hidden={!open} ref={ref}>
      <div className="tm-head" style={delay(30)}>
        外观
      </div>
      {THEME_OPTIONS.map((o, i) => {
        const active = preference === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            className={'theme-menu-item' + (active ? ' active' : '')}
            style={delay(60 + i * 30)}
            onClick={() => {
              setThemePreference(o.value)
              onClose()
            }}
          >
            <Icon name={THEME_ICONS[o.value]} variant="linear" tone="neutral" size={16} />
            <span className="am-label">{o.label}</span>
            {active && <Icon name="check" size={14} className="am-chev" />}
          </button>
        )
      })}
    </div>
  )
}
